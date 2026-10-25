/**
 * netlify/functions/lib/timesheet-hours.js  (v1, 2026-10-25)
 *
 * Reads the hours off the "Time" tab of a technician's bi-weekly time and expense workbook.
 *
 * Layout it expects (the standard MCR sheet): a Time tab with two blocks, each opened by a
 * WEEK BEGINNING / WEEK ENDING pair, daily hours in the HOURS column, and labeled totals
 * "WEEK 1 TOTAL:", "WEEK 2 TOTAL:" and "TOTAL HOURS THIS PAY PERIOD:". The labeled total is
 * used when it holds a number; if it is blank (a sheet saved without calculated values), the
 * daily hours are added up instead.
 *
 * Overtime rule (the owner's): a week over 40 hours is overtime, judged week by week, because a
 * 45-hour week and a 30-hour week total 75 and would slip under a plain 80-hour check.
 *
 * Returns { ok:true, weeks:[{label, begin, end, hours, source}], total, overtime, overtimeWeeks:[n] }
 * or { ok:false, reason } when no Time tab / no week blocks can be found.
 */
const WEEKLY_LIMIT = 40;

function num(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = v.trim().replace(/,/g, '');
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  }
  return null;
}
function isoDate(v) {
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  return null;
}
function firstNumberAfter(row, idx) {
  for (let i = idx + 1; i < row.length; i++) { const n = num(row[i]); if (n != null) return n; }
  return null;
}

function parseHoursFromGrid(grid) {
  const weeks = [];
  let cur = null;
  let periodTotal = null;
  for (const row of grid) {
    const cells = row.map((c) => (typeof c === 'string' ? c.trim() : c));
    const joined = cells.filter((c) => typeof c === 'string').join(' ');
    if (/WEEK\s*BEGINNING/i.test(joined)) {
      cur = { begin: null, end: null, daily: 0, dailyCount: 0, total: null };
      weeks.push(cur);
      for (const c of cells) { const d = isoDate(c); if (d) { cur.begin = d; break; } }
      continue;
    }
    if (!cur) {
      if (/TOTAL\s*HOURS\s*THIS\s*PAY\s*PERIOD/i.test(joined)) {
        const i = cells.findIndex((c) => typeof c === 'string' && /TOTAL\s*HOURS/i.test(c));
        periodTotal = firstNumberAfter(cells, i);
      }
      continue;
    }
    if (/WEEK\s*ENDING/i.test(joined)) {
      for (const c of cells) { const d = isoDate(c); if (d) { cur.end = d; break; } }
      continue;
    }
    const totalIdx = cells.findIndex((c) => typeof c === 'string' && /WEEK\s*\d?\s*TOTAL/i.test(c));
    if (totalIdx >= 0) { cur.total = firstNumberAfter(cells, totalIdx); cur = null; continue; }
    if (/TOTAL\s*HOURS\s*THIS\s*PAY\s*PERIOD/i.test(joined)) {
      const i = cells.findIndex((c) => typeof c === 'string' && /TOTAL\s*HOURS/i.test(c));
      periodTotal = firstNumberAfter(cells, i);
      continue;
    }
    // a daily line: a weekday name in the first cell and a number in the HOURS column (F)
    if (typeof cells[0] === 'string' && /^(MON|TUES?|WED(NES)?|THU(RS)?|FRI|SAT(UR)?|SUN)/i.test(cells[0])) {
      const h = num(cells[5]);
      if (h != null) { cur.daily += h; cur.dailyCount += 1; }
    }
  }
  if (!weeks.length) return { ok: false, reason: 'No week blocks found on the Time tab' };
  const out = weeks.map((w, i) => ({
    label: 'Week ' + (i + 1), begin: w.begin, end: w.end,
    hours: w.total != null ? w.total : w.daily,
    source: w.total != null ? 'total' : 'daily',
  }));
  const sum = out.reduce((a, w) => a + w.hours, 0);
  const total = periodTotal != null ? periodTotal : sum;
  const overtimeWeeks = out.map((w, i) => (w.hours > WEEKLY_LIMIT ? i + 1 : 0)).filter(Boolean);
  return { ok: true, weeks: out, total, overtime: overtimeWeeks.length > 0, overtimeWeeks, weeklyLimit: WEEKLY_LIMIT };
}

function parseTimesheetHoursBuffer(buffer) {
  const XLSX = require('xlsx');
  let wb;
  try { wb = XLSX.read(buffer, { type: 'buffer', cellDates: true }); }
  catch (e) { return { ok: false, reason: 'Not a readable workbook' }; }
  const name = wb.SheetNames.find((n) => /^time$/i.test(n.trim())) || wb.SheetNames.find((n) => /time/i.test(n) && !/expense/i.test(n));
  if (!name) return { ok: false, reason: 'No Time tab' };
  const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null });
  return parseHoursFromGrid(grid);
}

module.exports = { parseTimesheetHoursBuffer, parseHoursFromGrid, WEEKLY_LIMIT };
