/* PlumiChat — background-task, rate-limit and thinking-token state for every
   conversation, plus the window.PLUMI_* hooks the tray and other pages read. */

import { viewKey } from './state.js';

/* ---------- Background-task / limits / thinking state ----------
   The engine now keeps a turn alive across background agents and reports them
   ({type:'task'}), the account's rate-limit window ({type:'limits'}) and a
   running thinking-token estimate ({type:'thinkingTokens'}). We only maintain
   the STATE here — the agents tray and the turn-control buttons that render it
   are built on top of these hooks. They are mirrored onto `window.PLUMI_TASKS`,
   `window.PLUMI_LIMITS` and `window.PLUMI_THINKING` (see the accessors below)
   so that UI can read them without importing this module. */
export let convTasks = {};       // convKey -> { id: { id, name, description, status, summary, phase, startedAt, endedAt } }
export let convTaskOrder = {};   // convKey -> [id…] (arrival order, for a stable tray)
export let waitingState = {};    // convKey -> { tasks, text } while a turn waits on background work
export let limitsState = null;   // last {status, resetsAt, kind, overage} the server reported
// resetsAt has been seen as both epoch seconds and epoch milliseconds; anything
// that parses as a date is accepted, and anything that doesn't is simply not shown.
// It lives HERE, with the limits state it reads, rather than in usage.js: stream.js
// needs it too, and usage.js already imports stream.js — so importing it back would
// have closed a cycle. server/resume.js and server/claude.js keep the same rule.
export function limitResetMs(l) {
  if (!l || l.resetsAt == null) return 0;
  var v = l.resetsAt;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  var t = Date.parse(String(v));
  return Number.isFinite(t) ? t : 0;
}
// Real tokens this account has spent through PlumiChat inside the CURRENT rate-limit
// window, summed from the usage every turn's `result` reports. The rate-limit
// event itself carries NO consumption figure — only a status — so this is the
// only honest number available. Keyed by the window's reset time: when that moves
// the window rolled over and the count starts again.
export let windowUsage = { resetsAt: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, costUsd: 0 };
export function setLimits(v) {
  var prevReset = limitsState && limitsState.resetsAt;
  limitsState = v;
  if (v && v.resetsAt !== prevReset) resetWindowUsage(v.resetsAt);
}
export function resetWindowUsage(resetsAt) {
  windowUsage = { resetsAt: resetsAt == null ? null : resetsAt, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, costUsd: 0 };
}
// Called once per finished turn from stream.js. Defensive about shape: the usage
// block has gained fields before and a missing one must not poison the total.
export function addTurnUsage(ev) {
  if (!ev) return;
  var u = ev.usage || {};
  windowUsage.input += Number(u.input) || 0;
  windowUsage.output += Number(u.output) || 0;
  windowUsage.cacheRead += Number(u.cacheRead) || 0;
  windowUsage.cacheWrite += Number(u.cacheWrite) || 0;
  windowUsage.costUsd += Number(ev.costUsd) || 0;
  windowUsage.turns += 1;
  emitTasksChanged(null);
}
export let thinkingState = {};   // convKey -> last estimated thinking-token count
// Anyone can subscribe to "something in the above changed" — the tray re-renders
// from the accessors rather than being pushed a diff.
export let taskListeners = [];
export function onTasksChanged(fn) { if (typeof fn === "function") taskListeners.push(fn); }
export function emitTasksChanged(key) {
  for (var i = 0; i < taskListeners.length; i++) {
    try { taskListeners[i](key); } catch (e) { /* a broken listener must not kill the stream */ }
  }
}
export function tasksFor(key) {
  var byId = convTasks[key] || {}, order = convTaskOrder[key] || [];
  return order.map(function (id) { return byId[id]; }).filter(Boolean);
}
export function waitingFor(key) { return waitingState[key] || null; }
export function thinkingFor(key) { return thinkingState[key] || 0; }
export function noteTask(key, ev) {
  if (!ev || !ev.id) return;
  if (!convTasks[key]) { convTasks[key] = {}; convTaskOrder[key] = []; }
  var byId = convTasks[key], t = byId[ev.id];
  if (!t) { t = byId[ev.id] = { id: ev.id, startedAt: Date.now() }; convTaskOrder[key].push(ev.id); }
  t.phase = ev.phase || t.phase || "progress";
  if (ev.name) t.name = ev.name;
  if (ev.description) t.description = ev.description;
  if (ev.status) t.status = ev.status;
  if (ev.summary) t.summary = ev.summary;
  if (ev.phase === "done" || ev.phase === "stopped") t.endedAt = Date.now();
  emitTasksChanged(key);
}
export function clearTasks(key) {
  delete convTasks[key]; delete convTaskOrder[key];
  delete waitingState[key]; delete thinkingState[key];
  emitTasksChanged(key);
}
// Re-key everything a brand-new conversation accumulated under "new:N" once the
// server hands back the real session id.
export function rekeyTaskState(oldKey, newKey) {
  ["convTasks", "convTaskOrder", "waitingState", "thinkingState"].forEach(function (n) {
    var map = n === "convTasks" ? convTasks : n === "convTaskOrder" ? convTaskOrder
      : n === "waitingState" ? waitingState : thinkingState;
    if (map[oldKey] !== undefined) { map[newKey] = map[oldKey]; delete map[oldKey]; }
  });
}

export function initTasks() {
  // The hook the agents-tray / turn-controls UI reads. Everything is a live getter,
  // so the tray never holds a stale copy.
  window.PLUMI_TASKS = {
    forConversation: tasksFor,
    waiting: waitingFor,
    thinking: thinkingFor,
    current: function () { return tasksFor(viewKey); },
    currentWaiting: function () { return waitingFor(viewKey); },
    currentThinking: function () { return thinkingFor(viewKey); },
    subscribe: onTasksChanged
  };
  window.PLUMI_LIMITS = { get: function () { return limitsState; }, subscribe: onTasksChanged };
  window.PLUMI_THINKING = { get: function () { return thinkingFor(viewKey); }, subscribe: onTasksChanged };
}
