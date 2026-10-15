/**
 * distance-matrix-quickadd-auth.js
 * Built 2026-09-25.
 *
 * Quick Add (admin.html's "I added a new tech/location" buttons, see
 * compute-distance-matrix.js and backfill-site-distance-gaps.js) always
 * prices exactly one new item against everything already built -- linear
 * cost, additive-only, the confirm dialog shows the real dollar amount
 * before anything runs. That's a fundamentally smaller risk than a full
 * state rebuild, so Mark wants Quick Add specifically to accept a
 * dispatcher's own admin-role login (the same username+PIN already used
 * for admin.html) instead of requiring the separate, stronger
 * DISTANCE_MATRIX_ADMIN_PASSWORD shared secret that gates every other
 * paid build. That password stays completely unchanged for everything
 * else -- full rebuilds, the direct Build (Drive-Time) button, Fill
 * Missing Pairs, all of it.
 *
 * IMPORTANT -- this is a SEPARATE, weaker check than the shared password,
 * used ONLY for Quick Add's inherently bounded operations. It must never
 * be reachable for a full rebuild or non-additive build: the two call
 * sites in compute-distance-matrix.js and backfill-site-distance-gaps.js
 * both hard-enforce additive:true and force:false whenever this path is
 * used, regardless of what the request body claims, so a buggy or
 * tampered frontend request can't use the lighter auth to trigger an
 * expensive operation.
 *
 * PINs are checked through lib/auth.js (hashed, with lockout), the same as
 * the main sign-in.
 *
 * Fails closed on any Supabase error or missing/inactive/non-admin user.
 */

const auth = require("./lib/auth");

async function verifyQuickAddAdmin(supabase, username, pin) {
  const cleanUsername = String(username || "").trim().toLowerCase();
  const cleanPin = String(pin || "").trim();
  if (!cleanUsername || !cleanPin) {
    return { ok: false, reason: "Username and PIN are required." };
  }

  try {
    const r = await auth.verifyCredentials(supabase, cleanUsername, cleanPin);
    if (r.error) return { ok: false, reason: r.status === 429 ? r.error : (r.status === 500 ? "Login check failed." : "Invalid username or PIN.") };
    if (r.user.role !== "admin") return { ok: false, reason: "This login doesn't have admin access." };

    return { ok: true, username: r.user.username };
  } catch (err) {
    return { ok: false, reason: "Login check failed: " + err.message };
  }
}

module.exports = { verifyQuickAddAdmin };
