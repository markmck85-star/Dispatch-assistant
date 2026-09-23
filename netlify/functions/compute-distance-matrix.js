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
 * POST /.netlify/functions/compute-distance-matrix
 * Body: { state: "GA", mode: "haversine"|"driving", additive?: true,
 *         offset?: 0, adminSecret?: "...", force?: true }
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

const MATRIX_URL = "https://maps.googleapis.com/maps/api/distancematrix/json";
const DEST_BATCH = 10; // destinations per Distance Matrix API call
const TECH_BATCHES_PER_CALL = 1; // techs (each with their own full destination sweep) processed per invocation -- see v5 comment above
const R_MI = 3958.8;  // Earth radius in miles

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

  const state = String(payload.state || "").trim().toUpperCase();
  if (!state || !/^[A-Z]{2}$/.test(state))
    return json(400, { error: "Valid 2-letter state required" });

  const mode = payload.mode === "driving" ? "driving" : "haversine";
  const additive = mode === "driving" && payload.additive === true;
  const offset = Number.isInteger(payload.offset) ? payload.offset : 0;
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (mode === "driving" && !apiKey)
    return json(500, { error: "GOOGLE_MAPS_API_KEY env var not set (required for driving mode)" });

  // Dry-run cost preview -- free, no password needed, no API call to Google.
  if (payload.dryRun === true && mode === "driving") {
    const dryStore = getStore("dispatch");
    const supabasePreview = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const [{ data: pSites, error: pSitesErr }, { data: pTechs, error: pTechsErr }] = await Promise.all([
      supabasePreview.from("sites").select("site_code").eq("state", state).eq("active", true),
      supabasePreview.from("technicians").select("slug").eq("home_state", state).eq("active", true),
    ]);
    if (pSitesErr) return json(500, { ok: false, error: "sites fetch failed: " + pSitesErr.message });
    if (pTechsErr) return json(500, { ok: false, error: "technicians fetch failed: " + pTechsErr.message });

    const siteCount = (pSites || []).length;
    const techCount = (pTechs || []).length;

    let elementCount;
    if (additive) {
      const existing = await dryStore.get("distance-matrix/" + state, { type: "json" });
      const existingMatrix = (existing && existing.matrix) || {};
      const siteCodes = new Set((pSites || []).map((s) => s.site_code));
      const techSlugs = new Set((pTechs || []).map((t) => t.slug));
      let alreadyCovered = 0;
      for (const [key, val] of Object.entries(existingMatrix)) {
        const [techKey, locCode] = key.split("|");
        if (techSlugs.has(techKey) && siteCodes.has(locCode) && val.type === "driving") alreadyCovered++;
      }
      elementCount = Math.max(0, techCount * siteCount - alreadyCovered);
    } else {
      elementCount = techCount * siteCount;
    }

    const usedThisMonth = await getMonthlyElementsUsed(dryStore);
    const preview = estimateCost(elementCount, usedThisMonth);
    return json(200, { ok: true, state, mode, additive, elementCount, techCount, siteCount, ...preview });
  }

  // Password gate -- shared lockout with compute-site-distance-matrix.js.
  // Only re-checked on a genuine fresh start (offset 0); a resume call
  // still must present the password on every request, just skips the
  // lockout bookkeeping since it already passed once.
  if (mode === "driving") {
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
