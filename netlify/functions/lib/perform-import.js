// lib/perform-import.js
//
// Core "rows -> site_visits" logic, extracted 2026-07-27 from
// import-service-appointments.js so it can be called two ways:
//   1. The existing HTTP handler (manual xlsx upload from state.html)
//   2. salesforce-report-sync.js (the new automated scraper)
// without duplicating the site/tech matching or the per-row insert
// fallback. See import-service-appointments.js for the full history/
// reasoning comments on the matching strategy -- kept there since that's
// still the primary human-facing entry point.

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
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {Array<object>} rows - already mapped to {accountName, state, woNumber,
 *   appointmentNumber, actualStart, actualEnd, durationMin, techName,
 *   remediation, remediationDetail} -- same shape state.html's autoImport builds.
 * @returns {Promise<{inserted:number, skippedExisting:number, siteMatched:number,
 *   techMatched:number, needsReview:number, reviewSamples:Array, rowErrors:Array}>}
 */
async function performImport(supabase, rows) {
  const [{ data: sites, error: sitesErr }, { data: techs, error: techsErr }] = await Promise.all([
    supabase.from('sites').select('id, name, state'),
    supabase.from('technicians').select('id, name'),
  ]);
  if (sitesErr) throw new Error('sites fetch failed: ' + sitesErr.message);
  if (techsErr) throw new Error('technicians fetch failed: ' + techsErr.message);

  const sitesByState = {};
  for (const s of sites) {
    if (!sitesByState[s.state]) sitesByState[s.state] = [];
    sitesByState[s.state].push(s);
  }
  const techByLowerName = {};
  for (const t of techs) techByLowerName[t.name.trim().toLowerCase()] = t.id;

  const incomingApptNumbers = rows.map((r) => r.appointmentNumber).filter(Boolean);
  const existingSet = new Set();
  // Chunk the "already imported?" lookup -- a full scraped report can be
  // ~3,000 appointment numbers in one go (state.html only ever sends 250 at
  // a time), and a single .in() filter that large risks an oversized query.
  for (let i = 0; i < incomingApptNumbers.length; i += 500) {
    const chunk = incomingApptNumbers.slice(i, i + 500);
    const { data: existing, error: existingErr } = await supabase
      .from('site_visits')
      .select('appointment_number')
      .in('appointment_number', chunk);
    if (existingErr) throw new Error('existing lookup failed: ' + existingErr.message);
    for (const r of existing || []) existingSet.add(r.appointment_number);
  }

  const incomingWoNumbers = rows.map((r) => r.woNumber).filter(Boolean);
  let ticketByWo = {};
  for (let i = 0; i < incomingWoNumbers.length; i += 500) {
    const chunk = incomingWoNumbers.slice(i, i + 500);
    if (!chunk.length) continue;
    const { data: matchedTickets } = await supabase
      .from('tickets')
      .select('id, wo_number')
      .in('wo_number', chunk);
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
      included_restock: null,
      included_restock_source: null,
      source: 'salesforce_report',
      needs_review: !matched,
      imported_at: new Date().toISOString(),
    });
  }

  let inserted = 0;
  let rowErrors = [];
  if (toInsert.length) {
    const { error: insertErr, count } = await supabase
      .from('site_visits')
      .insert(toInsert, { count: 'exact' });
    if (!insertErr) {
      inserted = count != null ? count : toInsert.length;
    } else {
      for (const row of toInsert) {
        const { error: rowErr } = await supabase.from('site_visits').insert([row]);
        if (rowErr) {
          let reason = rowErr.message;
          if (/state_fkey|violates foreign key/i.test(rowErr.message)) {
            reason = `state code "${row.state}" not found in the "states" table -- add a row for it there first.`;
          }
          rowErrors.push({
            appointmentNumber: row.appointment_number,
            accountName: row.account_name_raw,
            state: row.state,
            reason,
          });
        } else {
          inserted++;
        }
      }
    }
  }

  return {
    inserted,
    skippedExisting: rows.length - toInsert.length,
    siteMatched: siteMatchedCount,
    techMatched: techMatchedCount,
    needsReview: needsReviewCount,
    reviewSamples,
    rowErrors,
  };
}

module.exports = { performImport, matchSite, tokenize, stripStatePrefix, parseSalesforceDate };
