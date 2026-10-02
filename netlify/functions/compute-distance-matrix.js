/**
 * compute-distance-matrix.js
 * Admin-triggered function.  Reads stored lat/lng from Supabase (sites and
 * technicians tables), then builds a technician↔location distance matrix
 * for a state and writes it to Blobs at distance-matrix/{STATE}.
 *
 * v2 (2026-07-28): migrated input from the old Blobs "locations/{STATE}"
 * and "technicians/{STATE}" keys to Supabase, matching the same migration
 * done to geocode-addresses.js and compute-site-distance-matrix.js the
 * same day. Output (the computed matrix itself) is unchanged -- still
 * cached in Blobs, since index.html already reads from there.
 *
 * v7 (2026-10-01): (1) "already covered" for additive/Quick Add runs and the dry-run preview now comes from
 * the tech_site_distances table, not the older copy in Netlify storage -- a Quick Add on a fully built state
 * no longer re-prices pairs the database already has; (2) the preview only counts techs/sites with map
 * coordinates, like the real build; (3) Quick Add runs are capped server-side at QUICKADD_MAX_COST dollars;
 * (4) action:"verify-secret" lets admin.html unlock its advanced tools with one password check.
 *
 * v3 (2026-09-02): added additive mode for driving builds. A full driving
 * rebuild re-queries and re-bills every tech x site pair in the state, even
 * when only one new tech or one new site was added since the last build --
 * expensive for something that should cost pennies. Additive mode instead
 * loads the existing cached matrix, drops any pair whose tech or site no
 * longer exists/is no longer active (free -- no API call needed, this is
 * also how a departed tech like Nyzier Moore gets fully cleared out even
 * without a paid rebuild), and only calls Google's API for pairs that are
 * genuinely new. Existing valid pairs are carried over untouched, so a
 * stale pair (tech moved, site address corrected) will NOT be refreshed by
 * additive mode -- run a full rebuild when you actually want to force
 * everything current.
 *
 * Two modes:
 *   haversine (default, free) — straight-line distance using stored lat/lng.
 *     Fast, no external API call. Always a full SWEEP (every tech x site
 *     pair is checked), but as of v4 below it no longer means a full
 *     REBUILD -- real driving data already on file for a pair is preserved,
 *     not overwritten. Always completes in one call -- no Google API calls,
 *     so no chunking needed.
 *
 *   driving (optional, costs ~$5–$6 per full GA+FL refresh) — actual drive
 *     distance + duration via Google Maps Distance Matrix API.
 *     Batches DEST_BATCH destinations per API call. Pass additive: true to
 *     only price/query pairs missing from the existing cached matrix.
 *
 * v4 (2026-09-23): FIXED a real bug found live by Mark -- haversine mode's
 * "always a full rebuild (it's free either way)" was true in the sense
 * that it's harmless to WASTE (no Google billing), but it was never
 * harmless to the DATA: it unconditionally overwrote the entire Blobs
 * matrix with fresh haversine entries for every pair, silently destroying
 * any real driving-mode distances (with duration) that a previous paid
 * build had already put there for those same pairs. Fixed by having
 * haversine mode read the existing matrix first and preserve any pair
 * already on file as real ("driving" type) data.
 *
 * v5 (2026-09-23): FIXED a real timeout bug found live on CA (15 techs x
 * 290 sites = 4,350 elements, ~435 individual Google calls needed). This
 * function's driving mode previously ran as ONE continuous call with no
 * chunking, unlike compute-site-distance-matrix.js (Step 3), which was
 * already redesigned this way back on 2026-07-25 for the exact same
 * reason ("a full state takes far longer than Netlify's function
 * execution limit"). GA/FL's smaller tech rosters happened to finish
 * inside the limit; CA's didn't, and got killed mid-flight by Netlify's
 * own timeout (returns an HTML error page, not JSON -- the "Unexpected
 * token '<'" error Mark saw). Nothing partial was lost or double-billable
 * (the old code only wrote results at the very end, so a mid-flight kill
 * saved nothing either way), but real Google spend for whatever calls
 * completed before the cutoff was still real and unrecoverable. Driving
 * mode (both additive and full-rebuild) is now chunked and resumable,
 * mirroring compute-site-distance-matrix.js's proven design: one TECH
 * processed per invocation (matching that file's "CA timed out at 2
 * origin-batches, 1 is safe" finding), progress persisted to Blobs between
 * calls, results written to Supabase as each tech completes (not only at
 * the end) so an interruption never loses or re-bills completed work, and
 * the same orphaned-build guard (409 + resumeOffset) admin.html's
 * generalized resume-confirm flow already knows how to handle. Also adds
 * explicit `.order()` to the sites/technicians queries -- the same
 * ordering-instability class of bug fixed in compute-site-distance-
 * matrix.js v4, now relevant here too since this function spans multiple
 * calls for the first time.
 *
 * v6 (2026-09-25): added a lighter auth path for admin.html's Quick Add
 * buttons only ({ quickAdd: true, dispatcherAuth: { username, pin } }
 * instead of adminSecret) -- a dispatcher's own existing admin-role login
 * verified against the `dispatchers` table (see distance-matrix-quickadd-
 * auth.js), rather than the shared DISTANCE_MATRIX_ADMIN_PASSWORD. Only
 * reachable for additive builds (quickAdd forces additive:true above,
 * and quickAdd + force:true is rejected outright) -- structurally cannot
 * authorize a full/forced rebuild. Own separate lockout counter so a
 * fumbled PIN doesn't lock out the real admin-secret path.
 *
 * POST /.netlify/functions/compute-distance-matrix
 * Body: { state: "GA", mode: "haversine"|"driving", additive?: true,
 *         offset?: 0, adminSecret?: "...", force?: true,
 *         quickAdd?: true, dispatcherAuth?: { username, pin } }
 * offset is only meaningful for mode:"driving" -- haversine always
 * completes in a single call regardless of what's passed.
 *
 * Requires env var: GOOGLE_MAPS_API_KEY (only for driving mode)
 *
 * Matrix Blobs key: distance-matrix/{STATE}
 * Matrix entry key format: "{techKey}|{locationCode}"
 * e.g. "robert-medley|GA1001" → { distanceMi: 12.3, durationMin: 18, type: "driving" }
 */

const { getStore, connectLambda } = require("@netlify/blobs");
const { createClient } = require("@supabase/supabase-js");
const { getMonthlyElementsUsed, addMonthlyElementsUsed, estimateCost } = require("./distance-matrix-usage.js");
const { verifyQuickAddAdmin } = require("./distance-matrix-quickadd-auth.js");

const MATRIX_URL = "https://maps.googleapis.com/maps/api/distancematrix/json";
const DEST_BATCH = 10; // destinations per Distance Matrix API call
const TECH_BATCHES_PER_CALL = 1; // techs (each with their own full destination sweep) processed per invocation -- see v5 comment above
const R_MI = 3958.8;  // Earth radius in miles
// v7 (2026-10-01): hard ceiling for a Quick Add run. Quick Add accepts a dispatcher's own admin login
// instead of the shared password, so the server (not just the admin page) refuses anything that would
// cost more than this after the monthly free allowance. Bigger jobs go through the password-protected
// advanced tools.
const QUICKADD_MAX_COST = 5; // dollars

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

function haversineDistance(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R_MI * 2 * Math.asin(Math.sqrt(a));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// v7 (2026-10-01): reads the driving distances already saved in the tech_site_distances table (the
// database the app actually uses) for the given technicians. "Already covered" used to be judged from
// an older copy of the matrix kept in Netlify storage, which could be missing technicians the database
// already had -- so Quick Add re-priced (and re-billed against the free allowance) pairs it already
// owned. Ordered by (technician_id, site_id) so paging never skips or repeats a row.
async function loadDrivingRows(supabase, techIds) {
  const rows = [];
  for (let i = 0; i < techIds.length; i += 10) {
    const ids = techIds.slice(i, i + 10);
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from("tech_site_distances")
        .select("technician_id, site_id, distance_mi, duration_min")
        .eq("mode", "driving")
        .in("technician_id", ids)
        .order("technician_id", { ascending: true })
        .order("site_id", { ascending: true })
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      rows.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
  }
  return rows;
}

// Queries one tech's full (or missing-only, for additive) destination list
// against Google, DEST_BATCH destinations per call. Returns the new matrix
// entries and any failures -- never throws, failures are recorded and
// fall back to haversine like the rest of this codebase does.
async function queryTechAgainstDestinations(apiKey, techKey, tech, destCodes, locMap, failedPairs) {
  const results = {};
  for (let i = 0; i < destCodes.length; i += DEST_BATCH) {
    const batchCodes = destCodes.slice(i, i + DEST_BATCH);
    const destinations = batchCodes.map((code) => { const l = locMap.get(code); return `${l.lat},${l.lng}`; }).join("|");
    const url = MATRIX_URL +
      "?origins=" + encodeURIComponent(`${tech.lat},${tech.lng}`) +
      "&destinations=" + encodeURIComponent(destinations) +
      "&units=imperial&key=" + apiKey;
    try {
      const res = await fetch(url);
      const data = await res.json();
      if (data.status !== "OK") {
        failedPairs.push({ techKey, batchStart: i, reason: "API status: " + data.status });
      } else {
        const row = data.rows[0];
        row.elements.forEach((el, di) => {
          const locCode = batchCodes[di];
          const key = techKey + "|" + locCode;
          if (el.status === "OK") {
            results[key] = {
              distanceMi: Math.round((el.distance.value / 1609.34) * 10) / 10,
              durationMin: Math.round(el.duration.value / 60),
              distanceText: el.distance.text,
              durationText: el.duration.text,
              type: "driving",
            };
          } else {
            failedPairs.push({ techKey, locCode, reason: "Element status: " + el.status });
            const loc = locMap.get(locCode);
            results[key] = { distanceMi: Math.round(haversineDistance(tech.lat, tech.lng, loc.lat, loc.lng) * 10) / 10, type: "haversine-fallback" };
          }
        });
      }
    } catch (err) {
      failedPairs.push({ techKey, batchStart: i, reason: "Network error: " + err.message });
    }
    await sleep(150);
  }
  return results;
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

  // v7 (2026-10-01): password check only -- no state needed, no Google call, nothing is built or billed.
  // admin.html uses it to unlock the advanced (full rebuild / re-geocode) controls with ONE password
  // entry. Same shared lockout counter as every other paid action: five wrong guesses locks it for 24h.
  if (payload.action === "verify-secret") {
    const requiredSecretV = process.env.DISTANCE_MATRIX_ADMIN_PASSWORD;
    if (!requiredSecretV) {
      return json(500, { ok: false, error: "DISTANCE_MATRIX_ADMIN_PASSWORD is not configured." });
    }
    const vStore = getStore("dispatch");
    const vKey = "distance-matrix-failed-attempts";
    const V_MAX_FAILED = 5;
    const V_LOCKOUT_HOURS = 24;
    const vData = (await vStore.get(vKey, { type: "json" })) || { count: 0, lockedUntil: null };
    if (vData.lockedUntil && Date.now() < new Date(vData.lockedUntil).getTime()) {
      const minsLeft = Math.ceil((new Date(vData.lockedUntil).getTime() - Date.now()) / 60000);
      return json(429, { ok: false, error: `Too many incorrect admin-secret attempts -- locked out for ${minsLeft} more minute(s).` });
    }
    if (String(payload.adminSecret || "") !== requiredSecretV) {
      const newCount = (vData.count || 0) + 1;
      const update = { count: newCount, lockedUntil: null };
      let msg;
      if (newCount >= V_MAX_FAILED) {
        update.lockedUntil = new Date(Date.now() + V_LOCKOUT_HOURS * 3600 * 1000).toISOString();
        update.count = 0;
        msg = `Incorrect admin secret. Too many failed attempts -- locked out for ${V_LOCKOUT_HOURS} hours.`;
      } else {
        msg = `Incorrect admin secret. ${V_MAX_FAILED - newCount} attempt(s) remaining before a ${V_LOCKOUT_HOURS}-hour lockout.`;
      }
      await vStore.setJSON(vKey, update);
      return json(401, { ok: false, error: msg });
    }
    if (vData.count) await vStore.setJSON(vKey, { count: 0, lockedUntil: null });
    return json(200, { ok: true });
  }

  const state = String(payload.state || "").trim().toUpperCase();
  if (!state || !/^[A-Z]{2}$/.test(state))
    return json(400, { error: "Valid 2-letter state required" });

  const mode = payload.mode === "driving" ? "driving" : "haversine";
  // v6 (2026-09-25): quickAdd is a lighter auth path (see the password
  // gate below and distance-matrix-quickadd-auth.js) for admin.html's
  // Quick Add buttons only -- always additive, never combinable with a
  // full/forced rebuild, regardless of what the request body claims.
  const quickAdd = payload.quickAdd === true;
  if (quickAdd && payload.force === true) {
    return json(400, { error: "Quick Add cannot be combined with force -- resume any interrupted build normally instead." });
  }
  const additive = mode === "driving" && (quickAdd || payload.additive === true);
  const offset = Number.isInteger(payload.offset) ? payload.offset : 0;
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (mode === "driving" && !apiKey)
    return json(500, { error: "GOOGLE_MAPS_API_KEY env var not set (required for driving mode)" });

  // Dry-run cost preview -- free, no password needed, no API call to Google.
  // v7 (2026-10-01): counts only technicians and sites that have map coordinates (the real build skips
  // the rest, so the preview now matches what a run would actually do), and judges "already covered" from
  // the tech_site_distances table instead of the older copy in Netlify storage.
  if (payload.dryRun === true && mode === "driving") {
    const dryStore = getStore("dispatch");
    const supabasePreview = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const [{ data: pSites, error: pSitesErr }, { data: pTechs, error: pTechsErr }] = await Promise.all([
      supabasePreview.from("sites").select("id, site_code, lat, lng").eq("state", state).eq("active", true),
      supabasePreview.from("technicians").select("id, slug, lat, lng").eq("home_state", state).eq("active", true),
    ]);
    if (pSitesErr) return json(500, { ok: false, error: "sites fetch failed: " + pSitesErr.message });
    if (pTechsErr) return json(500, { ok: false, error: "technicians fetch failed: " + pTechsErr.message });

    const priceSites = (pSites || []).filter((s) => s.lat != null && s.lng != null);
    const priceTechs = (pTechs || []).filter((t) => t.lat != null && t.lng != null);

    let elementCount = priceTechs.length * priceSites.length;
    if (additive) {
      let coverageRows;
      try {
        coverageRows = await loadDrivingRows(supabasePreview, priceTechs.map((t) => t.id));
      } catch (e) {
        return json(500, { ok: false, error: "existing distances fetch failed: " + e.message });
      }
      const siteIdSet = new Set(priceSites.map((s) => s.id));
      const covered = new Set();
      for (const r of coverageRows) if (siteIdSet.has(r.site_id)) covered.add(r.technician_id + "|" + r.site_id);
      elementCount = Math.max(0, elementCount - covered.size);
    }

    const usedThisMonth = await getMonthlyElementsUsed(dryStore);
    const preview = estimateCost(elementCount, usedThisMonth);
    return json(200, {
      ok: true, state, mode, additive, elementCount,
      techCount: priceTechs.length, siteCount: priceSites.length,
      monthlyElementsUsed: usedThisMonth, quickAddMaxCost: QUICKADD_MAX_COST,
      ...preview,
    });
  }

  // Password gate -- shared lockout with compute-site-distance-matrix.js.
  // Only re-checked on a genuine fresh start (offset 0); a resume call
  // still must present the password on every request, just skips the
  // lockout bookkeeping since it already passed once.
  if (mode === "driving" && quickAdd) {
    // v6 (2026-09-25): Quick Add's own lighter gate -- a dispatcher's
    // existing admin-role login (username+PIN, same as admin.html itself)
    // instead of the shared DISTANCE_MATRIX_ADMIN_PASSWORD. Only reachable
    // when additive is force-true above, so this can never authorize a
    // full/non-additive rebuild. Checked on EVERY chunk (not just offset
    // 0) since there's no server-side session -- cheap Supabase lookup,
    // negligible cost next to the Google billing this gates. Own separate
    // lockout counter so a dispatcher fumbling their PIN doesn't lock out
    // Mark's/TJ's shared admin-secret path for real full rebuilds.
    const qaAuthStore = getStore("dispatch");
    const qaFailKey = "distance-matrix-quickadd-failed-attempts";
    const QA_MAX_FAILED_ATTEMPTS = 5;
    const QA_LOCKOUT_HOURS = 24;
    const qaFailData = (await qaAuthStore.get(qaFailKey, { type: "json" })) || { count: 0, lockedUntil: null };
    if (qaFailData.lockedUntil && Date.now() < new Date(qaFailData.lockedUntil).getTime()) {
      const minsLeft = Math.ceil((new Date(qaFailData.lockedUntil).getTime() - Date.now()) / 60000);
      return json(429, { error: `Too many incorrect Quick Add login attempts -- locked out for ${minsLeft} more minute(s).` });
    }
    const dispatcherAuth = payload.dispatcherAuth || {};
    const supabaseAuth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const verified = await verifyQuickAddAdmin(supabaseAuth, dispatcherAuth.username, dispatcherAuth.pin);
    if (!verified.ok) {
      const newCount = (qaFailData.count || 0) + 1;
      const update = { count: newCount, lockedUntil: null };
      let msg = verified.reason;
      if (newCount >= QA_MAX_FAILED_ATTEMPTS) {
        update.lockedUntil = new Date(Date.now() + QA_LOCKOUT_HOURS * 3600 * 1000).toISOString();
        update.count = 0;
        msg += ` Too many failed attempts -- locked out for ${QA_LOCKOUT_HOURS} hours.`;
      }
      await qaAuthStore.setJSON(qaFailKey, update);
      return json(401, { error: msg });
    }
    if (qaFailData.count) await qaAuthStore.setJSON(qaFailKey, { count: 0, lockedUntil: null });
  } else if (mode === "driving") {
    const requiredSecret = process.env.DISTANCE_MATRIX_ADMIN_PASSWORD;
    if (!requiredSecret) {
      return json(500, { error: "DISTANCE_MATRIX_ADMIN_PASSWORD is not configured -- refusing to run a paid build until it is set." });
    }
    const authStore = getStore("dispatch");
    const failKey = "distance-matrix-failed-attempts";
    const MAX_FAILED_ATTEMPTS = 5;
    const LOCKOUT_HOURS = 24;
    if (offset === 0) {
      const failData = (await authStore.get(failKey, { type: "json" })) || { count: 0, lockedUntil: null };
      if (failData.lockedUntil && Date.now() < new Date(failData.lockedUntil).getTime()) {
        const minsLeft = Math.ceil((new Date(failData.lockedUntil).getTime() - Date.now()) / 60000);
        return json(429, { error: `Too many incorrect admin-secret attempts -- locked out for ${minsLeft} more minute(s) (shared lockout across both distance-matrix build functions).` });
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
    } else {
      if (String(payload.adminSecret || "") !== requiredSecret) {
        return json(401, { error: "Incorrect or missing admin secret for this paid operation." });
      }
    }

    // Cooldown (full rebuild only, same as before) -- additive has no
    // cooldown since it's cheap by design and resuming needs to bypass it
    // anyway. Only checked at a genuine fresh start.
    if (offset === 0 && !additive) {
      const COOLDOWN_HOURS = 24;
      const cooldownStore = getStore("dispatch");
      const cooldownKey = "distance-matrix-cooldown/tech-site/" + state;
      const lastRun = await cooldownStore.get(cooldownKey, { type: "text" });
      if (lastRun) {
        const hoursSince = (Date.now() - new Date(lastRun).getTime()) / 36e5;
        if (hoursSince < COOLDOWN_HOURS) {
          return json(429, { error: `A driving-mode tech-to-site build for ${state} already ran ${hoursSince.toFixed(1)}h ago -- please wait ${(COOLDOWN_HOURS - hoursSince).toFixed(1)}h before running it again.` });
        }
      }
    }
  }

  const store = getStore("dispatch");

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const [{ data: sites, error: sitesErr }, { data: techs, error: techsErr }] = await Promise.all([
    supabase.from("sites").select("id, site_code, lat, lng").eq("state", state).eq("active", true)
      .order("site_code", { ascending: true }), // v5 (2026-09-23): deterministic ordering across chunks, same fix as compute-site-distance-matrix.js v4
    supabase.from("technicians").select("id, slug, lat, lng, active").eq("home_state", state)
      .order("slug", { ascending: true }), // v5: same reasoning, techs are now also chunked across calls
  ]);
  if (sitesErr) return json(500, { error: "sites fetch failed: " + sitesErr.message });
  if (techsErr) return json(500, { error: "technicians fetch failed: " + techsErr.message });

  const techEntries = (techs || [])
    .filter((t) => t.lat != null && t.lng != null && t.active !== false)
    .map((t) => [t.slug, { lat: t.lat, lng: t.lng }]);
  const locEntries = (sites || [])
    .filter((s) => s.lat != null && s.lng != null)
    .map((s) => [s.site_code, { lat: s.lat, lng: s.lng }]);

  const siteIdByCode = Object.fromEntries((sites || []).map((s) => [s.site_code, s.id]));
  const techIdBySlug = Object.fromEntries((techs || []).map((t) => [t.slug, t.id]));

  if (techEntries.length === 0) return json(400, { error: "No techs with lat/lng found for " + state + ". Run geocode-addresses first." });
  if (locEntries.length === 0) return json(400, { error: "No locations with lat/lng found for " + state + ". Run geocode-addresses first." });

  // ── HAVERSINE MODE: unchanged, single call, no chunking needed (no
  // Google API calls at all) ──────────────────────────────────────────────
  if (mode === "haversine") {
    const existingForHaversine = await store.get("distance-matrix/" + state, { type: "json" });
    const existingMatrixForHaversine = (existingForHaversine && existingForHaversine.matrix) || {};
    const matrix = {};
    let preservedDrivingCount = 0;
    for (const [techKey, tech] of techEntries) {
      for (const [locCode, loc] of locEntries) {
        const key = techKey + "|" + locCode;
        const existingEntry = existingMatrixForHaversine[key];
        if (existingEntry && existingEntry.type === "driving") {
          matrix[key] = existingEntry;
          preservedDrivingCount++;
          continue;
        }
        const mi = haversineDistance(tech.lat, tech.lng, loc.lat, loc.lng);
        matrix[key] = { distanceMi: Math.round(mi * 10) / 10, type: "haversine" };
      }
    }
    const meta = {
      state, mode, additive: false,
      computedAt: new Date().toISOString(),
      techCount: techEntries.length,
      locationCount: locEntries.length,
      failedPairs: [],
      preservedDrivingCount,
    };
    await store.setJSON("distance-matrix/" + state, { meta, matrix });
    return json(200, { ok: true, state, mode, additive: false, entryCount: Object.keys(matrix).length, meta, done: true });
  }

  // ── DRIVING MODE: chunked by tech, resumable ────────────────────────────
  const existing = await store.get("distance-matrix/" + state, { type: "json" });
  const existingMatrix = (existing && existing.matrix) || {};

  // Orphaned-build guard -- same shape as compute-site-distance-matrix.js,
  // so admin.html's existing generalized resume-confirm flow handles this
  // function too without any UI changes needed.
  if (offset === 0 && !payload.force && existing && existing.meta && existing.meta.techToSite && existing.meta.techToSite.inProgress) {
    const tf = existing.meta.techToSite;
    return json(409, {
      error: `An interrupted ${state} drive-time build already has ${tf.elementsUsed || 0} billed elements saved (from a previous session that didn't finish). Resume it with offset:${tf.lastOffset || 0} to avoid re-billing that work, or pass force:true to discard it and start completely over.`,
      resumeOffset: tf.lastOffset || 0,
      priorElementsUsed: tf.elementsUsed || 0,
    });
  }

  const techMap = new Map(techEntries);
  const locMap = new Map(locEntries);

  // Resume partial progress between calls.
  const priorPartial = (offset > 0 && existing && existing.meta && existing.meta.techToSite && existing.meta.techToSite.partialMatrix) || {};
  let matrix = { ...priorPartial };
  const priorFailed = (offset > 0 && existing && existing.meta && existing.meta.techToSite && existing.meta.techToSite.failedPairs) || [];
  const failedPairs = [...priorFailed];
  let elementsUsed = (offset > 0 && existing && existing.meta && existing.meta.techToSite && existing.meta.techToSite.elementsUsed) || 0;
  const elementsUsedBeforeThisChunk = elementsUsed;
  let prunedCount = (offset > 0 && existing && existing.meta && existing.meta.techToSite && existing.meta.techToSite.prunedCount) || 0;

  // On a fresh start, carry over whatever's still valid from the existing
  // (pre-this-build) matrix so additive mode's "already covered" pairs
  // don't get re-billed, and drop pairs whose tech/site no longer exists.
  if (offset === 0) {
    matrix = {};
    for (const [key, val] of Object.entries(existingMatrix)) {
      const [techKey, locCode] = key.split("|");
      if (!techMap.has(techKey) || !locMap.has(locCode)) { prunedCount++; continue; }
      if (additive && val.type === "driving") matrix[key] = val;
      // non-additive (full rebuild): nothing carried over, everything gets re-queried.
      // additive + non-driving existing entry: left out, falls into "missing" below.
    }

    // v7 (2026-10-01): additive mode also treats every driving distance already saved in the database
    // as covered (see loadDrivingRows), so nothing the app already owns gets re-priced.
    if (additive) {
      let coverageRows;
      try {
        coverageRows = await loadDrivingRows(supabase, (techs || []).map((t) => t.id));
      } catch (e) {
        return json(500, { error: "existing distances fetch failed: " + e.message });
      }
      const slugById = Object.fromEntries((techs || []).map((t) => [t.id, t.slug]));
      const codeById = Object.fromEntries((sites || []).map((x) => [x.id, x.site_code]));
      for (const r of coverageRows) {
        const slug = slugById[r.technician_id];
        const code = codeById[r.site_id];
        if (!slug || !code || !techMap.has(slug) || !locMap.has(code)) continue;
        const key = slug + "|" + code;
        if (!matrix[key]) {
          matrix[key] = {
            distanceMi: r.distance_mi != null ? Number(r.distance_mi) : null,
            durationMin: r.duration_min != null ? Number(r.duration_min) : null,
            type: "driving",
          };
        }
      }
    }

    // Quick Add ceiling: the server itself refuses a run that would cost more than QUICKADD_MAX_COST
    // after the monthly free allowance, whatever the page claims.
    if (quickAdd) {
      let plannedElements = 0;
      for (const [techKey] of techEntries) {
        for (const [code] of locEntries) if (!matrix[techKey + "|" + code]) plannedElements++;
      }
      const est = estimateCost(plannedElements, await getMonthlyElementsUsed(store));
      if (est.estimatedCost > QUICKADD_MAX_COST) {
        return json(403, {
          ok: false,
          error: `This would cost about $${est.estimatedCost.toFixed(2)}, over the $${QUICKADD_MAX_COST.toFixed(2)} Quick Add limit. Use the advanced tools (password required) for a job this size.`,
        });
      }
    }
  }

  const chunkTechs = techEntries.slice(offset, offset + TECH_BATCHES_PER_CALL);

  for (const [techKey, tech] of chunkTechs) {
    let destCodes;
    if (additive) {
      destCodes = locEntries.map(([code]) => code).filter((code) => !matrix[techKey + "|" + code]);
    } else {
      destCodes = locEntries.map(([code]) => code);
    }
    if (!destCodes.length) continue; // this tech already fully covered
    const results = await queryTechAgainstDestinations(apiKey, techKey, tech, destCodes, locMap, failedPairs);
    for (const [key, val] of Object.entries(results)) {
      matrix[key] = val;
      elementsUsed++;
    }
  }

  const nextOffset = offset + chunkTechs.length;
  const done = nextOffset >= techEntries.length;

  const elementsBilledThisChunk = elementsUsed - elementsUsedBeforeThisChunk;
  let monthlyElementsUsedTotal = null;
  if (elementsBilledThisChunk > 0) {
    monthlyElementsUsedTotal = await addMonthlyElementsUsed(store, elementsBilledThisChunk);
  }

  // Write to Supabase as each chunk completes, not only at the end -- so
  // an interruption partway through never loses or needs to re-bill
  // whichever techs already finished. Blobs (below) remains this
  // function's own resume/orphaned-build bookkeeping; this is purely an
  // additive parallel write, same pattern as compute-site-distance-
  // matrix.js's own Supabase sync.
  const techToSiteRows = [];
  const supabaseSyncSkipped = [];
  for (const [key, entry] of Object.entries(matrix)) {
    const [techSlug, siteCode] = key.split("|");
    const techId = techIdBySlug[techSlug];
    const siteId = siteIdByCode[siteCode];
    if (!techId || !siteId) { supabaseSyncSkipped.push(key); continue; }
    techToSiteRows.push({
      technician_id: techId,
      site_id: siteId,
      mode: entry.type === "driving" ? "driving" : "haversine",
      distance_mi: entry.distanceMi,
      duration_min: entry.durationMin ?? null,
      computed_at: new Date().toISOString(),
    });
  }
  let supabaseSyncError = null;
  if (techToSiteRows.length) {
    const UPSERT_BATCH = 500;
    for (let i = 0; i < techToSiteRows.length; i += UPSERT_BATCH) {
      const batch = techToSiteRows.slice(i, i + UPSERT_BATCH);
      const { error: syncErr } = await supabase
        .from("tech_site_distances")
        .upsert(batch, { onConflict: "technician_id,mode,site_id" });
      if (syncErr) { supabaseSyncError = syncErr.message; break; }
    }
  }

  if (done) {
    const meta = {
      ...((existing && existing.meta) || {}),
      state, mode, additive,
      computedAt: new Date().toISOString(),
      techCount: techEntries.length,
      locationCount: locEntries.length,
      failedPairs,
      elementsUsed,
      prunedCount,
      elementsBilledThisRun: elementsUsed,
      monthlyElementsUsedTotal,
    };
    delete meta.techToSite; // build finished -- clear the in-progress scratch data
    await store.setJSON("distance-matrix/" + state, { meta, matrix });

    if (!additive) {
      await store.set("distance-matrix-cooldown/tech-site/" + state, new Date().toISOString());
    }

    return json(200, {
      ok: true, done: true, state, mode, additive,
      entryCount: Object.keys(matrix).length,
      meta,
      supabaseSync: { written: techToSiteRows.length, skipped: supabaseSyncSkipped.length, error: supabaseSyncError },
    });
  }

  // Not done: persist progress for the next call to resume, without
  // touching the caller's view of "the real matrix" (that only updates on
  // done, mirroring compute-site-distance-matrix.js's own convention).
  const mergedMeta = {
    ...((existing && existing.meta) || {}),
    state,
    techToSite: {
      inProgress: true,
      mode, additive,
      techCount: techEntries.length,
      locationCount: locEntries.length,
      elementsUsed,
      failedPairs,
      partialMatrix: matrix,
      prunedCount,
      lastOffset: nextOffset,
    },
  };
  await store.setJSON("distance-matrix/" + state, { meta: mergedMeta, matrix: existingMatrix });

  return json(200, {
    ok: true, done: false, nextOffset,
    totalBatches: techEntries.length,
    elementsUsed,
    elementsBilledThisChunk,
    monthlyElementsUsedTotal,
    supabaseSync: { written: techToSiteRows.length, skipped: supabaseSyncSkipped.length, error: supabaseSyncError },
  });
};
