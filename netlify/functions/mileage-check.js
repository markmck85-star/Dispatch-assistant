/**
 * netlify/functions/lib/mileage-check.js
 * ======================================================================
 * Technician mileage sanity-check -- shared by:
 *   - process-mileage-timesheet.js (manual Admin Panel upload: browser
 *     parses the xlsx client-side with SheetJS, same as the Closed
 *     Tickets tab already does, and posts normalized leg rows here)
 *   - mailgun-inbound.js (forwarded timesheet emails: parses the .xlsx
 *     attachment server-side via parseMileageWorkbookBuffer below, then
 *     calls the exact same evaluateMileageReport as the manual path, so
 *     both paths are scored identically)
 *
 * WHAT THIS DOES, AND DOESN'T, PROVE:
 *   Mike's actual ask was a ballpark sanity check to catch a technician
 *   mistyping a mileage/odometer number, not a precise reimbursement
 *   audit. The mileage log format itself (built out in FieldPilot, see
 *   /areas/fieldpilot.md) already carries a full stop-by-stop odometer
 *   trail per leg -- Start place, start odometer, destination, end
 *   odometer, claimed mileage -- which sidesteps the messiness of trying
 *   to reconstruct a day's route from the closed-ticket report (that
 *   report also has no visibility into OTC/testing-station stops, or a
 *   mid-day trip home and back for a trouble ticket). Comparing each
 *   LEG's claimed mileage against the known site-to-site (or home-to-
 *   site) distance is a much sharper check than a single lump biweekly
 *   total ever could be.
 *
 * SITE MATCHING:
 *   The log uses free-text place names ("Steve Reynolds Kroger",
 *   "Lawrenceville Tag Office"), not site codes. Reuses the same
 *   tokenize + token-overlap-coefficient approach already used for the
 *   Salesforce/BlueFolder closed-ticket imports (see perform-import.js),
 *   scoped to the technician's home_state + additional_states to reduce
 *   cross-state false matches. A home-base leg ("Johns Creek" in Mark's
 *   own sample file) is detected separately, by checking whether the
 *   raw label appears inside the technician's own home_address -- not
 *   matched against `sites` at all.
 *
 * DISTANCE LOOKUP:
 *   Prefers real driving-distance rows already in tech_site_distances /
 *   site_site_distances (same tables the dispatch board's Map View and
 *   dispatch-ai.mjs already read from); falls back to a straight-line
 *   haversine estimate over stored lat/lng when no matrix row exists for
 *   that specific pair, flagged distinctly (type: 'haversine-fallback')
 *   so a flagged leg's summary can say honestly how confident the
 *   comparison actually is.
 *
 * FLAGGING (deliberately loose, not a precise audit -- see header above):
 *   - claimedMiles <= 0 on a leg between two different places -> always
 *     flagged (an odometer log genuinely cannot produce this from a real
 *     drive; it's a data-entry error every time).
 *   - claimedMiles vs expectedMiles ratio outside [MIN_RATIO, MAX_RATIO]
 *     -> flagged. Deliberately wide (2.5x / 0.4x) since lunch detours,
 *     a mid-route errand, or genuine route variation are all expected
 *     and should NOT trip this -- only a claim that's wildly off (a
 *     dropped digit, a transposed pair, an extra zero) should.
 *   A leg whose place names didn't resolve to anything goes in
 *   unmatched_legs instead -- genuinely unknown, not evidence of an
 *   error, and kept separate so it's never miscounted as "flagged."
 */

const TOKEN_ALIASES = { co: 'county', cnty: 'county', ave: 'avenue', blvd: 'boulevard', dr: 'drive', rd: 'road', st: 'street', mt: 'mount', hwy: 'highway', pkwy: 'parkway' };
function tokenize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean).map((t) => TOKEN_ALIASES[t] || t);
}

const MIN_RATIO = 0.4;
const MAX_RATIO = 2.5;
const SITE_MATCH_THRESHOLD = 0.65;

function haversineMiles(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => v == null || isNaN(v))) return null;
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** True if rawLabel plausibly refers to the technician's own home base. */
function isHomeLabel(rawLabel, homeAddress) {
  const label = (rawLabel || '').trim().toLowerCase();
  if (!label) return false;
  if (label === 'home' || label === 'office' || label === 'shop') return true;
  if (!homeAddress || label.length < 4) return false;
  return homeAddress.toLowerCase().includes(label);
}

/** Best site match for a raw place name, scoped to the given candidate sites. */
function matchSiteByName(rawName, candidateSites) {
  const targetTokens = tokenize(rawName);
  if (!targetTokens.length) return null;
  let best = null, bestScore = 0;
  for (const site of candidateSites) {
    const siteTokens = tokenize(site.name);
    const setA = new Set(targetTokens), setB = new Set(siteTokens);
    const intersection = [...setA].filter((t) => setB.has(t)).length;
    const smaller = Math.min(setA.size, setB.size);
    const score = smaller > 0 ? intersection / smaller : 0;
    if (score > bestScore) { bestScore = score; best = site; }
  }
  return best && bestScore >= SITE_MATCH_THRESHOLD ? best : null;
}

/**
 * Parses a "Mileage" sheet (the FieldPilot-standardized layout: NAME: cell,
 * then day-blocks of Date/Start/Odometer/To/Odometer/Mileage/Daily-sub.
 * rows) already loaded into a raw row-grid (array of row-arrays, 0-indexed
 * columns, dates as real Date objects -- i.e. SheetJS's
 * sheet_to_json(ws, {header:1, raw:true}) with cellDates:true on read, or
 * the equivalent from any other xlsx reader).
 *
 * Quirk found in the real template: the weekday abbreviation ("Mon") and
 * the row's actual Date both live in column A, but on two DIFFERENT rows
 * of the same day-block (the date shows up on the day's second leg row,
 * not its first) -- rather than special-case that, this just tracks
 * whatever real Date it last saw in column A and applies it to every leg
 * row until a newer one appears, which handles that quirk for free.
 *
 * Returns { technicianNameRaw, legs: [{date, fromRaw, toRaw, odometerStart,
 * odometerEnd, claimedMiles}] }. Skips non-leg rows (day-off placeholder
 * rows with numeric 0s, daily-subtotal-only rows, an incomplete trailing
 * row with a Start but no To) automatically, since a real leg row is
 * defined strictly as: Start and To both non-empty strings, Mileage a
 * number.
 */
function extractMileageLegs(grid) {
  let technicianNameRaw = null;
  for (const row of grid) {
    if (row[0] && String(row[0]).trim().toUpperCase() === 'NAME:') {
      technicianNameRaw = String(row[1] || '').trim();
      break;
    }
  }

  const legs = [];
  let currentDate = null;
  for (const row of grid) {
    const a = row[0], b = row[1], c = row[2], d = row[3], e = row[4], f = row[5];

    if (typeof d === 'string' && /TOTAL MILEAGE/i.test(d)) break; // grand-total row -- end of real data

    if (a instanceof Date && !isNaN(a)) currentDate = a;

    const fromRaw = typeof b === 'string' ? b.trim() : '';
    const toRaw = typeof d === 'string' ? d.trim() : '';
    if (fromRaw && toRaw && typeof f === 'number') {
      legs.push({
        date: currentDate ? currentDate.toISOString().slice(0, 10) : null,
        fromRaw,
        toRaw,
        odometerStart: typeof c === 'number' ? c : null,
        odometerEnd: typeof e === 'number' ? e : null,
        claimedMiles: f,
      });
    }
  }
  return { technicianNameRaw, legs };
}

/** Server-side counterpart of the browser's SheetJS parse, for the email
 * attachment path -- same extractMileageLegs logic, fed from the `xlsx`
 * npm package instead of the browser global. Requires `xlsx` as a
 * package.json dependency (added for this feature -- not previously a
 * dependency of this codebase, unlike fast-xml-parser).
 */
function parseMileageWorkbookBuffer(buffer) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = wb.SheetNames.find((n) => /mileage/i.test(n)) || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  return extractMileageLegs(grid);
}

/**
 * Core orchestration, shared by both entry points. `legs` is the
 * already-normalized array extractMileageLegs produces (or the browser's
 * equivalent). Looks up the technician by name, matches every leg's place
 * names to real sites (or home), looks up expected distance, flags
 * outliers, writes one technician_mileage_reports row, and returns the
 * full result for the caller to log/display.
 */
async function evaluateMileageReport(supabase, { technicianNameRaw, legs, payPeriodEnd, source, sourceEmailId, sourceFilename }) {
  const { data: techRow, error: techErr } = await supabase
    .from('technicians')
    .select('id, name, home_state, additional_states, home_address, lat, lng')
    .ilike('name', String(technicianNameRaw || '').trim())
    .maybeSingle();
  if (techErr) throw new Error('Technician lookup failed: ' + techErr.message);

  const states = techRow ? [techRow.home_state, ...(techRow.additional_states || [])].filter(Boolean) : [];
  let candidateSites = [];
  if (states.length) {
    const { data: siteRows, error: siteErr } = await supabase
      .from('sites').select('id, name, lat, lng').in('state', states);
    if (siteErr) throw new Error('Site lookup failed: ' + siteErr.message);
    candidateSites = siteRows || [];
  }

  // Pre-fetch this technician's whole tech_site_distances set, and
  // site_site_distances among just the candidate sites, rather than one
  // query per leg -- a two-week period is rarely more than ~40 legs, but
  // no reason to make 40+ round trips when the whole relevant set is small.
  const MODE_PRIORITY = { driving: 0, 'haversine-fallback': 1, haversine: 2 };
  const pickBest = (rows) => rows.slice().sort((a, b) => (MODE_PRIORITY[a.mode] ?? 9) - (MODE_PRIORITY[b.mode] ?? 9))[0];

  let techSiteDist = {};
  let siteSiteDist = {};
  if (techRow) {
    const { data: t2s } = await supabase
      .from('tech_site_distances').select('site_id, mode, distance_mi').eq('technician_id', techRow.id);
    const bySite = {};
    for (const row of t2s || []) (bySite[row.site_id] = bySite[row.site_id] || []).push(row);
    for (const [siteId, rows] of Object.entries(bySite)) techSiteDist[siteId] = pickBest(rows).distance_mi;
  }
  if (candidateSites.length) {
    const siteIds = candidateSites.map((s) => s.id);
    const { data: s2s } = await supabase
      .from('site_site_distances').select('site_a, site_b, mode, distance_mi')
      .or(`site_a.in.(${siteIds.join(',')}),site_b.in.(${siteIds.join(',')})`);
    const byPair = {};
    for (const row of s2s || []) {
      const k = [row.site_a, row.site_b].sort().join('|');
      (byPair[k] = byPair[k] || []).push(row);
    }
    for (const [k, rows] of Object.entries(byPair)) siteSiteDist[k] = pickBest(rows).distance_mi;
  }
  const siteById = Object.fromEntries(candidateSites.map((s) => [s.id, s]));

  function resolvePlace(rawLabel) {
    if (techRow && isHomeLabel(rawLabel, techRow.home_address)) return { type: 'home' };
    const site = matchSiteByName(rawLabel, candidateSites);
    return site ? { type: 'site', site } : null;
  }

  function expectedMilesFor(fromPlace, toPlace) {
    if (fromPlace.type === 'home' && toPlace.type === 'home') return { miles: 0, type: 'same-place' };
    if (fromPlace.type === 'home' || toPlace.type === 'home') {
      const site = fromPlace.type === 'home' ? toPlace.site : fromPlace.site;
      if (techSiteDist[site.id] != null) return { miles: techSiteDist[site.id], type: 'matrix' };
      if (techRow && techRow.lat != null && site.lat != null) {
        const h = haversineMiles(techRow.lat, techRow.lng, site.lat, site.lng);
        return h != null ? { miles: h, type: 'haversine-fallback' } : null;
      }
      return null;
    }
    const key = [fromPlace.site.id, toPlace.site.id].sort().join('|');
    if (siteSiteDist[key] != null) return { miles: siteSiteDist[key], type: 'matrix' };
    if (fromPlace.site.lat != null && toPlace.site.lat != null) {
      const h = haversineMiles(fromPlace.site.lat, fromPlace.site.lng, toPlace.site.lat, toPlace.site.lng);
      return h != null ? { miles: h, type: 'haversine-fallback' } : null;
    }
    return null;
  }

  const flaggedLegs = [];
  const unmatchedLegs = [];
  let matchedCount = 0;
  let totalClaimed = 0;
  let totalExpected = 0;

  for (const leg of legs) {
    totalClaimed += leg.claimedMiles;
    const fromPlace = resolvePlace(leg.fromRaw);
    const toPlace = resolvePlace(leg.toRaw);
    if (!fromPlace || !toPlace) {
      unmatchedLegs.push({ date: leg.date, fromRaw: leg.fromRaw, toRaw: leg.toRaw, claimedMiles: leg.claimedMiles, reason: 'site_not_matched' });
      continue;
    }
    const expected = expectedMilesFor(fromPlace, toPlace);
    if (!expected) {
      unmatchedLegs.push({ date: leg.date, fromRaw: leg.fromRaw, toRaw: leg.toRaw, claimedMiles: leg.claimedMiles, reason: 'no_distance_data' });
      continue;
    }
    matchedCount++;
    totalExpected += expected.miles;

    let reason = null;
    if (leg.claimedMiles <= 0 && expected.miles > 0.5) reason = 'negative_or_zero';
    else {
      const ratio = leg.claimedMiles / Math.max(expected.miles, 0.5);
      if (ratio > MAX_RATIO || ratio < MIN_RATIO) reason = 'ratio_outlier';
    }
    if (reason) {
      flaggedLegs.push({
        date: leg.date, fromRaw: leg.fromRaw, toRaw: leg.toRaw,
        claimedMiles: leg.claimedMiles,
        expectedMiles: Math.round(expected.miles * 10) / 10,
        expectedSource: expected.type,
        ratio: expected.miles > 0 ? Math.round((leg.claimedMiles / expected.miles) * 100) / 100 : null,
        reason,
      });
    }
  }

  const needsReview = flaggedLegs.length > 0 || (legs.length > 0 && unmatchedLegs.length / legs.length > 0.3) || !techRow;

  const row = {
    technician_id: techRow ? techRow.id : null,
    technician_name_raw: technicianNameRaw || null,
    pay_period_end: payPeriodEnd || null,
    source: source || 'manual_upload',
    source_email_id: sourceEmailId || null,
    source_filename: sourceFilename || null,
    total_legs: legs.length,
    matched_legs: matchedCount,
    total_claimed_miles: Math.round(totalClaimed * 10) / 10,
    total_expected_miles: Math.round(totalExpected * 10) / 10,
    flagged_legs: flaggedLegs,
    unmatched_legs: unmatchedLegs,
    needs_review: needsReview,
  };

  const { data: inserted, error: insertErr } = await supabase
    .from('technician_mileage_reports').insert(row).select().single();
  if (insertErr) throw new Error('Mileage report insert failed: ' + insertErr.message);

  return inserted;
}

module.exports = {
  tokenize, matchSiteByName, isHomeLabel, haversineMiles,
  extractMileageLegs, parseMileageWorkbookBuffer, evaluateMileageReport,
};
