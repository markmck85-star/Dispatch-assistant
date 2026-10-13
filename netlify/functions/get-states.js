// get-states.js
//
// Read-only list of states from the states table. Used by pages that build
// their state pickers from the table, so turning a state on in Admin -> States
// makes it appear without a code change.
//
// GET /.netlify/functions/get-states            -> active states only
// GET /.netlify/functions/get-states?all=1      -> every row (including inactive)
// -> { states: [ { code, name, timezone, saturday_coverage, active, accepts_prefixes } ] }
//
// Nothing sensitive is in this table (codes, names, time zones, flags).

const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(obj),
  };
}

exports.handler = async (event) => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: 'Supabase is not configured' });
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const qs = (event && event.queryStringParameters) || {};
  let q = supabase
    .from('states')
    .select('code, name, timezone, saturday_coverage, active, accepts_prefixes')
    .order('code', { ascending: true });
  if (!(qs.all === '1' || qs.all === 'true')) q = q.eq('active', true);
  const { data, error } = await q;
  if (error) return json(500, { error: error.message });
  return json(200, { states: data || [] });
};
