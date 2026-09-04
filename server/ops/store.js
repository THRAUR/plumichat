// The Operations task store, and the one place that announces a change to it
// (audit § 4.3).
//
// Moved out of operations.js verbatim. Everything that persists a task goes
// through updateTasks() here, which is what makes the SSE board possible: a
// mutation that bypassed it would save correctly and be invisible to every board
// on screen. Keeping that rule in a file of its own is most of the reason for the
// split — it is a one-line mistake to make and a very confusing one to debug.
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { read, update, DATA_DIR } from '../store.js';

const COLLECTION = 'operations';
export const NOTES_COLLECTION = 'opsNotes'; // cross-area handoff notes left between routines
export const WORKTREES_DIR = path.join(DATA_DIR, 'worktrees');
export const PATCHES_DIR = path.join(DATA_DIR, 'patches');
fs.mkdirSync(WORKTREES_DIR, { recursive: true });
fs.mkdirSync(PATCHES_DIR, { recursive: true });

const LOG_CAP = 200; // keep a task's event log bounded

export const newId = () => 'op_' + crypto.randomBytes(6).toString('hex');
export const now = () => new Date().toISOString();

export function load() { return read(COLLECTION, { tasks: [] }); }

/* ── Board change notification (audit §4.3) ──────────────────────────────
 * The board used to poll /api/ops/tasks every 2.5 seconds — the whole board,
 * logs and all, forever, whether or not anything had happened. On a phone that
 * is a request every 2.5s for as long as the tab is open. Every write to the
 * task store goes through updateTasks() below, so subscribers can simply be
 * told instead (index.js turns this into an SSE stream, like the notepad).
 *
 * Coalesced, because the runner writes on every tool event and a board does not
 * need sixty frames a second — it needs to be right within a blink. */
const CHANGE_COALESCE_MS = 400;
const changeSubs = new Set();
let changeTimer = null;
export function onOpsChange(cb) {
  changeSubs.add(cb);
  return () => { changeSubs.delete(cb); };
}
function notifyOpsChange() {
  if (!changeSubs.size || changeTimer) return;
  changeTimer = setTimeout(() => {
    changeTimer = null;
    for (const cb of changeSubs) {
      try { cb(); } catch { /* a broken subscriber must not stop the others */ }
    }
  }, CHANGE_COALESCE_MS);
  changeTimer.unref?.();   // never hold the process open for a board repaint
}
// The ONE writer of the task store. Anything that mutates a task goes through it
// so nothing can change the board without the board hearing about it.
export function updateTasks(fn) {
  update(COLLECTION, fn, { tasks: [] });
  notifyOpsChange();
}
export function patchFile(id) { return path.join(PATCHES_DIR, id + '.patch'); }
export function worktreePath(id) { return path.join(WORKTREES_DIR, id); }

export function mutate(id, fn) {
  let updated = null;
  updateTasks((db) => {
    const t = db.tasks.find((x) => x.id === id);
    if (t) { fn(t); updated = t; }
    return db;
  });
  return updated;
}

export function pushLog(id, entry) {
  mutate(id, (task) => {
    task.log.push({ t: now(), ...entry });
    if (task.log.length > LOG_CAP) task.log = task.log.slice(-LOG_CAP);
  });
}
