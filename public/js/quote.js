import { updateSend } from './composer.js';
import { $, input, messages } from './dom.js';
import { QX_ICON, REPLY_ICON } from './icons.js';

/* ---------- Reply to a highlighted passage (quote) ----------
   Highlight any text inside an assistant message and a floating "Reply" button
   appears next to it. Tapping it quotes exactly that passage into the composer,
   so a terse follow-up like "this one" is unambiguous to Claude. The quote rides
   along as a leading markdown blockquote in the prompt; addUser/splitQuote render
   it back as a styled quote in the echoed bubble and on history replay. */
export let pendingQuote = null;                 // captured passage awaiting a reply, or null
export let composerQuote = $("composerQuote");
// Peel a leading reply-blockquote off a user message: contiguous "> " lines, an
// optional blank separator, then the actual message. Plain messages pass through.
export function splitQuote(text) {
  if (!text || text.charAt(0) !== ">") return { quote: "", body: text || "" };
  var lines = text.split("\n"), q = [], i = 0;
  while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(lines[i].replace(/^>\s?/, "")); i++; }
  while (i < lines.length && lines[i].trim() === "") i++;   // drop the blank separator
  return { quote: q.join("\n"), body: lines.slice(i).join("\n") };
}
// Fold a pending quote + the typed message into the prompt Claude receives.
export function buildReplyPrompt(text) {
  if (!pendingQuote) return text;
  var q = pendingQuote.split("\n").map(function (l) { return "> " + l; }).join("\n");
  return text ? (q + "\n\n" + text) : q;
}
export function renderComposerQuote() {
  if (!composerQuote) return;
  composerQuote.innerHTML = "";
  if (!pendingQuote) { composerQuote.hidden = true; updateSend(); return; }
  composerQuote.hidden = false;
  var ic = document.createElement("span"); ic.className = "cq-ic"; ic.innerHTML = REPLY_ICON;
  var body = document.createElement("span"); body.className = "cq-body";
  var lbl = document.createElement("span"); lbl.className = "cq-label"; lbl.textContent = "Replying to";
  var txt = document.createElement("span"); txt.className = "cq-text";
  txt.textContent = pendingQuote.replace(/\s+/g, " ").trim();
  body.appendChild(lbl); body.appendChild(txt);
  var x = document.createElement("button");
  x.type = "button"; x.className = "cq-x"; x.setAttribute("aria-label", "Remove quote");
  x.innerHTML = QX_ICON;
  x.addEventListener("click", clearPendingQuote);
  composerQuote.appendChild(ic); composerQuote.appendChild(body); composerQuote.appendChild(x);
  updateSend();
}
export function setPendingQuote(text) {
  text = (text || "").replace(/^\s+|\s+$/g, "");
  if (!text) return;
  pendingQuote = text;
  renderComposerQuote();
  input.focus();
}
export function clearPendingQuote() { pendingQuote = null; renderComposerQuote(); }

// The floating "Reply" pill, parked on <body> and moved next to the selection.
export let replyFab = document.createElement("button");
export let fabText = "";                        // selection captured when the pill was shown
export let fabTimer = null, dragging = false;

export function hideReplyFab() { replyFab.classList.remove("show"); fabText = ""; }

// The assistant .row that fully contains the current selection, else null —
// so the pill only offers to quote one of Claude's own passages.
export function assistantRowOfSelection(sel) {
  if (!sel || !sel.rangeCount) return null;
  var node = sel.getRangeAt(0).commonAncestorContainer;
  if (node && node.nodeType === 3) node = node.parentNode;
  var row = node && node.closest ? node.closest(".row") : null;
  if (!row || !row.classList.contains("assistant") || !messages.contains(row)) return null;
  return row;
}
export function positionReplyFab(range) {
  var rect = range.getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) { hideReplyFab(); return; }
  replyFab.classList.add("show");        // show first so width/height measure true
  var bw = replyFab.offsetWidth, bh = replyFab.offsetHeight;
  var vw = document.documentElement.clientWidth;
  var left = Math.max(6, Math.min(rect.left + rect.width / 2 - bw / 2, vw - bw - 6));
  var top = rect.top - bh - 8;
  if (top < 6) top = rect.bottom + 8;    // no room above the passage → sit below it
  replyFab.style.left = left + "px";
  replyFab.style.top = top + "px";
}
export function evaluateSelection() {
  var sel = window.getSelection && window.getSelection();
  if (!sel || sel.isCollapsed) { hideReplyFab(); return; }
  var raw = sel.toString();
  if (!raw.trim() || !assistantRowOfSelection(sel)) { hideReplyFab(); return; }
  fabText = raw;
  positionReplyFab(sel.getRangeAt(0));
}
export function scheduleSelCheck(delay) {
  if (fabTimer) clearTimeout(fabTimer);
  fabTimer = setTimeout(evaluateSelection, delay == null ? 140 : delay);
}

export function initQuote() {
  replyFab.type = "button";
  replyFab.className = "reply-fab";
  replyFab.setAttribute("aria-label", "Reply to selection");
  replyFab.innerHTML = REPLY_ICON + "<span>Reply</span>";
  document.body.appendChild(replyFab);
  // Desktop: a drag-select ends on mouseup. Mobile: the selection handles emit
  // selectionchange. Either way we settle, then show the pill by the passage.
  messages.addEventListener("mousedown", function () { dragging = true; hideReplyFab(); });
  document.addEventListener("mouseup", function () { dragging = false; scheduleSelCheck(0); });
  document.addEventListener("selectionchange", function () {
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) { hideReplyFab(); return; }
    if (!dragging) scheduleSelCheck();     // wait for a pause; mouseup drives desktop
  });
  // The pill is viewport-fixed, so scrolling/resizing would strand it.
  messages.addEventListener("scroll", hideReplyFab, { passive: true });
  window.addEventListener("resize", hideReplyFab);

  // Keep the selection alive when pressing the pill (don't steal focus/collapse it).
  replyFab.addEventListener("mousedown", function (e) { e.preventDefault(); });
  replyFab.addEventListener("click", function (e) {
    e.preventDefault();
    var t = fabText || (window.getSelection ? window.getSelection().toString() : "");
    hideReplyFab();
    try { var s = window.getSelection(); if (s) s.removeAllRanges(); } catch (_) {}
    setPendingQuote(t);
  });
}
