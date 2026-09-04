// The running cost meter the spend cap was always missing.
//
// The README said it plainly: "the spend cap is stored, not enforced… nothing
// meters spend", and `isOverSpendCap()` sat exported and uncalled. This is the
// meter. Every finished turn already reports what it cost — claude.js forwards the
// SDK's `total_cost_usd` on the result event — so the only things missing were
// somewhere to add it up and somebody to ask before starting the next one.
//
// ONE HONESTY NOTE, and it belongs in every label this feeds: on a Claude
// subscription these dollars are the SDK's own ESTIMATE of what the same tokens
// would have cost through the API. They are not a bill, and nothing here is
// charged to anyone. It is a usage figure denominated in dollars, which is exactly
// what makes it a useful budget — and exactly why calling it "spent" would be a
// small lie repeated on every screen.
import { read, update } from './store.js';
import { isOverSpendCap, getWorkspace } from './settings.js';

const COLLECTION = 'spend';

// Calendar months, in the server's own zone — the box sits in one place and a
// budget is a human, local-calendar idea. Keyed as a string so the store stays a
// plain readable JSON file.
function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Keep a couple of years of history and no more: this file is read on every turn
// start, and an unbounded ledger would grow forever for a number nobody reads.
const KEEP_MONTHS = 24;

function empty() { return { months: {} }; }

// Record one finished turn. `usd` may be null — the SDK does not always compute a
// cost, and a turn with no figure must add nothing rather than add zero and be
// counted as a request that cost nothing.
export function recordTurn({ userId, usd, tokens }) {
  const cost = Number(usd);
  const tok = Number(tokens) || 0;
  if (!Number.isFinite(cost) && !tok) return;
  const key = monthKey();
  const who = String(userId || '__owner__');
  update(COLLECTION, (db) => {
    if (!db.months) db.months = {};
    const m = db.months[key] || (db.months[key] = { totalUsd: 0, turns: 0, tokens: 0, byUser: {} });
    const u = m.byUser[who] || (m.byUser[who] = { usd: 0, turns: 0, tokens: 0 });
    if (Number.isFinite(cost)) { m.totalUsd += cost; u.usd += cost; }
    m.tokens += tok; u.tokens += tok;
    m.turns += 1; u.turns += 1;
    const keys = Object.keys(db.months).sort();
    while (keys.length > KEEP_MONTHS) delete db.months[keys.shift()];
    return db;
  }, empty());
}

function monthOf(key) {
  const db = read(COLLECTION, empty());
  return (db.months && db.months[key]) || { totalUsd: 0, turns: 0, tokens: 0, byUser: {} };
}

// This month's figure, and where it sits against the cap.
export function spendSummary() {
  const key = monthKey();
  const m = monthOf(key);
  return {
    month: key,
    usd: round(m.totalUsd),
    turns: m.turns,
    tokens: m.tokens,
    over: isOverSpendCap(m.totalUsd),
    cap: Number(getWorkspace().spendCap) || 0,
    enforced: !!getWorkspace().budgetEnforced,
    // The label every consumer should use, so the caveat above travels with the
    // number instead of being lost between here and a screen.
    basis: 'estimated API-equivalent cost, not a bill',
  };
}

// Per-account figures for the members list, which returned hard-coded zeros until
// there was something real to put there.
export function spendByUser() {
  const m = monthOf(monthKey());
  const out = {};
  for (const [id, v] of Object.entries(m.byUser || {})) {
    out[id] = { usd: round(v.usd), turns: v.turns || 0, tokens: v.tokens || 0 };
  }
  return out;
}

// The gate. Called before a turn starts; returns null to proceed, or the reason to
// refuse. Deliberately NOT scoped per account: a workspace budget is a workspace
// budget, and an owner who capped themselves meant it. Settings still works while
// this is refusing, so the way out is always one screen away.
export function spendGate() {
  const s = spendSummary();
  if (!s.over) return null;
  return `The workspace budget for ${s.month} is used up (about $${s.usd.toFixed(2)} of estimated `
    + 'API-equivalent cost). Raise or clear the budget in Settings to keep going.';
}

function round(n) { return Math.round((Number(n) || 0) * 1e6) / 1e6; }
