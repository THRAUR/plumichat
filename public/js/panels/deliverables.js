import { $ } from '../dom.js';
import { fpDownload } from '../files.js';
import { DL_ARROW, GENERIC_FILE_ICON } from '../icons.js';
import { closeModel } from '../models.js';
import { closeMenu } from '../projects.js';
import { basenameOf } from '../render.js';
import { SKILL_ICON, closeSkills } from './skills.js';

/* ---------- Deliverables tray — files PlumiChat built this chat ---------- */
// A per-conversation shelf in the topbar: every file the agent hands back (via
// a plumi:file flag, surfaced by makeFileBox) is registered here so it can be
// re-downloaded later without scrolling back through the whole transcript.
export let filesPicker = $("filesPicker"), filesBtn = $("filesBtn"),
    filesCount = $("filesCount"), filesMenu = $("filesMenu");
export let convFiles = [];
// The one extension helper (the file picker's fpExt was the same thing). Takes a
// path OR a bare name and always answers lowercase.
export function extOf(p) { return ((basenameOf(p).match(/\.([a-z0-9]+)$/i) || [])[1] || "").toLowerCase(); }
export function fileIcon(p) {
  var e = extOf(p).toLowerCase();
  if (e === "pptx" || e === "ppt") return SKILL_ICON.pptx;
  if (e === "docx" || e === "doc") return SKILL_ICON.docx;
  if (e === "xlsx" || e === "xls" || e === "csv") return SKILL_ICON.xlsx;
  if (e === "pdf") return SKILL_ICON.pdf;
  return GENERIC_FILE_ICON;
}
export function renderFilesMenu() {
  filesMenu.innerHTML = "";
  var head = document.createElement("div"); head.className = "sk-head";
  head.textContent = "Files made in this chat"; filesMenu.appendChild(head);
  if (!convFiles.length) {
    var empty = document.createElement("div"); empty.className = "files-empty";
    empty.textContent = "Nothing yet — files PlumiChat builds appear here.";
    filesMenu.appendChild(empty);
    return;
  }
  convFiles.forEach(function (f) {
    var b = document.createElement("button");
    b.className = "file-item"; b.type = "button"; b.setAttribute("role", "menuitem");
    b.innerHTML = '<span class="sk-ic">' + fileIcon(f.path) + '</span>' +
      '<span class="sk-text"><b></b><span class="sk-desc"></span></span>' +
      '<span class="file-dl">' + DL_ARROW + '</span>';
    var nm = (f.name && f.name.trim()) ? f.name.trim() : basenameOf(f.path);
    b.querySelector("b").textContent = nm;
    var ex = extOf(f.path);
    b.querySelector(".sk-desc").textContent = (ex ? ex.toUpperCase() + " · " : "") + "tap to download";
    b.addEventListener("click", function () { fpDownload(f.path); closeFiles(); });
    filesMenu.appendChild(b);
  });
}
export function refreshFilesTray() {
  var n = convFiles.length;
  filesCount.textContent = n > 9 ? "9+" : String(n);
  filesPicker.hidden = (n === 0);
  if (n === 0) closeFiles();
  else if (filesPicker.classList.contains("open")) renderFilesMenu();
}
export function registerDeliverable(f) {
  if (!f || !f.path) return;
  for (var i = 0; i < convFiles.length; i++) if (convFiles[i].path === f.path) return;
  convFiles.push({ path: f.path, name: f.name || "" });
  refreshFilesTray();
}
export function clearConvFiles() { convFiles = []; refreshFilesTray(); }
export function closeFiles() { filesPicker.classList.remove("open"); filesBtn.setAttribute("aria-expanded", "false"); }

export function initDeliverables() {
  filesBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    var open = filesPicker.classList.toggle("open");
    filesBtn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) { closeMenu(); closeModel(); closeSkills(); renderFilesMenu(); }
  });
  refreshFilesTray();
}
