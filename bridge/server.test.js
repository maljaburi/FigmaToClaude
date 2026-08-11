// Behaviour tests for the bridge's pure functions and its two file writers.
//
//   node --test bridge/
//
// These exist because the parts of this server that can quietly ruin someone's day —
// writing into a project's CLAUDE.md, pinning settings, deciding what counts as a valid
// standard — had no coverage at all, and one of them was destroying user content.
//
// No dependencies: node:test and node:assert ship with Node.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Requiring the server must not bind a port or shell out — the require.main guard is what
// makes that true, so treat this import as part of the test surface.
const bridge = require("./server.js");

const {
  slugify, render, looksValid, writeLaws, pinModel, figmaUrl, isFigmaUrl,
  lawsForPrompt, templateVars, clean, projectId, originAllowed, hostAllowed,
  screensOf, screenVars, buildPrompt, firstScreenName,
  LAWS_BEGIN, LAWS_END, SCREEN_BEGIN, SCREEN_END, BuildError,
} = bridge;

const GOOD_LAWS = `${LAWS_BEGIN} (managed) -->\n## Figma implementation laws\n1. No guessing.\n${LAWS_END}`;

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f2c-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const readClaudeMd = (dir) => fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");

// ---- writeLaws --------------------------------------------------------------
// The regression this whole file was written for: a standards file that lost its END
// marker left an orphan in CLAUDE.md, and two sends later everything the designer had
// written was sliced out from between the orphan and the new block.
test("writeLaws creates CLAUDE.md when the project has none", (t) => {
  const dir = tmpdir(t);
  writeLaws(dir, GOOD_LAWS);
  assert.match(readClaudeMd(dir), /No guessing/);
});

test("writeLaws keeps the designer's own content above and below the block", (t) => {
  const dir = tmpdir(t);
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Project\n\nUse the design-system Button.\n");
  writeLaws(dir, GOOD_LAWS);
  fs.appendFileSync(path.join(dir, "CLAUDE.md"), "\n## Deploy\nrun `make ship`\n");

  writeLaws(dir, GOOD_LAWS.replace("No guessing.", "No guessing at all."));

  const body = readClaudeMd(dir);
  assert.match(body, /Use the design-system Button/);
  assert.match(body, /run `make ship`/);
  assert.match(body, /No guessing at all/);
  assert.equal(body.match(/FIGMA-TO-CLAUDE-CODE:BEGIN/g).length, 1, "exactly one managed block");
});

test("writeLaws is idempotent", (t) => {
  const dir = tmpdir(t);
  writeLaws(dir, GOOD_LAWS);
  const first = readClaudeMd(dir);
  writeLaws(dir, GOOD_LAWS);
  writeLaws(dir, GOOD_LAWS);
  assert.equal(readClaudeMd(dir), first);
});

test("writeLaws refuses laws with no END marker rather than writing them", (t) => {
  const dir = tmpdir(t);
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Mine\nkeep me\n");
  const before = readClaudeMd(dir);

  assert.throws(() => writeLaws(dir, `${LAWS_BEGIN} truncated`), BuildError);
  assert.equal(readClaudeMd(dir), before, "the file must be untouched after a refusal");
});

test("writeLaws refuses to touch a CLAUDE.md that already has an unterminated block", (t) => {
  const dir = tmpdir(t);
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), `${LAWS_BEGIN} half\n\n# Mine\nkeep me\n`);
  const before = readClaudeMd(dir);

  assert.throws(() => writeLaws(dir, GOOD_LAWS), /unterminated managed block/);
  assert.equal(readClaudeMd(dir), before);
});

test("writeLaws leaves no temp file behind", (t) => {
  const dir = tmpdir(t);
  writeLaws(dir, GOOD_LAWS);
  assert.deepEqual(fs.readdirSync(dir), ["CLAUDE.md"]);
});

// ---- looksValid -------------------------------------------------------------
test("looksValid requires both markers on the laws file", () => {
  assert.equal(looksValid("figma-laws.md", GOOD_LAWS), true);
  assert.equal(looksValid("figma-laws.md", `${LAWS_BEGIN} truncated`), false);
  assert.equal(looksValid("figma-laws.md", "<html>SSO login</html>"), false);
  assert.equal(looksValid("figma-laws.md", ""), false);
});

test("looksValid requires a placeholder on templates", () => {
  assert.equal(looksValid("prompt.md", `Build {{name}}\n${SCREEN_BEGIN} -->\nx\n${SCREEN_END}`), true);
  assert.equal(looksValid("prompt.md", "<html>SSO login</html>"), false);
});

// A prompt.md without the screen markers has nothing to repeat, so a twelve-frame
// selection would render a brief describing one frame and read as if it had worked.
test("looksValid rejects a prompt template with no screen block", () => {
  assert.equal(looksValid("prompt.md", "Build {{name}} with no markers"), false);
  assert.equal(looksValid("prompt.md", `Build {{name}}\n${SCREEN_BEGIN} --> only the opening one`), false);
});

// ---- pinModel ---------------------------------------------------------------
test("pinModel writes model and effort into .claude/settings.json", (t) => {
  const dir = tmpdir(t);
  pinModel(dir);
  const settings = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.model, "opus");
  assert.equal(settings.effortLevel, "xhigh");
});

test("pinModel preserves unrelated settings", (t) => {
  const dir = tmpdir(t);
  fs.mkdirSync(path.join(dir, ".claude"));
  fs.writeFileSync(path.join(dir, ".claude", "settings.json"), JSON.stringify({ hooks: { pre: "x" } }));
  pinModel(dir);
  const settings = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(settings.hooks, { pre: "x" });
  assert.equal(settings.model, "opus");
});

test("pinModel leaves a settings file it can't parse alone", (t) => {
  const dir = tmpdir(t);
  fs.mkdirSync(path.join(dir, ".claude"));
  const handEdited = "{ // a comment\n  \"model\": \"sonnet\"\n}";
  fs.writeFileSync(path.join(dir, ".claude", "settings.json"), handEdited);
  assert.equal(pinModel(dir), null);
  assert.equal(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"), handEdited);
});

// Valid JSON that isn't an object: `null` used to throw and fail the whole send, and an
// array accepted no properties while the log still reported the model as pinned.
for (const [label, body] of [["null", "null"], ["an array", "[]"], ["a number", "42"]]) {
  test(`pinModel leaves settings.json alone when it is ${label}`, (t) => {
    const dir = tmpdir(t);
    fs.mkdirSync(path.join(dir, ".claude"));
    fs.writeFileSync(path.join(dir, ".claude", "settings.json"), body);
    assert.equal(pinModel(dir), null);
    assert.equal(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"), body);
  });
}

// ---- render -----------------------------------------------------------------
test("render substitutes known placeholders", () => {
  assert.equal(render("Build {{frameName}} at {{size}}", { frameName: "Login", size: "390x844" }),
    "Build Login at 390x844");
});

test("render leaves an unknown placeholder visible", () => {
  assert.equal(render("[{{typo}}]", { frameName: "Login" }), "[{{typo}}]");
});

// `key in vars` walked the prototype chain, so {{toString}} rendered the source of
// Function.prototype.toString into the composer.
test("render does not resolve placeholders off the prototype chain", () => {
  for (const key of ["toString", "constructor", "valueOf", "hasOwnProperty"]) {
    assert.equal(render(`[{{${key}}}]`, { frameName: "Login" }), `[{{${key}}}]`);
  }
});

// ---- slugify ----------------------------------------------------------------
test("slugify cannot escape the prototypes directory", () => {
  assert.equal(slugify("../../etc/passwd"), "etc-passwd");
  assert.equal(slugify("..."), "frame");
  assert.equal(slugify("/"), "frame");
  assert.equal(slugify(""), "frame");
  assert.equal(slugify(null), "frame");
});

test("slugify makes a readable folder name and caps its length", () => {
  assert.equal(slugify("Checkout / Payment method"), "checkout-payment-method");
  assert.ok(slugify("x".repeat(200)).length <= 40);
});

// ---- figmaUrl ---------------------------------------------------------------
test("isFigmaUrl accepts only https figma.com URLs", () => {
  assert.equal(isFigmaUrl("https://www.figma.com/design/abc/x?node-id=1-2"), true);
  assert.equal(isFigmaUrl("https://figma.com/design/abc/x"), true);
  assert.equal(isFigmaUrl("http://www.figma.com/design/abc/x"), false, "plaintext");
  assert.equal(isFigmaUrl("https://evil.com/design/abc/x"), false, "wrong host");
  assert.equal(isFigmaUrl("https://figma.com.evil.com/x"), false, "suffix trick");
  assert.equal(isFigmaUrl("javascript:alert(1)"), false);
  assert.equal(isFigmaUrl("file:///etc/passwd"), false);
  assert.equal(isFigmaUrl(undefined), false);
});

test("figmaUrl passes a real Figma link through and forces Dev Mode", () => {
  assert.equal(figmaUrl({ url: "https://www.figma.com/design/abc/x?node-id=1-2" }),
    "https://www.figma.com/design/abc/x?node-id=1-2&m=dev");
});

test("figmaUrl does not add a second m=dev", () => {
  const url = "https://www.figma.com/design/abc/x?node-id=1-2&m=dev";
  assert.equal(figmaUrl({ url }), url);
});

// A supplied URL is presented to the agent as the design to read, so a non-Figma one is
// rebuilt from the parts rather than passed along.
test("figmaUrl rebuilds from fileKey when the supplied url is not Figma", () => {
  const out = figmaUrl({ url: "https://evil.com/x", fileKey: "abc123", nodeId: "12:345", file: "Design System" });
  assert.match(out, /^https:\/\/www\.figma\.com\/design\/abc123\//);
  assert.match(out, /node-id=12-345/);
  assert.match(out, /m=dev/);
});

test("figmaUrl returns null when there is nothing to build from", () => {
  assert.equal(figmaUrl({}), null);
  assert.equal(figmaUrl({ url: "https://evil.com/x" }), null);
});

// ---- templateVars -----------------------------------------------------------
test("clean caps length and strips control characters", () => {
  assert.equal(clean("a\u0000b\nc", "fallback", 100), "a b c");
  assert.equal(clean("", "fallback", 100), "fallback");
  assert.equal(clean(null, "fallback", 100), "fallback");
  assert.equal(clean("x".repeat(500), "fallback", 10).length, 10);
});

const ONE_FRAME = {
  name: "Checkout", type: "FRAME", nodeId: "12:345", fileKey: "abc",
  file: "Design System", page: "Flows", width: 390, height: 844,
  url: "https://www.figma.com/design/abc/x?node-id=12-345",
};

test("templateVars fills every placeholder the prompt template uses", () => {
  const standards = { files: { "figma-laws.md": { text: GOOD_LAWS } } };
  const vars = templateVars(ONE_FRAME, standards);

  assert.equal(vars.screenCount, "1");
  assert.equal(vars.file, "Design System");
  assert.equal(vars.page, "Flows");
  // The managed-block comments are an implementation detail of the CLAUDE.md copy and
  // have no business appearing in the composer.
  assert.doesNotMatch(vars.laws, /FIGMA-TO-CLAUDE-CODE/);
});

test("screenVars describes one screen from the values Figma gave", () => {
  const vars = screenVars(screensOf(ONE_FRAME)[0]);
  assert.equal(vars.name, "Checkout");
  assert.equal(vars.type, "frame");
  assert.equal(vars.size, "390x844");
  assert.match(vars.devLink, /m=dev/);
  assert.match(vars.designSource, /Dev Mode link/);
});

test("screenVars falls back to the MCP wording with no usable link", () => {
  const vars = screenVars(screensOf({ name: "Checkout", nodeId: "12:345" })[0]);
  assert.equal(vars.devLink, "(none available)");
  assert.match(vars.designSource, /STOP and ask/);
});

test("screenVars reports unknown dimensions rather than inventing them", () => {
  const vars = screenVars(screensOf({ name: "X", width: 0, height: 0 })[0]);
  assert.equal(vars.size, "size unknown");
});

// ---- screensOf --------------------------------------------------------------
// The plugin is published to the org and frozen at its publish version while this bridge
// self-updates over git, so a designer can be sending last month's single-frame payload to
// today's bridge. If that stops normalising, every un-reloaded plugin breaks at once.
test("screensOf reads a single-frame payload from an older plugin", () => {
  const screens = screensOf(ONE_FRAME);
  assert.equal(screens.length, 1);
  assert.equal(screens[0].name, "Checkout");
  assert.equal(screens[0].size, "390x844");
});

test("screensOf reads a multi-screen payload and keeps the order given", () => {
  const screens = screensOf({
    file: "F", page: "P",
    screens: [
      { name: "One", nodeId: "1:1", width: 390, height: 844 },
      { name: "Two", nodeId: "2:2", width: 390, height: 844 },
      { name: "Three", nodeId: "3:3", width: 390, height: 844 },
    ],
  });
  assert.deepEqual(screens.map((s) => s.name), ["One", "Two", "Three"]);
});

// An empty array is what a section holding no frames produces. Falling through to the
// envelope keeps a send working rather than composing a brief with no screen in it.
test("screensOf ignores an empty screens array", () => {
  assert.equal(screensOf({ name: "Solo", nodeId: "1:1", screens: [] }).length, 1);
});

test("screensOf cleans every screen, not just the first", () => {
  const screens = screensOf({
    screens: [
      { name: "Fine", nodeId: "1:1" },
      { name: "Bad\u0000name", nodeId: "2:2" },
      { name: "", nodeId: "3:3" },
    ],
  });
  assert.equal(screens[1].name, "Bad name");
  assert.equal(screens[2].name, "(unnamed)");
});

// ---- buildPrompt ------------------------------------------------------------
const PROMPT_TPL = [
  "Build {{screenCount}} screens from {{file}} · {{page}}.",
  "",
  `${SCREEN_BEGIN} (repeated) -->`,
  "### {{name}} — {{type}}, {{size}}",
  "{{designSource}}",
  SCREEN_END,
  "",
  "{{laws}}",
].join("\n");

function standardsWith(tpl) {
  return { files: { "figma-laws.md": { text: GOOD_LAWS }, "prompt.md": { text: tpl } } };
}

function promptFor(data) {
  const std = standardsWith(PROMPT_TPL);
  return buildPrompt(templateVars(data, std), std, screensOf(data));
}

test("buildPrompt repeats the screen block once per screen", () => {
  const prompt = promptFor({
    file: "F", page: "P",
    screens: [
      { name: "One", nodeId: "1:1", width: 10, height: 20 },
      { name: "Two", nodeId: "2:2", width: 30, height: 40 },
    ],
  });
  assert.match(prompt, /### One — frame, 10x20/);
  assert.match(prompt, /### Two — frame, 30x40/);
  assert.match(prompt, /2 screens/);
  // Each screen carries its own node, or the agent reads one frame twice.
  assert.match(prompt, /1:1/);
  assert.match(prompt, /2:2/);
});

test("buildPrompt leaves no marker or placeholder in what reaches the composer", () => {
  const prompt = promptFor({ screens: [{ name: "One", nodeId: "1:1" }] });
  assert.doesNotMatch(prompt, /SCREEN:BEGIN|SCREEN:END/);
  assert.doesNotMatch(prompt, /\{\{\w+\}\}/);
});

test("buildPrompt renders a single-frame payload the same way", () => {
  const prompt = promptFor(ONE_FRAME);
  assert.match(prompt, /### Checkout — frame, 390x844/);
  assert.match(prompt, /1 screens/);
});

// A frame named "{{laws}}" would otherwise have its name substituted a second time when
// the envelope is rendered, dropping the whole ruleset into the middle of a heading.
test("buildPrompt does not re-render values that came from a frame name", () => {
  const prompt = promptFor({ screens: [{ name: "{{laws}}", nodeId: "1:1" }] });
  assert.match(prompt, /### \{\{laws\}\} —/);
});

// Notes in prompt.md are addressed to whoever edits it, not to the designer approving the
// send — one of them reached the composer verbatim, taking its own {{laws}} example with it
// and pasting the entire ruleset into the middle of a sentence about not pasting it.
test("buildPrompt keeps editor notes out of the composer", () => {
  const std = standardsWith([
    "Build {{screenCount}}.",
    "<!-- a note to whoever edits this, mentioning {{laws}} -->",
    SCREEN_BEGIN + " -->",
    "### {{name}}",
    SCREEN_END,
    "<!-- another note -->",
    "Tail.",
  ].join("\n"));
  const data = { screens: [{ name: "One", nodeId: "1:1" }] };
  const prompt = buildPrompt(templateVars(data, std), std, screensOf(data));
  assert.doesNotMatch(prompt, /a note to whoever|another note/);
  assert.doesNotMatch(prompt, /No guessing/);
  assert.match(prompt, /### One/);
  assert.match(prompt, /Tail\./);
});

// Comments are stripped per piece and before rendering, never from the assembled prompt.
// "<!--" and "-->" are both legal Figma layer names, and a pass over the finished text
// would let one screen open a comment that swallowed every screen listed after it.
test("buildPrompt cannot have its text commented out by a frame name", () => {
  const prompt = promptFor({
    screens: [
      { name: "<!--", nodeId: "1:1" },
      { name: "Middle", nodeId: "2:2" },
      { name: "-->", nodeId: "3:3" },
    ],
  });
  assert.match(prompt, /### Middle/);
  assert.match(prompt, /2:2/);
});

// ---- the laws on folder state -----------------------------------------------
// What the folder already holds used to be asserted by the bridge, from a flag set while the
// target was resolved. It is now law text, because the bridge's answer is a snapshot: between
// resolving the target and Claude Code opening it, the designer can empty the folder in
// Finder and an earlier session can leave half a build in it. The laws tell the agent to look
// instead, and the agent looks after both of those have happened.
//
// Asserted against the shipped file rather than a fixture, and inside the managed block,
// because that block is the only part writeLaws() copies into the project. Deliberately loose,
// like the laws-reach-the-agent test below: this is prose meant to be rewritten by someone who
// doesn't ship code, so the test is pitched to fail when the guidance is *gone* rather than
// when it is reworded. Nothing in laws 1–10 mentions a folder being empty, so that word
// disappearing means the preamble did.
test("the shipped laws still tell the agent to look at the folder", () => {
  const laws = fs.readFileSync(path.join(__dirname, "..", "standards", "figma-laws.md"), "utf8");
  const managed = laws.slice(laws.indexOf(LAWS_BEGIN), laws.indexOf(LAWS_END));

  assert.match(managed, /folder/i, "the laws have to talk about the target folder at all");
  assert.match(managed, /empty/i, "the branch for a folder with nothing in it");
  assert.match(managed, /in place|already holds|existing codebase/i, "the branch for one with work in it");
});

// The bridge asserting nothing about the folder is the point of the change: it measured that
// while resolving the target, and the agent read the claim after the deeplink opened. Matching
// the deleted sentences rather than any mention of a folder, so a comment can still explain
// why they went.
test("the bridge no longer states what the target folder holds", () => {
  const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  assert.doesNotMatch(source, /already holds a previous build/);
  assert.doesNotMatch(source, /new, empty prototype folder/);
  assert.doesNotMatch(source, /reuse its components, tokens and layout patterns/);
});

// ---- firstScreenName --------------------------------------------------------
test("firstScreenName names the folder after whatever was picked first", () => {
  assert.equal(firstScreenName({ name: "Solo" }), "Solo");
  assert.equal(firstScreenName({ screens: [{ name: "One" }, { name: "Two" }] }), "One");
  // Falls back to the envelope rather than undefined, which would slugify to "" and throw.
  assert.equal(firstScreenName({ name: "Solo", screens: [] }), "Solo");
});

// ~/.claude.json holds the designer's whole Claude Code history and has no versioned
// contract, so the bar is: add exactly one key, or change nothing at all.
test.describe("trustProject", () => {
  const { trustProject } = bridge;
  const write = (dir, value) => {
    const file = path.join(dir, "claude.json");
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2));
    return file;
  };

  test("marks the directory trusted", (t) => {
    const dir = tmpdir(t);
    const file = write(dir, { numStartups: 3, projects: {} });
    assert.equal(trustProject("/Users/x/Design-Prototypes/checkout", file), true);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(after.projects["/Users/x/Design-Prototypes/checkout"].hasTrustDialogAccepted, true);
    assert.equal(after.numStartups, 3);
  });

  test("keeps every other project and key untouched", (t) => {
    const dir = tmpdir(t);
    const file = write(dir, {
      numStartups: 9,
      tipsHistory: { a: 1 },
      projects: {
        "/Users/x/other": { hasTrustDialogAccepted: true, history: ["one", "two"] },
      },
    });
    trustProject("/Users/x/new", file);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(after.projects["/Users/x/other"], { hasTrustDialogAccepted: true, history: ["one", "two"] });
    assert.deepEqual(after.tipsHistory, { a: 1 });
    assert.equal(after.numStartups, 9);
  });

  test("preserves the rest of an existing entry for the same directory", (t) => {
    const dir = tmpdir(t);
    const file = write(dir, {
      projects: { "/Users/x/p": { hasTrustDialogAccepted: false, projectOnboardingSeenCount: 4 } },
    });
    trustProject("/Users/x/p", file);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(after.projects["/Users/x/p"].hasTrustDialogAccepted, true);
    assert.equal(after.projects["/Users/x/p"].projectOnboardingSeenCount, 4);
  });

  test("writes nothing when it is already trusted", (t) => {
    const dir = tmpdir(t);
    const file = write(dir, { projects: { "/Users/x/p": { hasTrustDialogAccepted: true } } });
    const before = fs.readFileSync(file, "utf8");
    assert.equal(trustProject("/Users/x/p", file), false);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });

  // Every one of these is a reason to walk away rather than guess at the file's shape.
  test("leaves a file it doesn't understand exactly as it found it", (t) => {
    for (const bad of ['{"projects": []}', '{"projects": 7}', "[1,2,3]", "null", "not json at all", '{"projects":{"/Users/x/p":"oops"}}']) {
      const dir = tmpdir(t);
      const file = write(dir, bad);
      assert.equal(trustProject("/Users/x/p", file), false, bad);
      assert.equal(fs.readFileSync(file, "utf8"), bad, bad);
    }
  });

  test("does nothing when the config isn't there", (t) => {
    assert.equal(trustProject("/Users/x/p", path.join(tmpdir(t), "absent.json")), false);
  });

  test("round-trips the exact serialisation Claude Code uses", (t) => {
    const dir = tmpdir(t);
    const original = { numStartups: 1, projects: { "/a": { hasTrustDialogAccepted: true } } };
    const file = path.join(dir, "claude.json");
    fs.writeFileSync(file, JSON.stringify(original, null, 2));
    trustProject("/b", file);
    const raw = fs.readFileSync(file, "utf8");
    // Two-space indent, no trailing newline — otherwise every send rewrites the whole file.
    assert.equal(raw, JSON.stringify(JSON.parse(raw), null, 2));
    assert.ok(!raw.endsWith("\n"));
  });

  test("leaves no temp file behind", (t) => {
    const dir = tmpdir(t);
    const file = write(dir, { projects: {} });
    trustProject("/Users/x/p", file);
    assert.deepEqual(fs.readdirSync(dir), ["claude.json"]);
  });
});

// It used to collapse the home prefix to `~`, which reads as noise to an engineer and as a
// question to a designer: the line naming where a build is about to land is the wrong place
// to make someone decode shell notation.
test("displayPath writes a path out in full", () => {
  const { displayPath } = bridge;
  const home = os.homedir();
  assert.equal(displayPath(path.join(home, "Design-Prototypes")), path.join(home, "Design-Prototypes"));
  assert.equal(displayPath(home), home);
  assert.equal(displayPath("/tmp/elsewhere"), "/tmp/elsewhere");
  assert.ok(!displayPath(home).includes("~"));
});

test("lawsForPrompt strips the managed-block comments", () => {
  assert.doesNotMatch(lawsForPrompt(GOOD_LAWS), /<!--/);
  assert.match(lawsForPrompt(GOOD_LAWS), /No guessing/);
});

// ---- request guards ---------------------------------------------------------
test("hostAllowed accepts loopback names and rejects everything else", () => {
  for (const host of ["localhost:7331", "127.0.0.1:7331", "[::1]:7331", "localhost"]) {
    assert.equal(hostAllowed({ headers: { host } }), true, host);
  }
  // A hostile name resolving to 127.0.0.1 still arrives with its own Host header.
  for (const host of ["evil.com:7331", "attacker.test", "127.0.0.1.evil.com:7331", ""]) {
    assert.equal(hostAllowed({ headers: { host } }), false, host);
  }
});

test("originAllowed admits the plugin sandbox and refuses web pages", () => {
  assert.equal(originAllowed({ headers: {} }), true, "no Origin (plugin sandbox)");
  assert.equal(originAllowed({ headers: { origin: "null" } }), true, "opaque origin");
  assert.equal(originAllowed({ headers: { origin: "https://www.figma.com" } }), true);
  assert.equal(originAllowed({ headers: { origin: "https://evil.com" } }), false);
  assert.equal(originAllowed({ headers: { origin: "http://localhost:3000" } }), false);
});

// ---- readBody ---------------------------------------------------------------
// A Figma frame name routinely carries accents, arrows and emoji. Accumulating chunks
// with `b += chunk` decoded each one independently, so any multi-byte character landing
// on a chunk boundary arrived as replacement characters — in the prompt and the folder name.
const { PassThrough } = require("node:stream");

function fakeRequest(headers) {
  const req = new PassThrough();
  req.headers = headers || { "content-type": "application/json" };
  req.setTimeout = () => {};
  return req;
}

test("readBody decodes multi-byte characters split across chunks", (t, done) => {
  const name = "Café → Página • 🎨 Ünïcode";
  const buf = Buffer.from(JSON.stringify({ name }), "utf8");
  const req = fakeRequest();
  bridge.readBody(req, (err, data) => {
    assert.ifError(err);
    assert.equal(data.name, name);
    done();
  });
  // One byte at a time is the worst case: every multi-byte character is split.
  for (let i = 0; i < buf.length; i++) req.write(buf.subarray(i, i + 1));
  req.end();
});

test("readBody treats an empty body as an empty object", (t, done) => {
  const req = fakeRequest();
  bridge.readBody(req, (err, data) => {
    assert.ifError(err);
    assert.deepEqual(data, {});
    done();
  });
  req.end();
});

test("readBody rejects a non-JSON content type", (t, done) => {
  const req = fakeRequest({ "content-type": "text/plain" });
  bridge.readBody(req, (err) => {
    assert.match(err.message, /application\/json/);
    done();
  });
});

test("readBody rejects a body past the size cap", (t, done) => {
  const req = fakeRequest();
  bridge.readBody(req, (err) => {
    assert.match(err.message, /too large/);
    done();
  });
  req.write(Buffer.alloc(70 * 1024, "a"));
  req.end();
});

test("readBody reports malformed JSON rather than throwing", (t, done) => {
  const req = fakeRequest();
  bridge.readBody(req, (err) => {
    assert.ok(err instanceof SyntaxError);
    done();
  });
  req.end("{not json");
});

// ---- the shipped prompt -----------------------------------------------------
// The laws reach the agent one of two ways: pasted into the composer by {{laws}}, or
// loaded from the CLAUDE.md the bridge writes before Claude Code opens. The prompt was
// shortened by switching from the first to the second, and an edit that drops both would
// send a build with no rules at all and nothing failing to say so.
test("the shipped prompt still gets the laws in front of the agent", () => {
  const tpl = fs.readFileSync(path.join(__dirname, "..", "standards", "prompt.md"), "utf8");
  const body = tpl.replace(/<!--[\s\S]*?-->/g, "");
  assert.ok(
    body.includes("{{laws}}") || /CLAUDE\.md/.test(body),
    "prompt.md neither inlines {{laws}} nor points at CLAUDE.md"
  );
});

// The link is the only copy of the laws a person can reach from the composer, and a 404
// looks identical to a working link until someone clicks it. Checked against the repo
// rather than over the network: this catches the failure that actually happens — a file
// renamed or moved under standards/ — without making the suite need an internet connection.
test("a laws link in the prompt points at a file that exists", () => {
  const tpl = fs.readFileSync(path.join(__dirname, "..", "standards", "prompt.md"), "utf8");
  const links = tpl.match(/https?:\/\/\S*?standards\/[\w.-]+/g) || [];
  for (const link of links) {
    const file = link.slice(link.lastIndexOf("/") + 1);
    assert.ok(
      fs.existsSync(path.join(__dirname, "..", "standards", file)),
      `prompt.md links to standards/${file}, which is not in this repo`
    );
  }
});

// The table in README.md is what someone editing prompt.md works from, and it drifted for a
// long time without anything noticing: it listed {{frameName}} and {{frameType}}, which have
// never existed, and went on listing {{buildContext}} after it was deleted. A name in that
// table that resolves to nothing is a line rendered literally into the composer, and a real
// one missing from it is a value nobody knows they can use. Compared as a set of names, so
// rewording or regrouping the table costs nothing.
test("the README's placeholder table matches what the templates can actually use", () => {
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  const row = readme.split("\n").find((line) => line.startsWith("| `prompt.md`"));
  assert.ok(row, "the prompt.md row of the placeholder table in README.md");

  const documented = (row.match(/\{\{(\w+)\}\}/g) || []).map((p) => p.slice(2, -2));
  const standards = { files: { "figma-laws.md": { text: GOOD_LAWS } } };
  const available = [
    ...Object.keys(templateVars(ONE_FRAME, standards)),
    ...Object.keys(screenVars(screensOf(ONE_FRAME)[0])),
  ];

  assert.deepEqual(documented.sort(), available.sort());
});

// ---- the destination list ---------------------------------------------------
// It used to be a scan of the destination directory, which in a home directory means
// Library, Movies and node_modules offered as places to build a prototype, with the folder
// the designer actually wanted buried among them. What they want back is where they built
// last, so the list is now exactly that.
//
test("the most recent build is the first one offered", (t) => {
  const dir = tmpdir(t);
  const first = path.join(dir, "first"); fs.mkdirSync(first);
  const second = path.join(dir, "second"); fs.mkdirSync(second);
  assert.deepEqual(bridge.nextRecents([first], second), [second, first]);
});

test("building into the same folder twice leaves one entry", (t) => {
  const dir = tmpdir(t);
  const a = path.join(dir, "a"); fs.mkdirSync(a);
  const b = path.join(dir, "b"); fs.mkdirSync(b);
  assert.deepEqual(bridge.nextRecents([a, b], a), [a, b]);
});

// A remembered folder the designer has since deleted or renamed in Finder. Offering it
// would resolve to a path that isn't there, and the send would fail after they pressed it.
test("a remembered folder that is gone drops off the list", (t) => {
  const dir = tmpdir(t);
  const here = path.join(dir, "here"); fs.mkdirSync(here);
  assert.deepEqual(bridge.usableRecents([here, path.join(dir, "gone")]), [here]);
});

// prefs.json is hand-editable and survives upgrades, so the list can be anything.
test("a junk recents list doesn't take the dropdown with it", () => {
  assert.deepEqual(bridge.usableRecents(null), []);
  assert.deepEqual(bridge.usableRecents(["", 7, null]), []);
});

test("the recents list stops growing", (t) => {
  const dir = tmpdir(t);
  const made = [];
  for (let i = 0; i < 12; i++) {
    const full = path.join(dir, `p${i}`);
    fs.mkdirSync(full);
    made.unshift(full);
    assert.ok(bridge.nextRecents(made.slice(1), full).length <= 8);
  }
});

// ---- the update channel -----------------------------------------------------
// Designers follow `release`, which is moved deliberately; a canary machine follows `main`.
// Every one of them installed from `main`, and none will re-run an installer to change a
// branch they don't know exists, so the switch has to happen inside the pull — which means
// this code runs `git checkout` unattended on other people's machines. The guards are the
// whole point of it, so they are what's tested.
const { execFileSync } = require("node:child_process");

function git(repo, ...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// A remote and a clone of it, both real, both thrown away afterwards.
function clonedRepo(t, branches) {
  const root = tmpdir(t);
  const origin = path.join(root, "origin");
  const work = path.join(root, "clone");
  fs.mkdirSync(origin);

  git(origin, "init", "--quiet", "--initial-branch=main");
  git(origin, "config", "user.email", "t@example.com");
  git(origin, "config", "user.name", "T");
  fs.writeFileSync(path.join(origin, "readme"), "one");
  git(origin, "add", "-A");
  git(origin, "commit", "--quiet", "-m", "one");
  for (const b of branches || []) git(origin, "branch", b);

  git(root, "clone", "--quiet", origin, work);
  git(work, "config", "user.email", "t@example.com");
  git(work, "config", "user.name", "T");
  return work;
}

test("a clone follows its channel once that branch exists", async (t) => {
  const repo = clonedRepo(t, ["release"]);
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(await bridge.ensureChannel(repo, "release"), "release");
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "release");
});

// Every machine in the window between shipping this code and cutting the first release.
// Staying on main is right; failing the pull, or landing on a detached HEAD, is not.
test("no release branch yet leaves the clone where it is", async (t) => {
  const repo = clonedRepo(t, []);
  assert.equal(await bridge.ensureChannel(repo, "release"), "main");
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "main");
});

// On a designer's Mac this is standards/ edited by hand; on a developer's it is everything.
// Either way an unattended checkout would be taking work away from someone.
test("a dirty tree is never checked out from under", async (t) => {
  const repo = clonedRepo(t, ["release"]);
  fs.writeFileSync(path.join(repo, "readme"), "edited by hand");
  assert.equal(await bridge.ensureChannel(repo, "release"), "main");
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(fs.readFileSync(path.join(repo, "readme"), "utf8"), "edited by hand");
});

test("a machine already on its channel is left alone", async (t) => {
  const repo = clonedRepo(t, ["release"]);
  await bridge.ensureChannel(repo, "release");
  assert.equal(await bridge.ensureChannel(repo, "release"), "release");
});

// The canary, which is the same mechanism pointed the other way.
test("a canary can be moved back onto main", async (t) => {
  const repo = clonedRepo(t, ["release"]);
  await bridge.ensureChannel(repo, "release");
  assert.equal(await bridge.ensureChannel(repo, "main"), "main");
});

// ---- project ids ------------------------------------------------------------
test("projectId is stable and does not leak the path", () => {
  const id = projectId("/Users/someone/Projects/storefront");
  assert.equal(id, projectId("/Users/someone/Projects/storefront"));
  assert.notEqual(id, projectId("/Users/someone/Projects/design-system"));
  assert.doesNotMatch(id, /[/.]/);
  assert.match(id, /^[0-9a-f]{12}$/);
});
