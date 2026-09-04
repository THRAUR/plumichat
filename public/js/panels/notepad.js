import { apiFetch } from '../api.js';
import { fmtSize } from './attachments.js';
import { makeCopyBtn } from '../cards.js';
import { $, toast } from '../dom.js';
import { iosifyLink } from '../handoff.js';
import { NP_DL_ICON, NP_FILE_ICON, NP_TRASH_ICON } from '../icons.js';
import { closeDrawer } from '../library.js';
import { confirmSheet } from '../sheet.js';

/* ===================== Notepad: synced scratchpad ======================= */
// A per-user pad of text "clips" and small file drops that syncs across the
// signed-in user's devices — paste a password on the phone, tap Copy on the
// computer. Live sync is an SSE stream (/api/notepad/stream); we also pull a
// snapshot on open so it's never stale before the first event lands.
export let notepadNav = $("notepadNav");
export let npModal = $("npModal"), npOverlay = $("npOverlay"), npList = $("npList");
export let npInput = $("npInput"), npAdd = $("npAdd"), npAttach = $("npAttach");
export let npFile = $("npFile"), npClear = $("npClear"), npSync = $("npSync");
export let npStream = null, npClips = [], npOpen = false, npDragDepth = 0;

export function npSetSync(live) {
  if (!npSync) return;
  npSync.setAttribute("data-state", live ? "on" : "off");
  npSync.textContent = live ? "Synced" : "Offline";
}
export function npAddState() { npAdd.disabled = !npInput.value.trim(); }

export function openNotepad() {
  npOpen = true;
  closeDrawer();
  npOverlay.classList.add("open"); npModal.classList.add("open");
  npModal.setAttribute("aria-hidden", "false");
  npConnect();
  setTimeout(function () { try { npInput.focus(); } catch (e) {} }, 60);
}
export function closeNotepad() {
  npOpen = false;
  npOverlay.classList.remove("open"); npModal.classList.remove("open");
  npModal.setAttribute("aria-hidden", "true");
  npModal.classList.remove("dragging"); npDragDepth = 0;
  npDisconnect();
}

// Open a live stream. EventSource auto-reconnects on transient drops, so we only
// repaint the sync badge on its events; the server sends a snapshot immediately.
export function npConnect() {
  npPull();
  if (npStream) return;
  try {
    npStream = new EventSource("/api/notepad/stream");
    npStream.onmessage = function (e) {
      if (!e.data) return;
      var msg; try { msg = JSON.parse(e.data); } catch (err) { return; }
      if (msg && msg.type === "clips") { npClips = msg.clips || []; npRender(); npSetSync(true); }
    };
    npStream.onopen = function () { npSetSync(true); };
    npStream.onerror = function () { npSetSync(false); };
  } catch (e) { npSetSync(false); }
}
export function npDisconnect() {
  if (npStream) { try { npStream.close(); } catch (e) {} npStream = null; }
  npSetSync(false);
}

// Snapshot fetch — the source of truth on open, and the fallback whenever the
// live stream isn't connected.
export function npPull() {
  apiFetch("/api/notepad").then(function (r) { return r.json(); }).then(function (d) {
    if (d && d.clips) { npClips = d.clips; npRender(); }
  }).catch(function () {});
}
export function npRefresh() { if (!npStream) npPull(); } // when live, the broadcast repaints us

export function npRender() {
  npList.innerHTML = "";
  if (npClear) npClear.hidden = !npClips.length;
  if (!npClips.length) {
    var empty = document.createElement("div");
    empty.className = "np-empty";
    empty.textContent = "No notes yet. Add one above, or drop a file — it appears on your other devices.";
    npList.appendChild(empty);
    return;
  }
  npClips.forEach(function (clip) { npList.appendChild(npRow(clip)); });
}

export function npRow(clip) {
  var row = document.createElement("div");
  row.className = "np-clip " + (clip.kind === "file" ? "is-file" : "is-text");

  var main = document.createElement("div");
  main.className = "np-clip-main";

  if (clip.kind === "file") {
    var link = document.createElement("a");
    link.className = "np-filerow";
    link.href = "/api/notepad/file/" + encodeURIComponent(clip.id);
    link.setAttribute("download", clip.name || "file");
    link.innerHTML = '<span class="np-fileic">' + NP_FILE_ICON + "</span>";
    var fmeta = document.createElement("span"); fmeta.className = "np-filemeta";
    var fname = document.createElement("span"); fname.className = "np-filename"; fname.textContent = clip.name || "file";
    var fsize = document.createElement("span"); fsize.className = "np-filesize"; fsize.textContent = fmtSize(clip.size) + " · tap to download";
    fmeta.appendChild(fname); fmeta.appendChild(fsize);
    link.appendChild(fmeta);
    main.appendChild(iosifyLink(link, clip.name || "file"));
  } else {
    var txt = document.createElement("div");
    txt.className = "np-text";
    txt.textContent = clip.text || "";
    main.appendChild(txt);
  }

  var time = document.createElement("div");
  time.className = "np-clip-time";
  time.textContent = relTime(clip.updatedAt || clip.createdAt);
  main.appendChild(time);
  row.appendChild(main);

  var actions = document.createElement("div");
  actions.className = "np-clip-actions";
  if (clip.kind === "text") {
    actions.appendChild(makeCopyBtn(function () { return clip.text || ""; }, "np-act np-copy", "Copy"));
  } else {
    var dl = document.createElement("a");
    dl.className = "np-act np-dl";
    dl.href = "/api/notepad/file/" + encodeURIComponent(clip.id);
    dl.setAttribute("download", clip.name || "file");
    dl.title = "Download"; dl.setAttribute("aria-label", "Download");
    dl.innerHTML = NP_DL_ICON + "<span>Get</span>";
    actions.appendChild(iosifyLink(dl, clip.name || "file"));
  }
  var del = document.createElement("button");
  del.type = "button"; del.className = "np-act np-del";
  del.title = "Delete"; del.setAttribute("aria-label", "Delete");
  del.innerHTML = NP_TRASH_ICON;
  del.addEventListener("click", function () { npDelete(clip.id); });
  actions.appendChild(del);
  row.appendChild(actions);
  return row;
}

export function npReqJSON(url, opts) {
  return apiFetch(url, opts).then(function (r) {
    return r.text().then(function (t) {
      var d = {}; try { d = JSON.parse(t); } catch (e) {}
      if (!r.ok) throw new Error(d.error || ("Request failed (" + r.status + ")"));
      return d;
    });
  });
}

export function npAddText() {
  var text = npInput.value;
  if (!text.trim()) return;
  npInput.value = ""; npAddState();
  npReqJSON("/api/notepad", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: text })
  }).then(npRefresh).catch(function (e) {
    npInput.value = text; npAddState(); // restore so nothing is lost
    toast(e.message || "Couldn't add note", true);
  });
}
export function npDelete(id) {
  npReqJSON("/api/notepad/" + encodeURIComponent(id), { method: "DELETE" })
    .then(npRefresh).catch(function (e) { toast(e.message || "Couldn't delete", true); });
}

export function npUpload(fileList) {
  var files = Array.prototype.slice.call(fileList || []).filter(Boolean);
  var LIMIT = 30 * 1024 * 1024;
  if (files.some(function (f) { return f.size > LIMIT; })) toast("Files over 30 MB were skipped", true);
  files = files.filter(function (f) { return f.size <= LIMIT; });
  if (!files.length) return;
  toast(files.length === 1 ? "Adding file…" : "Adding " + files.length + " files…");
  var chain = Promise.resolve();
  files.forEach(function (f) {
    chain = chain.then(function () {
      return npReqJSON("/api/notepad/file?name=" + encodeURIComponent(f.name || "file"), {
        method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: f
      });
    });
  });
  chain.then(npRefresh).catch(function (e) { toast(e.message || "Upload failed", true); });
}

// Relative "how long ago" — shared with the terminal's live-shell card, which
// used to carry its own near-identical copy.
export function relTime(ts) {
  ts = Number(ts) || 0;
  if (!ts) return "";
  var s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  var d = new Date(ts);
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " +
    d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function npHasFiles(e) {
  return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") >= 0;
}

export function initNotepad() {
  if (notepadNav) notepadNav.addEventListener("click", openNotepad);
  $("npClose").addEventListener("click", closeNotepad);
  npOverlay.addEventListener("click", closeNotepad);
  npInput.addEventListener("input", npAddState);
  npInput.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); npAddText(); }
  });
  npAdd.addEventListener("click", npAddText);
  npAttach.addEventListener("click", function () { npFile.click(); });
  npFile.addEventListener("change", function () { npUpload(npFile.files); npFile.value = ""; });
  if (npClear) npClear.addEventListener("click", function () {
    if (!npClips.length) return;
    confirmSheet({
      title: "Clear the notepad?",
      message: "Deletes every note and file in it. This cannot be undone.",
      confirmLabel: "Delete everything",
      danger: true,
      onConfirm: function () {
        npReqJSON("/api/notepad/clear", { method: "POST" }).then(npRefresh)
          .catch(function (e) { toast(e.message || "Couldn't clear", true); });
      },
    });
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && npOpen) closeNotepad(); });

  // Drag a file anywhere onto the open panel to add it. A depth counter keeps the
  // highlight steady as the pointer crosses child elements.
  npModal.addEventListener("dragenter", function (e) {
    if (!npHasFiles(e)) return;
    e.preventDefault(); npDragDepth++; npModal.classList.add("dragging");
  });
  npModal.addEventListener("dragover", function (e) { if (npHasFiles(e)) e.preventDefault(); });
  npModal.addEventListener("dragleave", function () {
    npDragDepth = Math.max(0, npDragDepth - 1);
    if (!npDragDepth) npModal.classList.remove("dragging");
  });
  npModal.addEventListener("drop", function (e) {
    e.preventDefault(); npDragDepth = 0; npModal.classList.remove("dragging");
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) npUpload(e.dataTransfer.files);
  });
}
