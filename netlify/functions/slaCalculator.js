/**
 * slaCalculator.js
 *
 * Computes the real trouble-ticket SLA deadline from receivedAt + site address,
 * replacing the unreliable priority/deadline fields Neumo's emails carry.
 *
 * Rule (confirmed 2026-09-07):
 *   - 4 business hours, 8:00 AM - 5:00 PM, in the SITE'S local timezone
 *     (ticket receivedAt timestamps arrive in Eastern regardless of site state)
 *   - Business days: Mon-Fri everywhere, + Saturday only in states with
 *     Saturday coverage
 *   - Never counts: Sundays, holidays (any state)
 *
 * Timezone is derived from the ticket's zip code (via the site address),
 * NOT a state-level table -- this handles multi-timezone states (FL
 * panhandle, ID panhandle, TX/El Paso, etc.) automatically and needs no
 * maintenance as new states are added.
 *
 * Does NOT touch technician assignment/availability -- that's a separate,
 * later step that can consume this deadline as one input.
 *
 * Dependency: zipcode-to-timezone (zero deps, offline lookup)
 *   npm install zipcode-to-timezone
 */

const tzlookup = require('zipcode-to-timezone');

// ---- Config you own / need to verify -------------------------------------

// States with NO Saturday rotation (confirmed from TJ's dispatch doc,
// 2026-07-27): everyone else is assumed to have Saturday coverage.
// This is a staffing decision, not a geographic one, so it stays
// state-level even though timezone no longer is. VERIFY against the full
// 17-state list -- I only have this subset confirmed.
const NO_SATURDAY_COVERAGE = new Set([
  'OH', 'WV', 'NC', 'SC', 'IL', 'MN', 'OR', 'FL',
]);

// Fallback timezone per state, used ONLY if a zip can't be extracted from
// the ticket's address (should be rare -- worth logging/reviewing if it
// ever fires). Best-effort defaults, not authoritative.
const STATE_TIMEZONE_FALLBACK = {
  GA: 'America/New_York', NC: 'America/New_York', SC: 'America/New_York',
  FL: 'America/New_York', OH: 'America/New_York', WV: 'America/New_York',
  MI: 'America/Detroit',
  IN: 'America/Indiana/Indianapolis',
  IL: 'America/Chicago', MN: 'America/Chicago', AL: 'America/Chicago',
  AR: 'America/Chicago', MS: 'America/Chicago',
  CO: 'America/Denver',
  ID: 'America/Boise', // panhandle (Pacific) handled by zip lookup; this is the fallback default
  NV: 'America/Los_Angeles', OR: 'America/Los_Angeles',
  CA: 'America/Los_Angeles', // not yet live -- added ahead of rollout
  // AL: appears in the app's state dropdown but not in the current company
  // roster -- left in for now, worth confirming whether it's an active state
};

// Company holidays observed across ALL states. Populate/verify against
// whatever source of truth you want the connector to use -- confirmed
// 2026-09-07 lines up with the "Holidays in United States" Google calendar.
const HOLIDAYS_2026 = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19',
  '2026-07-03', '2026-09-07', '2026-11-26', '2026-11-27', '2026-12-25',
]);

const BUSINESS_START_HOUR = 8;
const BUSINESS_END_HOUR = 17;
const SLA_HOURS = 4;

// ---- Zip / timezone resolution --------------------------------------------

function extractZip(address) {
  const match = address && address.match(/\b(\d{5})(?:-\d{4})?\b/);
  return match ? match[1] : null;
}

function resolveTimezone(address, state) {
  const zip = extractZip(address);
  const tz = zip ? tzlookup.lookup(zip) : null;
  if (tz) return tz;
  const fallback = STATE_TIMEZONE_FALLBACK[state];
  if (fallback) return fallback;
  throw new Error(
    `Could not resolve timezone: no zip found in address ("${address}") ` +
    `and no fallback configured for state "${state}"`
  );
}

// ---- Timezone-safe wall-clock helpers (no external deps) ------------------

function getZonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).map(p => [p.type, p.value])
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday,
  };
}

function zonedTimeToUtc(year, month, day, hour, minute, timeZone) {
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  for (let i = 0; i < 2; i++) {
    const observed = getZonedParts(guess, timeZone);
    const observedAsUtc = Date.UTC(
      observed.year, observed.month - 1, observed.day,
      observed.hour, observed.minute, observed.second
    );
    const target = Date.UTC(year, month - 1, day, hour, minute, 0);
    const diff = target - observedAsUtc;
    guess = new Date(guess.getTime() + diff);
  }
  return guess;
}

function isWeekendOrHoliday(parts, isoDate, saturdayCovered) {
  if (parts.weekday === 'Sun') return true;
  if (parts.weekday === 'Sat' && !saturdayCovered) return true;
  if (HOLIDAYS_2026.has(isoDate)) return true;
  return false;
}

function toIsoDate(parts) {
  const mm = String(parts.month).padStart(2, '0');
  const dd = String(parts.day).padStart(2, '0');
  return `${parts.year}-${mm}-${dd}`;
}

// ---- Core SLA calculation --------------------------------------------------

/**
 * @param {string} receivedAtUtc - ISO timestamp, ticket's receivedAt (raw,
 *   as sent -- Eastern-sourced regardless of site state; this function
 *   handles the conversion internally)
 * @param {string} address - ticket's site address (used to extract zip ->
 *   timezone)
 * @param {string} state - 2-letter state code (used only for Saturday-
 *   coverage lookup, and as a timezone fallback if zip extraction fails)
 * @returns {string} ISO UTC timestamp of the real SLA deadline
 */
function computeSlaDeadline(receivedAtUtc, address, state) {
  const timeZone = resolveTimezone(address, state);
  const saturdayCovered = !NO_SATURDAY_COVERAGE.has(state);

  let remainingMinutes = SLA_HOURS * 60;

  let cursor = new Date(receivedAtUtc);
  let parts = getZonedParts(cursor, timeZone);

  const isBeforeOpen = parts.hour < BUSINESS_START_HOUR;
  const isAfterClose = parts.hour >= BUSINESS_END_HOUR;
  const nonBusinessDay = isWeekendOrHoliday(parts, toIsoDate(parts), saturdayCovered);

  if (nonBusinessDay || isAfterClose) {
    cursor = advanceToNextBusinessDayStart(cursor, timeZone, saturdayCovered);
    parts = getZonedParts(cursor, timeZone);
  } else if (isBeforeOpen) {
    cursor = zonedTimeToUtc(parts.year, parts.month, parts.day, BUSINESS_START_HOUR, 0, timeZone);
    parts = getZonedParts(cursor, timeZone);
  }

  while (remainingMinutes > 0) {
    const minutesLeftToday = (BUSINESS_END_HOUR - parts.hour) * 60 - parts.minute;
    if (remainingMinutes <= minutesLeftToday) {
      cursor = new Date(cursor.getTime() + remainingMinutes * 60000);
      remainingMinutes = 0;
    } else {
      remainingMinutes -= minutesLeftToday;
      cursor = advanceToNextBusinessDayStart(cursor, timeZone, saturdayCovered);
      parts = getZonedParts(cursor, timeZone);
    }
  }

  return cursor.toISOString();
}

function advanceToNextBusinessDayStart(cursor, timeZone, saturdayCovered) {
  let parts = getZonedParts(cursor, timeZone);
  do {
    const nextUtcGuess = zonedTimeToUtc(parts.year, parts.month, parts.day, 12, 0, timeZone);
    const nextDay = new Date(nextUtcGuess.getTime() + 24 * 3600 * 1000);
    parts = getZonedParts(nextDay, timeZone);
  } while (isWeekendOrHoliday(parts, toIsoDate(parts), saturdayCovered));
  return zonedTimeToUtc(parts.year, parts.month, parts.day, BUSINESS_START_HOUR, 0, timeZone);
}

module.exports = {
  computeSlaDeadline,
  resolveTimezone,
  extractZip,
  NO_SATURDAY_COVERAGE,
  HOLIDAYS_2026,
};
