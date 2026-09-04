// Out-of-band session control: /context, /rewind and fork, reachable BETWEEN turns.
//
// The SDK puts getContextUsage() and rewindFiles() on a live `Query`, and PlumiChat
// runs one process per turn — which is why the audit filed these under "needs the
// persistent per-conversation process first". It doesn't. A query whose prompt is
// an async generator that never yields still boots the CLI, resumes the transcript
// and answers control requests; it just never runs a turn. That costs a ~1s child
// spawn and ZERO tokens (measured: no API call, the transcript is only read).
// So the buttons work today, on the one-process-per-turn engine, and get faster —
// not different — when the persistent process eventually lands.
//
// forkSession() and getSessionMessages() are plain top-level SDK calls: no query
// at all, they read and rewrite the session JSONL directly.
import { query, forkSession, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { scrubbedEnv } from './claude.js';
import { sessionPaths } from './history.js';

// A control call must not hang the request: the CLI could be slow to boot, or the
// session file could be huge. Past this the query is aborted and the caller gets a
// plain error instead of a socket that never answers.
const CONTROL_TIMEOUT_MS = 45_000;

// Last known context snapshot per session id. Module scope on purpose, exactly like
// claude.js's `lastLimits`: the ring has to say something the instant a conversation
// opens, and the cheapest snapshot is the one the last turn already paid for. The
// map is bounded because a long-lived server would otherwise accumulate one entry
// per conversation ever opened.
const snapshots = new Map();
const SNAPSHOT_CAP = 200;
export function contextSnapshot(sessionId) { return snapshots.get(sessionId) || null; }
function rememberContext(sessionId, usage) {
  if (!sessionId || !usage) return null;
  const norm = normalize(usage);
  if (!norm) return null;
  snapshots.delete(sessionId);
  snapshots.set(sessionId, norm);
  while (snapshots.size > SNAPSHOT_CAP) snapshots.delete(snapshots.keys().next().value);
  return norm;
}
export function forgetContext(sessionId) { snapshots.delete(sessionId); }

// Move the ring on after a finished turn, without spending a CLI spawn on it.
// The SDK's own totalTokens is input + cache_read + cache_creation of the last
// request — verified by reading getContextUsage and the api-usage block it
// returns on the same session (8 + 16845 + 240 = 17093 = totalTokens). So a
// turn's result event already carries the one number the ring's headline needs;
// the category rows it does NOT carry are marked stale rather than rescaled, so
// the breakdown never claims a freshness it doesn't have.
export function touchContext(sessionId, usage) {
  if (!sessionId || !usage) return null;
  const used = (Number(usage.input) || 0) + (Number(usage.cacheRead) || 0) + (Number(usage.cacheWrite) || 0);
  if (!used) return null;
  const prev = snapshots.get(sessionId);
  const max = prev ? prev.max : 0;
  const next = {
    ...(prev || { model: '', categories: [], autoCompactAt: null }),
    used,
    max,
    // Only claim a percentage when a real window is known. Inventing 200k as a
    // default would put a confident number on a model whose window we never read.
    percent: max ? Math.round((used / max) * 100) : null,
    // The bars belong to the last full read, not to this turn.
    categoriesStale: !!(prev && prev.categories && prev.categories.length),
    at: Date.now(),
  };
  snapshots.delete(sessionId);
  snapshots.set(sessionId, next);
  while (snapshots.size > SNAPSHOT_CAP) snapshots.delete(snapshots.keys().next().value);
  return next;
}

// The SDK's response is generous (per-skill, per-MCP-tool, per-agent token counts,
// an api-usage block, a grid meant for the terminal's own renderer). The phone needs
// the headline and the category bars, so flatten to that and keep the percentage the
// SDK computed rather than dividing numbers ourselves — the usage bar already
// shipped once with figures it had invented, and that is not happening again.
function normalize(u) {
  if (!u || typeof u !== 'object') return null;
  const max = Number(u.rawMaxTokens || u.maxTokens || 0) || 0;
  const cats = (Array.isArray(u.categories) ? u.categories : [])
    .map((c) => ({
      name: String((c && c.name) || ''),
      tokens: Number(c && c.tokens) || 0,
      // 'Free space' is the remainder, and deferred rows are out-of-window tool
      // schemas the docs explicitly exclude from usage math. Flag both so the
      // client can render them differently instead of stacking them as "used".
      free: /free space/i.test(String((c && c.name) || '')),
      deferred: !!(c && c.isDeferred),
    }))
    .filter((c) => c.tokens > 0);
  return {
    model: String(u.model || ''),
    used: Number(u.totalTokens) || 0,
    max,
    percent: Number.isFinite(Number(u.percentage)) ? Number(u.percentage) : null,
    autoCompactAt: u.isAutoCompactEnabled ? (Number(u.autoCompactThreshold) || null) : null,
    categories: cats,
    categoriesStale: false,
    at: Date.now(),
  };
}

// One control query per session at a time. Two taps on the ring would otherwise
// boot two CLIs against the same transcript for the same answer.
//
// Exported because the engine-extension controls (server/plugins.js) need exactly
// the same short-lived query. `sessionId` may be null there: with no `resume` the
// CLI boots against the cwd alone and — verified — writes no session file, so
// asking the engine about its MCP servers never leaves a stray conversation.
const inflight = new Map();
export function withSessionControl(cwd, sessionId, fn) {
  const key = `${cwd} ${sessionId || ''}`;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const ac = new AbortController();
    // A prompt that never yields: the SDK is in streaming-input mode, so the child
    // stays up serving control requests and never starts a turn.
    const idle = (async function* () { await new Promise(() => {}); })();
    const q = query({
      prompt: idle,
      options: {
        cwd,
        ...(sessionId ? { resume: sessionId } : null),
        // Rewind can only restore what was checkpointed, and the flag must be on for
        // the process doing the restoring too (claude.js sets it on every turn).
        enableFileCheckpointing: true,
        abortController: ac,
        env: scrubbedEnv(),
      },
    });
    const timer = setTimeout(() => { try { ac.abort(); } catch { /* already gone */ } }, CONTROL_TIMEOUT_MS);
    try {
      return await fn(q);
    } finally {
      clearTimeout(timer);
      try { ac.abort(); } catch { /* already gone */ }
      try { await q.close?.(); } catch { /* already gone */ }
    }
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// --- Public API -------------------------------------------------------------

// The context report. `detail: 'summary'` answers from the last response's usage
// plus local estimates — no per-category token-count API calls, so reading the ring
// never costs the user money.
export async function readContext(projectName, sessionId, user) {
  const { cwd } = sessionPaths(projectName, sessionId, user);
  const raw = await withSessionControl(cwd, sessionId, (q) => q.getContextUsage({ detail: 'summary' }));
  return rememberContext(sessionId, raw);
}

// User messages, oldest first, as rewind targets. rewindFiles() keys off a user
// message UUID, so the picker needs the uuid the SDK's own log carries — never an
// index we made up.
export async function rewindPoints(projectName, sessionId, user, limit = 40) {
  const { cwd } = sessionPaths(projectName, sessionId, user);
  const msgs = await getSessionMessages(sessionId, { dir: cwd });
  const out = [];
  for (const m of Array.isArray(msgs) ? msgs : []) {
    if (!m || m.type !== 'user' || !m.uuid) continue;
    const c = m.message && m.message.content;
    const text = typeof c === 'string'
      ? c
      : (Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ') : '');
    const trimmed = String(text || '').trim();
    // Tool results and meta entries ride in as 'user' messages with no prose;
    // they are not things a human recognises as "a message I sent".
    if (!trimmed) continue;
    out.push({
      id: m.uuid,
      at: Date.parse(m.timestamp || '') || null,
      text: trimmed.length > 160 ? trimmed.slice(0, 160) + '…' : trimmed,
    });
  }
  return out.slice(-limit);
}

// Preview (dryRun) or perform a file rewind. The preview is what makes this safe to
// put on a phone: you see the file list and the +/- counts before anything is touched.
export async function rewind(projectName, sessionId, user, messageId, { dryRun = true } = {}) {
  if (!messageId) throw new Error('messageId is required');
  const { cwd } = sessionPaths(projectName, sessionId, user);
  const res = await withSessionControl(cwd, sessionId, (q) => q.rewindFiles(String(messageId), { dryRun: !!dryRun }));
  return {
    dryRun: !!dryRun,
    canRewind: !!(res && res.canRewind),
    error: (res && res.error) || null,
    files: (res && res.filesChanged) || [],
    insertions: (res && res.insertions) || 0,
    deletions: (res && res.deletions) || 0,
    skippedLinks: (res && res.skippedLinks) || 0,
  };
}

// Branch a conversation. The SDK copies the transcript into a new session file with
// fresh UUIDs, so the original is untouched and both are independently resumable.
// `upToMessageId` branches from a point instead of the end — "go back and try again
// from here" without losing what actually happened.
export async function fork(projectName, sessionId, user, { upToMessageId, title } = {}) {
  const { cwd } = sessionPaths(projectName, sessionId, user);
  const opts = { dir: cwd };
  if (upToMessageId) opts.upToMessageId = String(upToMessageId);
  if (title) opts.title = String(title).slice(0, 120);
  const res = await forkSession(sessionId, opts);
  if (!res || !res.sessionId) throw new Error('fork produced no session');
  return { sessionId: res.sessionId };
}
