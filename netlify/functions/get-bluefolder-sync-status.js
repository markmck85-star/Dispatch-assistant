/**
 * netlify/functions/get-bluefolder-sync-status.js
 * ======================================================================
 * Read-only status check for bluefolder_service_requests, the staging
 * table bluefolder-service-requests-sync.js writes to (see that file's
 * own header for the full pipeline this belongs to).
 *
 * Built 2026-09-20 because Mark had zero visibility into whether the
 * scheduled sync was actually running -- nothing in the app surfaced it
 * at all, the only way to check was a direct database query. Surfaced in
 * admin.html's Closed Tickets tab, alongside the backfill trigger
 * (bluefolder-service-requests-backfill.js).
 *
 * GET, no params. Returns:
 *   totalRows          count of all rows currently in the staging table
 *   lastSyncedAt        max(synced_at) -- when the sync (scheduled or
 *                       backfill) last actually wrote to this table
 *   earliestClosed/latestClosed
 *                       min/max(date_time_closed) currently on file --
 *                       the real date range of data present right now
 *   needsReviewCount   rows still needing a site match
 */
const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: 'Supabase env vars not configured' });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { count: totalRows, error: countErr } = await supabase
      .from('bluefolder_service_requests')
      .select('id', { count: 'exact', head: true });
    if (countErr) return json(500, { error: 'Row count failed: ' + countErr.message });

    const { count: needsReviewCount, error: reviewErr } = await supabase
      .from('bluefolder_service_requests')
      .select('id', { count: 'exact', head: true })
      .eq('needs_review', true);
    if (reviewErr) return json(500, { error: 'needs_review count failed: ' + reviewErr.message });

    // Postgres has no direct min/max-via-select-count shortcut through
    // supabase-js without a raw aggregate query -- ordering + limit(1) on
    // each end is the simplest reliable way to get both bounds cheaply
    // against an indexed timestamp column at this table's current size.
    const [{ data: latestSyncRow }, { data: latestClosedRow }, { data: earliestClosedRow }] = await Promise.all([
      supabase.from('bluefolder_service_requests').select('synced_at').order('synced_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('bluefolder_service_requests').select('date_time_closed').order('date_time_closed', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('bluefolder_service_requests').select('date_time_closed').order('date_time_closed', { ascending: true }).limit(1).maybeSingle(),
    ]);

    return json(200, {
      ok: true,
      totalRows: totalRows || 0,
      needsReviewCount: needsReviewCount || 0,
      lastSyncedAt: latestSyncRow ? latestSyncRow.synced_at : null,
      earliestClosed: earliestClosedRow ? earliestClosedRow.date_time_closed : null,
      latestClosed: latestClosedRow ? latestClosedRow.date_time_closed : null,
    });
  } catch (err) {
    return json(500, { error: 'Unexpected error: ' + err.message });
  }
};
