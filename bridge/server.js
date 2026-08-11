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
//   PROTOTYPES_DIR=/path where builds land and the directory the panel lists (default ~)
//   STANDARDS_URL=https://.../standards/  org-hosted laws + prompt template;
//                        wins over the bundled copies so one edit reaches every designer
//   BUILD_MODEL=opus     model pinned per project (empty string to leave it alone)
//   BUILD_EFFORT=xhigh   effort pinned per project; low|medium|high|xhigh only
//   PRETRUST=0           stop marking the target trusted in ~/.claude.json, so Claude Code
//                        asks about each folder itself
//   SELF_UPDATE=0        don't `git pull` standards/ before a send
//   SKIP_AUTOSETUP=1     don't auto-connect the Figma MCP on startup

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");

// `fetch` and `AbortSignal.timeout` are the floor, and both are only reachable on 18+.
// Under launchd's KeepAlive an older Node produced a ReferenceError restart loop roughly
// six times a minute, forever, and the only symptom the designer saw was the plugin
// reporting the bridge as not installed.
if (Number(process.versions.node.split(".")[0]) < 18) {
  console.error(`This bridge needs Node 18 or newer — this is Node ${process.versions.node}.`);
  console.error("Install a current Node, then re-run install.command.");
  process.exit(0); // 0, not 1: a failing exit under KeepAlive respawns forever.
}

const PORT = process.env.PORT || 7331;
const HOME = os.homedir();
// The home directory, not a subfolder of it. Claude Code treats the home directory as a
// trusted workspace on most machines, and a build folder created inside an already-trusted
// one inherits that — so a send opens straight into the build instead of a trust prompt.
// It also means a designer's prototypes sit where they already look for their own work.
// The Change button in the panel moves this, and the choice outlives self-updates.
const PROTOTYPES_DIR_DEFAULT = process.env.PROTOTYPES_DIR || HOME;

// A designer can move where new prototypes land from the panel, so it can't live only in
// the LaunchAgent: that is written by the installer, and every re-run and self-update
// would put it back. This file is the one piece of bridge state that outlives both.
const PREFS_FILE = path.join(HOME, ".figma-to-claude", "prefs.json");

function readPrefs() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PREFS_FILE, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    return {};
  }
}

let prefs = readPrefs();

function savePrefs() {
  try {
    fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true });
    writeFileAtomic(PREFS_FILE, JSON.stringify(prefs, null, 2) + "\n");
    return true;
  } catch (e) {
    log(`couldn't save preferences: ${e.message}`);
    return false;
  }
}

function prototypesDir() {
  const chosen = prefs.prototypesDir;
  return typeof chosen === "string" && chosen ? chosen : PROTOTYPES_DIR_DEFAULT;
}

// Written out in full, `/Users/someone/Work` rather than `~/Work`. The home prefix was
// being collapsed as noise, which is true for an engineer reading a terminal and not for a
// designer reading a panel: `~` is shell notation, and someone who has to ask what it means
// cannot check whether the folder about to be built in is the one they meant.
function displayPath(p) {
  return p;
}
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
// Read rather than hardcoded, so the settings panel can't drift from what shipped. Wrapped
// because a missing or malformed package.json should cost a version string, not the bridge.
const BRIDGE_VERSION = (() => {
  try { return require("./package.json").version || "unknown"; } catch (e) { return "unknown"; }
})();
const SELF_UPDATE = process.env.SELF_UPDATE !== "0";
// Which branch a machine follows. `main` is where work lands and is not fit to be running
// on twenty Macs the moment it is pushed; `release` is moved deliberately, so cutting a
// release is a fast-forward rather than a deploy. UPDATE_CHANNEL=main opts one machine into
// every commit, which is how a change gets tried somewhere before it reaches everyone.
const UPDATE_CHANNEL = process.env.UPDATE_CHANNEL || "release";
const BUILD_MODEL = process.env.BUILD_MODEL || "opus";
const BUILD_EFFORT = process.env.BUILD_EFFORT || "xhigh";
const STANDARDS_DIR = path.join(__dirname, "..", "standards");
// Whatever this serves becomes standing instructions for an agent with write access to
// the designer's projects, so plaintext http is refused outright rather than warned about.
const STANDARDS_URL = (() => {
  const raw = process.env.STANDARDS_URL || "";
  if (raw && !/^https:\/\//i.test(raw)) {
    console.error(`STANDARDS_URL must be https:// — ignoring "${raw}" and using the bundled standards.`);
    return "";
  }
  return raw;
})();
const STANDARDS_CACHE = path.join(HOME, ".figma-to-claude", "standards");
const STANDARDS_TTL_MS = 5 * 60 * 1000;
const MAX_STANDARD_BYTES = 512 * 1024;
const LAWS_BEGIN = "<!-- FIGMA-TO-CLAUDE-CODE:BEGIN";
const LAWS_END = "<!-- FIGMA-TO-CLAUDE-CODE:END -->";

// prompt.md carries the per-screen block between these, so the wording of a screen entry
// stays in standards/ rather than becoming a string in here.
const SCREEN_BEGIN = "<!-- SCREEN:BEGIN";
const SCREEN_END = "<!-- SCREEN:END -->";

// The panel warns past 12 and stops here. Enforced on this side as well as in the panel
// because the panel is a published plugin frozen at its publish version, so its own limit
// is whatever it shipped with — this is the one that can be changed.
const MAX_SCREENS = 30;

// This log is the only diagnostic channel for a fleet install, and it is appended to
// across restarts — so every event needs a date, not just a time of day. Without one,
// a crash loop and a month of normal use are indistinguishable.
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

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
let ensureWaiters = null; // callbacks queued while a connect is already in flight
// Cache the miss as well as the hit. Only caching hits meant that in the one state where
// the panel polls hardest — Claude Code not installed yet — every 2s poll forked a login
// shell. And caching the hit forever meant an uninstall was never noticed.
let claudeLookup = { value: null, at: 0 };
let claudeWaiters = null;
const CLAUDE_LOOKUP_TTL_MS = 15000;

function hasClaude(cb) {
  if (claudeLookup.value !== null && Date.now() - claudeLookup.at < CLAUDE_LOOKUP_TTL_MS) {
    return cb(!!claudeLookup.value, claudeLookup.value);
  }
  if (claudeWaiters) { claudeWaiters.push(cb); return; }
  claudeWaiters = [cb];
  sh("command -v claude || true", (e, out) => {
    claudeLookup = { value: out || "", at: Date.now() };
    const waiters = claudeWaiters; claudeWaiters = null;
    waiters.forEach((w) => w(!!out, out));
  });
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
let mcpWaiters = null;
let warnedUnparsedMcp = false;
// "connected" only changes when someone authorizes in a browser, and /setup clears this
// cache explicitly on the one event that changes it — so it can be held much longer than
// the unresolved states, where the panel is actively waiting for a transition.
const MCP_STATE_TTL_MS = 20000;
const MCP_CONNECTED_TTL_MS = 5 * 60 * 1000;

function figmaMcpState(cb) {
  const ttl = mcpState.value === "connected" ? MCP_CONNECTED_TTL_MS : MCP_STATE_TTL_MS;
  if (mcpState.value && Date.now() - mcpState.at < ttl) return cb(mcpState.value);
  // `claude mcp get` takes ~1.7s. Without this, every poll arriving inside that window
  // started its own CLI process, so a 2s poll interval could keep several in flight.
  if (mcpWaiters) { mcpWaiters.push(cb); return; }
  mcpWaiters = [cb];
  sh("claude mcp get figma 2>&1", (e, out) => {
    const text = out || "";
    let state;
    if (/needs authentication/i.test(text)) state = "needs-auth";
    else if (/connected/i.test(text)) state = "connected";
    else if (/no mcp server found|not found/i.test(text) || e) state = "missing";
    else {
      // This is human-readable CLI output with no versioned contract behind it. If the
      // wording changes, defaulting to "missing" routes designers to a Connect button
      // that re-registers an already-registered server forever. "needs-auth" sends them
      // to /mcp instead, which shows the truth and is recoverable either way.
      state = "needs-auth";
      if (!warnedUnparsedMcp) {
        warnedUnparsedMcp = true;
        log(`figma MCP: couldn't classify \`claude mcp get figma\` output, assuming needs-auth:\n${text}`);
      }
    }
    mcpState = { value: state, at: Date.now() };
    const waiters = mcpWaiters; mcpWaiters = null;
    waiters.forEach((w) => w(state));
  });
}
function addFigmaMcp(cb) { sh(`claude mcp add --scope user --transport http figma ${FIGMA_MCP_URL}`, cb); }

// No "already done" latch here. A flag set on the first success is never cleared, so
// after `claude mcp remove figma` the plugin's Connect button reported success without
// touching anything — an unrecoverable loop where the panel stays blocked and the button
// keeps saying it worked. hasFigmaMcp is cheap and the real answer.
function ensureFigmaMcp(cb) {
  if (ensureWaiters) { ensureWaiters.push(cb); return; } // coalesce concurrent calls
  ensureWaiters = [cb];
  const finish = (err, ok, note) => {
    // Every path here can have changed what figmaMcpState() caches. Invalidating only in
    // the /setup route left the first send — which is often what actually connects it —
    // reporting "missing" for the next 20 seconds.
    mcpState = { value: null, at: 0 };
    const waiters = ensureWaiters; ensureWaiters = null;
    waiters.forEach((w) => w(err, ok, note));
  };
  hasClaude((claude) => {
    if (!claude) return finish(new Error("`claude` CLI not found on PATH"), false);
    hasFigmaMcp((present) => {
      if (present) return finish(null, true, "already registered");
      addFigmaMcp((err, out, errout) => {
        const msg = errout || (err && err.message) || "";
        // `mcp add` errors with "already exists" if another run beat us to it — that's fine.
        if (err && !/already exists/i.test(msg)) return finish(new Error(msg), false);
        finish(null, true, /already exists/i.test(msg)
          ? "already registered"
          : "registered — run /mcp in Claude Code once to authorize Figma in your browser");
      });
    });
  });
}

// ---- project discovery ------------------------------------------------------
// Anything with a package.json or a .git dir is a plausible build target.

// Folders this designer has actually built into, newest first. Not a scan of a directory:
// listing every folder in the home directory put Library, node_modules and Movies in a
// dropdown of places to build a prototype, and made the one folder they wanted something to
// hunt for. A first send has none of these and the list simply isn't there.
const MAX_RECENTS = 8;

// Split from the two functions that touch prefs so the rules can be tested without a test
// run rewriting the preferences of whoever ran it.
//
// The existence check is not paranoia: these are folders in Finder, and one renamed or
// thrown away between sends would otherwise still be offered, then fail to resolve after
// the designer had already pressed Send.
function usableRecents(list) {
  return (Array.isArray(list) ? list : [])
    .filter((p) => typeof p === "string" && p && fs.existsSync(p))
    .slice(0, MAX_RECENTS);
}

function nextRecents(list, dir) {
  return [dir, ...usableRecents(list).filter((p) => p !== dir)].slice(0, MAX_RECENTS);
}

function recentTargets() {
  return usableRecents(prefs.recentTargets);
}

// Recorded once the build is away rather than when the target is resolved: a folder that
// failed to prepare is not somewhere to offer going back to.
function rememberRecent(dir) {
  prefs.recentTargets = nextRecents(prefs.recentTargets, dir);
  savePrefs();
}

function listProjects() {
  return recentTargets().map((full) => ({ path: full, name: path.basename(full) }));
}

// The plugin is given opaque ids, never absolute paths. Two reasons: an unauthenticated
// response listing every project is a map of the user's machine, and a path the client
// hands back is a path the client can choose — which made any existing directory on the
// Mac a valid build target. The id can only ever name something this scan produced,
// so the scan itself is the allowlist.
let projectIndex = new Map(); // id -> absolute path

function projectId(fullPath) {
  return crypto.createHash("sha256").update(fullPath).digest("hex").slice(0, 12);
}

// Folders reached through the native picker, which can sit anywhere on disk and so are
// not in the scan. They have to outlive it: publishProjects() rebuilds the index from
// scratch on every poll, and without this a folder chosen a second ago would stop
// resolving before the designer got round to pressing Send.
const chosenTargets = new Map(); // id -> absolute path

function publishProjects() {
  const scanned = listProjects();
  projectIndex = new Map(scanned.map((p) => [projectId(p.path), p.path]));
  const out = scanned.map((p) => ({ id: projectId(p.path), name: p.name }));
  for (const [id, full] of chosenTargets) {
    projectIndex.set(id, full);
    if (!scanned.some((p) => p.path === full)) out.push({ id, name: path.basename(full) });
  }
  return out;
}

// ---- target folders ---------------------------------------------------------
// Errors we author are written for the designer and are safe to show. Anything else —
// EACCES, ENOSPC, a raw fs error — carries absolute paths, so those go to the log and
// the panel gets a generic line instead.
class BuildError extends Error {}

function slugify(text) {
  return String(text || "frame").toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 40) || "frame";
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
// figma-laws.md needs BOTH markers, not just the opening one: a truncated body carrying
// BEGIN without END passes into writeLaws, which appends it, fails its own read-back, and
// leaves an orphaned marker that a later send uses to slice out the designer's own text.
function looksValid(name, text) {
  if (!text) return false;
  if (name === "figma-laws.md") return text.includes(LAWS_BEGIN) && text.includes(LAWS_END);
  // prompt.md needs both screen markers for the same reason the laws need both: the block
  // between them is repeated per selected frame, so a prompt.md missing them would send a
  // twelve-frame selection as a brief describing one frame — wrong, and silently so.
  // Failing here instead routes to the standards-missing screen, which says what to do.
  if (name === "prompt.md" && !(text.includes(SCREEN_BEGIN) && text.includes(SCREEN_END))) return false;
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

let pullInFlight = null;

// execFile with an argument array and cwd, not a shell string. The previous form
// interpolated the install path into `cd "..." && …` inside `zsh -lc`, so a path
// containing a quote, backtick or $( ) was interpreted rather than used.
function gitP(repo, args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: repo, timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => err
        ? reject(new Error(String(stderr || err.message).split("\n")[0]))
        : resolve(String(stdout || "").trim()));
  });
}

// Move a clone onto the channel branch. This is the only migration path there is:
// everyone installed from `main`, and a designer will never re-run the installer to change
// a branch they don't know exists — so the switch has to ride in on the code they are
// already pulling. It is a no-op on a machine already on its channel, which is every
// machine after the first time.
//
// Declines rather than forces on anything it doesn't expect. A bridge that stayed on the
// wrong branch still builds and gets fixed next release; one that discarded an edit or
// landed on a detached HEAD is somebody's afternoon. Two cases in particular:
//
//   - the channel branch isn't on the remote yet, which is every machine in the window
//     between shipping this code and cutting the first release. Staying on `main` is right.
//   - the working tree is dirty, which on a designer's Mac means the standards were edited
//     by hand and on a developer's means everything.
async function ensureChannel(repo, channel) {
  const current = await gitP(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current === channel) return current;

  await gitP(repo, ["fetch", "--quiet", "origin"]);
  try {
    await gitP(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${channel}`]);
  } catch (e) {
    log(`channel: no origin/${channel} yet — staying on ${current}`);
    return current;
  }

  const dirty = await gitP(repo, ["status", "--porcelain"]);
  if (dirty) {
    log(`channel: ${current} has uncommitted changes — not switching to ${channel}`);
    return current;
  }

  await gitP(repo, ["checkout", "-B", channel, `origin/${channel}`]);
  log(`channel: ${current} → ${channel}`);
  return channel;
}

// Record the sha either side of the pull so we know both whether anything arrived and,
// specifically, whether any of it was code this process is already running. `before` is
// taken ahead of the channel switch so that moving between branches counts as an update
// too — it changes bridge/ like any other, and has to trigger the same restart.
// --ff-only: never rewrite a designer's local edit, just decline to update.
async function doPull(repo) {
  const before = await gitP(repo, ["rev-parse", "HEAD"]);
  await ensureChannel(repo, UPDATE_CHANNEL);
  await gitP(repo, ["pull", "--ff-only", "--quiet"]);
  const after = await gitP(repo, ["rev-parse", "HEAD"]);
  if (!after || before === after) return; // already current

  standardsCache.clear(); // the pull may have changed them; don't serve the old copy
  log(`updated ${before.slice(0, 7)} → ${after.slice(0, 7)}`);

  // standards/ is re-read from disk every send, so those changes are already live.
  // bridge/ is the code running right now, and that only changes on a restart.
  const names = await gitP(repo, ["diff", "--name-only", before, after]);
  const codeChanged = names.split("\n").filter((f) => f.startsWith("bridge/"));
  if (codeChanged.length) {
    if (UNDER_LAUNCHD) {
      restartPending = true;
      log(`  bridge code changed (${codeChanged.join(", ")}) — restarting after this send`);
    } else {
      log(`  bridge code changed (${codeChanged.join(", ")}) — restart it to pick this up`);
    }
  }
}

function refreshFromGit(cb) {
  if (SELF_UPDATE === false) return cb();
  // Await the in-flight pull rather than starting a second one. Both callers used to
  // pass the throttle check (it was stamped before the pull, not after) and could read
  // standards/ off a working tree the other was mid-checkout on.
  if (pullInFlight) return pullInFlight.then(() => cb(), () => cb());
  if (Date.now() - lastPull < STANDARDS_TTL_MS) return cb();
  const repo = path.join(__dirname, "..");
  if (!fs.existsSync(path.join(repo, ".git"))) return cb();

  const run = doPull(repo)
    .catch((e) => log(`standards: git pull skipped (${e.message})`))
    .then(() => { lastPull = Date.now(); pullInFlight = null; });
  pullInFlight = run;
  run.then(() => cb(), () => cb());
}

// Called once the response is out the door: exiting mid-send would drop it. launchd's
// KeepAlive brings us straight back on the new code.
function maybeRestart() {
  if (!restartPending) return;
  restartPending = false;
  setTimeout(() => {
    log("restarting to load the new bridge code (deliberate exit)");
    // Close the listeners first so an in-flight /status poll finishes instead of dying
    // as a bare connection reset. The timeout is the backstop for a hung socket.
    let closed = 0;
    const bye = () => { if (++closed >= 2) process.exit(0); };
    try { v6.close(bye); } catch (e) { bye(); }
    try { server.close(bye); } catch (e) { bye(); }
    setTimeout(() => process.exit(0), 2000).unref();
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
    let fetched = null;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const raw = await res.text();
      // These become standing instructions for an agent working inside the designer's
      // repositories, so an unbounded body is both a memory problem and a sign the
      // endpoint isn't serving what we asked for.
      if (raw.length > MAX_STANDARD_BYTES) throw new Error(`larger than ${MAX_STANDARD_BYTES} bytes`);
      const text = raw.trim();
      if (!looksValid(name, text)) throw new Error(`response doesn't look like ${name}`);
      fetched = text;
    } catch (e) {
      log(`standards: couldn't fetch ${url} (${e.message}) — falling back to cache/bundled`);
    }
    if (fetched !== null) {
      // Cache separately from the fetch. Sharing one try meant an unwritable cache
      // directory threw away a perfectly good standard already in memory and blamed
      // the network for it in the log.
      try {
        fs.mkdirSync(STANDARDS_CACHE, { recursive: true });
        writeFileAtomic(cacheFile, fetched);
      } catch (e) {
        log(`standards: fetched ${name} but couldn't cache it (${e.message}) — using it anyway`);
      }
      return remember(fetched, "org");
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

// All of them or none. A build missing one is worse than no build at all.
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
  // the output rather than silently becoming an empty string. hasOwnProperty rather than
  // `in`, or {{toString}} and {{constructor}} resolve off the prototype and render
  // "function toString() { [native code] }" into the composer.
  return tpl.replace(/\{\{(\w+)\}\}/g, (m, key) =>
    (Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m));
}

// Write via a temp file in the same directory, then rename. A truncate-then-write that is
// interrupted — including by the self-restart below — leaves the designer's project with
// a half-written file and no way to tell.
function writeFileAtomic(target, contents) {
  const tmp = `${target}.f2c-${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, contents);
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) {}
    throw e;
  }
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

  // An opening marker with no closing one is a file an earlier version corrupted.
  // Appending a second block would leave that first BEGIN and the new END as the
  // outermost pair, so the *next* send would slice out everything between them —
  // which is wherever the designer's own text now sits. Refuse instead of guessing
  // which half is theirs.
  if (start !== -1 && (end === -1 || end < start)) {
    throw new BuildError(
      "CLAUDE.md has an unterminated managed block. Delete the stray " +
      "FIGMA-TO-CLAUDE-CODE marker by hand, then send again."
    );
  }

  const next = start !== -1 && end !== -1
    ? existing.slice(0, start) + lawsText + existing.slice(end + LAWS_END.length)
    : existing ? existing.replace(/\s*$/, "") + "\n\n" + lawsText + "\n" : lawsText + "\n";

  // Validate the candidate before it touches disk. Writing first and checking after
  // meant every failed check left a corrupted CLAUDE.md behind.
  if (!next.includes(LAWS_BEGIN) || !next.includes(LAWS_END)) {
    throw new BuildError("refusing to write CLAUDE.md: the laws are missing their managed-block markers");
  }
  if (next !== existing) writeFileAtomic(target, next);
}

// Claude Code asks whether you trust a folder the first time it opens one. For a folder
// this bridge just made, at the designer's request, from their own selection, that prompt
// carries no information they don't already have — but it does stop the build dead until
// someone notices the modal and clicks it.
//
// ~/.claude.json belongs to Claude Code and has no versioned contract, so every branch
// here fails toward leaving the file untouched and letting the prompt appear. A trust
// dialog is a small annoyance; a corrupted config is the designer's entire Claude Code
// history. Re-serialised at two-space indent with no trailing newline, which is byte-for-
// byte how Claude Code writes it, so this adds one key rather than reformatting 56 KB.
const CLAUDE_CONFIG = path.join(HOME, ".claude.json");
const PRETRUST = process.env.PRETRUST !== "0";

function trustProject(dir, configPath) {
  if (!PRETRUST) return false;
  const file = configPath || CLAUDE_CONFIG;

  let config;
  try { config = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return false; }
  if (!config || typeof config !== "object" || Array.isArray(config)) return false;

  const projects = config.projects;
  if (projects !== undefined && (typeof projects !== "object" || projects === null || Array.isArray(projects))) return false;

  const existing = projects && projects[dir];
  if (existing && typeof existing === "object" && existing.hasTrustDialogAccepted === true) return false;
  if (existing !== undefined && (typeof existing !== "object" || existing === null || Array.isArray(existing))) return false;

  config.projects = projects || {};
  config.projects[dir] = Object.assign({}, existing || {}, { hasTrustDialogAccepted: true });

  try {
    writeFileAtomic(file, JSON.stringify(config, null, 2));
    return true;
  } catch (e) {
    log(`couldn't pre-trust ${dir}: ${e.message}`);
    return false;
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

  // Valid JSON that isn't an object still parses. `null` would throw on assignment and
  // fail the whole send; an array or a number would silently accept no properties and
  // then get written back as-is while the log claimed the model was pinned.
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    console.log(`  model: left ${target} alone — it isn't a JSON object`);
    return null;
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
  writeFileAtomic(target, JSON.stringify(settings, null, 2) + "\n");
  return `${settings.model || "(default)"}${settings.effortLevel ? " @ " + settings.effortLevel : ""}`;
}

// Always hand Claude Code a Dev Mode link (m=dev). The plugin already builds one, but
// normalise here too so a pasted design link becomes a dev link as well.
// This value is handed to Claude Code as "the design to read", so it has to be a Figma
// URL and not merely a string the caller supplied. An unchecked url meant any scheme and
// any host could be presented to the agent as the design source.
function isFigmaUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === "https:" && (u.hostname === "figma.com" || u.hostname.endsWith(".figma.com"));
  } catch (e) { return false; }
}

function figmaUrl(info) {
  let url = isFigmaUrl(info.url) ? String(info.url) : null;
  if (!url) {
    if (!info.fileKey) return null;
    // Reconstruct from the parts instead of trusting the supplied link. Also the path
    // taken when a pasted link isn't a Figma URL at all.
    const key = encodeURIComponent(String(info.fileKey).replace(/[^A-Za-z0-9]/g, "").slice(0, 40));
    if (!key) return null;
    const nodeParam = encodeURIComponent(
      String(info.urlNodeId || String(info.nodeId || "").replace(/:/g, "-")).replace(/[^\w-]/g, "").slice(0, 40));
    const slug = encodeURIComponent(
      String(info.file || "").trim().replace(/\s+/g, "-").replace(/[^\w-]/g, "").slice(0, 60)) || "frame";
    url = `https://www.figma.com/design/${key}/${slug}?node-id=${nodeParam}`;
  }
  if (!/[?&]m=dev(&|$)/.test(url)) url += (url.indexOf("?") === -1 ? "?" : "&") + "m=dev";
  return url;
}

// The laws go into the prompt verbatim, minus the managed-block HTML comments that only
// exist so the CLAUDE.md copy can be found and replaced later.
function lawsForPrompt(text) {
  return text.replace(/<!--[\s\S]*?-->/g, "").trim();
}

// Everything here lands in the Claude Code composer as instructions, so cap the length
// and drop control characters. Capping rather than rejecting: an unusual frame name is
// legitimate and should still build.
function clean(value, fallback, max) {
  const text = String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return text ? text.slice(0, max) : fallback;
}

// A plugin published to the org is frozen at publish time while this bridge self-updates
// over git, so a designer can be sending last month's single-frame payload to today's
// bridge. Both shapes normalise to a list here, and the rest of the build only knows lists.
function screensOf(data) {
  const list = Array.isArray(data.screens) && data.screens.length ? data.screens : [data];
  return list.map((s) => ({
    name: clean(s.name, "(unnamed)", 200),
    type: clean(s.type, "frame", 40).toLowerCase(),
    size: Number.isFinite(Number(s.width)) && Number.isFinite(Number(s.height)) && s.width && s.height
      ? `${Math.round(Number(s.width))}x${Math.round(Number(s.height))}`
      : "size unknown",
    nodeId: clean(s.nodeId, "(unknown)", 60),
    url: figmaUrl(s),
  }));
}

function templateVars(info, standards) {
  const screens = screensOf(info);

  return {
    screenCount: String(screens.length),
    file: clean(info.file, "(unknown)", 200),
    page: clean(info.page, "(unknown)", 200),
    laws: lawsForPrompt(standards.files["figma-laws.md"].text),
  };
}

// Per-screen values. Kept separate from templateVars because these are the only ones that
// vary between repetitions of the screen block.
function screenVars(screen) {
  return {
    name: screen.name,
    type: screen.type,
    size: screen.size,
    nodeId: screen.nodeId,
    devLink: screen.url || "(none available)",
    designSource: screen.url
      ? `Dev Mode link: ${screen.url}`
      : `Figma node id: ${screen.nodeId} — no link available, so read it from the current selection via the local Dev Mode MCP, and STOP and ask rather than guessing at any value.`,
  };
}

// The prompt has to stand on its own: a designer reading the composer should see which
// frame is about to be built and where the design is read from. Wording lives in
// standards/prompt.md, not here, so it can be edited without shipping code.
// The envelope is rendered around the screen list rather than over it. Splicing first and
// rendering the result put frame names through a second substitution pass, so a frame
// called "{{laws}}" — a legal Figma layer name — emptied the whole ruleset into its own
// heading. Each piece is rendered exactly once, and render() replaces via a callback, so
// a value that looks like a placeholder is never rescanned.
function buildPrompt(vars, standards, screens) {
  const tpl = standards.files["prompt.md"].text;
  const begin = tpl.indexOf(SCREEN_BEGIN);
  const end = tpl.indexOf(SCREEN_END);
  const body = tpl.slice(tpl.indexOf("\n", begin) + 1, end).trim();
  const list = screens.map((s) => render(dropComments(body), screenVars(s))).join("\n\n");
  return (
    render(dropComments(tpl.slice(0, begin)), vars) +
    list +
    render(dropComments(tpl.slice(end + SCREEN_END.length)), vars)
  ).trim();
}

// Notes to whoever edits prompt.md, which is a different audience from the designer
// approving the send — they were reaching the composer verbatim. Stripped per piece and
// before rendering, never from the finished prompt: a frame called "<!--" and another
// called "-->" are both legal Figma layer names, and a pass over the assembled text would
// let that pair delete everything the prompt said in between.
function dropComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, "");
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

// Slack ids are opaque and go straight into a URL, so anything that isn't one is dropped
// rather than assembled into a deeplink that opens who-knows-what.
function slackId(value) {
  return /^[A-Z0-9]{6,20}$/.test(String(value || "")) ? String(value) : "";
}

// Where the support link goes. The panel can only ask *that* support be opened, never
// where — `figma.openExternal` refuses any scheme but http(s), so opening the Slack app at
// all has to happen here, and a bridge that opened a URL named by the caller would be a
// way for any page that got past the origin checks to launch arbitrary schemes on this Mac.
const SUPPORT_SLACK_ID = slackId(process.env.SUPPORT_SLACK_ID || "U0A7ZH40VMK");
// An Enterprise Grid org id (E…) rather than a workspace id (T…), because that is what
// `forhims` is. Both shapes are ids to Slack; a different org sets SUPPORT_SLACK_TEAM.
const SUPPORT_SLACK_TEAM = slackId(process.env.SUPPORT_SLACK_TEAM || "E02QZN4PXRT");
const SUPPORT_URL = process.env.SUPPORT_URL ||
  "https://forhims.enterprise.slack.com/team/U0A7ZH40VMK";

// Ordered by how close each one lands to a message box, and every step is a real fallback:
// the deeplink needs a team id that an org may not have configured, `-a Slack` needs the
// app installed, and the browser needs only a browser. execFile with an argument array, so
// none of these ever reaches a shell.
function supportAttempts() {
  const tries = [];
  if (SUPPORT_SLACK_TEAM && SUPPORT_SLACK_ID) {
    tries.push({
      via: "slack-dm",
      args: [`slack://user?team=${SUPPORT_SLACK_TEAM}&id=${SUPPORT_SLACK_ID}`],
    });
  }
  tries.push({ via: "slack-app", args: ["-a", "Slack", SUPPORT_URL] });
  tries.push({ via: "browser", args: [SUPPORT_URL] });
  return tries;
}

function openSupport(cb) {
  const tries = supportAttempts();
  const next = (i) => {
    if (i >= tries.length) return cb(new Error("couldn't open Slack or a browser"));
    execFile("open", tries[i].args, (err) => (err ? next(i + 1) : cb(null, tries[i].via)));
  };
  next(0);
}

// ---- http -------------------------------------------------------------------
// Binding to loopback is not a security boundary on its own: every browser tab on this
// Mac is also on loopback, and this server writes files and launches applications. Two
// header checks close that gap without a shared secret the plugin has no way to carry.
//   Host   — a hostile DNS name pointed at 127.0.0.1 arrives with its own Host header.
//            That is how DNS rebinding gets past an origin check.
//   Origin — an ordinary web page always sends one. The Figma plugin sandbox sends no
//            Origin, or one of the figma.com origins below.
const ALLOWED_ORIGINS = new Set(["null", "https://www.figma.com", "https://figma.com"]);

function originAllowed(req) {
  const origin = req.headers.origin;
  return origin === undefined || ALLOWED_ORIGINS.has(origin);
}

function hostAllowed(req) {
  const name = String(req.headers.host || "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return name === "localhost" || name === "127.0.0.1" || name === "::1";
}

function send(res, code, body, json) {
  if (json) res.setHeader("Content-Type", "application/json");
  res.writeHead(code);
  res.end(json ? JSON.stringify(body) : body);
}

// 64 KB is ~200x the largest real payload; anything above it is not a frame.
const MAX_BODY_BYTES = 64 * 1024;

function readBody(req, cb) {
  const chunks = [];
  let size = 0;
  let done = false;
  const finish = (err, value) => { if (!done) { done = true; cb(err, value); } };

  const type = String(req.headers["content-type"] || "").split(";")[0].trim();
  if (type && type !== "application/json") return finish(new Error("expected application/json"));

  req.setTimeout(15000, () => { req.destroy(); finish(new Error("request timed out")); });
  req.on("error", (e) => finish(e));
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_BODY_BYTES) {
      // Stop reading, but leave the socket alive long enough for the caller's error
      // response to arrive. Destroying here gave the client a bare connection reset,
      // which tells whoever is debugging nothing at all.
      req.pause();
      return finish(new Error("body too large"));
    }
    chunks.push(c);
  });
  // Concat then decode once. Coercing each chunk to a string independently turns any
  // multi-byte character straddling a chunk boundary into replacement characters, and
  // frame names routinely carry accents, arrows and emoji.
  req.on("end", () => {
    try { finish(null, JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
    catch (e) { finish(e); }
  });
}

// Opens the macOS folder picker and reports back what was chosen.
//
// This is the one place a directory enters the bridge from outside, and it still isn't the
// caller who supplies it: the request only asks for the dialog to open, and the path comes
// from a designer clicking a folder on their own Mac. /build continues to refuse a path in
// a request body, which is what stops a page that gets past the origin checks from naming
// a directory to write into.
// `prompt` is the line across the top of the dialog. It is a parameter because the same
// dialog serves two questions — where future builds should land, and which folder this one
// goes in — and asking the second while titled as the first is how you get a designer
// setting their whole destination to a folder they meant to build in once.
function chooseFolderNatively(prompt, cb) {
  // Run inside System Events so the dialog comes to the front. A launchd agent has no
  // window of its own, and without this the picker opens behind Figma, which reads as the
  // button having done nothing at all.
  // Opens on the current destination so "somewhere near where these already live" is one
  // click, rather than starting at whatever folder the picker last remembered.
  const start = fs.existsSync(prototypesDir()) ? prototypesDir() : HOME;
  const script =
    'tell application "System Events"\n' +
    '  activate\n' +
    '  set chosen to choose folder with prompt ' + JSON.stringify(String(prompt)) + ' ' +
    'default location POSIX file ' + JSON.stringify(start) + '\n' +
    'end tell\n' +
    'POSIX path of chosen';

  execFile("osascript", ["-e", script], { timeout: 180000 }, (err, stdout, stderr) => {
    if (err) {
      // -128 is "user cancelled", which is a normal outcome and not a failure to report.
      if (/User canceled|-128/.test(String(stderr) + String(err.message))) return cb(null, null);
      return cb(new Error(String(stderr).trim() || err.message));
    }
    cb(null, String(stdout).trim().replace(/\/+$/, "") || null);
  });
}

// Everything a chosen directory has to satisfy before it becomes the destination. Checked
// here rather than at build time so the designer hears about it while the picker is still
// in mind, instead of on their next send.
function adoptPrototypesDir(dir) {
  let real;
  try { real = fs.realpathSync(dir); } catch (e) {
    return { ok: false, message: "That folder couldn't be opened. Pick another one." };
  }
  try {
    if (!fs.statSync(real).isDirectory()) return { ok: false, message: "That isn't a folder." };
  } catch (e) {
    return { ok: false, message: "That folder couldn't be read. Pick another one." };
  }
  try { fs.accessSync(real, fs.constants.W_OK); } catch (e) {
    return { ok: false, message: "That folder is read-only. Pick one you can write to." };
  }

  prefs.prototypesDir = real;
  const saved = savePrefs();
  publishProjects();
  return {
    ok: true,
    prototypesDir: displayPath(real),
    // Worth saying out loud: the build will still work, it just won't be remembered, and a
    // silent revert on the next restart is the confusing version of this.
    message: saved ? null : "Using it for now, but it couldn't be saved for next time."
  };
}

// The folder is named after whatever the designer picked first, so a send lands somewhere
// they can recognise in Finder without being asked to name it every time.
function firstScreenName(data) {
  if (Array.isArray(data.screens) && data.screens.length) return data.screens[0].name;
  return data.name;
}

// Resolve where this build should land. What the folder already contains is deliberately not
// established here: the laws tell the agent to look when it opens the folder, which is later
// and therefore true. A verdict taken at this point is a snapshot, and between here and the
// deeplink opening there is time for the designer to empty the folder in Finder or for an
// earlier session to leave half a build in it.
function resolveTarget(data) {
  const target = data.target || {};
  if (target.mode === "existing") {
    const id = String(target.id || "");
    // Rebuild the index on a miss: the bridge may have restarted since the plugin
    // fetched the list, which would otherwise turn a valid pick into a hard failure.
    if (!projectIndex.has(id)) publishProjects();
    const dir = projectIndex.get(id);
    if (!dir) throw new BuildError("that project isn't available any more — reopen the plugin and pick it again");
    let real;
    try { real = fs.realpathSync(dir); } catch (e) {
      throw new BuildError("that project folder is no longer readable — reopen the plugin and pick it again");
    }
    if (!fs.statSync(real).isDirectory()) throw new BuildError("that project target isn't a directory");
    return { dir: real, created: false, mode: "existing" };
  }
  // "New prototype": one folder named after the selection, REUSED on later sends. A fresh
  // random folder each time meant Claude Code asked to trust a new directory on every send,
  // and re-sending a frame couldn't iterate on what it built last time.
  //
  // slugify, not the raw name: this is the one place a Figma layer name — which can hold
  // slashes, dots and leading spaces — becomes a path segment. `data.projectName` is typed
  // by the designer and gets exactly the same treatment for exactly the same reason.
  const chosen = clean(target.projectName, "", 200) || firstScreenName(data);
  const slug = slugify(chosen);
  if (!slug) throw new BuildError("that name has no characters that can be used in a folder name");
  const dir = path.join(prototypesDir(), slug);
  const created = !fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, created, mode: "new" };
}

async function buildFromRequest(data, done) {
  // A build without the standards is worse than no build: it silently guesses
  // values. So this is a hard stop, never a warning.
  await new Promise(refreshFromGit);
  const std = await loadStandards();
  if (!std.ok) {
    console.error(`  error: standard "${std.missing}" not available (tried ${STANDARDS_URL || STANDARDS_DIR})`);
    return done(500,
      `Stopped: "${std.missing}" couldn't be loaded, so nothing was sent. ` +
      "Re-run the install command, or ask whoever set this up.");
  }

  let target, prompt, pinned, trusted, screens;
  try {
    target = resolveTarget(data);
    writeLaws(target.dir, std.files["figma-laws.md"].text);
    pinned = pinModel(target.dir);
    // Trust the prototypes root as well as the folder itself. Claude Code walks up from
    // the directory it is opening, so a trusted root covers every future build in one
    // entry — which matters because a Claude Code session running right now can rewrite
    // ~/.claude.json from memory and drop the per-folder key we just added.
    trusted = trustProject(target.dir);
    if (target.mode === "new") trusted = trustProject(prototypesDir()) || trusted;
    screens = screensOf(data);
    if (screens.length > MAX_SCREENS) {
      throw new BuildError(`that's ${screens.length} screens in one send — ${MAX_SCREENS} is the most one build can take on. Send them in smaller batches.`);
    }
    prompt = buildPrompt(templateVars(data, std), std, screens);
  } catch (e) {
    console.error("  error:", e.message);
    return done(500, e instanceof BuildError
      ? "Couldn't prepare the project: " + e.message
      : "Couldn't prepare the project. Check the bridge log for details.");
  }

  const { dir, created } = target;
  log(`build ${created ? "new" : "existing"} → ${dir}`);
  for (const s of screens) console.log(`  screen: "${s.name}"  ${s.url || "(no link)"}`);
  console.log(`  standards: ${std.version} (${std.source}) → prompt + CLAUDE.md`);
  if (pinned) console.log(`  model: ${pinned}`);
  if (trusted) console.log("  trust: pre-accepted, so Claude Code opens straight into the build");
  console.log(`  prompt: ${prompt.length} chars`);

  // Make sure the MCP is wired before we launch (idempotent, cached).
  await new Promise((resolve) => ensureFigmaMcp(() => resolve()));
  await new Promise((resolve) => {
    launchDesktop(dir, prompt, (e, message) => {
      if (e) {
        console.error("  error:", e.message);
        done(500, "Couldn't open Claude Code — check that it's installed. See the bridge log.");
      } else {
        console.log("  " + message);
        rememberRecent(dir);
        done(200, `${created ? "Created" : "Reusing"} ${path.basename(dir)}. ` + message);
      }
      resolve();
    });
  });
}

function handleRequest(req, res) {
  const origin = req.headers.origin;
  if (origin !== undefined && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (!hostAllowed(req)) return send(res, 403, "Bad Host");
  if (!originAllowed(req)) return send(res, 403, "Origin not allowed");

  if (req.method === "OPTIONS") return send(res, 204, "");

  // Readiness for the plugin's status dots.
  if (req.method === "GET" && req.url === "/status") {
    loadStandards().then((std) => {
      const base = {
        bridge: true,
        laws: std.ok
          ? { ok: true, version: std.version, source: std.source }
          : { ok: false, missing: std.missing },
        // Reported rather than hardcoded in the panel: BUILD_MODEL and BUILD_EFFORT are
        // configurable, and the panel used to state the opposite of what gets written.
        pinned: {
          model: BUILD_MODEL || null,
          effort: PERSISTABLE_EFFORT.includes(BUILD_EFFORT) ? BUILD_EFFORT : null,
        },
        version: BRIDGE_VERSION,
        node: process.version,
        // So a bug report from a machine running ahead of the org identifies itself. The
        // panel shows it only when it isn't the channel everyone else is on.
        channel: SELF_UPDATE ? UPDATE_CHANNEL : "pinned",
      };
      base.claudeApp = hasClaudeApp();
      hasClaude((cli) => {
        base.claudeCli = cli;
        // Both halves matter: the CLI wires up the MCP, the desktop app receives the
        // deeplink. Having one without the other fails at a different step each time.
        base.claude = cli && base.claudeApp;
        if (!cli) return send(res, 200, Object.assign(base, { figmaMcp: false, figmaMcpState: "missing" }), true);
        // Deliberately not short-circuiting on the `figmaReady` flag: that only records
        // that `mcp add` ran, which is true long before anyone authorizes it.
        figmaMcpState((state) => send(res, 200,
          Object.assign(base, { figmaMcp: state === "connected", figmaMcpState: state }), true));
      });
    }).catch((e) => {
      // Without this the poll gets no response at all and the panel hangs on "Checking
      // this Mac…", while the unhandled rejection takes the process down with it.
      console.error("  error: /status failed:", e.stack || e.message);
      send(res, 500, { bridge: true, error: "status check failed" }, true);
    });
    return;
  }

  // Populates the plugin's project dropdown.
  if (req.method === "GET" && req.url === "/projects") {
    send(res, 200, {
      prototypesDir: displayPath(prototypesDir()),
      projects: publishProjects(),
    }, true);
    return;
  }

  // "Change" next to the destination hint. Opens a native picker on this Mac.
  if (req.method === "POST" && req.url === "/choose-folder") {
    chooseFolderNatively("Where should new folders be created?", (err, dir) => {
      if (err) {
        log(`folder picker failed: ${err.message}`);
        return send(res, 500, { ok: false, message: "The folder picker didn't open." }, true);
      }
      if (!dir) return send(res, 200, { ok: false, cancelled: true }, true);
      const result = adoptPrototypesDir(dir);
      if (result.ok) log(`new prototypes now land in: ${result.prototypesDir}`);
      send(res, result.ok ? 200 : 400, result, true);
    });
    return;
  }

  // "New folder…" in the destination dropdown. The same native dialog as /choose-folder,
  // but the answer becomes this build's target rather than the directory builds land in —
  // and macOS already gives that dialog a New Folder button and inline renaming, which is
  // why there is no folder-naming UI in the panel.
  //
  // Takes no parameters on purpose — see openSupport(). The panel asks for support to be
  // opened; this decides what that means.
  if (req.method === "POST" && req.url === "/open-support") {
    return openSupport((err, via) => {
      if (err) {
        log(`support link failed: ${err.message}`);
        return send(res, 500, { ok: false, url: SUPPORT_URL }, true);
      }
      log(`support: opened via ${via}`);
      send(res, 200, { ok: true, via }, true);
    });
  }

  // Still no path from the request body: the caller asks for a dialog, and the path comes
  // back from the person clicking their own Mac. It is registered in the project index so
  // the plugin only ever holds the opaque id, exactly like a folder from the scan.
  if (req.method === "POST" && req.url === "/choose-target") {
    chooseFolderNatively("Choose a folder to build in, or New Folder to make one:", (err, dir) => {
      if (err) {
        log(`folder picker failed: ${err.message}`);
        return send(res, 500, { ok: false, message: "The folder picker didn't open." }, true);
      }
      if (!dir) return send(res, 200, { ok: false, cancelled: true }, true);
      let real;
      try { real = fs.realpathSync(dir); } catch (e) {
        return send(res, 400, { ok: false, message: "That folder couldn't be opened." }, true);
      }
      try {
        if (!fs.statSync(real).isDirectory()) throw new Error("not a directory");
        fs.accessSync(real, fs.constants.R_OK | fs.constants.W_OK);
      } catch (e) {
        return send(res, 400, { ok: false, message: "That folder can't be written to." }, true);
      }
      const id = projectId(real);
      chosenTargets.set(id, real);
      projectIndex.set(id, real);
      log(`build target chosen: ${displayPath(real)}`);
      send(res, 200, { ok: true, id, name: path.basename(real), path: displayPath(real) }, true);
    });
    return;
  }

  // The "Connect Figma" button on the plugin's blocked screen.
  if (req.method === "POST" && req.url === "/setup") {
    ensureFigmaMcp((err, ok, note) => {
      // ensureFigmaMcp clears the figmaMcpState cache itself, so the next poll sees the
      // change rather than a 20-second-old answer that reads as "the button did nothing".
      if (err) return send(res, 200, { ok: false, message: err.message }, true);
      send(res, 200, { ok: true, message: "Figma MCP " + note }, true);
    });
    return;
  }

  if (req.method === "POST" && req.url === "/build") {
    // Every exit from here runs maybeRestart(): a pending restart that only fires on the
    // success path stays pending for the 5-minute pull window while the log has already
    // announced it, and the process keeps serving code it says it replaced.
    const done = (code, body) => {
      // A body we refused to finish reading leaves the client still sending. Close the
      // socket once the response is out, not before, or the response gets truncated.
      if (!req.readableEnded) res.on("finish", () => req.destroy());
      send(res, code, body);
      maybeRestart();
    };

    readBody(req, (err, data) => {
      if (err) {
        log(`build refused: ${err.message}`);
        return done(400, "Couldn't read that request.");
      }
      // The whole handler is wrapped: without it a rejection sends no response at all,
      // the plugin's fetch hangs, and Node exits the process on the unhandled rejection.
      buildFromRequest(data, done).catch((e) => {
        console.error("  error:", e.stack || e.message);
        done(500, "Something went wrong preparing the build. Check the bridge log.");
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
const server = http.createServer(handleRequest);

// Both binds are fatal on EADDRINUSE. Letting the [::1] bind fail quietly meant any
// unprivileged local process could take that address and silently become the bridge for
// the plugin — which asks for "localhost", and macOS resolves that to ::1 first — while
// this process kept logging that it was healthy.
function bindFatally(srv, address, label) {
  srv.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${PORT} on ${label} is already in use — the bridge is probably already running.`);
    } else {
      console.error(`Server error on ${label}:`, err.message);
    }
    // Exit 0, not 1: the plist sets KeepAlive, which restarts on any exit. A failing
    // exit code here produced a respawn loop against a port that was never going to
    // free up, roughly every ten seconds, forever.
    process.exit(0);
  });
  srv.listen(PORT, address);
}

function start() {
  bindFatally(v6, "::1", "[::1]");
  bindFatally(server, "127.0.0.1", "127.0.0.1");

  server.on("listening", () => {
    log(`figma → claude bridge listening on http://127.0.0.1:${PORT} (node ${process.versions.node})`);
    console.log(`new prototypes land in: ${prototypesDir()}`);
    console.log(`destination for new prototypes: ${displayPath(prototypesDir())}`);
    console.log(`standards from: ${STANDARDS_URL || STANDARDS_DIR}`);
    loadStandards().then((std) => {
      if (!std.ok) return log(`standards: "${std.missing}" NOT AVAILABLE — sends will be refused until this is fixed.`);
      console.log(`standards: ${std.version}`);
      for (const name of STANDARDS) console.log(`  ${name}  ${std.files[name].version} (${std.files[name].source})`);
    }).catch((e) => log(`standards: couldn't load (${e.message}) — sends will be refused until this is fixed.`));
    if (process.env.SKIP_AUTOSETUP) return;
    ensureFigmaMcp((err, ok, note) => {
      if (err) log(`figma MCP: not registered yet — ${err.message}. Retries on first send, or click Connect in the plugin.`);
      // "registered" is not "authorized" — figmaMcpState is the one that knows the
      // difference, and /status reports that rather than this note.
      else log(`figma MCP: ${note}`);
    });
  });
}

// A last-resort net so an unexpected rejection is diagnosable instead of a silent exit
// followed by a KeepAlive restart that looks like a fresh boot.
process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection:", (reason && reason.stack) || reason);
});
process.on("uncaughtException", (err) => {
  console.error("uncaught exception:", err.stack || err.message);
  process.exit(1);
});

// Only bind ports and touch the MCP when run as a program. Without this, requiring the
// module from a test takes the port and shells out to `claude`, which is why none of
// the functions above had tests.
if (require.main === module) start();

module.exports = {
  slugify, render, looksValid, writeLaws, writeFileAtomic, pinModel,
  figmaUrl, isFigmaUrl, lawsForPrompt, templateVars, clean,
  listProjects, publishProjects, projectId, resolveTarget, usableRecents, nextRecents,
  ensureChannel,
  originAllowed, hostAllowed, readBody, versionOf,
  displayPath, adoptPrototypesDir, prototypesDir, trustProject,
  screensOf, screenVars, buildPrompt, firstScreenName,
  LAWS_BEGIN, LAWS_END, SCREEN_BEGIN, SCREEN_END, MAX_SCREENS, BuildError,
};
