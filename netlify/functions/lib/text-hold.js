// lib/text-hold.js -- 2026-10-29
// "Don't text before 8:00 AM the recipient's time". A dispatcher in one time zone sends at 7:00 AM
// their time; a technician two or three hours behind gets it held until 8:00 AM THEIR time.
// Only the morning edge is handled; late evening is left to the dispatcher's judgment.

// Default zone per state (a technician row can override with technicians.timezone).
const STATE_TZ = {
  AL: 'America/Chicago', AR: 'America/Chicago', CA: 'America/Los_Angeles', CO: 'America/Denver',
  FL: 'America/New_York', GA: 'America/New_York', ID: 'America/Denver', IL: 'America/Chicago',
  IN: 'America/New_York', MI: 'America/New_York', MN: 'America/Chicago', MS: 'America/Chicago',
  NC: 'America/New_York', NV: 'America/Los_Angeles', OH: 'America/New_York', OR: 'America/Los_Angeles',
  SC: 'America/New_York', WV: 'America/New_York',
};
const EARLIEST_HOUR = 8;

function techTimezone(tech) {
  if (!tech) return null;
  return tech.timezone || STATE_TZ[String(tech.home_state || '').toUpperCase()] || null;
}

function zoneParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
  const o = {};
  for (const p of f.formatToParts(date)) if (p.type !== 'literal') o[p.type] = parseInt(p.value, 10);
  return o;
}
function offsetMs(date, tz) {
  const p = zoneParts(date, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(date.getTime() / 60000) * 60000;
}
function abbr(date, tz) {
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' });
    const part = f.formatToParts(date).find(x => x.type === 'timeZoneName');
    return part ? part.value : '';
  } catch (e) { return ''; }
}
function clock(date, tz) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(date);
}

// -> { tz, hold, deliverAt (ISO or null), label, etLabel, localNow }
function computeHold(tz, now) {
  now = now || new Date();
  if (!tz) return { tz: null, hold: false };
  const p = zoneParts(now, tz);
  const localNow = clock(now, tz) + ' ' + abbr(now, tz);
  if (p.hour >= EARLIEST_HOUR) return { tz, hold: false, localNow };
  // 08:00 local today: find the UTC instant (two passes so a DST change between now and 8 AM is honored)
  let guess = Date.UTC(p.year, p.month - 1, p.day, EARLIEST_HOUR, 0);
  let at = new Date(guess - offsetMs(new Date(guess), tz));
  at = new Date(guess - offsetMs(at, tz));
  return {
    tz, hold: true, localNow,
    deliverAt: at.toISOString(),
    label: clock(at, tz) + ' ' + abbr(at, tz),
    etLabel: clock(at, 'America/New_York') + ' ' + abbr(at, 'America/New_York'),
  };
}

module.exports = { STATE_TZ, techTimezone, computeHold };
