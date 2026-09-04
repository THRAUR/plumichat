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
// offline). `ctx1m` mirrors what the curated picker offers today, so a 1M request
// still works while we're running blind.
const STATIC_FALLBACK = [
  { id: 'claude-opus-5', display_name: 'Claude Opus 5', ctx1m: true },
  { id: 'claude-fable-5-1', display_name: 'Claude Fable 5.1', ctx1m: true },
  { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' },
  { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5' },
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

// Family ordering + capability hints for the UI. We read the model's real effort
// levels from the API capabilities instead of guessing from the id, so a new model
// lights up exactly the effort controls it supports (and none if it has none).
function decorate(list) {
  const rank = (id) => (/opus/i.test(id) ? 0 : /sonnet/i.test(id) ? 1 : /haiku/i.test(id) ? 2 : 3);
  return list
    .map((m) => ({
      id: m.id,
      name: m.display_name || m.id,
      short: shortName(m.display_name, m.id),
      fast: /opus/i.test(m.id),
      efforts: effortsOf(m.capabilities),
      // /v1/models says nothing about 1M twins; only the curated picker knows.
      ctx1m: !!m.ctx1m,
    }))
    // Keep the API's newest-first order within each family, families Opus→Sonnet→Haiku.
    .map((m, i) => ({ ...m, _i: i }))
    .sort((a, b) => (rank(a.id) - rank(b.id)) || (a._i - b._i))
    .map(({ _i, ...m }) => m);
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

// The picker's descriptions lead with the human version string ("Opus 5 with 1M
// context · Best for everyday…"), which makes a far better pill label than the
// menu-oriented displayName ("Default (recommended)"). Fall back to the display
// name with any trailing parenthetical stripped.
function sdkShort(row) {
  const lead = String(row.description || '').split('·')[0].replace(/\s+with 1M context\s*$/i, '').trim();
  if (lead && lead.length <= 30) return lead;
  return String(row.displayName || '').replace(/\s*\(.*\)\s*$/, '').trim() || baseId(row);
}

// Collapse the picker's rows (several per model: an alias, a 1M twin, …) into one
// entry per real model id, in the CLI's own order. That order IS the curation —
// re-sorting it by family the way decorate() does would throw it away.
function decorateSdk(rows) {
  const out = [], byId = new Map();
  for (const row of rows || []) {
    const id = baseId(row);
    if (!id) continue;
    let m = byId.get(id);
    if (!m) {
      m = { id, name: '', short: '', fast: false, efforts: [], ctx1m: false };
      byId.set(id, m);
      out.push(m);
    }
    if (has1m(row)) m.ctx1m = true;
    if (row.supportsFastMode) m.fast = true;
    const levels = EFFORT_ORDER.filter((k) => (row.supportedEffortLevels || []).includes(k));
    if (levels.length > m.efforts.length) m.efforts = levels;
    // 'default' is an alias row whose label names the slot, not the model — let a
    // real row overwrite it, but keep it if it's all we have for this id.
    if (!m.name || row.value !== 'default') {
      m.short = sdkShort(row);
      m.name = m.short;
    }
  }
  return out;
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
