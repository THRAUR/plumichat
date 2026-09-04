// Every slash command the native CLI has — including the ones the chat engine
// cannot run.
//
// WHY THIS EXISTS. `supportedCommands()` (see commands.js) is authoritative for
// what an SDK session can execute, and it is the right source for the palette's
// runnable rows. But it is NOT the whole list: the interactive REPL registers a
// further ~25 commands that only make sense with a terminal in front of them —
// /btw, /bug, /branch, /cd, /chrome, /background, /add-dir, /artifacts, /resume,
// /theme, /login … Ask the SDK to run one and it answers "/btw isn't available in
// this environment", which is a different thing from "Unknown command": the CLI
// knows it, this engine just cannot host it.
//
// Hiding those made PlumiChat's palette look smaller than the terminal it mirrors.
// PlumiChat *has* a terminal, and (since the key bar) a usable one on a phone — so
// the honest answer is to list them, mark them as terminal-only, and open the
// terminal with the command ready to run.
//
// The list is read out of the CLI binary rather than typed here, so it tracks the
// engine instead of going stale. The records look like
//   {type:"local-jsx",name:"btw",description:"Ask a quick side question…",…}
// with `aliases` sometimes floating between the fields, which is why the scan
// pairs a name with the FIRST description before the next `name:` rather than
// anything within a fixed window — a window silently attributes a neighbour's
// description to the wrong command (it gave /btw the text for /autofix-pr).
import fs from 'node:fs';
import path from 'node:path';
import { claudeBin } from './engine.js';
import { read, write } from './store.js';

const COLLECTION = 'cli-commands';

// Telling a command record apart from the config-schema records that share its
// {name, description} shape. Most commands carry type:"local" | "local-jsx" |
// "prompt", but not all — /chrome has no `type` at all, only
// {name, description, availability, isEnabled, policyGate}. So: reject anything
// whose type is one of the SCHEMA types, and otherwise accept a record that
// carries at least one marker only a command has.
const COMMAND_TYPES = new Set(['local', 'local-jsx', 'prompt']);
const SCHEMA_TYPES = new Set(['text', 'number', 'object', 'boolean', 'string', 'array', 'enum']);
const COMMAND_MARKER = /\b(isEnabled|argumentHint|aliases|immediate|availability|policyGate|userFacingName|progressMessage)\b/;

const NAME = /name:"([a-z0-9:_-]{2,40})"/g;
const CHUNK = 8 << 20;
const OVERLAP = 8192;   // so a record straddling a chunk boundary is still seen

function scan(file) {
  const out = new Map();
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let tail = '';
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, null);
      if (!n) break;
      // latin1: we only match ASCII field names, and it never throws on the
      // binary's non-text regions the way utf-8 decoding would mangle them.
      const data = tail + buf.toString('latin1', 0, n);
      NAME.lastIndex = 0;
      let m;
      while ((m = NAME.exec(data))) {
        const name = m[1];
        let fwd = data.slice(m.index + m[0].length, m.index + m[0].length + 260);
        const nextRecord = fwd.indexOf('name:"');
        if (nextRecord !== -1) fwd = fwd.slice(0, nextRecord);
        // `description:"…"` normally, but a few are computed —
        // /passes is `get description(){ if(…) return "…" }`.
        const d = /description(?::|\(\)\s*\{[^"]{0,160}?return\s*)"([^"]{3,300})"/.exec(fwd);
        if (!d) continue;
        let back = data.slice(Math.max(0, m.index - 160), m.index);
        const prev = back.lastIndexOf('name:"');
        if (prev !== -1) back = back.slice(prev);
        const t = /type:"([a-z-]{3,20})"/.exec(back);
        if (t && SCHEMA_TYPES.has(t[1])) continue;               // a config field
        const isCommand = (t && COMMAND_TYPES.has(t[1]))
          || COMMAND_MARKER.test(back) || COMMAND_MARKER.test(fwd);
        if (!isCommand) continue;
        const a = /argumentHint:"([^"]{0,80})"/.exec(fwd);
        const rec = { name, description: decode(d[1]), args: a ? decode(a[1]) : '' };
        // Longest description wins: the same command can appear more than once in
        // the bundle, and the fullest record is the real one.
        const had = out.get(name);
        if (!had || rec.description.length > had.description.length) out.set(name, rec);
      }
      tail = data.slice(-OVERLAP);
    }
  } finally { fs.closeSync(fd); }
  return [...out.values()].filter((c) => !c.name.startsWith('__'));
}

// The bundle is JS source, so a description can carry \n, \" and \uXXXX escapes.
function decode(s) {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, ' ').replace(/\\t/g, ' ').replace(/\\(.)/g, '$1')
    .replace(/\s+/g, ' ').trim();
}

// Scanning 200 MB takes a moment, so the result is cached against the binary's
// size+mtime: a CLI update changes both, and the next call rescans on its own.
export function cliCommands() {
  let file, stat;
  try {
    file = claudeBin();
    if (!path.isAbsolute(file)) return [];   // bare 'claude' — nothing to read
    stat = fs.statSync(file);
  } catch { return []; }
  const key = `${stat.size}:${Math.round(stat.mtimeMs)}`;
  const cached = read(COLLECTION, null);
  if (cached && cached.key === key && Array.isArray(cached.commands)) return cached.commands;
  let commands = [];
  try { commands = scan(file); } catch { return cached && cached.commands ? cached.commands : []; }
  // A scan that finds almost nothing means the bundle's shape changed. Keep the
  // last good list rather than publishing an empty one.
  if (commands.length < 20 && cached && cached.commands && cached.commands.length) {
    return cached.commands;
  }
  write(COLLECTION, { key, at: Date.now(), commands });
  return commands;
}
