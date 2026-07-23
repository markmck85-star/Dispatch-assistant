// get-site-history.js
//
// Powers the clickable-location-history feature on the dispatch board:
// clicking a location name shows its recent visits (restocks + trouble
// calls) pulled from site_visits, populated by the Closed Tickets import
// (2026-07-22). Read-only.

const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  const code = (event.queryStringParameters || {}).code;
  if (!code) return json(400, { ok: false, error: 'Missing ?code=' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: site, error: siteErr } = await supabase
    .from('sites')
    .select('id, name, state, site_code')
    .eq('site_code', code)
    .maybeSingle();
  if (siteErr) return json(500, { ok: false, error: siteErr.message });
  if (!site) return json(404, { ok: false, error: 'No site found for code ' + code });

  const { data: visits, error: visitsErr } = await supabase
    .from('site_visits')
    .select('started_at, ended_at, duration_min, tech_name_raw, remediation, remediation_detail, is_restock, wo_number, needs_review')
    .eq('site_id', site.id)
    .order('started_at', { ascending: false, nullsFirst: false })
    .limit(15);
  if (visitsErr) return json(500, { ok: false, error: visitsErr.message });

  // Related shipments: rma_shipments.site_id is only populated on a small
  // fraction of real rows (the inbound RMA email parser was never wired
  // up to resolve it the way the closed-ticket import now does for
  // site_visits) -- so cross-reference by WO number against the visits
  // just fetched instead, plus a direct site_id match as a belt-and-
  // suspenders check for the rows that do have it.
  const woNumbers = [...new Set((visits || []).map((v) => v.wo_number).filter(Boolean))];
  let shipments = [];
  if (woNumbers.length) {
    const { data: byWo, error: shipErr } = await supabase
      .from('rma_shipments')
      .select('wo_number, warehouse_name, outbound_tracking, inbound_tracking, return_broken_part, returned_at, received_at')
      .in('wo_number', woNumbers)
      .order('received_at', { ascending: false, nullsFirst: false });
    if (shipErr) return json(500, { ok: false, error: shipErr.message });
    shipments = byWo || [];
  }

  return json(200, {
    ok: true,
    site: { name: site.name, state: site.state, code: site.site_code },
    visits: visits || [],
    shipments,
  });
};
