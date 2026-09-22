// get-bluefolder-requests.js
//
// Read-only list/search over bluefolder_service_requests, the staging
// table filled by bluefolder-service-requests-sync.js (daily) and
// bluefolder-service-requests-backfill.js (manual chunks).
//
// These rows are NOT automatically written onto sites / site_visits.
// site_id is almost always null; needs_review stays true until a separate
// matching pass links a BlueFolder location name/address to a sites row.

const { createClient } = require('@supabase/supabase-js');

const PAGE_SIZE = 40;

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: 'Supabase env vars not configured' });
  }

  const params = event.queryStringParameters || {};
  const state = (params.state || '').trim().toUpperCase();
  const q = (params.q || '').trim();
  const match = (params.match || 'all').toLowerCase(); // all | matched | unmatched
  const from = (params.from || '').trim();
  const to = (params.to || '').trim();
  const offset = Math.max(0, parseInt(params.offset || '0', 10) || 0);

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  let query = supabase
    .from('bluefolder_service_requests')
    .select(
      'id, service_request_id, customer_name, customer_location_id, customer_location_name, customer_location_street_address, customer_location_city, customer_location_state, customer_location_postal_code, description, detailed_description, status, type, priority, date_time_created, date_time_closed, external_id, site_id, needs_review, synced_at, sites(name, site_code, state)',
      { count: 'exact' }
    )
    .order('date_time_closed', { ascending: false, nullsFirst: false })
    .range(offset, offset + PAGE_SIZE - 1);

  if (state) query = query.ilike('customer_location_state', state);
  if (match === 'matched') query = query.not('site_id', 'is', null);
  if (match === 'unmatched') query = query.is('site_id', null);
  if (from) query = query.gte('date_time_closed', from + 'T00:00:00.000Z');
  if (to) query = query.lte('date_time_closed', to + 'T23:59:59.999Z');
  if (q) {
    const safe = q.replace(/,/g, ' ');
    query = query.or(
      [
        `customer_location_name.ilike.%${safe}%`,
        `customer_location_city.ilike.%${safe}%`,
        `customer_location_street_address.ilike.%${safe}%`,
        `description.ilike.%${safe}%`,
        `detailed_description.ilike.%${safe}%`,
        `service_request_id.ilike.%${safe}%`,
        `external_id.ilike.%${safe}%`,
        `customer_name.ilike.%${safe}%`,
      ].join(',')
    );
  }

  const { data, error, count } = await query;
  if (error) return json(500, { ok: false, error: error.message });

  const rows = (data || []).map((r) => ({
    id: r.id,
    serviceRequestId: r.service_request_id,
    customerName: r.customer_name,
    locationId: r.customer_location_id,
    locationName: r.customer_location_name,
    address: r.customer_location_street_address,
    city: r.customer_location_city,
    state: r.customer_location_state,
    postalCode: r.customer_location_postal_code,
    description: r.description,
    note: r.detailed_description,
    status: r.status,
    type: r.type,
    priority: r.priority,
    createdAt: r.date_time_created,
    closedAt: r.date_time_closed,
    externalId: r.external_id,
    siteId: r.site_id,
    needsReview: r.needs_review,
    syncedAt: r.synced_at,
    siteCode: r.sites ? r.sites.site_code : null,
    siteName: r.sites ? r.sites.name : null,
    siteState: r.sites ? r.sites.state : null,
  }));

  return json(200, {
    ok: true,
    rows,
    offset,
    pageSize: PAGE_SIZE,
    total: count != null ? count : rows.length,
    hasMore: offset + rows.length < (count != null ? count : 0),
  });
};
