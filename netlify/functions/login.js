/**
 * login.js — v2 — dispatcher-territories migration
 *
 * Now authenticates against the Supabase `dispatchers` table instead of
 * the hardcoded USERS array. Adding/disabling a dispatcher is now a data
 * change (insert a row / flip `active`), not a code edit + deploy.
 *
 * Falls back to the old hardcoded array only if Supabase isn't configured
 * (mirrors the fallback pattern already used in get-locations.js), so a
 * Supabase outage doesn't lock everyone out of the app.
 */

const { createClient } = require("@supabase/supabase-js");

// Fallback only — used if SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY aren't set.
const FALLBACK_USERS = [
  { username: "gina",  pin: "4084", states: ["GA", "NC", "SC"], role: "dispatcher" },
  { username: "admin", pin: "9602", states: ["GA", "NC", "SC", "FL"], role: "admin" },
  { username: "tj",    pin: "8278", states: ["GA", "NC", "SC", "FL", "MI", "IN", "OH", "NV", "IL", "MN", "WV", "OR"], role: "admin" }
];

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj)
  };
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

  const username = String(payload.username || "").trim().toLowerCase();
  const pin     = String(payload.pin     || "").trim();

  if (!username || !pin) {
    return json(400, { error: "Username and PIN are required" });
  }

  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      const { data, error } = await supabase
        .from("dispatchers")
        .select("username, role, states, active")
        .ilike("username", username)
        .eq("pin", pin)
        .eq("active", true)
        .maybeSingle();

      if (error) throw error;

      if (!data) {
        return json(401, { error: "Invalid username or PIN" });
      }

      return json(200, {
        ok: true,
        username: data.username,
        role:     data.role   || "dispatcher",
        states:   data.states || []
      });
    } catch (err) {
      console.error("login.js: Supabase query failed, falling back to hardcoded users:", err.message);
      // fall through to FALLBACK_USERS below
    }
  }

  const user = FALLBACK_USERS.find(
    u => u.username.toLowerCase() === username && u.pin === pin
  );

  if (!user) {
    return json(401, { error: "Invalid username or PIN" });
  }

  return json(200, {
    ok: true,
    username: user.username,
    role:     user.role   || "dispatcher",
    states:   user.states || []
  });
};
