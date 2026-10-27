const { getStore, connectLambda } = require("@netlify/blobs");
const { createClient } = require("@supabase/supabase-js");
const auth = require("./lib/auth");

// The switches for the Salesforce sync passes can only be changed by an admin login
// (they live in the Admin panel). Everything else this function saves is unchanged.
const ADMIN_ONLY_FIELDS = ["salesforceReportSyncEnabled", "closingNotesEnabled", "salesforceStatusSyncEnabled"];

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

function getSettingsStore() {
  return getStore("dispatch");
}

exports.handler = async (event) => {
  connectLambda(event);
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch { return json(400, { error: "Invalid JSON body" }); }

  if (ADMIN_ONLY_FIELDS.some((f) => Object.prototype.hasOwnProperty.call(payload, f))) {
    try {
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      const who = await auth.requireUser(sb, event, { roles: ["admin"] });
      if (who.error) return json(who.status || 403, { error: who.error === "Sign in required" ? who.error : "Only an admin can change the sync switches." });
    } catch (e) {
      return json(500, { error: "Could not check the login: " + e.message });
    }
  }

  const state = String(payload.state || "global").toUpperCase();
  const key = state === "GLOBAL" ? "settings/global" : `settings/${state}`;

  try {
    const store = getSettingsStore();
    const existing = (await store.get(key, { type: "json" })) || {};
    const { state: _s, ...rest } = payload;
    const updated = { ...existing, ...rest, updatedAt: new Date().toISOString() };
    await store.setJSON(key, updated);
    return json(200, { ok: true, settings: updated });
  } catch (err) {
    return json(500, { error: "Failed to save settings: " + err.message });
  }
};
