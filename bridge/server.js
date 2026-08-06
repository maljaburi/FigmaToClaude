#!/usr/bin/env node
// Local bridge for the "Send to Claude Code" Figma plugin.
//
// A Figma plugin can only reach http/https/ws/wss, so it can't launch anything on
// this Mac by itself. This server is the missing half: it takes the frame the
// designer selected, builds the prompt from standards/, and opens Claude Code
// desktop on it via `claude://code/new?q=...&folder=...`.
//
// No dependencies — run with `node server.js` (or double-click start.command).
//
//   PORT=7331            port to listen on
//   PROTOTYPES_DIR=/path where "New prototype" builds land (default ~/Design-Prototypes)
//   PROJECT_ROOTS=a:b    colon-separated dirs to scan for existing projects
//   STANDARDS_URL=https://.../standards/  org-hosted laws + prompt template;
//                        wins over the bundled copies so one edit reaches every designer
//   BUILD_MODEL=opus     model pinned per project (empty string to leave it alone)
//   BUILD_EFFORT=xhigh   effort pinned per project; low|medium|high|xhigh only
//   SELF_UPDATE=0        don't `git pull` standards/ before a send
//   SKIP_AUTOSETUP=1     don't auto-connect the Figma MCP on startup

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");

const PORT = process.env.PORT || 7331;
const HOME = os.homedir();
const PROTOTYPES_DIR = process.env.PROTOTYPES_DIR || path.join(HOME, "Design-Prototypes");
const PROJECT_ROOTS = (process.env.PROJECT_ROOTS || [HOME, path.join(HOME, "Desktop", "Projects"), PROTOTYPES_DIR].join(":"))
  .split(":").filter(Boolean);
const FIGMA_MCP_URL = "https://mcp.figma.com/mcp";
// Every word that reaches Claude Code is a file in standards/, never a string in this
// server, so the wording can be edited and distributed without shipping code.
//   figma-laws.md — inlined into the prompt, and copied into the project's CLAUDE.md
//                   so it survives a long build even if the prompt scrolls away
//   prompt.md     — what appears in the Claude Code composer
const STANDARDS = ["figma-laws.md", "prompt.md"];
// Pinned per project via .claude/settings.json, because the claude://code/new deeplink
// has no model or effort parameter. `effortLevel` only persists low|medium|high|xhigh:
// "max" exists as a live level but its schema uses .catch(), so an invalid value is
// silently dropped and you'd get the default while believing you'd pinned max.
const PERSISTABLE_EFFORT = ["low", "medium", "high", "xhigh"];
const SELF_UPDATE = process.env.SELF_UPDATE !== "0";
const BUILD_MODEL = process.env.BUILD_MODEL || "opus";
const BUILD_EFFORT = process.env.BUILD_EFFORT || "xhigh";
const STANDARDS_DIR = path.join(__dirname, "..", "standards");
const STANDARDS_URL = process.env.STANDARDS_URL || "";
const STANDARDS_CACHE = path.join(HOME, ".figma-to-claude", "standards");
const STANDARDS_TTL_MS = 5 * 60 * 1000;
const LAWS_BEGIN = "<!-- FIGMA-TO-CLAUDE-CODE:BEGIN";
const LAWS_END = "<!-- FIGMA-TO-CLAUDE-CODE:END -->";

// Run a command in a login shell so it inherits the user's PATH — needed to find
// `claude` when the bridge is launched from Finder/launchd, not a terminal.
const EXTRA_PATH = "$HOME/.local/bin:$HOME/.claude/bin:$HOME/bin:/opt/homebrew/bin:/usr/local/bin";
function sh(command, opts, cb) {
  if (typeof opts === "function") { cb = opts; opts = {}; }
  execFile("/bin/zsh", ["-lc", `export PATH="${EXTRA_PATH}:$PATH"; ${command}`],
    Object.assign({ timeout: 30000, maxBuffer: 64 * 1024 * 1024 }, opts),
    (err, stdout, stderr) => cb(err, (stdout || "").trim(), (stderr || "").trim()));
}

// ---- Figma MCP wiring -------------------------------------------------------
let figmaReady = false;
let ensureWaiters = null; // callbacks queued while a connect is already in flight
let claudePathCache = null;

function hasClaude(cb) {
  if (claudePathCache) return cb(true, claudePathCache);
  sh("command -v claude || true", (e, out) => { if (out) claudePathCache = out; cb(!!out, out); });
}
function hasFigmaMcp(cb) { sh("claude mcp get figma >/dev/null 2>&1 && echo yes || echo no", (e, out) => cb(out === "yes")); }

// The deeplink opens the desktop app, so the CLI being present says nothing about
// whether the thing we're about to launch actually exists.
function hasClaudeApp() {
  return ["/Applications/Claude.app", path.join(HOME, "Applications", "Claude.app")]
    .some((p) => fs.existsSync(p));
}

// Registered is not the same as authorized: `mcp add` succeeds immediately but the
// server sits at "Needs authentication" until someone approves the OAuth in a browser.
// Reporting that as connected sends designers into builds that can't read the design.
let mcpState = { value: null, at: 0 };
const MCP_STATE_TTL_MS = 20000;
function figmaMcpState(cb) {
  if (mcpState.value && Date.now() - mcpState.at < MCP_STATE_TTL_MS) return cb(mcpState.value);
  sh("claude mcp get figma 2>&1", (e, out) => {
    const text = out || "";
    let state = "missing";
    if (/needs authentication/i.test(text)) state = "needs-auth";
    else if (/connected/i.test(text)) state = "connected";
    mcpState = { value: state, at: Date.now() };
    cb(state);
  });
}
function addFigmaMcp(cb) { sh(`claude mcp add --scope user --transport http figma ${FIGMA_MCP_URL}`, cb); }

function ensureFigmaMcp(cb) {
  if (figmaReady) return cb(null, true, "already connected");
  if (ensureWaiters) { ensureWaiters.push(cb); return; } // coalesce concurrent calls
  ensureWaiters = [cb];
  const finish = (err, ok, note) => {
    const waiters = ensureWaiters; ensureWaiters = null;
    waiters.forEach((w) => w(err, ok, note));
  };
  hasClaude((claude) => {
    if (!claude) return finish(new Error("`claude` CLI not found on PATH"), false);
    hasFigmaMcp((present) => {
      if (present) { figmaReady = true; return finish(null, true, "already connected"); }
      addFigmaMcp((err, out, errout) => {
        const msg = errout || (err && err.message) || "";
        // `mcp add` errors with "already exists" if another run beat us to it — that's fine.
        if (err && !/already exists/i.test(msg)) return finish(new Error(msg), false);
        figmaReady = true;
        finish(null, true, /already exists/i.test(msg)
          ? "already connected"
          : "connected — run /mcp in Claude Code once to authorize Figma in your browser");
      });
    });
  });
}

// ---- project discovery ------------------------------------------------------
// Anything with a package.json or a .git dir is a plausible build target.
function looksLikeProject(dir) {
  try {
    return fs.existsSync(path.join(dir, "package.json")) || fs.existsSync(path.join(dir, ".git"));
  } catch (e) { return false; }
}

function listProjects() {
  const seen = new Set();
  const out = [];
  for (const root of PROJECT_ROOTS) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const full = path.join(root, entry.name);
      if (seen.has(full) || !looksLikeProject(full)) continue;
      seen.add(full);
      out.push({ path: full, name: entry.name });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ---- target folders ---------------------------------------------------------
function slugify(text) {
  return String(text || "frame").toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 40) || "frame";
}

function shortId() {
  return Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 6);
}

// ---- the laws ---------------------------------------------------------------
// Point STANDARDS_URL at an org-hosted standards/ directory and every designer picks up
// an edit on their next send. Falls back to the last good fetch, then to the bundled
// copy, so a flaky network can't strip the standards out of a build.
const standardsCache = new Map(); // name -> { text, version, source, at }

function versionOf(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 7);
}

// Guards against a login page or error body being accepted as a standard.
function looksValid(name, text) {
  if (!text) return false;
  if (name === "figma-laws.md") return text.includes(LAWS_BEGIN);
  return text.indexOf("{{") !== -1; // the templates must carry placeholders
}

// STANDARDS_URL can't authenticate against a private repo, so for a private org repo the
// distribution channel is git: every designer already has a clone (that's how the bridge
// got installed), so a `git pull` before loading picks up an edit to standards/ without
// any token handling. Throttled to the same window as the standards cache.
let lastPull = 0;
let restartPending = false;

// launchd sets this to the agent label. Absent it, we were started by hand via
// start.command — and exiting then would just stop the bridge with nothing to revive it.
const UNDER_LAUNCHD = String(process.env.XPC_SERVICE_NAME || "").includes("figma-to-claude");

function refreshFromGit(cb) {
  if (SELF_UPDATE === false) return cb();
  if (Date.now() - lastPull < STANDARDS_TTL_MS) return cb();
  lastPull = Date.now();
  const repo = path.join(__dirname, "..");
  if (!fs.existsSync(path.join(repo, ".git"))) return cb();

  // Record the sha either side of the pull so we know both whether anything arrived
  // and, specifically, whether any of it was code this process is already running.
  // --ff-only: never rewrite a designer's local edit, just decline to update.
  const cmd = `cd "${repo}" && before=$(git rev-parse HEAD) && git pull --ff-only --quiet ` +
    `&& after=$(git rev-parse HEAD) && echo "$before $after" && git diff --name-only "$before" "$after"`;

  sh(cmd, { timeout: 15000 }, (err, out, errout) => {
    if (err) {
      console.log(`standards: git pull skipped (${(errout || err.message).split("\n")[0]})`);
      return cb();
    }
    const lines = out.split("\n").filter(Boolean);
    const [before, after] = (lines.shift() || "").split(" ");
    if (!after || before === after) return cb(); // already current

    standardsCache.clear(); // the pull may have changed them; don't serve the old copy
    console.log(`updated ${String(before).slice(0, 7)} → ${String(after).slice(0, 7)}`);

    // standards/ is re-read from disk every send, so those changes are already live.
    // bridge/ is the code running right now, and that only changes on a restart.
    const codeChanged = lines.filter((f) => f.startsWith("bridge/"));
    if (codeChanged.length) {
      if (UNDER_LAUNCHD) {
        restartPending = true;
        console.log(`  bridge code changed (${codeChanged.join(", ")}) — restarting after this send`);
      } else {
        console.log(`  bridge code changed (${codeChanged.join(", ")}) — restart it to pick this up`);
      }
    }
    cb();
  });
}

// Called once the response is out the door: exiting mid-send would drop it. launchd's
// KeepAlive brings us straight back on the new code.
function maybeRestart() {
  if (!restartPending) return;
  restartPending = false;
  setTimeout(() => {
    console.log("restarting to load the new bridge code");
    process.exit(0);
  }, 500);
}

async function loadStandard(name) {
  const hit = standardsCache.get(name);
  if (hit && Date.now() - hit.at < STANDARDS_TTL_MS) return hit;

  const remember = (text, source) => {
    const entry = { text: text, version: versionOf(text), source: source, at: Date.now() };
    standardsCache.set(name, entry);
    return entry;
  };
  const cacheFile = path.join(STANDARDS_CACHE, name);

  if (STANDARDS_URL) {
    const url = STANDARDS_URL.replace(/\/?$/, "/") + name;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const text = (await res.text()).trim();
      if (!looksValid(name, text)) throw new Error(`response doesn't look like ${name}`);
      fs.mkdirSync(STANDARDS_CACHE, { recursive: true });
      fs.writeFileSync(cacheFile, text);
      return remember(text, "org");
    } catch (e) {
      console.log(`standards: couldn't fetch ${url} (${e.message}) — falling back to cache/bundled`);
    }
    try {
      const text = fs.readFileSync(cacheFile, "utf8").trim();
      if (looksValid(name, text)) return remember(text, "cache");
    } catch (e) {}
  }

  try {
    const text = fs.readFileSync(path.join(STANDARDS_DIR, name), "utf8").trim();
    if (looksValid(name, text)) return remember(text, "local");
  } catch (e) {}
  return null;
}

// All three or nothing. A build missing one of them is worse than no build at all.
async function loadStandards() {
  const files = {};
  for (const name of STANDARDS) {
    const entry = await loadStandard(name);
    if (!entry) return { ok: false, missing: name };
    files[name] = entry;
  }
  return {
    ok: true,
    files: files,
    version: versionOf(STANDARDS.map((n) => files[n].version).join(":")),
    source: files["figma-laws.md"].source,
  };
}

function render(tpl, vars) {
  // Unknown placeholders are left visible on purpose: a template typo should show up in
  // the output rather than silently becoming an empty string.
  return tpl.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
}

// Copy the laws into the project's CLAUDE.md so they stay in context for the whole
// build, not just the first turn. Idempotent, and preserves anything the project
// already had outside the managed block.
function writeLaws(dir, lawsText) {
  const target = path.join(dir, "CLAUDE.md");
  let existing = "";
  try { existing = fs.readFileSync(target, "utf8"); } catch (e) {}

  const start = existing.indexOf(LAWS_BEGIN);
  const end = existing.indexOf(LAWS_END);
  let next;
  if (start !== -1 && end !== -1 && end > start) {
    next = existing.slice(0, start) + lawsText + existing.slice(end + LAWS_END.length);
  } else {
    next = existing ? existing.replace(/\s*$/, "") + "\n\n" + lawsText + "\n" : lawsText + "\n";
  }
  if (next !== existing) fs.writeFileSync(target, next);

  // Read it back. "The laws were injected" has to be a fact, not an assumption.
  const written = fs.readFileSync(target, "utf8");
  if (!written.includes(LAWS_BEGIN) || !written.includes(LAWS_END)) {
    throw new Error(`wrote CLAUDE.md but the managed block isn't there: ${target}`);
  }
}

// Pin the model and effort for this project. The deeplink can't carry them, so they go
// in the project's own settings, which the desktop app reads when it opens the folder.
// Returns a short note for the log, or null if nothing was written.
function pinModel(dir) {
  if (!BUILD_MODEL && !BUILD_EFFORT) return null;

  const target = path.join(dir, ".claude", "settings.json");
  let settings = {};
  let existed = false;
  try {
    const raw = fs.readFileSync(target, "utf8");
    existed = true;
    settings = JSON.parse(raw);
  } catch (e) {
    // A settings file we can't parse (comments, hand-edited) is not ours to rewrite.
    if (existed) {
      console.log(`  model: left ${target} alone — it isn't valid JSON`);
      return null;
    }
  }

  if (BUILD_MODEL) settings.model = BUILD_MODEL;
  if (BUILD_EFFORT) {
    if (!PERSISTABLE_EFFORT.includes(BUILD_EFFORT)) {
      // Silently dropped by the settings schema otherwise, which looks like it worked.
      console.log(`  model: BUILD_EFFORT="${BUILD_EFFORT}" can't be persisted (only ${PERSISTABLE_EFFORT.join("/")}) — leaving effort unset`);
      delete settings.effortLevel;
    } else {
      settings.effortLevel = BUILD_EFFORT;
    }
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(settings, null, 2) + "\n");
  return `${settings.model || "(default)"}${settings.effortLevel ? " @ " + settings.effortLevel : ""}`;
}

// Always hand Claude Code a Dev Mode link (m=dev). The plugin already builds one, but
// normalise here too so a pasted design link becomes a dev link as well.
function figmaUrl(info) {
  let url = info.url;
  if (!url) {
    if (!info.fileKey) return null;
    const nodeParam = info.urlNodeId || String(info.nodeId || "").replace(/:/g, "-");
    const slug = encodeURIComponent(String(info.file || "").trim().replace(/\s+/g, "-").replace(/[^\w-]/g, "")) || "frame";
    url = `https://www.figma.com/design/${info.fileKey}/${slug}?node-id=${nodeParam}`;
  }
  if (!/[?&]m=dev(&|$)/.test(url)) url += (url.indexOf("?") === -1 ? "?" : "&") + "m=dev";
  return url;
}

// The laws go into the prompt verbatim, minus the managed-block HTML comments that only
// exist so the CLAUDE.md copy can be found and replaced later.
function lawsForPrompt(text) {
  return text.replace(/<!--[\s\S]*?-->/g, "").trim();
}

function templateVars(info, standards) {
  const url = figmaUrl(info);
  const nodeId = info.nodeId || "(unknown)";

  return {
    frameName: info.name || "(unnamed)",
    frameType: String(info.type || "FRAME").toLowerCase(),
    size: info.width && info.height ? `${info.width}x${info.height}` : "size unknown",
    file: info.file || "(unknown)",
    page: info.page || "(unknown)",
    nodeId: nodeId,
    devLink: url || "(none available)",
    laws: lawsForPrompt(standards.files["figma-laws.md"].text),
    designSource: url
      ? `Dev Mode link: ${url}`
      : `Figma node id: ${nodeId} — no link available, so read it from the current selection via the local Dev Mode MCP, and STOP and ask rather than guessing at any value.`,
  };
}

// The prompt has to stand on its own: a designer reading the composer should see which
// frame is about to be built and where the design is read from. Wording lives in
// standards/prompt.md, not here, so it can be edited without shipping code.
function buildPrompt(vars, standards) {
  return render(standards.files["prompt.md"].text, vars).trim();
}

// ---- launching Claude Code desktop -----------------------------------------
// Verified against Claude.app 1.25927.0: the `code/new` route reads `q` (or
// `prompt`) plus repeatable `folder`, trusts the workspace, and opens the new-task
// screen with the prompt pre-filled. The designer presses Enter to start it.
function launchDesktop(dir, prompt, cb) {
  const link = "claude://code/new?q=" + encodeURIComponent(prompt) + "&folder=" + encodeURIComponent(dir);
  execFile("open", [link], (err) => {
    if (err) return cb(err);
    cb(null, "Claude Code is open on this project — press Enter to start the build.");
  });
}

// ---- http -------------------------------------------------------------------
function send(res, code, body, json) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (json) res.setHeader("Content-Type", "application/json");
  res.writeHead(code);
  res.end(json ? JSON.stringify(body) : body);
}

function readBody(req, cb) {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => { try { cb(null, JSON.parse(b || "{}")); } catch (e) { cb(e); } });
}

// Resolve where this build should land.
function resolveTarget(data) {
  const target = data.target || {};
  if (target.mode === "existing" && target.path) {
    if (!fs.existsSync(target.path)) throw new Error(`That project folder no longer exists: ${target.path}`);
    return { dir: target.path, created: false };
  }
  // "New prototype": one folder per frame name, REUSED on later sends. A fresh random
  // folder each time meant Claude Code asked to trust a new directory on every send,
  // and re-sending a frame couldn't iterate on what it built last time.
  const dir = path.join(PROTOTYPES_DIR, slugify(data.name));
  const created = !fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, created };
}

function handleRequest(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, "");

  // Readiness for the plugin's status dots.
  if (req.method === "GET" && req.url === "/status") {
    loadStandards().then((std) => {
      const base = {
        bridge: true,
        laws: std.ok
          ? { ok: true, version: std.version, source: std.source }
          : { ok: false, missing: std.missing },
      };
      base.claudeApp = hasClaudeApp();
      hasClaude((cli, p) => {
        base.claudeCli = cli;
        base.claudePath = p;
        // Both halves matter: the CLI wires up the MCP, the desktop app receives the
        // deeplink. Having one without the other fails at a different step each time.
        base.claude = cli && base.claudeApp;
        if (!cli) return send(res, 200, Object.assign(base, { figmaMcp: false, figmaMcpState: "missing" }), true);
        // Deliberately not short-circuiting on the `figmaReady` flag: that only records
        // that `mcp add` ran, which is true long before anyone authorizes it.
        figmaMcpState((state) => send(res, 200,
          Object.assign(base, { figmaMcp: state === "connected", figmaMcpState: state }), true));
      });
    });
    return;
  }

  // Populates the plugin's project dropdown.
  if (req.method === "GET" && req.url === "/projects") {
    send(res, 200, { prototypesDir: PROTOTYPES_DIR, projects: listProjects() }, true);
    return;
  }

  // The "Connect Figma MCP" button.
  if (req.method === "POST" && req.url === "/setup") {
    ensureFigmaMcp((err, ok, note) => {
      if (err) return send(res, 200, { ok: false, message: err.message }, true);
      send(res, 200, { ok: true, message: "Figma MCP " + note }, true);
    });
    return;
  }

  if (req.method === "POST" && req.url === "/build") {
    readBody(req, async (err, data) => {
      if (err) return send(res, 400, "Bad JSON");

      // A build without the standards is worse than no build: it silently guesses
      // values. So this is a hard stop, never a warning.
      await new Promise(refreshFromGit);
      const std = await loadStandards();
      if (!std.ok) {
        console.error(`  error: standard not available: ${std.missing}`);
        return send(res, 500,
          `Stopped: "${std.missing}" couldn't be loaded, so nothing was sent.\n` +
          (STANDARDS_URL ? `Tried ${STANDARDS_URL}, its cache, then ` : "Expected ") +
          path.join(STANDARDS_DIR, std.missing));
      }

      let dir, created, prompt, pinned;
      try {
        ({ dir, created } = resolveTarget(data));
        writeLaws(dir, std.files["figma-laws.md"].text);
        pinned = pinModel(dir);
        prompt = buildPrompt(templateVars(data, std), std);
      } catch (e) {
        console.error("  error:", e.message);
        return send(res, 500, "Couldn't prepare the project: " + e.message);
      }
      const url = figmaUrl(data);

      console.log(`\n[${new Date().toLocaleTimeString()}] ${created ? "new" : "existing"} → ${dir}`);
      console.log(`  frame: "${data.name}"  ${url || "(no link)"}`);
      console.log(`  standards: ${std.version} (${std.source}) → prompt + CLAUDE.md`);
      if (pinned) console.log(`  model: ${pinned}`);
      console.log(`  prompt: ${prompt.length} chars`);

      // Make sure the MCP is wired before we launch (idempotent, cached).
      ensureFigmaMcp(() => {
        launchDesktop(dir, prompt, (e, message) => {
          if (e) { console.error("  error:", e.message); maybeRestart(); return send(res, 500, "Launch failed: " + e.message); }
          console.log("  " + message);
          send(res, 200, `${created ? "Created" : "Reusing"} ${path.basename(dir)}. ` + message);
          maybeRestart();
        });
      });
    });
    return;
  }

  send(res, 404, "Not found");
}

// Bind both loopback addresses explicitly. Passing the "localhost" hostname binds only
// whichever address DNS happens to return first, so a client that tries the other one
// gets connection refused. A wildcard bind would also fix it, but this server writes
// files and launches apps — it has no business being reachable from the network.
const v6 = http.createServer(handleRequest);
v6.on("error", (err) => console.log(`(not listening on [::1]:${PORT} — ${err.code || err.message})`));
v6.listen(PORT, "::1");

const server = http.createServer(handleRequest);
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use — the bridge is probably already running. Exiting.`);
  } else {
    console.error("Server error:", err.message);
  }
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`figma → claude bridge listening on http://localhost:${PORT}`);
  console.log(`new prototypes land in: ${PROTOTYPES_DIR}`);
  console.log(`scanning for projects in: ${PROJECT_ROOTS.join(", ")}`);
  console.log(`standards from: ${STANDARDS_URL || STANDARDS_DIR}`);
  loadStandards().then((std) => {
    if (!std.ok) return console.log(`standards: "${std.missing}" NOT AVAILABLE — sends will be refused until this is fixed.`);
    console.log(`standards: ${std.version}`);
    for (const name of STANDARDS) console.log(`  ${name}  ${std.files[name].version} (${std.files[name].source})`);
  });
  if (process.env.SKIP_AUTOSETUP) return;
  ensureFigmaMcp((err, ok, note) => {
    if (err) console.log(`figma MCP: not connected yet — ${err.message}. Retries on first send, or click Connect in the plugin.`);
    else console.log(`figma MCP: ${note}`);
  });
});
