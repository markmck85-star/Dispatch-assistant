/**
 * clear-distance-matrix-cooldown.js
 *
 * Minimal one-off admin action: deletes a single distance-matrix cooldown
 * key so a blocked build can run again immediately, instead of waiting out
 * the full 24h window. Intended for cases like 2026-09-07's GA cooldown --
 * set by a run that (due to a since-fixed bug) computed 0 real pairs, so
 * the 24h block that followed was protecting nothing.
 *
 * No UI button for this on purpose -- rare enough to not warrant one; call
 * directly. Same password gate as the other paid-adjacent distance-matrix
 * actions, sharing the same lockout counter.
 *
 * POST /.netlify/functions/clear-distance-matrix-cooldown
 * Body: { state: "GA", kind: "site-site" | "tech-site", adminSecret: "..." }
 * -> { ok: true, cleared: "distance-matrix-cooldown/site-site/GA" }
 */

const { getStore, connectLambda } = require("@netlify/blobs");

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  connectLambda(event);

  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const state = String(payload.state || "").trim().toUpperCase();
  if (!state || !/^[A-Z]{2}$/.test(state)) return json(400, { error: "Valid 2-letter state required" });

  const kind = payload.kind === "tech-site" ? "tech-site" : "site-site";

  const requiredSecret = process.env.DISTANCE_MATRIX_ADMIN_PASSWORD;
  if (!requiredSecret) return json(500, { error: "DISTANCE_MATRIX_ADMIN_PASSWORD is not configured." });

  const authStore = getStore("dispatch");
  const failKey = "distance-matrix-failed-attempts";
  const MAX_FAILED_ATTEMPTS = 5;
  const LOCKOUT_HOURS = 24;
  const failData = (await authStore.get(failKey, { type: "json" })) || { count: 0, lockedUntil: null };

  if (failData.lockedUntil && Date.now() < new Date(failData.lockedUntil).getTime()) {
    const minsLeft = Math.ceil((new Date(failData.lockedUntil).getTime() - Date.now()) / 60000);
    return json(429, { error: `Locked out for ${minsLeft} more minute(s).` });
  }

  if (String(payload.adminSecret || "") !== requiredSecret) {
    const newCount = (failData.count || 0) + 1;
    const update = { count: newCount, lockedUntil: null };
    let msg;
    if (newCount >= MAX_FAILED_ATTEMPTS) {
      update.lockedUntil = new Date(Date.now() + LOCKOUT_HOURS * 3600 * 1000).toISOString();
      update.count = 0;
      msg = `Incorrect admin secret. Locked out for ${LOCKOUT_HOURS} hours.`;
    } else {
      msg = `Incorrect admin secret. ${MAX_FAILED_ATTEMPTS - newCount} attempt(s) remaining.`;
    }
    await authStore.setJSON(failKey, update);
    return json(401, { error: msg });
  }
  if (failData.count) await authStore.setJSON(failKey, { count: 0, lockedUntil: null });

  const store = getStore("dispatch");
  const key = "distance-matrix-cooldown/" + kind + "/" + state;
  await store.delete(key);

  return json(200, { ok: true, cleared: key });
};
