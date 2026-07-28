// get-local-sync-status.js
//
// Read-only companion to request-local-sync.js -- reports the current
// state of local_sync_state (Supabase) so state.html's Refresh Now button
// can show real progress from Mark's PC script instead of guessing.

const { createClient } = require("@supabase/supabase-js");

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

exports.handler = async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await supabase.from("local_sync_state").select("*").eq("id", 1).maybeSingle();

  if (error) return json(500, { ok: false, error: error.message });
  return json(200, { ok: true, state: data || {} });
};
