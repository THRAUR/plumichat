// Notepad — a per-user synced scratchpad: text "clips" plus small file drops that
// sync across a member's own devices (phone <-> computer). This is pure user
// content, NOT AI output and NOT app secrets, so it lives in the JSON store keyed
// by the caller's user id; dropped files land under DATA_DIR/notepad-files/<user>/
// (both are gitignored via data/). Isolation is the whole point: every read and
// write is scoped to keyOf(user), so one account can never see another's clips.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { read, update, DATA_DIR } from './store.js';

const STORE = 'notepad';                    // shape: { [userKey]: Clip[] }, newest first
const FILES_DIR = path.join(DATA_DIR, 'notepad-files');
const MAX_CLIPS = 200;                       // keep each user's pad bounded
const MAX_TEXT = 100 * 1024;                 // 100 KB per text clip

const newId = () => crypto.randomBytes(8).toString('hex');

// Stable per-account key. Registered accounts carry a real id; the Basic-auth
// owner fallback has none, so it collapses to a single 'owner' pad.
export function keyOf(user) { return String((user && user.id) || 'owner'); }
// Same value, hardened for use as a filesystem path segment (defense in depth —
// ids are app-generated hex, but never trust an id straight into a path).
const dirKey = (user) => keyOf(user).replace(/[^\w-]+/g, '_') || 'owner';

function allClips(user) { return read(STORE, {})[keyOf(user)] || []; }

// The on-disk record carries `storedPath`; clients must never see server paths.
function publicClip(c) { const { storedPath, ...pub } = c; return pub; }

export function listClips(user) { return allClips(user).map(publicClip); }

/* ------------------------------- text clips ------------------------------- */
export function addText(user, text) {
  text = String(text == null ? '' : text);
  if (!text.trim()) throw new Error('note is empty');
  if (text.length > MAX_TEXT) throw new Error('note is too large (max 100 KB)');
  const clip = { id: newId(), kind: 'text', text, createdAt: Date.now(), updatedAt: Date.now() };
  return publicClip(pushClip(user, clip));
}

export function editText(user, id, text) {
  text = String(text == null ? '' : text);
  if (!text.trim()) throw new Error('note is empty');
  if (text.length > MAX_TEXT) throw new Error('note is too large (max 100 KB)');
  const key = keyOf(user);
  let found = null;
  update(STORE, (all) => {
    const list = all[key] || (all[key] = []);
    const c = list.find((x) => x.id === id && x.kind === 'text');
    if (c) { c.text = text; c.updatedAt = Date.now(); found = c; }
    return all;
  }, {});
  if (!found) throw new Error('note not found');
  return publicClip(found);
}

/* ------------------------------- file clips ------------------------------- */
export function addFile(user, name, buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new Error('empty file');
  const id = newId();
  const safe = sanitizeName(name);
  const dir = path.join(FILES_DIR, dirKey(user));
  fs.mkdirSync(dir, { recursive: true });
  const storedPath = path.join(dir, id + '-' + safe);
  fs.writeFileSync(storedPath, buf);
  const clip = { id, kind: 'file', name: safe, size: buf.length, createdAt: Date.now(), updatedAt: Date.now(), storedPath };
  return publicClip(pushClip(user, clip));
}

// Resolve a file clip to something streamable, scoped to the caller. Throws if the
// id isn't a file clip the caller owns — so the download route can't be coaxed
// into serving another account's bytes.
export function fileFor(user, id) {
  const c = allClips(user).find((x) => x.id === id && x.kind === 'file');
  if (!c || !c.storedPath) throw new Error('file not found');
  return { storedPath: c.storedPath, name: c.name };
}

/* --------------------------------- delete --------------------------------- */
export function remove(user, id) {
  const key = keyOf(user);
  let removed = null;
  update(STORE, (all) => {
    const list = all[key] || [];
    all[key] = list.filter((c) => (c.id === id ? ((removed = c), false) : true));
    return all;
  }, {});
  if (!removed) throw new Error('note not found');
  unlinkClip(removed);
  return { ok: true };
}

export function clearAll(user) {
  const key = keyOf(user);
  allClips(user).forEach(unlinkClip);
  update(STORE, (all) => { all[key] = []; return all; }, {});
  return { ok: true };
}

/* ------------------------------- internals -------------------------------- */
function pushClip(user, clip) {
  const key = keyOf(user);
  update(STORE, (all) => {
    const list = all[key] || (all[key] = []);
    list.unshift(clip);                                   // newest first
    if (list.length > MAX_CLIPS) list.splice(MAX_CLIPS).forEach(unlinkClip); // trim oldest
    return all;
  }, {});
  return clip;
}

function unlinkClip(c) {
  if (c && c.kind === 'file' && c.storedPath) {
    try { fs.unlinkSync(c.storedPath); } catch { /* already gone */ }
  }
}

function sanitizeName(name) {
  const base = path.basename(String(name || 'file')).replace(/[^\w.\- ]+/g, '_').trim();
  return base.slice(0, 120) || 'file';
}
