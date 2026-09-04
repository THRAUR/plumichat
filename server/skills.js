// Live skill list, discovered from disk the way models.js discovers models from
// the API: scan ~/.claude/skills/<id>/SKILL.md, read each skill's `name` and
// `description` frontmatter, and hand the whole set to the Agent SDK. Drop a new
// skill folder in and it appears automatically — in the SDK (so the agent can use
// it) and in the composer's "/" picker (so the human can pick it) — with no code
// edit. This is the single source of truth both claude.js (SDK `skills` option)
// and index.js (/api/skills, the "/" menu) read from.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');

// If the scan can't run (dir missing, unreadable) we still guarantee the four
// Anthropic document skills — the toolchain for them is always installed here.
const FALLBACK_IDS = ['pptx', 'docx', 'xlsx', 'pdf'];

// The scan is a handful of tiny local reads, but it runs once per turn (SDK ids)
// and on every page load (/api/skills), so cache it briefly. Short TTL so a newly
// added skill shows up within a few seconds, not half an hour.
const TTL_MS = 15 * 1000;
let cache = { at: 0, list: null };

// Pull `name:` / `description:` out of a SKILL.md YAML frontmatter block. Values
// may be bare or wrapped in single/double quotes (the doc skills quote their long
// descriptions and escape inner quotes) — handle both without a YAML dependency.
function parseFrontmatter(md) {
  const m = md.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const body = m[1];
  const grab = (key) => {
    const r = body.match(new RegExp('^' + key + ':[ \\t]*(.+)$', 'm'));
    if (!r) return '';
    let v = r[1].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return v.replace(/\\"/g, '"').trim();
  };
  return { name: grab('name'), description: grab('description') };
}

// Read every skill folder into { id, name, description }. `id` is the folder name
// — the identifier the SDK's `skills` option and the "/command" both key on.
function scan() {
  let entries;
  try { entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }); }
  catch { return null; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const id = e.name;
    let md;
    try { md = fs.readFileSync(path.join(SKILLS_DIR, id, 'SKILL.md'), 'utf8'); }
    catch { continue; } // a dir without a SKILL.md isn't a skill
    const fm = parseFrontmatter(md);
    out.push({ id, name: fm.name || id, description: fm.description || '' });
  }
  // The four document skills lead, in their familiar order; anything else the
  // owner has installed follows, alphabetically by display name.
  const lead = FALLBACK_IDS;
  out.sort((a, b) => {
    const ia = lead.indexOf(a.id), ib = lead.indexOf(b.id);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return String(a.name).localeCompare(String(b.name));
  });
  return out;
}

// Full metadata for the UI (the "what PlumiChat can make" sheet and the "/" picker).
export function listSkills() {
  if (cache.list && Date.now() - cache.at < TTL_MS) return cache.list;
  const list = scan();
  if (list && list.length) { cache = { at: Date.now(), list }; return list; }
  if (cache.list) return cache.list; // keep the last good scan on a transient failure
  return FALLBACK_IDS.map((id) => ({ id, name: id, description: '' }));
}

// Just the ids, for the SDK's `skills` option (claude.js). Never empty.
export function skillIds() {
  const ids = listSkills().map((s) => s.id);
  return ids.length ? ids : FALLBACK_IDS.slice();
}

// Terminal-style skill invocation. If a message begins with "/<skill-id>" and the
// id is a real installed skill, return { id, rest }; index.js turns that into a
// plain "Use the … skill" instruction for the model. Anything else → null (the
// message is ordinary text and passes through untouched).
export function matchSkillCommand(raw) {
  const m = String(raw || '').match(/^\s*\/([a-zA-Z0-9][\w-]*)(?:[ \t]+([\s\S]*))?$/);
  if (!m) return null;
  const id = m[1].toLowerCase();
  if (!skillIds().includes(id)) return null;
  return { id, rest: (m[2] || '').trim() };
}
