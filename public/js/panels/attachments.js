import { updateSend } from '../composer.js';
import { $, composer, input, toast } from '../dom.js';
import { CHIP_X_SVG } from '../icons.js';
import { pending } from '../state.js';

/* ---------- Attachments (files, pictures, voice) ---------- */
export let attachments = $("attachments");
export let fileInput = $("fileInput");
export let imgInput = $("imgInput");
// The one byte formatter (this and the notepad's npFmtSize were the same thing).
// Coerces, because a missing size used to render "undefined B".
export function fmtSize(b) {
  b = Number(b) || 0;
  if (b < 1024) return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(b < 10240 ? 1 : 0) + " KB";
  return (b / 1048576).toFixed(b < 10485760 ? 1 : 0) + " MB";
}
export function renderAttachments() {
  attachments.innerHTML = "";
  pending.forEach(function (a, i) {
    var chip = document.createElement("div");
    chip.className = "chip" + (a.kind === "img" ? " img" : "");
    var inner = "";
    if (a.kind === "img") inner = '<img class="thumb" src="' + a.url + '" alt="" />';
    else if (a.kind === "voice") inner = '<svg class="cico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"></rect><path d="M5 10a7 7 0 0 0 14 0"></path></svg>';
    else if (a.kind === "server" && a.dir) inner = '<svg class="cico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>';
    else if (a.kind === "server") inner = '<svg class="cico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="14" width="20" height="8" rx="2"></rect><rect x="2" y="2" width="20" height="8" rx="2"></rect><line x1="6" y1="6" x2="6.01" y2="6"></line><line x1="6" y1="18" x2="6.01" y2="18"></line></svg>';
    else inner = '<svg class="cico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>';
    var name = document.createElement("span"); name.className = "cname"; name.textContent = a.name;
    chip.innerHTML = inner;
    chip.appendChild(name);
    // `meta` is a size OR a folder name read off the disk, and a member can name
    // a folder "<img src=x onerror=…>". Interpolating it into HTML ran that
    // script in an admin's session (audit H5) — build the node, never the markup.
    if (a.meta) { var cm = document.createElement("span"); cm.className = "cmeta"; cm.textContent = a.meta; chip.appendChild(cm); }
    var xb = document.createElement("span");
    xb.className = "x"; xb.setAttribute("data-i", i);
    xb.innerHTML = CHIP_X_SVG;   // static markup, no interpolation
    chip.appendChild(xb);
    attachments.appendChild(chip);
  });
  updateSend();
}
// Paste image(s) straight from the clipboard (screenshots, copied pictures).
// Browsers expose them as image/* "file" items on the paste event; a bare
// textarea silently swallows them (it can't render an image), which is exactly
// why pasting felt broken. We intercept, wrap each blob as a uniquely-named
// File, and attach it just like the picture picker — so it rides the SAME
// upload → server path → Read pipeline. Plain-text pastes are left untouched.
export function pastedImageName(type) {
  var sub = (String(type || "").split("/")[1] || "png").split("+")[0]; // png, jpeg, svg…
  if (sub === "jpeg") sub = "jpg";
  return "pasted-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6) + "." + sub;
}
// Drag-and-drop files/images straight onto the composer. A browser normally
// "opens" a dropped file (navigating away from the app), so we swallow drops at
// the window level and let only the composer accept them: images become picture
// attachments (thumbnail), everything else a generic file — both ride the same
// upload → server path → Read pipeline as the pickers.
export function addDroppedFiles(list) {
  var added = 0;
  Array.prototype.forEach.call(list || [], function (f) {
    if (!f) return;
    if (/^image\//.test(f.type)) {
      pending.push({ kind: "img", name: f.name || pastedImageName(f.type), url: URL.createObjectURL(f), file: f });
    } else {
      pending.push({ kind: "file", name: f.name || "file", meta: fmtSize(f.size), file: f });
    }
    added++;
  });
  if (added) { renderAttachments(); toast(added + (added === 1 ? " file" : " files") + " attached"); }
}

export function initAttachments() {
  attachments.addEventListener("click", function (e) {
    var x = e.target.closest(".x");
    if (!x) return;
    var i = +x.getAttribute("data-i");
    if (pending[i] && pending[i].url) URL.revokeObjectURL(pending[i].url);
    pending.splice(i, 1);
    renderAttachments();
  });
  $("fileBtn").addEventListener("click", function () { fileInput.click(); });
  $("imgBtn").addEventListener("click", function () { imgInput.click(); });
  fileInput.addEventListener("change", function () {
    Array.prototype.forEach.call(fileInput.files, function (f) {
      pending.push({ kind: "file", name: f.name, meta: fmtSize(f.size), file: f });
    });
    fileInput.value = ""; renderAttachments();
  });
  imgInput.addEventListener("change", function () {
    Array.prototype.forEach.call(imgInput.files, function (f) {
      pending.push({ kind: "img", name: f.name, url: URL.createObjectURL(f), file: f });
    });
    imgInput.value = ""; renderAttachments();
  });

  input.addEventListener("paste", function (e) {
    var items = (e.clipboardData && e.clipboardData.items) || [];
    var imgs = [], docs = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind !== "file") continue; // plain/rich text paste uses "string" items — leave it alone
      var blob = items[i].getAsFile();
      if (!blob) continue;
      if (/^image\//.test(items[i].type)) imgs.push(blob);
      else docs.push(blob); // a PDF / spreadsheet / doc copied to the clipboard
    }
    if (!imgs.length && !docs.length) return; // ordinary paste — let the browser handle it
    e.preventDefault();       // keep the blob's placeholder text out of the box
    imgs.forEach(function (blob) {
      var name = pastedImageName(blob.type);
      var file;
      try { file = new File([blob], name, { type: blob.type || "image/png" }); }
      catch (_) { file = blob; } // very old browsers: fall back to the raw blob
      pending.push({ kind: "img", name: name, url: URL.createObjectURL(file), file: file });
    });
    docs.forEach(function (blob) {
      var name = (blob.name && String(blob.name)) ||
        ("pasted-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6));
      pending.push({ kind: "file", name: name, meta: fmtSize(blob.size), file: blob });
    });
    renderAttachments();
    var n = imgs.length + docs.length;
    toast(n + (n === 1 ? " file" : " files") + " attached from clipboard");
  });

  ["dragenter", "dragover"].forEach(function (ev) {
    composer.addEventListener(ev, function (e) {
      if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") < 0) return;
      e.preventDefault();
      composer.classList.add("dragover");
    });
  });
  ["dragleave", "dragend"].forEach(function (ev) {
    composer.addEventListener(ev, function (e) {
      // Only clear the highlight when the pointer truly leaves the composer, not
      // when it crosses between the composer's own children (which also fire).
      if (e.target === composer || !composer.contains(e.relatedTarget)) composer.classList.remove("dragover");
    });
  });
  composer.addEventListener("drop", function (e) {
    e.preventDefault();
    composer.classList.remove("dragover");
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addDroppedFiles(e.dataTransfer.files);
  });
  // A drop that misses the composer would otherwise make the page navigate to the
  // dropped file; swallow stray drag/drop everywhere else so that can't happen.
  window.addEventListener("dragover", function (e) { e.preventDefault(); });
  window.addEventListener("drop", function (e) { e.preventDefault(); });
}
