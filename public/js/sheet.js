import { $ } from './dom.js';

/* ---------- One shared sheet (usage & account, deploy) ----------
   Two near-identical modals would be two places to fix every phone bug, so both
   panels borrow this one. `name` is only so a caller can tell which is open. */
export let sheetEl = $("sheet"), sheetOverlayEl = $("sheetOverlay"),
    sheetTitleEl = $("sheetTitle"), sheetBodyEl = $("sheetBody"), sheetCloseBtn = $("sheetClose");
export let sheetOpenName = "";
export function openSheet(name, title, build) {
  if (!sheetEl) return;
  sheetOpenName = name;
  sheetTitleEl.textContent = title;
  sheetBodyEl.innerHTML = "";
  build(sheetBodyEl);
  sheetOverlayEl.classList.add("open");
  sheetEl.classList.add("open");
  sheetEl.setAttribute("aria-hidden", "false");
}
export function closeSheet() {
  if (!sheetEl || !sheetOpenName) return;
  sheetOpenName = "";
  sheetOverlayEl.classList.remove("open");
  sheetEl.classList.remove("open");
  sheetEl.setAttribute("aria-hidden", "true");
}
export function sheetSection(parent, label) {
  var d = document.createElement("div"); d.className = "sheet-sec"; d.textContent = label;
  parent.appendChild(d); return d;
}
export function sheetNote(parent, text) {
  var d = document.createElement("div"); d.className = "sheet-note"; d.textContent = text;
  parent.appendChild(d); return d;
}
export function sheetActions(parent) {
  var d = document.createElement("div"); d.className = "sheet-actions";
  parent.appendChild(d); return d;
}
export function sheetButton(row, label, cls, onClick) {
  var b = document.createElement("button");
  b.type = "button"; b.className = "sheet-btn" + (cls ? " " + cls : "");
  b.textContent = label;
  b.addEventListener("click", function () { onClick(b); });
  row.appendChild(b);
  return b;
}
// A fact card in the .engine-card vocabulary: title, optional pill, label/value rows.
export function factCard(parent, title, tag, rows, cls) {
  var card = document.createElement("div");
  card.className = "engine-card" + (cls ? " " + cls : "");
  var head = document.createElement("div"); head.className = "engine-card-head";
  var h = document.createElement("span"); h.textContent = title; head.appendChild(h);
  if (tag) { var t = document.createElement("span"); t.className = "engine-tag"; t.textContent = tag; head.appendChild(t); }
  card.appendChild(head);
  rows.forEach(function (r) {
    var row = document.createElement("div"); row.className = "engine-row" + (r.changed ? " changed" : "");
    var l = document.createElement("span"); l.className = "engine-row-label"; l.textContent = r.label;
    var v = document.createElement("span"); v.className = "engine-row-val";
    v.textContent = (r.value === null || r.value === undefined || r.value === "") ? "—" : String(r.value);
    row.appendChild(l); row.appendChild(v); card.appendChild(row);
  });
  parent.appendChild(card);
  return card;
}

export function initSheet() {
  if (sheetCloseBtn) sheetCloseBtn.addEventListener("click", closeSheet);
  if (sheetOverlayEl) sheetOverlayEl.addEventListener("click", closeSheet);
}

/* ---------- Ask before you act, in PlumiChat's own vocabulary ----------
   window.confirm/prompt draw the BROWSER's dialog. Inside a home-screen web app
   that reads as "127.0.0.1 says…" over the top of the design, it cannot be styled
   or dismissed by the sheet's own overlay, and prompt() is outright suppressed in
   some standalone contexts — which would have made "Save to file" simply do
   nothing. Both take a callback rather than returning, because a sheet is async
   where a native dialog blocks. */
export function confirmSheet(opts) {
  var title = opts.title || "Are you sure?";
  openSheet("confirm", title, function (box) {
    if (opts.message) sheetNote(box, opts.message);
    var row = sheetActions(box);
    sheetButton(row, opts.confirmLabel || "Confirm", opts.danger ? "danger" : "go", function () {
      closeSheet();
      opts.onConfirm();
    });
    sheetButton(row, opts.cancelLabel || "Cancel", "", closeSheet);
  });
}
export function promptSheet(opts) {
  openSheet("prompt", opts.title || "", function (box) {
    if (opts.message) sheetNote(box, opts.message);
    var field = document.createElement("input");
    field.className = "sheet-input";
    field.type = "text";
    field.value = opts.value || "";
    if (opts.placeholder) field.placeholder = opts.placeholder;
    field.autocomplete = "off";
    field.autocapitalize = "off";
    field.spellcheck = false;
    field.enterkeyhint = "done";
    box.appendChild(field);
    var submit = function () {
      var v = field.value.trim();
      if (!v) return;
      closeSheet();
      opts.onSubmit(v);
    };
    field.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); submit(); } });
    var row = sheetActions(box);
    sheetButton(row, opts.submitLabel || "Save", "go", submit);
    sheetButton(row, "Cancel", "", closeSheet);
    // Focus after the sheet has finished animating in, or iOS drops the keyboard.
    requestAnimationFrame(function () { try { field.focus(); field.select(); } catch (e) {} });
  });
}
