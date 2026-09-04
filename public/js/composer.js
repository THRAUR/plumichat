/* PlumiChat — the composer: the send/queue/stop button, the auto-growing textarea and
   submit(). Kept out of app.js because several modules call updateSend(), and the
   entry module is the one file nothing may import. */

import { renderAttachments } from './panels/attachments.js';
import { syncCmdWarn } from './panels/commands.js';
import { reflectContext } from './panels/context.js';
import { composer, input, sendBtn } from './dom.js';
import { QUEUE_ICON, SEND_ICON, STOP_ICON } from './icons.js';
import { updatePaneState } from './library.js';
import { buildReplyPrompt, clearPendingQuote, pendingQuote, setPendingQuote } from './quote.js';
import { activeStreams, pending, reattachTries, setPending, viewKey } from './state.js';
import { send, stopCurrent } from './stream.js';
import { enqueueMessage, renderQueued } from './tray.js';
import { recording, stopRec } from './panels/voice.js';

/* ---------- Composer ---------- */
// The composer button has three jobs now: Send (idle), Queue (a turn is running
// and you have typed something) and Stop (a turn is running and you have not).
// Stop also lives permanently in the agents-tray head, so it is never more than
// one tap away even while the button is busy queueing.
export let sendMode = "";
export function setSendMode(mode) {
  if (sendMode === mode) return;
  sendMode = mode;
  sendBtn.classList.toggle("stop", mode === "stop");
  sendBtn.classList.toggle("queue", mode === "queue");
  sendBtn.innerHTML = mode === "stop" ? STOP_ICON : mode === "queue" ? QUEUE_ICON : SEND_ICON;
  sendBtn.setAttribute("aria-label", mode === "stop" ? "Stop" : mode === "queue" ? "Queue this message" : "Send");
  sendBtn.title = mode === "stop" ? "Stop"
    : mode === "queue" ? "Send it as soon as this turn ends" : "Send";
}
export function updateSend() {
  // A conversation whose pipe dropped is still RUNNING on the server while we
  // retry, so it counts as streaming — sending there would only earn a 409.
  var streaming = !!activeStreams[viewKey] || !!reattachTries[viewKey];
  var hasText = input.value.trim().length > 0 || pending.length > 0 || !!pendingQuote;
  if (streaming && hasText) { setSendMode("queue"); sendBtn.disabled = false; }
  else if (streaming) { setSendMode("stop"); sendBtn.disabled = false; }
  else { setSendMode("send"); sendBtn.disabled = !hasText; }
  renderQueued();
  updatePaneState(); // updateSend runs on every stream start/end — piggyback
  reflectContext();  // …and on every view change, which is what the ring follows
}
export function autoGrow() {
  input.style.height = "auto";
  // Cap scales with the display (matches the CSS max-height: max(140px, 28vh)).
  var cap = Math.max(140, Math.round(window.innerHeight * 0.28));
  input.style.height = Math.min(input.scrollHeight, cap) + "px";
  updateSend();
  // autoGrow is the one call every PROGRAMMATIC change to the box goes through
  // (send clearing it, a skill starter, a picked command), so the unknown-command
  // warning is re-checked here as well as on the input event.
  syncCmdWarn();
}
/* Enter: send, or newline? The shell script in index.html owns that decision —
   a phone keyboard has no Shift+Enter, so on a coarse pointer Enter HAS to insert
   a newline and the send button becomes the only way to send. It publishes the
   answer as html[data-enter-mode] before app.js loads (safe to read at init) and
   re-fires "plumi-enter-mode" whenever the pointer type changes live, which
   really happens: docking an iPad to a keyboard flips it mid-conversation.
   In newline mode Cmd/Ctrl+Enter still sends, because a docked keyboard expects
   to be able to. */
export let enterMode = document.documentElement.dataset.enterMode || "send";
export function submit() {
  var text = input.value.trim();
  if (!text && pending.length === 0 && !pendingQuote) return;
  if (recording) stopRec();
  var atts = pending.slice();
  // Everything the composer is about to be emptied of. A send can still fail —
  // an upload error, a 409 "already running", a 400 — and losing a long typed
  // message to that was the app's most infuriating small bug. The notepad
  // already restores on failure; do the same here.
  var savedText = input.value;
  var savedQuote = pendingQuote;
  setPending([]);
  renderAttachments();
  var wire = buildReplyPrompt(text);   // fold in a quoted passage, if any
  clearPendingQuote();
  input.value = ""; autoGrow(); input.focus();
  // A turn is already running in this conversation: park the message instead of
  // refusing it. It sends itself when the turn ends (flushQueued).
  if (activeStreams[viewKey] || reattachTries[viewKey]) { enqueueMessage(viewKey, wire, atts); return; }
  send(wire, atts, function () {
    // Don't clobber a new message they started typing while the send was failing.
    if (!input.value.trim()) { input.value = savedText; autoGrow(); }
    setPending(atts.concat(pending));
    renderAttachments();
    if (savedQuote && !pendingQuote) setPendingQuote(savedQuote);
    updateSend();
  });
}

export function initComposer() {
  input.addEventListener("input", autoGrow);
  window.addEventListener("plumi-enter-mode", function (e) {
    enterMode = (e && e.detail) || "send";
  });
  input.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" || e.isComposing) return;
    if (e.shiftKey) return;                                     // explicit newline, both modes
    if (enterMode === "newline" && !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault(); submit();
  });
  composer.addEventListener("submit", function (e) { e.preventDefault(); submit(); });
  // While a turn is in flight with an empty composer the button acts as Stop; with
  // something typed it queues (see updateSend), which goes through submit().
  sendBtn.addEventListener("click", function (e) {
    if (sendMode === "stop") { e.preventDefault(); stopCurrent(); }
  });
}
