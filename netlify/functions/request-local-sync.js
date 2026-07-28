// request-local-sync.js
//
// Built 2026-07-28 alongside local-sync-watchdog.js, once the automated
// Netlify-side login was conclusively ruled out (see salesforce-report-
// sync.md for the full investigation). The actual sync work now runs on
// Mark's own PC via local-sync-watchdog.js, checking in with Supabase on a
// short timer. This function is the "Refresh Now" button's other half --
// it can't reach into Mark's PC directly (no webpage can trigger a program
// on someone's specific computer), so instead it just sets a flag in a
// shared table that the PC script checks every couple of minutes and acts
// on when it sees a newer request than its last completed run.

const { createClient } = require("@supabase/supabase-js");

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "POST only" });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { error } = await supabase
    .from("local_sync_state")
    .update({ requested_at: new Date().toISOString() })
    .eq("id", 1);

  if (error) return json(500, { ok: false, error: error.message });
  return json(200, { ok: true });
};
