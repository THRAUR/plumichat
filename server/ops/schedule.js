// When an Operations routine next fires (audit § 4.3).
//
// Split out of operations.js verbatim: this is the only part of that module with
// no state of its own and no dependency on the rest of it — pure calendar maths
// plus the validation that produces a schedule object in the first place. It is
// also the part most worth reading on its own, because timezone arithmetic is
// where "it fired an hour early" bugs live.
//
// The rule the whole file exists to honour: a time means the wall clock in the
// zone the user set it in (their device sends its IANA zone), not the server every
// offset is read from the actual zone rules at that instant via Intl, so DST is
// correct and no fixed offset is ever baked in.

// Validate + normalize a schedule from the client into a clean object, or null
// for "run now". Throws on malformed input so the API surfaces a clear error.
export function normalizeSchedule(s) {
  if (!s || s.type === 'now' || s.type === 'none') return null;
  const type = String(s.type);
  // The client sends its IANA timezone so a time means the wall clock where the
  // user set it (their device), not the server's. Fall back to the server zone
  // for older clients / saved schedules so nothing silently shifts.
  const tz = validTz(s && s.tz) ? s.tz : SERVER_TZ;
  if (type === 'once') {
    // A naive wall-clock ("2026-06-09T14:30") + the user's tz. Interpret those
    // calendar fields in THAT zone, not the server's, so it fires when picked.
    const m = String((s && s.at) || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    const at = m
      ? new Date(wallTimeToUtc(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], tz))
      : new Date(s.at); // fallback: an already-absolute ISO string
    if (Number.isNaN(at.getTime())) throw new Error('invalid date/time for a one-off schedule');
    return { type: 'once', at: at.toISOString(), tz };
  }
  if (type === 'daily') return { type: 'daily', time: normalizeTime(s.time), tz };
  if (type === 'weekly') {
    const day = Number(s.day);
    if (!Number.isInteger(day) || day < 0 || day > 6) throw new Error('weekly schedule needs a weekday (0–6)');
    return { type: 'weekly', day, time: normalizeTime(s.time), tz };
  }
  throw new Error('unknown schedule type: ' + type);
}

function normalizeTime(t) {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return '09:00';
  const hh = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  const mm = Math.min(59, Math.max(0, parseInt(m[2], 10)));
  return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

// The server's own IANA zone — the backward-compatible fallback for schedules
// saved before timezones were tracked, and for any client that omits one.
const SERVER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

function validTz(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// Offset (ms) of `tz` from UTC at instant `ms` = (that zone's wall clock read as
// if it were UTC) − ms. Positive east of UTC. DST-correct: read from the actual
// zone rules at that instant via Intl, with no fixed offsets baked in.
function tzOffsetMs(ms, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(ms))) p[part.type] = part.value;
  const hour = p.hour === '24' ? 0 : Number(p.hour); // Intl can emit '24' at midnight
  const asUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second));
  return asUTC - ms;
}

// UTC instant (ms) for a wall-clock time in `tz`. Two passes so a DST boundary
// between the first guess and the real offset is corrected (handles spring/autumn).
function wallTimeToUtc(y, mo, d, hh, mm, tz) {
  const wallAsUtc = Date.UTC(y, mo, d, hh, mm, 0, 0);
  const off1 = tzOffsetMs(wallAsUtc, tz);
  const off2 = tzOffsetMs(wallAsUtc - off1, tz);
  return wallAsUtc - off2;
}

// Calendar { y, mo(0-11), d } of an instant as seen in `tz`.
function ymdInTz(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  return { y: Number(p.year), mo: Number(p.month) - 1, d: Number(p.day) };
}

// Weekday (0=Sun … 6=Sat) of a calendar date — a tz-independent calendar fact.
function weekdayOf({ y, mo, d }) { return new Date(Date.UTC(y, mo, d, 12)).getUTCDay(); }

// Shift a calendar date by n days, staying in calendar space (noon anchor avoids
// any DST midnight edge).
function addDaysCal({ y, mo, d }, n) {
  const t = new Date(Date.UTC(y, mo, d + n, 12));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth(), d: t.getUTCDate() };
}

// Next wall-clock occurrence (ISO/UTC) for a schedule, computed in the schedule's
// own timezone — so "10:15 daily" means 10:15 where the user set it, DST and all.
export function computeNextRun(schedule, from = new Date()) {
  if (!schedule) return null;
  if (schedule.type === 'once') return schedule.at;
  const tz = validTz(schedule.tz) ? schedule.tz : SERVER_TZ;
  const [hh, mm] = schedule.time.split(':').map(Number);
  const fromMs = from.getTime();
  const today = ymdInTz(from, tz);
  // Walk forward calendar day by day (≤8 covers daily + any weekday) to the first
  // matching occurrence strictly in the future.
  for (let i = 0; i < 8; i++) {
    const cal = addDaysCal(today, i);
    if (schedule.type === 'weekly' && weekdayOf(cal) !== schedule.day) continue;
    const ms = wallTimeToUtc(cal.y, cal.mo, cal.d, hh, mm, tz);
    if (ms > fromMs) return new Date(ms).toISOString();
  }
  return new Date(fromMs + 7 * 24 * 3600 * 1000).toISOString(); // safety net (unreachable)
}
