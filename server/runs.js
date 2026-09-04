// Run manager — decouples an agent turn's lifecycle from the HTTP request that
// started it. A "run" keeps streaming on the server even if the browser
// disconnects (page refresh, navigation, network blip); clients (re)attach via
// SSE to follow it, can stop it on demand, and are told *why* it ended. This is
// what makes a turn survive a refresh instead of being silently aborted.
//
// In-memory only (single-user personal tool): runs reset on process restart,
// which is fine — finished turns are already persisted to the SDK's session log.
import { randomUUID } from 'node:crypto';
import { runPrompt, makeMemberPolicy, makeMemberSandbox, memberTurnsSupported } from './claude.js';
import { platformLabel } from './platform.js';
import { generateTitle, setAutoTitle, getAutoTitle, sdkTitle } from './titles.js';
import { touchContext } from './context.js';
import { recordTurn, spendGate } from './spend.js';
import { sendToUser } from './push.js';

const runs = new Map();          // key (sessionId | tempId) -> Run
const asks = new Map();          // askId -> { run, resolve }
const sessionAllow = new Map();  // sessionId -> Set<toolName>  ("allow always")
const SESSION_ALLOW_MAX = 500;   // bound the per-conversation allow-list cache
const TRANSCRIPT_CAP = 8000;     // bound the per-run replay buffer (entries)
// …and bound it by SIZE too. Entries are wildly uneven — a coalesced text run or a
// Write tool call carries kilobytes while a task row carries bytes — so an entry
// count alone let a long thinking stream evict the answer that followed it.
const TRANSCRIPT_CHARS_MAX = 1_500_000;
const TRIM_MARK = '(earlier output trimmed)';

let nextRunId = 1;

// Keep an ended run around so a client that attaches late still receives the
// final ended/done and the stop reason. Ten minutes, not one: on iOS the page is
// suspended the moment the phone locks, and the turn it started has to still be
// collectable when the screen comes back on.
const CLEANUP_MS = 10 * 60 * 1000;

// Concurrency caps (audit H6). Each turn is a ~340 MB CLI process on a 5.9 GB
// box, and nothing used to count them: owner + members + the ops runner could all
// pile on until the machine swapped and the remote lifeline went with it.
const MAX_RUNS_PER_USER = Math.max(1, Number(process.env.PLUMI_MAX_RUNS_PER_USER) || 2);
const MAX_RUNS = Math.max(1, Number(process.env.PLUMI_MAX_RUNS) || 5);

// How long a parked permission/question prompt waits for a human. It used to wait
// forever, so one approval card missed on a locked phone wedged that conversation
// permanently — no turn could start while the old one held the session.
const ASK_TIMEOUT_MS = Math.max(60 * 1000, Number(process.env.PLUMI_ASK_TIMEOUT_MS) || 30 * 60 * 1000);

// Move a run from its temporary key to its real session id once the SDK assigns
// one. Live subscribers hold a direct reference to the run, so they keep getting
// events; only the lookup key changes (so future attaches use the session id).
function rekey(run, sessionId) {
  if (run.key && runs.get(run.key) === run) runs.delete(run.key);
  run.sessionId = sessionId;
  run.key = sessionId;
  runs.set(sessionId, run);
  if (!sessionAllow.has(sessionId)) sessionAllow.set(sessionId, run.allowAlways);
}

// Once a brand-new conversation has BOTH a session id and a generated title,
// persist the title and push it to subscribers as a 'title' event so the drawer
// re-titles live — no manual refresh. The title is generated in parallel with
// the turn (started in startRun), so it's usually ready well before the turn
// ends. Wired exactly once per run; safe to call repeatedly.
function maybePushTitle(run) {
  if (!run.titleGen || run.titleWired || !run.sessionId) return;
  run.titleWired = true;
  const sid = run.sessionId;
  run.titleGen.then((t) => {
    if (!t) return;
    if (!getAutoTitle(sid)) setAutoTitle(sid, t);
    emit(run, { type: 'title', sessionId: sid, title: t });
  }).catch(() => {});
}

// Events worth replaying to a client that (re)attaches mid-turn. 'result' is in
// the list so the cost/usage badge survives a reattach, and 'waiting'/'task' so
// the agents tray rebuilds itself instead of coming back empty. session / model /
// title / ask / ended / done are replayed explicitly by subscribe() instead.
const BUFFERED = new Set(['text', 'thinking', 'tool', 'notice', 'result', 'waiting', 'task', 'limits', 'context']);
// Deltas arrive one per token, so both streaming kinds are coalesced into the
// previous entry of the same kind — one entry per paragraph-run, not per token.
const COALESCED = new Set(['text', 'thinking']);

// Roughly how much of the character budget an entry costs. Text/thinking is its
// own string; anything else pays for its serialized form, which is what actually
// matters for a tool call carrying a file's contents as its input.
function evSize(ev) {
  if (COALESCED.has(ev.type)) return (ev.text || '').length;
  try { return JSON.stringify(ev).length; } catch { return 0; }
}

// Record a renderable event into the run's replay buffer. Capped two ways — see
// TRANSCRIPT_CAP / TRANSCRIPT_CHARS_MAX — and when anything is dropped the client
// is told so, once, at the front of the replay: silently losing the start of a
// turn reads like a bug, whereas a marker reads like a limit.
function bufferEvent(run, event) {
  const t = event.type;
  if (!BUFFERED.has(t)) return;
  const buf = run.transcript;
  const last = buf[buf.length - 1];
  if (COALESCED.has(t) && last && last.type === t) {
    last.text += event.text || '';
    run.chars += (event.text || '').length;
  } else {
    const entry = COALESCED.has(t) ? { type: t, text: event.text || '' } : event;
    buf.push(entry);
    run.chars += evSize(entry);
  }

  let trimmed = false;
  const drop = () => {
    const [gone] = buf.splice(0, 1);
    // The marker is never counted, so never uncount it either.
    if (!(gone && gone.type === 'notice' && gone.text === TRIM_MARK)) run.chars -= evSize(gone);
    trimmed = true;
  };
  while (buf.length > TRANSCRIPT_CAP) drop();
  while (run.chars > TRANSCRIPT_CHARS_MAX && buf.length > 1) drop();
  if (trimmed && !(buf[0] && buf[0].type === 'notice' && buf[0].text === TRIM_MARK)) {
    buf.unshift({ type: 'notice', text: TRIM_MARK });
  }
}

// Web Push for the two moments that have to reach a LOCKED phone: a turn that
// finished, and a turn parked on an approval card. The page's own Notification
// can only fire while the page is alive, which on iOS it is not from the instant
// the screen locks — that is the entire reason server/push.js exists, and until
// now nothing called it.
//
// Gate: only when NOTHING is attached to this run. A client holding a live SSE
// pipe is awake enough to raise its own ping (and it checks document.hidden
// first), so pushing as well would banner someone staring at the answer.
//
// "Attached" only means "watching" because the page now hangs up deliberately the
// moment it goes into the background (public/app.js parkStreams) instead of
// leaving a socket that a locked phone keeps half-open for minutes — which is what
// used to swallow the push in exactly the case it exists for.
//
// `stillWorth`, when given, buys ONE re-check a few seconds later for a subscriber
// that was attached at call time: long enough for a TCP teardown to reach us, short
// enough for the ping to still be timely, and only fired if the moment is still
// worth interrupting for. It is deliberately NOT used for "the turn finished": a
// finished SSE response ends itself, so its socket closes a beat later either way
// and a re-check could not tell a delivered ending from a missed one — it would
// simply banner everyone who sat and watched their own answer arrive. It IS used
// for an approval card, which the turn parks on indefinitely: there, a socket that
// disappears seconds later really does mean nobody is looking.
// Never awaited and never throws: a notification must never be able to fail the
// turn that triggered it.
const PUSH_RECHECK_MS = 6000;
function pushIfAway(run, body, tag, stillWorth) {
  const fire = () => {
    const q = [];
    if (run.project) q.push('project=' + encodeURIComponent(run.project));
    if (run.key) q.push('c=' + encodeURIComponent(run.key));
    Promise.resolve(sendToUser({ id: run.userId }, {
      // The conversation's own title, exactly as the page titles its foreground
      // ping, so the two read identically.
      title: (run.sessionId && getAutoTitle(run.sessionId)) || 'PlumiChat',
      body,
      // The page uses 'plumi-turn-done' for its own pings; sharing the tag means a
      // push and a foreground ping for one turn replace each other, never stack.
      tag: tag || 'plumi-turn-done',
      // The shape public/sw.js already parses back into {project, key} (targetUrl).
      url: q.length ? '/?' + q.join('&') : '/',
    })).catch(() => { /* push is best-effort by contract */ });
  };
  if (!run.subs.size) { fire(); return; }
  if (!stillWorth) return;                      // a passing moment — attached means watching
  const t = setTimeout(() => {
    if (run.subs.size) return;                  // still genuinely being watched
    if (!stillWorth()) return;                  // answered in the meantime
    fire();
  }, PUSH_RECHECK_MS);
  t.unref?.(); // six seconds must never hold the process open at shutdown
}

// Bookkeeping + fan-out to every attached subscriber. A dead subscriber must
// never break the run or its other subscribers.
function emit(run, event) {
  if (event.type === 'session' && event.sessionId) {
    if (run.sessionId !== event.sessionId) rekey(run, event.sessionId);
    maybePushTitle(run); // session id is now known → push the AI title once it's ready
  } else if (event.type === 'model' && event.model) {
    // Remember the whole event (model + source + requested) so a reattaching
    // client learns it too. Latest wins: 'api' upgrades the earlier 'init'.
    run.model = event.model;
    run.modelEv = event;
  } else if (event.type === 'error' && event.message) {
    run.errorMsg = event.message;
  } else if (event.type === 'result') {
    // Meter it. Before this, the workspace budget in Settings was a note to self:
    // every turn reported what it cost and nothing added it up (see spend.js).
    recordTurn({
      userId: run.userId,
      usd: event.costUsd,
      tokens: event.usage ? (event.usage.input || 0) + (event.usage.output || 0) : 0,
    });
  }
  if (event.type === 'result' && event.usage) {
    // A finished turn already carries the number the context ring's headline needs
    // (see touchContext), so the ring moves without anyone paying for a CLI spawn.
    // Emitted as its own small event rather than folded into 'result' so a client
    // that doesn't draw a ring can keep ignoring it.
    const snap = touchContext(event.sessionId || run.sessionId, event.usage);
    if (snap) {
      bufferEvent(run, event);
      for (const send of run.subs) { try { send(event); } catch { /* ignore a broken subscriber */ } }
      event = { type: 'context', sessionId: event.sessionId || run.sessionId, context: snap };
    }
  }
  bufferEvent(run, event);
  for (const send of run.subs) {
    try { send(event); } catch { /* ignore a broken subscriber */ }
  }
}

// Start a detached turn and return its Run. Throws if a turn is already running
// for the same conversation (one in-flight turn per conversation).
export function startRun({ project, cwd, prompt, sessionId, model, effort, fastMode, context1m, permissionMode, confineHome, userId }) {
  if (sessionId) {
    const existing = runs.get(sessionId);
    if (existing && existing.status === 'running') {
      throw new Error('A turn is already running for this conversation.');
    }
  }
  // Members are confined by an OS sandbox, so on a platform that has none there is
  // no safe way to run their turn at all. Refuse HERE, with a sentence an operator
  // can act on, rather than letting the SDK fail mid-turn on failIfUnavailable —
  // and never by silently dropping the sandbox, which would turn a confined member
  // into an unconfined shell on the owner's machine.
  if (confineHome && !memberTurnsSupported()) {
    throw new Error(
      `Member turns need an OS sandbox, which ${platformLabel()} does not provide. `
      + 'Run this as an owner-only install, or host it on Linux or macOS. See docs/SECURITY.md.',
    );
  }

  // The workspace budget, which until now was a note the owner wrote to themselves.
  // Checked BEFORE the resource caps because it is the more absolute of the two:
  // a cap says "not right now", a spent budget says "not until you decide
  // otherwise". Settings keeps working while this refuses, so the way out is one
  // screen away.
  const budget = spendGate();
  if (budget) throw new Error(budget);

  // Resource guard (H6): refuse rather than let the box thrash. Same throw shape
  // as the duplicate-conversation case above, which index.js maps to a 409, so
  // the client already knows how to show it.
  let live = 0, mine = 0;
  for (const r of runs.values()) {
    if (r.status !== 'running') continue;
    live++;
    if (userId && r.userId === userId) mine++;
  }
  if (userId && mine >= MAX_RUNS_PER_USER) {
    throw new Error(`You already have ${mine} turn${mine === 1 ? '' : 's'} running — stop one first.`);
  }
  if (live >= MAX_RUNS) {
    throw new Error(`The box is busy with ${live} turns — wait for one to finish and try again.`);
  }

  const id = 'run:' + (nextRunId++);
  const allowAlways = (sessionId && sessionAllow.get(sessionId)) || new Set();
  if (sessionId) sessionAllow.set(sessionId, allowAlways);
  // Bound the cache: evict the oldest conversations' allow-lists (Map iterates
  // in insertion order) so it can't grow forever across months of chats.
  while (sessionAllow.size > SESSION_ALLOW_MAX) {
    sessionAllow.delete(sessionAllow.keys().next().value);
  }

  const run = {
    id,
    key: sessionId || id,
    project,
    userId: userId || null,
    // Everything needed to run this turn AGAIN, unchanged. server/resume.js
    // re-issues it verbatim when a usage window reopens, so the continuation
    // lands on the same project, model, effort and approval mode the person was
    // actually working in — not on whatever the defaults happen to be hours
    // later. Kept here because startRun's arguments are otherwise unrecoverable
    // once the turn has ended.
    spec: { project, cwd, sessionId: sessionId || null, model, effort,
            fastMode: !!fastMode, context1m: !!context1m,
            permissionMode: permissionMode || 'default',
            confineHome: confineHome || null, userId: userId || null },     // who started it — for per-user attach/stop checks
    model: null,                // the real model the API reported for this turn
    modelEv: null,              // full model event (source: 'init'|'api', requested)
    sessionId: sessionId || null,
    status: 'running',          // 'running' | 'done' | 'error' | 'stopped'
    reason: null,               // human-readable end reason (stopped/error)
    errorMsg: null,             // captured from any {type:'error'} event
    stopReason: null,           // set by stopRun()
    stalled: false,             // ended by the background-wait valve, not by a human
    endedEv: null,              // the exact 'ended' event, replayed to late attachers
    subs: new Set(),            // active SSE senders
    transcript: [],             // buffered progress events (replayed to new subscribers)
    chars: 0,                   // running size of `transcript` (see TRANSCRIPT_CHARS_MAX)
    openAsks: new Map(),        // askId -> ask event (replayed to new subscribers)
    abort: new AbortController(),
    allowAlways,
    startedAt: Date.now(),
    endedAt: null,              // set in the finally block; reported by listRuns()
    cleanupTimer: null,
  };
  runs.set(run.key, run);

  // Brand-new conversation → summarize the first request into a short drawer
  // title in the background, overlapping the turn so it's usually ready by the
  // time the turn finishes (persisted in the finally block, against the session
  // id the SDK assigns). Resumed conversations keep their existing title, which
  // is derived from turn one. generateTitle never throws (resolves '' on failure).
  run.titleGen = (!sessionId && prompt && String(prompt).trim()) ? generateTitle(prompt) : null;

  // Permission / question prompts: park a resolver and surface an 'ask' event.
  // Keep it in openAsks so a client that (re)attaches mid-prompt sees it again.
  // Ids are unguessable (UUID) and each ask remembers its run, so /api/respond
  // can verify the answerer actually owns the conversation being prompted.
  const askUser = (request) => new Promise((resolve) => {
    const askId = randomUUID();
    const ev = { type: 'ask', id: askId, kind: request.kind, tool: request.tool, input: request.input };
    // Nobody home? Dismiss it (resolve null = "denied / not answered") rather than
    // park the turn forever — the agent gets a clear refusal it can respond to,
    // and the conversation is usable again. unref'd so it never holds the process.
    let timer = setTimeout(() => {
      timer = null;
      const a = asks.get(askId);
      if (!a) return;
      const mins = Math.round(ASK_TIMEOUT_MS / 60000);
      emit(run, {
        type: 'notice', phase: 'done',
        text: `No answer after ${mins} minute${mins === 1 ? '' : 's'} — the request was dismissed.`,
      });
      a.resolve(null);
    }, ASK_TIMEOUT_MS);
    timer.unref?.();
    asks.set(askId, {
      run,
      resolve: (value) => {
        if (timer) { clearTimeout(timer); timer = null; }
        asks.delete(askId); run.openAsks.delete(askId); resolve(value);
      },
    });
    run.openAsks.set(askId, ev);
    emit(run, ev);
    // The turn is now blocked on a human, and it gives up after ASK_TIMEOUT_MS —
    // so this is the other moment worth waking a phone for, not just the ending.
    pushIfAway(
      run,
      request.kind === 'question'
        ? 'Claude is asking you something.'
        : 'Claude needs your permission to continue.',
      'plumi-ask',
      // Only still worth a banner if the card is genuinely unanswered when the
      // re-check runs — six seconds is plenty of time to have tapped Allow.
      () => run.openAsks.has(askId),
    );
  });

  const onEvent = (event) => emit(run, event);

  // Members run hard-confined to their home. Their Bash is ALLOWED but wrapped
  // in an OS sandbox (makeMemberSandbox) that confines all writes to that
  // home — this is what lets the document Skills run code without risking the
  // owner's files. The owner/admin gets the normal interactive policy (built
  // inside runPrompt when canUseTool is omitted) and no sandbox.
  const sandbox = confineHome ? makeMemberSandbox(confineHome) : undefined;
  const canUseTool = confineHome
    ? makeMemberPolicy({ home: confineHome, askUser, allowAlways, sandboxed: true })
    : undefined;

  // Detached IIFE: the turn is NOT tied to any one request/response.
  (async () => {
    let outcome = null;
    try {
      outcome = await runPrompt({
        prompt, cwd, sessionId, model, effort, fastMode, context1m, permissionMode,
        onEvent, askUser, allowAlways, abortController: run.abort, canUseTool, sandbox,
      });
    } catch (err) {
      if (!run.errorMsg) run.errorMsg = err?.message || String(err);
    } finally {
      // The background-wait safety valve fired: a background agent went silent (or
      // the absolute ceiling hit) and claude.js aborted to end the turn. That IS an
      // abort, so the status stays 'stopped' and the Continue button still shows —
      // but it was not the user's Stop, and reporting it as a bare "Stopped" reads
      // like they did it themselves. Their own Stop still wins if both happened.
      if (outcome && outcome.stalled) run.stalled = true;
      // runPrompt swallows SDK errors (emits {type:'error'}) and is silent on
      // abort, so derive the final status here.
      run.status = run.abort.signal.aborted
        ? 'stopped'
        : (run.errorMsg ? 'error' : 'done');
      run.reason = run.status === 'stopped'
        ? (run.stopReason || (run.stalled ? outcome.reason : 'Stopped'))
        : (run.status === 'error' ? (run.errorMsg || 'error') : null);
      // Release anything still waiting on the human.
      for (const askId of [...run.openAsks.keys()]) {
        const a = asks.get(askId);
        if (a) a.resolve(null);
      }
      // Make sure the AI title (new conversations) is persisted AND pushed before
      // we signal 'done', so the client's post-turn refresh already reflects it
      // even if it never caught the live 'title' event. Bounded wait: a slow or
      // failed title call must never hold up the turn. maybePushTitle does the
      // live emit; the await + store here is the belt-and-suspenders fallback.
      if (run.titleGen && run.sessionId) {
        maybePushTitle(run);
        const sid = run.sessionId;
        try {
          // Prefer the CLI's own title if it wrote one during this turn: that's
          // the exact name the terminal shows for the session, so the two agree
          // instead of drifting. Our Haiku title is the stand-in for when it
          // hasn't — which is most first turns, since the CLI titles lazily.
          const sdk = await sdkTitle(sid, cwd);
          const t = sdk || await Promise.race([
            run.titleGen,
            new Promise((res) => setTimeout(() => res(''), 3000)),
          ]);
          if (t && (sdk || !getAutoTitle(sid))) {
            setAutoTitle(sid, t);
            // maybePushTitle already emitted the Haiku one; only a better,
            // SDK-sourced title is worth correcting the drawer for.
            if (sdk) emit(run, { type: 'title', sessionId: sid, title: t });
          }
        } catch { /* never block done on a title failure */ }
      }
      run.endedAt = Date.now();
      // Kept whole so subscribe() replays the SAME ending a live subscriber got,
      // `stalled` flag and all, instead of rebuilding a lesser copy of it.
      run.endedEv = { type: 'ended', status: run.status, reason: run.reason, stalled: !!run.stalled };
      emit(run, run.endedEv);
      emit(run, { type: 'done' });
      // "Ping me when done", for a phone that stopped listening. Emitted after
      // 'ended' so the wording matches the outcome we just derived, and after
      // 'done' so a slow push can never delay the turn's own completion.
      pushIfAway(run,
        run.stalled ? `The turn ended — ${run.reason}.`
          : run.status === 'stopped' ? 'The turn was stopped.'
            : run.status === 'error' ? 'The turn hit an error.'
              : 'Your task is ready.');
      run.cleanupTimer = setTimeout(() => {
        if (runs.get(run.key) === run) runs.delete(run.key);
      }, CLEANUP_MS);
      run.cleanupTimer.unref?.(); // 10 minutes is long enough to matter at shutdown
    }
  })();

  return run;
}

// Attach a sender to a run. Brings a fresh/refreshed client up to speed (session
// id + any open prompts), and if the run already ended, replays ended/done so
// the client terminates cleanly. Returns an unsubscribe fn, or null if no run.
export function subscribe(key, send) {
  const run = runs.get(key);
  if (!run) return null;

  if (run.sessionId) send({ type: 'session', sessionId: run.sessionId });
  if (run.modelEv) send(run.modelEv); // carries source ('init'|'api') + requested
  else if (run.model) send({ type: 'model', model: run.model });
  // Replay everything streamed so far this turn (text/tools/notices), THEN the
  // open prompts — so a reattaching client rebuilds the in-flight turn in order
  // instead of seeing only what arrives after it connects.
  for (const ev of run.transcript) send(ev);
  for (const ev of run.openAsks.values()) send(ev);

  if (run.status !== 'running') {
    send(run.endedEv || { type: 'ended', status: run.status, reason: run.reason });
    send({ type: 'done' });
    return () => {};
  }
  run.subs.add(send);
  return () => { run.subs.delete(send); };
}

// Answer a parked permission/question prompt. Returns false if unknown/expired.
export function respondAsk(id, response) {
  const a = asks.get(id);
  if (!a) return false;
  a.resolve(response || null);
  return true;
}

// The run a pending prompt belongs to (for ownership checks), or null.
export function askRun(id) {
  const a = asks.get(id);
  return a ? a.run : null;
}

// Manually stop a running turn. The reason is surfaced to the client as the end
// reason. Returns false if there's no running turn for this key.
export function stopRun(key, reason) {
  const run = runs.get(key);
  if (!run || run.status !== 'running') return false;
  run.stopReason = reason || 'Stopped by you';
  run.abort.abort();
  return true;
}

// Snapshot of all known runs — RUNNING ones to reattach to, and recently ENDED
// ones (kept for CLEANUP_MS) so a phone that was asleep when a turn finished can
// still collect how it ended instead of showing a half-written answer forever.
export function listRuns() {
  const out = [];
  for (const run of runs.values()) {
    out.push({
      key: run.key, id: run.id, project: run.project, sessionId: run.sessionId,
      status: run.status, userId: run.userId,
      reason: run.reason, startedAt: run.startedAt, endedAt: run.endedAt,
    });
  }
  return out;
}

export function getRun(key) { return runs.get(key); }
