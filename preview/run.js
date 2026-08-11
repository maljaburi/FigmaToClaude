#!/usr/bin/env node
// Renders every screen the plugin can show, without opening Figma.
//
//   node preview/run.js
//
// The panel decides for itself which of five views to show and how tall to be, from a
// status the bridge returns. That makes "it looks right on my Mac" worth very little:
// this Mac only ever produces one of those statuses. So this feeds the real plugin every
// status it can receive, over the same postMessage channel Figma uses, and checks what
// came out — one view visible at a time, each panel sized to its content, the buttons
// wired to something. Writes preview/screens.png and exits non-zero if a check fails.
//
// No dependencies. Needs Chrome, which it drives headlessly.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const REPO = path.join(__dirname, "..");
const UI = path.join(REPO, "plugin", "ui.html");
const PAGE = path.join(__dirname, "screens.html");
const SHOT = path.join(__dirname, "screens.png");

const BROWSERS = [
  process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
].filter(Boolean);

// --headless=new landed in Chrome 112 and --dump-dom's behaviour with it settled shortly
// after. An older build fails in a way that looks like a plugin bug rather than a tooling
// one, so name the real problem.
const MIN_CHROME_MAJOR = 112;

function findBrowser() {
  const found = BROWSERS.find((p) => fs.existsSync(p));
  if (!found) {
    console.error("Couldn't find Chrome. Install it, or set CHROME=/path/to/binary.");
    process.exit(1);
  }
  return found;
}

function checkBrowserVersion(browser, cb) {
  execFile(browser, ["--version"], { encoding: "utf8", timeout: 15000 }, (err, stdout) => {
    const version = String(stdout || "").trim();
    const major = Number((version.match(/(\d+)\.\d+\.\d+/) || [])[1]);
    if (Number.isFinite(major) && major < MIN_CHROME_MAJOR) {
      console.error(`${version} is too old — this harness needs Chrome ${MIN_CHROME_MAJOR}+ for --headless=new.`);
      process.exit(1);
    }
    cb(version || "unknown version");
  });
}

// The plugin can only reach hosts listed in the manifest, and the port lives in two files
// that nothing forces to agree. Getting this wrong presents as "bridge not installed" on
// a machine where the bridge is running perfectly.
// Compares the whole origin, not just the port. An earlier version matched only the port
// number, so changing the host to 127.0.0.1 while the manifest still allowlisted localhost
// passed this check and silently blocked every request the plugin made.
function checkOriginAgreement() {
  const code = fs.readFileSync(path.join(REPO, "plugin", "code.js"), "utf8");
  const manifest = fs.readFileSync(path.join(REPO, "plugin", "manifest.json"), "utf8");
  const port = (code.match(/BRIDGE_PORT\s*=\s*(\d+)/) || [])[1];
  const originExpr = (code.match(/BRIDGE_ORIGIN\s*=\s*"([^"]+)"\s*\+\s*BRIDGE_PORT/) || [])[1];
  const origin = originExpr && port ? originExpr + port : null;
  const allowed = JSON.parse(manifest).networkAccess.allowedDomains;
  const same = !!origin && allowed.indexOf(origin) !== -1;
  console.log("BRIDGE ORIGIN");
  console.log("  plugin/code.js       : " + (origin || "(not found)"));
  console.log("  plugin/manifest.json : " + allowed.join(", "));
  console.log("  allowlisted          : " + (same ? "yes" : "NO"));
  console.log("");
  return same;
}

// Served rather than opened from file://, so the page can read into the plugin's iframe
// to measure it. Read per request, so editing ui.html and re-running is enough.
function serve(cb) {
  const server = http.createServer((req, res) => {
    const file = req.url.startsWith("/ui.html") ? UI : PAGE;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(fs.readFileSync(file));
  });
  server.listen(0, "127.0.0.1", () => cb(server, server.address().port));
}

// Async, not spawnSync: the page being rendered is served by this same process, and a
// synchronous spawn blocks the event loop that would have answered Chrome's request.
//
// Deliberately no --user-data-dir. Isolating the profile is the tidier instinct, but
// paired with --screenshot it stops Chrome from ever exiting, turning a 3-second run into
// however long you're willing to wait. Headless runs fine alongside an open Chrome
// without it. --virtual-time-budget fast-forwards the page's timers so this stays quick.
function render(browser, port, cb) {
  execFile(browser, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--virtual-time-budget=8000",
    // Tall enough for every state in STATES to be in the image. screens.html fails a check
    // when the page outgrows this, because the render silently lost its last row twice.
    "--window-size=1500,3800",
    `--screenshot=${SHOT}`,
    "--dump-dom",
    `http://127.0.0.1:${port}/screens.html`,
  ], { encoding: "utf8", timeout: 60000, maxBuffer: 64 * 1024 * 1024 },
    (err, stdout) => cb(err, stdout || ""));
}

function reportFrom(dom) {
  const match = dom.match(/<pre id="report">([\s\S]*?)<\/pre>/);
  if (!match) return null;
  const json = match[1]
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  return JSON.parse(json);
}

function print(report) {
  console.log("INSTALL COMMAND, as the setup screen wraps it");
  report.install_cmd_lines.forEach((line) => console.log("   |" + line + "|"));

  // The Copy button hands over #install-cmd's textContent, and that element carries
  // markup now to stop the paths breaking mid-word. If that markup ever swallows or adds
  // a character, the command a designer pastes stops being the one we document.
  const readme = fs.readFileSync(path.join(REPO, "README.md"), "utf8");
  const documented = (readme.match(/\[ -d \S+ \] \|\| git clone \S+ \S+ && \S+install\.command/) || [])[0];
  const same = documented === report.install_cmd_copied;
  console.log("");
  console.log("  copied by the plugin : " + report.install_cmd_copied);
  console.log("  documented in README : " + (documented || "(not found)"));
  console.log("  identical            : " + (same ? "yes" : "NO"));

  console.log("");
  console.log("PANELS");
  for (const g of report.geometry) {
    console.log("  " + g.screen.padEnd(20) + g.view.padEnd(11) +
      "panel " + g.panel.padEnd(10) +
      "content " + String(g.content_h).padEnd(6) +
      "slack " + String(g.slack).padEnd(5) + (g.overflows ? "OVERFLOW" : ""));
  }

  const failed = report.checks.filter((c) => !c.pass);
  console.log("");
  console.log("CHECKS: " + report.checks.length + " run, " + failed.length + " failed");
  // A passing check with a nonsense measurement behind it is how a probe ends up asserting
  // nothing at all. VERBOSE=1 shows what each one actually saw.
  if (process.env.VERBOSE) {
    for (const c of report.checks) {
      console.log("  " + (c.pass ? "ok  " : "FAIL") + "  " + c.name + (c.detail ? "  — " + c.detail : ""));
    }
  } else {
    for (const c of failed) console.log("  FAIL  " + c.name + (c.detail ? "  — " + c.detail : ""));
  }
  console.log("");
  console.log("screenshot: " + SHOT);
  return failed.length === 0 && same;
}

const browser = findBrowser();
checkBrowserVersion(browser, (version) => {
  console.log("driving " + version);
  console.log("");
  const originsAgree = checkOriginAgreement();
  serve((server, port) => {
    render(browser, port, (err, dom) => {
      server.close();
      if (err && !dom) {
        console.error("Chrome failed: " + err.message);
        process.exit(1);
      }

      const report = reportFrom(dom);
      if (!report) {
        console.error("The page didn't finish — no report in the DOM. Chrome returned:\n");
        console.error(dom.slice(0, 1500));
        process.exit(1);
      }
      process.exit(print(report) && originsAgree ? 0 : 1);
    });
  });
});
