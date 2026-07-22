const { getStore } = require("@netlify/blobs");

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method Not Allowed" });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const code = String(payload.code || payload.siteCode || "").trim().toUpperCase();
  if (!/^([A-Z]{2})\d{3,5}$/.test(code)) {
    return json(400, { error: "Invalid site code format", code });
  }

  const record = {
    code,
    state: payload.state || (code.startsWith("FL") ? "FL" : (code.startsWith("GA") ? "GA" : "")),
    name: String(payload.name || "").trim(),
    address: String(payload.address || "").trim(),
    defaultTech: String(payload.defaultTech || "").trim(),
    contractorOverride: Boolean(payload.contractorOverride),
    contractorName: String(payload.contractorName || "").trim(),
    updatedAt: new Date().toISOString(),
  };

  // Require address for new entries (can be relaxed later)
  if (!record.address) {
    return json(400, { error: "Address is required to save a location" });
  }

  try {
    const store = getStore("dispatch-tool");
    const existing = (await store.get("locations", { type: "json" })) || {};
    existing[code] = { ...(existing[code] || {}), ...record };
    await store.set("locations", existing, { type: "json" });
    return json(200, { ok: true, location: existing[code] });
  } catch (err) {
    return json(500, { error: "Failed to save location" });
  }
};
