// netlify/functions/save-on-call.js
//
// Writes a row to on_call_schedule using the Supabase service-role key.
// on_call_schedule's write RLS policy only allows authenticated users
// with role 'admin' or 'dispatcher' -- this page only ever holds the
// anon key client-side, so the insert has to go through a server-side
// function with the service-role key, same pattern as
// save-tech-availability.js.
//
// Expects the same env vars already configured for save-tech-availability:
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.

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

  const { state, technician_id, day, action } = body;
  if (!state || !technician_id || !day) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'state, technician_id, and day are required' }) };
  }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (action === 'delete') {
    const { error } = await sb
      .from('on_call_schedule')
      .delete()
      .match({ state, day, technician_id });

    if (error) {
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: error.message }) };
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  // Primary key is (state, day, technician_id) -- upsert so re-saving the
  // same tech for the same state/day doesn't error, and swapping techs
  // for an existing state/day just adds a second row (remove the old one
  // via the day-detail "Remove" button if a swap, not an addition, is
  // intended).
  const { error } = await sb
    .from('on_call_schedule')
    .upsert({ state, technician_id, day }, { onConflict: 'state,day,technician_id' });

  if (error) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: error.message }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
