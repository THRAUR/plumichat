// Live model list, in three grades of authority:
//
//   1. The CLI's OWN curated picker (Query.supportedModels()) — the same rows the
//      terminal offers, with exact effort levels, fast-mode support, resolved wire
//      ids and the '[1m]' 1M-context twins. This is what the UI *should* offer, so
//      it wins outright when we can get it.
//   2. The Anthropic /v1/models endpoint, authenticated with the same Claude
//      subscription (OAuth) token the Agent SDK uses — every model the account can
//      technically call, curated by nobody.
//   3. A tiny static list, so the picker is never empty offline.
//
// We never copy or log the token; we read it from ~/.claude/.credentials.json at
// call time (Claude Code keeps it refreshed) and use it only for this request.
import fs from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { scrubbedEnv } from './claude.js';

// Used only if neither live source can be reached (token missing/expired,
// offline). It mirrors the curated picker's current lineup, so running blind
// still offers what the terminal would. `ctx1m` used to mark the '[1m]' twins the
// picker offered for Opus 5 and Fable 5.1; it offers none for this lineup — each of
// these has a 1M window with no suffix — so the static list asks for none either.
const STATIC_FALLBACK = [
  { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' },
  { id: 'claude-fable-5-1', display_name: 'Claude Fable 5.1' },
  { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5' },
];

const TTL_MS = 30 * 60 * 1000; // the list changes rarely; refresh at most twice an hour
const FAIL_TTL_MS = 2 * 60 * 1000; // …but retry a FAILED probe sooner than that
let cache = { at: 0, models: null, live: false };

export function oauthToken() {
  try {
    const p = path.join(process.env.HOME || '', '.claude', '.credentials.json');
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    const o = c.claudeAiOauth || c;
    return o.accessToken || o.access_token || null;
  } catch { return null; }
}

// Shorten a display name for the compact picker label ("Claude Opus 4.8" -> "Opus 4.8").
function shortName(name, id) {
  let s = String(name || id || '').replace(/^Claude\s+/i, '').trim();
  // Drop a trailing date stamp if the display name carries one.
  s = s.replace(/\s+\d{8}$/, '').trim();
  return s || id;
}

// Canonical effort ordering (faster → smarter). We report each model's supported
// subset so the picker never offers a level the model would reject.
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];

// Read the supported effort levels straight from the API capabilities:
//   null  — no capability data at all (the offline STATIC_FALLBACK) → "unknown",
//           the UI falls back to a safe default set.
//   []    — capability data present and effort is unsupported (e.g. Haiku) → the
//           UI hides the effort control entirely.
//   [..]  — the exact levels this model accepts (e.g. low..xhigh..max).
function effortsOf(caps) {
  if (!caps || !caps.effort) return null;
  if (!caps.effort.supported) return [];
  return EFFORT_ORDER.filter((k) => caps.effort[k] && caps.effort[k].supported);
}

// Which family a model id belongs to, and the order families are offered in when
// nothing better says so — the curated picker's own order of its alias rows. A
// family nobody has named here yet is its own family ('claude-sonata-1' →
// 'sonata'), never one shared "other" bucket: Fable arrived exactly like that, and
// two new families sharing one would make the second look like an older version
// of the first.
const KNOWN_FAMILIES = ['opus', 'fable', 'sonnet', 'haiku'];
function familyOf(id) {
  const s = String(id || '').toLowerCase();
  const known = KNOWN_FAMILIES.find((f) => s.includes(f));
  if (known) return known;
  const m = /^claude-([a-z]+)/.exec(s);
  return m ? m[1] : s;
}
const FAMILY_ORDER = KNOWN_FAMILIES;
// What each family is for, in the curated picker's own words. Grades 2 and 3 carry
// no descriptions at all, and a menu that has one under every row but these would
// look broken rather than offline.
const FAMILY_DESC = {
  opus: 'For complex work and everyday tasks',
  fable: 'For your toughest challenges',
  sonnet: 'Most efficient for simpler tasks',
  haiku: 'Fastest for quick answers',
};

// Every list leaves here in the shape the picker draws: the LATEST lineup first
// (one current model per family, in the order given), then every older version,
// kept together by family in the lineup's order and newest-first within one.
// `latest` is what the menu splits on — the lineup is always on show, the older
// versions fold under one row.
function lineupFirst(models) {
  const fams = [];
  const add = (f) => { if (!fams.includes(f)) fams.push(f); };
  for (const m of models) if (m.latest) add(familyOf(m.id));
  for (const f of FAMILY_ORDER) add(f);
  for (const m of models) add(familyOf(m.id));
  const older = models
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => !m.latest)
    .sort((a, b) => (fams.indexOf(familyOf(a.m.id)) - fams.indexOf(familyOf(b.m.id))) || (a.i - b.i))
    .map(({ m }) => m);
  return [...models.filter((m) => m.latest), ...older];
}

// Family ordering + capability hints for the UI. We read the model's real effort
// levels from the API capabilities instead of guessing from the id, so a new model
// lights up exactly the effort controls it supports (and none if it has none).
function decorate(list) {
  // A family not in FAMILY_ORDER goes after the ones that are, not before them.
  const rank = (id) => { const i = FAMILY_ORDER.indexOf(familyOf(id)); return i < 0 ? FAMILY_ORDER.length : i; };
  const seen = new Set();
  return lineupFirst(list
    .map((m) => ({
      id: m.id,
      name: m.display_name || m.id,
      short: shortName(m.display_name, m.id),
      desc: FAMILY_DESC[familyOf(m.id)] || '',
      fast: /opus/i.test(m.id),
      efforts: effortsOf(m.capabilities),
      // /v1/models says nothing about 1M twins; only the curated picker knows.
      ctx1m: !!m.ctx1m,
    }))
    // Keep the API's newest-first order within each family, families in FAMILY_ORDER.
    .map((m, i) => ({ ...m, _i: i }))
    .sort((a, b) => (rank(a.id) - rank(b.id)) || (a._i - b._i))
    .map(({ _i, ...m }) => m)
    // Nobody curated this list, so the newest of each family stands in for the
    // lineup the CLI's picker would have named.
    .map((m) => {
      const latest = !seen.has(familyOf(m.id));
      seen.add(familyOf(m.id));
      return { ...m, latest };
    }));
}

// --- Grade 1: the CLI's own curated model picker --------------------------
// `Query.supportedModels()` is answered from the CLI's initialize response, so it
// resolves in ~1.5s without the model ever being asked anything.
//
// The prompt is an async generator that NEVER YIELDS, which is the whole trick: the
// SDK stays in streaming-input mode with the child up and answering control
// requests, and no turn can ever begin. This used to pass the string 'model list'
// and race the abort against the turn it had just started — a race the probe won
// most of the time, but "most of the time" times a 30-minute refresh is a haiku
// turn nobody asked for, several times a day. A generator that yields nothing
// cannot lose that race because there is no race. (Same mechanism as
// server/context.js; see the header there.)
//
// persistSession:false keeps it out of ~/.claude/projects (otherwise every probe
// would surface as a phantom conversation in the drawer) and settingSources:[]
// keeps the operator's own settings out of a call that only reads a static list.
let sdkCache = { at: 0, rows: null, ok: false };

export async function sdkModels() {
  const ttl = sdkCache.ok ? TTL_MS : FAIL_TTL_MS;
  if (sdkCache.rows && Date.now() - sdkCache.at < ttl) return sdkCache.rows;
  const ac = new AbortController();
  let q = null;
  try {
    q = query({
      prompt: (async function* () { await new Promise(() => {}); })(),
      options: {
        model: 'haiku',
        persistSession: false,
        maxTurns: 1,
        settingSources: [],
        abortController: ac,
        env: scrubbedEnv(),
        stderr: () => {}, // a probe's stderr is noise in the server log
      },
    });
    const rows = await q.supportedModels();
    sdkCache = { at: Date.now(), rows: Array.isArray(rows) ? rows : [], ok: true };
  } catch {
    // Never throw: an unavailable picker just means we fall back a grade.
    sdkCache = { at: Date.now(), rows: sdkCache.rows || [], ok: false };
  } finally {
    // Always tear the probe down — a leaked CLI is ~340 MB of this box's 5.9 GB.
    try { ac.abort(); } catch { /* already gone */ }
    try { await q?.close?.(); } catch { /* already gone */ }
  }
  return sdkCache.rows;
}

// A picker row's wire id, minus the 1M marker: 'opus[1m]' and 'default' both
// resolve to 'claude-opus-5', which is the id we actually send to the API.
const baseId = (row) => String(row.resolvedModel || row.value || '').replace(/\[1m\]$/i, '');
const has1m = (row) => /\[1m\]$/i.test(String(row.value || '')) || /\[1m\]$/i.test(String(row.resolvedModel || ''));

// A picker row's human name and its one-line "what it's for". The CLI has written
// these two ways:
//   before — displayName named the SLOT ("Default (recommended)") and the
//            description led with the version: "Opus 5 with 1M context · Best for…"
//   now    — displayName IS the version ("Opus 5.5") and the description is a bare
//            line ("For your toughest challenges").
// The old reader took the description's lead whenever it was short, which under
// the new format made every short description a model's NAME: the picker offered
// "Fastest for quick answers" twice and "Efficient for routine tasks" for two
// different Sonnets. A name carries a version number and a description does not,
// so whichever of the two has one is the name, and the rest is the description.
function sdkLabel(row) {
  const display = String(row.displayName || '').replace(/^Claude\s+/i, '').replace(/\s*\(.*\)\s*$/, '').trim();
  const parts = String(row.description || '').split('·').map((s) => s.trim()).filter(Boolean);
  const lead = (parts[0] || '').replace(/\s+with 1M context$/i, '').trim();
  const named = (s) => !!s && s.length <= 30 && /\d/.test(s);
  if (named(display)) {
    // A description that ALSO leads with the name must not repeat it underneath.
    const dup = lead.toLowerCase().startsWith(display.toLowerCase());
    return { short: display, desc: (dup ? parts.slice(1) : parts).join(' · ') };
  }
  if (named(lead)) return { short: lead, desc: parts.slice(1).join(' · ') };
  return { short: display || baseId(row), desc: parts.join(' · ') };
}

// Collapse the picker's rows (several per model: an alias, a 1M twin, …) into one
// entry per real model id. The CLI's order is still the curation, but it is no
// longer one family at a time: it leads with the current model of each family and
// then lists every older version, Haiku 4.5 before Sonnet 5 before Opus 5. Drawn
// as it came, that was nine family headers for four families.
//
// So the FIRST model of each family is its latest, and lineupFirst() groups the
// rest. Not "the alias rows are the lineup": that holds for the new list, but the
// list before it named Fable 5.1 by its full id ('claude-fable-5-1[1m]') between
// two aliases, and would have filed the newest Fable under "Older models".
function decorateSdk(rows) {
  const out = [], byId = new Map();
  // 'default' names a SLOT ("Default (recommended)"), and the CLI lists it first.
  // Read it last, so it can fill in a model nothing else describes but never
  // decides where that model sits — it put Sonnet at the top of the lineup.
  const all = rows || [];
  const ordered = [...all.filter((r) => r.value !== 'default'), ...all.filter((r) => r.value === 'default')];
  for (const row of ordered) {
    const id = baseId(row);
    if (!id) continue;
    let m = byId.get(id);
    if (!m) {
      m = { id, name: '', short: '', desc: '', fast: false, efforts: [], ctx1m: false };
      byId.set(id, m);
      out.push(m);
    }
    if (has1m(row)) m.ctx1m = true;
    if (row.supportsFastMode) m.fast = true;
    const levels = EFFORT_ORDER.filter((k) => (row.supportedEffortLevels || []).includes(k));
    if (levels.length > m.efforts.length) m.efforts = levels;
    // The first row to name a model labels it: a family's alias comes before any
    // full-id row for the same model, and 'default' — read last — only labels a
    // model no other row named.
    if (!m.name) {
      const l = sdkLabel(row);
      m.short = l.short;
      m.name = l.short;
      m.desc = l.desc;
    }
  }
  const seen = new Set();
  for (const m of out) { m.latest = !seen.has(familyOf(m.id)); seen.add(familyOf(m.id)); }
  return lineupFirst(out);
}

// Does this model id have a 1M-context twin? Asked by claude.js before it appends
// the '[1m]' suffix — sending it to a model without one makes the CLI reject the
// id outright. Falls back to the static table so 1M still works while offline.
export async function supports1m(id) {
  const want = String(id || '').replace(/\[1m\]$/i, '');
  if (!want) return false;
  const rows = await sdkModels();
  if (rows && rows.length) return rows.some((r) => has1m(r) && baseId(r) === want);
  return STATIC_FALLBACK.some((m) => m.ctx1m && m.id === want);
}

export async function listModels() {
  if (cache.models && Date.now() - cache.at < TTL_MS) return cache;
  // Grade 1: the curated picker — what the terminal itself would offer.
  const curated = decorateSdk(await sdkModels());
  if (curated.length) { cache = { at: Date.now(), models: curated, live: true }; return cache; }
  const tok = oauthToken();
  if (tok) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/models?limit=100', {
        headers: {
          authorization: 'Bearer ' + tok,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20',
        },
      });
      if (r.ok) {
        const j = await r.json();
        const models = decorate((j.data || []).filter((m) => m && m.id));
        if (models.length) { cache = { at: Date.now(), models, live: true }; return cache; }
      }
    } catch { /* fall through to fallback */ }
  }
  // Keep the last good live list if we have one; otherwise the static subset.
  if (cache.models) return cache;
  return { at: Date.now(), models: decorate(STATIC_FALLBACK), live: false };
}
