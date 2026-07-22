const { getStore } = require("@netlify/blobs");

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method Not Allowed" });
  }

  try {
    const store = getStore({ name: "dispatch", siteID: process.env.SITE_ID, token: process.env.NETLIFY_AUTH_TOKEN });
    const existing = await store.get("users", { type: "json" });

    if (existing && existing.length > 0) {
      return json(200, { ok: true, message: "Users already exist, skipped seeding", count: existing.length });
    }

    const defaultUsers = [
      { username: "gina", pin: "1234", states: ["GA", "NC", "SC"], role: "dispatcher" },
      { username: "admin", pin: "0000", states: ["GA", "NC", "SC", "FL", "TN", "AL"], role: "admin" }
    ];

    await store.setJSON("users", defaultUsers);
    return json(200, { ok: true, message: "Default users seeded", count: defaultUsers.length });
  } catch (err) {
    return json(500, { error: "Failed to seed users: " + err.message });
  }
};
