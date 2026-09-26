// get-saturday-states.js
//
// Read-only list of Saturday-coverage states, from states.saturday_coverage
// (the same flag get-on-call.js already checks per-state). Built for the
// Saturday on-call page's overview map/ticket list, which need the live
// list of covered states plus each one's timezone -- rather than any page
// hardcoding a GA/IN/MI/NV-style list that goes stale the moment a new
// state gets Saturday coverage.
//
// GET /.netlify/functions/get-saturday-states
// -> { states: [ { code, name, timezone }, ... ] }

const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data, error } = await supabase
    .from('states')
    .select('code, name, timezone')
    .eq('saturday_coverage', true)
    .eq('active', true)
    .order('code', { ascending: true });

  if (error) return json(500, { error: error.message });

  return json(200, { states: data || [] });
};
