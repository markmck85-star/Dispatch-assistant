// get-on-call.js
//
// Read-only lookup of the Saturday on-call schedule, from the same
// on_call_schedule table calendar.html already reads (state, day,
// technician_id -> technicians.name/home_state). Only states with
// saturday_coverage=true have real rotation data -- this mirrors
// calendar.html's own scoping rather than inventing new logic.
//
// GET /.netlify/functions/get-on-call?state=GA&since=2026-09-01&until=2026-09-30
// -> { entries: [{ state, day, technician, homeState }, ...] }
//
// state is optional (omit for every Saturday-coverage state at once).
// since/until are optional -- default to today through +60 days, since
// the real use case ("who's on call next Saturday") is forward-looking,
// not historical.

const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const state = String(params.state || '').trim().toUpperCase();

  const today = new Date();
  const defaultUntil = new Date(today.getTime() + 60 * 24 * 3600 * 1000);
  const since = params.since || isoDate(today);
  const until = params.until || isoDate(defaultUntil);

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // If a state was given, confirm it actually has Saturday coverage --
  // same real-world fact dispatcher-procedures already establishes (CO/ID
  // have none, for example). Return a clear, honest empty result rather
  // than a confusing "no rows" for a state that was never going to have any.
  if (state) {
    const { data: stateRow, error: stateErr } = await supabase
      .from('states')
      .select('code, saturday_coverage')
      .eq('code', state)
      .maybeSingle();
    if (stateErr) return json(500, { error: 'State lookup failed: ' + stateErr.message });
    if (!stateRow) return json(404, { error: 'Unknown state code ' + state });
    if (!stateRow.saturday_coverage) {
      return json(200, { state, entries: [], note: state + ' does not have Saturday coverage -- no on-call rotation exists for it.' });
    }
  }

  let query = supabase
    .from('on_call_schedule')
    .select('state, day, technicians!inner(name, home_state)')
    .gte('day', since)
    .lte('day', until)
    .order('day', { ascending: true });
  if (state) query = query.eq('state', state);

  const { data, error } = await query;
  if (error) return json(500, { error: error.message });

  const entries = (data || []).map((row) => ({
    state: row.state,
    day: row.day,
    technician: row.technicians ? row.technicians.name : null,
    homeState: row.technicians ? row.technicians.home_state : null,
  }));

  return json(200, { state: state || 'all', since, until, entries });
};
