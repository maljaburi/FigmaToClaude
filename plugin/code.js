// Runs in the Figma plugin sandbox. Reads the selected frame and hands it to the
// local bridge, which opens Claude Code desktop on the target project.
//
// Figma plugins can only reach http/https/ws/wss, which is why the bridge exists.

// Keep the bridge origin in one place. Figma matches `allowedDomains` in manifest.json
// literally: 127.0.0.1 and localhost are different entries to it, and a request to an
// unlisted origin is blocked with no error the panel can distinguish from a bridge that
// isn't running — so the panel sat on "Waiting for the helper" with a healthy bridge.
// preview/run.js asserts these two strings are identical, not merely that ports match.
const BRIDGE_PORT = 7331;
const BRIDGE_ORIGIN = "http://localhost:" + BRIDGE_PORT;
const BRIDGE = BRIDGE_ORIGIN;
const BRIDGE_LABEL = "localhost:" + BRIDGE_PORT;

// Shown on the settings screen. Bumped by hand when the plugin is republished, because a
// published plugin is frozen at its publish version and this is the only way for a designer
// to tell support which one they are running.
const PLUGIN_VERSION = "1.1.0";

// Who to ask when it goes wrong. Kept here rather than in the panel's markup so it is one
// line to change, and read by the panel rather than duplicated there. This copy is only
// the fallback the browser gets — the bridge holds the Slack deeplink, because it is the
// only side of this that can open an app rather than a web page.
const SUPPORT = {
  name: "@Mustafa",
  url: "https://forhims.enterprise.slack.com/team/U0A7ZH40VMK",
};

figma.showUI(__html__, { width: 380, height: 140, themeColors: true });

// Every bridge call needs a deadline. A bridge that accepts the connection and then
// never answers used to leave the panel on "Checking this Mac…" indefinitely while the
// 2s poller stacked up requests that could never settle.
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + " timed out")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

function bridgeFetch(pathname, opts, ms) {
  const options = Object.assign({}, opts || {});
  let controller = null;
  // AbortController isn't guaranteed in every Figma sandbox version, so the timeout
  // stands on its own and aborting is a bonus when it's available.
  try { controller = new AbortController(); options.signal = controller.signal; } catch (e) {}
  return withTimeout(fetch(BRIDGE + pathname, options), ms || 8000, pathname)
    .catch((err) => {
      if (controller) { try { controller.abort(); } catch (e) {} }
      throw err;
    });
}

// In Figma Design the selection lives in PageNode.selection. In Dev Mode the
// highlighted node can be PageNode.focusedNode instead.
function findSelectedNodes() {
  try {
    if (figma.currentPage.selection.length > 0) return figma.currentPage.selection.slice();
  } catch (e) {}
  try {
    if (figma.currentPage.focusedNode) return [figma.currentPage.focusedNode];
  } catch (e) {}
  return [];
}

function findSelectedNode() {
  var nodes = findSelectedNodes();
  return nodes.length ? nodes[0] : null;
}

// Types that are worth building on their own. A section is a container, so it contributes
// its frames rather than itself; a group or a vector inside a frame is part of a screen,
// not a screen.
var BUILDABLE = { FRAME: 1, COMPONENT: 1, COMPONENT_SET: 1, INSTANCE: 1 };

function isSection(node) {
  return node && node.type === "SECTION";
}

// Sections read left-to-right, top-to-bottom on the canvas, which is the order a designer
// describes the flow in. Selection order is click order, and clicking the last screen first
// would otherwise hand the agent the flow backwards. Banded by row so screens laid out in a
// grid don't interleave: a 40px drift in y is the same row, not a new one.
function readingOrder(a, b) {
  var ay = Number(a.y) || 0, by = Number(b.y) || 0;
  if (Math.abs(ay - by) > 40) return ay - by;
  return (Number(a.x) || 0) - (Number(b.x) || 0);
}

// Walks a section for the frames inside it, including through nested sections. Only the
// section's own levels are walked — a frame nested inside another frame is part of that
// screen's content, not a screen of its own.
function framesInSection(section, out) {
  var kids;
  try { kids = section.children || []; } catch (e) { return; }
  var direct = [];
  for (var i = 0; i < kids.length; i++) {
    var kid = kids[i];
    if (isSection(kid)) framesInSection(kid, out);
    else if (BUILDABLE[kid.type]) direct.push(kid);
  }
  direct.sort(readingOrder);
  for (var j = 0; j < direct.length; j++) out.push(direct[j]);
}

function isInsideAnyOf(node, ancestors) {
  var cur = node;
  try {
    while (cur && cur.parent) {
      cur = cur.parent;
      if (ancestors[cur.id]) return true;
    }
  } catch (e) {}
  return false;
}

// Turns whatever is selected into the list of screens to build: sections become the frames
// they hold, loose frames stay themselves, and anything already covered by a selected
// section is dropped so shift-clicking a section plus one of its frames doesn't build that
// frame twice.
function expandSelection(nodes) {
  var sectionIds = {};
  var i;
  for (i = 0; i < nodes.length; i++) if (isSection(nodes[i])) sectionIds[nodes[i].id] = true;

  var loose = [];
  var out = [];
  for (i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    if (isSection(node)) continue;
    if (!BUILDABLE[node.type]) continue;
    if (isInsideAnyOf(node, sectionIds)) continue;
    loose.push(node);
  }
  loose.sort(readingOrder);
  for (i = 0; i < loose.length; i++) out.push(loose[i]);

  // Sections after the loose frames, each block internally ordered, so a section's screens
  // stay together in the brief instead of being interleaved by canvas position.
  for (i = 0; i < nodes.length; i++) if (isSection(nodes[i])) framesInSection(nodes[i], out);

  var seen = {};
  var unique = [];
  for (i = 0; i < out.length; i++) {
    if (seen[out[i].id]) continue;
    seen[out[i].id] = true;
    unique.push(out[i]);
  }
  return unique;
}

function fileKey() {
  // Only resolves for plugins published privately to the org, with
  // enablePrivatePluginApi in the manifest. Undefined otherwise.
  try { return figma.fileKey || null; } catch (e) { return null; }
}

function fileName() {
  try { return figma.root.name; } catch (e) { return "?"; }
}

// Figma puts the file name in the URL path with spaces as hyphens. It's cosmetic to
// Figma but makes the link readable in the brief.
function urlSlug(name) {
  const cleaned = String(name || "").trim().replace(/\s+/g, "-").replace(/[^\w-]/g, "");
  return encodeURIComponent(cleaned) || "frame";
}

// A Dev Mode link is the normal design URL plus m=dev, which opens the node straight
// into Dev Mode instead of the design editor.
function devLink(key, urlNodeId) {
  return `https://www.figma.com/design/${key}/${urlSlug(fileName())}?node-id=${urlNodeId}&m=dev`;
}

function screenFrom(node, key) {
  const nodeId = node.id;                       // "12:345"
  const urlNodeId = nodeId.replace(/:/g, "-");  // URLs use a dash: "12-345"
  return {
    name: node.name,
    type: node.type,
    nodeId: nodeId,
    urlNodeId: urlNodeId,
    fileKey: key,
    url: key ? devLink(key, urlNodeId) : null,
    width: Math.round(node.width || 0),
    height: Math.round(node.height || 0),
  };
}

// Past this many screens the panel stops rather than warns. The bridge enforces its own
// limit too: this plugin is published to the org and frozen at its publish version, so
// this number can't be changed for anyone who hasn't reinstalled.
const MAX_SCREENS = 30;
const WARN_SCREENS = 12;

function selectionInfo() {
  const selected = findSelectedNodes();
  if (!selected.length) {
    return { error: "Nothing selected. Click a frame or a section on the canvas." };
  }

  const nodes = expandSelection(selected);
  if (!nodes.length) {
    // Reached by selecting a section with no frames in it, or by selecting a group or a
    // shape. Naming what is missing beats "nothing selected" when something clearly is.
    return { error: "Nothing here to build. Select a frame, or a section with frames in it." };
  }

  const key = fileKey();
  const screens = nodes.map((node) => screenFrom(node, key));
  const first = screens[0];

  // The first screen's fields stay on the envelope so a bridge older than this plugin —
  // one that reads a single frame and knows nothing about `screens` — still builds
  // something correct rather than failing on a payload it can't parse.
  return Object.assign({}, first, {
    screens: screens,
    page: figma.currentPage.name,
    file: fileName(),
    tooMany: screens.length > MAX_SCREENS ? MAX_SCREENS : 0,
    warn: screens.length > WARN_SCREENS,
  });
}

// Fallback for before the plugin is published privately: fileKey is undefined, so
// the designer pastes the frame link once and we parse it.
// Parsed with regexes rather than `new URL`, because the plugin sandbox's globals are
// limited and a missing URL constructor would reject every valid link.
function infoFromUrl(text) {
  const raw = String(text || "").trim();

  const keyMatch = raw.match(/figma\.com\/(?:design|file|board)\/([A-Za-z0-9]+)/);
  if (!keyMatch) return { error: "Use a Figma design link, e.g. figma.com/design/…?node-id=12-345" };

  const nodeMatch = raw.match(/[?&]node-id=([^&#\s]+)/);
  if (!nodeMatch) return { error: "That link has no node-id. Right-click the frame and Copy link to selection." };

  let nodeParam = nodeMatch[1];
  try { nodeParam = decodeURIComponent(nodeParam); } catch (e) {}
  // Links use "12-345"; the API wants "12:345".
  const nodeId = nodeParam.indexOf(":") === -1 ? nodeParam.replace(/-/g, ":") : nodeParam;
  nodeParam = nodeId.replace(/:/g, "-");

  // Prefer the live selection's name when it matches what was pasted.
  const node = findSelectedNode();
  const sameNode = node && node.id.replace(/:/g, "-") === nodeParam;

  const one = {
    name: sameNode ? node.name : "Linked Figma frame",
    type: sameNode ? node.type : "FRAME",
    nodeId: nodeId,
    urlNodeId: nodeParam,
    fileKey: keyMatch[1],
    url: devLink(keyMatch[1], nodeParam),
    width: sameNode ? Math.round(node.width || 0) : 0,
    height: sameNode ? Math.round(node.height || 0) : 0,
  };
  // A pasted link addresses exactly one node, so this is the one screen there is.
  return Object.assign({}, one, {
    screens: [one],
    page: sameNode ? figma.currentPage.name : "from pasted link",
    file: fileName(),
  });
}

// One remembered target per Figma file, so sending from the same file twice in a
// row doesn't make the designer pick again.
function targetKey() {
  return "target:" + (fileKey() || fileName());
}

// The last folder used anywhere, which is what a file with no memory of its own falls
// back to. Someone who has never sent anything gets neither, and lands on Default.
const LAST_TARGET_KEY = "target:last";

// Nested under `info` on purpose: selectionInfo() has its own `type` field (the node
// type), and spreading it onto the message would overwrite the message's own `type`.
// Only posted when it actually changed: the 1.5s poll otherwise re-sent an identical
// message ~40 times a minute, and every one of those re-ran the UI's send-state logic.
let lastSelectionJson = "";
function postSelection() {
  const info = selectionInfo();
  const json = JSON.stringify(info);
  if (json === lastSelectionJson) return;
  lastSelectionJson = json;
  figma.ui.postMessage({ type: "selection", info: info });
}

// Status is deliberately NOT de-duplicated: the panel counts consecutive polls to decide
// whether a missing bridge is a restart or a real outage, so it needs every tick.
async function pushStatus() {
  let status = { bridge: false };
  try {
    const r = await bridgeFetch("/status", null, 6000);
    status = await r.json();
  } catch (e) { /* bridge not running, or not answering */ }
  // `type` last so a future field named `type` on the server response can't overwrite
  // the message type — that exact collision silently froze the selection panel once.
  figma.ui.postMessage(Object.assign({}, status, { type: "status" }));
}

let projectsLoaded = false;

async function pushProjects() {
  let payload = { projects: [], prototypesDir: null };
  try {
    const r = await bridgeFetch("/projects", null, 6000);
    payload = await r.json();
    projectsLoaded = true;
  } catch (e) { /* bridge not running yet; retried until it is */ }

  let saved = null;
  try {
    saved = await figma.clientStorage.getAsync(targetKey()) ||
            await figma.clientStorage.getAsync(LAST_TARGET_KEY);
  } catch (e) {}
  figma.ui.postMessage(Object.assign({ saved: saved }, payload, { type: "projects" }));
}

let buildInFlight = false;

figma.ui.onmessage = async (msg) => {
  if (msg.type === "init") {
    figma.ui.postMessage({ type: "about", pluginVersion: PLUGIN_VERSION, support: SUPPORT });
    await postSelection();
    await pushStatus();
    await pushProjects();
    // selectionchange can miss the state at open time, so poll lightly too.
    setInterval(postSelection, 1500);
    // 2s rather than 5s: during setup the designer is sitting there watching this,
    // and the bridge caches the expensive parts of /status anyway.
    setInterval(pushStatus, 2000);
    // Projects only exist once the bridge does, so keep retrying until they arrive —
    // then stop, rather than firing forever to evaluate a flag that never changes back.
    const projectsTimer = setInterval(function () {
      if (projectsLoaded) return clearInterval(projectsTimer);
      pushProjects();
    }, 4000);
    return;
  }

  // The panel sizes itself per screen: onboarding needs more room than the working view.
  // The result is reported back rather than swallowed. When a window refuses to shrink
  // there is no way to tell from the panel whether the request failed or was ignored, and
  // that difference is the whole diagnosis — one is a bug here, the other is Figma holding
  // the height because the plugin is docked, which no amount of layout can fix.
  if (msg.type === "resize") {
    var asked = Math.round(msg.h);
    var error = null;
    try { figma.ui.resize(Math.round(msg.w), asked); } catch (e) { error = e && e.message ? e.message : String(e); }
    figma.ui.postMessage({ type: "resized", asked: asked, error: error });
    return;
  }

  // Opens a native folder picker on the Mac. The timeout is long because a person is
  // standing in front of the dialog — the usual 8s deadline would abandon the request
  // while they were still deciding, and then the answer would have nowhere to go.
  if (msg.type === "chooseFolder") {
    try {
      const r = await bridgeFetch("/choose-folder", { method: "POST" }, 190000);
      const j = await r.json();
      figma.ui.postMessage({ type: "folderChosen", ok: !!j.ok, cancelled: !!j.cancelled, prototypesDir: j.prototypesDir, message: j.message });
    } catch (e) {
      figma.ui.postMessage({ type: "folderChosen", ok: false, message: "Couldn't reach the bridge on " + BRIDGE_LABEL + "." });
    }
    return;
  }

  // "New folder…" in the destination dropdown. Long deadline for the same reason as
  // /choose-folder: a person is standing in front of the dialog, and the usual 8s would
  // abandon the request while they were still deciding.
  if (msg.type === "chooseTarget") {
    try {
      const r = await bridgeFetch("/choose-target", { method: "POST" }, 190000);
      const j = await r.json();
      figma.ui.postMessage({
        type: "targetChosen", ok: !!j.ok, cancelled: !!j.cancelled,
        id: j.id, name: j.name, path: j.path, message: j.message,
      });
    } catch (e) {
      figma.ui.postMessage({ type: "targetChosen", ok: false, message: "Couldn't reach the bridge on " + BRIDGE_LABEL + "." });
    }
    return;
  }

  // Opening Slack itself is the bridge's job: `figma.openExternal` refuses anything but
  // http(s), so from here the best that can happen is a browser tab on a profile page,
  // which is two clicks and an SSO round trip away from a message box.
  //
  // The browser is still the fallback, and not a rare one — this link lives on the screen
  // a designer opens when the bridge isn't running, which is the one case where asking the
  // bridge to open it cannot work. Failing silently is what it did before, and is why
  // nobody could tell whether the link was broken or Slack was.
  if (msg.type === "openSupport") {
    try {
      const r = await bridgeFetch("/open-support", { method: "POST" }, 20000);
      const j = await r.json();
      if (j && j.ok) return figma.ui.postMessage({ type: "supportOpened", ok: true });
    } catch (e) {}

    const url = String((SUPPORT && SUPPORT.url) || "");
    try {
      figma.openExternal(url);
      figma.ui.postMessage({ type: "supportOpened", ok: true });
    } catch (e) {
      figma.ui.postMessage({ type: "supportOpened", ok: false, url: url });
    }
    return;
  }

  if (msg.type === "setup") {
    try {
      const r = await bridgeFetch("/setup", { method: "POST" }, 45000);
      const j = await r.json();
      figma.ui.postMessage({ type: "result", ok: j.ok, message: j.message });
    } catch (e) {
      figma.ui.postMessage({ type: "result", ok: false, message: "Couldn't reach the bridge on " + BRIDGE_LABEL + "." });
    }
    await pushStatus();
    return;
  }

  if (msg.type === "build") {
    // The UI re-enables its Send button on the next selection tick, so without a guard
    // here a second click while the first request is still open starts a second build.
    if (buildInFlight) return;
    buildInFlight = true;
    try {
      const info = msg.pastedUrl ? infoFromUrl(msg.pastedUrl) : selectionInfo();
      if (info.error) {
        figma.ui.postMessage({ type: "result", ok: false, message: info.error });
        return;
      }
      if (info.tooMany) {
        figma.ui.postMessage({
          type: "result", ok: false,
          message: "That's " + info.screens.length + " screens in one send. " +
            info.tooMany + " is the most one build can take on — send them in smaller batches.",
        });
        return;
      }

      // The remembered target is the mode and project, never the typed name: a name is
      // about this send, and silently reusing it would land the next selection in a folder
      // named after a screen that isn't in it.
      const target = Object.assign({}, msg.target || { mode: "new" });
      try {
        const remembered = Object.assign({}, target);
        delete remembered.projectName;
        await figma.clientStorage.setAsync(targetKey(), remembered);
        await figma.clientStorage.setAsync(LAST_TARGET_KEY, remembered);
      } catch (e) {}

      const payload = Object.assign({}, info, { target: target });
      try {
        const res = await bridgeFetch("/build", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }, 120000);
        const text = await res.text();
        figma.ui.postMessage({ type: "result", ok: res.ok, message: text });
      } catch (e) {
        figma.ui.postMessage({
          type: "result",
          ok: false,
          message: "Couldn't reach the bridge on " + BRIDGE_LABEL +
            ". It auto-starts at login — or double-click bridge/start.command.",
        });
      }
    } finally {
      buildInFlight = false;
    }
    return;
  }
};

figma.on("selectionchange", postSelection);
figma.on("currentpagechange", postSelection);
