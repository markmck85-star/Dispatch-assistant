// netlify/functions/save-dispatcher-on-call.js
//
// Writes to saturday_dispatcher_schedule using the Supabase service-role
// key (same reasoning as save-on-call.js -- RLS on this table requires an
// authenticated admin/dispatcher session, and any page calling this only
// ever holds the anon key client-side).
//
// No BlueFolder push here -- BlueFolder is being retired, so unlike
// save-on-call.js this only ever touches the local table.
//
// Two actions, selected by body.action:
//   (default / 'set')  -- upsert today's (or any given day's) dispatcher.
//                          day alone is the key, so this always replaces
//                          whoever was previously set for that day rather
//                          than adding a second row.
//   'delete'            -- remove the row for a given day, reverting that
//                          Saturday to "no dispatcher set."

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ ok: false, error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid JSON body' }) };
  }

  const { day, dispatcher_id, action } = body;
  if (!day) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'day is required' }) };
  }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (action === 'delete') {
    const { error } = await sb.from('saturday_dispatcher_schedule').delete().match({ day });
    if (error) return { statusCode: 500, body: JSON.stringify({ ok: false, error: error.message }) };
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  // ---- default ('set'): upsert, day is the conflict key ----
  if (!dispatcher_id) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'dispatcher_id is required to set a dispatcher' }) };
  }

  const { error } = await sb
    .from('saturday_dispatcher_schedule')
    .upsert({ day, dispatcher_id }, { onConflict: 'day' });

  if (error) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: error.message }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
