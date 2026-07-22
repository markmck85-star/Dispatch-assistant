const { getStore, connectLambda } = require("@netlify/blobs");

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

function getDispatchStore() {
  return getStore("dispatch");
}

exports.handler = async (event) => {
  connectLambda(event);
  const store = getDispatchStore();

  if (event.httpMethod === "GET") {
    const params = event.queryStringParameters || {};
    const state = (params.state || "").trim().toUpperCase();
    if (!state || !/^[A-Z]{2}$/.test(state))
      return json(400, { error: "Missing or invalid state parameter" });

    try {
      const technicians = (await store.get("technicians/" + state, { type: "json" })) || {};
      const locations = (await store.get("locations/" + state, { type: "json" })) || {};
      return json(200, { version: 1, state, createdAt: new Date().toISOString(), technicians, locations });
    } catch (err) {
      return json(500, { error: "Failed to read backup data: " + err.message });
    }
  }

  if (event.httpMethod === "POST") {
    const restoreKey = event.headers["x-restore-key"];
    if (restoreKey !== "mcr2026") return json(403, { error: "Forbidden - invalid restore key" });

    let payload;
    try { payload = JSON.parse(event.body || "{}"); }
    catch { return json(400, { error: "Invalid JSON body" }); }

    const targetState = ((event.queryStringParameters || {}).state || "").trim().toUpperCase();
    if (!targetState || !/^[A-Z]{2}$/.test(targetState))
      return json(400, { error: "Missing or invalid state parameter" });

    if (payload.state && payload.state.toUpperCase() !== targetState)
      return json(400, { error: "Backup state does not match target state" });

    if (!payload.locations && !payload.technicians)
      return json(400, { error: "Payload must contain locations or technicians" });

    try {
      if (payload.locations) await store.setJSON("locations/" + targetState, payload.locations);
      if (payload.technicians) await store.setJSON("technicians/" + targetState, payload.technicians);
      return json(200, { ok: true, state: targetState, restored: { locations: !!payload.locations, technicians: !!payload.technicians } });
    } catch (err) {
      return json(500, { error: "Failed to restore data: " + err.message });
    }
  }

  return json(405, { error: "Method Not Allowed" });
};
