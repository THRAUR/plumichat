// Live production signals — what is failing in the project RIGHT NOW (audit § 4.3).
//
// Moved out of operations.js verbatim, and it moves cleanly because it shares
// nothing with the rest: no board state, no task record, no store. It takes a
// task and a cadence, asks the project's own admin API for a redacted error
// digest, and hands back a markdown block for the run context.
import path from 'node:path';
import fs from 'node:fs';
import { DATA_DIR } from '../store.js';

/* ──────────────────────── Live production signals ──────────────────────────
 * Operational memory tells a routine what IT did before; live signals tell it
 * what is failing in production RIGHT NOW. PlumiChat (the trusted server) fetches
 * a REDACTED, aggregate error digest from the project's admin API and folds it
 * into the run context as the freshest section — the "newest problems" the
 * operator asked us to triage first.
 *
 * Security: the admin key lives in PlumiChat's config (a gitignored file or env),
 * is sent as an HTTP header, and never enters a prompt, a tool call, or the
 * agent's view. The remote endpoint is the one that guarantees no PII leaves
 * the source app; we only ever render
 * counts + developer-authored codes/messages here. Unconfigured → no-op, so a
 * project without a signals source behaves exactly as before.
 *
 * Config shape (per project, keyed by the project dir name):
 *   { "my-project": { "baseUrl": "https://…", "apiKey": "…",
 *                               "path": "/dashboard/api/ops/errors" } }
 */
const SIGNALS_FILE = path.join(DATA_DIR, 'ops-signals.json');
const SIGNALS_TIMEOUT_MS = 8000;
const SIGNALS_PATH_DEFAULT = '/dashboard/api/ops/errors';
const SIGNALS_PLACEHOLDER = /PASTE_|YOUR_|example\.com|changeme/i; // half-filled template → treat as unset

// Load the per-project signals config. The OPS_SIGNALS env var (a JSON string)
// wins when present — handy for prod secret injection — otherwise we read the
// gitignored data/ops-signals.json. Malformed/absent → {} (signals disabled).
function loadSignalsConfig() {
  let cfg = null;
  if (process.env.OPS_SIGNALS) {
    try { cfg = JSON.parse(process.env.OPS_SIGNALS); } catch { /* ignore malformed env */ }
  }
  if (!cfg) {
    try { cfg = JSON.parse(fs.readFileSync(SIGNALS_FILE, 'utf8')); } catch { /* absent → no signals */ }
  }
  return cfg && typeof cfg === 'object' ? cfg : {};
}

// Resolve a usable {baseUrl, apiKey, path} for a project, or null when it's
// missing or still carries template placeholders.
function signalsConfigFor(project) {
  const c = loadSignalsConfig()[project];
  if (!c || !c.baseUrl || !c.apiKey) return null;
  if (SIGNALS_PLACEHOLDER.test(c.baseUrl) || SIGNALS_PLACEHOLDER.test(c.apiKey)) return null;
  return { baseUrl: String(c.baseUrl).replace(/\/+$/, ''), apiKey: String(c.apiKey), path: c.path || SIGNALS_PATH_DEFAULT };
}

// How far back to ask for, matched to the routine's cadence (the same window
// the memory split uses): a daily routine sees the last day, a weekly one the
// last week, an ad-hoc task the last day.
function signalsWindowHours(cad) {
  if (cad?.label === 'week') return 24 * 7;
  return 24;
}

// Turn a digest payload into { block, snapshot }: `block` is the prompt text
// (empty when there is nothing useful to say), `snapshot` is a compact object
// stashed on the task for the detail pane.
function renderLiveSignals(data, hours) {
  const winLabel = hours >= 168 ? 'week' : (hours <= 24 ? 'day' : hours + 'h');
  const totals = (data && data.totals) || {};
  const total = Number(totals.total || 0);
  if (!total) {
    return {
      block: `LIVE PRODUCTION SIGNALS (last ${winLabel}): the production error log recorded NO failures in this window. There is no active fire — use this run to verify things still look healthy rather than to hunt for a problem.`,
      snapshot: { ok: true, hours, total: 0, bySeverity: {}, byCategory: {}, top: [] },
    };
  }
  const sev = totals.by_severity || {};
  const cat = totals.by_category || {};
  const top = Array.isArray(data.top_errors) ? data.top_errors.slice(0, 8) : [];
  const sevLine = ['critical', 'error', 'warn'].filter((k) => sev[k]).map((k) => `${sev[k]} ${k}`).join(', ');
  const catLine = Object.entries(cat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');

  let b = `LIVE PRODUCTION SIGNALS — REAL errors logged in production in the last ${winLabel} (the source of truth for "what is broken NOW"; already redacted, contains no user data):`;
  b += `\n- Total failures: ${total}` + (sevLine ? ` (${sevLine})` : '');
  if (catLine) b += `\n- By area: ${catLine}`;
  if (top.length) {
    b += '\n- Most frequent failures (investigate the top ones first):';
    for (const e of top) {
      const code = e.error_code || '(no code)';
      const msg = e.sample_message ? ` — “${String(e.sample_message).slice(0, 140)}”` : '';
      b += `\n   • ${e.count}× [${e.category}/${code}${e.severity ? ', ' + e.severity : ''}]${msg}`;
    }
  }
  b += '\nTreat these as the NEWEST problems. Cross-check each against your past-run memory below: if one recurs after a prior fix, that fix did NOT hold — go deeper rather than repeating it.';

  return {
    block: b,
    snapshot: {
      ok: true, hours, total,
      bySeverity: sev, byCategory: cat,
      top: top.map((e) => ({ category: e.category, code: e.error_code || null, severity: e.severity || null, count: e.count, msg: e.sample_message ? String(e.sample_message).slice(0, 120) : null })),
    },
  };
}

// Fetch the live digest for a task's project. Server-side, header-authenticated,
// time-boxed, and NEVER throws — any failure returns a snapshot the operator can
// see with an empty block (so the agent isn't told about a fetch we couldn't do).
export async function fetchLiveSignals(task, cad) {
  const conf = signalsConfigFor(task.project);
  if (!conf) return null;
  const hours = signalsWindowHours(cad);
  const url = `${conf.baseUrl}${conf.path}?hours=${hours}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SIGNALS_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'X-API-Key': conf.apiKey, Accept: 'application/json' }, signal: ctl.signal });
    if (!res.ok) return { block: '', snapshot: { ok: false, hours, status: res.status } };
    const data = await res.json();
    return renderLiveSignals(data, hours);
  } catch (e) {
    return { block: '', snapshot: { ok: false, hours, error: String(e?.message || e) } };
  } finally {
    clearTimeout(timer);
  }
}
