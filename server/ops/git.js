// Git, the shell, and the test gate — the layer Operations runs the world through
// (audit § 4.3).
//
// Moved out of operations.js verbatim. Everything here shells out and comes back
// with data; none of it knows what a task is, reads the board, or touches the
// change notification. That is the whole reason it is a separate file: the parts
// of the runner that CAN damage a working tree all funnel through these few
// functions, and they are much easier to audit when they are not buried in the
// middle of two and a half thousand lines of scheduling and pipeline state.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const pexec = promisify(execFile);
export const TEST_TIMEOUT_MS = 8 * 60 * 1000; // hard cap on a single test run
const TEST_OUTPUT_CAP = 6000;          // chars of test output we keep on the task
// Pytest args for the gate: quiet, no on-disk cache (keeps the tree clean so we
// never accidentally stage a cache dir), and exclude *live* tests that hit real
// external services. A project opts in simply by having a `.venv` + pytest.
const PYTEST_ARGS = ['-q', '-p', 'no:cacheprovider', '--ignore-glob=*live*'];
// pytest's "no tests were collected" exit code. It is NOT a failing suite — it
// means there is no gate here at all — but the old code read it as red and spent
// two autonomous fix-up passes editing the operator's real tree for nothing.
const PYTEST_NO_TESTS_EXIT = 5;

export function git(cwd, args) { return pexec('git', ['-C', cwd, ...args], { maxBuffer: 64 * 1024 * 1024 }); }

// Run a command to completion, capturing output instead of throwing on a
// non-zero exit (a failing test run is data, not an exception). cwd sets the
// working directory; output is bounded by maxBuffer.
// The three failure shapes are NOT interchangeable and the old code flattened
// them all to `code: 1` (probed on Node 22, execFile):
//   timeout      -> e.code === null, e.signal === 'SIGTERM', e.killed === true
//   spawn error  -> e.code is a STRING ('ENOENT' when the venv python is gone)
//   real failure -> e.code is a number (pytest 1 = failures, 5 = nothing collected)
// Collapsing a timeout or a missing interpreter into "the tests are red" is what
// sent autonomous fix-up agents at the operator's real tree for no reason.
async function runCapture(cmd, args, cwd, timeoutMs) {
  try {
    const { stdout, stderr } = await pexec(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, stdout: stdout || '', stderr: stderr || '', signal: null, timedOut: false, spawnError: null };
  } catch (e) {
    const timedOut = !!e.killed || (e.code == null && !!e.signal);
    const spawnError = typeof e.code === 'string' ? e.code : null;
    return {
      code: typeof e.code === 'number' ? e.code : null,
      stdout: e.stdout || '',
      stderr: e.stderr || (e.message || ''),
      signal: e.signal || null,
      timedOut,
      spawnError,
    };
  }
}

// Decide how to run a project's test suite. Today: a Python project that has
// provisioned a local `.venv` and uses pytest. Returns null when no gate is
// configured — callers then skip auto-ship and leave the task `applied` for a
// human (preserving the pre-pipeline behavior). This is the seam to add Node /
// other runners later.
export function resolveTestCommand(cwd) {
  const venvPy = path.join(cwd, '.venv', 'bin', 'python');
  const usesPytest = fs.existsSync(path.join(cwd, 'pytest.ini'))
    || fs.existsSync(path.join(cwd, 'tests'))
    || fs.existsSync(path.join(cwd, 'pyproject.toml'));
  if (fs.existsSync(venvPy) && usesPytest) {
    return { label: 'pytest', cmd: venvPy, args: ['-m', 'pytest', ...PYTEST_ARGS] };
  }
  return null;
}

// Run the resolved test suite. `output` is a bounded tail suitable for showing
// the operator and feeding a fix-up agent.
// Returns { ok, output, noTests, timedOut, spawnError, code }. Only `ok` means
// green; `noTests` means the project has no gate after all; `timedOut` and
// `spawnError` mean we could not verify — none of the three is a red suite, and
// none of them may trigger a fix-up pass (see verifyAndShip).
export async function runTests(cwd, tc) {
  const r = await runCapture(tc.cmd, tc.args, cwd, TEST_TIMEOUT_MS);
  const merged = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
  const output = merged.length > TEST_OUTPUT_CAP ? merged.slice(-TEST_OUTPUT_CAP) : merged;
  return {
    ok: r.code === 0,
    output: output || '(no test output)',
    noTests: r.code === PYTEST_NO_TESTS_EXIT,
    timedOut: !!r.timedOut,
    spawnError: r.spawnError,
    code: r.code,
  };
}

/* ── Git path parsing: NUL-delimited, never split on spaces ───────────────
 * Default git porcelain output C-QUOTES any path with a space, a quote or a
 * non-ASCII byte, and the old parser split on ' -> ' and trimmed. This operator's
 * filenames are routinely Traditional Chinese, so "\344\270\255..." was being
 * handed verbatim to `git add --` / `git commit --` and the file was silently
 * dropped from the ship. Every path now comes from -z (NUL-terminated, never
 * quoted, never escaped) and is sliced by offset, never by delimiter search.
 *
 * SELF CHECK — the exact commands, and their exact output, probed on git 2.53.0
 * in a scratch repo containing a rename, a modified CJK filename and an
 * untracked filename with a space + a non-ASCII glyph ('<NUL>' shown for \0):
 *
 *   $ git -C <cwd> status --porcelain -uall -z
 *   R  renamed plain.txt<NUL>plain.txt<NUL> M 中文 檔案.txt<NUL>?? new untracked ✓.txt<NUL>
 *
 * Note the shape of a rename in -z mode: '->' is gone and the ORIGINAL path is
 * its own NUL-terminated field FOLLOWING the destination, so the parser must
 * consume an extra field whenever X or Y is 'R' or 'C'. Getting that wrong
 * shifts every subsequent record by one — which is why this is parsed as a
 * field stream, not line by line.
 *
 *   $ git -C <cwd> apply --numstat -z -- <patch>
 *   -\t-\tbin ary.dat<NUL>1\t0\tnew untracked ✓.txt<NUL>0\t0\trenamed plain.txt<NUL>1\t0\t中文 檔案.txt<NUL>
 *
 * ('-\t-' is git's marker for a binary file. `git diff --numstat -z` writes a
 * rename as an EMPTY path field followed by two more fields, from then to —
 * `git apply` resolves it to the destination, but both shapes are handled.)
 */

// `git status --porcelain` PRINTS paths relative to the repository root, while
// `git add` / `commit` / `checkout` / `reset` INTERPRET pathspecs relative to the
// directory they run in. Those two agree only when the project directory is
// itself the repo root. A project that lives in a subdirectory of a larger repo
// would otherwise stage the wrong path — or silently nothing — while the board
// reported a successful ship. Resolve the root once and run every path-based
// command there. Falls back to `cwd` when git cannot answer, which is exactly
// the old behaviour.
export async function repoRoot(cwd) {
  try {
    const { stdout } = await git(cwd, ['rev-parse', '--show-toplevel']);
    return String(stdout).trim() || cwd;
  } catch { return cwd; }
}

// Split NUL-terminated command output into fields, dropping the empty tail the
// final terminator produces. Never trims: a leading/trailing space is a legal
// part of a filename.
export function nulFields(stdout) {
  const parts = String(stdout).split('\0');
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

// Working-tree status as records: [{ x, y, path, from }]. `from` is the
// rename/copy SOURCE. Used to compute exactly which paths a task is responsible
// for, so auto-ship commits ONLY the task's own changes — never the operator's
// unrelated local edits.
export async function gitStatusRecords(cwd) {
  // -c core.quotePath=false is belt-and-braces: -z already disables quoting, but
  // it costs nothing and keeps the command correct if -z is ever dropped.
  const { stdout } = await git(cwd, ['-c', 'core.quotePath=false', 'status', '--porcelain', '-uall', '-z']);
  const fields = nulFields(stdout);
  const out = [];
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i];
    if (rec.length < 4) continue; // 'XY ' + at least one path character
    const x = rec[0], y = rec[1];
    const entry = { x, y, path: rec.slice(3), from: null }; // XY + one separating space
    if (x === 'R' || y === 'R' || x === 'C' || y === 'C') {
      // The next field is the rename/copy SOURCE, not a new record. Consuming it
      // is not optional: miss it and every later record shifts by one.
      i += 1;
      if (i < fields.length && fields[i]) entry.from = fields[i];
    }
    out.push(entry);
  }
  return out;
}

// Flat list of every path involved in a change. For a rename BOTH sides are
// returned: committing the destination without the source would leave the
// deletion uncommitted.
export async function gitChangedPaths(cwd) {
  const out = [];
  for (const r of await gitStatusRecords(cwd)) {
    out.push(r.path);
    if (r.from) out.push(r.from);
  }
  return out;
}

// One parser for both numstat producers (`git diff --numstat -z` at capture time
// and `git apply --numstat -z` at accept time). Returns
// [{ path, pathFrom, added, removed, binary }].
//   • '-' for both counts marks a binary file (no line delta to report).
//   • `git diff` writes a rename as an EMPTY path field followed by two more
//     fields, <from>\0<to>; `git apply` resolves it to the destination. Both
//     shapes are handled, and the source is kept as `pathFrom` so the ship stage
//     can stage the deletion alongside the addition.
export function parseNumstatZ(out) {
  const fields = nulFields(out);
  const files = [];
  for (let i = 0; i < fields.length; i++) {
    const cols = fields[i].split('\t');
    if (cols.length < 3) continue;
    const rawA = cols[0], rawD = cols[1];
    let p = cols[2], from = null;
    if (!p) { from = fields[i + 1] || null; p = fields[i + 2] || ''; i += 2; }
    if (!p) continue;
    const a = parseInt(rawA, 10), d = parseInt(rawD, 10);
    files.push({
      path: p,
      pathFrom: from && from !== p ? from : null,
      added: Number.isFinite(a) ? a : 0,
      removed: Number.isFinite(d) ? d : 0,
      binary: rawA === '-' && rawD === '-',
    });
  }
  return files;
}

// Per-file stats for a patch, WITHOUT applying it.
async function patchNumstat(cwd, pf) {
  try {
    const { stdout } = await git(cwd, ['apply', '--numstat', '-z', '--', pf]);
    return parseNumstatZ(stdout);
  } catch { return []; }
}

// The exact files a patch touches (without applying it). These are the task's
// own files; we always ship them, even if one was already dirty, so a task's
// change is never silently dropped. Genuinely-unrelated local edits are handled
// separately (see shipChanges). Both ends of a rename are returned: committing
// the destination without the source leaves the deletion behind.
export async function patchFilePaths(cwd, pf) {
  const out = [];
  for (const f of await patchNumstat(cwd, pf)) {
    out.push(f.path);
    if (f.pathFrom) out.push(f.pathFrom);
  }
  return out;
}
