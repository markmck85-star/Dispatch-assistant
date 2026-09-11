// netlify/functions/get-state-techs.js
//
// Returns the distinct list of tech_name_raw values that have appeared on
// site_visits for a given state, sorted alphabetically. Built 2026-09-12
// to populate a "Technician" filter dropdown on Location Lookup and the
// Closing Email Reconstructor's state-wide recent-visits feed -- lets
// someone pick a tech directly rather than typing/guessing a name, and
// naturally only shows techs who've actually worked that state.

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

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars first.');
    }
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Postgres has no simple "distinct column via the JS client" call, so
    // pull tech_name_raw for the state (capped generously) and de-dupe in
    // JS -- fine at this scale (a few thousand rows per state at most) and
    // avoids needing a raw-SQL RPC just for this.
    const { data, error } = await supabase
      .from('site_visits')
      .select('tech_name_raw')
      .eq('state', state)
      .not('tech_name_raw', 'is', null)
      .limit(5000);
    if (error) throw new Error(error.message);

    const techs = [...new Set((data || []).map((r) => r.tech_name_raw).filter(Boolean))].sort();

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, techs }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
