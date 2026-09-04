/* PlumiChat — the conversation state every module shares.

   These were plain `var`s in app.js's single IIFE. Each is exported as a LIVE
   binding, so a reader always sees the current value instead of a copy taken at
   import time; every WRITE goes through a setter here, because an ES module may
   not assign to an imported binding and because one owner means nothing can
   drift. Reads elsewhere are unchanged — `viewKey` still reads as `viewKey`. */

/* ---------- State ---------- */
export let projects = [];                 // [{ name, path }]
export function setProjects(v) { projects = v; }
export let current = 0;                   // index into projects
export function setCurrent(v) { current = v; }
export const sessionsCache = {};          // { projectName: [{ id, title, updatedAt }] }
export let activeSessionId = null;        // null = unsent new chat
export function setActiveSessionId(v) { activeSessionId = v; }
// Per-conversation streaming so two conversations can run at once without one
// bleeding into the other. `viewKey` = identity of the on-screen conversation
// (a session id, or "new:N" for an unsent chat). `viewToken` bumps on every
// view swap and gates live DOM rendering. `activeStreams` tracks in-flight
// turns keyed by conversation identity.
export let viewKey = null;
export function setViewKey(v) { viewKey = v; }
export let viewToken = 0;
export function bumpViewToken() { viewToken++; }
export const activeStreams = {};
// Declared up here, beside activeStreams, and NOT in the re-attach code that
// owns it: turnRunning() reads both, and renderModelMenu() calls turnRunning()
// during start-up — long before that code runs. Back when this was one file,
// declaring it lower down left `var` hoisting to make it `undefined` at that
// moment, so the read threw and took the whole app's initialisation with it.
// (That crash is why every one of these now lives in this one module: a module's
// exports are initialised before any importer's body runs, so there is no order
// in which a reader can see one of them half-built.)
export let reattachTries = {};
export function resetReattachTries() { reattachTries = {}; }
// Endings we've already delivered for a run, keyed by run id. The server now
// keeps ENDED runs around for ten minutes so a phone that was asleep collects
// the ending — this stops us re-attaching to (and re-announcing) the same
// finished run on every wake-up.
export const endingsSeen = {};
// Local-clock guard against an attach loop. onDone reloads the transcript, which
// calls syncRuns again — so if /api/runs were momentarily to still report a run
// as 'running' after we already collected its ending, attach → ended → reload →
// sync → attach would spin forever. Nothing may re-attach a conversation whose
// ending we delivered in the last few seconds; starting a new turn clears it.
export const recentlyEnded = {};
export const REATTACH_COOLDOWN_MS = 3000;
// Client-side placeholders for brand-new conversations, KEYED by their view key
// ("new:N" until the server assigns a session id, then re-keyed to it). Each
// appears in the drawer the instant you start one (the pen) — before it's ever
// saved server-side — and is re-titled live (AI summary) as its turn runs. This
// is a map, not one global: starting a second new chat while the first turn was
// still running used to clobber the first one's drawer row and swallow its live
// title event. { key: { key, title, project } }
export const drafts = {};
let newSeq = 0;
export function freshViewKey() { return "new:" + (++newSeq); }
export function draftFor(key) { return (key && drafts[key]) || null; }
// Abandon every draft except `keep` that has no turn in flight — an unsent new
// chat is discarded when you start another one (as before), but one that is
// mid-turn keeps its drawer row and its live title.
export function dropIdleDrafts(keep) {
  Object.keys(drafts).forEach(function (k) { if (k !== keep && !activeStreams[k]) delete drafts[k]; });
}
export function startDraft(name) {
  dropIdleDrafts(viewKey);
  drafts[viewKey] = { key: viewKey, title: "New conversation", project: name || projName() };
}
export function projName() { return projects.length ? projects[current].name : null; }

/* ---------- The live streaming bubble ----------
   Owned here rather than in stream.js because render.js's clearMessages() drops
   it when you switch conversations, and stream.js builds it. */
export let cur = null;   // { bubble, p, caret, text }
export function setCur(v) { cur = v; }

/* ---------- Attachments queued on the composer ----------
   Filled by the attach menu / paste / drop, drained by submit(), refilled when a
   queued message is unqueued or a send fails. */
export let pending = [];
export function setPending(v) { pending = v; }
