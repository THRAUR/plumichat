/* PlumiChat — the background-agents tray and the queue of messages waiting for the
   running turn to end. Both render from tasks.js's accessors; neither owns state. */

import { renderAttachments } from './panels/attachments.js';
import { autoGrow, updateSend } from './composer.js';
import { $, input, toast } from './dom.js';
import { TRAY_CHEV } from './icons.js';
import { activeStreams, pending, reattachTries, setPending, viewKey } from './state.js';
import { send, stopCurrent } from './stream.js';
import { onTasksChanged, tasksFor, waitingFor } from './tasks.js';
import { renderUsageChip } from './usage.js';

/* ---------- Background agents tray + turn controls (audit F3 / F4) ----------
   The engine no longer ends a turn at the first result: while background agents
   are pending it keeps iterating and the CLI auto-continues, exactly as it does
   in the terminal. That fix is INVISIBLE unless the app shows it — "waiting on 2
   background agents…" is the whole difference between "it resumed itself" and
   the user's number-one complaint, "it just stopped". So the tray is deliberately
   loud about the waiting state and quiet about everything else.

   It reads the same per-conversation state window.PLUMI_TASKS publishes; being
   in the same app we import those accessors directly and subscribe through the
   one shared listener list. The tray head doubles as the turn-control bar: it is
   the only surface guaranteed to be on screen for the whole of a running turn. */
export let taskTray = $("taskTray");
/* Collapsed by DEFAULT. This used to open true, so every refresh and every
   reopen of the home-screen app landed on the latest conversation with the
   whole agent list unrolled — including rows from a turn that finished hours
   ago. The box is the thing worth having on screen; the processes inside it are
   something you ask for. Toggling still survives re-renders within the session;
   a reload starts collapsed again, which is the point. */
export let trayOpen = false;
export let trayTick = null;        // 1s ticker — only while something is actually live
export let trayLeaving = {};       // task id -> exit timer
export let trayHidden = {};        // task id -> true once its row has folded away

export function fmtElapsed(ms) {
  var s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + "s";
  var m = Math.floor(s / 60);
  if (m < 60) return m + "m" + (s % 60 ? " " + (s % 60) + "s" : "");
  return Math.floor(m / 60) + "h " + (m % 60) + "m";
}
// Hollow = queued, pulsing accent = live, green = done, red = failed — the exact
// vocabulary .task-dot was written for. Phases come from claude.js:
// started/progress/done/stopped, with status running/completed/failed/killed.
export function taskState(t) {
  if (t.phase === "stopped" || t.status === "failed" || t.status === "killed") return "failed";
  if (t.phase === "done" || t.status === "completed") return "done";
  if (!t.phase || t.status === "queued" || t.status === "pending") return "";
  return "live";
}
export function taskTitle(t) {
  return (t.description && String(t.description).trim())
    || (t.name && String(t.name).trim())
    || "Background task";
}
// A finished row lingers with its one-line result, then folds away — so a task
// that completed while you were reading doesn't vanish before you saw it.
export function trayScheduleExit(id) {
  if (trayLeaving[id] || trayHidden[id]) return;
  trayLeaving[id] = setTimeout(function () {
    delete trayLeaving[id];
    var row = null, rows = taskTray.querySelectorAll(".task-row");
    for (var i = 0; i < rows.length; i++) if (rows[i].dataset.task === id) row = rows[i];
    if (row) row.classList.add("leaving");
    setTimeout(function () { trayHidden[id] = true; renderTaskTray(); }, 340);
  }, 6000);
}
export function trayRow(t) {
  var row = document.createElement("div");
  var st = taskState(t);
  row.className = "task-row" + (st ? " " + st : "");
  row.dataset.task = t.id;
  var dot = document.createElement("span");
  dot.className = "task-dot" + (st ? " " + st : "");
  var name = document.createElement("span");
  name.className = "task-name"; name.textContent = taskTitle(t);
  row.appendChild(dot); row.appendChild(name);
  // A finished task leaves its result behind; a live one shows how long it has
  // been going, which is the only honest progress signal we get.
  if (st === "done" || st === "failed") {
    var sum = document.createElement("span");
    sum.className = "task-sum";
    sum.textContent = (t.summary && String(t.summary).trim()) || (st === "failed" ? "failed" : "done");
    row.appendChild(sum);
    trayScheduleExit(t.id);
  } else {
    var meta = document.createElement("span");
    meta.className = "task-meta";
    meta.textContent = t.startedAt ? fmtElapsed(Date.now() - t.startedAt) : "";
    row.appendChild(meta);
  }
  return row;
}
export function renderTaskTray() {
  if (!taskTray) return;
  var key = viewKey;
  var all = tasksFor(key);
  var waiting = waitingFor(key);
  var running = !!activeStreams[key] || !!reattachTries[key];

  // Forget bookkeeping for tasks that no longer exist — a new turn clears the set.
  var alive = {};
  all.forEach(function (t) { alive[t.id] = true; });
  Object.keys(trayHidden).forEach(function (id) { if (!alive[id]) delete trayHidden[id]; });
  Object.keys(trayLeaving).forEach(function (id) {
    if (!alive[id]) { clearTimeout(trayLeaving[id]); delete trayLeaving[id]; }
  });

  var rows = all.filter(function (t) { return !trayHidden[t.id]; });
  if (!running && !rows.length && !waiting) {
    taskTray.hidden = true; taskTray.innerHTML = "";
    if (trayTick) { clearInterval(trayTick); trayTick = null; }
    return;
  }

  var live = rows.filter(function (t) { return taskState(t) === "live"; }).length;
  taskTray.innerHTML = "";
  taskTray.hidden = false;

  var head = document.createElement("div");
  head.className = "task-tray-head";
  var toggle = document.createElement("button");
  toggle.type = "button"; toggle.className = "task-tray-toggle";
  toggle.setAttribute("aria-expanded", trayOpen ? "true" : "false");
  toggle.innerHTML = TRAY_CHEV;
  var ttl = document.createElement("span");
  ttl.className = "task-tray-title";
  // Collapsing must not cost the one line this tray was built for: "waiting on
  // N background agents" is the whole difference between "it resumed itself"
  // and "it just stopped". The banner that carries it lives below the fold, so
  // while collapsed the head says it instead — .task-tray-title already
  // truncates, so a long phrase cannot push the count or Stop off the edge.
  ttl.textContent = (!trayOpen && waiting && waiting.text)
    ? waiting.text
    : (rows.length ? "Background agents" : "Turn running");
  toggle.appendChild(ttl);
  toggle.addEventListener("click", function () { trayOpen = !trayOpen; renderTaskTray(); });
  head.appendChild(toggle);
  if (rows.length) {
    var count = document.createElement("span");
    count.className = "task-tray-count";
    count.textContent = live ? (live + " / " + rows.length) : String(rows.length);
    head.appendChild(count);
  }
  // Stop lives here rather than only on the send button, because while a turn is
  // running the send button is busy queueing your next message.
  if (running) {
    var stop = document.createElement("button");
    stop.type = "button"; stop.className = "task-tray-stop";
    stop.textContent = "Stop";
    stop.setAttribute("aria-label", "Stop this turn");
    stop.title = "Stop the whole turn, including its background agents";
    stop.addEventListener("click", function () { stopCurrent(); });
    head.appendChild(stop);
  }
  taskTray.appendChild(head);

  if (!trayOpen) return;

  // The waiting banner goes ABOVE the rows: it is the one line that answers
  // "has it died?" — and the answer is no, it resumes by itself.
  if (waiting && waiting.text) {
    var w = document.createElement("div");
    w.className = "task-wait";
    var wd = document.createElement("span"); wd.className = "tw-dot";
    var wt = document.createElement("span"); wt.className = "tw-text"; wt.textContent = waiting.text;
    var ws = document.createElement("span"); ws.className = "tw-sub"; ws.textContent = "resumes by itself";
    w.appendChild(wd); w.appendChild(wt); w.appendChild(ws);
    taskTray.appendChild(w);
  }
  rows.forEach(function (t) { taskTray.appendChild(trayRow(t)); });

  // The elapsed column only needs a heartbeat while something is genuinely live.
  if (live && !trayTick) trayTick = setInterval(renderTaskTray, 1000);
  else if (!live && trayTick) { clearInterval(trayTick); trayTick = null; }
}
/* ---------- Queue a message while a turn is running (audit F4) ----------
   The composer used to be a dead end during a turn: typing was allowed, sending
   was not, and pressing send earned a 409. Now what you type is parked and goes
   out the instant the turn ends.

   A parked message is also EDITABLE, because the reason you queued it is that you
   were thinking ahead — and a thought you had thirty seconds into a turn is often
   wrong by the end of it. Tap a chip to open it; the queue then treats that one
   item as not-ready and keeps draining around it (see flushQueued). */
export let queuedList = $("queuedList");
export let queuedMsgs = {};        // convKey -> [{ id, wire, atts }]
export let queuedPainted = "";     // cheap guard: updateSend() runs on every keystroke
// Which parked message is open in the inline editor, as { key, id } or null.
// Keyed by a STABLE id rather than an index: flushQueued splices items out from
// under it, so an index would silently start pointing at the wrong message.
export let editingQueued = null;
var queuedSeq = 0;
export function queuedFor(key) { return queuedMsgs[key] || []; }
export function isEditingQueued(key, id) {
  return !!editingQueued && editingQueued.key === key && editingQueued.id === id;
}
export function repaintQueued() { queuedPainted = ""; renderQueued(); }

export function renderQueued() {
  if (!queuedList) return;
  var list = queuedFor(viewKey);
  // The signature deliberately does NOT include the message text. While the editor
  // is open, updateSend() fires on every keystroke, and repainting would replace
  // the textarea the caret is in. Ids + which one is open is enough to catch every
  // change that actually needs new DOM.
  var sig = String(viewKey) + ":" + list.map(function (q) { return q.id; }).join(",")
          + ":" + (editingQueued && editingQueued.key === viewKey ? editingQueued.id : "");
  if (sig === queuedPainted) return;
  queuedPainted = sig;
  queuedList.innerHTML = "";
  list.forEach(function (q) {
    queuedList.appendChild(isEditingQueued(viewKey, q.id) ? queuedEditor(q) : queuedChip(q));
  });
}

function attsLabel(atts) {
  return atts.length + (atts.length === 1 ? " attachment" : " attachments");
}

// The resting state: a compact chip. The whole label is the edit affordance, so
// there is no second icon competing with the × for a thumb-sized target.
function queuedChip(q) {
  var chip = document.createElement("span");
  chip.className = "queued-chip";
  var tx = document.createElement("button");
  tx.type = "button"; tx.className = "qc-text";
  var label = String(q.wire || "").replace(/\s+/g, " ").trim();
  tx.textContent = label ? label.slice(0, 60) : attsLabel(q.atts);
  tx.title = "Edit this before it sends";
  tx.setAttribute("aria-label", "Edit this queued message before it sends");
  tx.addEventListener("click", function () { beginEditQueued(viewKey, q.id); });
  var x = document.createElement("button");
  x.type = "button"; x.className = "qc-x"; x.textContent = "\u00d7";
  x.setAttribute("aria-label", "Take this message back out of the queue");
  x.title = "Put it back in the composer";
  x.addEventListener("click", function () { unqueueById(viewKey, q.id); });
  chip.appendChild(tx); chip.appendChild(x);
  return chip;
}

// The open state: a real textarea on its own row (.queued-list wraps, and this
// takes the full width). It is marked "won't send yet" because that is exactly
// what being open means — see flushQueued.
function queuedEditor(q) {
  var box = document.createElement("div");
  box.className = "queued-edit";

  var head = document.createElement("div"); head.className = "qe-head";
  head.appendChild(document.createTextNode("Editing \u2014 won\u2019t send until you\u2019re done"));
  if (q.atts && q.atts.length) {
    var a = document.createElement("span"); a.className = "qe-atts"; a.textContent = attsLabel(q.atts);
    head.appendChild(a);
  }
  box.appendChild(head);

  var ta = document.createElement("textarea");
  ta.className = "qe-input"; ta.rows = 2; ta.value = q.wire || "";
  ta.setAttribute("aria-label", "Queued message");
  box.appendChild(ta);

  var row = document.createElement("div"); row.className = "qe-row";
  var del = document.createElement("button");
  del.type = "button"; del.className = "qe-btn danger"; del.textContent = "Remove";
  del.addEventListener("click", function () { unqueueById(viewKey, q.id); });
  var cancel = document.createElement("button");
  cancel.type = "button"; cancel.className = "qe-btn"; cancel.textContent = "Cancel";
  cancel.addEventListener("click", function () { closeQueuedEditor(); });
  var save = document.createElement("button");
  save.type = "button"; save.className = "qe-btn primary"; save.textContent = "Save";
  save.addEventListener("click", function () { saveEditQueued(viewKey, q.id, ta.value); });
  row.appendChild(del); row.appendChild(cancel); row.appendChild(save);
  box.appendChild(row);

  // Enter saves, Shift+Enter is a newline, Escape closes without saving — the same
  // grammar as the composer, so the muscle memory carries over.
  ta.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEditQueued(viewKey, q.id, ta.value); }
    else if (e.key === "Escape") { e.stopPropagation(); closeQueuedEditor(); }
  });
  setTimeout(function () { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
  return box;
}

export function beginEditQueued(key, id) {
  editingQueued = { key: key, id: id };
  repaintQueued();
}

// Closing the editor is what makes the message eligible again — so it has to try
// the queue immediately. The turn it was waiting behind may well have ended while
// you were typing, in which case flushQueued skipped this one and moved on; now
// that it is ready, nothing else is going to come along and start it.
export function closeQueuedEditor() {
  if (!editingQueued) return;
  editingQueued = null;
  repaintQueued();
  updateSend();
  flushQueued(viewKey);
}

export function saveEditQueued(key, id, text) {
  var list = queuedMsgs[key];
  var item = list && list.find(function (q) { return q.id === id; });
  if (!item) { closeQueuedEditor(); return; }
  var wire = String(text == null ? "" : text).trim();
  // Emptied with nothing else to carry: that is a delete, not a blank message.
  if (!wire && !(item.atts && item.atts.length)) { unqueueById(key, id); return; }
  item.wire = wire;
  closeQueuedEditor();
}

export function enqueueMessage(key, wire, atts) {
  if (!queuedMsgs[key]) queuedMsgs[key] = [];
  queuedMsgs[key].push({ id: ++queuedSeq, wire: wire, atts: atts || [] });
  repaintQueued(); updateSend();
  toast("Queued \u2014 tap it to edit before it sends");
}

// Taking one back must not lose it: the text goes into the composer (unless you
// have already started typing something else) and the files back onto the tray.
export function unqueueById(key, id) {
  var list = queuedMsgs[key]; if (!list) return;
  var i = list.findIndex(function (q) { return q.id === id; });
  if (i < 0) return;
  var item = list.splice(i, 1)[0];
  if (!list.length) delete queuedMsgs[key];
  if (isEditingQueued(key, id)) editingQueued = null;
  if (item) {
    if (!input.value.trim() && item.wire) { input.value = item.wire; autoGrow(); }
    if (item.atts && item.atts.length) { setPending(pending.concat(item.atts)); renderAttachments(); }
  }
  repaintQueued(); updateSend();
}
// Index-based removal is kept for callers that already have one.
export function unqueue(key, i) {
  var list = queuedMsgs[key];
  if (list && list[i]) unqueueById(key, list[i].id);
}

// Send the oldest READY queued message for a conversation. Only ever for the
// conversation ON SCREEN: send() binds the new turn to viewKey/viewToken, so
// flushing a background conversation's queue would post it into whichever chat you
// were looking at. A parked queue simply waits until you come back (see
// reflectStream).
export function flushQueued(key) {
  if (key !== viewKey) return;
  if (activeStreams[key] || reattachTries[key]) return;
  var list = queuedMsgs[key];
  if (!list || !list.length) return;
  // Skip whatever is open in the editor. You are still writing it, so sending it
  // now would post a half-finished message — but the ones BEHIND it are finished,
  // so the queue keeps moving and the edited one simply holds its place until you
  // close the editor (closeQueuedEditor calls back in here).
  var i = 0;
  while (i < list.length && isEditingQueued(key, list[i].id)) i++;
  if (i >= list.length) return;   // everything parked is mid-edit: wait for you.
  var next = list.splice(i, 1)[0];
  if (!list.length) delete queuedMsgs[key];
  repaintQueued();
  send(next.wire, next.atts);
}

export function initTaskTray() {
  // One subscription drives the tray, the usage chip and the queued-message list —
  // PLUMI_TASKS / PLUMI_LIMITS / PLUMI_THINKING share a single listener list.
  onTasksChanged(function (key) {
    if (key && key !== viewKey) return;   // another conversation's turn — not on screen
    renderTaskTray();
    renderUsageChip();
  });
}
