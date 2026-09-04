// Operational memory: what a routine did last time, and what other areas left
// for it to pick up (audit § 4.3 — the "context.js" in that list).
//
// Moved out of operations.js verbatim. It reads prior runs and handoff notes and
// renders the preamble injected ahead of a routine's prompt, so a recurring agent
// can tell "I already fixed this and it came back" from "this is new". Nothing
// here runs anything or touches a working tree — it only reads the board and
// writes notes, both through ops/store.js.
import crypto from 'node:crypto';
import { read, update } from '../store.js';
import { NOTES_COLLECTION, load, mutate, now } from './store.js';

/* ───────────────────────── Operational memory ──────────────────────────────
 * Recurring routines learn across runs. Before each run we inject a context
 * preamble: (1) a digest of this routine's PAST runs — so the agent can spot a
 * problem it already "fixed" and escalate instead of repeating a fix that
 * didn't hold — and (2) INCOMING handoff notes left by runs in OTHER areas that
 * touched this one. The agent may, in turn, emit its own "### Handoffs" block,
 * which we persist as notes for the target area's next run. Notes live in their
 * own collection but ride the same atomic JSON store as everything else.
 */
const noteId = () => 'note_' + crypto.randomBytes(5).toString('hex');
function loadNotes() { return read(NOTES_COLLECTION, { notes: [] }); }
function addNotes(records) {
  if (!records || !records.length) return;
  update(NOTES_COLLECTION, (db) => { db.notes.push(...records); return db; }, { notes: [] });
}
// Mark notes as delivered to a run of their target area (they stop being fresh
// "action items" and become "recently handled" context). Kept forever as history.
export function ackNotes(ids, byTaskId) {
  if (!ids || !ids.length) return;
  const set = new Set(ids);
  update(NOTES_COLLECTION, (db) => {
    db.notes.forEach((n) => { if (set.has(n.id) && n.status === 'open') { n.status = 'ack'; n.ackedBy = byTaskId; n.ackedAt = now(); } });
    return db;
  }, { notes: [] });
}
// Once a run ships, stamp its commit onto the notes it wrote so the target area
// sees exactly what landed in production.
export function stampNoteCommit(fromTaskId, sha) {
  if (!sha) return;
  update(NOTES_COLLECTION, (db) => { db.notes.forEach((n) => { if (n.fromTask === fromTaskId) n.shipCommit = sha; }); return db; }, { notes: [] });
}

// Terminal statuses worth remembering as "a past attempt at this routine".
const MEMORY_STATUSES = new Set(['needs_approval', 'applied', 'shipped', 'done', 'verify_failed', 'ship_failed', 'rejected', 'error', 'cancelled']);

function routineFor(task) {
  return task.routineId ? (load().tasks.find((x) => x.id === task.routineId) || null) : null;
}
// Cadence drives the "new vs. precedent" split the operator asked for: a daily
// routine treats the last 24h as "new", a weekly one the last 7 days; older runs
// are precedents.
export function cadenceOf(task) {
  const type = routineFor(task)?.schedule?.type;
  if (type === 'daily') return { label: 'day', windowMs: 24 * 3600 * 1000 };
  if (type === 'weekly') return { label: 'week', windowMs: 7 * 24 * 3600 * 1000 };
  return null;
}
// Past runs of the same routine (or, for an ad-hoc task, the same project+area),
// most recent first, terminal only, excluding this run.
function priorRuns(task, cap = 8) {
  const sameRoutine = (t) => (task.routineId
    ? t.routineId === task.routineId
    : (!t.routineId && t.project === task.project && t.category === task.category));
  return load().tasks
    .filter((t) => t.id !== task.id && t.startedAt && sameRoutine(t) && MEMORY_STATUSES.has(t.status))
    .sort((a, b) => ((a.finishedAt || a.startedAt) < (b.finishedAt || b.startedAt) ? 1 : -1))
    .slice(0, cap);
}
const OUTCOME = {
  shipped: 'shipped to production', applied: 'applied, awaiting commit',
  needs_approval: 'awaited approval', done: 'no change needed',
  verify_failed: 'FAILED tests', ship_failed: 'FAILED to ship',
  rejected: 'rejected by operator', error: 'errored', cancelled: 'cancelled',
};
function outcomeLabel(s) { return OUTCOME[s] || s; }
function runStatusLabel(id) {
  const t = load().tasks.find((x) => x.id === id);
  return t ? outcomeLabel(t.status) : 'unknown';
}
function briefSummary(t, maxBullets = 2) {
  const lines = String(t.summary || '').split('\n').map((s) => s.replace(/^[-*•]\s*/, '').trim()).filter(Boolean);
  if (!lines.length) return t.detail ? '(narration only)' : '(no summary)';
  return lines.slice(0, maxBullets).join('; ');
}
function fmtDate(iso, tz) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz || SERVER_TZ, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  } catch { return String(iso); }
}

// Incoming notes addressed to this run's area+project. `open` = fresh action
// items (not yet delivered to a run of this area); `recent` = lately delivered,
// kept as context. A note is never echoed back to the area that wrote it.
function notesForRun(task, openCap = 12, recentCap = 6) {
  const open = [], recent = [];
  for (const n of loadNotes().notes) {
    if (n.project !== task.project || n.toCategory !== task.category || n.fromCategory === task.category) continue;
    (n.status === 'open' ? open : recent).push(n);
  }
  const byNew = (k) => (a, b) => ((a[k] || a.createdAt) < (b[k] || b.createdAt) ? 1 : -1);
  open.sort(byNew('createdAt'));
  recent.sort(byNew('ackedAt'));
  return { open: open.slice(0, openCap), recent: recent.slice(0, recentCap) };
}

// Assemble the context preamble — or '' when there is nothing worth saying, which
// keeps a simple one-off task exactly as it behaved before this feature existed.
// `liveBlock` is a pre-fetched live-signals section (see fetchLiveSignals); it
// rides at the very top as the freshest "what's broken now" briefing.
// Returns { text, noteIds }. `noteIds` are the incoming handoff notes folded
// into this prompt; the CALLER acks them, and only once the run has actually
// reached a terminal success — see executeTask.
export function buildRunContext(task, liveBlock = '') {
  const cad = cadenceOf(task);
  const tz = routineFor(task)?.schedule?.tz || SERVER_TZ;
  const sections = [];

  if (liveBlock) sections.push(liveBlock);

  const prior = priorRuns(task);
  if (prior.length) {
    const fmtRun = (t) => `- ${fmtDate(t.finishedAt || t.startedAt, tz)} — ${outcomeLabel(t.status)}${t.shipCommit ? ' (' + t.shipCommit + ')' : ''}: ${briefSummary(t)}`;
    if (cad) {
      const cut = Date.now() - cad.windowMs;
      const recent = prior.filter((t) => new Date(t.finishedAt || t.startedAt).getTime() >= cut);
      const earlier = prior.filter((t) => new Date(t.finishedAt || t.startedAt).getTime() < cut);
      let b = 'PAST RUNS OF THIS ROUTINE — your operational memory (newest first):';
      if (recent.length) b += `\n\nThis ${cad.label}:\n` + recent.map(fmtRun).join('\n');
      if (earlier.length) b += '\n\nEarlier (precedents — check whether a past fix failed to hold):\n' + earlier.map(fmtRun).join('\n');
      sections.push(b);
    } else {
      sections.push('PAST RUNS — your operational memory (newest first):\n' + prior.map(fmtRun).join('\n'));
    }
  }

  const { open, recent } = notesForRun(task);
  const shownIds = [];
  if (open.length || recent.length) {
    let b = `INCOMING NOTES FROM OTHER AREAS (addressed to "${task.category}"):`;
    if (open.length) {
      b += '\n\nNeeds your attention:';
      for (const n of open) { shownIds.push(n.id); b += `\n- from ${n.fromCategory} [${runStatusLabel(n.fromTask)}${n.shipCommit ? ', ' + n.shipCommit : ''}]: ${n.message}`; }
    }
    if (recent.length) {
      b += '\n\nRecently handled (context):';
      for (const n of recent) b += `\n- from ${n.fromCategory}: ${n.message}`;
    }
    sections.push(b);
  }

  const recurringOrMemory = !!(liveBlock || task.routineId || cad || prior.length || open.length || recent.length);
  if (recurringOrMemory) {
    sections.push([
      'HOW TO WORK THIS RUN:',
      '1. Triage the NEWEST problems first.',
      '2. For each, consult the memory above for PRECEDENTS — has this come up before?',
      '3. If a past update was meant to fix it but the problem is back, treat that fix as FAILED:',
      '   do not repeat it. Look one layer deeper, question an assumption, and try a genuinely',
      '   different approach (root cause over symptom).',
      '4. If your work touches a concern owned by another area (payments, translation, support,',
      "   health, branding, billing), leave that area a handoff note (see the output format) — even",
      "   if you couldn't fully resolve it — so its next run picks up where you left off.",
    ].join('\n'));
  }

  if (!sections.length) return { text: '', noteIds: [] };
  // Stash a snapshot of the notes this run read, for the detail pane. The ack
  // itself is deliberately NOT done here: a run that is cancelled or crashes
  // before finishing has not handled anything, and acking at prompt-build time
  // meant the other area's message was consumed and never seen by anyone.
  if (shownIds.length) {
    mutate(task.id, (t) => { t.contextNotes = open.map((n) => ({ from: n.fromCategory, message: n.message, status: runStatusLabel(n.fromTask), commit: n.shipCommit || null })); });
  }
  return {
    text: '===== OPERATIONS CONTEXT (read this before you start) =====\n\n' + sections.join('\n\n') + '\n\n===== END CONTEXT =====\n\n',
    noteIds: shownIds,
  };
}

// Parse a "### Handoffs" block into {toCategory, message} entries. Lenient: a
// recognized "area:" prefix routes the note; anything else falls back to general
// so a message is never lost. Explicit "none"/"n/a" lines are dropped.
function parseHandoffLines(block) {
  const out = [];
  for (let line of String(block).split('\n')) {
    line = line.replace(/^[\s>]*[-*•]\s*/, '').trim();
    if (!line || /^(none|n\/?a|nothing)\b/i.test(line)) continue;
    let toCategory = 'general', message = line;
    const m = line.match(/^([a-z][a-z ]{1,20}?)\s*[:\-—]\s*(.+)$/i);
    if (m && VALID_CATEGORIES.has(m[1].trim().toLowerCase())) { toCategory = m[1].trim().toLowerCase(); message = m[2].trim(); }
    if (message) out.push({ toCategory, message: message.slice(0, 600) });
  }
  return out;
}
export function extractHandoffs(text) {
  const full = String(text || '');
  const i = full.indexOf(HANDOFF_MARK);
  if (i === -1) return [];
  let blk = full.slice(i + HANDOFF_MARK.length);
  const nxt = blk.search(/\n#{2,3}\s/); // stop at the next heading (e.g. ### Summary)
  if (nxt !== -1) blk = blk.slice(0, nxt);
  return parseHandoffLines(blk);
}
export function persistHandoffs(id, task, finalText) {
  const hs = extractHandoffs(finalText);
  if (!hs.length) return;
  const records = hs.map((h) => ({
    id: noteId(), fromTask: id, fromCategory: task.category, toCategory: h.toCategory,
    project: task.project, message: h.message, createdAt: now(),
    status: 'open', shipCommit: null, ackedBy: null, ackedAt: null,
  }));
  addNotes(records);
  mutate(id, (t) => { t.handoffs = records.map((r) => ({ to: r.toCategory, message: r.message })); });
}
