/**
 * Local-calendar date helpers.
 *
 * Claude Code's stats-cache keys days by the user's LOCAL date, and "today"
 * in the UI means the local day — so never derive date keys from
 * toISOString() (that is UTC and rolls over early/late depending on offset).
 */

function pad(n) { return String(n).padStart(2, '0'); }

/** 'YYYY-MM-DD' for the local calendar day containing `d`. */
function localDateKey(d = new Date()) {
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local date key `n` calendar days before/after `d` (DST-safe). */
function addDaysKey(d, n) {
  const date = new Date(d instanceof Date ? d.getTime() : d);
  date.setDate(date.getDate() + n);
  return localDateKey(date);
}

/** Inclusive list of the last `days` local date keys ending at `now`. */
function lastNDays(days, now = new Date()) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(addDaysKey(now, -i));
  return out;
}

function daysInMonth(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

module.exports = { localDateKey, addDaysKey, lastNDays, daysInMonth };
