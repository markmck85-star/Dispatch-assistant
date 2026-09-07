// get-calendar.js
//
// Read-only lookup of the two calendar.html data sources NOT covered by
// get-on-call.js: planned technician time off (technician_availability,
// where available=false) and company-wide events (company_events, not
// tied to any one technician or state). Forward-looking by default --
// same reasoning as get-on-call.js: "who's out next week" is the real
// use case, not historical record-keeping.
//
// GET /.netlify/functions/get-calendar?state=GA&since=2026-09-01&until=2026-09-30
// -> { unavailable: [{ day, technician, homeState, reason, note }, ...],
//      companyEvents: [{ day, label, note }, ...] }
//
// state filters unavailable entries by technician.home_state; company
// events are never state-filtered, matching calendar.html's own logic
// (they apply to everyone regardless of which state view is selected).

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

  let unavailQuery = supabase
    .from('technician_availability')
    .select('day, reason, note, technicians!inner(name, home_state)')
    .eq('available', false)
    .gte('day', since)
    .lte('day', until)
    .order('day', { ascending: true });
  if (state) unavailQuery = unavailQuery.eq('technicians.home_state', state);

  const { data: unavailData, error: unavailErr } = await unavailQuery;
  if (unavailErr) return json(500, { error: 'technician_availability query failed: ' + unavailErr.message });

  const unavailable = (unavailData || []).map((row) => ({
    day: row.day,
    technician: row.technicians ? row.technicians.name : null,
    homeState: row.technicians ? row.technicians.home_state : null,
    reason: row.reason || null,
    note: row.note || null,
  }));

  // Company events are never state-filtered -- they apply to everyone.
  const { data: eventData, error: eventErr } = await supabase
    .from('company_events')
    .select('day, label, note')
    .gte('day', since)
    .lte('day', until)
    .order('day', { ascending: true });
  if (eventErr) return json(500, { error: 'company_events query failed: ' + eventErr.message });

  return json(200, {
    state: state || 'all',
    since, until,
    unavailable,
    companyEvents: eventData || [],
  });
};
