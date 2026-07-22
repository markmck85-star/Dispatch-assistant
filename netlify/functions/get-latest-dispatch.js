/**
 * get-latest-dispatch.js
 * 
 * Returns the most recently received inbound dispatch email body
 * so the dispatch app can auto-load it without manual paste.
 * 
 * GET /.netlify/functions/get-latest-dispatch?state=MI
 * GET /.netlify/functions/get-latest-dispatch  (returns global latest)
 */

const { getStore, connectLambda } = require("@netlify/blobs");

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

function getDispatchStore() {
  return getStore("dispatch");
}

exports.handler = async (event) => {
  connectLambda(event);
  if (event.httpMethod !== "GET") return json(405, { error: "Method Not Allowed" });

  const state = (event.queryStringParameters?.state || "").toUpperCase();
  const key = state ? `inbound/latest-${state}` : "inbound/latest-dispatch";

  try {
    const store = getDispatchStore();
    const data = await store.get(key, { type: "json" });
    if (!data) return json(200, { ok: true, found: false });
    return json(200, { ok: true, found: true, ...data });
  } catch (err) {
    return json(200, { ok: true, found: false });
  }
};
