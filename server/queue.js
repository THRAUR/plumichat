/* PlumiChat — the queue of messages waiting for the running turn to end.
   ==========================================================================
   Typing ahead during a turn used to park the message in the browser tab that
   typed it. That made it three things it should never have been: invisible on
   your other devices, lost to a hard refresh, and lost to closing the window by
   accident. A queue you cannot trust to still be there is worse than no queue —
   you stop typing ahead.

   So the queue lives here, in the JSON store, keyed by CONVERSATION. Every
   device sees the same list, a refresh restores it, and the work still goes out
   when the turn ends even if nothing is watching.

   Design notes worth keeping:

   - The key is the SDK sessionId, because that is exactly how runs.js keys a run
     (`key: sessionId || id`). Anything else would mean the drain could not find
     the queue belonging to the turn that just finished.
   - The turn parameters come from the RUNNING RUN, never from the request body.
     This is the same rule server/resume.js follows and for the same reason: a
     body that could name a cwd or a permission mode would be a way to run an
     arbitrary turn later, under someone else's confinement.
   - Attachments are stored as absolute PATHS, resolved and scope-checked before
     they get here. The browser uploads a File at queue time rather than at send
     time — it has to, because a File object cannot be persisted, and because the
     whole point is that the tab may be gone by the time this is sent.
   - `editing` is a HOLD, not a lock, and it expires. A tab that opens the editor
     and is then closed must not wedge the queue forever, so a hold older than
     EDIT_HOLD_MS is ignored (see isHeld).
*/

import crypto from 'node:crypto';
import { read, update } from './store.js';

const COLLECTION = 'queue';

// Per conversation. Enough to type ahead through a long turn; low enough that a
// runaway client cannot fill the disk.
const MAX_PER_KEY = 25;
// A queued message older than this is stale — the conversation has moved on and
// sending it now would be a surprise, not a favour.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// How long an "I am editing this" hold survives without being refreshed. Long
// enough to actually write a message, short enough that a closed tab frees it.
const EDIT_HOLD_MS = 5 * 60 * 1000;

const rows = () => read(COLLECTION, []);
const newId = () => 'q_' + crypto.randomBytes(6).toString('hex');

/* ---------------------------------------------------------- change events -- */
// index.js registers the SSE broadcaster here. Kept as a listener list rather
// than an import so this module never has to know about Express — and so runs.js
// can drain the queue without pulling the HTTP layer in with it.
const listeners = new Set();
export function onQueueChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function changed(userId, key) {
  for (const fn of listeners) {
    try { fn(userId, key); } catch { /* a bad listener must not break a mutation */ }
  }
}

/* ---------------------------------------------------------------- reading -- */

export function isHeld(row) {
  return !!row.editing && (Date.now() - (row.editingAt || 0)) < EDIT_HOLD_MS;
}

function publicRow(row) {
  return {
    id: row.id,
    key: row.key,
    wire: row.wire,
    atts: (row.paths || []).length,
    editing: isHeld(row),
    editingBy: isHeld(row) ? (row.editingBy || null) : null,
    at: row.at,
  };
}

// Everything queued for one conversation, oldest first — the order it will send.
export function listFor(user, key) {
  const uid = String((user && user.id) || 'owner');
  const k = String(key || '');
  return rows()
    .filter((r) => r.userId === uid && r.key === k)
    .sort((a, b) => a.at - b.at)
    .map(publicRow);
}

/* ---------------------------------------------------------------- writing -- */

// `spec` is the running turn's own spec, copied by the caller from run.spec.
export function enqueue(user, key, { wire, prompt, paths, spec }) {
  const uid = String((user && user.id) || 'owner');
  const k = String(key || '').trim();
  if (!k) throw new Error('A conversation is required');
  const text = String(wire == null ? '' : wire);
  const files = Array.isArray(paths) ? paths.map(String) : [];
  if (!text.trim() && !files.length) throw new Error('Nothing to queue');
  if (!spec) throw new Error('No running turn to queue behind');

  let created = null;
  update(COLLECTION, (db) => {
    const mine = db.filter((r) => r.userId === uid && r.key === k);
    if (mine.length >= MAX_PER_KEY) throw new Error(`Queue is full (${MAX_PER_KEY} messages)`);
    created = {
      id: newId(), userId: uid, key: k,
      // `wire` is what the person typed and what they edit; `prompt` is what the
      // engine receives, composed by the HTTP layer exactly as /api/chat composes
      // it (skill picker + attachment preamble). Storing both is what keeps a
      // queued message byte-identical to the same message sent immediately.
      wire: text, prompt: String(prompt == null ? text : prompt), paths: files,
      editing: false, editingAt: 0, editingBy: null,
      spec, at: Date.now(),
    };
    db.push(created);
    return db;
  }, []);
  changed(uid, k);
  return publicRow(created);
}

function mutate(user, id, fn) {
  const uid = String((user && user.id) || 'owner');
  let out = null, key = null;
  update(COLLECTION, (db) => {
    const i = db.findIndex((r) => r.id === id && r.userId === uid);
    if (i < 0) throw new Error('That message is no longer queued');
    key = db[i].key;
    const next = fn(db[i], db, i);
    out = next === null ? null : publicRow(db[i]);
    return db;
  }, []);
  changed(uid, key);
  return out;
}

export function editQueued(user, id, wire, prompt) {
  const text = String(wire == null ? '' : wire).trim();
  return mutate(user, id, (row, db, i) => {
    // Emptied with nothing else to carry is a delete, not a blank message.
    if (!text && !(row.paths || []).length) { db.splice(i, 1); return null; }
    row.wire = text;
    row.prompt = String(prompt == null ? text : prompt);
    row.editing = false; row.editingAt = 0; row.editingBy = null;
    return row;
  });
}

// Open/close the hold. `by` is a free-text device label, shown to the OTHER
// devices so "why is this one not sending?" has a visible answer.
export function setEditing(user, id, on, by) {
  return mutate(user, id, (row) => {
    row.editing = !!on;
    row.editingAt = on ? Date.now() : 0;
    row.editingBy = on ? (by ? String(by).slice(0, 40) : null) : null;
    return row;
  });
}

export function removeQueued(user, id) {
  const uid = String((user && user.id) || 'owner');
  let removed = null, key = null;
  update(COLLECTION, (db) => {
    const i = db.findIndex((r) => r.id === id && r.userId === uid);
    if (i < 0) return db;
    key = db[i].key;
    removed = db.splice(i, 1)[0];
    return db;
  }, []);
  if (removed) changed(uid, key);
  return removed ? { id: removed.id, wire: removed.wire, paths: removed.paths || [] } : null;
}

/* --------------------------------------------------------------- draining -- */

// Take the oldest READY message for a conversation and hand it back, removed.
// "Ready" means not currently held open in somebody's editor: sending a
// half-written message would be worse than not sending. The ones BEHIND a held
// message are finished, so the queue keeps moving and the held one keeps its
// place — that is the whole point of skipping rather than stopping.
//
// Atomic by construction: a single update() picks and removes in one pass, so two
// devices racing to drain the same conversation cannot both win the same message.
export function claimNext(key) {
  const k = String(key || '');
  let claimed = null, uid = null;
  update(COLLECTION, (db) => {
    const mine = db.filter((r) => r.key === k).sort((a, b) => a.at - b.at);
    const row = mine.find((r) => !isHeld(r));
    if (!row) return db;
    const i = db.findIndex((r) => r.id === row.id);
    claimed = db.splice(i, 1)[0];
    uid = claimed.userId;
    return db;
  }, []);
  if (claimed) changed(uid, k);
  return claimed;
}

// Put a claimed row back. Used when startRun refuses (a cap, the spend gate):
// the row was removed atomically so nothing else holds it, and dropping it would
// silently lose work the person is expecting to happen. Its original `at` is kept,
// which is what puts it back at the FRONT — everything queued after it is newer.
export function requeueFront(row) {
  if (!row || !row.id) return null;
  update(COLLECTION, (db) => {
    if (!db.some((r) => r.id === row.id)) db.push({ ...row, editing: false, editingAt: 0, editingBy: null });
    return db;
  }, []);
  changed(row.userId, row.key);
  return row;
}

// Is anything still waiting for this conversation (held or not)?
export function pendingFor(key) {
  const k = String(key || '');
  return rows().filter((r) => r.key === k).length;
}

/* ------------------------------------------------------------- housekeeping */

// Drop rows nothing will ever send. Runs at boot rather than on a timer: the only
// thing that makes a row stale is the passage of time, so checking once per start
// is enough and costs nothing.
export function sweepQueue() {
  const now = Date.now();
  let dropped = 0;
  update(COLLECTION, (db) => {
    const keep = db.filter((r) => now - (r.at || 0) <= MAX_AGE_MS);
    dropped = db.length - keep.length;
    return keep;
  }, []);
  if (dropped) console.log(`[queue] dropped ${dropped} stale message(s)`);
  return dropped;
}
