const USERS = [
  { username: "gina",  pin: "2847", states: ["GA", "NC", "SC"], role: "dispatcher" },
  { username: "admin", pin: "2847", states: ["GA", "NC", "SC", "FL"], role: "admin" },
  { username: "tj",    pin: "2847", states: ["GA", "NC", "SC", "FL", "MI", "IN", "OH", "NV", "IL", "MN", "WV", "OR"], role: "admin" }
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

  const user = USERS.find(
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
