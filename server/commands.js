// The slash-command palette's real source (audit F2).
//
// public/js/panels/skills.js has been asking for GET /api/commands since the
// palette shipped, and shrugging at the 404 — a deliberate placeholder for "a
// later server that publishes one". This is that server. Until now the palette
// showed 19 commands typed out by hand in commands.js; the CLI actually offers
// about 65 on this install, including deep-research, security-review, verify,
// debug, loop, schedule, agents and recap.
//
// Read through the same control-only query as the context ring and MCP status: a
// prompt that never yields, so the CLI boots, answers, and no turn ever runs.
import { withSessionControl } from './context.js';
import { cliCommands } from './cli-commands.js';

// One CLI spawn per cwd per ten minutes. This route is hit on EVERY page load by
// every client, and the command list changes about as often as the engine is
// updated — so anything less than a cache here would be a process per page view.
const TTL_MS = 10 * 60 * 1000;
const cache = new Map();
const CACHE_CAP = 20;

// Only the CLI's internal plumbing is hidden — anything `__`-prefixed, which it
// never means to show a human.
//
// This used to also drop doctor, color, clear, heapdump, config and import as
// "terminal-only". That was a guess about what a web client can use, and guessing
// on the user's behalf is how the palette ended up feeling smaller than the
// terminal. The ask was explicit: everything the terminal offers should be here.
// A command that turns out to do nothing useful through the SDK is at least
// VISIBLY doing nothing, which is information; one that was filtered out looks
// like a missing feature.
const TERMINAL_ONLY = new Set();

// The CLI appends a scope marker to a skill's description — "… (user)", "(project)",
// "(plugin)". It is the only thing distinguishing a skill from a built-in command in
// this payload, so read it, then strip it: it is provenance, not description.
const SCOPE_RE = /\s*\((user|project|plugin|built-in|builtin|local)\)\s*$/i;

// A palette row is one line on a phone. Skill descriptions are frontmatter
// paragraphs — the docx one is 600 characters of trigger guidance — so take the
// first sentence and cap it. The full text is never the thing you are reading when
// you are looking for a command by name.
const MAX_DESC = 120;
// …and the same for the argument hint. Most are "<question>"; a few are a whole
// usage line (auto-mode-setup ships 90 characters of flags), which on a 390px
// screen would push the description off the row it belongs to.
const MAX_ARGS = 34;
function trimDesc(raw) {
  let d = String(raw || '').replace(SCOPE_RE, '').trim();
  const stop = d.search(/\.\s|\.$/);
  if (stop > 30) d = d.slice(0, stop + 1);
  if (d.length > MAX_DESC) d = d.slice(0, MAX_DESC - 1).replace(/\s+\S*$/, '') + '…';
  return d;
}

function clip(s, max) {
  return s.length > max ? s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : s;
}

function shape(list) {
  const out = [];
  for (const c of Array.isArray(list) ? list : []) {
    const id = String((c && c.name) || '').trim();
    if (!id || id.startsWith('__') || TERMINAL_ONLY.has(id)) continue;
    const scope = SCOPE_RE.exec(String((c && c.description) || ''));
    out.push({
      id,
      // The palette shows the id as the heading anyway; a prettier name is a
      // nicety, not a fact, so derive it rather than inventing one.
      name: id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase()),
      description: trimDesc(c && c.description),
      args: clip(String((c && c.argumentHint) || ''), MAX_ARGS),
      // 'skill' groups the things that make something, which is how the palette
      // already colours its rows. Anything the CLI ships built-in is 'builtin'.
      group: scope && /user|project|plugin/i.test(scope[1]) ? 'skill' : 'builtin',
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// `cwd` is resolved by the caller against the CALLER's own root, so a member gets
// their own project-local commands and never someone else's.
//
// TWO SOURCES, and the difference between them is the point:
//   - supportedCommands() is what an SDK session can actually RUN. Authoritative
//     for the chat rows, and it includes this project's skills.
//   - the CLI binary's own registry (cli-commands.js) is the full terminal list.
//     Roughly 25 of those the SDK refuses — "/btw isn't available in this
//     environment" — because they need a terminal in front of them.
// Serving only the first made the palette look smaller than the terminal it
// mirrors. Serving the union, with each row saying WHERE it runs, is the honest
// version: `where: 'chat'` goes to the composer, `where: 'terminal'` opens the
// Terminal with the command typed out.
export async function listCommands(cwd) {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.commands;
  const raw = await withSessionControl(cwd, null, (q) => q.supportedCommands());
  const chat = shape(raw).map((c) => ({ ...c, where: 'chat' }));
  const known = new Set(chat.map((c) => c.id));
  const terminal = cliCommands()
    .filter((c) => !known.has(c.name))
    .map((c) => ({
      id: c.name,
      name: c.name.replace(/[-_]+/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase()),
      description: trimDesc(c.description),
      args: clip(String(c.args || ''), MAX_ARGS),
      group: 'terminal',
      where: 'terminal',
    }));
  const commands = chat.concat(terminal).sort((a, b) => a.id.localeCompare(b.id));
  cache.delete(cwd);
  cache.set(cwd, { commands, at: Date.now() });
  while (cache.size > CACHE_CAP) cache.delete(cache.keys().next().value);
  return commands;
}
