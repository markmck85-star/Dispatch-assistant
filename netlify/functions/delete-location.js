const { getStore, connectLambda } = require("@netlify/blobs");
const { createClient } = require("@supabase/supabase-js");

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

function getDispatchStore() {
  return getStore("dispatch");
}

exports.handler = async (event) => {
  connectLambda(event);
  if (event.httpMethod !== "DELETE" && event.httpMethod !== "POST")
    return json(405, { error: "Method Not Allowed" });

  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch { return json(400, { error: "Invalid JSON body" }); }

  const state = String(payload.state || "").trim().toUpperCase();
  const code = String(payload.code || "").trim().toUpperCase();
  if (!state || !code) return json(400, { error: "State and code are required" });

  try {
    const store = getDispatchStore();
    const key = "locations/" + state;
    const existing = (await store.get(key, { type: "json" })) || {};
    delete existing[code];
    await store.setJSON(key, existing);

    // Additive Supabase soft-delete: a hard delete would violate the
    // tickets/assignments/site_visits foreign keys (no cascade, by design --
    // deleting a site must never silently wipe its history).
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      try {
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
        const { error: supaErr } = await supabase.from("sites").update({ active: false }).eq("site_code", code);
        if (supaErr) console.error("[delete-location] Supabase sync failed (non-fatal):", supaErr.message);
      } catch (supaEx) {
        console.error("[delete-location] Supabase sync error (non-fatal):", supaEx.message);
      }
    }

    return json(200, { ok: true });
  } catch (err) {
    return json(500, { error: "Failed to delete location: " + err.message });
  }
};
