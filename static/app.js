// zk-graph front end: a plain script, no build step.
//
// Sections: constants · state · server API and busy indicator · info bar ·
// network setup · tag colours and legend · styling (search, focus, label mode) · graph edits ·
// saved views · UI wiring · startup.
//
// The server (the zk-graph script) serves this page, answers GET /init with
// the graph to show, and POST /<route> with JSON for everything else.
"use strict";

// ---- Constants ------------------------------------------------------------

const HELP = " — Click: details + focus (on an edge: where it links) | Double-click: open | Ctrl+click: add outgoing | " +
  "Right-click: expand/remove | Space: freeze | L: labels | Ctrl+F: search | Ctrl+S: save view";
const LABEL_MODES = ["hubs", "all", "none"];
const LABEL_SIZE = 12;
const HOVER_FOCUS_MAX = 1500;  // above this many notes, restyling on every hover lags
const BUSY_DELAY_MS = 150;     // requests faster than this show no busy indicator
const EXPAND_LABELS = { both: "Adding linked notes", out: "Adding outgoing links", in: "Adding backlinks" };
// Colours for tags without one in the config, picked by a hash of the tag name
// so a tag keeps its colour across sessions.
const TAG_PALETTE = [
  "#e74c3c", "#f39c12", "#9b59b6", "#2ecc71", "#3498db", "#1abc9c", "#e67e22", "#e84393",
  "#00cec9", "#a29bfe", "#fd79a8", "#badc58", "#ff7675", "#74b9ff", "#55efc4", "#ffeaa7",
];
const COLORS = {
  label: "#ccc", labelHit: "#fff", labelHidden: "rgba(0,0,0,0)", background: "#1e1e1e",
  edge: "#555", edgeFocus: "#aaa", edgeDimmed: "rgba(85,85,85,0.08)",
};

// ---- State ----------------------------------------------------------------

let token = "";             // required by the server on every POST
let nodes, edges, network;  // vis DataSets and the vis Network

let frozen = false;         // physics off
let currentView = null;     // name of the loaded/saved view, null if none
let viewOrigin = null;      // CLI options the current view started from
let dirty = false;          // unsaved changes to the current view

let legendConfig = { tags: [], dirs: [], default: "#97c2fc" };  // from the config file
let tagStyles = {};         // per-view overrides: {tag: {on, color}}, saved with the view
let tagPriority = [];       // tags in legend order; a note takes the first one that's on

let labelMode = loadLabelMode();
let searchQuery = "";
let selectedId = null;      // focused by click; stays until you click elsewhere
let hoverId = null;         // focused by hover; wins over the selection meanwhile

const $ = (id) => document.getElementById(id);

// ---- Server API and busy indicator ----------------------------------------

// The indicator appears only after BUSY_DELAY_MS, so fast requests don't flash
// it, then counts seconds, since a request that re-reads the notebook is slow.
const busy = { count: 0, timer: null, started: 0, label: "" };

function renderBusy() {
  const secs = Math.floor((Date.now() - busy.started) / 1000);
  $("busyText").textContent = busy.label + (secs >= 1 ? `  ${secs} s` : "") +
    (busy.count > 1 ? `  (+${busy.count - 1} more)` : "");
}

function busyStart(label) {
  busy.count++;
  busy.label = label;
  if (busy.count > 1) { renderBusy(); return; }
  busy.started = Date.now();
  const tick = () => {
    document.body.classList.add("busy");
    renderBusy();
    busy.timer = setTimeout(tick, 500);
  };
  busy.timer = setTimeout(tick, BUSY_DELAY_MS);
}

function busyEnd() {
  busy.count--;
  if (busy.count > 0) { renderBusy(); return; }
  clearTimeout(busy.timer);
  document.body.classList.remove("busy");
}

// POST JSON to the server; with a label, shows the busy indicator meanwhile.
async function api(route, payload, label) {
  if (label) busyStart(label);
  try {
    const r = await fetch(route, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Token": token },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error((await r.text()) || String(r.status));
    return await r.json();
  } finally {
    if (label) busyEnd();
  }
}

// ---- Info bar ---------------------------------------------------------------

let infoTimer = null;

// Show `msg` (for `ms` milliseconds, if given), or the default status line.
function setInfo(msg, ms) {
  clearTimeout(infoTimer);
  const view = currentView ? `View: ${currentView}${dirty ? "*" : ""} | ` : "";
  $("info").textContent = msg || `${view}Nodes: ${nodes.length} | Edges: ${edges.length}${HELP}`;
  if (msg && ms) infoTimer = setTimeout(() => setInfo(), ms);
}

function showError(err) {
  setInfo("Error: " + err.message, 5000);
}

function markDirty() {
  if (!dirty) { dirty = true; setInfo(); }
}

// ---- Network setup ----------------------------------------------------------

// A per-node `scaling.label` replaces the global one wholesale, so it must
// always carry every field; a bare {enabled} leaves the label size null.
// `alwaysDraw` drops the threshold below which small labels aren't drawn,
// without changing the label's size.
function labelScaling(enabled, alwaysDraw = false) {
  return { enabled, min: 10, max: 22, drawThreshold: alwaysDraw ? 0 : 9, maxVisible: 26 };
}

function networkOptions(view) {
  return {
    nodes: {
      shape: "dot",
      // With label scaling on ("hubs" mode), label size follows the note's size
      // and labels smaller than drawThreshold px on screen aren't drawn.
      scaling: { min: 6, max: 36, label: labelScaling(true) },
      // The stroke is a halo in the background colour, so edges don't cross the text
      font: { color: COLORS.label, size: LABEL_SIZE, strokeWidth: 3, strokeColor: COLORS.background },
      widthConstraint: { maximum: 160 },  // wrap long labels instead of widening them
      borderWidth: 1,
    },
    edges: {
      color: { color: COLORS.edge, highlight: COLORS.edgeFocus },
      arrows: { to: { enabled: true, scaleFactor: 0.5 } },
      smooth: { type: "continuous" },
    },
    physics: {
      enabled: !view.frozen,
      solver: "forceAtlas2Based",
      forceAtlas2Based: {
        gravitationalConstant: -30,
        centralGravity: 0.005,
        springLength: 100,
        springConstant: 0.02,
        damping: 0.4,
      },
      // Don't let the initial layout re-fit over a saved viewport
      stabilization: { iterations: 150, fit: !view.viewport },
    },
    interaction: {
      hover: true,
      navigationButtons: true,
      keyboard: { enabled: true, bindToWindow: false },
    },
    layout: { improvedLayout: false },
  };
}

function createNetwork(graph, view) {
  nodes = new vis.DataSet(graph.nodes);
  edges = new vis.DataSet(graph.edges);
  network = new vis.Network($("graph"), { nodes, edges }, networkOptions(view));
  if (view.viewport) applyViewport(view.viewport);
}

function applyViewport(vp) {
  if (vp && isFinite(vp.scale) && isFinite(vp.x) && isFinite(vp.y)) {
    network.moveTo({ position: { x: vp.x, y: vp.y }, scale: vp.scale });
  } else {
    network.fit();
  }
}

function setFrozen(f) {
  frozen = f;
  network.setOptions({ physics: { enabled: !frozen } });
  $("btnFreeze").textContent = frozen ? "Unfreeze" : "Freeze";
  $("btnFreeze").classList.toggle("active", frozen);
}

function toggleFreeze() {
  setFrozen(!frozen);
  markDirty();
}

// ---- Tag colours and the legend ------------------------------------------------
// The legend lists every tag of the notes on screen. Clicking a tag turns its
// colour on or off; clicking its dot picks another colour. Both are saved with
// the view. A note takes the colour of its first tag that's on (in legend
// order), else its directory's colour, else the default.

function configuredColor(tag) {
  const found = legendConfig.tags.find(([t]) => t === tag);
  return found ? found[1] : null;
}

function autoColor(tag) {
  let h = 0;
  for (const ch of tag) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return TAG_PALETTE[h % TAG_PALETTE.length];
}

function tagColor(tag) {
  return (tagStyles[tag] && tagStyles[tag].color) || configuredColor(tag) || autoColor(tag);
}

// Configured tags start on; the rest start off, so a notebook with many tags
// isn't a rainbow until you pick the tags you care about.
function tagOn(tag) {
  const style = tagStyles[tag];
  return style && typeof style.on === "boolean" ? style.on : configuredColor(tag) !== null;
}

function setTagStyle(tag, change) {
  tagStyles[tag] = { ...tagStyles[tag], ...change };
  markDirty();
  renderLegend();
  applyStyles();
}

function nodeColor(n) {
  const tags = n.tags || [];
  const tag = tagPriority.find((t) => tagOn(t) && tags.includes(t));
  return tag ? tagColor(tag) : n.base || legendConfig.default;
}

// Tags of the notes on screen: configured ones first, in config order (which
// decides their priority), then the rest by how many notes have them.
function shownTags() {
  const counts = new Map();
  nodes.forEach((n) => (n.tags || []).forEach((t) => counts.set(t, (counts.get(t) || 0) + 1)));
  const configured = legendConfig.tags.map(([t]) => t);
  const rest = [...counts.keys()].filter((t) => !configured.includes(t))
    .sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b));
  return { order: [...configured.filter((t) => counts.has(t)), ...rest], counts };
}

function legendRow(dotColor, label, { off = false, title = "" } = {}) {
  const row = document.createElement("div");
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.style.background = off ? "transparent" : dotColor;
  dot.style.borderColor = dotColor;
  const text = document.createElement("span");
  text.className = "label";
  text.textContent = label;
  row.append(dot, text);
  row.classList.toggle("off", off);
  row.title = title;
  return { row, dot, text };
}

// Rebuild the legend and the tag priority; call when the shown notes change.
function renderLegend() {
  const { order, counts } = shownTags();
  tagPriority = order;
  const rows = order.map((tag) => {
    const on = tagOn(tag);
    const { row, dot, text } = legendRow(tagColor(tag), `#${tag} (${counts.get(tag)})`, {
      off: !on, title: "Click: colour on/off · click the dot: change colour",
    });
    row.classList.add("tag");
    text.addEventListener("click", () => setTagStyle(tag, { on: !on }));
    // A colour input over the dot opens the browser's colour picker
    const picker = document.createElement("input");
    picker.type = "color";
    picker.value = /^#[0-9a-f]{6}$/i.test(tagColor(tag)) ? tagColor(tag) : "#000000";
    picker.addEventListener("change", () => setTagStyle(tag, { color: picker.value.toLowerCase(), on: true }));
    dot.append(picker);
    return row;
  });
  if (!order.length) rows.push(legendRow("transparent", "No tags on shown notes", { off: true }).row);
  const sep = document.createElement("hr");
  rows.push(sep,
    ...legendConfig.dirs.map(([dir, color]) => legendRow(color, dir + "/ (no coloured tag)").row),
    legendRow(legendConfig.default, legendConfig.dirs.length ? "Other" : "No coloured tag").row);
  $("legend").replaceChildren(...rows);
}

// ---- Styling: search, focus and label mode ---------------------------------
// Anything that changes one of these calls applyStyles(), which restyles all
// nodes and edges from scratch; with a few hundred notes that's instant.

function loadLabelMode() {
  try {
    const saved = localStorage.getItem("zkGraphLabels");
    if (LABEL_MODES.includes(saved)) return saved;
  } catch (e) { /* storage unavailable: use the default */ }
  return "hubs";
}

function setLabelMode(mode) {
  labelMode = mode;
  $("btnLabels").textContent = "Labels: " + mode;
  try { localStorage.setItem("zkGraphLabels", mode); } catch (e) { /* not remembered */ }
  applyStyles();
}

function cycleLabelMode() {
  setLabelMode(LABEL_MODES[(LABEL_MODES.indexOf(labelMode) + 1) % LABEL_MODES.length]);
}

// Search matches the full title too, not just the shortened label.
function matches(n, q) {
  return (n.full || n.label).toLowerCase().includes(q) || n.id.toLowerCase().includes(q);
}

function focusCenter() {
  const center = hoverId || selectedId;
  return center && nodes.get(center) ? center : null;
}

function applyStyles() {
  const center = focusCenter();
  const focus = center ? new Set([center, ...network.getConnectedNodes(center)]) : null;
  const q = searchQuery;

  nodes.update(nodes.get().map((n) => {
    const hit = !q || matches(n, q);
    const inFocus = !focus || focus.has(n.id);
    const lit = hit && inFocus;
    // Focused notes always show their label, at the same size as unfocused
    // (so hovering doesn't resize it), even if too small to draw otherwise
    const showLabel = lit && (focus ? true : labelMode !== "none");
    return {
      id: n.id,
      color: nodeColor(n),
      opacity: lit ? 1 : 0.12,
      font: {
        color: !showLabel ? COLORS.labelHidden : q && hit ? COLORS.labelHit : COLORS.label,
        strokeWidth: showLabel ? 3 : 0,
        size: LABEL_SIZE,
      },
      scaling: { label: labelScaling(labelMode === "hubs", Boolean(focus && inFocus)) },
    };
  }));

  edges.update(edges.get().map((e) => {
    const touches = e.from === center || e.to === center;
    const color = !center ? COLORS.edge : touches ? COLORS.edgeFocus : COLORS.edgeDimmed;
    return { id: e.id, color: { color, highlight: COLORS.edgeFocus } };
  }));
}

function setHover(id) {
  if (id && nodes.length > HOVER_FOCUS_MAX) return;
  if (hoverId === id) return;
  hoverId = id;
  applyStyles();
}

function syncSelection() {
  selectedId = network.getSelectedNodes()[0] || null;
  applyStyles();
}

function setSearch(q) {
  searchQuery = q;
  applyStyles();
}

// ---- Graph edits: remove, expand, refresh -----------------------------------

function removeNode(id) {
  edges.remove(edges.getIds({ filter: (e) => e.from === id || e.to === id }));
  nodes.remove(id);
  if (selectedId === id) selectedId = null;
  if (hoverId === id) hoverId = null;
  if (popupNodeId === id || (popupEdgeId && !edges.get(popupEdgeId))) hidePopup();
}

// Add fresh edges whose endpoints are displayed; drop displayed edges that
// isStale() claims for this sync but that are absent from the fresh set.
function syncEdges(fresh, isStale) {
  const freshIds = new Set(fresh.map((e) => e.id));
  edges.add(fresh.filter((e) => !edges.get(e.id) && nodes.get(e.from) && nodes.get(e.to)));
  edges.remove(edges.getIds({ filter: (e) => isStale(e) && !freshIds.has(e.id) }));
  if (popupEdgeId && !edges.get(popupEdgeId)) hidePopup();
}

// Start new notes on a circle around `center`, so they don't pile up in the
// middle when the layout is frozen.
function placeAround(center, added) {
  const c = nodes.get(center) ? network.getPosition(center) : { x: 0, y: 0 };
  added.forEach((n, i) => {
    const a = 2 * Math.PI * i / added.length;
    n.x = c.x + 150 * Math.cos(a);
    n.y = c.y + 150 * Math.sin(a);
  });
}

// Add the notes linked with `path` in `direction` ("both", "out" or "in").
async function expand(path, direction) {
  const node = nodes.get(path);
  const label = EXPAND_LABELS[direction] + (node ? ` of “${node.label}”` : "") + "…";
  try {
    const result = await api("/neighbors", { path, direction, shown: nodes.getIds() }, label);
    const added = result.nodes.filter((n) => !nodes.get(n.id));
    placeAround(path, added);
    nodes.add(added);
    // Edges among shown + new nodes; stale ones only for the clicked node
    syncEdges(result.edges, (e) => e.from === path || e.to === path);
    renderLegend();
    applyStyles();
    if (added.length) {
      markDirty();
      setInfo();
    } else {
      setInfo("No new notes to add", 3000);
    }
  } catch (err) {
    showError(err);
  }
}

// Re-read displayed notes from disk: update their content, drop deleted ones,
// sync their edges.
async function refresh() {
  const btn = $("btnRefresh");
  btn.textContent = "Refreshing...";
  btn.disabled = true;
  const displayed = nodes.getIds();
  try {
    const result = await api("/refresh", { paths: displayed }, "Refreshing notes…");
    // Update notes still shown (not ones removed while waiting), so no notes are added
    nodes.update(result.nodes.filter((n) => nodes.get(n.id)));
    const fresh = new Set(result.nodes.map((n) => n.id));
    displayed.filter((id) => !fresh.has(id)).forEach(removeNode);
    syncEdges(result.edges, () => true);
    await updatePopup();
    renderLegend();
    applyStyles();
    setInfo();
  } catch (err) {
    showError(err);
  } finally {
    btn.textContent = "Refresh";
    btn.disabled = false;
  }
}

// ---- Saved views --------------------------------------------------------------

async function refreshViewList() {
  const { views } = await api("/views/list", {});
  const select = $("viewSelect");
  const placeholder = new Option(views.length ? "Views…" : "No saved views", "");
  placeholder.disabled = true;
  select.replaceChildren(placeholder, ...views.map((v) => new Option(`${v.name} (${v.count})`, v.name)));
  select.value = currentView || "";
}

async function saveView() {
  let name = prompt("Save view as (letters, digits, _ . -):", currentView || "");
  if (name === null || !(name = name.trim())) return;
  const center = network.getViewPosition();
  try {
    await api("/views/save", {
      name,
      nodes: network.getPositions(),
      viewport: { scale: network.getScale(), x: center.x, y: center.y },
      frozen,
      tags: tagStyles,
      origin: viewOrigin,
    }, `Saving view “${name}”…`);
    currentView = name;
    dirty = false;
    setInfo();
    await refreshViewList();
  } catch (err) {
    showError(err);
  }
}

async function loadView(name) {
  if (dirty && !confirm("Discard unsaved changes to the current view?")) {
    $("viewSelect").value = currentView || "";
    return;
  }
  try {
    const v = await api("/views/load", { name }, `Loading view “${name}”…`);
    setFrozen(v.frozen);  // before adding nodes, so a frozen view stays put
    edges.clear();
    nodes.clear();
    nodes.add(v.graph.nodes);
    edges.add(v.graph.edges);
    currentView = v.name;
    viewOrigin = v.origin;
    tagStyles = v.tags || {};
    dirty = false;
    $("search").value = "";
    searchQuery = "";
    selectedId = hoverId = null;
    hidePopup();
    renderLegend();
    applyStyles();
    applyViewport(v.viewport);
    $("viewSelect").value = v.name;
    if (v.missing) setInfo(`View ${v.name}: ${v.missing} deleted note(s) dropped`, 5000);
    else setInfo();
  } catch (err) {
    $("viewSelect").value = currentView || "";
    showError(err);
  }
}

// ---- UI wiring ----------------------------------------------------------------

let popupNodeId = null;  // note whose details the popup shows
let popupEdgeId = null;  // or edge whose links it shows

// A note's details (HTML built and escaped by the server) and its whole body,
// rendered from Markdown and sanitized: notes may hold raw HTML. Images are
// dropped, since the server doesn't serve the notebook's files.
async function noteHtml(id) {
  const { body } = await api("/note", { path: id }, "Loading note…");
  if (!body) return nodes.get(id).details;
  const md = DOMPurify.sanitize(marked.parse(body, { gfm: true, breaks: true }),
    { FORBID_TAGS: ["img", "style"] });
  return `${nodes.get(id).details}<hr><div class="md">${md}</div>`;
}

// Where an edge's source note links to its target.
async function edgeHtml(id) {
  const edge = edges.get(id);
  return (await api("/link", { from: edge.from, to: edge.to }, "Loading link…")).details;
}

// Show a note's details, or an edge's links, next to `at` (px in the page).
// Both are fetched on click: a note's body can be long.
async function showPopup(id, at) {
  if (!nodes.get(id)) return hidePopup();
  hidePopup();
  popupNodeId = id;
  try {
    const html = await noteHtml(id);
    if (popupNodeId === id) placePopup(html, at);  // unless closed or replaced meanwhile
  } catch (err) {
    showError(err);
  }
}

async function showEdgePopup(id, at) {
  if (!edges.get(id)) return hidePopup();
  hidePopup();
  popupEdgeId = id;
  try {
    const html = await edgeHtml(id);
    if (popupEdgeId === id) placePopup(html, at);
  } catch (err) {
    showError(err);
  }
}

// Re-fetch what the open popup shows, keeping its place and scroll.
async function updatePopup() {
  const node = popupNodeId, edge = popupEdgeId;
  const html = node ? await noteHtml(node) : edge ? await edgeHtml(edge) : null;
  if (html !== null && popupNodeId === node && popupEdgeId === edge) $("popup").innerHTML = html;
}

// Fill the popup with `html` (built and escaped by the server) and place it
// next to `at` (px in the page), kept inside the window.
function placePopup(html, at) {
  const popup = $("popup");
  popup.innerHTML = html;
  popup.style.display = "block";
  popup.scrollTop = 0;
  const margin = 10, gap = 16;
  let x = at.x + gap, y = at.y + gap;
  if (x + popup.offsetWidth > innerWidth - margin) x = Math.max(margin, at.x - gap - popup.offsetWidth);
  if (y + popup.offsetHeight > innerHeight - margin) y = Math.max(margin, innerHeight - margin - popup.offsetHeight);
  popup.style.left = x + "px";
  popup.style.top = y + "px";
}

function hidePopup() {
  $("popup").style.display = "none";
  popupNodeId = popupEdgeId = null;
}

let ctxNodeId = null;  // note the context menu was opened on

function showCtxMenu(nodeId, event) {
  ctxNodeId = nodeId;
  const menu = $("ctxmenu");
  menu.style.left = event.pageX + "px";
  menu.style.top = event.pageY + "px";
  menu.style.display = "block";
}

function hideCtxMenu() {
  $("ctxmenu").style.display = "none";
  ctxNodeId = null;
}

function wireToolbar() {
  $("btnRefresh").addEventListener("click", refresh);
  $("btnFreeze").addEventListener("click", toggleFreeze);
  $("btnFit").addEventListener("click", () =>
    network.fit({ animation: { duration: 500, easingFunction: "easeInOutQuad" } }));
  $("btnLabels").addEventListener("click", cycleLabelMode);
  $("btnSave").addEventListener("click", saveView);
  $("viewSelect").addEventListener("change", (e) => { if (e.target.value) loadView(e.target.value); });
}

function wireSearch() {
  const input = $("search");
  let timer = null;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.toLowerCase();
    timer = setTimeout(() => setSearch(q), 400);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      input.value = "";
      input.dispatchEvent(new Event("input"));
      input.blur();
    } else if (e.key === "Enter") {
      const q = input.value.toLowerCase();
      const found = nodes.get({ filter: (n) => matches(n, q) })[0];
      if (!found) return;
      network.focus(found.id, { scale: 1.5, animation: { duration: 500 } });
      network.selectNodes([found.id]);  // doesn't fire selectNode, so sync by hand
      syncSelection();
    }
  });
}

function wireKeyboard() {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { hideCtxMenu(); hidePopup(); }
    if (e.ctrlKey || e.metaKey) {
      if (e.key === "f") { e.preventDefault(); $("search").focus(); $("search").select(); }
      if (e.key === "s") { e.preventDefault(); saveView(); }
      return;
    }
    if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName) || e.altKey) return;
    if (e.code === "Space") { e.preventDefault(); toggleFreeze(); }
    if (e.key.toLowerCase() === "l") cycleLabelMode();
  });
}

// Links in a note's body: web links open in a new tab; others (links to
// notes, relative files) do nothing, rather than navigate away from the graph.
function wirePopup() {
  $("popup").addEventListener("click", (e) => {
    const a = e.target.closest("a[href]");
    if (!a) return;
    e.preventDefault();
    if (/^https?:/i.test(a.getAttribute("href"))) window.open(a.href, "_blank", "noopener");
  });
}

function wireContextMenu() {
  document.addEventListener("click", hideCtxMenu);
  $("ctxmenu").querySelectorAll("[data-dir]").forEach((item) => {
    item.addEventListener("click", () => {
      const path = ctxNodeId;
      hideCtxMenu();
      if (path) expand(path, item.dataset.dir);
    });
  });
  $("ctxRemove").addEventListener("click", () => {
    const path = ctxNodeId;
    hideCtxMenu();
    if (!path) return;
    removeNode(path);
    renderLegend();
    applyStyles();
    markDirty();
    setInfo();
  });
}

function wireNetwork() {
  network.on("doubleClick", (p) => {
    if (p.nodes.length) api("/open", { path: p.nodes[0] }).catch(showError);
  });
  // Click: show the note's details, or the edge's links; Ctrl+click (Cmd+click
  // on macOS) on a note: add outgoing links
  network.on("click", (p) => {
    const ev = p.event && p.event.srcEvent;
    const id = p.nodes[0];
    if (id && ev && (ev.ctrlKey || ev.metaKey)) {
      hidePopup();
      expand(id, "out");
    } else if (id) {
      showPopup(id, p.pointer.DOM);
    } else if (p.edges.length) {
      showEdgePopup(p.edges[0], p.pointer.DOM);
    } else {
      hidePopup();
    }
  });
  // The popup doesn't follow the graph, so close it when the graph moves
  network.on("dragStart", hidePopup);
  network.on("zoom", hidePopup);
  network.on("oncontext", (p) => {
    p.event.preventDefault();
    const nodeId = network.getNodeAt(p.pointer.DOM);
    if (nodeId) showCtxMenu(nodeId, p.event);
    else hideCtxMenu();
  });
  network.on("hoverNode", (p) => setHover(p.node));
  network.on("blurNode", () => setHover(null));
  network.on("selectNode", syncSelection);
  network.on("deselectNode", syncSelection);
  network.on("dragEnd", (p) => { if (p.nodes.length) markDirty(); });
}

// ---- Startup --------------------------------------------------------------------

async function main() {
  busyStart("Loading graph…");
  let init;
  try {
    const r = await fetch("/init");
    if (!r.ok) throw new Error((await r.text()) || String(r.status));
    init = await r.json();
  } finally {
    busyEnd();
  }
  token = init.token;
  currentView = init.view.name;
  viewOrigin = init.view.origin;
  legendConfig = init.legend;
  tagStyles = init.view.tags || {};
  createNetwork(init.graph, init.view);
  renderLegend();
  wireToolbar();
  wireSearch();
  wireKeyboard();
  wireContextMenu();
  wirePopup();
  wireNetwork();
  setFrozen(init.view.frozen);
  setLabelMode(labelMode);  // also applies the initial styles
  setInfo();
  refreshViewList().catch(showError);
}

main().catch((err) => {
  $("info").textContent = "Error: " + err.message;
});
