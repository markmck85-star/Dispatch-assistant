// get-dispatcher-on-call.js
//
// Read-only lookup of the Saturday dispatcher-of-the-day schedule, from
// saturday_dispatcher_schedule (day, dispatcher_id -> dispatchers.username).
// Unlike get-on-call.js (technicians, per state per day), this is one
// dispatcher covering every Saturday-coverage state for the whole day, so
// there's no state filter -- just a date range.
//
// GET /.netlify/functions/get-dispatcher-on-call?since=2026-09-01&until=2026-09-30
// -> { entries: [{ day, dispatcherId, dispatcher }, ...] }
//
// since/until are optional -- default to today through +60 days, same
// forward-looking default as get-on-call.js ("who's on call next
// Saturday" is the real use case, not historical lookback).

const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};

  const today = new Date();
  const defaultUntil = new Date(today.getTime() + 60 * 24 * 3600 * 1000);
  const since = params.since || isoDate(today);
  const until = params.until || isoDate(defaultUntil);

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data, error } = await supabase
    .from('saturday_dispatcher_schedule')
    .select('day, dispatcher_id, dispatchers!inner(username)')
    .gte('day', since)
    .lte('day', until)
    .order('day', { ascending: true });

  if (error) return json(500, { error: error.message });

  const entries = (data || []).map((row) => ({
    day: row.day,
    dispatcherId: row.dispatcher_id,
    dispatcher: row.dispatchers ? row.dispatchers.username : null,
  }));

  return json(200, { since, until, entries });
};
