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

function matchSite(accountName, state, sitesForState, aliasMap) {
  // Exact alias match first (built from confirmed corrections -- see
  // site_aliases table) -- these are known-correct mappings for account
  // names that fuzzy matching gets wrong (e.g. Neumo's internal label for
  // a site not matching that site's real current display name).
  const aliasSiteId = aliasMap[String(accountName || '').trim()];
  if (aliasSiteId) return { siteId: aliasSiteId, matched: true, matchSource: 'alias' };

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
  if (best && bestScore >= 0.65) return { siteId: best.id, matched: true, matchSource: 'text' };
  return { siteId: null, matched: false, matchSource: null };
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
  const [{ data: sites, error: sitesErr }, { data: techs, error: techsErr }, { data: aliases, error: aliasesErr }] = await Promise.all([
    supabase.from('sites').select('id, name, state'),
    supabase.from('technicians').select('id, name'),
    supabase.from('site_aliases').select('alias, site_id'),
  ]);
  if (sitesErr) throw new Error('sites fetch failed: ' + sitesErr.message);
  if (techsErr) throw new Error('technicians fetch failed: ' + techsErr.message);
  if (aliasesErr) throw new Error('site_aliases fetch failed: ' + aliasesErr.message);

  const aliasMap = {};
  for (const a of aliases || []) aliasMap[a.alias] = a.site_id;

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
      .select('id, wo_number, site_id')
      .in('wo_number', chunk);
    for (const t of matchedTickets || []) ticketByWo[t.wo_number] = t;
  }

  const toInsert = [];
  const reviewSamples = [];
  let siteMatchedCount = 0;
  let techMatchedCount = 0;
  let needsReviewCount = 0;
  // 2026-08-06: WO-matched tickets get auto-closed and their board
  // assignment auto-completed below, once the closed-ticket report
  // confirms the work actually happened -- see the update block after the
  // site_visits insert for why.
  const ticketIdsToClose = new Set();
  // 2026-08-12: paired with the site_visits.ticket_id backfill below --
  // see the comment inside the loop for why this is needed alongside
  // ticketIdsToClose.
  const appointmentToTicketId = [];

  for (const r of rows) {
    if (!r.appointmentNumber) continue;

    // 2026-08-12 fix: this WO-number ticket-close check now runs for EVERY
    // row with an appointment number, BEFORE the already-imported skip
    // below -- not just newly-inserted rows. Root cause found the same day:
    // a completion row can land in Salesforce's export before the matching
    // trouble-ticket EMAIL has created its own `tickets` row (email/report
    // timing isn't guaranteed to be in order). On that first import,
    // ticketByWo[r.woNumber] finds nothing, so the ticket never closes --
    // and because the row is now in existingSet, every subsequent
    // re-import (even a fully up-to-date one) skipped straight past it via
    // the old `continue` before ever getting a second chance to check
    // whether a matching ticket now exists. Confirmed live: WO 00149242
    // (FL1067, Palm Beach County Southern Publix) sat correctly in the
    // report ("22953 already on file") through multiple re-imports while
    // its ticket stayed open the whole time. Moving this check ahead of
    // the skip means every re-import re-attempts the WO match for every
    // row, closing tickets whose completion arrived out of order relative
    // to their own creation, however long ago that completion was first
    // imported.
    const linkedTicket = r.woNumber ? ticketByWo[r.woNumber] : null;
    if (linkedTicket) ticketIdsToClose.add(linkedTicket.id);

    // 2026-08-12, same session as the fix above: get-state-console.js's
    // Open/Closed label does NOT read tickets.status at all -- it
    // independently checks whether a site_visits row's ticket_id is
    // populated (see that file's own comments: closedOn is derived purely
    // from site_visits, deliberately not tickets.status). So the fix above
    // makes the WATCHDOG log correct (it reads tickets.status), but the
    // STATE CONSOLE stayed blind to the exact same class of ticket: a
    // site_visits row inserted on an earlier import, before its matching
    // ticket existed yet, has ticket_id permanently NULL -- nothing ever
    // went back and linked it after the fact, even once the ticket showed
    // up and even after today's tickets.status fix. Track every
    // appointment-number -> ticket-id pair with a real WO match here
    // (regardless of whether the row is new or already-imported), then
    // batch-backfill site_visits.ticket_id for the already-imported ones
    // after the main insert below.
    if (linkedTicket && r.appointmentNumber) {
      appointmentToTicketId.push({ appointment_number: r.appointmentNumber, ticket_id: linkedTicket.id });
    }

    if (existingSet.has(r.appointmentNumber)) continue;

    // 2026-08-04: prefer a WO-number-matched ticket's already-resolved
    // site_id over fuzzy text matching whenever available. This is the
    // most authoritative source there is -- Salesforce itself already
    // resolved that specific ticket to a specific site, which sidesteps
    // the one real known gap in text-based matching: locations with 2+
    // co-located machines (e.g. "Arapahoe County Aurora 2"), where the
    // closed-ticket report's free-text description doesn't say which
    // specific unit was serviced, so name-only matching can lump a
    // busy site's later machines onto whichever one matches first.
    let siteId, matched, matchSource;
    if (linkedTicket && linkedTicket.site_id) {
      siteId = linkedTicket.site_id;
      matched = true;
      matchSource = 'wo_number';
    } else {
      const sitesForState = sitesByState[r.state] || [];
      ({ siteId, matched, matchSource } = matchSite(r.accountName, r.state, sitesForState, aliasMap));
    }
    if (matched) siteMatchedCount++;
    else {
      needsReviewCount++;
      if (reviewSamples.length < 25) reviewSamples.push({ state: r.state, accountName: r.accountName });
    }

    const technicianId = r.techName ? techByLowerName[r.techName.trim().toLowerCase()] || null : null;
    if (technicianId) techMatchedCount++;

    const ticketId = linkedTicket ? linkedTicket.id : null;

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

  // 2026-08-12: backfill site_visits.ticket_id for rows that already
  // existed from an earlier import but whose ticket didn't exist yet at
  // that time -- see the comment inside the main loop above.
  //
  // v2, same session: the first version of this used .upsert(chunk,
  // { onConflict: 'appointment_number' }), which requires a matching
  // UNIQUE constraint on that column to work at all. site_visits almost
  // certainly doesn't have one -- the insert-dedup above relies on a
  // separate SELECT + JS-side existingSet check instead of a DB-level
  // onConflict the way mailgun-inbound.js does for tickets.wo_number,
  // which is a strong tell there's no such constraint here. That upsert
  // was silently failing every call (error caught and logged server-side
  // only, invisible to Mark), backfilling nothing while the import still
  // reported success -- confirmed live: a full redeploy + reimport + wait
  // produced zero change on the state console. Switched to plain
  // row-by-row .update().eq('appointment_number', ...) instead -- needs
  // no constraint, and is safer besides: update can only ever touch a
  // row that already exists, where upsert risks silently inserting a
  // malformed new row (missing every other required column) if a match
  // ever unexpectedly fails.
  let ticketIdsBackfilled = 0;
  for (const { appointment_number, ticket_id } of appointmentToTicketId) {
    const { error: backfillErr, count: backfillCount } = await supabase
      .from('site_visits')
      .update({ ticket_id })
      .eq('appointment_number', appointment_number)
      .is('ticket_id', null)
      .select('id', { count: 'exact', head: true });
    if (backfillErr) {
      console.error(`[perform-import] site_visits.ticket_id backfill failed for ${appointment_number}:`, backfillErr.message);
    } else {
      ticketIdsBackfilled += backfillCount || 0;
    }
  }

  let ticketsClosed = 0;
  let assignmentsCompleted = 0;
  if (ticketIdsToClose.size) {
    // 2026-08-06: Mark asked for this after noticing that updating the
    // closed-ticket report correctly refreshed ticket STATUS everywhere
    // it's displayed (state console, the site-history popup) but never
    // touched the actual board STOP -- so a completed ticket kept sitting
    // on the active board with its urgency badge still drawing attention,
    // and had to be manually clicked "Done" to move to the completed
    // list at the bottom, even though the closed-ticket report already
    // proved the work was done. This closes that gap: any ticket whose
    // WO number matched a closed-ticket report row this import gets
    // marked closed, and its board assignment (if still 'planned', i.e.
    // not already completed/removed/reassigned some other way) gets
    // flipped to 'completed' the same way clicking "Done" would --
    // without needing anyone to notice and click through it by hand.
    const ticketIdList = [...ticketIdsToClose];
    const { error: ticketCloseErr, count: ticketCloseCount } = await supabase
      .from('tickets')
      .update({ status: 'closed' })
      .in('id', ticketIdList)
      .neq('status', 'closed')
      .select('id', { count: 'exact', head: true });
    if (ticketCloseErr) {
      console.error('[perform-import] auto-close tickets failed:', ticketCloseErr.message);
    } else {
      ticketsClosed = ticketCloseCount || 0;
    }

    const { error: assignmentErr, count: assignmentCount } = await supabase
      .from('assignments')
      .update({ status: 'completed' })
      .in('ticket_id', ticketIdList)
      .eq('status', 'planned')
      .select('id', { count: 'exact', head: true });
    if (assignmentErr) {
      console.error('[perform-import] auto-complete assignments failed:', assignmentErr.message);
    } else {
      assignmentsCompleted = assignmentCount || 0;
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
    ticketsClosed,
    assignmentsCompleted,
    ticketIdsBackfilled,
  };
}

module.exports = { performImport, matchSite, tokenize, stripStatePrefix, parseSalesforceDate };
