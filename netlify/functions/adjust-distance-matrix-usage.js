/**
 * adjust-distance-matrix-usage.js
 *
 * One-off manual correction for the shared monthly element-usage counter
 * (distance-matrix-usage.js). Needed because the counter didn't exist until
 * 2026-09-07 -- any real Google Maps Distance Matrix usage from EARLIER
 * that same month (e.g. the accidental Indiana site-to-site build, 4,812
 * elements) never got recorded, so cost previews would understate real
 * usage for the rest of that month until manually corrected here.
 *
 * Deliberately NOT wired into any UI flow beyond a single button -- this is
 * a rare, manual, audit-trailed correction, not a routine action.
 *
 * Same password gate as the two build functions (DISTANCE_MATRIX_ADMIN_PASSWORD),
 * sharing the same brute-force lockout counter -- this still touches real
 * account-affecting numbers even though it doesn't call Google itself.
 *
 * POST /.netlify/functions/adjust-distance-matrix-usage
 * Body: { elementsToAdd: 4812, reason: "...", adminSecret: "..." }
 * -> { ok: true, added, monthlyElementsUsedTotal, monthKey }
 */

const { getStore } = require("@netlify/blobs");
const { getMonthlyElementsUsed, addMonthlyElementsUsed, monthKey } = require("./distance-matrix-usage.js");

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const elementsToAdd = Number(payload.elementsToAdd);
  if (!Number.isFinite(elementsToAdd) || elementsToAdd <= 0) {
    return json(400, { error: "elementsToAdd must be a positive number" });
  }

  // Same shared password + lockout as compute-distance-matrix.js /
  // compute-site-distance-matrix.js -- a wrong guess here counts against
  // the same 5-try/24h lockout as either build function.
  const requiredSecret = process.env.DISTANCE_MATRIX_ADMIN_PASSWORD;
  if (!requiredSecret) {
    return json(500, { error: "DISTANCE_MATRIX_ADMIN_PASSWORD is not configured." });
  }

  const authStore = getStore("dispatch");
  const failKey = "distance-matrix-failed-attempts";
  const MAX_FAILED_ATTEMPTS = 5;
  const LOCKOUT_HOURS = 24;
  const failData = (await authStore.get(failKey, { type: "json" })) || { count: 0, lockedUntil: null };

  if (failData.lockedUntil && Date.now() < new Date(failData.lockedUntil).getTime()) {
    const minsLeft = Math.ceil((new Date(failData.lockedUntil).getTime() - Date.now()) / 60000);
    return json(429, {
      error: `Too many incorrect admin-secret attempts -- locked out for ${minsLeft} more minute(s) (shared lockout across all distance-matrix admin actions).`,
    });
  }

  if (String(payload.adminSecret || "") !== requiredSecret) {
    const newCount = (failData.count || 0) + 1;
    const update = { count: newCount, lockedUntil: null };
    let msg;
    if (newCount >= MAX_FAILED_ATTEMPTS) {
      update.lockedUntil = new Date(Date.now() + LOCKOUT_HOURS * 3600 * 1000).toISOString();
      update.count = 0;
      msg = `Incorrect admin secret. Too many failed attempts -- locked out for ${LOCKOUT_HOURS} hours.`;
    } else {
      msg = `Incorrect admin secret. ${MAX_FAILED_ATTEMPTS - newCount} attempt(s) remaining before a ${LOCKOUT_HOURS}-hour lockout.`;
    }
    await authStore.setJSON(failKey, update);
    return json(401, { error: msg });
  }
  if (failData.count) await authStore.setJSON(failKey, { count: 0, lockedUntil: null });

  const usageStore = getStore("dispatch");
  const before = await getMonthlyElementsUsed(usageStore);
  const after = await addMonthlyElementsUsed(usageStore, elementsToAdd);

  return json(200, {
    ok: true,
    monthKey: monthKey(),
    before,
    added: elementsToAdd,
    monthlyElementsUsedTotal: after,
    reason: String(payload.reason || "").slice(0, 200) || null,
  });
};
