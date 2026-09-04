/* PlumiChat — the server file picker: browsing the machine's own disk from the phone,
   attaching what you find to a message, uploading into a folder, and handing a file
   off to the device (which on an iOS home-screen app means the share sheet). */

import { apiFetch } from './api.js';
import { fmtSize, renderAttachments } from './panels/attachments.js';
import { extOf } from './panels/deliverables.js';
import { $, pref, toast } from './dom.js';
import { IOS_HANDOFF, fetchAndShare, handOffUrl } from './handoff.js';
import { FP_DL, FP_TICK, ICON_FOLDER_SM, ICON_HOME, ICON_WORKSPACE } from './icons.js';
import { basenameOf } from './render.js';
import { pending, projects } from './state.js';

/* ---------- Server file picker (browse the machine's disk) ---------- */
// Owner/admin can browse the whole computer; a member is confined to their own
// folder. Picked files are attached by PATH — send() ships the paths and the
// backend hands them to Claude's Read tool (scope is re-enforced server-side).
export let driveBtn = $("driveBtn");
export let fpModal = $("fpModal"), fpOverlay = $("fpOverlay");
export let fpList = $("fpList"), fpUp = $("fpUp"), fpBack = $("fpBack");
export let fpCrumbs = $("fpCrumbs"), fpSide = $("fpSide");
export let fpViewGrid = $("fpViewGrid"), fpViewList = $("fpViewList");
export let fpSortBtn = $("fpSort"), fpSortLabel = $("fpSortLabel"), fpSelAll = $("fpSelAll");
export let fpCount = $("fpCount"), fpAttach = $("fpAttach"), fpDownloadSel = $("fpDownloadSel");
export let fpUpload = $("fpUpload"), fpUploadMenu = $("fpUploadMenu");
export let fpUploadInput = $("fpUploadInput"), fpUploadDirInput = $("fpUploadDirInput");
export let fpSearch = $("fpSearch"), fpSearchClear = $("fpSearchClear");
export let fpProjectsBtn = $("fpProjectsBtn");
export let fpCwd = "", fpParent = null, fpHome = "", fpRoot = "", fpWorkspace = "", fpSel = {};
export let fpHist = [];                          // paths visited this session (Back button)
export let fpShown = [], fpCurEntries = null, fpCurOpts = null; // last render (re-sort / select-all)
export let fpView = "grid", fpSort = "name";     // remembered device-locally (pref)
export let fpSearchTimer = null, fpSearchSeq = 0; // debounce + ignore stale responses
export let FP_SORTS = ["name", "size", "type"];
export let FP_SORT_LABEL = { name: "Name", size: "Size", type: "Kind" };
// Raster image extensions we can thumbnail inline (mirrors the server's
// /api/thumb allow-list). SVG is deliberately excluded (served as an icon).
export let FP_RASTER = { png: 1, jpg: 1, jpeg: 1, gif: 1, webp: 1, bmp: 1, avif: 1, ico: 1 };
// Extension → kind (drives both the icon shape and its colour class).
export let FP_KIND = {};
export function fpKindOf(en) { return en.type === "dir" ? "dir" : (FP_KIND[extOf(en.name)] || "file"); }
export function fpIsRaster(name) { return !!FP_RASTER[extOf(name)]; }
export function fpSvg(inner) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>'; }
export let FP_SVG = {
  dir: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>',
  img: '<rect x="3" y="3" width="18" height="18" rx="2.5"></rect><circle cx="8.5" cy="9" r="1.6"></circle><path d="M21 16l-5-5L5 21"></path>',
  vid: '<rect x="3" y="5" width="18" height="14" rx="2"></rect><polygon points="10 9 16 12 10 15 10 9"></polygon>',
  aud: '<path d="M9 18V5l10-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="16" cy="16" r="3"></circle>',
  pdf: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><path d="M9 13h1.5a1.5 1.5 0 0 1 0 3H9zM9 13v5"></path>',
  doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="8" y1="13" x2="16" y2="13"></line><line x1="8" y1="17" x2="13" y2="17"></line>',
  txt: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="8" y1="13" x2="16" y2="13"></line><line x1="8" y1="17" x2="13" y2="17"></line>',
  sheet: '<rect x="3" y="4" width="18" height="16" rx="2"></rect><line x1="3" y1="10" x2="21" y2="10"></line><line x1="3" y1="15" x2="21" y2="15"></line><line x1="9" y1="4" x2="9" y2="20"></line><line x1="15" y1="4" x2="15" y2="20"></line>',
  slide: '<rect x="3" y="4" width="18" height="13" rx="2"></rect><line x1="12" y1="17" x2="12" y2="21"></line><line x1="8" y1="21" x2="16" y2="21"></line>',
  arch: '<path d="M21 8v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8"></path><rect x="2" y="3.5" width="20" height="4.5" rx="1"></rect><line x1="10" y1="12" x2="14" y2="12"></line>',
  code: '<polyline points="9 8 5 12 9 16"></polyline><polyline points="15 8 19 12 15 16"></polyline>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline>'
};

// Pull server file(s)/folder(s) down to this device. Pass one path or many: the
// route streams a lone file as-is and anything else (a folder, or a multi-pick)
// as a .zip. A same-origin request sends the session cookie; the route's
// Content-Disposition: attachment makes the browser SAVE it (and names it) —
// except in an iOS home-screen app, where handOffUrl/fetchAndShare take over.
export function fpDownload(paths) {
  var list = Array.isArray(paths) ? paths : [paths];
  if (!list.length) return;
  if (list.length === 1) {
    // Single file/folder → simple GET (folder comes back as a .zip).
    handOffUrl("/api/download?path=" + encodeURIComponent(list[0]), basenameOf(list[0]));
    return;
  }
  if (IOS_HANDOFF) {
    var body = new URLSearchParams();
    list.forEach(function (p) { body.append("path", p); });
    fetchAndShare("/api/download", "plumi-files.zip", { method: "POST", body: body });
    return;
  }
  // Many picks → POST a hidden form so the (potentially long) path list travels
  // in the body, not the URL. The attachment response downloads without navigating.
  var form = document.createElement("form");
  form.method = "POST"; form.action = "/api/download"; form.style.display = "none";
  list.forEach(function (p) {
    var i = document.createElement("input"); i.type = "hidden"; i.name = "path"; i.value = p; form.appendChild(i);
  });
  document.body.appendChild(form); form.submit();
  setTimeout(function () { document.body.removeChild(form); }, 0);
}

export function fpJoin(dir, name) { return (dir === "/" ? "" : dir.replace(/\/+$/, "")) + "/" + name; }
export function fpDirName(p) { var i = p.lastIndexOf("/"); var d = i <= 0 ? "/" : p.slice(0, i); var seg = d.split("/").filter(Boolean); return seg.length ? seg[seg.length - 1] : "/"; }
export let FP_DASH = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg>';
export function fpUpdateCount() {
  var n = Object.keys(fpSel).length;
  fpCount.textContent = n ? (n + " selected") : "";
  fpAttach.disabled = !n;
  fpAttach.textContent = n ? ("Attach " + n) : "Attach";
  if (fpDownloadSel) fpDownloadSel.disabled = !n;
  fpUpdateSelAll();
}
// The header "select all" reflects the CURRENT view: filled when every shown
// item is picked, a dash when only some are, empty when none. Toggling it acts
// only on what's visible (the open folder or the search hits), never the disk.
export function fpUpdateSelAll() {
  if (!fpSelAll) return;
  var box = fpSelAll.querySelector(".fp-selall-box");
  var total = fpShown.length, picked = 0;
  for (var i = 0; i < fpShown.length; i++) if (fpSel[fpShown[i].abs]) picked++;
  fpSelAll.disabled = !total;
  var all = total > 0 && picked === total, some = picked > 0 && picked < total;
  fpSelAll.classList.toggle("on", all);
  fpSelAll.classList.toggle("some", some);
  if (box) box.innerHTML = all ? FP_TICK : (some ? FP_DASH : "");
}
// Select or clear every item currently in view in one tap.
export function fpToggleSelAll() {
  if (!fpShown.length) return;
  var allPicked = true;
  for (var i = 0; i < fpShown.length; i++) if (!fpSel[fpShown[i].abs]) { allPicked = false; break; }
  fpShown.forEach(function (s) {
    var en = s.en, abs = s.abs;
    if (allPicked) delete fpSel[abs];
    else if (!fpSel[abs]) fpSel[abs] = en.type === "dir"
      ? { name: en.name, size: null, path: abs, dir: true }
      : { name: en.name, size: en.size, path: abs };
  });
  var nodes = fpList.querySelectorAll(".fp-item");
  for (var j = 0; j < nodes.length; j++) nodes[j].classList.toggle("sel", !!fpSel[nodes[j].getAttribute("data-abs")]);
  fpUpdateCount();
}
// Toggle one file/folder in/out of the selection and reflect it on its tile.
export function toggleSel(abs, meta, el) {
  if (fpSel[abs]) delete fpSel[abs]; else fpSel[abs] = meta;
  if (el) el.classList.toggle("sel", !!fpSel[abs]);
  fpUpdateCount();
}
// Folders first, then by the chosen key. Name sort is natural/numeric-aware so
// "file10" lands after "file2". The SAME markup works in grid and list views.
export function fpSortEntries(entries) {
  var arr = entries.slice();
  arr.sort(function (a, b) {
    var ad = a.type === "dir", bd = b.type === "dir";
    if (ad !== bd) return ad ? -1 : 1;
    if (fpSort === "size") {
      var as = a.size == null ? -1 : a.size, bs = b.size == null ? -1 : b.size;
      if (as !== bs) return bs - as;
    } else if (fpSort === "type") {
      var ak = fpKindOf(a), bk = fpKindOf(b);
      if (ak !== bk) return ak < bk ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
  return arr;
}
// Build one tile. `en` may carry an absolute `path` and a `rel` sub-path when
// it's a search hit; in plain browsing the path is derived from fpCwd. Rasters
// get a lazy inline preview that silently falls back to the kind icon on error.
export function fpNode(en) {
  var abs = en.path || fpJoin(fpCwd, en.name);
  var kind = fpKindOf(en);
  var isDir = en.type === "dir";
  var item = document.createElement("button"); item.type = "button";
  item.className = "fp-item" + (isDir ? " dir" : " file") + (fpSel[abs] ? " sel" : "");
  item.setAttribute("data-abs", abs);

  var thumb = document.createElement("span"); thumb.className = "fp-thumb fp-k-" + kind;
  thumb.innerHTML = fpSvg(FP_SVG[kind] || FP_SVG.file);
  if (!isDir && fpIsRaster(en.name)) {
    var img = document.createElement("img"); img.className = "fp-img"; img.loading = "lazy"; img.alt = "";
    img.addEventListener("load", function () { thumb.classList.add("has-img"); });
    img.addEventListener("error", function () { if (img.parentNode) img.parentNode.removeChild(img); });
    img.src = "/api/thumb?path=" + encodeURIComponent(abs);
    thumb.appendChild(img);
  }
  var chk = document.createElement("span"); chk.className = "fp-check"; chk.innerHTML = FP_TICK; thumb.appendChild(chk);
  item.appendChild(thumb);

  var nm = document.createElement("span"); nm.className = "fp-name";
  var main = document.createElement("span"); main.className = "fp-name-main"; main.textContent = en.name; nm.appendChild(main);
  var subText = (en.rel && en.rel !== en.name) ? en.rel : (!isDir && en.size != null ? fmtSize(en.size) : "");
  if (subText) { var sub = document.createElement("span"); sub.className = "fp-name-sub"; sub.textContent = subText; nm.appendChild(sub); }
  item.appendChild(nm);

  var acts = document.createElement("span"); acts.className = "fp-acts";
  if (isDir) {
    // A folder can be BOTH opened (tap the tile) and attached whole (tap the
    // pick control). The control swallows the click so it never navigates.
    var pk = document.createElement("span"); pk.className = "fp-pick"; pk.setAttribute("role", "button");
    pk.title = "Attach this folder"; pk.setAttribute("aria-label", "Attach this folder"); pk.innerHTML = FP_TICK;
    pk.addEventListener("click", function (e) { e.stopPropagation(); toggleSel(abs, { name: en.name, size: null, path: abs, dir: true }, item); });
    acts.appendChild(pk);
  }
  var dl = document.createElement("span"); dl.className = "fp-dl"; dl.setAttribute("role", "button");
  dl.title = isDir ? "Download this folder (.zip)" : "Download to this device";
  dl.setAttribute("aria-label", dl.title); dl.innerHTML = FP_DL;
  dl.addEventListener("click", function (e) { e.stopPropagation(); fpDownload(abs); });
  acts.appendChild(dl);
  item.appendChild(acts);

  if (isDir) item.addEventListener("click", function () { fpNavTo(abs); }); // also exits search
  else item.addEventListener("click", function () { toggleSel(abs, { name: en.name, size: en.size, path: abs }, item); });
  return item;
}
// Render `entries` into the list using the current view (grid/list) & sort.
// `opts.sort===false` keeps the given order (search hits arrive pre-ranked).
// `opts.note` shows a status line on top; `opts.empty` overrides empty text.
// Remembers the input so a view/sort change can re-render without a refetch.
export function fpRenderList(entries, opts) {
  opts = opts || {};
  fpCurEntries = entries; fpCurOpts = opts;
  fpList.className = "fp-list " + fpView;
  fpList.innerHTML = "";
  fpShown = [];
  if (opts.note) { var nt = document.createElement("div"); nt.className = "fp-note"; nt.textContent = opts.note; fpList.appendChild(nt); }
  if (!entries.length) {
    var emptyText = ("empty" in opts) ? opts.empty : "This folder is empty";
    if (emptyText) { var em = document.createElement("div"); em.className = "fp-empty"; em.textContent = emptyText; fpList.appendChild(em); }
    fpUpdateSelAll();
    return;
  }
  var ordered = opts.sort === false ? entries : fpSortEntries(entries);
  var grid = document.createElement("div"); grid.className = "fp-grid";
  ordered.forEach(function (en) {
    var abs = en.path || fpJoin(fpCwd, en.name);
    fpShown.push({ abs: abs, en: en });
    grid.appendChild(fpNode(en));
  });
  fpList.appendChild(grid);
  fpUpdateSelAll();
}
export function fpUpdateBack() { if (fpBack) fpBack.disabled = !fpHist.length; }
// The "Projects" jump button: shown only when the server says the projects
// workspace is reachable (owner/admin), and dimmed while you're already there.
export function fpUpdateProjectsBtn() {
  if (!fpProjectsBtn) return;
  if (!fpWorkspace) { fpProjectsBtn.hidden = true; return; }
  fpProjectsBtn.hidden = false;
  fpProjectsBtn.disabled = (fpCwd === fpWorkspace);
}
// Clickable breadcrumb from the workspace root down to the open folder. The top
// is always labelled "Workspace" (the top of what you're allowed to see); a
// member never sees path pieces above their sandbox because fpRoot is their root.
export function fpRenderCrumbs() {
  if (!fpCrumbs) return;
  fpCrumbs.innerHTML = "";
  var root = fpRoot || "/";
  var addCrumb = function (label, path, isLast, iconHtml) {
    var b = document.createElement("button"); b.type = "button"; b.className = "fp-crumb" + (isLast ? " cur" : "");
    if (iconHtml) { var ic = document.createElement("span"); ic.className = "fp-crumb-ic"; ic.innerHTML = iconHtml; b.appendChild(ic); }
    var tx = document.createElement("span"); tx.className = "fp-crumb-tx"; tx.textContent = label; b.appendChild(tx);
    if (!isLast) b.addEventListener("click", function () { fpNavTo(path); });
    fpCrumbs.appendChild(b);
  };
  var tail = [];
  if (fpCwd && fpCwd !== root && fpCwd.indexOf(root) === 0) {
    var base = (root === "/") ? "" : root;
    var acc = base;
    fpCwd.slice(base.length).split("/").filter(Boolean).forEach(function (seg) { acc = acc + "/" + seg; tail.push({ name: seg, path: acc }); });
  }
  addCrumb("Workspace", root, tail.length === 0, ICON_WORKSPACE);
  tail.forEach(function (seg, i) {
    var sep = document.createElement("span"); sep.className = "fp-crumb-sep"; sep.textContent = "›"; fpCrumbs.appendChild(sep);
    addCrumb(seg.name, seg.path, i === tail.length - 1, null);
  });
}
// Left "Places" rail: quick jumps to the workspace root, the home folder, and
// each known project. Deduped by path; the open folder is highlighted.
export function fpRenderSide() {
  if (!fpSide) return;
  fpSide.innerHTML = "";
  var places = [], seen = {};
  var add = function (label, path, icon) { if (!path || seen[path]) return; seen[path] = 1; places.push({ label: label, path: path, icon: icon }); };
  add("Workspace", fpRoot || "/", ICON_WORKSPACE);
  if (fpHome && fpHome !== fpRoot) add("Home", fpHome, ICON_HOME);
  (projects || []).forEach(function (p) { if (p && p.path) add(p.name || basenameOf(p.path), p.path, ICON_FOLDER_SM); });
  if (!places.length) return;
  var head = document.createElement("div"); head.className = "fp-side-head"; head.textContent = "Places"; fpSide.appendChild(head);
  places.forEach(function (pl) {
    var b = document.createElement("button"); b.type = "button"; b.className = "fp-place" + (pl.path === fpCwd ? " active" : "");
    var ic = document.createElement("span"); ic.className = "fp-place-ic"; ic.innerHTML = pl.icon; b.appendChild(ic);
    var tx = document.createElement("span"); tx.className = "fp-place-tx"; tx.textContent = pl.label; b.appendChild(tx);
    b.addEventListener("click", function () { fpNavTo(pl.path); });
    fpSide.appendChild(b);
  });
}
export function fpLoad(p) {
  // Loading a directory listing always means "browse mode" — cancel any pending
  // or in-flight search and empty the box so the two views never fight.
  fpCtxClose();
  if (fpSearchTimer) { clearTimeout(fpSearchTimer); fpSearchTimer = null; }
  fpSearchSeq++;
  if (fpSearch) fpSearch.value = "";
  if (fpSearchClear) fpSearchClear.hidden = true;
  fpShown = []; fpCurEntries = null; fpUpdateSelAll();
  fpList.className = "fp-list " + fpView;
  fpList.innerHTML = '<div class="fp-empty">Loading…</div>';
  apiFetch("/api/files" + (p ? "?path=" + encodeURIComponent(p) : ""))
    .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
    .then(function (res) {
      if (!res.ok) { fpRenderList([], { empty: (res.d && res.d.error) || "Can't open this folder" }); return; }
      var d = res.d;
      fpCwd = d.path; fpParent = d.parent; fpHome = d.home; fpRoot = d.root || fpRoot || d.path;
      if (d.workspace != null) fpWorkspace = d.workspace;
      fpUp.disabled = !!d.atRoot || !d.parent;
      fpUpdateBack();
      fpUpdateProjectsBtn();
      fpRenderCrumbs();
      fpRenderSide();
      fpRenderList(d.entries || []);
    })
    .catch(function () { fpRenderList([], { empty: "Network error" }); });
}
// Navigate into a folder, remembering where we came from so Back works.
export function fpNavTo(p) {
  if (p == null) return;
  if (fpCwd && p !== fpCwd) fpHist.push(fpCwd);
  fpLoad(p);
}
export function fpOpen() {
  fpSel = {}; fpHist = []; fpUpdateCount();
  fpOverlay.classList.add("open"); fpModal.classList.add("open");
  fpModal.setAttribute("aria-hidden", "false");
  fpLoad(""); // server defaults to the caller's home/root
}
export function fpClose() {
  fpCtxClose();
  fpOverlay.classList.remove("open"); fpModal.classList.remove("open");
  fpModal.setAttribute("aria-hidden", "true");
}
// View (grid/list) and sort (name/size/kind) are remembered on THIS device and
// re-render the current listing in place — no refetch. Search results keep the
// server's ranking (opts.sort === false), so sort only re-orders browsed folders.
export function fpSetView(v) {
  fpView = (v === "list") ? "list" : "grid";
  pref("fpView", fpView);
  if (fpViewGrid) fpViewGrid.classList.toggle("on", fpView === "grid");
  if (fpViewList) fpViewList.classList.toggle("on", fpView === "list");
  if (fpCurEntries) fpRenderList(fpCurEntries, fpCurOpts || {});
  else fpList.className = "fp-list " + fpView;
}
export function fpSetSort(s) {
  fpSort = FP_SORTS.indexOf(s) >= 0 ? s : "name";
  pref("fpSort", fpSort);
  if (fpSortLabel) fpSortLabel.textContent = FP_SORT_LABEL[fpSort];
  if (fpCurEntries && !(fpCurOpts && fpCurOpts.sort === false)) fpRenderList(fpCurEntries, fpCurOpts || {});
}
export function fpCycleSort() { var i = FP_SORTS.indexOf(fpSort); fpSetSort(FP_SORTS[(i + 1) % FP_SORTS.length]); }
// Recursive "find by name" rooted at the current folder. Each keystroke (debounced)
// supersedes the last via fpSearchSeq, so a slow response can't overwrite newer
// results. Selections made here persist into fpSel exactly like browsed ones.
export function fpRunSearch(q) {
  var seq = ++fpSearchSeq;
  fpRenderList([], { note: "Searching…", empty: "", sort: false });
  apiFetch("/api/search?q=" + encodeURIComponent(q) + (fpCwd ? "&path=" + encodeURIComponent(fpCwd) : ""))
    .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
    .then(function (res) {
      if (seq !== fpSearchSeq) return; // a newer keystroke (or a navigation) won
      if (!res.ok) { fpRenderList([], { empty: (res.d && res.d.error) || "Search failed", sort: false }); return; }
      var rs = (res.d && res.d.results) || [], trunc = res.d && res.d.truncated;
      var note = rs.length
        ? (rs.length + (trunc ? "+" : "") + " match" + (rs.length === 1 && !trunc ? "" : "es") + (trunc ? " — refine to narrow" : ""))
        : "";
      fpRenderList(rs, { note: note, empty: 'No files match “' + q + '”', sort: false });
    })
    .catch(function () { if (seq === fpSearchSeq) fpRenderList([], { empty: "Network error", sort: false }); });
}
export function fpOnSearchInput() {
  var q = fpSearch.value;
  fpSearchClear.hidden = !q;
  if (fpSearchTimer) { clearTimeout(fpSearchTimer); fpSearchTimer = null; }
  if (!q.trim()) { fpLoad(fpCwd); return; } // emptied → back to browsing this folder
  fpSearchTimer = setTimeout(function () { fpRunSearch(q.trim()); }, 220);
}
// Push device files/folders INTO the folder we're viewing. The Upload button opens
// a tiny menu: "files" (multi-select, works everywhere incl. iOS) or "folder"
// (desktop only — hidden where the browser can't pick a directory). Each chosen
// file streams its bytes to /api/upload-to with its relative path, so a folder's
// whole tree is rebuilt server-side. Sequential (one request at a time) to keep the
// progress honest and not pile requests onto the single-process server.
export let fpCanDir = !!fpUploadDirInput && ("webkitdirectory" in fpUploadDirInput);
export let fpUploadFolderBtn = $("fpUploadFolder");
export function fpUploadMenuOpen(open) {
  if (!fpUploadMenu) return;
  fpUploadMenu.hidden = !open;
  if (fpUpload) fpUpload.setAttribute("aria-expanded", open ? "true" : "false");
}
export let fpUploadFilesBtn = $("fpUploadFiles");
// Make a folder right where you're standing: right-click (computer) or long-press
// (phone) the EMPTY space of the listing — a click on a tile keeps its own meaning.
// The little menu is a child of .fp-modal, whose transform makes it the containing
// block for positioned children, so it's placed in modal-relative coordinates and
// clamped to stay inside.
export let fpCtx = $("fpCtx");
export let fpCtxAt = { x: 0, y: 0 };
export let ICON_NEW_FOLDER = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><line x1="12" y1="11" x2="12" y2="17"></line><line x1="9" y1="14" x2="15" y2="14"></line></svg>';

export function fpCtxClose() { if (fpCtx) { fpCtx.hidden = true; fpCtx.innerHTML = ""; } }
// Re-run after swapping the menu's contents — the box changes size.
export function fpCtxPlace() {
  var m = fpModal.getBoundingClientRect();
  var w = fpCtx.offsetWidth, h = fpCtx.offsetHeight;
  fpCtx.style.left = Math.max(8, Math.min(fpCtxAt.x - m.left, m.width - w - 8)) + "px";
  fpCtx.style.top = Math.max(8, Math.min(fpCtxAt.y - m.top, m.height - h - 8)) + "px";
}
export function fpCtxOpen(x, y) {
  if (!fpCtx) return;
  fpUploadMenuOpen(false);
  fpCtxAt = { x: x, y: y };
  fpCtx.innerHTML = "";
  var b = document.createElement("button");
  b.type = "button"; b.className = "fp-ctx-item"; b.setAttribute("role", "menuitem");
  b.innerHTML = ICON_NEW_FOLDER + "<span>New folder…</span>";
  b.addEventListener("click", fpCtxNewFolder);
  fpCtx.appendChild(b);
  fpCtx.hidden = false;
  fpCtxPlace();
}
// Swap the menu for an inline name field — no browser prompt, which is awkward
// on a phone. Creates in the folder that was open when the menu was raised.
export function fpCtxNewFolder() {
  var dest = fpCwd;
  fpCtx.innerHTML = "";
  var inp = document.createElement("input");
  inp.type = "text"; inp.className = "fp-ctx-input"; inp.placeholder = "Folder name";
  inp.maxLength = 80; inp.autocapitalize = "off"; inp.spellcheck = false;
  var err = document.createElement("div"); err.className = "fp-ctx-err"; err.hidden = true;
  var row = document.createElement("div"); row.className = "fp-ctx-row";
  var cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "fp-ctx-mini"; cancel.textContent = "Cancel";
  var create = document.createElement("button"); create.type = "button"; create.className = "fp-ctx-mini primary"; create.textContent = "Create";
  function fail(msg) {
    err.textContent = msg; err.hidden = false;
    create.disabled = false; cancel.disabled = false; inp.disabled = false;
    fpCtxPlace(); inp.focus();
  }
  function submit() {
    var name = inp.value.trim();
    if (!name) { inp.focus(); return; }
    err.hidden = true; create.disabled = true; cancel.disabled = true; inp.disabled = true;
    apiFetch("/api/mkdir", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir: dest, name: name })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.error || ("Request failed (" + r.status + ")"));
        return d;
      });
    }).then(function (d) {
      fpCtxClose();
      toast('Created folder "' + d.name + '"');
      if (fpModal.classList.contains("open") && fpCwd === dest) fpLoad(dest);
    }).catch(function (e) { fail(e.message || "Could not create the folder"); });
  }
  create.addEventListener("click", submit);
  cancel.addEventListener("click", fpCtxClose);
  inp.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
    else if (e.key === "Escape") { e.stopPropagation(); fpCtxClose(); }
  });
  row.appendChild(cancel); row.appendChild(create);
  fpCtx.appendChild(inp); fpCtx.appendChild(err); fpCtx.appendChild(row);
  fpCtxPlace();
  inp.focus();
}
export function fpInVoid(target) { return !(target && target.closest && target.closest(".fp-item")); }
export let fpUploading = false;
export let FP_UPLOAD_MAX = 100 * 1024 * 1024; // mirrors the server's per-file cap
export function fpUploadLabel(txt) { var s = fpUpload && fpUpload.querySelector("span"); if (s) s.textContent = txt; }
export function fpDoUpload(fileList) {
  if (fpUploading) return;
  var all = Array.prototype.slice.call(fileList || []);
  var tooBig = all.filter(function (f) { return f.size > FP_UPLOAD_MAX; }).length;
  var files = all.filter(function (f) { return f.size <= FP_UPLOAD_MAX; });
  if (!files.length) { if (tooBig) toast("Nothing uploaded — over the 100 MB per-file limit.", true); return; }
  var destDir = fpCwd, total = files.length, failed = 0, i = 0;
  fpUploading = true;
  if (fpUpload) fpUpload.disabled = true;
  fpUploadLabel("Uploading 1/" + total + "…");
  function finish() {
    fpUploading = false;
    if (fpUpload) fpUpload.disabled = false;
    fpUploadLabel("Upload");
    var okCount = total - failed;
    var msg = okCount ? ("Uploaded " + okCount + " item" + (okCount === 1 ? "" : "s")) : "Upload failed";
    if (failed) msg += " · " + failed + " failed";
    if (tooBig) msg += " · " + tooBig + " too large";
    toast(msg, !okCount);
    if (fpModal.classList.contains("open") && fpCwd === destDir) fpLoad(fpCwd); // show the new files
  }
  function next() {
    if (i >= files.length) return finish();
    var f = files[i];
    var rel = (f.webkitRelativePath && f.webkitRelativePath.length) ? f.webkitRelativePath : f.name;
    fpUploadLabel("Uploading " + (i + 1) + "/" + total + "…");
    f.arrayBuffer().then(function (buf) {
      return apiFetch("/api/upload-to?dir=" + encodeURIComponent(destDir) + "&rel=" + encodeURIComponent(rel), {
        method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: buf
      });
    }).then(function (r) { if (!r.ok) failed++; }, function () { failed++; })
      .then(function () { i++; next(); });
  }
  next();
}

export function initFilePicker() {
  (function () {
    var groups = {
      img: "png jpg jpeg gif webp bmp avif ico svg heic heif tiff",
      vid: "mp4 mov webm mkv avi m4v wmv flv",
      aud: "mp3 wav m4a aac ogg flac",
      pdf: "pdf",
      doc: "doc docx rtf odt pages",
      txt: "txt md markdown log",
      sheet: "xls xlsx csv tsv ods numbers",
      slide: "ppt pptx odp key",
      arch: "zip tar gz tgz rar 7z bz2 xz",
      code: "js mjs cjs ts tsx jsx py rb go rs java c h hpp cpp cc cs php sh bash zsh json yml yaml toml xml html htm css scss sass sql swift kt vue"
    };
    Object.keys(groups).forEach(function (k) { groups[k].split(" ").forEach(function (e) { FP_KIND[e] = k; }); });
  })();
  // Restore remembered view/sort before the first open so the toolbar matches.
  fpView = pref("fpView") === "list" ? "list" : "grid";
  fpSort = FP_SORTS.indexOf(pref("fpSort")) >= 0 ? pref("fpSort") : "name";
  if (fpViewGrid) fpViewGrid.classList.toggle("on", fpView === "grid");
  if (fpViewList) fpViewList.classList.toggle("on", fpView === "list");
  if (fpSortLabel) fpSortLabel.textContent = FP_SORT_LABEL[fpSort];

  if (driveBtn) driveBtn.addEventListener("click", fpOpen);
  if (fpBack) fpBack.addEventListener("click", function () { if (fpHist.length) fpLoad(fpHist.pop()); });
  fpUp.addEventListener("click", function () { if (fpParent) fpNavTo(fpParent); });
  if (fpProjectsBtn) fpProjectsBtn.addEventListener("click", function () { if (fpWorkspace) fpNavTo(fpWorkspace); });
  if (fpViewGrid) fpViewGrid.addEventListener("click", function () { fpSetView("grid"); });
  if (fpViewList) fpViewList.addEventListener("click", function () { fpSetView("list"); });
  if (fpSortBtn) fpSortBtn.addEventListener("click", fpCycleSort);
  if (fpSelAll) fpSelAll.addEventListener("click", fpToggleSelAll);
  $("fpClose").addEventListener("click", fpClose);
  fpOverlay.addEventListener("click", fpClose);
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || !fpModal.classList.contains("open")) return;
    if (fpCtx && !fpCtx.hidden) fpCtxClose(); else fpClose(); // back out one layer at a time
  });
  fpAttach.addEventListener("click", function () {
    var have = {}; pending.forEach(function (a) { if (a.kind === "server") have[a.path] = true; });
    Object.keys(fpSel).forEach(function (p) {
      if (have[p]) return;
      var s = fpSel[p];
      pending.push({ kind: "server", name: s.name, path: p, meta: s.dir ? "folder" : fpDirName(p), size: s.size, dir: !!s.dir });
    });
    fpClose(); renderAttachments();
  });

  if (fpSearch) {
    fpSearch.addEventListener("input", fpOnSearchInput);
    fpSearch.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); if (fpSearchTimer) { clearTimeout(fpSearchTimer); fpSearchTimer = null; } if (fpSearch.value.trim()) fpRunSearch(fpSearch.value.trim()); }
      else if (e.key === "Escape" && fpSearch.value) { e.stopPropagation(); fpLoad(fpCwd); } // clear search, keep modal open
    });
  }
  if (fpSearchClear) fpSearchClear.addEventListener("click", function () { fpLoad(fpCwd); if (fpSearch) fpSearch.focus(); });
  // Download every selected file/folder to the device — one file streams as-is,
  // anything else arrives as a single .zip built server-side.
  if (fpDownloadSel) fpDownloadSel.addEventListener("click", function () {
    var paths = Object.keys(fpSel);
    if (paths.length) fpDownload(paths);
  });

  if (fpCanDir) fpUploadDirInput.webkitdirectory = true;
  if (fpUploadFolderBtn && !fpCanDir) fpUploadFolderBtn.hidden = true;
  if (fpUpload) fpUpload.addEventListener("click", function (e) {
    e.stopPropagation();
    if (fpUpload.disabled) return;
    if (!fpCanDir) { if (fpUploadInput) fpUploadInput.click(); return; } // no folder pick → straight to files
    fpUploadMenuOpen(!!fpUploadMenu && fpUploadMenu.hidden);
  });
  if (fpUploadMenu) fpUploadMenu.addEventListener("click", function (e) { e.stopPropagation(); });
  document.addEventListener("click", function () { fpUploadMenuOpen(false); });
  if (fpUploadFilesBtn) fpUploadFilesBtn.addEventListener("click", function () { fpUploadMenuOpen(false); if (fpUploadInput) fpUploadInput.click(); });
  if (fpUploadFolderBtn) fpUploadFolderBtn.addEventListener("click", function () { fpUploadMenuOpen(false); if (fpUploadDirInput) fpUploadDirInput.click(); });
  if (fpUploadInput) fpUploadInput.addEventListener("change", function () { fpDoUpload(this.files); this.value = ""; });
  if (fpUploadDirInput) fpUploadDirInput.addEventListener("change", function () { fpDoUpload(this.files); this.value = ""; });

  if (fpCtx) {
    fpCtx.addEventListener("click", function (e) { e.stopPropagation(); });
    fpCtx.addEventListener("contextmenu", function (e) { e.preventDefault(); e.stopPropagation(); });
    document.addEventListener("click", fpCtxClose);
    fpList.addEventListener("contextmenu", function (e) {
      if (!fpInVoid(e.target)) return; // on a file/folder — leave the native menu alone
      e.preventDefault();
      fpCtxOpen(e.clientX, e.clientY);
    });
    // Long-press equivalent for touch. Cancelled by moving, lifting early, or
    // scrolling; the firing touchend swallows its own synthetic click so the
    // document handler above doesn't close the menu the instant it appears.
    var fpPressTimer = null, fpPressPt = null, fpPressFired = false;
    function fpPressStop() { if (fpPressTimer) { clearTimeout(fpPressTimer); fpPressTimer = null; } }
    fpList.addEventListener("touchstart", function (e) {
      fpPressStop(); fpPressFired = false;
      if (e.touches.length !== 1 || !fpInVoid(e.target)) return;
      var t = e.touches[0];
      fpPressPt = { x: t.clientX, y: t.clientY };
      fpPressTimer = setTimeout(function () {
        fpPressTimer = null; fpPressFired = true;
        if (navigator.vibrate) { try { navigator.vibrate(12); } catch (err) {} }
        fpCtxOpen(fpPressPt.x, fpPressPt.y);
      }, 480);
    }, { passive: true });
    fpList.addEventListener("touchmove", function (e) {
      if (!fpPressTimer || !fpPressPt) return;
      var t = e.touches[0];
      if (Math.abs(t.clientX - fpPressPt.x) > 10 || Math.abs(t.clientY - fpPressPt.y) > 10) fpPressStop();
    }, { passive: true });
    fpList.addEventListener("touchend", function (e) {
      fpPressStop();
      if (fpPressFired) { fpPressFired = false; e.preventDefault(); }
    });
    fpList.addEventListener("touchcancel", fpPressStop);
    fpList.addEventListener("scroll", fpPressStop, { passive: true });
  }
}
