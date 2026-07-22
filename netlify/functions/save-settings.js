const { getStore, connectLambda } = require("@netlify/blobs");

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
