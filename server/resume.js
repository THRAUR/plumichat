/* PlumiChat — carry a turn on when the usage window reopens.
   ==========================================================================
   Hitting the 5-hour limit mid-task used to be the end of the evening: the turn
   stops, and the work only continues when a human is awake to press Continue.
   The reset time is known — the SDK reports it on every `rate_limit_event` — so
   the machine can simply wait. That is the whole feature: when a turn stops
   because the window is spent, offer to resume it the moment the new window
   opens, and if the answer is yes, do it whether or not anybody is watching.

   Design notes worth keeping:

   - It is SERVER-side, and persisted. The point is that the person is asleep and
     the phone is locked, so a browser timer would be useless. The armed resume
     lives in the JSON store and is re-armed on boot, which means a restart (or a
     deploy) between arming and firing does not silently drop the work.
   - It is POLLED on a 30s tick rather than a single long setTimeout. A timer
     that far out is unreliable across sleep/suspend, and Node clamps anything
     over ~24.8 days anyway; a tick also lets a resume that failed (a turn was
     already running, the box was at its cap) simply try again shortly.
   - It resumes with the literal prompt "continue", which is exactly what the
     Continue button on a stop notice already sends. Same semantics, so a
     conversation cannot tell whether a human or the clock pressed it.
   - GRACE_MS exists because resetsAt is the instant the window *becomes*
     available; firing on the dot occasionally lands a beat early and burns the
     attempt on a still-rejected request.
*/

import { read, update } from './store.js';
import { startRun, getRun } from './runs.js';
import { sendToUser } from './push.js';

const COLLECTION = 'resumes';

const TICK_MS = 30 * 1000;
// Fire a minute past the stated reset: see the note above.
const GRACE_MS = 60 * 1000;
// Give up after this many failed attempts (~10 min of ticks). A resume that
// cannot start because the box is busy should retry; one that cannot start
// because something is genuinely wrong should not retry forever.
const MAX_ATTEMPTS = 20;
// An armed resume older than this is stale — the window it was waiting for is
// long gone and firing it now would be a surprise, not a favour.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/* resetsAt has been seen as both epoch seconds and epoch milliseconds. Mirrors
   limitResetMs() in public/js/usage.js — same tolerance, same reasoning: accept
   anything that parses as a time, ignore anything that does not. */
export function limitResetMs(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : 0;
}

const list = () => read(COLLECTION, []);

// One armed resume per conversation. Re-arming replaces rather than stacks, so a
// turn that stops twice against the same window cannot queue two continuations.
export function armResume(entry) {
  const key = String(entry.key || '').trim();
  if (!key) throw new Error('nothing to resume');
  const at = limitResetMs(entry.resetsAt);
  if (!at) throw new Error('no reset time was reported for this limit');

  const row = {
    key,
    userId: entry.userId || null,
    project: entry.project || '',
    cwd: entry.cwd || '',
    sessionId: entry.sessionId || null,
    model: entry.model || null,
    effort: entry.effort || null,
    fastMode: !!entry.fastMode,
    context1m: !!entry.context1m,
    permissionMode: entry.permissionMode || 'default',
    confineHome: entry.confineHome || null,
    kind: entry.kind || '',            // 'five_hour' | 'seven_day' | …, for the wording
    resumeAt: at + GRACE_MS,
    armedAt: Date.now(),
    attempts: 0,
  };
  update(COLLECTION, (rows) => [...rows.filter((r) => r.key !== key), row], []);
  return publicRow(row);
}

export function cancelResume(userId, key) {
  update(COLLECTION, (rows) => rows.filter(
    (r) => !(r.key === key && (!userId || r.userId === userId))
  ), []);
  return { ok: true };
}

// Only your own. An armed resume names a project path and a session id, so it is
// account-scoped data like everything else on the profile.
export function resumesFor(userId) {
  return list().filter((r) => !userId || r.userId === userId).map(publicRow);
}
export function resumeFor(userId, key) {
  return resumesFor(userId).find((r) => r.key === key) || null;
}
function publicRow(r) {
  return {
    key: r.key, project: r.project, sessionId: r.sessionId,
    kind: r.kind, resumeAt: r.resumeAt, armedAt: r.armedAt, attempts: r.attempts || 0,
  };
}

function drop(key) {
  update(COLLECTION, (rows) => rows.filter((r) => r.key !== key), []);
}
function bumpAttempt(key) {
  update(COLLECTION, (rows) => rows.map(
    (r) => (r.key === key ? { ...r, attempts: (r.attempts || 0) + 1 } : r)
  ), []);
}

function fire(row) {
  // Already going? The window opened and something else (a person, most likely)
  // got there first. That is a success, not a retry.
  const live = getRun(row.key);
  if (live && live.status === 'running') { drop(row.key); return; }

  try {
    startRun({
      project: row.project,
      cwd: row.cwd,
      prompt: 'continue',
      sessionId: row.sessionId,
      model: row.model,
      effort: row.effort,
      fastMode: row.fastMode,
      context1m: row.context1m,
      permissionMode: row.permissionMode,
      confineHome: row.confineHome,
      userId: row.userId,
    });
    drop(row.key);
    // Told, not asked: the person armed this precisely because they would not be
    // watching. Best-effort by contract, like every other push here.
    if (row.userId) {
      const q = [];
      if (row.project) q.push('project=' + encodeURIComponent(row.project));
      if (row.key) q.push('c=' + encodeURIComponent(row.key));
      // A user OBJECT, not the bare id — rawSubs() reads .id, so passing the string
      // would find no subscriptions and send nothing, silently. Same shape as
      // pushIfAway() in runs.js.
      Promise.resolve(sendToUser({ id: row.userId }, {
        title: 'PlumiChat picked the work back up',
        body: 'Your usage window reset, so the paused turn is running again.',
        tag: 'plumi-resume',
        url: '/' + (q.length ? '?' + q.join('&') : ''),
      })).catch(() => { /* best effort */ });
    }
  } catch (err) {
    // startRun throws for "a turn is already running", the per-user cap, the box
    // cap and the spend gate. All of those are worth retrying on the next tick;
    // none is worth retrying forever.
    bumpAttempt(row.key);
    const n = (row.attempts || 0) + 1;
    if (n >= MAX_ATTEMPTS) {
      console.error(`[resume] giving up on ${row.key} after ${n} attempts: ${err?.message || err}`);
      drop(row.key);
    }
  }
}

function tick() {
  const now = Date.now();
  for (const row of list()) {
    if (now - (row.armedAt || 0) > MAX_AGE_MS) { drop(row.key); continue; }
    if (now >= row.resumeAt) fire(row);
  }
}

let ticker = null;
export function initResumes() {
  if (ticker) return;
  // Sweep once at boot: a resume whose window opened while the server was down
  // is exactly the case this feature exists for, so it must not wait for the
  // first tick — nor be lost because the process restarted.
  try { tick(); } catch (err) { console.error('[resume] boot sweep failed:', err); }
  ticker = setInterval(() => {
    try { tick(); } catch { /* keep the timer alive */ }
  }, TICK_MS);
  ticker.unref?.();
}
