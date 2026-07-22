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
  const name = String(payload.name || "").trim();
  if (!state || !name) return json(400, { error: "State and name are required" });

  try {
    const store = getDispatchStore();
    const key = "technicians/" + state;
    const existing = (await store.get(key, { type: "json" })) || {};
    // Technicians are stored under their display name as key
    delete existing[name];
    await store.setJSON(key, existing);

    // Additive Supabase soft-delete: a hard delete would violate the
    // assignments/site_visits foreign keys (no cascade, by design -- deleting
    // a technician must never silently wipe their dispatch history). `active`
    // false matches how the rest of the app already treats inactive techs.
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      try {
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
        const slug = name.toLowerCase().replace(/\s+/g, "-");
        const { error: supaErr } = await supabase.from("technicians").update({ active: false }).eq("slug", slug);
        if (supaErr) console.error("[delete-technician] Supabase sync failed (non-fatal):", supaErr.message);
      } catch (supaEx) {
        console.error("[delete-technician] Supabase sync error (non-fatal):", supaEx.message);
      }
    }

    return json(200, { ok: true });
  } catch (err) {
    return json(500, { error: "Failed to delete technician: " + err.message });
  }
};
