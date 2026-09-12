// netlify/functions/get-recent-visits.js
//
// Returns recent site_visits directly, filtered by state (required) and an
// optional single date or date range, sorted newest-first (by started_at).
// Built 2026-09-12 for Location Lookup and the Closing Email
// Reconstructor's state-wide browse view -- both pages previously required
// searching for a specific site first, which made it slow to hunt for
// whichever recent visits happened to have a captured closing note. This
// lets a dispatcher browse a whole state's stream of visits directly,
// newest first, without picking a site up front.
//
// Query params:
//   state      (required) - 2-letter state code
//   date       (optional) - single day, YYYY-MM-DD -- filters to that one
//              calendar day (based on started_at)
//   from / to  (optional) - date range, YYYY-MM-DD each, inclusive.
//              Ignored if `date` is also present -- date wins.
//   tech       (optional) - exact tech_name_raw match, from the
//              Technician dropdown (populated by get-state-techs.js)
//   limit      (optional) - default 50, max 200
//   offset     (optional) - default 0, for "Load more" pagination
//
// Joins to `sites` for display name/code, since site_visits only stores
// site_id plus the raw Salesforce account name (account_name_raw), which
// doesn't always match the site's real display name.

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const params = event.queryStringParameters || {};
    const state = (params.state || '').trim().toUpperCase();
    if (!state) {
      return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'state is required' }) };
    }
    const limit = Math.min(parseInt(params.limit, 10) || 50, 200);
    const offset = parseInt(params.offset, 10) || 0;

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars first.');
    }
    const supabase = createClient(supabaseUrl, supabaseKey);

    let query = supabase
      .from('site_visits')
      .select(
        'id, site_id, account_name_raw, state, appointment_number, wo_number, started_at, ended_at, ' +
        'duration_min, tech_name_raw, remediation, remediation_detail, is_restock, needs_review, ' +
        'closing_note, closing_note_captured_at, sites(name, site_code)',
        { count: 'exact' }
      )
      .eq('state', state)
      .order('started_at', { ascending: false, nullsFirst: false })
      .range(offset, offset + limit - 1);

    if (params.date) {
      query = query.gte('started_at', `${params.date}T00:00:00`).lte('started_at', `${params.date}T23:59:59`);
    } else {
      if (params.from) query = query.gte('started_at', `${params.from}T00:00:00`);
      if (params.to) query = query.lte('started_at', `${params.to}T23:59:59`);
    }
    if (params.tech) {
      query = query.eq('tech_name_raw', params.tech);
    }

    const { data, error, count } = await query;
    if (error) throw new Error(error.message);

    const visits = (data || []).map((v) => ({
      ...v,
      site_name: v.sites ? v.sites.name : v.account_name_raw,
      site_code: v.sites ? v.sites.site_code : null,
      sites: undefined,
    }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        visits,
        total: count ?? null,
        hasMore: count != null ? offset + visits.length < count : visits.length === limit,
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
