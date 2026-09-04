// Tiny atomic JSON store. One file per collection under DATA_DIR, written via
// temp-file + rename so a crash mid-write never corrupts the live file. The
// server is single-process and single-threaded, so an in-memory read-through
// cache is safe and keeps reads cheap. Files are plain JSON you can hand-edit
// (stop the server first, or your edit may be overwritten by a cached write).
//
// This is deliberately dependency-free. When we build the live-data analytics
// phase, this is the seam to swap for SQLite — keep the read/write/update API.
//
// WHICH READER: read() hands back the LIVE cached object, which is what the
// classic read-mutate-write()/update() flow wants and what most call sites rely
// on. Use readCopy() instead whenever you build a candidate value that might be
// thrown away — validate-then-save, or anything that can throw halfway through —
// because a mutation on read()'s result is already visible to every later read
// even if you never persist it, and that dirty cache outlives the failed request.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = path.resolve(
  process.env.DATA_DIR || path.join(__dirname, '..', 'data')
);
fs.mkdirSync(DATA_DIR, { recursive: true });

const cache = new Map();
const fileFor = (name) => path.join(DATA_DIR, name + '.json');

// Read a collection, falling back to (and caching) `fallback` when absent.
export function read(name, fallback) {
  if (cache.has(name)) return cache.get(name);
  let val = fallback;
  try {
    val = JSON.parse(fs.readFileSync(fileFor(name), 'utf8'));
  } catch { /* missing or unreadable → use fallback */ }
  cache.set(name, val);
  return val;
}

// Read a collection as a detached deep COPY, so mutating it cannot touch the
// cache. Costs one structuredClone; use it when a caller may mutate and then
// bail out (operations.editTask is the case that motivated this).
export function readCopy(name, fallback) {
  return structuredClone(read(name, fallback));
}

// Persist a collection atomically and refresh the cache. The disk write happens
// FIRST: if it throws, the cache must NOT be updated, or in-memory would diverge
// from disk and every later read would return data that was never persisted.
export function write(name, data) {
  const target = fileFor(name);
  const tmp = target + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, target);
  cache.set(name, data);
  return data;
}

// Read-modify-write helper. `fn` may mutate-and-return or return a fresh value;
// returning undefined keeps (and persists) the mutated current value.
export function update(name, fn, fallback) {
  const cur = read(name, fallback);
  const next = fn(cur);
  return write(name, next === undefined ? cur : next);
}
