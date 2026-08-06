// Runs in the Figma plugin sandbox. Reads the selected frame and hands it to the
// local bridge, which opens Claude Code desktop on the target project.
//
// Figma plugins can only reach http/https/ws/wss, which is why the bridge exists.

const BRIDGE = "http://localhost:7331";

figma.showUI(__html__, { width: 360, height: 540, themeColors: true });

// In Figma Design the selection lives in PageNode.selection. In Dev Mode the
// highlighted node can be PageNode.focusedNode instead.
function findSelectedNode() {
  try {
    if (figma.currentPage.selection.length > 0) return figma.currentPage.selection[0];
  } catch (e) {}
  try {
    if (figma.currentPage.focusedNode) return figma.currentPage.focusedNode;
  } catch (e) {}
  return null;
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

function selectionInfo() {
  const node = findSelectedNode();
  if (!node) {
    return { error: "Nothing selected. Click the frame or section on the canvas." };
  }

  const key = fileKey();
  const nodeId = node.id;                       // "12:345"
  const urlNodeId = nodeId.replace(/:/g, "-");  // URLs use a dash: "12-345"

  return {
    name: node.name,
    type: node.type,
    nodeId: nodeId,
    urlNodeId: urlNodeId,
    fileKey: key,
    url: key ? devLink(key, urlNodeId) : null,
    page: figma.currentPage.name,
    file: fileName(),
    width: Math.round(node.width || 0),
    height: Math.round(node.height || 0),
  };
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

  return {
    name: sameNode ? node.name : "Linked Figma frame",
    type: sameNode ? node.type : "FRAME",
    nodeId: nodeId,
    urlNodeId: nodeParam,
    fileKey: keyMatch[1],
    url: devLink(keyMatch[1], nodeParam),
    page: sameNode ? figma.currentPage.name : "from pasted link",
    file: fileName(),
    width: sameNode ? Math.round(node.width || 0) : 0,
    height: sameNode ? Math.round(node.height || 0) : 0,
  };
}

// One remembered target per Figma file, so sending from the same file twice in a
// row doesn't make the designer pick again.
function targetKey() {
  return "target:" + (fileKey() || fileName());
}

// Nested under `info` on purpose: selectionInfo() has its own `type` field (the node
// type), and spreading it onto the message would overwrite the message's own `type`.
function postSelection() {
  figma.ui.postMessage({ type: "selection", info: selectionInfo() });
}

async function pushStatus() {
  let status = { bridge: false };
  try {
    const r = await fetch(BRIDGE + "/status");
    status = await r.json();
  } catch (e) { /* bridge not running */ }
  // `type` last so a future field named `type` on the server response can't overwrite
  // the message type — that exact collision silently froze the selection panel once.
  figma.ui.postMessage(Object.assign({}, status, { type: "status" }));
}

async function pushProjects() {
  let payload = { projects: [], prototypesDir: null };
  try {
    const r = await fetch(BRIDGE + "/projects");
    payload = await r.json();
  } catch (e) { /* bridge not running; UI falls back to New prototype only */ }

  let saved = null;
  try { saved = await figma.clientStorage.getAsync(targetKey()); } catch (e) {}
  figma.ui.postMessage(Object.assign({ saved: saved }, payload, { type: "projects" }));
}

figma.ui.onmessage = async (msg) => {
  if (msg.type === "init") {
    await postSelection();
    await pushStatus();
    await pushProjects();
    // selectionchange can miss the state at open time, so poll lightly too.
    setInterval(postSelection, 1500);
    setInterval(pushStatus, 5000);
    return;
  }

  if (msg.type === "refresh") {
    await pushStatus();
    await pushProjects();
    return;
  }

  if (msg.type === "setup") {
    try {
      const r = await fetch(BRIDGE + "/setup", { method: "POST" });
      const j = await r.json();
      figma.ui.postMessage({ type: "result", ok: j.ok, message: j.message });
    } catch (e) {
      figma.ui.postMessage({ type: "result", ok: false, message: "Couldn't reach the bridge on localhost:7331." });
    }
    await pushStatus();
    return;
  }

  if (msg.type === "build") {
    const info = msg.pastedUrl ? infoFromUrl(msg.pastedUrl) : selectionInfo();
    if (info.error) {
      figma.ui.postMessage({ type: "result", ok: false, message: info.error });
      return;
    }

    try { await figma.clientStorage.setAsync(targetKey(), msg.target || null); } catch (e) {}

    const payload = Object.assign({}, info, { target: msg.target || { mode: "new" } });
    try {
      const res = await fetch(BRIDGE + "/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      figma.ui.postMessage({ type: "result", ok: res.ok, message: text });
    } catch (e) {
      figma.ui.postMessage({
        type: "result",
        ok: false,
        message: "Couldn't reach the bridge on localhost:7331. It auto-starts at login — or double-click bridge/start.command.",
      });
    }
    return;
  }
};

figma.on("selectionchange", postSelection);
figma.on("currentpagechange", postSelection);
