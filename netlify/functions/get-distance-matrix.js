/**
 * get-distance-matrix.js
 * Returns the pre-computed distance matrix for a state from Blobs.
 * Returns null (200) if the matrix hasn't been built yet — the frontend
 * handles this gracefully by falling back to client-side haversine.
 *
 * GET /.netlify/functions/get-distance-matrix?state=GA
 */

const { getStore, connectLambda } = require("@netlify/blobs");

exports.handler = async (event) => {
  connectLambda(event);

  const params = event.queryStringParameters || {};
  const state = (params.state || "").trim().toUpperCase();

  const headers = { "Content-Type": "application/json" };

  if (!state || !/^[A-Z]{2}$/.test(state)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Valid 2-letter state required" }) };
  }

  try {
    const store = getStore("dispatch");
    const data = await store.get("distance-matrix/" + state, { type: "json" });
    return { statusCode: 200, headers, body: JSON.stringify(data || null) };
  } catch {
    return { statusCode: 200, headers, body: JSON.stringify(null) };
  }
};
