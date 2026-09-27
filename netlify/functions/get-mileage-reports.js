/**
 * netlify/functions/get-mileage-reports.js
 * ======================================================================
 * Lists recent technician_mileage_reports rows for the Admin Panel's
 * Mileage Check tab. Read-only. GET ?limit=50 (default 50, max 100).
 *
 * 2026-09-27: two changes, per Mark --
 *   1. Added day_summaries/history_comparison to the select list -- the
 *      new day-total and period-vs-history checks write these, but this
 *      endpoint never returned them, so mileage.html's new display for
 *      both was silently getting undefined no matter what the backend
 *      computed.
 *   2. Default limit raised 25 -> 50 (Mark's own estimate of a typical
 *      biweekly batch size), and results are now re-sorted by a rough
 *      severity score before returning, worst-looking first -- with
 *      dozens of reports landing at once, Mike shouldn't have to scroll
 *      past a page of clean ones to find the two that need him. This is
 *      a JS re-sort of whatever the query already fetched (ordered by
 *      processed_at first), not a database-level ORDER BY on a computed
 *      value -- fine at this scale; would need a real computed/indexed
 *      column if this list ever needs to page past ~100.
 */
const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

// Higher score = more worth a look. Deliberately rough -- this exists to
// order a list for a human to skim top-down, not to produce a precise
// ranking. Weighted roughly by how strong a signal each thing is: a
// period that looks unusual for THIS tech specifically (history) or a
// technician name that didn't even resolve are both stronger signals
// than a single flagged leg, which itself is stronger than a run of
// unmatched (usually just unlearned) stop names.
function severityScore(r) {
  const flaggedCount = (r.flagged_legs || []).length;
  const clusterCount = (r.flagged_legs || []).filter((f) => f.cluster).length;
  const dayFlagCount = (r.day_summaries || []).filter((d) => d.flagged).length;
  const historyFlagged = r.history_comparison && r.history_comparison.flagged ? 1 : 0;
  const noTech = r.technician_id ? 0 : 1;
  const unmatchedRatio = r.total_legs > 0 ? (r.unmatched_legs || []).length / r.total_legs : 0;
  return flaggedCount * 3 + clusterCount * 2 + dayFlagCount * 4 + historyFlagged * 6 + noTech * 10 + unmatchedRatio * 2;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: 'Supabase env vars not configured' });
  }

  const params = event.queryStringParameters || {};
  const limit = Math.min(parseInt(params.limit, 10) || 50, 100);

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await supabase
      .from('technician_mileage_reports')
      .select('id, technician_id, technician_name_raw, pay_period_end, source, source_filename, total_legs, matched_legs, total_claimed_miles, total_expected_miles, flagged_legs, unmatched_legs, day_summaries, history_comparison, needs_review, processed_at, technicians(name)')
      .order('processed_at', { ascending: false })
      .limit(limit);
    if (error) return json(500, { error: error.message });

    const reports = (data || [])
      .map((r) => ({
        ...r,
        technicianName: r.technicians ? r.technicians.name : r.technician_name_raw,
        technicians: undefined,
      }));
    reports.sort((a, b) => severityScore(b) - severityScore(a)); // stable sort -- ties keep their processed_at-desc order

    return json(200, { ok: true, reports });
  } catch (err) {
    return json(500, { error: err.message || 'Unexpected error' });
  }
};
