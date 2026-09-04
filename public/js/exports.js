import { apiFetch } from './api.js';
import { capabilities } from "./capabilities.js";
import { toast } from './dom.js';
import { IOS_APP, IOS_HANDOFF, blobAsFile, shareFile } from './handoff.js';
import { DL_ICON } from './icons.js';
import { mdNode } from './render.js';

// --- Download an answer as PDF / Word / PowerPoint / Excel -------------------
// PDF is produced in the browser: we print the rendered answer, so Traditional
// Chinese (and any other script) uses the device's own fonts and looks perfect.
// The Office formats are built server-side (pandoc for Word/PowerPoint, a
// table->sheet converter for Excel) and streamed back as a file download.
export let DL_ITEMS = [
  { fmt: "pdf",  label: "PDF" },
  { fmt: "docx", label: "Word (.docx)" },
  { fmt: "pptx", label: "PowerPoint (.pptx)" },
  { fmt: "xlsx", label: "Excel (.xlsx)" }
];
export let DL_EXT = { docx: "docx", pptx: "pptx", xlsx: "xlsx" };

// A friendly file name from the answer's first heading or first non-empty line.
export function deriveExportName(text) {
  var s = String(text || "");
  var m = s.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/m);
  var line = m ? m[1] : "";
  if (!line) { var first = s.split("\n").find(function (x) { return x.trim(); }); line = first || "PlumiChat answer"; }
  line = line.replace(/[*_`>#\[\]]/g, "").replace(/\s+/g, " ").trim();
  return line.slice(0, 60) || "PlumiChat answer";
}

// Trim a free-text label (e.g. an AI-supplied document name) to a safe filename base.
export function sanitizeBase(s) {
  return String(s || "").replace(/[*_`>#\[\]\/\\]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
}

// An answer may carry a hidden flag the AI emits when it produced a downloadable
// document: <!--plumi:download format=pptx name="..."-->. Pull every such flag
// out, returning the cleaned text (flags removed, so Copy/Save/export never leak
// them) plus the list of documents to render a "ready to download" box for. The
// flag is an HTML comment, so an un-refreshed client simply renders nothing for it.
export let DL_OK = { pdf: 1, docx: 1, pptx: 1, xlsx: 1 };

// Word and PowerPoint are produced by pandoc, which is not installed everywhere.
// Drop them from the offered formats when the server says it has no pandoc, so the
// box never shows a button whose only outcome is an error.
//
// PDF and Excel are deliberately NOT gated: .xlsx is built here (yazl, no external
// tool) and PDF falls back to the browser's own print pipeline, so both work on a
// machine with nothing installed.
capabilities().then(function (caps) {
  if (!caps) return;
  if (caps.exportDocx && !caps.exportDocx.available) DL_OK.docx = 0;
  if (caps.exportPptx && !caps.exportPptx.available) DL_OK.pptx = 0;
}).catch(function () { /* leave every format on */ });
export function extractDownloadFlags(text) {
  var docs = [];
  var files = [];
  var clean = String(text || "")
    .replace(/<!--\s*plumi:download\b([^>]*?)-->/gi, function (_, attrs) {
      var fm = String((attrs.match(/\bformat\s*=\s*["']?([a-z]+)/i) || [])[1] || "").toLowerCase();
      var nm = (attrs.match(/\bname\s*=\s*"([^"]*)"/i) || attrs.match(/\bname\s*=\s*'([^']*)'/i) || [])[1] || "";
      if (DL_OK[fm]) docs.push({ format: fm, name: String(nm).trim() });
      return "";
    })
    // A REAL file the AI built on disk (e.g. a deck from the document Skills):
    // <!--plumi:file path="/abs/file.pptx" name="Short Title"-->. Streamed as-is
    // via /api/download (which re-checks containment server-side), not re-derived
    // from the answer's markdown the way the plumi:download box is.
    .replace(/<!--\s*plumi:file\b([^>]*?)-->/gi, function (_, attrs) {
      var pth = (attrs.match(/\bpath\s*=\s*"([^"]*)"/i) || attrs.match(/\bpath\s*=\s*'([^']*)'/i) || [])[1] || "";
      var nm = (attrs.match(/\bname\s*=\s*"([^"]*)"/i) || attrs.match(/\bname\s*=\s*'([^']*)'/i) || [])[1] || "";
      pth = String(pth).trim();
      if (pth) files.push({ path: pth, name: String(nm).trim() });
      return "";
    });
  clean = clean.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { clean: clean, docs: docs, files: files };
}

// Print just this answer to PDF via the browser's own "Save as PDF". A hidden
// print root holds a titled copy of the rendered markdown; @media print shows
// only it. No popup (so nothing to block) and no server round-trip.
export function printAnswerAsPdf(text) {
  var root = document.getElementById("printRoot");
  if (!root) { root = document.createElement("div"); root.id = "printRoot"; root.className = "print-root"; document.body.appendChild(root); }
  root.innerHTML = "";
  var head = document.createElement("div"); head.className = "print-head";
  var ttl = document.createElement("div"); ttl.className = "print-title"; ttl.textContent = deriveExportName(text);
  var dt = document.createElement("div"); dt.className = "print-date"; dt.textContent = new Date().toLocaleString();
  head.appendChild(ttl); head.appendChild(dt); root.appendChild(head);
  root.appendChild(mdNode(text));
  function cleanup() { root.innerHTML = ""; window.removeEventListener("afterprint", cleanup); }
  window.addEventListener("afterprint", cleanup);
  setTimeout(function () { window.print(); }, 60);
}

// Printing stays the default: it uses the device's own fonts, which is what keeps
// Traditional Chinese looking right, and costs the server nothing. But an iOS
// home-screen web app has NO print UI, so window.print() is a silent no-op there —
// those get the PDF rendered on the box and handed over like any other file.
export function saveAnswerAsPdf(text, btn, nameOverride) {
  if (IOS_APP) return exportAnswerFile("pdf", text, btn, nameOverride);
  printAnswerAsPdf(text);
}

// POST the answer's markdown to the server, get the converted file back, save it.
// nameOverride (optional) lets an AI-flagged document set its own file name.
export function exportAnswerFile(format, text, btn, nameOverride) {
  var base = sanitizeBase(nameOverride) || deriveExportName(text);
  if (btn) btn.classList.add("busy");
  function done() { if (btn) btn.classList.remove("busy"); }
  apiFetch("/api/export", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ format: format, markdown: text, filename: base })
  }).then(function (r) {
    if (!r.ok) return r.json().catch(function () { return {}; }).then(function (d) { throw new Error(d.error || "Export failed"); });
    return r.blob();
  }).then(function (blob) {
    var fname = base + "." + (DL_EXT[format] || format);
    if (IOS_HANDOFF) { shareFile(blobAsFile(blob, fname)); done(); return; }
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a"); a.href = url; a.download = fname;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
    toast("Downloaded " + fname); done();
  }).catch(function (e) { toast(e.message || "Export failed", true); done(); });
}

export function closeDlMenus(except) {
  var open = document.querySelectorAll(".dl-menu:not([hidden])");
  Array.prototype.forEach.call(open, function (m) { if (m !== except) m.setAttribute("hidden", ""); });
}
// The "Download" button + its little format menu, appended to an answer's actions.
export function makeDownloadMenu(text) {
  var wrap = document.createElement("div"); wrap.className = "dl-wrap";
  var btn = document.createElement("button"); btn.type = "button"; btn.className = "save-btn dl-btn";
  btn.innerHTML = DL_ICON + "<span>Download</span>";
  var menu = document.createElement("div"); menu.className = "dl-menu"; menu.setAttribute("hidden", "");
  DL_ITEMS.forEach(function (it) {
    var b = document.createElement("button"); b.type = "button"; b.textContent = it.label;
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      menu.setAttribute("hidden", "");
      if (it.fmt === "pdf") saveAnswerAsPdf(text, btn);
      else exportAnswerFile(it.fmt, text, btn);
    });
    menu.appendChild(b);
  });
  btn.addEventListener("click", function (e) {
    e.stopPropagation();
    var willOpen = menu.hasAttribute("hidden");
    closeDlMenus(menu);
    if (willOpen) menu.removeAttribute("hidden"); else menu.setAttribute("hidden", "");
  });
  wrap.appendChild(btn); wrap.appendChild(menu);
  return wrap;
}

// Detect a GitHub-flavoured markdown table (a pipe row followed by a --- separator
// line), mirroring the server's parser closely enough to know whether Excel applies.
export function hasMarkdownTable(md) {
  var lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
  var sep = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
  for (var i = 0; i < lines.length - 1; i++) {
    if (lines[i].indexOf("|") !== -1 && sep.test(lines[i + 1])) return true;
  }
  return false;
}

// Which formats make sense for this answer. PDF and Word fit any prose; Excel only
// when there's a table; PowerPoint only with slide structure (2+ headings) or when
// the AI explicitly flagged a deck. The flagged format always leads. This is why a
// spreadsheet never offers PowerPoint and a deck never offers Excel.
export function compatibleFormats(primary, text) {
  var clean = String(text || "");
  var headings = (clean.match(/^\s{0,3}#{1,6}\s+\S/gm) || []).length;
  var hasTable = hasMarkdownTable(clean);
  var set = [];
  function add(f) { if (DL_OK[f] && set.indexOf(f) === -1) set.push(f); }
  if (primary) add(primary);                            // what the AI made — first
  add("pdf");                                           // anything prints to PDF
  add("docx");                                          // any markdown -> Word
  if (hasTable) add("xlsx");                            // Excel needs a table
  if (headings >= 2 || primary === "pptx") add("pptx"); // slides need structure
  var order = ["pdf", "docx", "pptx", "xlsx"];
  var rest = order.filter(function (f) { return f !== primary && set.indexOf(f) !== -1; });
  return (primary && DL_OK[primary]) ? [primary].concat(rest) : rest;
}

// A prominent box shown under an answer when the AI flagged a downloadable document.
// It offers every compatible format (the flagged one highlighted); PDF prints
// client-side, the Office formats hit /api/export.
export let DL_SHORT = { pdf: "PDF", docx: "Word", pptx: "PowerPoint", xlsx: "Excel" };
export function makeDownloadBox(primaryFormat, name, text) {
  var primary = String(primaryFormat || "").toLowerCase();
  var fname = (name && name.trim()) ? name.trim() : deriveExportName(text);
  var formats = compatibleFormats(primary, text);

  var box = document.createElement("div"); box.className = "dl-box";
  var head = document.createElement("div"); head.className = "dl-box-head";
  var icon = document.createElement("span"); icon.className = "dl-box-icon"; icon.innerHTML = DL_ICON;
  var info = document.createElement("div"); info.className = "dl-box-info";
  var ttl = document.createElement("div"); ttl.className = "dl-box-title"; ttl.textContent = fname;
  var sub = document.createElement("div"); sub.className = "dl-box-sub"; sub.textContent = "Ready to download";
  info.appendChild(ttl); info.appendChild(sub);
  head.appendChild(icon); head.appendChild(info);

  var actions = document.createElement("div"); actions.className = "dl-box-actions";
  formats.forEach(function (f) {
    var b = document.createElement("button"); b.type = "button";
    b.className = "dl-box-fmt" + (f === primary ? " primary" : "");
    b.textContent = DL_SHORT[f] || f;
    b.addEventListener("click", function () {
      if (f === "pdf") saveAnswerAsPdf(text, b, name);
      else exportAnswerFile(f, text, b, name);
    });
    actions.appendChild(b);
  });

  box.appendChild(head); box.appendChild(actions);
  return box;
}

export function initDownloadMenus() {
  document.addEventListener("click", function (e) {
    if (!e.target.closest || !e.target.closest(".dl-wrap")) closeDlMenus(null);
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeDlMenus(null); });
}
