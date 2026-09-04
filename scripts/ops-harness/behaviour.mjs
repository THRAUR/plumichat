// Characterisation test for server/operations.js.
//
// Records what the module DOES, through its public exports, against a throwaway
// DATA_DIR and a throwaway workspace. Run before the split to make a golden file,
// run after to prove nothing observable changed.
//
// What it deliberately never touches: runNow(), acceptTask() and initRunner().
// Those start an autonomous agent or apply a patch to a real working tree. Every
// task it creates is scheduled for 2030, because createTask() with no schedule
// calls kick() and the runner would take it immediately.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Everything is resolved from THIS file, so the harness runs from any checkout on
// any OS — no absolute paths, no assumptions about where the repo lives.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(os.tmpdir(), 'ops-harness');
const mode = process.argv[2]; // 'before' | 'after'
const DATA = path.join(OUT, `data-${mode}`);
// A throwaway workspace, NOT a real one: the harness creates a project directory
// inside it and this must never be somewhere you keep work.
const WS = path.join(OUT, 'workspace');
const PROJECT = 'zz-ops-harness';
const PROJ_DIR = path.join(WS, PROJECT);

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(WS, { recursive: true });
fs.mkdirSync(PROJ_DIR, { recursive: true });
fs.writeFileSync(path.join(PROJ_DIR, 'a.txt'), 'hello\n');

process.env.DATA_DIR = DATA;
process.env.WORKSPACES_ROOT = WS;

const SRC = path.join(REPO, 'server', 'operations.js');
const ops = await import(pathToFileURL(SRC).href);

const rec = {};
const capture = (label, fn) => {
  try { rec[label] = { ok: true, value: fn() }; }
  catch (e) { rec[label] = { ok: false, error: String(e.message || e) }; }
};

// --- 1. The export surface. A function that failed to move, or moved without a
// re-export, dies here rather than in production.
rec.__exports = Object.keys(ops).sort().map((k) => ({
  name: k, type: typeof ops[k], arity: typeof ops[k] === 'function' ? ops[k].length : null,
}));

// --- 2. Vocabulary and metadata: pure reads, no state.
capture('opsMeta', () => {
  const m = ops.opsMeta();
  // projects rescans the workspace root and varies with the disk; keep the shape,
  // drop the contents, so the golden file is about THIS module.
  return { ...m, projects: Array.isArray(m.projects) ? `[${m.projects.length} projects]` : m.projects };
});
capture('opsRunners', () => ops.opsRunners());
capture('emptyBoard', () => ops.listTasks());
capture('emptyStatus', () => ops.opsStatus());

// --- 3. Change notification: the invariant the SSE board depends on.
let changes = 0;
const unsub = ops.onOpsChange(() => { changes += 1; });

// --- 4. Task CRUD. Scheduled for 2030 so nothing ever runs.
const sched = { type: 'once', at: '2030-01-01T12:00', tz: 'UTC' };
const scrub = (t) => t && ({
  ...t, id: '<id>', createdAt: '<ts>',
  // nextRun is computed from the schedule, so it IS worth asserting — normalise
  // only the fields that move with wall-clock time.
  startedAt: t.startedAt ? '<ts>' : t.startedAt,
  finishedAt: t.finishedAt ? '<ts>' : t.finishedAt,
});

let a, b;
capture('createScheduled', () => { a = ops.createTask({ project: PROJECT, prompt: 'harness one', schedule: sched }); return scrub(a); });
capture('createWithCategory', () => {
  b = ops.createTask({ project: PROJECT, prompt: 'harness two', category: 'payments', model: 'haiku', runner: 'sdk', schedule: sched });
  return scrub(b);
});
capture('createBadCategory', () => scrub(ops.createTask({ project: PROJECT, prompt: 'x', category: 'not-a-real-category', schedule: sched })));
capture('createNoProject', () => ops.createTask({ prompt: 'x', schedule: sched }));
capture('createNoPrompt', () => ops.createTask({ project: PROJECT, schedule: sched }));
capture('createBadSchedule', () => ops.createTask({ project: PROJECT, prompt: 'x', schedule: { type: 'once', at: 'not-a-date' } }));

// --- 5. Recurring schedules: the calendar maths, reached through nextRun.
for (const s of [
  { type: 'daily', at: '09:30', tz: 'UTC' },
  { type: 'weekly', at: '09:30', weekday: 3, tz: 'UTC' },
  { type: 'hourly', tz: 'UTC' },
  { type: 'daily', at: '09:30', tz: 'Asia/Taipei' },
  { type: 'daily', at: '09:30', tz: 'Not/AZone' },
]) {
  capture(`schedule:${s.type}:${s.tz}:${s.weekday ?? '-'}`, () => {
    const t = ops.createTask({ project: PROJECT, prompt: 'sched probe', schedule: s });
    const out = { schedule: t.schedule, hasNextRun: !!t.nextRun };
    ops.deleteTask(t.id);
    return out;
  });
}

// Sorted by prompt, not left in board order: tasks created in the same millisecond
// tie on createdAt and are then ordered by their RANDOM id, so board order is
// stable within a run (which is the property that matters — the board must not
// reshuffle between refreshes) but not reproducible across runs. Assert content
// here and the stability property separately, below.
capture('listAfterCreates', () => ops.listTasks()
  .map((t) => ({ prompt: t.prompt, status: t.status, category: t.category, runner: t.runner }))
  .sort((x, y) => (x.prompt < y.prompt ? -1 : 1)));
// The actual invariant: two reads of an unchanged board agree.
capture('listIsStable', () => {
  const one = ops.listTasks().map((t) => t.id).join(',');
  const two = ops.listTasks().map((t) => t.id).join(',');
  return one === two ? 'stable' : 'RESHUFFLED BETWEEN READS';
});
capture('statusAfterCreates', () => ops.opsStatus());

capture('editPrompt', () => scrub(ops.editTask(a.id, { prompt: 'harness one, edited' })));
capture('editCategory', () => scrub(ops.editTask(a.id, { category: 'branding' })));
capture('editUnknownId', () => ops.editTask('op_deadbeefdead', { prompt: 'x' }));

capture('cancelScheduled', () => ops.cancelTask(b.id));
capture('cancelUnknown', () => ops.cancelTask('op_deadbeefdead'));
capture('patchMissing', () => ops.taskPatch(a.id));
capture('patchUnknownId', () => ops.taskPatch('op_deadbeefdead'));

capture('deleteOne', () => ops.deleteTask(a.id));
capture('deleteUnknown', () => ops.deleteTask('op_deadbeefdead'));
capture('boardAfterDeletes', () => ops.listTasks().map((t) => t.prompt).sort());

// --- 6. A task parked in needs_approval, so the approval-adjacent reads can be
// exercised without ever running an agent. Injected THROUGH store.js, not by
// writing the file: store.read() memoises per collection, so a file written
// behind its back is simply never seen (which is how the first cut of this
// harness quietly recorded needsApproval: 0).
const store = await import(pathToFileURL(path.join(REPO, 'server', 'store.js')).href);
store.update('operations', (db) => {
  db.tasks.push({
    id: 'op_fixture0001', project: PROJECT, prompt: 'awaiting a human', model: 'sonnet',
    category: 'general', runner: 'sdk', status: 'needs_approval', schedule: null,
    createdAt: '2026-01-01T00:00:00.000Z', startedAt: null, finishedAt: null,
    summary: 'did a thing', error: '', log: [], diff: { files: 1, additions: 2, deletions: 0 },
  });
  return db;
}, { tasks: [] });
capture('statusWithApproval', () => ops.opsStatus());
capture('rejectFixture', () => ops.rejectTask('op_fixture0001'));
capture('statusAfterReject', () => ops.opsStatus());
capture('rejectUnknown', () => ops.rejectTask('op_deadbeefdead'));

// The coalescing timer means the count is only meaningful after it has fired.
await new Promise((r) => setTimeout(r, 700));
rec.__changeNotifications = changes > 0 ? 'fired' : 'NEVER FIRED';
unsub();

fs.writeFileSync(path.join(OUT, `behaviour-${mode}.json`), JSON.stringify(rec, null, 1));
console.log(`${mode}: ${Object.keys(rec).length} observations, ${rec.__exports.length} exports, notifications ${rec.__changeNotifications}`);
fs.rmSync(PROJ_DIR, { recursive: true, force: true });
process.exit(0);
