const { getStore, connectLambda } = require("@netlify/blobs");

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

function getSettingsStore() {
  return getStore("dispatch");
}

exports.handler = async (event) => {
  connectLambda(event);
  if (event.httpMethod !== "GET") return json(405, { error: "Method Not Allowed" });

  const state = String(event.queryStringParameters?.state || "global").toUpperCase();
  const key = state === "GLOBAL" ? "settings/global" : `settings/${state}`;

  try {
    const store = getSettingsStore();
    const settings = (await store.get(key, { type: "json" })) || {};
    return json(200, { ok: true, settings });
  } catch (err) {
    return json(200, { ok: true, settings: {} });
  }
};
