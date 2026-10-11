/**
 * lib/inventory-dates.js  (v1, 2026-10-11)
 * SAVE AS: netlify/functions/lib/inventory-dates.js
 *
 * One shared rule for "how far ahead may a count sheet be dated?".
 *
 * A technician who sends the count before it is due (for example Friday or
 * Saturday for a Monday-morning deadline) naturally dates it with the due date.
 * Nothing is used between sending and the due date, so that is fine and must
 * not be flagged as "in the future".
 *
 * The latest acceptable date for a sheet that arrived on day X is the latest of:
 *   - X + 1 day (the long-standing allowance for time zones / late-evening sends)
 *   - the next weekly due day (the first Monday on or after X), when X is
 *     Friday, Saturday, Sunday or Monday
 *   - the month-end due day, when it falls within 7 days after X:
 *       last business day of the month; if the month ends on a Saturday, the
 *       following Monday; if it ends on a Sunday, the Friday before.
 *
 * All dates are YYYY-MM-DD strings (Eastern calendar day), compared as text.
 */

function parse(ymd) {
  const [y, m, d] = String(ymd).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}
function fmt(dt) { return dt.toISOString().slice(0, 10); }
function addDays(ymd, n) { const d = parse(ymd); d.setUTCDate(d.getUTCDate() + n); return fmt(d); }

// First Monday on or after the given day.
function nextMondayOnOrAfter(ymd) {
  const dow = parse(ymd).getUTCDay(); // 0 Sun .. 6 Sat
  return addDays(ymd, (8 - dow) % 7);
}

// Month-end due day for the month containing ymd.
function monthEndDue(ymd) {
  const d = parse(ymd);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12));
  const dow = last.getUTCDay();
  const lastYmd = fmt(last);
  if (dow === 6) return addDays(lastYmd, 2); // Saturday -> next Monday
  if (dow === 0) return addDays(lastYmd, -2); // Sunday -> Friday before
  return lastYmd;
}

// Latest date a sheet that arrived on `arrived` may carry without being "in the future".
function latestAllowedDate(arrived) {
  let limit = addDays(arrived, 1);
  // Only for sends within 3 days of Monday (Fri, Sat, Sun, Mon). A Tuesday-to-
  // Thursday send dated next Monday is more likely a typo than an early count.
  const monday = nextMondayOnOrAfter(arrived);
  const daysToMonday = Math.round((parse(monday) - parse(arrived)) / 86400000);
  if (daysToMonday <= 3 && monday > limit) limit = monday;
  const monthEnd = monthEndDue(arrived);
  if (monthEnd >= arrived && monthEnd <= addDays(arrived, 7) && monthEnd > limit) limit = monthEnd;
  return limit;
}

module.exports = { latestAllowedDate, nextMondayOnOrAfter, monthEndDue };
