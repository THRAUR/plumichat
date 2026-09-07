/* PlumiChat — the background-agents tray and the queue of messages waiting for the
   running turn to end. Both render from tasks.js's accessors; neither owns state. */

import { renderAttachments } from './panels/attachments.js';
import { autoGrow, updateSend } from './composer.js';
import { $, input, toast } from './dom.js';
import { reqJSON, apiFetch } from './api.js';
import { TRAY_CHEV } from './icons.js';
import { activeStreams, pending, reattachTries, setPending, viewKey } from './state.js';
import { send, stopCurrent, syncRuns, uploadOne } from './stream.js';
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
   The composer is not a dead end during a turn: what you type is parked and goes
   out when the turn ends.

   The queue lives on the SERVER (server/queue.js), keyed by conversation. It used
   to be a plain object in this file, which made it three things it should never
   have been: invisible on your other devices, lost to a hard refresh, and lost to
   closing the window by accident. A queue you cannot trust to still be there is
   worse than no queue, because you stop typing ahead.

   So this module is now a VIEW, not a store:
     - reads come from GET /api/queue, mirrored locally only to paint from
     - every mutation is an HTTP call, and the answer is the truth
     - other devices (and the server's own draining) arrive over an SSE stream
     - NOTHING here sends a queued message any more. runs.js drains the queue when
       a turn ends, so the work happens whether or not a browser is watching. */
export let queuedList = $("queuedList");
var queued = {};        // convKey -> rows from the server (mirror, never the truth)
var staged = {};        // convKey -> rows not yet on the server (see stageOrPost)
var editingId = null;   // the row open in THIS window's editor
export let queuedPainted = "";
var queueSeq = 0;       // ids for staged rows, which have no server id yet

export function queuedFor(key) { return (staged[key] || []).concat(queued[key] || []); }
function rowById(id) {
  var all = queuedFor(viewKey);
  for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
  return null;
}
export function repaintQueued() { queuedPainted = ""; renderQueued(); }

/* ------------------------------------------------------------ server reads -- */

export function refreshQueue(key) {
  var k = key || viewKey;
  if (!k || String(k).indexOf("new:") === 0) { repaintQueued(); return Promise.resolve(); }
  return reqJSON("/api/queue?key=" + encodeURIComponent(k)).then(function (d) {
    queued[k] = (d && d.queued) || [];
    repaintQueued();
    updateSend();
  }).catch(function () { /* offline — keep painting the last known list */ });
}

/* ---------------------------------------------------------------- painting -- */

export function renderQueued() {
  if (!queuedList) return;
  var list = queuedFor(viewKey);
  // The signature deliberately does NOT include the message text. While the editor
  // is open, updateSend() fires on every keystroke, and repainting would replace
  // the textarea the caret is in. Ids, who is holding what, and which one is open
  // here is enough to catch every change that actually needs new DOM.
  var sig = String(viewKey) + ":" + list.map(function (q) {
    return q.id + (q.editing ? "!" : "") + (q.pending ? "?" : "");
  }).join(",") + ":" + (editingId || "");
  if (sig === queuedPainted) return;
  queuedPainted = sig;
  queuedList.innerHTML = "";
  list.forEach(function (q) {
    queuedList.appendChild(q.id === editingId ? queuedEditor(q) : queuedChip(q));
  });
}

function attsLabel(n) { return n + (n === 1 ? " attachment" : " attachments"); }

// The resting state: a compact chip. The whole label is the edit affordance, so
// there is no second icon competing with the × for a thumb-sized target.
function queuedChip(q) {
  var chip = document.createElement("span");
  chip.className = "queued-chip" + (q.editing ? " held" : "") + (q.pending ? " pending" : "");
  var tx = document.createElement("button");
  tx.type = "button"; tx.className = "qc-text";
  var label = String(q.wire || "").replace(/\s+/g, " ").trim();
  tx.textContent = label ? label.slice(0, 60) : attsLabel(q.atts || 0);
  if (q.editing) {
    // Held open somewhere else. Say so rather than letting it look stuck: this is
    // the whole reason the hold is shared instead of being per-window state.
    tx.title = "Being edited on another device — it won't send until that's finished";
    tx.setAttribute("aria-label", tx.title);
  } else {
    tx.title = "Edit this before it sends";
    tx.setAttribute("aria-label", "Edit this queued message before it sends");
  }
  tx.addEventListener("click", function () { beginEditQueued(q.id); });
  var x = document.createElement("button");
  x.type = "button"; x.className = "qc-x"; x.textContent = "\u00d7";
  x.setAttribute("aria-label", "Take this message back out of the queue");
  x.title = "Put it back in the composer";
  x.addEventListener("click", function () { unqueueById(q.id); });
  chip.appendChild(tx); chip.appendChild(x);
  return chip;
}

// The open state: a real textarea on its own row (.queued-list wraps, and this
// claims the full width).
function queuedEditor(q) {
  var box = document.createElement("div");
  box.className = "queued-edit";

  var head = document.createElement("div"); head.className = "qe-head";
  head.appendChild(document.createTextNode("Editing \u2014 won\u2019t send until you\u2019re done"));
  if (q.atts) { var a = document.createElement("span"); a.className = "qe-atts"; a.textContent = attsLabel(q.atts); head.appendChild(a); }
  box.appendChild(head);

  var ta = document.createElement("textarea");
  ta.className = "qe-input"; ta.rows = 2; ta.value = q.wire || "";
  ta.setAttribute("aria-label", "Queued message");
  box.appendChild(ta);

  var row = document.createElement("div"); row.className = "qe-row";
  var del = document.createElement("button");
  del.type = "button"; del.className = "qe-btn danger"; del.textContent = "Remove";
  del.addEventListener("click", function () { unqueueById(q.id); });
  var cancel = document.createElement("button");
  cancel.type = "button"; cancel.className = "qe-btn"; cancel.textContent = "Cancel";
  cancel.addEventListener("click", function () { closeQueuedEditor(); });
  var save = document.createElement("button");
  save.type = "button"; save.className = "qe-btn primary"; save.textContent = "Save";
  save.addEventListener("click", function () { saveEditQueued(q.id, ta.value); });
  row.appendChild(del); row.appendChild(cancel); row.appendChild(save);
  box.appendChild(row);

  // Enter saves, Shift+Enter is a newline, Escape closes without saving — the same
  // grammar as the composer, so the muscle memory carries over.
  ta.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEditQueued(q.id, ta.value); }
    else if (e.key === "Escape") { e.stopPropagation(); closeQueuedEditor(); }
  });
  setTimeout(function () { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
  return box;
}

/* --------------------------------------------------------------- mutations -- */

// Park a message behind the running turn. Files are uploaded HERE rather than at
// send time: a File object cannot be persisted, and the whole promise of this
// queue is that it outlives the tab that typed it.
export function enqueueMessage(key, wire, atts) {
  var files = [], ready = [];
  (atts || []).forEach(function (a) {
    if (a.kind === "server" && a.path) ready.push(a.path);
    else if (a.file) files.push(a.file);
  });
  Promise.all(files.map(uploadOne)).then(function (paths) {
    return stageOrPost(key, wire, ready.concat(paths));
  }).catch(function (e) {
    toast(e.message || "Could not queue that message", true);
  });
}

// A brand-new chat has no session id until the server sends one, a second or so
// into its first turn — and the server queue is keyed by that id. So a message
// queued inside that window is STAGED locally and posted the moment the id lands
// (rekeyQueue). It is painted like any other, because to the person it is queued.
function stageOrPost(key, wire, paths) {
  if (!key || String(key).indexOf("new:") === 0) {
    if (!staged[key]) staged[key] = [];
    staged[key].push({ id: "s_" + (++queueSeq), wire: wire, atts: paths.length, paths: paths, pending: true });
    repaintQueued(); updateSend();
    toast("Queued \u2014 tap it to edit before it sends");
    return Promise.resolve();
  }
  return postQueued(key, wire, paths);
}

function postQueued(key, wire, paths) {
  return apiFetch("/api/queue", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: key, wire: wire, attachments: paths }),
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (d) {
      if (r.status === 409 && d.sendNow) {
        // The turn ended between deciding to queue and this arriving. Nothing is
        // waiting for it, so send it instead of pretending it is still queued.
        send(wire, (paths || []).map(function (p) { return { kind: "server", path: p, name: p }; }));
        return;
      }
      if (!r.ok) throw new Error(d.error || ("Could not queue (" + r.status + ")"));
      toast("Queued \u2014 tap it to edit before it sends");
      return refreshQueue(key);
    });
  });
}

// Called from stream.js when a new chat learns its real session id. Anything
// staged under the placeholder key goes to the server now, in order.
export function rekeyQueue(oldKey, newKey) {
  var rows = staged[oldKey] || [];
  delete staged[oldKey];
  if (queued[oldKey]) { queued[newKey] = queued[oldKey]; delete queued[oldKey]; }
  var chain = Promise.resolve();
  rows.forEach(function (r) {
    chain = chain.then(function () { return postQueued(newKey, r.wire, r.paths || []); });
  });
  chain.then(function () { return refreshQueue(newKey); }).catch(function () { /* toast already shown */ });
}

export function beginEditQueued(id) {
  var q = rowById(id);
  if (!q) return;
  editingId = id;
  repaintQueued();
  // Tell the server (and therefore the other devices, and the drain) that this one
  // is being written. Staged rows have no server row to hold yet.
  if (!q.pending) {
    apiFetch("/api/queue/" + encodeURIComponent(id), {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ editing: true, by: deviceLabel() }),
    }).catch(function () { /* the hold is an optimisation, not a correctness gate */ });
  }
}

// Closing the editor releases the hold, which is what makes the message eligible
// again. The server drains on its own from there.
export function closeQueuedEditor() {
  var id = editingId;
  if (!id) return;
  editingId = null;
  repaintQueued(); updateSend();
  var q = rowById(id);
  if (q && !q.pending) {
    apiFetch("/api/queue/" + encodeURIComponent(id), {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ editing: false }),
    }).then(function () { return refreshQueue(viewKey); }).catch(function () { /* ignore */ });
  }
}

export function saveEditQueued(id, text) {
  var q = rowById(id);
  if (!q) { closeQueuedEditor(); return; }
  var wire = String(text == null ? "" : text).trim();
  // Emptied with nothing else to carry: that is a delete, not a blank message.
  if (!wire && !q.atts) { unqueueById(id); return; }
  if (q.pending) { q.wire = wire; editingId = null; repaintQueued(); updateSend(); return; }
  editingId = null;
  repaintQueued();
  apiFetch("/api/queue/" + encodeURIComponent(id), {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wire: wire, attachments: q.paths || [] }),
  }).then(function () { return refreshQueue(viewKey); })
    .catch(function (e) { toast(e.message || "Could not save that edit", true); });
}

// Taking one back must not lose it: the text goes into the composer (unless you
// have already started typing something else).
export function unqueueById(id) {
  var q = rowById(id);
  if (!q) return;
  if (editingId === id) editingId = null;
  if (!input.value.trim() && q.wire) { input.value = q.wire; autoGrow(); }
  if (q.pending) {
    var list = staged[viewKey] || [];
    var i = list.findIndex(function (r) { return r.id === id; });
    if (i >= 0) list.splice(i, 1);
    repaintQueued(); updateSend();
    return;
  }
  // Paint the removal immediately; the refresh below is the confirmation.
  queued[viewKey] = (queued[viewKey] || []).filter(function (r) { return r.id !== id; });
  repaintQueued(); updateSend();
  apiFetch("/api/queue/" + encodeURIComponent(id), { method: "DELETE" })
    .then(function () { return refreshQueue(viewKey); })
    .catch(function () { refreshQueue(viewKey); });
}

/* ---------------------------------------------------------------- draining -- */

// The server drains the queue when a turn ends (runs.js), so this no longer sends
// anything — it only brings the view back in step. Kept under the old name because
// three callers already say "the turn ended, deal with the queue" by calling it.
export function flushQueued(key) {
  refreshQueue(key || viewKey);
}

// A short, throwaway label so another device can say WHERE a message is being
// edited. Deliberately coarse — it is a courtesy, not telemetry.
function deviceLabel() {
  var ua = navigator.userAgent || "";
  if (/iPhone|Android.*Mobile/i.test(ua)) return "a phone";
  if (/iPad|Tablet/i.test(ua)) return "a tablet";
  if (/Macintosh/i.test(ua)) return "a Mac";
  if (/Windows/i.test(ua)) return "a PC";
  return "another device";
}

// Live sync. Every device with the app open holds this stream; the server pushes a
// bare "something changed" and we re-read, which keeps the wire dumb and means a
// missed frame self-heals on the next one. It also fires when the SERVER drains,
// which is how a window that did not start the turn still picks it up: syncRuns()
// attaches to whatever is now running.
var queueES = null;
export function initQueueSync() {
  if (queueES || typeof EventSource === "undefined") return;
  try { queueES = new EventSource("/api/queue/stream"); } catch (e) { return; }
  queueES.onmessage = function () {
    refreshQueue(viewKey);
    syncRuns();
  };
  // EventSource reconnects on its own (the server sends `retry:`); nothing to do
  // here but avoid logging a reconnect as an error.
  queueES.onerror = function () { /* browser retries */ };
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
