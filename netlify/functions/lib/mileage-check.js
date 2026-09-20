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

const TOKEN_ALIASES = {
  co: 'county', cnty: 'county', ave: 'avenue', blvd: 'boulevard', dr: 'drive', rd: 'road',
  st: 'street', mt: 'mount', hwy: 'highway', pkwy: 'parkway',
  // 2026-09-20: directional abbreviations ("N. Decatur", "S Cobb" -- both
  // real site names already in this database) previously tokenized to a
  // bare "n"/"s", which almost never overlaps the spelled-out
  // "north"/"south" a technician actually writes -- silently weakening a
  // real match's score for no good reason. Single-letter tokens are
  // unambiguous enough in this context (a site-name word list, not free
  // prose) that this carries negligible risk of misreading something else.
  n: 'north', s: 'south', e: 'east', w: 'west',
};
function tokenize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean).map((t) => TOKEN_ALIASES[t] || t);
}

const MIN_RATIO = 0.4;
const MAX_RATIO = 2.5;
const SITE_MATCH_THRESHOLD = 0.65;

// 2026-09-20: found via a real false positive on Mark's own timesheet --
// "Lawrenceville Suwanee Kroger" (a real place, not yet in `sites` at
// all) scored 0.667 against "Gwinnett County Kroger - Lawrenceville
// Lilburn" (a DIFFERENT, unrelated Kroger) purely because "Lawrenceville"
// and "Kroger" overlapped, even though "Suwanee" and "Lilburn" -- the
// actual distinguishing place names -- share nothing. Generic chain/
// site-type words like "Kroger" or "County" appear in dozens of this
// state's site names and should never be able to carry a match on their
// own; they're down-weighted here (not removed outright, since a real
// match like "State Bridge Kroger" vs "Fulton County Kroger State
// Bridge" should still get a little credit from the shared "Kroger") so
// a match has to be driven by the genuinely distinctive place-name words.
// Scoped to this function only -- other site-matching code elsewhere in
// this app (Salesforce/BlueFolder imports) has its own independent copy
// of this scoring and isn't touched by this fix.
const GENERIC_TERM_WEIGHT = 0.15;
const GENERIC_TERMS = new Set([
  'kroger', 'publix', 'walmart', 'target', 'county', 'cnty', 'co',
  'tag', 'office', 'dmv', 'mv', 'department', 'motor', 'vehicle',
  'tax', 'collector', 'market', 'marketplace', 'store',
]);
function weightedTokenSum(tokens) {
  return tokens.reduce((sum, t) => sum + (GENERIC_TERMS.has(t) ? GENERIC_TERM_WEIGHT : 1), 0);
}

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

/**
 * Best site match for a raw place name, scoped to the given candidate
 * sites. Each site may carry a `.aliases` array (other colloquial names
 * already taught to the system, e.g. via a previous positional
 * resolution or a manually-added one) -- scored the same way as the
 * site's own `.name`, taking the BEST result across name + every alias.
 *
 * 2026-09-20: added per Mark's real example -- a site's real `name` field
 * is often generic or even actively misleading (a site's naming
 * convention frequently follows the STREET it's on rather than the city/
 * county it's actually in -- "Covington Highway Kroger" is really in
 * Lithonia, not Covington), so a technician's own wording can fuzzy-match
 * an ALIAS much better than it ever could the bare site name. Previously
 * aliases only fed the exact-match fast path in evaluateMileageReport;
 * a near-variant of a known alias (a typo, a different word order,
 * dropped punctuation) fell all the way through to matching against just
 * the site's own name, which is exactly the gap that let "Lawrenceville
 * Suwanee Kroger" -- close to an existing alias, not identical to it --
 * go unmatched even with a relevant alias already on file.
 */
function matchSiteByName(rawName, candidateSites) {
  const targetTokens = tokenize(rawName);
  if (!targetTokens.length) return null;
  const targetWeight = weightedTokenSum(targetTokens);
  let best = null, bestScore = 0;
  for (const site of candidateSites) {
    const namesToTry = [site.name, ...(site.aliases || [])];
    for (const candidateName of namesToTry) {
      const siteTokens = tokenize(candidateName);
      const setA = new Set(targetTokens), setB = new Set(siteTokens);
      const intersectionTokens = [...setA].filter((t) => setB.has(t));
      const intersectionWeight = weightedTokenSum(intersectionTokens);
      const siteWeight = weightedTokenSum(siteTokens);
      const smallerWeight = Math.min(targetWeight, siteWeight);
      const overlapScore = smallerWeight > 0 ? intersectionWeight / smallerWeight : 0;
      // 2026-09-20: found via a second real false positive on the SAME
      // technician's file -- a short, generic alias ("Lawrenceville
      // Kroger", for a DIFFERENT, real site) that happens to be a pure
      // SUBSET of a longer target's tokens ("Lawrenceville Suwanee
      // Kroger") scores a perfect 1.0 on the overlap-coefficient above,
      // regardless of how much of the target it actually explains --
      // dividing by the SMALLER side means any short candidate fully
      // contained in a longer name auto-wins, even missing the one word
      // ("Suwanee") that actually distinguishes the real place. Also
      // requiring targetCoverage (how much of what the TECHNICIAN typed
      // this candidate accounts for) to clear the same bar closes this
      // without reopening the original generic-word bug: a genuine short
      // colloquial name (target IS the short side) still scores 1.0/1.0
      // coverage against a longer official name, since coverage is
      // computed against whichever side is actually the technician's own
      // wording -- this only bites when the CANDIDATE is short relative
      // to a longer, more specific target.
      const targetCoverage = targetWeight > 0 ? intersectionWeight / targetWeight : 0;
      const score = Math.min(overlapScore, targetCoverage);
      if (score > bestScore) { bestScore = score; best = site; }
    }
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

  // Two passes, not one: the template shows a day's weekday abbreviation
  // ("Mon") on that day's FIRST leg row, but the real Date value doesn't
  // appear until the SECOND leg row of that same day -- confirmed against
  // the real file (row 16: "Mon"/Johns Creek->Steve Reynolds, no date;
  // row 17: the actual 2026-08-31, on the very next leg). A single
  // top-to-bottom pass that just tracks "the last Date object seen"
  // mis-dates every day's first leg (the home -> first-stop commute) to
  // the PREVIOUS day, silently, since it still had the prior block's date
  // carried over when that first row was processed. Splitting into
  // day-blocks first (new block starts at any weekday-abbreviation row),
  // then resolving each block's real date from whichever row in that same
  // block actually carries it, fixes this for every block uniformly.
  const WEEKDAYS = new Set(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
  const blocks = [];
  let current = null;
  for (const row of grid) {
    const a = row[0];
    const aStr = typeof a === 'string' ? a.trim().toLowerCase() : null;
    if (aStr && WEEKDAYS.has(aStr)) {
      current = { date: null, rows: [] };
      blocks.push(current);
    }
    if (!current) continue; // rows before the first weekday marker (title/NAME rows) -- not part of any day
    current.rows.push(row);
    if (a instanceof Date && !isNaN(a) && !current.date) current.date = a;
  }

  const legs = [];
  outer:
  for (const block of blocks) {
    if (!block.date) continue; // no date ever appeared in this block (shouldn't normally happen, but skip rather than guess)
    const dateStr = block.date.toISOString().slice(0, 10);
    for (const row of block.rows) {
      const b = row[1], c = row[2], d = row[3], e = row[4], f = row[5];
      if (typeof d === 'string' && /TOTAL MILEAGE/i.test(d)) break outer; // grand-total row -- end of real data
      const fromRaw = typeof b === 'string' ? b.trim() : '';
      const toRaw = typeof d === 'string' ? d.trim() : '';
      if (fromRaw && toRaw && typeof f === 'number') {
        legs.push({
          date: dateStr, fromRaw, toRaw,
          odometerStart: typeof c === 'number' ? c : null,
          odometerEnd: typeof e === 'number' ? e : null,
          claimedMiles: f,
        });
      }
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
      .from('sites').select('id, name, site_code, lat, lng').in('state', states);
    if (siteErr) throw new Error('Site lookup failed: ' + siteErr.message);
    candidateSites = siteRows || [];
  }

  // 2026-09-20: colloquial-name fast path. Every technician tends to
  // write a site's name their own way ("Steve Reynolds Kroger" vs the
  // real site name "Gwinnett County Kroger Steve Reynolds") -- token
  // matching handles a lot of that, but not every variant, and definitely
  // not a genuine misspelling. Checking site_aliases FIRST (exact,
  // case-insensitive) catches anything already taught to the system,
  // including aliases THIS function itself writes below once resolved
  // via the closed-ticket report -- so a name that had to be resolved the
  // hard way once is recognized instantly on every later timesheet.
  //
  // Also attaches each site's aliases as `.aliases` so matchSiteByName's
  // fuzzy scoring can try them too, not just the exact-match path above --
  // a site's real `name` is often generic or even misleading (naming
  // frequently follows the street it's on, not the city/county it's
  // actually in -- "Covington Highway Kroger" is really in Lithonia), so
  // a near-variant of a known alias can score far better against that
  // alias than against the bare site name alone.
  let aliasMap = {}; // lowercased alias -> site row
  if (candidateSites.length) {
    const { data: aliasRows } = await supabase
      .from('site_aliases').select('alias, site_id').in('site_id', candidateSites.map((s) => s.id));
    const siteById = Object.fromEntries(candidateSites.map((s) => [s.id, s]));
    for (const s of candidateSites) s.aliases = [];
    for (const a of aliasRows || []) {
      if (siteById[a.site_id]) {
        aliasMap[a.alias.toLowerCase()] = siteById[a.site_id];
        siteById[a.site_id].aliases.push(a.alias);
      }
    }
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

  // 2026-09-21: split out of the old combined resolvePlace -- home/alias
  // checks are unambiguous and free (no DB round trip), so they still run
  // first. Fuzzy name-matching (matchSiteByName) is deliberately NOT
  // called here anymore -- see the precedence rationale below.
  function resolveHomeOrAlias(rawLabel) {
    if (techRow && isHomeLabel(rawLabel, techRow.home_address)) return { type: 'home' };
    const aliasHit = aliasMap[String(rawLabel || '').trim().toLowerCase()];
    return aliasHit ? { type: 'site', site: aliasHit } : null;
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

  // ── Pass 1: home + exact alias only (unambiguous, no guessing) ─────────
  const resolved = legs.map((leg) => ({
    leg,
    fromPlace: resolveHomeOrAlias(leg.fromRaw),
    toPlace: resolveHomeOrAlias(leg.toRaw),
  }));

  // ── Pass 2: position against the closed-ticket report, BEFORE fuzzy
  // ── name-matching is even attempted ─────────────────────────────────
  // 2026-09-21 reordering, per Mark: with many technicians each writing
  // stop names their own way, a naming-based matcher has no real ceiling
  // on how many variations/misspellings it needs to keep learning --
  // every fix so far has been reactive, one technician's timesheet at a
  // time. Position doesn't have that problem: a technician's mileage log
  // for a day is a sequence of real stops, and the closed-ticket report
  // (site_visits) is an INDEPENDENT record of the same day's real
  // visits, in the same real order -- it doesn't care what words anyone
  // used. So position is tried FIRST now, ahead of fuzzy matching, since
  // it's grounded in verified data rather than a probabilistic guess;
  // fuzzy matching is demoted to the last resort, for whatever position
  // genuinely can't reach.
  //
  // The one thing position can't do is replace fuzzy matching entirely:
  // it only works when a day's stop COUNT matches its visit COUNT
  // exactly. A mismatched count (an OTC/testing-station stop that never
  // reaches this report, a sync lag, an errand mixed in) means SOMETHING
  // isn't accounted for, and guessing which stop is the odd one out would
  // risk silently mis-mapping everything after it -- so a mismatched day
  // is skipped for position entirely and falls through to fuzzy matching
  // for every leg on it instead, same as before this reordering.
  const unresolvedLabelsByDate = {};
  for (const r of resolved) {
    if (!r.fromPlace) (unresolvedLabelsByDate[r.leg.date] = unresolvedLabelsByDate[r.leg.date] || new Set()).add(r.leg.fromRaw);
    if (!r.toPlace) (unresolvedLabelsByDate[r.leg.date] = unresolvedLabelsByDate[r.leg.date] || new Set()).add(r.leg.toRaw);
  }
  const datesNeedingLookup = Object.keys(unresolvedLabelsByDate).filter(Boolean).sort();

  const labelToResolvedSite = {}; // `${date}|${rawLabel}` -> site row
  const resolvedViaClosedTickets = [];
  if (techRow && datesNeedingLookup.length) {
    const { data: visitRows, error: visitErr } = await supabase
      .from('site_visits')
      .select('site_id, started_at, sites(id, name, site_code, lat, lng)')
      .eq('technician_id', techRow.id)
      .gte('started_at', datesNeedingLookup[0] + 'T00:00:00Z')
      .lte('started_at', datesNeedingLookup[datesNeedingLookup.length - 1] + 'T23:59:59Z')
      .order('started_at', { ascending: true });
    if (visitErr) console.error('[mileage-check] site_visits lookup failed (non-fatal, falls through to fuzzy matching):', visitErr.message);

    const visitsByDate = {};
    for (const v of visitRows || []) {
      const d = String(v.started_at).slice(0, 10);
      (visitsByDate[d] = visitsByDate[d] || []).push(v);
    }

    for (const date of datesNeedingLookup) {
      // This date's real stop sequence, as WRITTEN in the log (every
      // leg's destination, home excluded) -- independent of whether each
      // one already resolved in pass 1.
      const dayLegs = legs.filter((l) => l.date === date);
      const stops = dayLegs.map((l) => l.toRaw).filter((label) => !(techRow && isHomeLabel(label, techRow.home_address)));
      const visits = visitsByDate[date] || [];
      if (stops.length === 0 || stops.length !== visits.length) continue; // count mismatch -- skip this date entirely

      stops.forEach((label, i) => {
        if (!unresolvedLabelsByDate[date].has(label)) return; // already resolved in pass 1 -- don't touch
        const site = visits[i].sites;
        if (!site) return;
        const key = `${date}|${label}`;
        if (labelToResolvedSite[key]) return; // already resolved this label for this date
        labelToResolvedSite[key] = site;
        resolvedViaClosedTickets.push({ date, rawLabel: label, resolvedSiteCode: site.site_code, resolvedSiteName: site.name });
      });
    }

    // Apply resolutions back onto pass-1 results.
    for (const r of resolved) {
      if (!r.fromPlace) {
        const site = labelToResolvedSite[`${r.leg.date}|${r.leg.fromRaw}`];
        if (site) r.fromPlace = { type: 'site', site };
      }
      if (!r.toPlace) {
        const site = labelToResolvedSite[`${r.leg.date}|${r.leg.toRaw}`];
        if (site) r.toPlace = { type: 'site', site };
      }
    }
  }

  // ── Pass 3: fuzzy name-matching, now genuinely the last resort -- only
  // ── for whatever neither the alias table nor position could reach ────
  for (const r of resolved) {
    if (!r.fromPlace) {
      const site = matchSiteByName(r.leg.fromRaw, candidateSites);
      if (site) r.fromPlace = { type: 'site', site };
    }
    if (!r.toPlace) {
      const site = matchSiteByName(r.leg.toRaw, candidateSites);
      if (site) r.toPlace = { type: 'site', site };
    }
  }

  // Teach these back to site_aliases so the NEXT timesheet recognizes the
  // name instantly via the fast path above, instead of needing the
  // closed-ticket report every time. Never overwrites an existing alias
  // that already points somewhere else -- that's a real conflict worth a
  // human look, not something to silently resolve either direction.
  const aliasConflicts = [];
  for (const [key, site] of Object.entries(labelToResolvedSite)) {
    const rawLabel = key.slice(key.indexOf('|') + 1);
    if (aliasMap[rawLabel.toLowerCase()]) continue; // already known (shouldn't normally happen given the check above, but safe)
    const { data: existing } = await supabase
      .from('site_aliases').select('site_id').eq('alias', rawLabel).maybeSingle();
    if (existing) {
      if (existing.site_id !== site.id) aliasConflicts.push({ rawLabel, existingSiteId: existing.site_id, resolvedSiteCode: site.site_code });
      continue;
    }
    const { error: aliasInsertErr } = await supabase
      .from('site_aliases').insert({ alias: rawLabel, site_id: site.id, source: 'mileage_timesheet' });
    if (aliasInsertErr) console.error(`[mileage-check] alias write failed for "${rawLabel}" (non-fatal):`, aliasInsertErr.message);
    else aliasMap[rawLabel.toLowerCase()] = site; // so later legs in this same run also benefit
  }

  // ── Score every leg against its (now possibly pass-2-resolved) places ──
  const flaggedLegs = [];
  const unmatchedLegs = [];
  let matchedCount = 0;
  let totalClaimed = 0;
  let totalExpected = 0;

  for (const { leg, fromPlace, toPlace } of resolved) {
    totalClaimed += leg.claimedMiles;
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

  const needsReview = flaggedLegs.length > 0 || aliasConflicts.length > 0
    || (legs.length > 0 && unmatchedLegs.length / legs.length > 0.3) || !techRow;

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
    resolved_via_closed_tickets: resolvedViaClosedTickets,
    needs_review: needsReview,
  };

  const { data: inserted, error: insertErr } = await supabase
    .from('technician_mileage_reports').insert(row).select().single();
  if (insertErr) throw new Error('Mileage report insert failed: ' + insertErr.message);

  if (aliasConflicts.length) {
    console.warn('[mileage-check] alias conflicts needing manual review:', JSON.stringify(aliasConflicts));
  }

  return inserted;
}

module.exports = {
  tokenize, matchSiteByName, isHomeLabel, haversineMiles,
  extractMileageLegs, parseMileageWorkbookBuffer, evaluateMileageReport,
};
