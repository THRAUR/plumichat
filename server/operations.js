// Operations — a persistent task board with a real background runner.
//
// SAFETY MODEL (important — read before changing anything here). A task moves
// through three stages, and only the FIRST is fully isolated:
//
//   1. RUN (isolated). A queued task runs the Claude Agent SDK autonomously (no
//      human in the loop) inside a throwaway git worktree checked out at the
//      project's current HEAD. The agent's file writes are confined to that
//      worktree by canUseTool; Bash is denied outright because it trivially
//      escapes confinement. We capture the result as a binary-safe patch
//      (`git diff --cached --binary`) plus a summary, then park the task in
//      `needs_approval`. Nothing has touched the operator's real tree yet.
//
//   2. APPLY (the human gate). Accept applies that patch to the operator's REAL
//      working tree. We refuse when any file the patch touches is already dirty,
//      dry-run with `git apply --check` first, and if the real apply still fails
//      we roll the patch's own paths back (unstage, restore, delete files that
//      did not exist before) and park the task in `apply_failed` — never a
//      half-applied tree with the Accept button still armed.
//
//   3. VERIFY & SHIP (autonomous — THIS COMMITS AND PUSHES). If the project has
//      a test gate (a `.venv` + pytest), an automated stage runs it against the
//      applied tree; on red a confined fix-up agent gets up to MAX_FIX_ATTEMPTS
//      repair passes IN THE REAL TREE; on green we `git commit` + `git push` the
//      task's OWN files only (the patch's paths plus paths the fix-up agents
//      actually wrote — everything else that changed is logged and left alone).
//      Projects with no test gate stop at `applied`: no gate, no unattended push.
//      We never force-push, never skip hooks, and never commit a file the task
//      did not touch. A test suite that collects nothing (pytest exit 5) or times
//      out counts as NO gate, not as green.
//
// Residual risk: the agent can reach the network during a run (stage 1 gates FILE
// changes behind review; it does not sandbox the network), and stages 2–3 operate
// on the operator's real repository. Every code path here is written to fail
// closed and to report what it declined to touch, because this runner is
// unattended.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import { read, update, DATA_DIR } from './store.js';
import { resolveInRoot } from './sandbox.js';
import { runPrompt } from './claude.js';
import { spendGate } from './spend.js';
import { normalizeSchedule, computeNextRun } from './ops/schedule.js';
import {
  git, gitChangedPaths, gitStatusRecords, nulFields, parseNumstatZ, patchFilePaths,
  repoRoot, resolveTestCommand, runTests, TEST_TIMEOUT_MS,
} from './ops/git.js';
import { fetchLiveSignals } from './ops/signals.js';
import {
  NOTES_COLLECTION, WORKTREES_DIR, PATCHES_DIR, newId, now, load, updateTasks,
  patchFile, worktreePath, mutate, pushLog, onOpsChange,
} from './ops/store.js';
import {
  ackNotes, buildRunContext, cadenceOf, extractHandoffs, persistHandoffs, stampNoteCommit,
} from './ops/notes.js';

// Still part of this module's public surface — index.js imports it from here.
export { onOpsChange };
import {
  nativeCapability, nativeCapabilitySnapshot, primeNativeCapability, nativeRestricted,
  startSession as startNativeSession, findSession as findNativeSession,
  sessionVerdict as nativeSessionVerdict, stopSession as stopNativeSession,
  removeSession as removeNativeSession, stopSessionSync as stopNativeSessionSync,
  removeSessionSync as removeNativeSessionSync, removeWorktree as removeNativeWorktree,
  sweepWorktrees as sweepNativeWorktrees, readTranscript as readNativeTranscript,
  findSessionByTask as findNativeSessionByTask, findSessionByTaskSync as findNativeSessionByTaskSync,
  sleep as nativeSleep, NATIVE_POLL_MS, NATIVE_MAX_MS,
} from './ops-native.js';


const DEFAULT_MODEL = process.env.OPS_MODEL || process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const TICK_MS = 30 * 1000; // how often we check for due scheduled tasks
// operations.json is rewritten in full on every task mutation (the atomic store
// is single-process by design). Every run — including each recurring schedule
// firing — adds a task record, so without a cap the file grows forever and each
// sync write gets slower. Keep the most-recent HISTORY_CAP *terminal* tasks;
// active/awaiting-approval tasks are never pruned. This bounds both disk and the
// per-write cost. See pruneHistory().
const HISTORY_CAP = 300;
// ── The status vocabulary, defined ONCE ──────────────────────────────────
// The audit found these lists maintained in four places (here, twice more below,
// and hard-coded again in public/operations.html). They now live here and are
// published to the client by opsMeta(), so a new status cannot drift out of sync.
//
// Statuses that mean a task is still live (or waiting on a human) — never pruned.
const ACTIVE_STATUS_LIST = [
  'queued', 'scheduled', 'running', 'verifying', 'fixing', 'shipping', 'needs_approval',
];
const ACTIVE_STATUSES = new Set(ACTIVE_STATUS_LIST);
// The autonomous verify→ship phase, between approval and shipped.
const PIPELINE_STATUS_LIST = ['verifying', 'fixing', 'shipping'];
// A task is doing work RIGHT NOW in one of these (see opsStatus / deleteTask).
const IN_FLIGHT_STATUSES = new Set(['running', ...PIPELINE_STATUS_LIST]);
// Terminal statuses — the board's history lane. 'apply_failed' is new: a patch
// that could not be applied cleanly to the real tree, rolled back and parked so
// it can never be approved again without a fresh run (see acceptTask).
const DONE_STATUS_LIST = [
  'applied', 'shipped', 'done', 'rejected', 'cancelled', 'error',
  'verify_failed', 'ship_failed', 'apply_failed',
];
// Terminal failures a run can be retried from — but ONLY while nothing of the
// task has been applied to the operator's real working tree (see runNow). Once
// changes are in their tree, re-running the agent would duplicate the work.
const RETRYABLE_STATUS_LIST = ['error', 'cancelled', 'apply_failed', 'verify_failed', 'ship_failed'];

// ── Which backend runs a task ────────────────────────────────────────────
// 'sdk'    — the in-process Agent SDK path this module has always used: a
//            throwaway worktree under DATA_DIR, runPrompt(), confinement by
//            canUseTool. Everything below the capture point is shared.
// 'native' — a `claude --bg --worktree` background session driven through the
//            CLI (see server/ops-native.js). Same task record, same statuses,
//            same patch artifact, same Accept/Reject gate.
// The SDK path is the DEFAULT and stays the default: a task with no `runner`
// field — every task that already exists on the board — runs exactly as before.
const RUNNER_LIST = ['sdk', 'native'];
const DEFAULT_RUNNER = RUNNER_LIST.includes(String(process.env.OPS_RUNNER || '')) ? String(process.env.OPS_RUNNER) : 'sdk';

// Appended to every autonomous run so the result carries a tight, skimmable
// recap. We split this back out (everything after the marker) into `summary`,
// keeping the agent's full narration as `detail` — so the board shows a
// one-glance summary by default, with the thinking a tap away.
const SUMMARY_MARK = '### Summary';
const HANDOFF_MARK = '### Handoffs';
// Appended to every autonomous run. Requests an OPTIONAL cross-area handoff
// block (parsed out into notes for other areas), then the ALWAYS-required
// one-glance summary — which must come LAST so splitSummary can find it.
const OUTPUT_SUFFIX = '\n\n----\n' +
  'When you are completely finished, end your reply with these blocks, in THIS order:\n\n' +
  'FIRST, only if your work concerns an area OTHER than your own, add a handoffs block — one ' +
  'bullet per area, each formatted EXACTLY as "area: what changed or what they should check", ' +
  'where area is one of: payments, translation, support, health, branding, billing. ' +
  'Omit this block entirely when nothing applies:\n\n' +
  HANDOFF_MARK + '\n' +
  '- payments: e.g. the subscription-status link in the welcome copy looked wrong; please verify the billing-portal URL.\n\n' +
  'LAST, always add a short recap, on its own, formatted EXACTLY like this and with nothing after it:\n\n' +
  SUMMARY_MARK + '\n' +
  '- One bullet per change or finding, in plain language a non-engineer can skim.\n' +
  '- Say what you changed and why — or, if nothing needed changing, what you found.\n' +
  '- Keep it to 1–5 short bullets. Avoid file paths unless one is essential.';

// Project "areas" a task can be tagged with — organizational labels that map to
// the Operations vision (payments, translation, support, …). Free of behavior for
// now; they group + colour the board and will later route to domain specialists.
const VALID_CATEGORIES = new Set([
  'general', 'payments', 'translation', 'support', 'health', 'branding', 'billing',
]);

// ── Verify & Ship pipeline tunables ──────────────────────────────────────
// After a human approves a task, a second automated stage runs the project's
// test suite and, only on green, commits + pushes the task's changes (the host
// auto-deploys from the remote). These bound that stage.
const MAX_FIX_ATTEMPTS = 2;            // confined repair passes before giving up
// Cap on the patch text taskPatch() hands back, so a huge diff can't wedge a
// phone rendering it (the full patch stays on disk either way).
const PATCH_READ_CAP = 512 * 1024;

// Runtime-only handle on the in-flight run so Cancel can abort it.
let running = false;
let ticker = null; // setInterval handle for the schedule sweep
const aborts = new Map(); // taskId -> AbortController
const shipping = new Set(); // taskIds with an in-flight verify→ship pipeline
const cancelling = new Set(); // taskIds asked to cancel mid verify→ship pipeline
// taskIds inside an accept/reject transition. Both paths read the status, then
// await (patch inspection, git apply) before writing the new one — so without
// this, a double-tap or an Accept racing a Reject both pass the status check and
// both proceed. Held for the WHOLE of each path, released in a finally.
const transitioning = new Set();
// Cancellation tokens for tasks whose run has been requested but whose
// AbortController does not exist yet. cancelTask() marks the id here; the setup
// path in executeTask checks it after every await, so Cancel is never a silent
// no-op during the seconds before the SDK query starts (audit H4).
const cancelRequested = new Set();


// Tools that write files — confined to the worktree so an autonomous run can
// never edit outside its isolated copy (the diff-review boundary).
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// The autonomous tool policy. No human is in the loop, so we enforce safety
// structurally: file edits must stay inside `root` (the worktree); Bash is
// disabled because it can trivially escape confinement (cd, absolute paths,
// redirection); questions auto-proceed; reads/searches are allowed.
// `onWrite(relPath)` (optional) is called with the repo-relative path of every
// write we allow. That is how the ship stage knows exactly which files a fix-up
// agent touched in the operator's REAL tree — attribution from the tool call
// itself, not from "whatever changed while it was running", which would sweep in
// a concurrent chat turn's edits (audit H4: ship scope).
function makeConfinedPolicy(root, onWrite) {
  const within = (p) => {
    if (!p) return false;
    const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
    const rel = path.relative(root, abs);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  return async (toolName, input) => {
    if (WRITE_TOOLS.has(toolName)) {
      const fp = input && (input.file_path || input.path || input.notebook_path);
      if (!within(fp)) {
        return { behavior: 'deny', message: 'Refused: "' + fp + '" is outside the task working directory. Edit only files inside the project, using paths relative to it.' };
      }
      if (onWrite) {
        // Never let bookkeeping break a run: a bad path here must not deny a
        // write the containment check already approved.
        try { onWrite(path.relative(root, path.resolve(root, fp))); } catch { /* ignore */ }
      }
      return { behavior: 'allow', updatedInput: input };
    }
    if (toolName === 'Bash') {
      return { behavior: 'deny', message: 'Bash is disabled for autonomous background tasks (it can escape the isolated worktree). Make changes by editing files directly — they will be reviewed as a diff.' };
    }
    if (toolName === 'AskUserQuestion') {
      return { behavior: 'deny', message: 'No human is available for background tasks. Proceed using your best judgement.' };
    }
    return { behavior: 'allow', updatedInput: input };
  };
}



export function listTasks() {
  // Newest first; the front-end buckets them into lanes by status.
  //
  // The comparator used to be `(b.createdAt < a.createdAt ? -1 : 1)`, which never
  // returns 0 — so for two tasks created in the SAME millisecond it claimed an
  // order that does not exist, and their positions on the board could swap between
  // one refresh and the next. Ties are common: a routine firing several runs at
  // once stamps them all identically. Fall back to the id, which is stable.
  return load().tasks.slice().sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.id < b.id ? 1 : (a.id > b.id ? -1 : 0);
  });
}

/* ── Board metadata, status and patch review ─────────────────────────────
 * public/operations.html hard-codes the category list, MAX_FIX and the status
 * lanes; the audit found those maintained in four places at once. These three
 * exports publish the server's own values so the client can stop guessing.
 * They are all SYNCHRONOUS on purpose — index.js wires simple routes with a
 * `res.json(fn())` helper, and returning a promise there would serialise as {}.
 */

// Cheap memo for the project scan: opsMeta() may be polled by an open board.
let metaProjectsCache = null;
let metaProjectsAt = 0;
const META_PROJECTS_TTL_MS = 30 * 1000;

// Which root projects exist, and which of them have a test gate (so the client
// can say "Approve & ship" only where a suite actually gates the push, and
// "Approve & apply" everywhere else).
function metaProjects() {
  if (metaProjectsCache && Date.now() - metaProjectsAt < META_PROJECTS_TTL_MS) return metaProjectsCache;
  let out = [];
  try {
    const root = resolveInRoot(); // no segments → the workspace root itself
    out = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => {
        let hasTestGate = false;
        try { hasTestGate = !!resolveTestCommand(path.join(root, name)); } catch { /* unreadable → no gate */ }
        return { name, hasTestGate };
      });
  } catch { out = []; } // no workspace root → an empty picker, not a 500
  metaProjectsCache = out;
  metaProjectsAt = Date.now();
  return out;
}

// The board's vocabulary and tunables, straight from this module.
export function opsMeta() {
  return {
    categories: [...VALID_CATEGORIES],
    maxFix: MAX_FIX_ATTEMPTS,
    statuses: {
      active: [...ACTIVE_STATUS_LIST],
      done: [...DONE_STATUS_LIST],
      pipeline: [...PIPELINE_STATUS_LIST],
      retryable: [...RETRYABLE_STATUS_LIST],
    },
    projects: metaProjects(),
    testTimeoutMs: TEST_TIMEOUT_MS,
    runners: opsRunners(),
  };
}

// Which backends a new task may choose, and — when the native one is not on
// offer — the honest reason why. The board asks so it can show the choice
// truthfully instead of advertising a runner that would fail on first use.
// Synchronous like its neighbours (index.js wires `res.json(fn())`), so it reads
// the capability probe's CACHED answer; the probe itself is kicked at boot by
// initRunner and re-kicked here if it somehow has not run yet.
export function opsRunners() {
  const cap = nativeCapabilitySnapshot();
  const available = ['sdk'];
  let nativeReason = null;
  if (!cap) nativeReason = 'still checking the claude CLI';
  else if (cap.ok) available.push('native');
  else nativeReason = cap.reason;
  return {
    available,
    default: DEFAULT_RUNNER,
    nativeReason,
    nativeVersion: cap && cap.version ? cap.version : null,
    nativeRestricted: nativeRestricted(),
  };
}

// Is the runner busy, and what is it busy with? This is the signal a sleep
// controller needs: `busy` false with `queued` 0 and no imminent `nextDueAt`
// means nothing here objects to the box going to sleep.
export function opsStatus() {
  const tasks = load().tasks;
  const running = [];
  let queued = 0;
  let needsApproval = 0;
  let nextDueAt = null;
  for (const t of tasks) {
    if (IN_FLIGHT_STATUSES.has(t.status)) {
      running.push({ id: t.id, project: t.project, status: t.status, startedAt: t.startedAt || null });
    } else if (t.status === 'queued') {
      queued += 1;
    } else if (t.status === 'needs_approval') {
      // The one state that is WAITING ON A HUMAN rather than on the machine. It is
      // what the drawer badge exists to surface: a finished task can sit unnoticed
      // indefinitely, because nothing about it is running any more.
      needsApproval += 1;
    } else if (t.status === 'scheduled' && t.nextRun) {
      const ms = new Date(t.nextRun).getTime();
      if (Number.isFinite(ms) && (nextDueAt === null || ms < nextDueAt)) nextDueAt = ms;
    }
  }
  return { busy: running.length > 0 || queued > 0, running, queued, needsApproval, nextDueAt };
}

// The captured patch for review BEFORE the operator approves it — the human gate
// is blind without this. Synchronous and git-free: the per-file breakdown was
// recorded from git's own -z numstat when the patch was captured, so nothing
// here has to re-parse C-quoted paths out of the diff text.
export function taskPatch(id) {
  const t = load().tasks.find((x) => x.id === id);
  if (!t) throw new Error('task not found');
  const pf = patchFile(id);
  let st;
  try { st = fs.statSync(pf); } catch { st = null; }
  if (!st || !st.size) {
    throw new Error(t.status === 'needs_approval'
      ? 'this task made no file changes, so there is nothing to review'
      : 'the patch for this task is no longer on disk (it is applied, rejected or cleaned up)');
  }
  // Read at most the cap, then cut back to the last complete line so a truncated
  // diff never ends mid-hunk (or mid UTF-8 sequence) in the reader.
  const truncated = st.size > PATCH_READ_CAP;
  let patch;
  const fd = fs.openSync(pf, 'r');
  try {
    const len = Math.min(st.size, PATCH_READ_CAP);
    const buf = Buffer.allocUnsafe(len);
    let read = 0;
    while (read < len) {
      const n = fs.readSync(fd, buf, read, len - read, read);
      if (n <= 0) break;
      read += n;
    }
    patch = buf.subarray(0, read).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  if (truncated) {
    const nl = patch.lastIndexOf('\n');
    if (nl > 0) patch = patch.slice(0, nl + 1);
    patch += '\n… patch truncated for display (' + st.size + ' bytes total). The full patch is applied in one piece if you Accept.\n';
  }
  return {
    id,
    patch,
    truncated,
    bytes: st.size,
    files: Array.isArray(t.diffFiles) ? t.diffFiles : [],
  };
}


export function createTask({ project, prompt, model, category, schedule, runner }) {
  if (!project || !prompt) throw new Error('project and prompt are required');
  const sched = normalizeSchedule(schedule); // null = run once, immediately
  const task = {
    id: newId(),
    project,
    prompt: String(prompt).trim(),
    model: model || DEFAULT_MODEL,
    category: normalizeCategory(category),
    runner: normalizeRunner(runner),
    status: sched ? 'scheduled' : 'queued',
    schedule: sched,
    nextRun: sched ? computeNextRun(sched) : null,
    routineId: null, // set on runs spawned by a recurring routine
    createdAt: now(),
    startedAt: null,
    finishedAt: null,
    summary: '',
    error: '',
    log: [],
    diff: null, // { files, additions, deletions } once a patch exists
  };
  updateTasks((db) => { db.tasks.push(task); return db; });
  if (sched) ensureTicker(); else kick();
  return task;
}

function normalizeCategory(c) {
  const v = String(c || 'general').toLowerCase();
  return VALID_CATEGORIES.has(v) ? v : 'general';
}

// An unknown or absent runner is the SDK one. Deliberately forgiving rather than
// throwing: a task record written before this field existed, or a client that
// has not learned about it, must keep behaving exactly as it did.
function normalizeRunner(r) {
  const v = String(r || '').toLowerCase();
  return RUNNER_LIST.includes(v) ? v : DEFAULT_RUNNER;
}
// One place that decides whether a task takes the native path.
function isNativeRunner(task) { return normalizeRunner(task && task.runner) === 'native'; }


// A recurring routine fires by creating a concrete one-off RUN that flows through
// the board (queued → running → needs_approval → …). The routine itself stays
// `scheduled`, with nextRun advanced to its next occurrence.
function spawnRun(routine) {
  const run = {
    id: newId(),
    project: routine.project,
    prompt: routine.prompt,
    model: routine.model || DEFAULT_MODEL,
    category: routine.category || 'general',
    // A routine's runs use whatever backend the routine was created with.
    runner: normalizeRunner(routine.runner),
    status: 'queued',
    schedule: null,
    nextRun: null,
    routineId: routine.id,
    createdAt: now(),
    startedAt: null,
    finishedAt: null,
    summary: '',
    error: '',
    log: [],
    diff: null,
  };
  updateTasks((db) => { db.tasks.push(run); return db; });
  return run;
}

// Promote a scheduled task to run immediately, or retry a failed one. A one-off
// becomes the run itself; a recurring routine spawns a run now and keeps its
// future schedule intact.
//
// Retry is deliberately narrow. A task whose changes already reached the
// operator's working tree (verify_failed, ship_failed, or anything else past the
// Accept gate) must NOT be re-run: the fresh worktree is cut from HEAD, so the
// agent would redo work that is already sitting in their tree and the two copies
// would collide. Those tasks say so instead of quietly duplicating themselves.
export function runNow(id) {
  const t = load().tasks.find((x) => x.id === id);
  if (!t) throw new Error('task not found');
  if (t.status === 'scheduled') {
    if (t.schedule && t.schedule.type !== 'once') spawnRun(t);
    else mutate(id, (task) => { task.status = 'queued'; task.nextRun = null; });
    kick();
    return { ok: true };
  }
  if (!RETRYABLE_STATUS_LIST.includes(t.status)) {
    throw new Error('only scheduled tasks, or a run that failed, can be started now');
  }
  if (t.appliedToTree) {
    throw new Error("this task's changes are already in your working tree — review, ship or revert them there; re-running would duplicate the work");
  }
  mutate(id, (task) => {
    task.status = 'queued';
    task.nextRun = null;
    task.startedAt = null;
    task.finishedAt = null;
    task.error = '';
    task.diff = null;
    // A retry is a fresh attempt: drop the previous run's ship bookkeeping so a
    // stale shipFiles list can never widen a later commit's scope.
    task.shipFiles = null;
    task.preexisting = null;
    task.fixAttempts = 0;
    task.testOutput = '';
    // A retry starts a NEW background session; the old session's id and worktree
    // must not survive, or cleanup would later chase a session that is gone (or,
    // worse, one that a different attempt is using).
    task.native = null;
  });
  kick();
  return { ok: true, retried: true };
}

// Edit a task that has not started yet.
//
// Order matters here and used to be wrong: store.update() hands `fn` the LIVE
// cached object, so the old code's half-applied edit survived in memory when
// normalizeSchedule() threw — and the next unrelated write persisted it. The API
// reported a clean 400 while the task had silently changed. Everything is
// therefore validated into locals FIRST; the mutation below cannot throw.
export function editTask(id, { prompt, project, category, schedule, runner }) {
  const cur = load().tasks.find((x) => x.id === id);
  if (!cur) throw new Error('task not found');
  if (cur.status !== 'queued' && cur.status !== 'scheduled') {
    throw new Error('only queued or scheduled tasks can be edited');
  }

  // --- validate (may throw; nothing has been mutated yet) ---
  const next = {};
  if (prompt != null) {
    if (typeof prompt !== 'string' && typeof prompt !== 'number') throw new Error('prompt must be text');
    const p = String(prompt).trim();
    if (!p) throw new Error('prompt cannot be empty');
    next.prompt = p;
  }
  if (project != null) {
    if (typeof project !== 'string' || !project.trim()) throw new Error('project must be a folder name');
    // Reject anything that would not resolve inside the workspace root before it
    // can be stored — a bad project only surfaces at run time otherwise.
    try { resolveInRoot(project); } catch (e) { throw new Error('invalid project: ' + e.message); }
    next.project = project;
  }
  if (category != null) next.category = normalizeCategory(category);
  if (runner != null) {
    const v = String(runner).toLowerCase();
    if (!RUNNER_LIST.includes(v)) throw new Error('unknown runner: ' + runner);
    if (v === 'native') {
      // Refuse the switch up front rather than letting the run fail later — the
      // whole point of the capability probe is that the board never offers a
      // backend that cannot work on this box.
      const cap = nativeCapabilitySnapshot();
      if (cap && !cap.ok) throw new Error('the native runner is unavailable: ' + cap.reason);
    }
    next.runner = v;
  }
  if (schedule !== undefined) {
    const sched = normalizeSchedule(schedule); // throws on malformed input
    next.schedule = sched;
    next.nextRun = sched ? computeNextRun(sched) : null;
    next.status = sched ? 'scheduled' : 'queued';
  }

  // --- apply (cannot throw) ---
  let raced = false;
  const t = mutate(id, (task) => {
    // Re-check under the write: nothing can interleave here today (this function
    // has no awaits), but a status change between read and write must never be
    // overwritten silently if that ever stops being true.
    if (task.status !== 'queued' && task.status !== 'scheduled') { raced = true; return; }
    Object.assign(task, next);
  });
  if (!t) throw new Error('task not found');
  if (raced) throw new Error('that task started while you were editing it');
  if (t.status === 'queued') kick();
  else if (t.status === 'scheduled') ensureTicker();
  return t;
}

// Why a delete can be refused: the old guard covered only 'running', so deleting
// a task mid verify/fix/ship removed the record while a fix-up agent was still
// editing the operator's real tree, or while a commit+push was in flight — an
// orphaned autonomous agent with nothing left to report to.
function inFlightRefusal(status) {
  if (status === 'shipping') return 'this task is committing and pushing right now — wait for it to finish';
  if (status === 'verifying' || status === 'fixing') return 'this task is being verified — cancel it first, then delete';
  if (status === 'running') return 'cancel the run before deleting';
  return null;
}

export function deleteTask(id) {
  const t = load().tasks.find((x) => x.id === id);
  if (!t) throw new Error('task not found');
  const refusal = inFlightRefusal(t.status);
  if (refusal) throw new Error(refusal);
  if (transitioning.has(id)) throw new Error('this task is being accepted or rejected — try again in a moment');

  // Deleting a recurring routine must also stop the runs it already spawned that
  // haven't finished — otherwise a queued child still fires once and a running
  // child keeps going, which reads to the operator as "I deleted it but it's
  // still running". Running children are aborted (their own finally lands them in
  // 'cancelled'); a child mid-verify is asked to cancel cooperatively; pending
  // (queued/scheduled) children are removed outright. Terminal children and any
  // awaiting approval are left as history.
  const isRoutine = !!(t.schedule && t.schedule.type && t.schedule.type !== 'once');
  const remove = new Set([id]);
  if (isRoutine) {
    const children = load().tasks.filter((c) => c.routineId === id);
    // Refuse the whole delete if any child is past the point of safe interruption
    // — removing the routine underneath a live commit+push helps nobody.
    const blocked = children.find((c) => c.status === 'shipping');
    if (blocked) throw new Error('a run from this routine is committing and pushing right now — wait for it to finish');
    for (const c of children) {
      if (c.status === 'running') {
        cancelRequested.add(c.id);
        const ac = aborts.get(c.id); if (ac) ac.abort();
      } else if (c.status === 'verifying' || c.status === 'fixing') {
        // Cooperative: the pipeline lands it in 'cancelled' at the next stage
        // boundary. The child's record is KEPT — its changes are in the tree.
        cancelling.add(c.id);
        const ac = aborts.get(c.id); if (ac) ac.abort();
      } else if (c.status === 'queued' || c.status === 'scheduled') {
        remove.add(c.id);
      }
    }
  }
  for (const rid of remove) cleanupArtifacts(rid);
  updateTasks((db) => { db.tasks = db.tasks.filter((x) => !remove.has(x.id)); return db; });
  return { ok: true };
}

export function cancelTask(id) {
  const t = load().tasks.find((x) => x.id === id);
  if (!t) throw new Error('task not found');
  if (t.status === 'queued' || t.status === 'scheduled') {
    mutate(id, (task) => { task.status = 'cancelled'; task.finishedAt = now(); });
  } else if (t.status === 'running') {
    // Mark the request BEFORE looking for a controller. A run spends its first
    // seconds in git setup (rev-parse, worktree add) with no AbortController
    // registered yet; without this flag Cancel returned ok and did nothing at
    // all. executeTask checks cancelRequested after each setup await.
    cancelRequested.add(id);
    const ac = aborts.get(id);
    if (ac) ac.abort();
    // executeTask's finally will land it in 'cancelled'.
  } else if (t.status === 'verifying' || t.status === 'fixing') {
    // Mid verify→ship pipeline: request cooperative cancellation. Abort any
    // in-flight fix-up agent right away; the pipeline checks this flag at each
    // stage boundary and lands the task in 'cancelled'. A test run already in
    // progress finishes (there's nothing safe to kill), then the flag stops the
    // NEXT stage — so cancel takes effect between tests/fix-ups, never mid-commit.
    cancelling.add(id);
    const ac = aborts.get(id);
    if (ac) ac.abort();
  } else if (t.status === 'shipping') {
    throw new Error('this task is already committing and pushing — it can’t be cancelled mid-ship');
  } else {
    throw new Error('task is not scheduled, queued, running or verifying');
  }
  return { ok: true };
}

// True (and finalizes the task as 'cancelled') if a mid-pipeline cancel was
// requested for `id`. The applied changes stay in the working tree — same as the
// 'applied' state — so nothing the agent did is lost; we just stop before ship.
function cancelledMidPipeline(id) {
  if (!cancelling.has(id)) return false;
  cancelling.delete(id);
  finish(id, 'cancelled', { error: 'cancelled during verification — applied changes remain in the working tree' });
  return true;
}

// Roll the operator's tree back after a failed `git apply`. ONLY the patch's own
// paths are touched, and only ones we verified were clean beforehand — so this
// can never discard the operator's work.
//
// Probed on git 2.53.0: a --3way apply that conflicts exits 1, leaves conflict
// markers plus an unmerged index entry (UU) for the clashing file AND leaves the
// files that DID apply staged. `git checkout -f --` alone is not enough (it warns
// "path is unmerged" and leaves the stage), so we unstage first, then restore
// pre-existing files, then delete files the patch created.
async function rollbackApply(cwd, paths, existedBefore) {
  const report = { restored: [], failed: [] };
  if (!paths.length) return report;
  try {
    await git(cwd, ['reset', '-q', '--', ...paths]);
  } catch (e) { report.failed.push('unstage: ' + (e.stderr || e.message)); }

  const existing = paths.filter((p) => existedBefore.has(p));
  if (existing.length) {
    try {
      await git(cwd, ['checkout', '-f', '--', ...existing]);
      report.restored.push(...existing);
    } catch (e) {
      // One unrestorable path (e.g. a gitignored file that existed on disk but
      // git does not track) fails the WHOLE batch, which would abandon every
      // other file mid-rollback. Retry one at a time so a single odd path costs
      // only itself, and report exactly which ones could not be put back.
      for (const p of existing) {
        try { await git(cwd, ['checkout', '-f', '--', p]); report.restored.push(p); }
        catch (e2) { report.failed.push('restore ' + p + ': ' + ((e2.stderr || e2.message || '').trim() || (e.stderr || e.message))); }
      }
    }
  }
  for (const p of paths) {
    if (existedBefore.has(p)) continue;
    // The patch created this file; it did not exist before, so removing it
    // restores the tree exactly. resolveInRoot-derived cwd + a git-reported
    // relative path, but re-assert containment before any unlink.
    try {
      const abs = path.resolve(cwd, p);
      const rel = path.relative(cwd, abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      if (fs.existsSync(abs)) { fs.rmSync(abs, { force: true }); report.restored.push(p); }
    } catch (e) { report.failed.push('remove ' + p + ': ' + (e?.message || String(e))); }
  }
  return report;
}

export async function acceptTask(id) {
  // Accept and Reject both read the status, then await, then write the new one.
  // Two taps (or Accept racing Reject) used to sail past the status check
  // together and apply the patch twice. Held for the whole path.
  if (transitioning.has(id)) throw new Error('that task is already being processed — give it a moment');
  transitioning.add(id);
  try {
    return await acceptTaskInner(id);
  } finally {
    transitioning.delete(id);
  }
}

async function acceptTaskInner(id) {
  const t = load().tasks.find((x) => x.id === id);
  if (!t) throw new Error('task not found');
  if (t.status !== 'needs_approval') throw new Error('task is not awaiting approval');
  const pf = patchFile(id);
  if (!fs.existsSync(pf) || fs.statSync(pf).size === 0) {
    // Nothing to apply (agent made no file changes) — just mark applied.
    mutate(id, (task) => { task.status = 'applied'; task.finishedAt = now(); });
    cleanupArtifacts(id);
    return { ok: true, applied: 0 };
  }
  let cwd;
  try { cwd = resolveInRoot(t.project); } catch (e) { throw new Error('invalid project: ' + e.message); }
  // Every path in this function is repo-root-relative (see repoRoot).
  const root = await repoRoot(cwd);

  // Snapshot what was already dirty BEFORE we touch the tree, and which files
  // this task's patch owns. The ship stage commits only the task's own files;
  // the operator's unrelated local edits are never staged.
  let preexisting = [];
  try { preexisting = await gitChangedPaths(root); } catch { /* clean tree → empty */ }
  const shipFiles = await patchFilePaths(root, pf);

  // GATE 1 — refuse if the patch would land on top of the operator's own edits.
  // This is the case that produced conflict markers in their real tree while the
  // Accept button stayed armed. Better to say exactly which files are in the way.
  const dirty = new Set(preexisting);
  const collisions = shipFiles.filter((p) => dirty.has(p));
  if (collisions.length) {
    const shown = collisions.slice(0, 8).join(', ') + (collisions.length > 8 ? ` (+${collisions.length - 8} more)` : '');
    throw new Error('you have uncommitted changes in ' + collisions.length + ' file(s) this task also edits — commit, stash or revert them first, then Accept again: ' + shown);
  }

  // Which of the patch's paths already exist, so a rollback knows what to restore
  // versus what to delete. Captured before anything is written.
  const existedBefore = new Set();
  for (const p of shipFiles) {
    try { if (fs.existsSync(path.resolve(root, p))) existedBefore.add(p); } catch { /* treat as new */ }
  }

  // GATE 2 — dry run. Catches "does not match index" / unappliable hunks before
  // a single byte is written. Note it is run WITHOUT --3way on purpose: probing
  // showed `--check --3way` reports success for a patch that will in fact apply
  // "with conflicts", so it is useless as a gate. A failure here is not fatal —
  // --3way can still merge a drifted base — but it tells us to expect trouble.
  let strictCheck = true;
  try { await git(root, ['apply', '--check', '--whitespace=nowarn', pf]); }
  catch { strictCheck = false; }

  try {
    // --3way uses blob context to apply cleanly even if the base drifted a little.
    await git(root, ['apply', '--3way', '--whitespace=nowarn', pf]);
  } catch (e) {
    // The apply may have half-landed: some files staged, one left with conflict
    // markers and an unmerged index entry. Put the tree back exactly as it was.
    const reason = (e.stderr || e.message || '').trim();
    const rb = await rollbackApply(root, shipFiles, existedBefore);
    pushLog(id, { type: 'error', text: 'Patch did not apply — your working tree was rolled back. ' + reason });
    if (rb.failed.length) {
      pushLog(id, { type: 'error', text: 'Rollback was incomplete: ' + rb.failed.join('; ') + ' — check `git status` in ' + t.project + '.' });
    }
    // Terminal-ish and NOT approvable: the patch was captured against a HEAD that
    // has since moved, so re-running the task is the only honest way forward.
    finish(id, 'apply_failed', {
      error: 'patch did not apply to your working tree'
        + (strictCheck ? '' : ' (the project changed since this task ran)')
        + ': ' + reason
        + (rb.failed.length ? ' — ROLLBACK INCOMPLETE, check git status' : ' — your tree was left untouched')
        + '. Re-run the task to rebuild the change against the current code.',
    });
    throw new Error('patch did not apply cleanly to your working tree — nothing was changed. Re-run the task to rebuild it against your current code. (' + reason + ')');
  }

  // Belt-and-braces: git apply exited 0, but a conflicted 3-way merge shows up as
  // an unmerged index entry. If ANY exists, the tree holds conflict markers and
  // must not be treated as a clean apply. A failure of ls-files itself is not
  // worth blocking a successful apply over, so it reads as "no conflicts".
  let conflicted = false;
  try {
    const { stdout: unmerged } = await git(root, ['ls-files', '-u', '-z']);
    conflicted = nulFields(unmerged).length > 0;
  } catch { /* could not check — assume the exit code told the truth */ }
  if (conflicted) {
    const rb = await rollbackApply(root, shipFiles, existedBefore);
    pushLog(id, { type: 'error', text: 'Patch applied with conflicts — your working tree was rolled back.' });
    finish(id, 'apply_failed', {
      error: 'patch applied with conflicts and was rolled back'
        + (rb.failed.length ? ' (ROLLBACK INCOMPLETE — check git status)' : '')
        + '. Re-run the task to rebuild the change against the current code.',
    });
    throw new Error('patch applied with conflicts — your working tree was rolled back. Re-run the task.');
  }

  // `git apply --numstat` reports ONLY a rename's destination (verified on git
  // 2.53.0), but the deletion of the source is part of the same change — commit
  // one without the other and the ship leaves a stray copy of the old file
  // behind. Now that the patch is in the index, git's own status names both
  // ends, so recover any source whose destination this task owns. Safe to
  // attribute: we refused to apply at all if one of these paths was already
  // dirty, so a rename touching them can only be the one we just made.
  const shipSet = new Set(shipFiles);
  try {
    for (const r of await gitStatusRecords(root)) {
      if (r.from && shipSet.has(r.path)) shipSet.add(r.from);
    }
  } catch { /* best effort — the destination is staged either way */ }
  const shipFilesFinal = [...shipSet];

  // From here the change IS in the operator's tree. Record that so a retry can
  // never silently duplicate it (see runNow).
  mutate(id, (task) => { task.appliedToTree = true; task.shipFiles = shipFilesFinal; });
  // The patch lives in the working tree now; we recompute changes from git, so
  // the artifact is no longer needed.
  try { fs.rmSync(pf, { force: true }); } catch { /* ignore */ }

  // No test gate configured for this project → keep the historical behavior:
  // apply and stop, leaving the diff for the human to commit/push.
  const tc = resolveTestCommand(cwd);
  if (!tc) {
    mutate(id, (task) => { task.status = 'applied'; task.finishedAt = now(); });
    return { ok: true, applied: true, verifying: false };
  }

  // Hand off to the autonomous verify→ship stage. Fire-and-forget: the board
  // polls and watches it advance verifying → (fixing) → shipping → shipped.
  mutate(id, (task) => {
    task.status = 'verifying';
    // Kept for the detail pane only — what else was already dirty when the
    // operator approved. The ship scope no longer derives anything from it.
    task.preexisting = preexisting;
    task.shipFiles = shipFilesFinal;
    task.testOutput = '';
    task.fixAttempts = 0;
    task.shipCommit = null;
    task.shipBranch = null;
    task.error = '';
  });
  verifyAndShip(id).catch((e) => {
    finish(id, 'ship_failed', { error: 'pipeline crashed: ' + (e?.message || String(e)) });
  });
  return { ok: true, applied: true, verifying: true };
}

// ── Verify & Ship ────────────────────────────────────────────────────────
// The automated second stage. Runs the test suite against the just-applied
// working tree; on green, commits the task's own changed files and pushes to
// the project's remote (Koyeb/Vercel/etc. then auto-deploy). On red, a confined
// fix-up agent gets up to MAX_FIX_ATTEMPTS repair passes, re-testing after each.
// We NEVER force-push, NEVER skip hooks, and NEVER commit files the task didn't
// change — the passing test suite is the safety gate for an unattended push.
async function verifyAndShip(id) {
  if (shipping.has(id)) return; // already in flight
  shipping.add(id);
  try {
    const t = load().tasks.find((x) => x.id === id);
    if (!t) return;
    let cwd;
    try { cwd = resolveInRoot(t.project); } catch (e) { return finish(id, 'ship_failed', { error: 'invalid project: ' + e.message }); }
    // Tests and the fix-up agent run in the project directory; every git path
    // operation speaks repo-root-relative paths (see repoRoot).
    const root = await repoRoot(cwd);
    const tc = resolveTestCommand(cwd);
    if (!tc) { return finish(id, 'applied', {}); } // gate vanished — fall back

    let attempt = 0;
    let res = await runTests(cwd, tc);
    mutate(id, (task) => { task.testOutput = res.output; });
    if (cancelledMidPipeline(id)) return;

    // Three outcomes that are NOT "the tests are red", and none of which may
    // start a fix-up agent against the operator's real tree:
    //
    //  • noTests (pytest exit 5) — the suite collected nothing, so there is no
    //    gate here. The old code read 5 as red and burned two autonomous repair
    //    passes trying to "fix" a project with no tests. No gate → no unattended
    //    push; stop at 'applied' exactly like a project with no .venv.
    //  • timedOut — we learned nothing in TEST_TIMEOUT_MS. A fix-up agent has no
    //    failure output to reason from and every retry costs another 8 minutes.
    //  • spawnError — the interpreter itself is gone (ENOENT); nothing to fix.
    if (res.noTests) {
      pushLog(id, { type: 'notice', text: 'The test suite collected no tests (pytest exit 5) — there is no gate for this project, so nothing was pushed. The changes are in your working tree.' });
      return finish(id, 'applied', {
        testOutput: res.output,
        detail: 'Verification skipped: the test suite collected no tests, so there was no gate to pass. Review and commit these changes yourself.',
      });
    }
    if (res.timedOut) {
      pushLog(id, { type: 'error', text: `The test suite did not finish within ${Math.round(TEST_TIMEOUT_MS / 60000)} minutes — it was stopped and nothing was pushed.` });
      return finish(id, 'verify_failed', {
        error: 'the test suite timed out after ' + Math.round(TEST_TIMEOUT_MS / 60000) + ' minutes (it was not run to a verdict, so this is not a test failure) — the changes are applied to your working tree; verify and ship them yourself',
        testOutput: res.output,
      });
    }
    if (res.spawnError) {
      pushLog(id, { type: 'error', text: 'Could not start the test suite (' + res.spawnError + ') — nothing was pushed.' });
      return finish(id, 'verify_failed', {
        error: 'could not start the test suite (' + res.spawnError + ' running ' + tc.label + ') — the changes are applied to your working tree; verify and ship them yourself',
        testOutput: res.output,
      });
    }

    while (!res.ok && attempt < MAX_FIX_ATTEMPTS) {
      attempt += 1;
      mutate(id, (task) => { task.status = 'fixing'; task.fixAttempts = attempt; });
      pushLog(id, { type: 'notice', text: `Tests failed — fix-up attempt ${attempt}/${MAX_FIX_ATTEMPTS}` });
      await runFixupAgent(id, cwd, root, t.model, res.output);
      if (cancelledMidPipeline(id)) return;
      mutate(id, (task) => { task.status = 'verifying'; });
      res = await runTests(cwd, tc);
      mutate(id, (task) => { task.testOutput = res.output; });
      if (cancelledMidPipeline(id)) return;
      // A fix-up can turn a red suite into an un-runnable or empty one — that is
      // still not green, and must not be retried either.
      if (res.noTests || res.timedOut || res.spawnError) {
        const why = res.noTests ? 'the suite now collects no tests'
          : res.timedOut ? 'the suite timed out'
            : 'the suite could not be started (' + res.spawnError + ')';
        pushLog(id, { type: 'error', text: 'After fix-up, ' + why + ' — not shipping.' });
        return finish(id, 'verify_failed', {
          error: 'after ' + attempt + ' fix-up attempt(s), ' + why + ' — the changes are applied to your working tree; verify and ship them yourself',
          testOutput: res.output,
        });
      }
    }

    if (!res.ok) {
      pushLog(id, { type: 'error', text: 'Tests still failing after fix-up — not shipping.' });
      return finish(id, 'verify_failed', { error: 'tests failed after ' + attempt + ' fix-up attempt(s)', testOutput: res.output });
    }

    // Last chance to bail before we commit/push — once shipping starts it can't
    // be interrupted safely.
    if (cancelledMidPipeline(id)) return;
    // Green. Commit the task's own changes and push.
    mutate(id, (task) => { task.status = 'shipping'; });
    pushLog(id, { type: 'notice', text: 'Tests passed — committing and pushing.' });
    const t2 = load().tasks.find((x) => x.id === id);
    const ship = await shipChanges(id, root, t2);
    if (!ship.ok) {
      return finish(id, 'ship_failed', { error: ship.error, testOutput: res.output });
    }
    // Stamp the shipped commit onto any handoff notes this run wrote, so the
    // target area sees exactly what landed in production.
    if (ship.sha) stampNoteCommit(id, ship.sha);
    return finish(id, 'shipped', {
      testOutput: res.output,
      shipCommit: ship.sha || null,
      shipBranch: ship.branch || null,
      detail: ship.empty ? 'No net changes to commit after verification.' : undefined,
    });
  } finally {
    shipping.delete(id);
  }
}

// A confined repair pass: the agent edits the real working tree (already holding
// the applied patch) to make the suite pass. Same structural safety as a
// background run — writes confined to the project, Bash disabled, questions
// auto-proceed — but no throwaway worktree: it continues fixing in place, and
// nothing is committed until the tests actually pass.
// `root` is the repo root the ship stage speaks in; `cwd` is the project the
// agent works in (usually the same directory). Every file the agent is allowed
// to write is recorded onto task.shipFiles, so the commit below covers the
// fix-up's own new files without ever widening to somebody else's edits.
async function runFixupAgent(id, cwd, root, model, testOutput) {
  const tail = String(testOutput || '').slice(-3500);
  const prompt = [
    'A change was just applied to this project and the automated test suite is now FAILING.',
    'Your job is to edit the code so the FULL suite passes again.',
    '',
    'Rules:',
    '- Fix the application/source code. Only change a test if the test itself is clearly wrong.',
    '- Bash/shell is disabled; you cannot run anything. Reason from the failure output and the code.',
    '- Make the smallest correct change. Do not introduce unrelated edits.',
    '',
    'Failing test output (tail):',
    '```',
    tail,
    '```',
  ].join('\n');
  const ac = new AbortController();
  aborts.set(id, ac);
  // Attribution comes from the tool call itself, not from "what changed while it
  // ran" — the operator (or a chat turn) may be editing the same project during
  // this window, and their files must never end up in an unattended commit.
  const wrote = new Set();
  const noteWrite = (relToCwd) => {
    const rel = path.relative(root, path.resolve(cwd, relToCwd));
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) wrote.add(rel);
  };
  try {
    await runPrompt({
      prompt,
      cwd,
      model,
      effort: 'high',
      onEvent: (ev) => {
        if (ev.type === 'tool') pushLog(id, { type: 'tool', name: ev.name, target: shortTarget(ev.input) });
        else if (ev.type === 'error') pushLog(id, { type: 'error', text: ev.message });
        else if (ev.type === 'notice') pushLog(id, { type: 'notice', text: ev.text });
      },
      canUseTool: makeConfinedPolicy(cwd, noteWrite),
      abortController: ac,
    });
  } catch (e) {
    pushLog(id, { type: 'error', text: 'fix-up agent error: ' + (e?.message || String(e)) });
  } finally {
    aborts.delete(id);
    // Union in whatever it touched, even on an error/abort: a partially-written
    // file still belongs to this task and must be visible to the ship scope.
    if (wrote.size) {
      mutate(id, (task) => {
        const set = new Set(task.shipFiles || []);
        for (const p of wrote) set.add(p);
        task.shipFiles = [...set];
      });
    }
  }
}

// Commit exactly the task's OWN paths and push to origin on the current branch.
// Uses a partial commit (`git commit -- <paths>`) so any other staged or dirty
// files in the operator's tree are left untouched. Surfaces hook / push failures
// verbatim so the operator can act.
//
// The scope rule changed after the audit. The old rule was "the task's files, OR
// anything that changed since the accept snapshot" — so a chat turn, or the
// operator editing the same project during the (potentially many-minute) verify
// window, was committed and pushed under an "ops: …" subject that had nothing to
// do with it. The rule is now strictly:
//
//     ship = files the patch touched  ∪  files a fix-up agent actually wrote
//
// Both sets are recorded at the moment they happen (patchNumstat at accept time,
// canUseTool during a fix-up), never inferred from the state of the tree.
// Anything else that changed is reported on the task log and left alone.
async function shipChanges(id, root, task) {
  let changed;
  try { changed = await gitChangedPaths(root); } catch (e) { return { ok: false, error: 'could not read working tree: ' + (e.stderr || e.message) }; }
  const taskFiles = new Set(task.shipFiles || []);
  const shipPaths = changed.filter((p) => taskFiles.has(p));

  // Tell the operator, on the task, exactly what we declined to commit. Silence
  // here is what made the old over-broad commit invisible until it was pushed.
  const foreign = changed.filter((p) => !taskFiles.has(p));
  if (foreign.length) {
    const shown = foreign.slice(0, 10).join(', ') + (foreign.length > 10 ? ` (+${foreign.length - 10} more)` : '');
    pushLog(id, { type: 'notice', text: 'Left alone (not this task\'s files): ' + shown });
  }
  if (shipPaths.length === 0) return { ok: true, empty: true, skipped: foreign.length };

  try {
    await git(root, ['add', '--', ...shipPaths]);
  } catch (e) {
    return { ok: false, error: 'git add failed: ' + (e.stderr || e.message) };
  }

  const subject = commitSubject(task);
  const body = 'Applied and pushed by PlumiChat Operations after the test suite passed.\nTask ' + id + '.';
  try {
    // Partial commit: only the listed paths, even if other files are staged.
    await git(root, ['commit', '-m', subject, '-m', body, '--', ...shipPaths]);
  } catch (e) {
    // A pre-commit hook (e.g. a secret scanner) blocking is a feature — report it.
    return { ok: false, error: 'commit blocked (hook or git error): ' + (e.stderr || e.message) };
  }

  let branch = 'HEAD';
  try { branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || 'HEAD'; } catch { /* keep HEAD */ }
  if (branch === 'HEAD') {
    // Detached HEAD: `git push origin HEAD` would push to a ref named HEAD on the
    // remote. Refuse rather than guess — the commit is safely local.
    return { ok: false, error: 'this project is on a detached HEAD, so there is no branch to push to (the commit is in place locally; check out a branch and push manually)' };
  }
  try {
    await git(root, ['push', 'origin', branch]);
  } catch (e) {
    return { ok: false, error: 'pushed nothing — `git push origin ' + branch + '` failed: ' + (e.stderr || e.message) + ' (the commit is in place locally; push manually)' };
  }
  let sha = null;
  try { sha = (await git(root, ['rev-parse', '--short', 'HEAD'])).stdout.trim(); } catch { /* best effort */ }
  return { ok: true, sha, branch, skipped: foreign.length };
}

// A short, human commit subject derived from the task's summary (first line) or
// its category, kept to a single tidy line.
function commitSubject(task) {
  const first = String(task.summary || '').split('\n').map((s) => s.replace(/^[-*•]\s*/, '').trim()).find(Boolean);
  const base = first || (task.category && task.category !== 'general' ? task.category + ' update' : 'automated update');
  const clean = base.replace(/\s+/g, ' ').trim().slice(0, 64);
  return 'ops: ' + clean;
}

// Reject shares the accept guard: an Accept already in flight is mid-`git apply`
// on the real tree, and deleting its patch out from under it would leave the
// operator with a half-applied change and no record of what it was.
export function rejectTask(id) {
  if (transitioning.has(id)) throw new Error('that task is already being processed — give it a moment');
  transitioning.add(id);
  try {
    const t = load().tasks.find((x) => x.id === id);
    if (!t) throw new Error('task not found');
    if (t.status !== 'needs_approval') throw new Error('task is not awaiting approval');
    cleanupArtifacts(id);
    mutate(id, (task) => { task.status = 'rejected'; task.finishedAt = now(); });
    return { ok: true };
  } finally {
    transitioning.delete(id);
  }
}

function cleanupArtifacts(id) {
  try { fs.rmSync(patchFile(id), { force: true }); } catch { /* ignore */ }
  removeWorktreeFor(id);
  // A native task's worktree lives inside the PROJECT (.claude/worktrees/<id>),
  // not under DATA_DIR, and its session is a separate process with its own job
  // record — neither of which removeWorktreeFor knows about. No-op for SDK tasks.
  try { removeNativeArtifacts(id); } catch { /* best effort */ }
}

// Remove a task's isolated worktree AND git's registration of it.
//
// The old version returned early when the directory was already gone — which is
// exactly the case a killed server leaves behind: `git worktree list` still holds
// an entry pointing at a path that no longer exists, and the stale registration
// makes the NEXT `git worktree add` for that path fail ("already registered").
// So: always attempt the git-level removal, even with no directory and even when
// the task record has been pruned away (in which case we prune the repo instead,
// the only deregistration possible without knowing which repo owned it).
function removeWorktreeFor(id) {
  const wt = worktreePath(id);
  const t = load().tasks.find((x) => x.id === id);
  let cwd = null;
  if (t) { try { cwd = resolveInRoot(t.project); } catch { /* unknown repo */ } }
  if (cwd) {
    // `worktree remove` refuses a missing directory; `prune` is what clears that
    // case, so run both and let each fail harmlessly when it does not apply.
    try { execFileSyncQuiet('git', ['-C', cwd, 'worktree', 'remove', '--force', wt]); } catch { /* fall through */ }
    try { execFileSyncQuiet('git', ['-C', cwd, 'worktree', 'prune']); } catch { /* fall through */ }
  }
  try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
}

// Drop git's registrations for worktrees whose directory is gone. Called for the
// repos of interrupted runs at boot.
function pruneWorktrees(cwd) {
  try { execFileSyncQuiet('git', ['-C', cwd, 'worktree', 'prune']); } catch { /* best effort */ }
}

function execFileSyncQuiet(cmd, args) {
  // Synchronous git used only on cleanup paths; swallow noise.
  return execFileSync(cmd, args, { stdio: 'ignore' });
}


// Pull the next queued task and run it. One at a time keeps it calm + safe.
let budgetHalted = false;
function kick() {
  if (running) return;
  const next = load().tasks
    .filter((t) => t.status === 'queued')
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0];
  if (!next) return;
  // An autonomous runner is the thing a workspace budget most needs to be able to
  // stop: nobody is watching it. The task STAYS QUEUED rather than failing — the
  // budget rolls over and the work is still wanted — and says so once on its own
  // log, so the board shows why it is sitting there instead of just sitting there.
  const budget = spendGate();
  if (budget) {
    if (!budgetHalted) { budgetHalted = true; pushLog(next.id, { type: 'notice', text: budget }); }
    return;
  }
  budgetHalted = false;
  running = true;
  executeTask(next.id).catch(() => { /* errors are recorded on the task */ })
    .finally(() => { running = false; kick(); });
}

// Promote any scheduled task whose time has arrived. Runs on a timer while PlumiChat
// is awake, and once on boot — so a task that came due while the box slept fires
// on wake (a single catch-up run, not a backlog: the next occurrence is computed
// forward from now, never replayed).
function tick() {
  const nowMs = Date.now();
  const due = load().tasks.filter(
    (t) => t.status === 'scheduled' && t.nextRun && new Date(t.nextRun).getTime() <= nowMs,
  );
  let promoted = false;
  for (const t of due) {
    if (t.schedule && t.schedule.type !== 'once') {
      // Recurring routine: fire a run now, advance to the next occurrence.
      spawnRun(t);
      mutate(t.id, (task) => { task.lastRunAt = now(); task.nextRun = computeNextRun(task.schedule); });
    } else {
      // One-off: the scheduled task itself becomes the run.
      mutate(t.id, (task) => { task.status = 'queued'; task.nextRun = null; });
    }
    promoted = true;
  }
  if (promoted) kick();
}

function ensureTicker() {
  if (ticker) return;
  ticker = setInterval(() => { try { tick(); } catch { /* keep the timer alive */ } }, TICK_MS);
  if (ticker.unref) ticker.unref(); // never hold the process open for the sweep alone
}



async function executeTask(id) {
  const task = load().tasks.find((x) => x.id === id);
  if (!task) return;
  mutate(id, (t) => { t.status = 'running'; t.startedAt = now(); t.error = ''; });

  // Register the abort controller BEFORE the first await. Setup (rev-parse,
  // worktree add, the live-signals fetch) takes seconds, and cancelTask used to
  // find no controller during that window, report ok and do nothing at all. Now
  // the controller exists from the first instant, and every setup await is
  // followed by a bail check so Cancel always takes effect.
  const ac = new AbortController();
  aborts.set(id, ac);
  // Honour a cancel that arrived between kick() and here.
  if (cancelRequested.has(id)) ac.abort();
  // Bail out of setup cleanly, leaving nothing registered or half-built.
  const bailIfCancelled = () => {
    if (!ac.signal.aborted && !cancelRequested.has(id)) return false;
    cancelRequested.delete(id);
    aborts.delete(id);
    removeWorktreeFor(id);
    finish(id, 'cancelled', { error: 'cancelled before the run started' });
    return true;
  };

  let cwd;
  try {
    cwd = resolveInRoot(task.project);
    if (!fs.statSync(cwd).isDirectory()) throw new Error('not a directory');
  } catch (e) {
    aborts.delete(id);
    cancelRequested.delete(id);
    return finish(id, 'error', { error: 'invalid project: ' + e.message });
  }
  if (bailIfCancelled()) return;

  // Require a git repo with at least one commit — that's the safety boundary.
  try {
    await git(cwd, ['rev-parse', '--is-inside-work-tree']);
    await git(cwd, ['rev-parse', 'HEAD']);
  } catch {
    aborts.delete(id);
    cancelRequested.delete(id);
    return finish(id, 'error', {
      error: 'project is not a git repository with a commit. The background runner needs git to isolate and review changes.',
    });
  }
  if (bailIfCancelled()) return;

  // The fork. Everything above is backend-agnostic (project resolution, the git
  // repo requirement, the cancel checks); everything below this line is the SDK
  // backend and is reached unchanged whenever `runner` is absent or 'sdk'.
  if (isNativeRunner(task)) return await executeNativeTask(id, task, cwd, ac);

  const wt = worktreePath(id);
  removeWorktreeFor(id); // clear any stale worktree from a prior attempt
  try {
    await git(cwd, ['worktree', 'add', '--detach', wt, 'HEAD']);
  } catch (e) {
    aborts.delete(id);
    cancelRequested.delete(id);
    return finish(id, 'error', { error: 'could not create isolated worktree: ' + (e.stderr || e.message) });
  }
  if (bailIfCancelled()) return;

  // Live production signals (redacted error digest) come first — the freshest
  // "what's broken now". Fetched server-side with the admin key kept out of the
  // prompt; a no-op when the project has no signals source configured.
  const live = await fetchLiveSignals(task, cadenceOf(task));
  if (live) mutate(id, (t) => { t.liveSignals = live.snapshot; });
  if (bailIfCancelled()) return;
  // Operational memory + cross-area notes + working method, injected ahead of
  // the routine's own prompt (empty string for a simple one-off with no history).
  // `noteIds` are the incoming handoff notes this prompt consumed — they are
  // acknowledged only if the run actually reaches a terminal SUCCESS (see below),
  // so a cancelled or crashed run does not swallow another area's message.
  const { text: ctx, noteIds } = buildRunContext(task, live && live.block ? live.block : '');
  let finalText = '';
  try {
    await runPrompt({
      prompt: ctx + task.prompt + OUTPUT_SUFFIX,
      cwd: wt,
      model: task.model,
      effort: 'high',
      onEvent: (ev) => {
        if (ev.type === 'text') { finalText += ev.text; }
        else if (ev.type === 'tool') { pushLog(id, { type: 'tool', name: ev.name, target: shortTarget(ev.input) }); }
        else if (ev.type === 'error') { pushLog(id, { type: 'error', text: ev.message }); }
        else if (ev.type === 'notice') { pushLog(id, { type: 'notice', text: ev.text }); }
      },
      // Autonomous + confined: file edits must stay inside the worktree, Bash is
      // off, questions auto-proceed. This is the structural safety boundary.
      canUseTool: makeConfinedPolicy(wt),
      abortController: ac,
    });
  } catch (e) {
    pushLog(id, { type: 'error', text: e?.message || String(e) });
  } finally {
    aborts.delete(id);
    cancelRequested.delete(id);
  }

  if (ac.signal.aborted) {
    removeWorktreeFor(id);
    const cut = splitSummary(finalText);
    // Notes stay OPEN: this run never delivered on them, so the next run of this
    // area must still see them.
    return finish(id, 'cancelled', { summary: cut.summary, detail: cut.detail });
  }

  // Capture the diff the agent produced inside the worktree.
  const cap = await capturePatch(id, wt);

  // The patch is saved; the worktree has served its purpose.
  removeWorktreeFor(id);

  return finishCapturedRun(id, task, finalText, noteIds, cap);
}

/* ── The native backend ──────────────────────────────────────────────────
 * One `claude --bg --worktree <task id>` session per task, driven through the
 * CLI (server/ops-native.js holds every invocation and the notes on what each
 * command really does). PlumiChat stops owning the worktree, the child process and
 * the abort plumbing; it keeps owning everything that follows the capture — the
 * approval gate, the fail-closed apply, the ship scope, the board.
 *
 * The shape below deliberately mirrors executeTask's SDK path step for step, so
 * the two stay comparable: same context builder, same OUTPUT_SUFFIX, same
 * cancel checks, same capture, same terminal statuses. Three things differ, and
 * all three are consequences of the process living outside this one:
 *
 *   • Confinement is `--restricted` instead of canUseTool (verified equivalent
 *     for the two rules that matter: no Bash, no writes outside the worktree).
 *   • Progress arrives by POLLING `claude agents --json` rather than as a
 *     stream, and the agent's words come from the session's JSONL transcript —
 *     `claude logs` is an ANSI screen dump, not text.
 *   • A session that ends badly (blocked on a permission prompt with no human,
 *     a reported failure, a stop from outside, the run ceiling) still has its
 *     worktree captured: nothing the agent did is thrown away silently. It
 *     lands in needs_approval WITH the reason recorded, or — when there is no
 *     patch at all — in 'error' with that same reason, never a quiet 'done'.
 *
 * Fail-closed is the rule everywhere: there is no branch that leaves a task in
 * 'running'. The poll loop is bounded by NATIVE_MAX_MS, three unreadable
 * listings in a row end it, and an unrecognised state ends it too, naming the
 * state in the error rather than waiting for one it knows.
 */
async function executeNativeTask(id, task, cwd, ac) {
  // Refuse before anything is created. The probe is cached, so this is a map
  // lookup on every run after the first.
  const cap = await nativeCapability();
  if (!cap.ok) {
    aborts.delete(id);
    cancelRequested.delete(id);
    return finish(id, 'error', { error: 'the native runner is unavailable: ' + cap.reason });
  }

  // Clear whatever a previous attempt of THIS task id left behind — a retry
  // reuses the id, and therefore the worktree name and the branch name.
  await nativePreflightCleanup(id, task, cwd);

  // Identical context to the SDK path: live production signals first, then
  // operational memory + cross-area notes, then the operator's own prompt.
  const live = await fetchLiveSignals(task, cadenceOf(task));
  if (live) mutate(id, (t) => { t.liveSignals = live.snapshot; });
  const { text: ctx, noteIds } = buildRunContext(task, live && live.block ? live.block : '');

  if (ac.signal.aborted || cancelRequested.has(id)) {
    aborts.delete(id);
    cancelRequested.delete(id);
    return finish(id, 'cancelled', { error: 'cancelled before the run started' });
  }

  let session;
  try {
    session = await startNativeSession({
      projectDir: cwd,
      taskId: id,
      prompt: ctx + task.prompt + OUTPUT_SUFFIX,
      model: task.model,
      effort: 'high', // the SDK path's effort, kept in step
    });
  } catch (e) {
    aborts.delete(id);
    cancelRequested.delete(id);
    // A half-started session can still have left a worktree behind.
    removeNativeWorktree(cwd, id);
    return finish(id, 'error', { error: (e && e.message) || String(e) });
  }
  // Record the handles BEFORE the first await of the poll loop, so a crash from
  // here on leaves initRunner enough to find and clean up.
  mutate(id, (t) => {
    t.native = {
      id: session.id,
      sessionId: session.sessionId,
      worktree: session.worktree,
      branch: session.branch,
      startedAt: now(),
      removed: false,
    };
  });
  pushLog(id, { type: 'notice', text: 'native background session ' + session.id + ' on branch ' + session.branch });

  const deadline = Date.now() + NATIVE_MAX_MS;
  let sessionId = session.sessionId;
  let verdict = { verdict: 'unknown', state: null, status: null };
  let settled = 0;      // consecutive non-active observations; two before we act
  let listFailures = 0; // consecutive `claude agents --json` failures
  let toolsSeen = 0;    // transcript tool_use blocks already pushed to the log
  let cancelled = false;

  for (;;) {
    if (ac.signal.aborted || cancelRequested.has(id)) { cancelled = true; break; }
    if (Date.now() > deadline) { verdict = { verdict: 'timeout', state: null, status: null }; break; }
    // Resolves early when Cancel aborts, so a cancel is never sat on for a
    // whole poll interval.
    await nativeSleep(NATIVE_POLL_MS, ac.signal);
    if (ac.signal.aborted || cancelRequested.has(id)) { cancelled = true; break; }

    let row;
    try {
      row = await findNativeSession(session.id);
      listFailures = 0;
    } catch (e) {
      listFailures += 1;
      pushLog(id, { type: 'error', text: 'could not read `claude agents --json`: ' + ((e && e.message) || String(e)) });
      if (listFailures >= 3) { verdict = { verdict: 'unreadable', state: null, status: null }; break; }
      continue;
    }

    // The session id only reaches us through the listing; without it there is no
    // transcript to read, so pick it up the first time it appears.
    if (row && !sessionId && typeof row.sessionId === 'string' && row.sessionId) {
      sessionId = row.sessionId;
      mutate(id, (t) => { if (t.native) t.native.sessionId = sessionId; });
    }
    toolsSeen = drainNativeTools(id, session.worktree, sessionId, toolsSeen);

    const v = nativeSessionVerdict(row);
    if (v.verdict === 'active') { settled = 0; continue; }
    // A row that has vanished from `--all` is definitive: somebody removed the
    // job. There is nothing to confirm on a second poll.
    if (v.verdict === 'gone') { verdict = v; break; }
    settled += 1;
    if (settled >= 2) { verdict = v; break; }
  }

  aborts.delete(id);
  cancelRequested.delete(id);

  // Stop FIRST, always. On a clean finish the session is merely idle — it is
  // still alive and could be handed more work — and on a timeout it is actively
  // editing. Diffing a worktree while its agent still holds the pen is how you
  // capture half a change.
  await stopNativeSession(session.id);

  const transcript = readNativeTranscript({ worktree: session.worktree, sessionId });
  drainNativeTools(id, session.worktree, sessionId, toolsSeen);
  const finalText = transcript.text;

  if (cancelled) {
    // Mirrors the SDK path's abort branch exactly: the worktree goes, the notes
    // stay OPEN (this run never delivered on them), and whatever the agent had
    // said is kept as the summary.
    await nativeTeardown(id, cwd, session.id);
    const cut = splitSummary(finalText);
    return finish(id, 'cancelled', { summary: cut.summary, detail: cut.detail });
  }

  const reason = nativeVerdictReason(verdict);
  if (reason) pushLog(id, { type: 'error', text: reason });
  const captured = await capturePatch(id, session.worktree);
  await nativeTeardown(id, cwd, session.id);
  return finishCapturedRun(id, task, finalText, noteIds, captured,
    reason ? { emptyStatus: 'error', fields: { error: reason } } : undefined);
}

// Why a native run ended, in the operator's words. null means "cleanly" — the
// only case that behaves exactly like a successful SDK run.
function nativeVerdictReason(v) {
  const state = v && v.state ? v.state : 'none';
  switch (v && v.verdict) {
    case 'done':
      return null;
    case 'blocked':
      return 'the background session stopped to ask a human (state: blocked) — an unattended task has nobody to answer, so it was stopped. Anything it had already changed is captured for review.';
    case 'failed':
      return 'the background session reported a failure (state: failed) — see its log entries above.';
    case 'stopped':
      return 'the background session was stopped from outside PlumiChat before it finished.';
    case 'gone':
      return 'the background session disappeared from `claude agents` before it finished.';
    case 'timeout':
      return 'the background session passed the ' + humanMs(NATIVE_MAX_MS) + ' ceiling for one run and was stopped.';
    case 'unreadable':
      return '`claude agents --json` could not be read three times running, so the run could not be tracked; the session was stopped.';
    default:
      return 'the background session ended in a state this runner does not recognise (' + state + ').';
  }
}

// A duration for a human, without dragging in a formatting dependency for one
// sentence. Sub-minute matters because the ceiling is env-tunable and a test (or
// an impatient operator) will set it to seconds.
function humanMs(ms) {
  if (ms < 60000) return Math.max(1, Math.round(ms / 1000)) + '-second';
  if (ms < 3600000) return Math.round(ms / 60000) + '-minute';
  const h = ms / 3600000;
  return (Number.isInteger(h) ? h : h.toFixed(1)) + '-hour';
}

// Push the tool calls that have appeared in the transcript since `seen` onto the
// task log, so the board shows live progress the way it does for an SDK run.
// Returns the new high-water mark. Never throws: a transcript that is missing,
// half-written or unreadable simply yields no new entries this poll.
//
// The transcript is flushed in batches, so this lags the agent by a few seconds
// (measured: files on disk at t+8s, their tool_use records readable at t+12s).
// It also re-reads the whole file each poll — bounded by the cap in ops-native
// and cheap at these sizes, and worth the simplicity of having no incremental
// parser state to get wrong.
function drainNativeTools(id, worktree, sessionId, seen) {
  if (!sessionId) return seen;
  let tools;
  try { tools = readNativeTranscript({ worktree, sessionId }).tools; } catch { return seen; }
  if (!Array.isArray(tools) || tools.length <= seen) return seen;
  for (let i = seen; i < tools.length; i++) {
    pushLog(id, { type: 'tool', name: tools[i].name, target: shortTarget(tools[i].input) });
  }
  return tools.length;
}

// Everything a finished native run leaves on the box: the worktree (which
// `claude rm` will not take while it holds uncommitted work), its branch, and
// the CLI's own job record.
async function nativeTeardown(id, cwd, sessionId) {
  // The worktree has to go before `claude rm`, which refuses (exit 0, "kept
  // <id>") while the tree holds uncommitted changes or unpushed commits — the
  // normal state of a PlumiChat run, whose whole point is that the diff is
  // reviewed before anything is committed.
  try { removeNativeWorktree(cwd, id); } catch { /* best effort */ }
  await removeNativeSession(sessionId);
  mutate(id, (t) => { if (t.native) t.native.removed = true; });
}

// Clear a previous attempt of the same task id before starting a new one: the
// worktree name and branch name are derived from the id, so a leftover would
// make `claude --bg --worktree` fail on a name that is already taken.
async function nativePreflightCleanup(id, task, cwd) {
  // The recorded id first; failing that, look the session up by the name we gave
  // it. A previous attempt that died between spawning and recording its id has
  // no stored handle, and the name is the only way back to it.
  let prior = task && task.native && task.native.id;
  if (!prior) {
    const row = await findNativeSessionByTask(id);
    prior = row ? row.id : null;
  }
  if (prior) await stopNativeSession(prior);
  // Worktree BEFORE `claude rm`: see nativeTeardown — rm keeps any session whose
  // worktree still holds uncommitted work, which is every PlumiChat run.
  try { removeNativeWorktree(cwd, id); } catch { /* best effort */ }
  if (prior) await removeNativeSession(prior);
}

// Native artifacts for one task, from the task record alone — the cleanup entry
// point the delete/prune/boot paths call. A no-op for SDK tasks.
function removeNativeArtifacts(id) {
  const t = load().tasks.find((x) => x.id === id);
  if (!t || !isNativeRunner(t)) return;
  // Same fallback as the preflight path: a run killed between spawn and record
  // left a live session with no stored id, and only its name can find it again.
  let sid = t.native && t.native.id;
  const pending = !(t.native && t.native.removed);
  // The lookup costs a subprocess, and this runs once per pruned task, so it is
  // gated on the task having actually STARTED: without a startedAt it never
  // reached executeTask and cannot have spawned anything.
  if (!sid && pending && t.startedAt) {
    const row = findNativeSessionByTaskSync(t.id);
    sid = row ? row.id : null;
  }
  // Stop first — an interrupted run's session is still ALIVE (that is what
  // `--bg` buys) and would keep editing a worktree nobody is watching.
  if (sid && pending) stopNativeSessionSync(sid);
  let cwd = null;
  try { cwd = resolveInRoot(t.project); } catch { cwd = null; } // unknown repo
  if (cwd) { try { removeNativeWorktree(cwd, t.id); } catch { /* best effort */ } }
  // …and only THEN the job record: `claude rm` keeps a session whose worktree
  // still holds uncommitted work, so removing it first is a silent no-op that
  // leaves one dead entry in `claude agents` per interrupted run.
  if (sid && pending) {
    removeNativeSessionSync(sid);
    mutate(id, (x) => { if (x.native) x.native.removed = true; });
  }
}

/* ── The shared tail of a run, whichever backend produced it ─────────────
 * Both backends end the same way: a git worktree holding the agent's edits, plus
 * the agent's final text. Everything from here down — the binary-safe patch, the
 * per-file breakdown the review pane reads, the summary split, the handoff notes
 * — is identical, and is deliberately written ONCE. The hardening comments below
 * are load-bearing history; read them before changing the git invocations.
 */

// Stage everything the agent did in `wt` and write the reviewable patch.
// Never throws: a capture failure is logged on the task and reported as "no
// patch", which lands the run in a terminal status instead of wedging it.
async function capturePatch(id, wt) {
  let diff = { files: 0, additions: 0, deletions: 0 };
  let diffFiles = [];
  let hasPatch = false;
  try {
    await git(wt, ['add', '-A']);
    const { stdout: numstat } = await git(wt, ['diff', '--cached', '--numstat', '-z']);
    diff = parseNumstat(numstat);
    // Keep the per-file breakdown for the review pane (taskPatch). Computed HERE,
    // from git's own machine-readable output, so serving it later needs no git
    // call and no re-parsing of C-quoted paths out of the patch text. Bounded so
    // a pathological run cannot bloat operations.json.
    diffFiles = parseNumstatZ(numstat).slice(0, 500).map((f) => ({
      path: f.path, added: f.added, removed: f.removed, binary: f.binary,
      // Present only for a rename, so the review pane can say "X → Y".
      ...(f.pathFrom ? { pathFrom: f.pathFrom } : {}),
    }));
    // --binary is REQUIRED. Without it git emits a "Binary files differ" stub
    // instead of the literal delta, and the later `git apply --3way` refuses with
    // "cannot apply binary patch … without full index line" — so a task that
    // touched any binary file (an image, a .xlsx, a compiled asset) could never
    // be accepted at all. Verified on git 2.53.0.
    const { stdout: patch } = await git(wt, ['diff', '--cached', '--binary']);
    if (patch && patch.trim()) {
      fs.writeFileSync(patchFile(id), patch);
      hasPatch = true;
    }
  } catch (e) {
    pushLog(id, { type: 'error', text: 'diff capture failed: ' + (e.stderr || e.message) });
  }
  return { diff, diffFiles, hasPatch };
}

// Land a captured run in its terminal status.
// `opts.emptyStatus` overrides the status used when the run produced NO patch
// (the native path uses it to say 'error' for a session that ended badly rather
// than reporting a clean 'done'); `opts.fields` adds fields to finish(). Called
// with neither, this is byte-for-byte the behaviour the SDK path always had.
function finishCapturedRun(id, task, finalText, noteIds, cap, opts) {
  const o = opts || {};
  const { summary, detail } = splitSummary(finalText);
  // Persist any cross-area handoff notes the agent wrote, for other areas' runs.
  persistHandoffs(id, task, finalText);
  // The run completed and produced a result, so the incoming notes it read have
  // genuinely been handled — only now do they stop being fresh action items.
  // Acking them at prompt-build time (as before) meant a cancelled or errored run
  // consumed another area's message forever, and nobody ever saw it.
  ackNotes(noteIds, id);
  if (cap.hasPatch) {
    mutate(id, (t) => { t.diffFiles = cap.diffFiles; });
    return finish(id, 'needs_approval', { summary, detail, diff: cap.diff, ...(o.fields || {}) });
  }
  // No file changes — a research/answer task. Keep the summary; nothing to apply.
  return finish(id, o.emptyStatus || 'done', { summary, detail, diff: cap.diff, ...(o.fields || {}) });
}

// Split the agent's final text into a glanceable summary (the trailing
// "### Summary" block we asked for) and the full narration before it. If the
// agent never emitted the marker, fall back to the whole text as the summary so
// nothing is ever lost.
function splitSummary(text) {
  const full = String(text || '').trim();
  const idx = full.lastIndexOf(SUMMARY_MARK);
  let summary, detail;
  if (idx === -1) { summary = full; detail = ''; }
  else {
    summary = full.slice(idx + SUMMARY_MARK.length).trim();
    detail = full.slice(0, idx).trim();
    if (!summary) { summary = detail || full; detail = ''; } // marker but empty body
  }
  // Keep the agent's "### Handoffs" block out of the narration view — it's parsed
  // and persisted separately as cross-area notes (see extractHandoffs).
  const hi = detail.indexOf(HANDOFF_MARK);
  if (hi !== -1) detail = detail.slice(0, hi).trim();
  return { summary, detail };
}

function finish(id, status, fields) {
  // A task reaching a terminal status can have no meaningful cancellation
  // pending. Clearing both flags here keeps the sets bounded and — the reason
  // that matters — stops a leftover flag from cancelling a LATER run of the same
  // id the moment it reaches its first checkpoint.
  cancelRequested.delete(id);
  cancelling.delete(id);
  const r = mutate(id, (t) => {
    t.status = status;
    t.finishedAt = now();
    if (fields.summary != null) t.summary = fields.summary;
    if (fields.detail != null) t.detail = fields.detail;
    if (fields.error != null) t.error = fields.error;
    if (fields.diff != null) t.diff = fields.diff;
    if (fields.testOutput != null) t.testOutput = fields.testOutput;
    if (fields.shipCommit != null) t.shipCommit = fields.shipCommit;
    if (fields.shipBranch != null) t.shipBranch = fields.shipBranch;
  });
  pruneHistory(); // a task just went terminal → trim old history if over cap
  return r;
}

// Bound the task board: keep the most-recent HISTORY_CAP terminal tasks and drop
// older ones (plus their on-disk artifacts — patch files, any stray worktree).
// Active and awaiting-approval tasks are always kept. Cheap no-op under the cap.
function pruneHistory() {
  const terminal = load().tasks.filter((t) => !ACTIVE_STATUSES.has(t.status));
  if (terminal.length <= HISTORY_CAP) return;
  terminal.sort((a, b) => {
    const ta = new Date(a.finishedAt || a.createdAt || 0).getTime();
    const tb = new Date(b.finishedAt || b.createdAt || 0).getTime();
    return ta - tb; // oldest first
  });
  const drop = new Set(terminal.slice(0, terminal.length - HISTORY_CAP).map((t) => t.id));
  for (const id of drop) { try { cleanupArtifacts(id); } catch { /* best effort */ } }
  updateTasks((db) => { db.tasks = db.tasks.filter((t) => !drop.has(t.id)); return db; });
}

// Board totals from a `git diff --numstat -z` stream (see parseNumstatZ).
function parseNumstat(out) {
  const files = parseNumstatZ(out);
  let additions = 0, deletions = 0;
  for (const f of files) { additions += f.added; deletions += f.removed; }
  return { files: files.length, additions, deletions };
}

function shortTarget(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input.slice(0, 80);
  if (input.file_path) return String(input.file_path).split('/').slice(-2).join('/');
  if (input.path) return String(input.path);
  if (input.command) return String(input.command).slice(0, 60);
  if (input.pattern) return String(input.pattern).slice(0, 60);
  if (input.url) return String(input.url).slice(0, 60);
  return '';
}

// On boot, recover from an interrupted run, fire any schedules that came due
// while we were down, and resume the queue.
export function initRunner() {
  // Collected while flipping statuses, cleaned up after the write lands (so
  // removeWorktreeFor still sees the task record it needs to find the repo).
  const interrupted = [];
  updateTasks((db) => {
    db.tasks.forEach((t) => {
      if (t.status === 'running') {
        interrupted.push(t.id);
        t.status = 'error';
        t.error = 'interrupted by a server restart';
        t.finishedAt = now();
      } else if (t.status === 'verifying' || t.status === 'fixing' || t.status === 'shipping') {
        // The pipeline can't safely resume mid-flight after a restart; the
        // changes are already applied to the working tree, so flag it for a
        // human to re-run verification or ship manually.
        t.status = 'verify_failed';
        t.error = 'verify/ship interrupted by a server restart — changes are applied to the working tree; re-run or ship manually';
        t.finishedAt = now();
      }
    });
    return db;
  });

  // A killed server leaves its worktree on disk AND registered with the repo.
  // The directory alone is ~a working copy of the project; the registration is
  // worse, because it makes the next `git worktree add` for that path fail and
  // every future run of that task error out. Remove both, then prune each repo
  // once to clear registrations whose directory has already vanished.
  const repos = new Set();
  for (const id of interrupted) {
    const t = load().tasks.find((x) => x.id === id);
    if (t) { try { repos.add(resolveInRoot(t.project)); } catch { /* unknown repo */ } }
    try { removeWorktreeFor(id); } catch { /* best effort */ }
    // A native run's background session SURVIVES a server restart — that is the
    // point of `claude --bg`. It is also the danger: an orphaned agent would go
    // on editing a worktree that nothing is watching, and its worktree + branch
    // would block the task's next attempt. Stop it, remove the job record, take
    // the worktree and branch down. (Re-ATTACHING to a survivor instead of
    // killing it is the obvious next step for this backend, but it needs the
    // run registry to learn about resumable runs; until then we match the SDK
    // path's behaviour exactly: interrupted means over.)
    try { removeNativeArtifacts(id); } catch { /* best effort */ }
  }
  // Any leftover worktree directory with no task record at all is an orphan from
  // a pruned task — nothing references it, so it is safe to delete outright.
  try {
    const known = new Set(load().tasks.map((t) => t.id));
    for (const name of fs.readdirSync(WORKTREES_DIR)) {
      if (known.has(name)) continue;
      try { fs.rmSync(path.join(WORKTREES_DIR, name), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  } catch { /* no worktrees dir yet */ }
  for (const repo of repos) pruneWorktrees(repo);
  // The same orphan argument for the native side, whose worktrees live inside
  // the PROJECT (.claude/worktrees/<task id>) rather than under DATA_DIR: a
  // directory whose task record is gone — pruned history, a task deleted while
  // the server was down — is referenced by nothing and would sit there being one
  // full checkout of the project. Every repo a native task has ever named is
  // swept, which is an empty set (and therefore free) on a board that has only
  // ever used the SDK runner. Only PlumiChat's own op_<12 hex> naming is touched, so
  // a worktree the owner created by hand, or one of their own `claude --worktree`
  // sessions, is never in scope.
  const nativeRepos = new Set();
  for (const t of load().tasks) {
    if (!isNativeRunner(t)) continue;
    try { nativeRepos.add(resolveInRoot(t.project)); } catch { /* unknown repo */ }
  }
  if (nativeRepos.size) {
    const known = new Set(load().tasks.map((t) => t.id));
    for (const repo of nativeRepos) {
      try { sweepNativeWorktrees(repo, known); } catch { /* best effort */ }
    }
  }
  // Warm the native capability probe so the board's runner picker has a real
  // answer (and a real REASON when native is off the table) on first load.
  primeNativeCapability();

  pruneHistory(); // trim any backlog that accumulated before the cap existed
  ensureTicker();
  try { tick(); } catch { /* a bad schedule must not block boot */ }
  kick();
}
