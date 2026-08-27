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

// Neumo's closed-ticket report gives Actual Start/End as plain
// "M/D/YYYY, h:mm AM/PM" strings with NO timezone marker -- these are
// Eastern wall-clock times (Neumo/MCR both operate on Eastern), but a bare
// `new Date(val)` on a server running in UTC (Netlify functions do) was
// silently treating that string AS IF it were already UTC, storing a value
// 4-5 hours off (depending on daylight saving) from the real moment. Found
// 2026-08-21 via two independent exact-4-hour matches between the raw
// report and the app's display (both during EDT). getEasternOffsetMinutes
// uses Intl's real America/New_York timezone data to get the correct
// UTC offset for the specific date in question, so this stays correct
// across the EST/EDT boundary rather than hardcoding either one.
function getEasternOffsetMinutes(date) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = dtf.formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const asIfUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return (asIfUTC - date.getTime()) / 60000;
}

// 2026-08-23: used by the new site_id+dispatch_date assignment-completion
// match below -- turns an already-corrected ISO timestamp (from
// parseSalesforceDate) into a plain "YYYY-MM-DD" Eastern calendar date, so
// it can be compared directly against assignments.dispatch_date (a plain
// `date` column, no time component). Reuses America/New_York the same way
// getEasternOffsetMinutes does, so this stays correct across the EST/EDT
// boundary too.
function easternDateOnly(isoString) {
  if (!isoString) return null;
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return null;
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = dtf.formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function parseSalesforceDate(val) {
  if (!val) return null;
  const m = String(val).match(/(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) {
    // Fallback for any format that isn't the plain Neumo export shape --
    // e.g. an already-ISO string with its own explicit offset, which
    // new Date() handles correctly on its own.
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  let [, mo, da, yr, hr, mi, ap] = m;
  hr = parseInt(hr, 10);
  if (/pm/i.test(ap) && hr !== 12) hr += 12;
  if (/am/i.test(ap) && hr === 12) hr = 0;
  const naiveUTC = Date.UTC(+yr, +mo - 1, +da, hr, +mi);
  const offsetMinutes = getEasternOffsetMinutes(new Date(naiveUTC));
  const trueUTC = naiveUTC - offsetMinutes * 60000;
  return new Date(trueUTC).toISOString();
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
  // 2026-08-23: also capture site_id/started_at for already-imported rows,
  // not just the appointment_number used for the skip check below -- the
  // new site+date completion pass needs to re-evaluate EVERY row on every
  // re-import (same reason as the 2026-08-12 ticket_id fix a few lines
  // down: a row already sitting in site_visits from a past import must
  // still get a chance to complete its assignment, not just brand-new
  // rows). Re-using the site_id already resolved and stored on that past
  // insert is both simpler and more correct than re-running matchSite().
  const existingRowInfo = new Map();
  // Chunk the "already imported?" lookup -- a full scraped report can be
  // ~3,000 appointment numbers in one go (state.html only ever sends 250 at
  // a time), and a single .in() filter that large risks an oversized query.
  for (let i = 0; i < incomingApptNumbers.length; i += 500) {
    const chunk = incomingApptNumbers.slice(i, i + 500);
    const { data: existing, error: existingErr } = await supabase
      .from('site_visits')
      .select('appointment_number, site_id, started_at')
      .in('appointment_number', chunk);
    if (existingErr) throw new Error('existing lookup failed: ' + existingErr.message);
    for (const r of existing || []) {
      existingSet.add(r.appointment_number);
      existingRowInfo.set(r.appointment_number, { site_id: r.site_id, started_at: r.started_at });
    }
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
  const insertedSamples = []; // for the Refresh Now progress display, so a dispatcher watching can confirm a specific ticket landed without hunting the list above
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
  // 2026-08-23: ticketIdsToClose/ticket_id-matching above only ever catches
  // assignments dispatched through the individual single-ticket flow
  // (singleTicketWo/window.ticketMeta) -- the vast majority of daily
  // volume, routine restocks sent through the bulk Location-Codes paste,
  // never gets assignments.ticket_id set at all, so those planned stops
  // were silently never auto-completing. Confirmed live via Supabase:
  // whole days of no-ticket planned assignments (15 on 8/20, 33 on 8/21)
  // sitting stuck while ticket-linked ones on the same days completed
  // normally. Fix: also collect {site_id, visit_date} for every row that
  // resolved to a real site, and complete any 'planned' assignment that
  // exact-matches on site_id + dispatch_date below. Confirmed via a live
  // data check that site_id+dispatch_date is unique among planned
  // assignments (no site ever has two planned stops the same day), and
  // that real same-day matches exist (day_diff 0) when the completion is
  // actually in this import -- so an EXACT date match is safe here; a
  // fuzzy/nearest-date match would not be, since stale planned rows for
  // the same site can span weeks and a loose match could complete the
  // wrong day's stop.
  const siteDateCompletions = [];

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

    // 2026-08-23: reaches the actual backlog -- a row already imported on
    // a past sync (before this completion pass existed) still needs a
    // chance to complete its assignment on THIS re-import. Use its
    // already-stored site_id/started_at directly rather than falling
    // through to the fresh-match logic below, which only runs for rows
    // that make it past the skip on the next line.
    if (existingSet.has(r.appointmentNumber)) {
      const info = existingRowInfo.get(r.appointmentNumber);
      if (info && info.site_id && info.started_at) {
        const visitDate = easternDateOnly(info.started_at);
        if (visitDate) siteDateCompletions.push({ site_id: info.site_id, visit_date: visitDate });
      }
      continue;
    }

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

    if (insertedSamples.length < 25) {
      insertedSamples.push({ accountName: r.accountName, state: r.state, woNumber: r.woNumber, appointmentNumber: r.appointmentNumber, matched });
    }

    const startedAtIso = parseSalesforceDate(r.actualStart);
    // 2026-08-23: this is the NEW-row half of the site+date completion
    // candidate list -- the already-imported half is pushed above, before
    // the existingSet skip. Only queue a candidate when this row actually
    // resolved to a real site and has a usable completion date -- an
    // unmatched site (needs_review) or a missing/unparseable actualStart
    // must never produce a phantom match.
    if (matched && siteId && startedAtIso) {
      const visitDate = easternDateOnly(startedAtIso);
      if (visitDate) siteDateCompletions.push({ site_id: siteId, visit_date: visitDate });
    }

    toInsert.push({
      appointment_number: r.appointmentNumber,
      site_id: siteId,
      account_name_raw: r.accountName,
      state: r.state || null,
      wo_number: r.woNumber || null,
      ticket_id: ticketId,
      started_at: startedAtIso,
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

  // 2026-08-23, REVISED 2026-08-27: second, independent auto-complete pass
  // covering the no-ticket bulk-restock case -- see the siteDateCompletions
  // comment above for why this exists.
  //
  // The original 2026-08-23 version required an EXACT match between a
  // planned assignment's dispatch_date and the real visit's Eastern
  // calendar date. Reconfirmed live 2026-08-26 that this almost never
  // fires: pulling real (dispatch_date, started_at) pairs for GA showed
  // the gap between a site being dispatched and the tech actually doing
  // the restock is routinely 1-5+ days (route backlog/bunching), not
  // same-day -- e.g. GA1077 dispatched 8/6 -> completed 8/11 (5-day gap),
  // dispatched 8/24 -> completed 8/25 (1-day gap). An exact match only
  // ever caught the rare same-day case, so the vast majority of real
  // bulk-restock completions kept sitting "planned" forever, exactly the
  // original bug this pass was meant to fix.
  //
  // New approach: FIFO per site. A site's planned dispatches queue up in
  // order, and its real completions also happen in roughly that same
  // order (oldest dispatched restock gets done first) -- so for each
  // site, sort its still-planned assignments by dispatch_date ascending,
  // sort this batch's real completion dates for that site ascending, and
  // walk both lists together: the oldest planned assignment is completed
  // by the earliest available real visit that happened ON OR AFTER it
  // (a visit can't complete a dispatch that hasn't happened yet), each
  // visit consumed at most once. Any planned assignment left over when
  // the visits run out (dispatch_date newer than every available
  // completion) is correctly left open rather than force-matched.
  let assignmentsCompletedBySiteDate = 0;
  const visitDatesBySite = new Map();
  for (const { site_id, visit_date } of siteDateCompletions) {
    if (!visitDatesBySite.has(site_id)) visitDatesBySite.set(site_id, new Set());
    visitDatesBySite.get(site_id).add(visit_date);
  }
  const siteIdsWithVisits = [...visitDatesBySite.keys()];
  for (let i = 0; i < siteIdsWithVisits.length; i += 200) {
    const chunk = siteIdsWithVisits.slice(i, i + 200);
    const { data: plannedRows, error: plannedErr } = await supabase
      .from('assignments')
      .select('id, site_id, dispatch_date')
      .in('site_id', chunk)
      .eq('status', 'planned')
      .order('dispatch_date', { ascending: true });
    if (plannedErr) {
      console.error('[perform-import] site/date auto-complete: planned-assignment lookup failed:', plannedErr.message);
      continue;
    }
    const plannedBySite = new Map();
    for (const row of plannedRows || []) {
      if (!plannedBySite.has(row.site_id)) plannedBySite.set(row.site_id, []);
      plannedBySite.get(row.site_id).push(row);
    }
    const idsToComplete = [];
    for (const site_id of chunk) {
      const visitDates = [...(visitDatesBySite.get(site_id) || [])].sort();
      const plannedList = plannedBySite.get(site_id) || [];
      let visitPtr = 0;
      for (const assignment of plannedList) {
        while (visitPtr < visitDates.length && visitDates[visitPtr] < assignment.dispatch_date) {
          visitPtr++;
        }
        if (visitPtr >= visitDates.length) break; // no more real completions available for this site in this batch
        idsToComplete.push(assignment.id);
        visitPtr++; // this visit is now consumed, can't also close a later assignment
      }
    }
    if (idsToComplete.length) {
      const { error: siteDateErr, count: siteDateCount } = await supabase
        .from('assignments')
        .update({ status: 'completed' })
        .in('id', idsToComplete)
        .eq('status', 'planned')
        .select('id', { count: 'exact', head: true });
      if (siteDateErr) {
        console.error('[perform-import] site/date auto-complete update failed:', siteDateErr.message);
      } else {
        assignmentsCompletedBySiteDate += siteDateCount || 0;
      }
    }
  }
  assignmentsCompleted += assignmentsCompletedBySiteDate;

  return {
    inserted,
    skippedExisting: rows.length - toInsert.length,
    siteMatched: siteMatchedCount,
    techMatched: techMatchedCount,
    needsReview: needsReviewCount,
    reviewSamples,
    // Rows are sampled when queued, before we know whether the actual
    // insert call succeeds -- pruning out anything that ended up in
    // rowErrors keeps this list accurate even in the rare case a row
    // fails at the database level after being queued.
    insertedSamples: insertedSamples.filter(
      (s) => !rowErrors.some((e) => e.appointmentNumber === s.appointmentNumber)
    ),
    rowErrors,
    ticketsClosed,
    assignmentsCompleted,
    // 2026-08-23: assignmentsCompleted above is now the COMBINED total from
    // both the ticket_id pass and this new pass; this breakout is just for
    // visibility (e.g. on the Refresh Now progress display) into how many
    // of today's completions were bulk-restock stops that the old
    // ticket_id-only logic would have missed entirely.
    assignmentsCompletedBySiteDate,
    ticketIdsBackfilled,
  };
}

module.exports = { performImport, matchSite, tokenize, stripStatePrefix, parseSalesforceDate, easternDateOnly };
