/* PlumiChat — carry a turn on when the usage window reopens.
   ==========================================================================
   Hitting the 5-hour or weekly limit mid-task used to be the end of the evening:
   the turn stops, and the work only continues when a human is awake to press
   Continue. The reset time is known — the SDK reports it on every
   `rate_limit_event` — so the machine can simply wait: when a turn stops because
   the window is spent, it is picked back up a minute after the new window opens,
   whether or not anybody is watching.

   Design notes worth keeping:

   - It is AUTOMATIC, and armed by the SERVER when the turn ends (runs.js calls
     settleResume). It used to be an offer under the stopped turn, armed by a tap.
     The offer was a live-only event, never buffered, so it reached a page only if
     one happened to be attached at the second the turn stopped: a locked phone came
     back to a plain error, and the only way to get the offer was to send another
     message into the spent window and stop on it again. The page now only SHOWS
     what is armed (GET /api/resume), with a Cancel.
   - It is SERVER-side, and persisted. The point is that the person is asleep and
     the phone is locked, so a browser timer would be useless. The armed resume
     lives in the JSON store and is re-armed on boot, which means a restart (or a
     deploy) between arming and firing does not silently drop the work.
   - It is POLLED on a short tick rather than a single long setTimeout. A timer
     that far out is unreliable across sleep/suspend, and Node clamps anything
     over ~24.8 days anyway; a tick also lets a resume that could not start (the
     box was at its cap) simply try again shortly.
   - It resumes with the literal prompt "continue", which is exactly what the
     Continue button on a stop notice already sends. Same semantics, so a
     conversation cannot tell whether a human or the clock pressed it.
   - GRACE_MS exists because resetsAt is the instant the window *becomes*
     available; firing on the dot occasionally lands a beat early and burns the
     attempt on a still-rejected request.
   - The window is CHECKED before the turn goes out. A "continue" sent into a
     window that is still spent is not free: it stays in the conversation as a
     message and an error. So the tick asks the plan's usage first (probeUsage, a
     control request that runs no turn and costs nothing), and a window that is
     still spent moves the time instead. The probe is an EXPERIMENTAL SDK call, so
     it is only ever a second opinion: when it fails, the turn goes out anyway.
   - "Not right now" is never a reason to give up. The per-person and box caps are
     a wait, not a failure: at a reset every paused conversation comes due at once,
     and the ones over the cap go out as the others finish. Only a spent workspace
     budget, a vanished account or a run of failed tries ends a resume.
   - A turn it starts is FOLLOWED to its end (row.firing). Stopping on the limit
     again re-arms from what that turn reported; an error that is not the limit
     (an overloaded API at the top of the hour, when every window resets) tries
     again with a backoff; a restart in the middle fires it again; a human Stop
     ends it. Any other turn starting in the conversation takes over instead
     (releaseResume): if that one also stops on the limit, it re-arms.
*/

import { query } from '@anthropic-ai/claude-agent-sdk';
import { read, update } from './store.js';
import { startResumed, getRun } from './runs.js';
import { sendToUser } from './push.js';
import { findById, isAdmin } from './users.js';
import { scrubbedEnv } from './claude.js';

const COLLECTION = 'resumes';

const TICK_MS = 15 * 1000;
// Fire a minute past the stated reset: see the note above.
const GRACE_MS = 60 * 1000;
// How many turns one stop may start before it is handed back to the person. Only
// tries that FAILED count, and a window that reports its reset never fails one.
const MAX_TRIES = 6;
// When nothing says when the window reopens, look again after this long.
const LIMIT_BACKOFF_MS = [15, 30, 60].map((m) => m * 60 * 1000);
// A turn that it started and that failed on something other than the limit.
const RETRY_BACKOFF_MS = [2, 5, 15, 30, 60].map((m) => m * 60 * 1000);
// A resume this far past its time is stale: the server was off for days, and
// firing it now would be a surprise, not a favour. Measured from resumeAt, not from
// when it was armed — a weekly limit is armed up to seven days ahead.
const STALE_MS = 2 * 24 * 60 * 60 * 1000;
// A fired turn whose run is gone but that never reported back (only a bug does
// that outside a restart) is cleared after this.
const LOST_MS = 2 * 60 * 1000;

// Off switch for a box that would rather not spend its next window on its own.
const AUTO = !/^(0|off|false|no)$/i.test(String(process.env.PLUMI_AUTO_RESUME || '').trim());

/* resetsAt has been seen as both epoch seconds and epoch milliseconds. Mirrors
   limitResetMs() in public/js/tasks.js — same tolerance, same reasoning: accept
   anything that parses as a time, ignore anything that does not. */
export function limitResetMs(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : 0;
}

const list = () => read(COLLECTION, []);
const rowFor = (key) => list().find((r) => r.key === key) || null;
const pick = (arr, i) => arr[Math.min(Math.max(0, i), arr.length - 1)];

/* ---------------------------------------------------------- change events -- */
// index.js relays this to the account's open pages as the queue's "something
// changed", which already makes every page re-read and re-attach — so a page left
// open on the conversation shows the note, loses it, and follows the turn that
// the clock started, with no stream of its own. Same listener shape as queue.js.
const listeners = new Set();
export function onResumeChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function changed(userId) {
  for (const fn of listeners) {
    try { fn(userId); } catch { /* a bad listener must not break a resume */ }
  }
}

/* ------------------------------------------------------------- wording -- */

export function limitLabel(kind) {
  switch (kind) {
    case 'five_hour': return '5-hour limit';
    case 'seven_day': return 'weekly limit';
    case 'seven_day_opus': return 'weekly Opus limit';
    case 'seven_day_sonnet': return 'weekly Sonnet limit';
    default: return 'usage limit';
  }
}

// Relative on purpose: the server does not know the reader's time zone, and a
// clock time in the box's zone is worse than none. The page shows the clock.
function inWords(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 24) return rm ? `${h} h ${rm} min` : `${h} h`;
  const d = Math.floor(h / 24), rh = h % 24;
  return `${d} day${d === 1 ? '' : 's'}${rh ? ` ${rh} h` : ''}`;
}

// The push a stopped turn sends, when it armed one of these.
export function pausedLine(row) {
  const wait = inWords(row.resumeAt - Date.now());
  if (row.source === 'retry') return `The turn hit an error. PlumiChat tries again in ${wait}.`;
  if (row.source === 'guess') return `Paused by a usage limit. PlumiChat checks again in ${wait} and carries on once it can.`;
  return `Paused by your ${limitLabel(row.kind)}. It continues automatically in ${wait}.`;
}

function push(userId, key, project, body) {
  if (!userId) return;
  const q = [];
  if (project) q.push('project=' + encodeURIComponent(project));
  if (key) q.push('c=' + encodeURIComponent(key));
  // A user OBJECT, not the bare id — rawSubs() reads .id, so passing the string
  // would find no subscriptions and send nothing, silently. Same shape as
  // pushIfAway() in runs.js. Best-effort by contract, like every other push here.
  Promise.resolve(sendToUser({ id: userId }, {
    title: 'PlumiChat',
    body,
    tag: 'plumi-resume',
    url: '/' + (q.length ? '?' + q.join('&') : ''),
  })).catch(() => { /* best effort */ });
}

/* ---------------------------------------------------------- the window -- */

/* What the plan's usage looks like right now, from the CLI's own /usage request.
   The prompt is an async generator that never yields, the same trick as
   sdkModels() in models.js: the CLI comes up, answers control requests, and can
   never start a turn. Experimental in the SDK, so every failure is just null —
   "no second opinion" — and the caller goes ahead without it. One request at a
   time, and an answer is reused for half a minute: a reset brings every paused
   conversation due in the same tick. */
const USAGE_CALL = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';
const PROBE_TTL_MS = 30 * 1000;
const PROBE_TIMEOUT_MS = 20 * 1000;
let probeCache = { at: 0, value: null };
let probing = null;

export function probeUsage() {
  if (probeCache.at && Date.now() - probeCache.at < PROBE_TTL_MS) return Promise.resolve(probeCache.value);
  if (probing) return probing;
  probing = (async () => {
    const ac = new AbortController();
    let q = null, value = null, timer = null;
    try {
      q = query({
        prompt: (async function* () { await new Promise(() => {}); })(),
        options: {
          model: 'haiku',
          persistSession: false,
          maxTurns: 1,
          settingSources: [],
          strictMcpConfig: true,
          mcpServers: {},
          abortController: ac,
          // No claude.ai connectors: a probe that only reads a number has no use for
          // them, and connecting them is most of a cold start.
          env: { ...scrubbedEnv(), ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
          stderr: () => {},
        },
      });
      if (typeof q[USAGE_CALL] !== 'function') throw new Error('this engine has no usage request');
      const u = await Promise.race([
        q[USAGE_CALL]({ skipBehaviors: true }),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('usage request timed out')), PROBE_TIMEOUT_MS); }),
      ]);
      if (u && u.rate_limits_available !== false && u.rate_limits && typeof u.rate_limits === 'object') {
        value = u.rate_limits;
      }
    } catch { value = null; }
    finally {
      if (timer) clearTimeout(timer);
      // Always tear the probe down — a leaked CLI is a few hundred MB of this box.
      try { ac.abort(); } catch { /* already gone */ }
      try { await q?.close?.(); } catch { /* already gone */ }
    }
    probeCache = { at: Date.now(), value };
    probing = null;
    return value;
  })();
  return probing;
}

// A model-scoped weekly window only binds a turn on that model.
const SCOPED = { seven_day_opus: /opus/i, seven_day_sonnet: /sonnet/i };

/* The latest reset among the windows that are spent and would stop this turn, or 0
   when none is. With a known `kind` only that window is read: the event that
   stopped the turn named it, and an unrelated window the probe also reports (a
   promotion, another product's allowance) must not hold the work for a week. */
export function spentUntil(rateLimits, { kind, model } = {}, now = Date.now()) {
  if (!rateLimits || typeof rateLimits !== 'object') return 0;
  const names = kind && kind in rateLimits
    ? [kind]
    : ['five_hour', 'seven_day', ...Object.keys(SCOPED).filter((k) => SCOPED[k].test(model || ''))];
  let until = 0;
  for (const name of names) {
    const w = rateLimits[name];
    if (!w || typeof w !== 'object') continue;
    const reset = limitResetMs(w.resets_at ?? w.resetsAt);
    if (Number(w.utilization) >= 100 && reset > now) until = Math.max(until, reset);
  }
  // Nothing real is more than a week and a bit away; a figure that is, is noise.
  return until && until - now < 8 * 24 * 60 * 60 * 1000 ? until : 0;
}

/* ------------------------------------------------------------- arming -- */

// One armed resume per conversation. Re-arming replaces rather than stacks, so a
// turn that stops twice against the same window cannot queue two continuations.
function arm(spec, { key, userId, kind, resetsAt, source, tries = 0, why = '', soon = false }) {
  const now = Date.now();
  const resetMs = limitResetMs(resetsAt);
  let resumeAt;
  if (source === 'retry') resumeAt = now + pick(RETRY_BACKOFF_MS, tries - 1);
  else if (resetMs > now) resumeAt = resetMs + GRACE_MS;
  else if (soon) resumeAt = now + GRACE_MS;   // the plan says it is open already
  else resumeAt = now + pick(LIMIT_BACKOFF_MS, tries);
  const row = {
    key,
    userId: userId || null,
    project: spec.project || '',
    cwd: spec.cwd || '',
    sessionId: spec.sessionId || key,
    model: spec.model || null,
    effort: spec.effort || null,
    fastMode: !!spec.fastMode,
    context1m: !!spec.context1m,
    permissionMode: spec.permissionMode || 'default',
    confineHome: spec.confineHome || null,
    kind: kind || '',                 // 'five_hour' | 'seven_day' | …, for the wording
    resetsAt: resetMs || null,
    resumeAt,
    source: source || 'limit',        // 'limit' | 'probe' | 'guess' | 'retry'
    why: String(why || '').slice(0, 160),
    tries,
    armedAt: now,
    firing: null,                     // { runId, at } while the turn it started runs
  };
  update(COLLECTION, (rows) => [...rows.filter((r) => r.key !== key), row], []);
  changed(row.userId);
  return publicRow(row);
}

function drop(key) {
  const row = rowFor(key);
  if (!row) return;
  update(COLLECTION, (rows) => rows.filter((r) => r.key !== key), []);
  changed(row.userId);
}

/* Called by runs.js when ANY turn ends. Returns the armed row (for the page and
   the push) or null. Async only for the rare stop that did not say when the
   window reopens, where it asks probeUsage — bounded by PROBE_TIMEOUT_MS.

   `run.limitStop` is set from claude.js's `limitPause`: { resetsAt, kind }, with
   resetsAt null when the engine said "limit" but no rejected window came with it.
   `run.resume` is set when this module started the turn: { tries }. */
export async function settleResume(run) {
  const key = run.sessionId || null;
  const ours = run.resume || null;
  if (!key) return null;                       // no session: nothing to continue
  const mine = rowFor(key);
  const ownsRow = mine && mine.firing && mine.firing.runId === run.id;

  // A human Stop is a decision, and the clock does not argue with it.
  if (run.status === 'stopped') {
    if (ownsRow) drop(key);
    return null;
  }

  const spec = { ...run.spec, sessionId: key };
  const who = { key, userId: run.userId || null };
  // A try only FAILED if the turn got nowhere. One the API actually answered did
  // work, and stopping on the limit hours later is the next window running out,
  // not the resume failing — counting those would hand back a long job after a
  // day and a half of perfectly good continuations.
  const progressed = !!(run.modelEv && run.modelEv.source === 'api');
  const tries = ours && !progressed ? ours.tries : 0;

  if (run.limitStop && AUTO) {
    if (tries >= MAX_TRIES) return giveUp(run, key, 'it stopped on the usage limit again after every try');
    const { resetsAt, kind } = run.limitStop;
    if (limitResetMs(resetsAt) > Date.now()) {
      return arm(spec, { ...who, kind, resetsAt, source: 'limit', tries });
    }
    // The engine said "limit" without a rejected window: ask the plan itself.
    const rl = await probeUsage();
    const until = spentUntil(rl, { kind, model: run.model || run.spec?.model });
    if (until) return arm(spec, { ...who, kind: kind || '', resetsAt: until, source: 'probe', tries });
    if (rl) {
      // The plan answered and nothing in it is spent, yet the engine said "limit".
      // Most often the window reopened between the stop and this question (a stop
      // in a window's last seconds), so it looks again in a minute. Arming nothing
      // here was the first cut, and it was the one way the work could silently not
      // carry on. A limit no window explains (a model that needs credits, a monthly
      // spend cap) fails that one try, and the second time it is handed back with a
      // push rather than pouring "continue" into it for hours.
      if (tries) return giveUp(run, key, 'it stopped on a limit that none of the usage windows explains');
      return arm(spec, { ...who, kind: kind || '', resetsAt: null, source: 'guess', tries, soon: true });
    }
    return arm(spec, { ...who, kind: kind || '', resetsAt: null, source: 'guess', tries });
  }

  if (ours && run.status === 'error') {
    if (tries >= MAX_TRIES) return giveUp(run, key, run.errorMsg || 'it kept failing');
    return arm(spec, { ...who, kind: '', resetsAt: null, source: 'retry', tries, why: run.errorMsg || '' });
  }

  if (ownsRow) drop(key);
  return null;
}

function giveUp(run, key, why) {
  const reason = String(why || '').replace(/[.\s]+$/, '');
  console.error(`[resume] ${key}: giving up — ${reason}`);
  drop(key);
  push(run.userId, key, run.project, `PlumiChat could not pick this back up on its own: ${reason}. Send "continue" when you are ready.`);
  return null;
}

// Another turn is starting in this conversation, so it decides now: if it also
// stops on the limit, settleResume arms again from what it reported.
export function releaseResume(key) {
  const row = key ? rowFor(key) : null;
  if (row && !row.firing) drop(key);
}

export function cancelResume(userId, key) {
  const row = rowFor(key);
  if (row && !row.firing && (!userId || row.userId === userId)) drop(key);
  return { ok: true };
}

// Only your own, and only the ones still waiting: a resume whose turn is running
// is that turn now, and the page follows it like any other.
export function resumesFor(userId) {
  return list().filter((r) => (!userId || r.userId === userId) && !r.firing).map(publicRow);
}
export function resumeFor(userId, key) {
  return resumesFor(userId).find((r) => r.key === key) || null;
}
function publicRow(r) {
  return {
    key: r.key, project: r.project, sessionId: r.sessionId, kind: r.kind || '',
    resetsAt: r.resetsAt || null, resumeAt: r.resumeAt, source: r.source || 'limit',
    why: r.why || '', tries: r.tries || 0, armedAt: r.armedAt,
  };
}

/* ------------------------------------------------------------- firing -- */

const inFlight = new Set();     // keys being fired right now (the probe is async)
const waitLogged = new Set();   // keys already logged as waiting for a free slot

function patch(key, fields) {
  update(COLLECTION, (rows) => rows.map((r) => (r.key === key ? { ...r, ...fields } : r)), []);
}

// The account as it is NOW, not as it was when the turn stopped. The parameters
// come from the run, never from a request — and confinement is only ever
// tightened here: a member's turn goes out in 'default' mode inside their home,
// exactly as /api/chat would send it, and a row that cannot prove that is dropped.
function specFor(row) {
  let admin = true;
  if (row.userId) {
    const user = findById(row.userId);
    if (!user) return { refuse: 'the account no longer exists' };
    admin = isAdmin(user);
  }
  const s = {
    project: row.project, cwd: row.cwd, sessionId: row.sessionId || row.key,
    model: row.model || undefined, effort: row.effort || undefined,
    fastMode: !!row.fastMode, context1m: !!row.context1m,
    permissionMode: row.permissionMode || 'default',
    confineHome: row.confineHome || null, userId: row.userId || null,
  };
  if (!admin) {
    if (!s.confineHome) return { refuse: 'a member turn without its confinement' };
    s.permissionMode = 'default';
  }
  return { spec: s };
}

async function fire(row) {
  if (inFlight.has(row.key)) return;
  inFlight.add(row.key);
  try {
    const live = getRun(row.key);
    // Already going? Something else (a person, most likely) got there first, and
    // that turn decides now.
    if (live && live.status === 'running') { drop(row.key); return; }

    // Is the window really open? A retry is about an error, not the window.
    if (row.source !== 'retry') {
      const rl = await probeUsage();
      const until = spentUntil(rl, { kind: row.kind, model: row.model });
      if (until && until + GRACE_MS > row.resumeAt) {
        const cur = rowFor(row.key);
        if (cur && cur.armedAt === row.armedAt && !cur.firing) {
          patch(row.key, { resumeAt: until + GRACE_MS, resetsAt: until, source: 'probe' });
          changed(row.userId);
        }
        return;
      }
    }

    // The probe took a moment: the row may have been cancelled or replaced since.
    const cur = rowFor(row.key);
    if (!cur || cur.armedAt !== row.armedAt) return;
    const still = getRun(row.key);
    if (still && still.status === 'running') { drop(row.key); return; }

    const { spec, refuse } = specFor(cur);
    if (refuse) {
      console.error(`[resume] ${row.key}: dropped — ${refuse}`);
      drop(row.key);
      return;
    }
    // This turn is one more try; settleResume reads it back off the run.
    const tries = (cur.tries || 0) + 1;
    let run;
    try {
      run = startResumed(spec, tries);
    } catch (err) {
      const msg = err?.message || String(err);
      if (/^(You already have|The box is busy with)/.test(msg)) {
        // A wait, not a failure: try again on the next tick, as long as it takes.
        if (!waitLogged.has(row.key)) { waitLogged.add(row.key); console.error(`[resume] ${row.key}: waiting for a free slot — ${msg}`); }
        return;
      }
      if (/^A turn is already running/.test(msg)) { drop(row.key); return; }
      // The budget, or something genuinely wrong: say so, once, and stop.
      console.error(`[resume] ${row.key}: could not start — ${msg}`);
      drop(row.key);
      push(cur.userId, row.key, cur.project, `PlumiChat could not pick this back up on its own: ${msg}`);
      return;
    }
    waitLogged.delete(row.key);
    patch(row.key, { firing: { runId: run.id, at: Date.now() }, tries, restarted: false });
    changed(cur.userId);
    // Told, not asked: the person is most likely not watching, which is the point.
    push(cur.userId, row.key, cur.project,
      cur.restarted ? 'The server restarted in the middle of the paused work, so PlumiChat picked it back up.'
        : cur.source === 'retry' ? 'PlumiChat is trying the paused turn again.'
          : 'Your usage window reset, so the paused turn is running again.');
  } catch (err) {
    console.error(`[resume] ${row.key}: ${err?.message || err}`);
  } finally {
    inFlight.delete(row.key);
  }
}

function tick(boot = false) {
  const now = Date.now();
  for (const row of list()) {
    if (row.firing) {
      const live = getRun(row.key);
      if (live && live.id === row.firing.runId && live.status === 'running') continue;
      // Its run is gone. At boot that is a restart that cut the turn short, and the
      // work is still waiting to be finished: it is due again now. (Its run counted
      // as a try when it started, so a restart loop still ends at MAX_TRIES.) At any
      // other time the run ended without reporting back, which settleResume is
      // there to prevent.
      if (boot && (row.tries || 0) < MAX_TRIES) {
        patch(row.key, { firing: null, resumeAt: now, restarted: true });
        const due = rowFor(row.key);
        if (due) fire(due);
        continue;
      }
      if (boot) {
        console.error(`[resume] ${row.key}: giving up — restarted in the middle of every try`);
        drop(row.key);
        push(row.userId, row.key, row.project, 'PlumiChat could not pick this back up on its own: the server kept restarting in the middle of it. Send "continue" when you are ready.');
      } else if (now - (row.firing.at || 0) > LOST_MS) drop(row.key);
      continue;
    }
    if (now - (row.resumeAt || 0) > STALE_MS) {
      console.error(`[resume] ${row.key}: dropped — its time passed more than two days ago`);
      drop(row.key);
      continue;
    }
    if (now >= row.resumeAt) fire(row);
  }
}

let ticker = null;
export function initResumes() {
  if (ticker) return;
  // Sweep once at boot: a resume whose window opened while the server was down
  // is exactly the case this feature exists for, so it must not wait for the
  // first tick — nor be lost because the process restarted.
  try { tick(true); } catch (err) { console.error('[resume] boot sweep failed:', err); }
  ticker = setInterval(() => {
    try { tick(); } catch { /* keep the timer alive */ }
  }, TICK_MS);
  ticker.unref?.();
}
