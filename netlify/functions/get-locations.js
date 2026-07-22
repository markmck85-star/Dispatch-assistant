const { getStore, connectLambda } = require("@netlify/blobs");

function getDispatchStore() {
  return getStore("dispatch");
}

exports.handler = async (event) => {
  connectLambda(event);
  const params = event.queryStringParameters || {};
  const state = (params.state || "").trim().toUpperCase();

  if (!state || !/^[A-Z]{2}$/.test(state)) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing or invalid state parameter" }),
    };
  }

  try {
    const store = getDispatchStore();
    const data = await store.get("locations/" + state, { type: "json" });
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data || {}),
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    };
  }
};
