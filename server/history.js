// Server-side conversation history, sourced from the Claude Agent SDK's own
// session logs at ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl.
// This is the real, cross-device history — replaces the old localStorage store.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { resolveInRoot, resolveInUserRoot } from './sandbox.js';
import { read, update } from './store.js';
import { getAutoTitle, clearAutoTitle, sdkTitles } from './titles.js';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// User-set conversation titles, keyed by session id. These override the title
// auto-derived from the first user message. Session ids are globally unique
// (UUIDs), so a flat id -> title map is enough — no project key needed.
const TITLES = 'session-titles';
// Per-conversation UI flags (pinned / archived), keyed by session id — same flat
// id->value shape as titles (ids are globally-unique UUIDs).
const FLAGS = 'session-flags';
const validId = (id) => /^[A-Za-z0-9._-]+$/.test(id);

// Rename a conversation. An empty/blank title clears the override, reverting to
// the auto-derived title. Returns the stored (trimmed) title. Scoped to the
// caller's home: the session file must resolve inside THEIR project dir, so a
// member can't rename another account's conversation by guessing its id (titles
// share one global id->title map, which is exactly why the scope check matters).
export function setSessionTitle(projectName, sessionId, title, user) {
  if (!validId(sessionId)) throw new Error('invalid session id');
  const file = path.join(sessionDir(projectName, user), sessionId + '.jsonl');
  if (!fs.existsSync(file)) throw new Error('conversation not found');
  const t = String(title == null ? '' : title).trim().slice(0, 200);
  update(TITLES, (map) => {
    if (t) map[sessionId] = t;
    else delete map[sessionId];
    return map;
  }, {});
  return { id: sessionId, title: t };
}

// Set a conversation's UI flags (pinned / archived). Only the keys present in
// `flags` are changed. Scoped to the caller's home exactly like setSessionTitle:
// the session log must resolve inside THEIR project dir. A flag pair that reduces
// to all-false is dropped from the map so it doesn't accumulate dead entries.
export function setSessionFlags(projectName, sessionId, flags, user) {
  if (!validId(sessionId)) throw new Error('invalid session id');
  const file = path.join(sessionDir(projectName, user), sessionId + '.jsonl');
  if (!fs.existsSync(file)) throw new Error('conversation not found');
  let out = { pinned: false, archived: false };
  update(FLAGS, (map) => {
    const cur = map[sessionId] || {};
    const next = {
      pinned: flags && 'pinned' in flags ? !!flags.pinned : !!cur.pinned,
      archived: flags && 'archived' in flags ? !!flags.archived : !!cur.archived,
    };
    if (next.pinned || next.archived) map[sessionId] = next;
    else delete map[sessionId];
    out = next;
    return map;
  }, {});
  return { id: sessionId, pinned: out.pinned, archived: out.archived };
}

// Permanently delete a conversation: removes the SDK session log file and any
// stored title override. Scoped to the caller's home via sessionDir(), so a
// member can only ever delete their own conversations (a foreign id simply
// resolves to a path inside their own dir and isn't found). Idempotent — a
// missing file is treated as success.
export function deleteSession(projectName, sessionId, user) {
  if (!validId(sessionId)) throw new Error('invalid session id');
  const file = path.join(sessionDir(projectName, user), sessionId + '.jsonl');
  // Only clear the (globally-keyed) title state if the log actually existed in
  // THIS caller's dir. Otherwise a member could wipe another account's title/
  // auto-title by passing a foreign id: rmSync{force} is a silent no-op on a
  // path that isn't theirs, but the title deletes below would still land.
  let existed;
  try {
    existed = fs.existsSync(file);
    fs.rmSync(file, { force: true });
  } catch (err) { throw new Error('could not delete conversation: ' + err.message); }
  if (existed) {
    update(TITLES, (map) => { delete map[sessionId]; return map; }, {});
    update(FLAGS, (map) => { delete map[sessionId]; return map; }, {});
    clearAutoTitle(sessionId); // drop the AI title too, so a reused id can't inherit it
  }
  return { id: sessionId, deleted: existed };
}

// Claude Code encodes a project's cwd into a dir name by replacing every
// non-alphanumeric character with '-' (verified against existing dirs).
function encodeCwd(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

// Resolve & validate the project against the user's home, so a member only ever
// sees their own conversations. This is the scope check every read below leans on.
function projectCwd(projectName, user) {
  return user ? resolveInUserRoot(user, projectName) : resolveInRoot(projectName);
}

// …and the SDK session directory that cwd maps to.
function sessionDir(projectName, user) {
  return path.join(PROJECTS_DIR, encodeCwd(projectCwd(projectName, user)));
}

// The same resolve-and-prove-it-exists check every read above does, exported for
// the out-of-band session controls in context.js. Those hand `cwd` to the SDK, and
// the SDK will happily resume ANY session id it can find — so the ownership check
// has to happen here, on the caller's own home, before the id reaches it.
export function sessionPaths(projectName, sessionId, user) {
  if (!validId(sessionId)) throw new Error('invalid session id');
  const dir = sessionDir(projectName, user);
  const file = path.join(dir, sessionId + '.jsonl');
  if (!fs.existsSync(file)) throw new Error('conversation not found');
  return { cwd: projectCwd(projectName, user), dir, file };
}

function textOf(message) {
  const c = message && message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
  return '';
}

function shortTarget(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input.slice(0, 80);
  if (input.file_path) return String(input.file_path).split('/').slice(-2).join('/');
  if (input.path) return String(input.path);
  if (input.notebook_path) return String(input.notebook_path).split('/').slice(-2).join('/');
  if (input.command) return String(input.command).slice(0, 60);
  if (input.pattern) return String(input.pattern).slice(0, 60);
  if (input.url) return String(input.url).slice(0, 60);
  if (input.query) return String(input.query).slice(0, 60);
  // AskUserQuestion: show the question being asked, not the raw JSON blob.
  if (Array.isArray(input.questions) && input.questions[0]) {
    return String(input.questions[0].question || input.questions[0].header || 'question').slice(0, 80);
  }
  if (input.description) return String(input.description).slice(0, 60);
  return ''; // unknown shape — show just the tool name, never raw JSON
}

// Cheap title: read only the head of the file and grab the first user text.
// Async (fs.promises) so the drawer-list request never blocks the event loop —
// listSessions may touch many files, and this runs only for sessions with no
// stored/AI title (the common case is short-circuited before we ever open a file).
async function titleFromHead(file) {
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
    const buf = Buffer.alloc(32 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const head = buf.toString('utf8', 0, bytesRead);
    for (const line of head.split('\n')) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; } // last line may be truncated
      if (o.type === 'user' && o.message && !o.isCompactSummary && !o.isMeta) {
        const t = textOf(o.message).trim();
        if (t) return t.slice(0, 60);
      }
    }
  } catch {
    /* ignore */
  } finally {
    if (fh) await fh.close();
  }
  return '';
}

// List a project's sessions (newest first): { id, title, updatedAt, pinned,
// archived }. Async: all disk work goes through fs.promises so a large history
// can't stall the server.
//
// The set of sessions still comes from the directory listing, NOT from the SDK —
// that listing is what every scope check here is built on, and swapping it for a
// cross-project API would quietly widen what a member can see. The SDK is used
// only to supply titles the CLI already knows (one call for the whole directory).
export async function listSessions(projectName, user) {
  const cwd = projectCwd(projectName, user);
  const dir = path.join(PROJECTS_DIR, encodeCwd(cwd));
  let files;
  try { files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.jsonl')); }
  catch { return []; } // no sessions yet
  const overrides = read(TITLES, {});
  const flags = read(FLAGS, {});
  const sdk = await sdkTitles(cwd); // empty map when the SDK can't answer
  const out = [];
  for (const f of files) {
    const full = path.join(dir, f);
    let stat;
    try { stat = await fs.promises.stat(full); } catch { continue; }
    const id = f.replace(/\.jsonl$/, '');
    // Precedence: user-set name > the SDK's own title > our AI summary >
    // first-message truncation (titles.js documents the tiers).
    const title = overrides[id] || sdk.get(id) || getAutoTitle(id) || await titleFromHead(full);
    if (!title) continue; // skip empty / contentless sessions
    const fl = flags[id] || {};
    out.push({ id, title, updatedAt: stat.mtimeMs, pinned: !!fl.pinned, archived: !!fl.archived });
  }
  // Newest first, but pinned conversations always float to the top.
  out.sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
  return out;
}

// The log line's wall-clock time as epoch ms, or null. Entries carry an ISO
// string; anything else (or a missing field) is simply not shown by the UI.
function atOf(o) {
  const raw = o && o.timestamp;
  if (!raw) return null;
  const ms = typeof raw === 'number' ? raw : Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

// Token usage for one assistant message, in the SAME shape the live 'result'
// event uses so the client can render replayed and live turns with one code path.
function usageOf(message) {
  const u = message && message.usage;
  if (!u || typeof u !== 'object') return null;
  return {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
  };
}

// Full message list for one session, normalized for the UI replay.
//
// Async: the log for a long conversation is megabytes, and reading it with
// readFileSync blocked the single event loop for every other request on the box.
//
// Entries are ADDITIVE over the previous shape — { role, text?, name?, target?,
// model? } all still mean exactly what they did, plus:
//   at      — epoch ms for the line, when it carries a timestamp
//   usage   — { input, output, cacheRead, cacheWrite } on assistant messages
//   costUsd — only when the log actually recorded one (it usually doesn't)
// and a new role, 'thinking', for extended-thinking blocks. Unknown shapes are
// skipped, never thrown on: one malformed line must not lose a whole history.
export async function getSession(projectName, sessionId, user) {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) throw new Error('invalid session id');
  const file = path.join(sessionDir(projectName, user), sessionId + '.jsonl');
  const content = await fs.promises.readFile(file, 'utf8');
  const messages = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const at = atOf(o);
    if (o.type === 'user' && o.message) {
      // Compaction summary is stored as a user entry — render a notice, not a
      // user bubble (it isn't something the human typed).
      if (o.isCompactSummary) { messages.push({ role: 'notice', text: 'Context compacted', at }); continue; }
      if (o.isMeta) continue; // system-injected context, not a real user turn
      const t = textOf(o.message).trim();
      if (t) messages.push({ role: 'user', text: t, at });
    } else if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
      const usage = usageOf(o.message);
      // Cost is per-TURN, not per-block: hang it (and the usage) on the first
      // block only, so a multi-block reply badges once instead of once per part.
      let first = true;
      for (const b of o.message.content) {
        if (b.type === 'text' && b.text && b.text.trim()) {
          // o.message.model = the id the Anthropic API stamped on this very
          // response (stored verbatim in the SDK log) — per-message provenance.
          const m = { role: 'assistant', text: b.text, model: o.message.model || '', at };
          if (first) {
            if (usage) m.usage = usage;
            const cost = o.costUSD != null ? o.costUSD : o.total_cost_usd;
            if (typeof cost === 'number') m.costUsd = cost;
            first = false;
          }
          messages.push(m);
        } else if (b.type === 'thinking' && b.thinking && String(b.thinking).trim()) {
          // Redacted thinking carries a signature but no text — nothing to show.
          messages.push({ role: 'thinking', text: String(b.thinking), at });
        } else if (b.type === 'tool_use') {
          messages.push({ role: 'tool', name: b.name, target: shortTarget(b.input), at });
        }
      }
    }
  }
  return messages;
}
