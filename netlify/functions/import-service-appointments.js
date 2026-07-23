// import-service-appointments.js
//
// Imports rows from the Salesforce "Completed Service Appointments" report
// (the same export restock tracker already knows how to parse) into the
// site_visits table. Built 2026-07-22 as the foundation for clickable
// location history and per-state dashboards -- site_visits already existed
// with a schema suited for exactly this, but had never been wired up (it
// was originally built for a stalled BlueFolder API effort instead).
//
// Client sends already-parsed rows (parsing happens in the browser via
// SheetJS, same as restock tracker) in batches, since a full report can be
// ~3,000 rows and Netlify functions have a payload/time budget.
//
// Matching strategy:
//   - Site: normalize "STATE - Description" -> Description, tokenize, and
//     find the best token-overlap (Jaccard) match among that state's sites.
//     Real accounts like "GA - Henry County Jonesboro Kroger" vs. the
//     site's actual name "Henry County Kroger Jonesboro" only differ in
//     word order, so this catches the common case cleanly. Anything below
//     a 0.5 overlap score is left unmatched and flagged needs_review rather
//     than guessed -- site_visits' needs_review column exists for exactly
//     this.
//   - Technician: exact case-insensitive name match against the current
//     technicians roster. No fuzzy matching here since names should match
//     exactly if the roster is current (same lesson learned tonight from
//     the OH/NV default-tech stale-name issue -- don't silently guess).
//   - Ticket (optional, for the future auto-close idea): exact match on
//     wo_number against the tickets table. Only sets ticket_id when found;
//     does not change ticket status -- that's a separate future feature.
//
// Dedup: appointment_number is Salesforce's own unique ID for each visit,
// so existing rows are looked up first and skipped rather than upserted,
// making repeated imports over overlapping date ranges safe to re-run.

const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

// Normalizes common abbreviation/full-word variants so token-overlap
// scoring doesn't lose credit purely for phrasing differences between
// Salesforce's Account Name and the real site name. Found 2026-07-23:
// "Fulton Co Kroger Roswell" (real site) vs Salesforce's "Fulton County
// Roswell Kroger" scored lower than the WRONG site "Fulton County Kroger
// State Bridge" purely because "Co" != "County" as raw tokens, even
// though every other word matched -- a real false-positive, not a
// needs_review case, so it slipped through silently instead of being
// flagged. Confirmed live: two techs' visits got attributed to State
// Bridge instead of their real sites (Glenwood, Roswell).
const TOKEN_ALIASES = {
  'co': 'county',
  'cnty': 'county',
  'ave': 'avenue',
  'blvd': 'boulevard',
  'dr': 'drive',
  'rd': 'road',
  'st': 'street',
  'mt': 'mount',
  'hwy': 'highway',
  'pkwy': 'parkway',
};

function tokenize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => TOKEN_ALIASES[t] || t);
}

function stripStatePrefix(accountName) {
  const m = String(accountName || '').trim().match(/^([A-Za-z]{2})\s*-\s*(.+)$/);
  return m ? m[2] : String(accountName || '').trim();
}

function overlapScore(tokensA, tokensB) {
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  const intersection = [...setA].filter((t) => setB.has(t)).length;
  const smaller = Math.min(setA.size, setB.size);
  return smaller > 0 ? intersection / smaller : 0;
}

function matchSite(accountName, state, sitesForState) {
  // Overlap-coefficient (intersection / size of the SHORTER token set), not
  // Jaccard -- confirmed via a broad real-sample check across many states
  // that Jaccard wrongly penalizes cases where the site's actual name in
  // Supabase is longer/more descriptive than Salesforce's short Account
  // Name (e.g. "Sterling Heights SOS" vs. the real site "Sterling Heights
  // - 19 Mile Rd SOS - MI1018 118" -- every word from the short name is
  // present, but Jaccard scores it low for the extra words on the other
  // side). Overlap-coefficient scores that case a clean 1.0 while still
  // correctly rejecting genuine non-matches like "Decatur DMV" against
  // "Decatur K2 - 111" (same city, different site, no real overlap).
  const nameOnly = stripStatePrefix(accountName);
  const targetTokens = tokenize(nameOnly);
  let best = null;
  let bestScore = 0;
  for (const site of sitesForState) {
    const score = overlapScore(targetTokens, tokenize(site.name));
    if (score > bestScore) {
      bestScore = score;
      best = site;
    }
  }
  if (best && bestScore >= 0.65) return { siteId: best.id, matched: true };
  return { siteId: null, matched: false };
}

function parseSalesforceDate(val) {
  // Salesforce exports "Actual Start"/"Actual End" as e.g. "7/22/2026, 6:07 PM"
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'POST only' });

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { ok: false, error: 'Invalid JSON body' });
  }
  const rows = payload.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    return json(400, { ok: false, error: 'No rows provided' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Fetch reference data fresh each call -- sites (761 rows) and
  // technicians (51 rows) are small enough that this is cheap, and it
  // avoids any staleness risk from caching across invocations.
  const [{ data: sites, error: sitesErr }, { data: techs, error: techsErr }] = await Promise.all([
    supabase.from('sites').select('id, name, state'),
    supabase.from('technicians').select('id, name'),
  ]);
  if (sitesErr) return json(500, { ok: false, error: 'sites fetch failed: ' + sitesErr.message });
  if (techsErr) return json(500, { ok: false, error: 'technicians fetch failed: ' + techsErr.message });

  const sitesByState = {};
  for (const s of sites) {
    if (!sitesByState[s.state]) sitesByState[s.state] = [];
    sitesByState[s.state].push(s);
  }
  const techByLowerName = {};
  for (const t of techs) techByLowerName[t.name.trim().toLowerCase()] = t.id;

  // Skip appointment numbers already imported.
  const incomingApptNumbers = rows.map((r) => r.appointmentNumber).filter(Boolean);
  const { data: existing, error: existingErr } = await supabase
    .from('site_visits')
    .select('appointment_number')
    .in('appointment_number', incomingApptNumbers);
  if (existingErr) return json(500, { ok: false, error: 'existing lookup failed: ' + existingErr.message });
  const existingSet = new Set((existing || []).map((r) => r.appointment_number));

  // Look up any open tickets whose wo_number appears in this batch, for
  // opportunistic ticket_id linking (auto-close UI is a future feature --
  // this just wires the data up in advance).
  const incomingWoNumbers = rows.map((r) => r.woNumber).filter(Boolean);
  let ticketByWo = {};
  if (incomingWoNumbers.length) {
    const { data: matchedTickets } = await supabase
      .from('tickets')
      .select('id, wo_number')
      .in('wo_number', incomingWoNumbers);
    for (const t of matchedTickets || []) ticketByWo[t.wo_number] = t.id;
  }

  const toInsert = [];
  const reviewSamples = [];
  let siteMatchedCount = 0;
  let techMatchedCount = 0;
  let needsReviewCount = 0;

  for (const r of rows) {
    if (!r.appointmentNumber || existingSet.has(r.appointmentNumber)) continue;

    const sitesForState = sitesByState[r.state] || [];
    const { siteId, matched } = matchSite(r.accountName, r.state, sitesForState);
    if (matched) siteMatchedCount++;
    else {
      needsReviewCount++;
      if (reviewSamples.length < 25) reviewSamples.push({ state: r.state, accountName: r.accountName });
    }

    const technicianId = r.techName ? techByLowerName[r.techName.trim().toLowerCase()] || null : null;
    if (technicianId) techMatchedCount++;

    const ticketId = r.woNumber ? ticketByWo[r.woNumber] || null : null;

    toInsert.push({
      appointment_number: r.appointmentNumber,
      site_id: siteId,
      account_name_raw: r.accountName,
      state: r.state || null,
      wo_number: r.woNumber || null,
      ticket_id: ticketId,
      started_at: parseSalesforceDate(r.actualStart),
      ended_at: parseSalesforceDate(r.actualEnd),
      duration_min: r.durationMin != null ? r.durationMin : null,
      tech_name_raw: r.techName || null,
      technician_id: technicianId,
      remediation: r.remediation || null,
      remediation_detail: r.remediationDetail || null,
      // is_restock is a Postgres GENERATED ALWAYS column (derived from
      // remediation + remediation_detail) -- omit it, Postgres computes
      // it and rejects any explicit value here.
      included_restock: null,
      included_restock_source: null,
      source: 'salesforce_report',
      needs_review: !matched,
      imported_at: new Date().toISOString(),
    });
  }

  let inserted = 0;
  if (toInsert.length) {
    const { error: insertErr, count } = await supabase
      .from('site_visits')
      .insert(toInsert, { count: 'exact' });
    if (insertErr) return json(500, { ok: false, error: 'insert failed: ' + insertErr.message });
    inserted = count != null ? count : toInsert.length;
  }

  return json(200, {
    ok: true,
    inserted,
    skippedExisting: rows.length - toInsert.length,
    siteMatched: siteMatchedCount,
    techMatched: techMatchedCount,
    needsReview: needsReviewCount,
    reviewSamples,
  });
};
