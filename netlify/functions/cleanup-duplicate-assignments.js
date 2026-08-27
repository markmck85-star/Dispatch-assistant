// cleanup-duplicate-assignments.js — added 2026-08-27
//
// One-off cleanup for the duplicate-assignment bug found live today: when a
// restock first misses its due date (dispatched via the bulk Location-Codes
// path, ticket_id left null) and Neumo later sends a real individual
// maintenance/trouble ticket for that same site, mailgun-inbound.js's
// auto-add-to-board logic only ever checked for a conflict on the NEW
// ticket's own exact date -- it had no way to see the older still-'planned'
// row sitting open on an earlier date, so it inserted a second row instead
// of reusing the first. The live parser is now fixed (see mailgun-inbound.js,
// same date) to absorb an older stale row going forward instead of creating
// a new one -- this script is the one-time cleanup for rows already
// duplicated before that fix existed.
//
// Confirmed live 2026-08-27: ~90 stale rows across 70+ sites, some sites
// carrying 3-5 stale duplicates (e.g. IN1085 had five all pointing at the
// same real ticket-linked entry).
//
// Deliberately conservative: only marks a still-'planned', ticket_id-NULL
// row 'removed' when that SAME site also has at least one OTHER still-
// 'planned' row that DOES have a ticket_id -- i.e. only when there's a real,
// currently-open, ticket-backed entry that already covers the same site.
// A site with only ticket-less 'planned' rows (no ticket-linked sibling at
// all) is left completely untouched -- that's a genuinely still-open,
// unresolved restock, not a duplicate, and this script has no way to tell
// those apart from a real backlog on its own.
//
// GET /.netlify/functions/cleanup-duplicate-assignments?dryRun=true
//   dryRun=true (default false) -- report what WOULD change without writing
//
// -> { ok, sitesAffected, rowsRemoved, samples }

const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const dryRun = params.dryRun === 'true';

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: plannedRows, error: plannedErr } = await supabase
    .from('assignments')
    .select('id, site_id, dispatch_date, ticket_id')
    .eq('status', 'planned');
  if (plannedErr) return json(500, { ok: false, error: 'planned fetch failed: ' + plannedErr.message });

  const bySite = new Map();
  for (const row of plannedRows || []) {
    if (!bySite.has(row.site_id)) bySite.set(row.site_id, []);
    bySite.get(row.site_id).push(row);
  }

  const staleIdsToRemove = [];
  const affectedSiteIds = new Set();
  const samples = [];

  for (const [siteId, rows] of bySite.entries()) {
    const hasTicketLinked = rows.some(r => r.ticket_id);
    if (!hasTicketLinked) continue; // no real covering entry -- leave this site's rows alone entirely

    const staleRows = rows.filter(r => !r.ticket_id);
    if (!staleRows.length) continue; // nothing stale here, nothing to do

    affectedSiteIds.add(siteId);
    for (const stale of staleRows) {
      staleIdsToRemove.push(stale.id);
      if (samples.length < 40) {
        const covering = rows.find(r => r.ticket_id);
        samples.push({
          siteId,
          removedAssignmentId: stale.id,
          removedDispatchDate: stale.dispatch_date,
          coveringDispatchDate: covering.dispatch_date,
        });
      }
    }
  }

  let rowsRemoved = 0;
  if (!dryRun && staleIdsToRemove.length) {
    for (let i = 0; i < staleIdsToRemove.length; i += 200) {
      const chunk = staleIdsToRemove.slice(i, i + 200);
      const { error: updateErr, count } = await supabase
        .from('assignments')
        .update({ status: 'removed', updated_at: new Date().toISOString() })
        .in('id', chunk)
        .eq('status', 'planned') // safety: only touch rows still 'planned' at write time
        .select('id', { count: 'exact', head: true });
      if (updateErr) {
        console.error('[cleanup-duplicate-assignments] update failed for chunk:', updateErr.message);
      } else {
        rowsRemoved += count || 0;
      }
    }
  }

  return json(200, {
    ok: true,
    dryRun,
    sitesAffected: affectedSiteIds.size,
    rowsToRemove: staleIdsToRemove.length,
    rowsRemoved: dryRun ? null : rowsRemoved,
    samples,
  });
};
