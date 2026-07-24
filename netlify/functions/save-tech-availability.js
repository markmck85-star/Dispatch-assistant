// save-tech-availability.js
//
// Server-side write for calendar.html's "+ Add Entry" form. Mark built
// calendar.html to insert directly into Supabase from the browser using the
// anon key -- caught 2026-07-24 that this can't actually work, since
// technician_availability's write RLS policy requires an authenticated
// admin/dispatcher session (checked via auth.uid()), which a bare anon-key
// client never has. This function does the write server-side with the
// service-role key instead, matching how every other write in this app
// works (through a Netlify function, never direct client-side Supabase).
//
// Upserts on (technician_id, day) -- same conflict target bluefolder-sync.js
// already uses for its own writes to this table, so a manual entry safely
// overwrites a same-day BlueFolder-synced row (or vice versa on the next
// sync) instead of erroring out or creating a duplicate.
//
// Built for TJ's specific use case: BlueFolder has a hard limit on how many
// technicians can be added, so this is the standalone way to track
// vacation/PTO/etc for technicians who don't fit. Confirmed those techs
// (no bluefolder_user_id set) are silently skipped by the sync's push step
// -- entries for them stay Supabase-only, never attempted against
// BlueFolder's API.

const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

const VALID_REASONS = new Set(['vacation', 'personal', 'pto', 'comp_day', 'manual', 'other']);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'POST required' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { ok: false, error: 'Invalid JSON body' });
  }

  const { technician_id, day, reason, note } = body;
  if (!technician_id || !day) {
    return json(400, { ok: false, error: 'technician_id and day are both required' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return json(400, { ok: false, error: 'day must be YYYY-MM-DD' });
  }
  const cleanReason = VALID_REASONS.has(reason) ? reason : 'other';

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data, error } = await supabase
    .from('technician_availability')
    .upsert(
      { technician_id, day, available: false, reason: cleanReason, note: note || null },
      { onConflict: 'technician_id,day' }
    )
    .select();

  if (error) return json(500, { ok: false, error: error.message });

  return json(200, { ok: true, entry: (data && data[0]) || null });
};
