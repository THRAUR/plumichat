// Operations, native backend — the thin layer over Claude Code's OWN background
// sessions (`claude --bg --worktree`, `claude agents --json`, `logs`, `stop`, `rm`).
//
// WHY THIS EXISTS (audit F10). server/operations.js hand-rolls the whole
// process lifecycle a background agent needs: worktree creation, isolation,
// abort plumbing, a run registry, leak pruning. The CLI on this box now ships
// all of it. This module lets a task opt IN to that native machinery while
// operations.js keeps the parts no CLI has an opinion about — the approval gate,
// the fail-closed apply, the attributed commit scope, the test gate, the phone UI.
//
// NOTHING HERE IS THE DEFAULT. operations.js runs the in-process Agent SDK path
// unless a task explicitly carries runner: 'native'.
//
// ── What was probed, and what it actually does (CLI 2.1.258/2.1.259, 2026-09-03)
// The audit's flag spelling was wrong; these are the verified ones. Every claim
// below was checked in a throwaway repo under /tmp, not against a real project.
//
//   $ claude --bg --worktree op_x --model haiku --permission-mode acceptEdits \
//            --restricted --effort low -n "PlumiChat op_x" -- "<prompt>"
//   Starting background service…
//   backgrounded · 3bc8db4b · PlumiChat op_x
//
//   • The short id is the FIRST 8 CHARS of the session uuid, and `--session-id` is
//     REFUSED with `--bg` ("--bg manages the session id; ignoring --session-id"),
//     so we cannot pre-assign it. We parse it from stdout AND confirm it against
//     `claude agents --json` by our unique `-n` name + a start-time window.
//   • The worktree is always `<repo>/.claude/worktrees/<name>` on branch
//     `worktree-<name>`, cut from HEAD, and git-LOCKED while the session lives.
//   • `claude agents --json` (no TTY needed) returns rows shaped:
//       { pid?, id?, cwd, kind: 'background'|'interactive', startedAt, sessionId,
//         name, status?: 'busy'|'idle'|'waiting', state?: 'working'|'done'|
//         'blocked'|'stopped'|'failed' }
//     `id` and `state` exist only on background rows — an interactive session
//     (the owner's terminal, or PlumiChat's own parent) has neither, which is why
//     every read here filters on kind + id before it trusts a row.
//     `cwd` is the WORKTREE while the session is alive and flips back to the
//     project directory once it stops, so cwd is never used as an identity key.
//   • `state` is partly derived from the agent's own output text (the binary
//     regex-matches result/blocked/failed markers), so it is a hint, not a
//     contract. `status: 'busy'` is the reliable "still working" signal, and the
//     verdict below only settles after two consecutive non-busy observations.
//   • `claude logs <id>` prints the raw ANSI TUI screen dump — cursor moves, SGR
//     colours, redraw frames. It is unusable as text. The clean source is the
//     session's own JSONL transcript, which we parse instead (see readTranscript).
//   • `claude stop <id>` really does halt a working session: the pid disappears,
//     state becomes 'stopped', and file writes stop (verified by watching a
//     40-file write loop freeze at 0 files).
//   • `claude rm <id>` REFUSES to delete the worktree whenever it has uncommitted
//     changes or unpushed commits — which is PlumiChat's normal state by design, the
//     diff is meant to be reviewed before anything is committed. It still exits 0
//     and prints "kept <id>". So PlumiChat must tear the worktree down itself
//     (`git worktree remove --force --force`, which is what overrides the CLI's
//     lock, then `prune`, then `git branch -D worktree-<name>` — the branch
//     survives worktree removal) and only then call `rm` to clear the job state.
//   • A missing id is NOT an error exit: `claude stop|rm|logs zzzzzzzz` prints
//     "No job matching …" and exits 0. Nothing here may key off exit codes alone.
//
// ── Confinement
// The SDK path enforces safety with a canUseTool policy (writes inside the
// worktree, Bash denied). A native session has no such hook, so confinement moves
// to the CLI's own `--restricted`, which was verified to do the same job:
//     Write /tmp/…/OUTSIDE.txt → "… is outside <worktree>; --restricted confines
//                                 the file tools to the working directory."
//     Bash "echo hi"           → "No such tool available: Bash. Bash is disabled
//                                 for this session, in subagents as well as here."
// `--permission-mode acceptEdits` is paired with it so edits inside the worktree
// do not sit at a permission prompt with no human to answer it. Turning
// PLUMI_OPS_NATIVE_RESTRICTED off removes the ONLY confinement a native run has;
// it exists for debugging, not for routine use.
//
// ── Fail closed
// Every function here either succeeds or throws/returns a reason. There is no
// path that leaves a caller waiting on a state that never arrives: the capability
// probe refuses up front when the CLI is missing, too old or shaped differently,
// and the caller's poll loop is bounded by an absolute ceiling.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { scrubbedEnv } from './claude.js';

const pexec = promisify(execFile);

// The CLI to drive. Overridable so the capability probe can be exercised against
// a deliberately broken binary in a test, and so a box with a non-PATH install
// can point at it without editing code.
const CLI = process.env.PLUMI_OPS_CLAUDE_BIN || 'claude';
// Oldest CLI whose `--bg` / `agents --json` surface we have actually verified.
// Below this we refuse rather than guess: the flags moved once already (the audit
// recorded `--spawn worktree`, which no installed version accepts).
const MIN_CLI = [2, 1, 0];
// A background session's own worktree, relative to the project. Hard-coded in the
// CLI (it refuses a symlinked `.claude` or `.claude/worktrees`), so it is safe to
// derive rather than discover — but we still verify the directory exists.
const WT_SEGMENTS = ['.claude', 'worktrees'];
// Session names PlumiChat gives its own runs. The prefix is how a stray session is
// recognisable in `claude agents` output, and how we re-find our own id.
const NAME_PREFIX = 'PlumiChat ';
// Only ever pass a task id we generated: op_ + 12 hex (see newId in operations.js).
// This is belt-and-braces on top of execFile's literal argv — a worktree name
// becomes a git branch and a directory, and neither should ever see free text.
const TASK_ID_RE = /^op_[0-9a-f]{12}$/;

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
// How often the caller should ask `claude agents --json` how the run is going.
export const NATIVE_POLL_MS = num(process.env.PLUMI_OPS_NATIVE_POLL_MS, 5000);
// Absolute ceiling on one native run. Nothing here can hang past this: the poll
// loop gives up, stops the session and reports the deadline as the reason.
export const NATIVE_MAX_MS = num(process.env.PLUMI_OPS_NATIVE_MAX_MS, 2 * 60 * 60 * 1000);
// How long `claude --bg` itself may take to come back with an id (it may have to
// boot the background service first — "Starting background service…").
const START_TIMEOUT_MS = num(process.env.PLUMI_OPS_NATIVE_START_MS, 120 * 1000);
// Short, bounded timeouts for the read/stop/rm commands — none of them should be
// slow, and a wedged CLI must not wedge the runner (or, for the sync variants
// used on cleanup paths, the boot).
const QUERY_TIMEOUT_MS = 20 * 1000;
const ADMIN_TIMEOUT_MS = 45 * 1000;
// Cap on how much transcript we parse. JSONL grows with tool results; we only
// need the assistant text and the tool names, so a tail is enough for anything
// pathological (and the tail is cut back to a line boundary before parsing).
const TRANSCRIPT_CAP = 16 * 1024 * 1024;
// `--restricted` is the confinement. Opt out only for debugging.
const RESTRICTED = process.env.PLUMI_OPS_NATIVE_RESTRICTED !== '0';

/* ── Environment ─────────────────────────────────────────────────────────
 * scrubbedEnv() already strips PlumiChat's secrets and the CLAUDE_CODE_* markers a
 * parent Claude session leaks into the server (see server/claude.js — the leak
 * that broke member turns). The CLI child needs one thing more: the messaging
 * handles that mark a process as the CHILD of a live SDK session. PlumiChat is
 * routinely started from inside a Claude session, so those can be present in
 * process.env, and handing them to a brand-new independent background session
 * points it at a socket that belongs to someone else's turn.
 */
const CHILD_LINK_ENV = [
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID',
];
function cliEnv() {
  const env = scrubbedEnv();
  for (const k of CHILD_LINK_ENV) delete env[k];
  return env;
}

function run(args, opts = {}) {
  return pexec(CLI, args, {
    env: cliEnv(),
    timeout: opts.timeout || QUERY_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    cwd: opts.cwd,
  });
}

// Sync variant for the cleanup paths (boot recovery, task deletion) that mirror
// operations.js's own execFileSyncQuiet idiom. Swallows everything: a cleanup
// command that fails must never take down the caller.
function runQuiet(args) {
  try {
    execFileSync(CLI, args, {
      env: cliEnv(), timeout: ADMIN_TIMEOUT_MS, stdio: 'ignore', maxBuffer: 4 * 1024 * 1024,
    });
    return true;
  } catch { return false; }
}

function gitQuiet(cwd, args) {
  try {
    execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore', timeout: ADMIN_TIMEOUT_MS });
    return true;
  } catch { return false; }
}

/* ── Names and paths ─────────────────────────────────────────────────────
 * All three are pure functions of a validated task id, so a caller can compute
 * where a run's artifacts are without asking the CLI (which matters on the boot
 * recovery path, where the session may already be gone).
 */
export function assertTaskId(taskId) {
  const id = String(taskId || '');
  if (!TASK_ID_RE.test(id)) throw new Error('refusing to pass an unrecognised task id to the CLI: ' + id);
  return id;
}
export function nativeWorktreePath(projectDir, taskId) {
  return path.join(projectDir, ...WT_SEGMENTS, assertTaskId(taskId));
}
export function nativeWorktreeBranch(taskId) {
  return 'worktree-' + assertTaskId(taskId);
}
export function nativeSessionName(taskId) {
  return NAME_PREFIX + assertTaskId(taskId);
}

/* ── Capability probe ────────────────────────────────────────────────────
 * Runs once per process and is cached, because it costs three subprocesses. It
 * checks the three things a native run actually depends on, in the order that
 * gives the most useful failure message:
 *   1. the binary exists and reports a version we have verified against,
 *   2. `--help` still spells the flags we pass (`--bg`, `--worktree`) — both
 *      engines self-update roughly daily, and this is the exact drift the audit
 *      warned about when it recorded a flag name that no longer exists,
 *   3. `claude agents --json` really returns a JSON ARRAY without a TTY, which
 *      is the call the whole poll loop is built on.
 * A failure is cached only briefly, so fixing the install (or an update landing)
 * is picked up without restarting the server; a success is cached for the
 * process, and a run that then hits a broken CLI fails with its own clear error.
 */
let capCache = null;      // { at, ok, reason, version, bin }
let capInFlight = null;
const CAP_OK_TTL_MS = 60 * 60 * 1000;
const CAP_FAIL_TTL_MS = 60 * 1000;

function parseVersion(text) {
  const m = String(text || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function olderThan(v, min) {
  for (let i = 0; i < 3; i++) {
    if (v[i] < min[i]) return true;
    if (v[i] > min[i]) return false;
  }
  return false;
}

async function probe() {
  let version = null;
  try {
    const { stdout } = await run(['--version']);
    version = parseVersion(stdout);
    if (!version) return { ok: false, reason: 'the claude CLI did not report a version', version: null };
  } catch (e) {
    const why = e && e.code === 'ENOENT'
      ? 'the claude CLI is not installed (or not on this process’s PATH)'
      : 'could not run the claude CLI: ' + ((e && (e.stderr || e.message)) || 'unknown error');
    return { ok: false, reason: why, version: null };
  }
  const vs = version.join('.');
  if (olderThan(version, MIN_CLI)) {
    return { ok: false, reason: 'the claude CLI is ' + vs + '; background sessions need ' + MIN_CLI.join('.') + ' or newer', version: vs };
  }
  try {
    const { stdout } = await run(['--help'], { timeout: ADMIN_TIMEOUT_MS });
    const help = String(stdout);
    const missing = [];
    if (!/--bg\b|--background\b/.test(help)) missing.push('--bg');
    if (!/--worktree\b/.test(help)) missing.push('--worktree');
    if (missing.length) {
      return { ok: false, reason: 'this claude CLI (' + vs + ') no longer offers ' + missing.join(' / ') + ' — the native runner needs updating', version: vs };
    }
  } catch (e) {
    return { ok: false, reason: 'could not read `claude --help`: ' + ((e && (e.stderr || e.message)) || 'unknown error'), version: vs };
  }
  try {
    const rows = await listSessions({ all: false });
    if (!Array.isArray(rows)) throw new Error('not an array');
  } catch (e) {
    return { ok: false, reason: '`claude agents --json` did not return a session list: ' + ((e && e.message) || 'unknown error'), version: vs };
  }
  return { ok: true, reason: null, version: vs };
}

// Async, authoritative. Every native run awaits this before it starts anything.
export async function nativeCapability({ refresh = false } = {}) {
  const ttl = capCache && capCache.ok ? CAP_OK_TTL_MS : CAP_FAIL_TTL_MS;
  if (!refresh && capCache && Date.now() - capCache.at < ttl) return capCache;
  if (!refresh && capInFlight) return capInFlight;
  capInFlight = (async () => {
    let result;
    try { result = await probe(); }
    catch (e) { result = { ok: false, reason: 'capability probe failed: ' + ((e && e.message) || String(e)), version: null }; }
    capCache = { at: Date.now(), bin: CLI, ...result };
    return capCache;
  })().finally(() => { capInFlight = null; });
  return capInFlight;
}

// Sync, for the synchronous board-metadata exports (opsMeta/opsRunners return
// plain objects to `res.json(fn())`, so they cannot await). Returns null until
// the first probe lands and kicks one off so the next call has an answer.
export function nativeCapabilitySnapshot() {
  if (capCache) return capCache;
  primeNativeCapability();
  return null;
}

// Fire-and-forget warm-up, called from initRunner so the board never has to show
// "checking…" in practice.
export function primeNativeCapability() {
  nativeCapability().catch(() => { /* the reason is cached either way */ });
}

/* ── Session listing ─────────────────────────────────────────────────────
 * The one call the poll loop depends on. Interactive rows (the owner's terminal,
 * PlumiChat's own parent session) are dropped here: they have no `id`, and treating
 * one as a background session would mean stopping a human's shell.
 */
export async function listSessions({ all = true, cwd = null } = {}) {
  const args = ['agents', '--json'];
  if (all) args.push('--all');
  if (cwd) args.push('--cwd', cwd);
  const { stdout } = await run(args);
  let parsed;
  try { parsed = JSON.parse(stdout); }
  catch { throw new Error('`claude agents --json` printed something that is not JSON'); }
  if (!Array.isArray(parsed)) throw new Error('`claude agents --json` did not return an array');
  return parsed.filter((r) => r && typeof r === 'object' && r.kind === 'background' && typeof r.id === 'string' && r.id);
}

export async function findSession(id) {
  if (!id) return null;
  const rows = await listSessions({ all: true });
  return rows.find((r) => r.id === id) || null;
}

/* Find a session by the name PlumiChat gave it, rather than by id.
 *
 * The id only reaches the task record a moment AFTER the session is spawned, so
 * a server that dies inside that window leaves a running session nothing points
 * at. The name is derived from the task id and is therefore recoverable without
 * any stored state — which is exactly what the cleanup paths need. Both a sync
 * and an async form, because cleanup happens in both kinds of context. */
export async function findSessionByTask(taskId) {
  let name;
  try { name = nativeSessionName(taskId); } catch { return null; }
  let rows = [];
  try { rows = await listSessions({ all: true }); } catch { return null; }
  return rows.find((r) => r.name === name) || null;
}
export function findSessionByTaskSync(taskId) {
  let name;
  try { name = nativeSessionName(taskId); } catch { return null; }
  let out;
  try {
    out = execFileSync(CLI, ['agents', '--json', '--all'], {
      env: cliEnv(), timeout: QUERY_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    });
  } catch { return null; }
  let parsed;
  try { parsed = JSON.parse(out); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  return parsed.find((r) => r && r.kind === 'background' && typeof r.id === 'string' && r.name === name) || null;
}

/* Is this row still doing work?
 *
 * `status: 'busy'` is the signal that survives the state field being a text
 * heuristic; 'working' is the state that pairs with it. Anything else — idle,
 * waiting, absent — means the session is not currently producing output, and the
 * caller confirms that across two consecutive polls before acting on it. */
export function sessionActive(row) {
  if (!row) return false;
  return row.status === 'busy' || row.state === 'working' || row.state === 'starting';
}

// Collapse a row into the verdict the runner's state machine cares about.
// 'unknown' is deliberate and not fatal on its own: the caller keeps polling
// (bounded by NATIVE_MAX_MS) and names the state in the error if it never
// resolves, rather than pretending an unrecognised state means success.
export function sessionVerdict(row) {
  if (!row) return { verdict: 'gone', state: null, status: null };
  const state = typeof row.state === 'string' ? row.state : null;
  const status = typeof row.status === 'string' ? row.status : null;
  if (sessionActive(row)) return { verdict: 'active', state, status };
  if (state === 'done') return { verdict: 'done', state, status };
  if (state === 'blocked') return { verdict: 'blocked', state, status };
  if (state === 'failed') return { verdict: 'failed', state, status };
  if (state === 'stopped') return { verdict: 'stopped', state, status };
  return { verdict: 'unknown', state, status };
}

/* ── Starting a run ──────────────────────────────────────────────────────
 * execFile with a literal argv — the prompt, the model, the worktree name and
 * the session name never go near a shell. The prompt is passed after `--` so a
 * prompt that begins with a dash can never be read as a flag.
 */
export async function startSession({ projectDir, taskId, prompt, model, effort }) {
  const id = assertTaskId(taskId);
  const name = nativeSessionName(id);
  const args = ['--bg', '--worktree', id];
  if (model) args.push('--model', String(model));
  if (effort) args.push('--effort', String(effort));
  args.push('--permission-mode', 'acceptEdits');
  if (RESTRICTED) args.push('--restricted');
  args.push('-n', name, '--', String(prompt));

  const startedFrom = Date.now();
  let stdout = '';
  try {
    const r = await run(args, { cwd: projectDir, timeout: START_TIMEOUT_MS });
    stdout = String(r.stdout || '') + '\n' + String(r.stderr || '');
  } catch (e) {
    const why = (e && (e.stderr || e.message)) || 'unknown error';
    throw new Error('could not start a native background session: ' + String(why).trim());
  }

  // The printed id is a hint. The session list is the source of truth, so we
  // confirm against it — matching our own unique name inside a start-time window
  // so a leftover session from an earlier attempt of the same task can never be
  // mistaken for this one.
  const printed = (stdout.match(/backgrounded[^\n]*?\b([0-9a-f]{6,12})\b/i) || [])[1] || null;
  let row = null;
  for (let attempt = 0; attempt < 10 && !row; attempt++) {
    let rows = [];
    try { rows = await listSessions({ all: true }); } catch { rows = []; }
    if (printed) row = rows.find((r) => r.id === printed) || null;
    if (!row) {
      row = rows.find((r) => r.name === name && Number(r.startedAt) >= startedFrom - 10000) || null;
    }
    if (!row) await sleep(1000);
  }
  if (!row) {
    // It printed an id, so something IS running out there — take it down rather
    // than leave an unowned agent editing a worktree nobody is watching.
    if (printed) { await stopSession(printed); await removeSession(printed); }
    throw new Error('the background session started but never appeared in `claude agents --json`'
      + (printed ? ' (printed id ' + printed + ')' : ''));
  }
  const worktree = nativeWorktreePath(projectDir, id);
  if (!fs.existsSync(worktree)) {
    await stopSession(row.id);
    await removeSession(row.id);
    throw new Error('the background session did not create its worktree at ' + worktree);
  }
  return {
    id: row.id,
    sessionId: typeof row.sessionId === 'string' ? row.sessionId : null,
    name,
    worktree,
    branch: nativeWorktreeBranch(id),
    startedAt: Number(row.startedAt) || startedFrom,
  };
}

/* ── Stop / remove ───────────────────────────────────────────────────────
 * Both are best effort by design: "No job matching <id>" is a normal, exit-0
 * outcome once a session has already gone, and a cleanup path must not turn that
 * into a failure. `stopSession` is the cancel primitive; it was verified to
 * actually halt a mid-flight session.
 */
export async function stopSession(id) {
  if (!id) return false;
  try { await run(['stop', String(id)], { timeout: ADMIN_TIMEOUT_MS }); return true; }
  catch { return false; }
}
export async function removeSession(id) {
  if (!id) return false;
  try { await run(['rm', String(id)], { timeout: ADMIN_TIMEOUT_MS }); return true; }
  catch { return false; }
}
export function stopSessionSync(id) { return id ? runQuiet(['stop', String(id)]) : false; }
export function removeSessionSync(id) { return id ? runQuiet(['rm', String(id)]) : false; }

/* ── Worktree teardown ───────────────────────────────────────────────────
 * `claude rm` cannot do this for us (see the header: it keeps any worktree with
 * uncommitted changes or unpushed commits, which is every PlumiChat run). So we do
 * exactly what operations.js already does for its own worktrees, plus the two
 * things a NATIVE worktree needs that a PlumiChat one does not:
 *   • the CLI git-LOCKS its worktree, and a plain `remove --force` refuses a
 *     locked tree ("use 'remove -f -f' to override or unlock first"), so the
 *     second --force is load-bearing;
 *   • the `worktree-<id>` BRANCH survives the worktree's removal and would
 *     otherwise pile up one dead branch per run.
 * Every step is independently best effort: a repo that has already been cleaned
 * (or moved) must not make this throw.
 */
export function removeWorktree(projectDir, taskId) {
  let id;
  try { id = assertTaskId(taskId); } catch { return false; }
  const wt = nativeWorktreePath(projectDir, id);
  gitQuiet(projectDir, ['worktree', 'remove', '--force', '--force', wt]);
  gitQuiet(projectDir, ['worktree', 'prune']);
  gitQuiet(projectDir, ['branch', '-D', nativeWorktreeBranch(id)]);
  try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
  return true;
}

/* Drop native worktrees in `projectDir` that no live task claims. The equivalent
 * of operations.js's orphan sweep over its own worktrees directory, and the same
 * argument for safety: only paths matching PlumiChat's own `.claude/worktrees/op_…`
 * naming are ever touched, so a worktree the OWNER created by hand (or a session
 * they started themselves) is left alone. */
export function sweepWorktrees(projectDir, knownIds) {
  const base = path.join(projectDir, ...WT_SEGMENTS);
  let names = [];
  try { names = fs.readdirSync(base); } catch { return []; }
  const dropped = [];
  for (const name of names) {
    if (!TASK_ID_RE.test(name)) continue;      // not one of ours
    if (knownIds && knownIds.has(name)) continue;
    removeWorktree(projectDir, name);
    dropped.push(name);
  }
  return dropped;
}

/* ── Reading what the agent said ─────────────────────────────────────────
 * NOT from `claude logs` — that is an ANSI screen dump (see the header). The
 * session's JSONL transcript is the same data the SDK path receives as events,
 * so parsing it gives byte-comparable material for splitSummary/extractHandoffs
 * and for the board's tool log.
 *
 * WHEN it is written matters, and was measured rather than assumed: the file
 * fills in DURING the turn, in batches, roughly 4–8 seconds behind the agent
 * (files appeared on disk at t+8s whose tool_use records only became readable at
 * t+12s). Two consequences the caller must live with:
 *   • a live tool log built from this lags by a few seconds, which is fine;
 *   • a session stopped inside its first ~10 seconds can have NO assistant
 *     records at all — verified on a cancel at 12s and a ceiling stop at 20s,
 *     both of which had already written files but had flushed no narration. The
 *     captured diff is unaffected (it comes from git, not from here), so a
 *     cancelled run loses its words, never its work.
 *
 * The transcript lives at <config>/projects/<slug>/<sessionId>.jsonl, where slug
 * is the session's cwd with every non-alphanumeric character replaced by '-'
 * (verified against both '/tmp/opsnat/proj/.claude/worktrees/op_escape01' →
 * '-tmp-opsnat-proj--claude-worktrees-op-escape01' and this repo's own name with
 * its spaces and parentheses). The slug is a LOSSY transform, so a miss falls
 * back to looking for the file by session id across the projects directory —
 * exact, and cheap enough for a once-per-poll read.
 */
function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}
function projectSlug(dir) {
  return String(dir).replace(/[^a-zA-Z0-9]/g, '-');
}
export function transcriptPath({ worktree, sessionId }) {
  if (!sessionId) return null;
  const file = String(sessionId) + '.jsonl';
  const projects = path.join(configDir(), 'projects');
  if (worktree) {
    const direct = path.join(projects, projectSlug(worktree), file);
    if (fs.existsSync(direct)) return direct;
  }
  let dirs = [];
  try { dirs = fs.readdirSync(projects); } catch { return null; }
  for (const d of dirs) {
    const p = path.join(projects, d, file);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function readTail(file) {
  const st = fs.statSync(file);
  if (st.size <= TRANSCRIPT_CAP) return fs.readFileSync(file, 'utf8');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(TRANSCRIPT_CAP);
    const n = fs.readSync(fd, buf, 0, TRANSCRIPT_CAP, st.size - TRANSCRIPT_CAP);
    const text = buf.subarray(0, n).toString('utf8');
    const nl = text.indexOf('\n');
    return nl === -1 ? '' : text.slice(nl + 1); // drop the partial first line
  } finally { fs.closeSync(fd); }
}

// { text, tools, found }. `text` is every assistant text block concatenated in
// order — the same accumulation the SDK path performs on its 'text' events, so
// the summary/handoff parsing downstream behaves identically. `tools` is the
// ordered tool_use list for the board's run log.
export function readTranscript({ worktree, sessionId }) {
  const file = transcriptPath({ worktree, sessionId });
  if (!file) return { text: '', tools: [], found: false };
  let raw;
  try { raw = readTail(file); } catch { return { text: '', tools: [], found: false }; }
  let text = '';
  const tools = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || rec.type !== 'assistant' || !rec.message) continue;
    const content = rec.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') text += block.text;
      else if (block.type === 'tool_use') tools.push({ name: String(block.name || 'tool'), input: block.input });
    }
  }
  return { text, tools, found: true };
}

/* ── Small helpers the runner needs ──────────────────────────────────────── */

// setTimeout that also resolves the moment an AbortSignal fires, so a Cancel is
// never sat on for a whole poll interval.
export function sleep(ms, signal) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal) { try { signal.removeEventListener('abort', finish); } catch { /* ignore */ } }
      resolve();
    };
    const timer = setTimeout(finish, ms);
    if (signal) {
      if (signal.aborted) return finish();
      try { signal.addEventListener('abort', finish, { once: true }); } catch { /* ignore */ }
    }
  });
}

// Whether `--restricted` is in force, for the board to report honestly.
export function nativeRestricted() { return RESTRICTED; }
