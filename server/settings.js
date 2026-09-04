// Settings — real, persisted, editable workspace data backed by the JSON store.
// Secrets are NOT kept here: provider rows store only non-sensitive metadata
// (name, connected flag, a display-only masked hint). Real API keys live solely
// in .env, per the project's credentials rule.
//
// SCOPE: workspace preferences and provider metadata, nothing else. Accounts,
// profiles and members belong to server/users.js — the profile/members API that
// used to live here was a pre-accounts duplicate and has been removed.
import { read, update } from './store.js';


const DEFAULT_WORKSPACE = {
  name: 'Agents Remote Terminal',
  defaultProject: '',
  // '' means "no preference — use the server default". This used to hold the
  // display label 'Sonnet 4.6', which no engine has ever accepted; see below.
  defaultModel: '',
  allowMemberSwitch: true,
  // Metered by server/spend.js and, when armed, enforced before a turn starts.
  spendCap: 500,
  // Enforcement is OPT-IN, and the default of false is the important part. This
  // figure existed for months as a note-to-self, under a row that said in so many
  // words that nothing checked it — so every stored value predates enforcement and
  // none of them was ever a decision to stop working at that number. Turning that
  // placeholder into a hard stop on the next restart would be a trap: the tool
  // would simply refuse to answer one day, for a limit its owner never chose.
  // The Settings toggle is how someone opts in, deliberately, once.
  budgetEnforced: false,
};

// defaultModel must be a MODEL ID the engine will accept ('claude-sonnet-5',
// 'opus[1m]', 'haiku'), never a display label ('Sonnet 4.6') — the settings page
// sends ids. Lowercase alphanumerics plus . _ - and the [1m] context suffix.
// CONTRACT: claude.js reads getWorkspace().defaultModel and uses it when a turn
// specifies no model; '' means the server picks.
const MODEL_ID_RE = /^[a-z0-9._\[\]-]+$/;
function looksLikeModelId(s) {
  return !!s && s.length <= 80 && MODEL_ID_RE.test(s);
}

/* ---------- Workspace ---------- */
export function getWorkspace() {
  const w = read('workspace', { ...DEFAULT_WORKSPACE });
  // An install from before the id rule may still hold the old 'Sonnet 4.6' label.
  // Never hand that to the engine — report "no preference" instead, so a stale
  // setting degrades to the server default rather than failing every turn.
  const m = String(w.defaultModel || '').trim();
  if (m && !looksLikeModelId(m)) return { ...w, defaultModel: '' };
  return w;
}
export function setWorkspace(patch) {
  const next = clean(patch, ['name', 'defaultProject', 'defaultModel', 'allowMemberSwitch', 'spendCap', 'budgetEnforced']);
  if (next.defaultModel !== undefined) {
    const m = String(next.defaultModel == null ? '' : next.defaultModel).trim();
    if (m && !looksLikeModelId(m)) {
      throw new Error('default model must be a model id (e.g. "claude-sonnet-5"), not a display name');
    }
    next.defaultModel = m;
  }
  return update('workspace', (cur) => ({ ...cur, ...next }), { ...DEFAULT_WORKSPACE });
}

// Would `spentUsd` breach the workspace's spend cap? The single place the rule
// lives, so it is not reinvented at a call site — server/spend.js is the meter
// that finally calls it. A cap of 0 or a blank means "no cap".
export function isOverSpendCap(spentUsd) {
  const w = getWorkspace();
  if (!w.budgetEnforced) return false;   // armed by hand only — see the default above
  const cap = Number(w.spendCap);
  if (!Number.isFinite(cap) || cap <= 0) return false;
  return Number(spentUsd) > cap;
}

function clean(obj, allowed) {
  const out = {};
  if (!obj) return out;
  allowed.forEach((k) => { if (obj[k] !== undefined) out[k] = obj[k]; });
  return out;
}
