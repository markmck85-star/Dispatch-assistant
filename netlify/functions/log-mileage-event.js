// log-mileage-event.js
// Tiny usage log for the mileage driving mode (GPS on/allowed/denied, suggestion taps, etc.).
// Stores only who, when and an event name. Never stores a location. Never blocks the app.

const { createClient } = require('@supabase/supabase-js');

const ALLOWED = new Set([
  'gps_on', 'gps_off', 'gps_allowed', 'gps_denied', 'gps_unavailable',
  'stop_nearest', 'stop_listed', 'stop_typed', 'stop_home',
  'estimate_used', 'odo_typed', 'drive_open', 'report_open', 'stop_deleted'
]);

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { ok: false }); }
  const name = String(body.event || '');
  if (!ALLOWED.has(name)) return json(400, { ok: false, error: 'unknown event' });
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    await supabase.from('mileage_usage_events').insert({
      username: body.username ? String(body.username).slice(0, 80) : null,
      technician_id: body.technician_id || null,
      event: name,
      detail: body.detail ? String(body.detail).slice(0, 80) : null
    });
  } catch (e) { /* logging must never break the app */ }
  return json(200, { ok: true });
};
