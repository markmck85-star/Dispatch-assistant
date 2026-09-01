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
 *     Fast, no external API call. Always a full rebuild (it's free either
 *     way, so there's no reason to do partial haversine runs).
 *
 *   driving (optional, costs ~$5–$6 per full GA+FL refresh) — actual drive
 *     distance + duration via Google Maps Distance Matrix API.
 *     Batches 25 locations per API request (5 techs × 25 = 125 elements/call,
 *     well under the 625-element limit per request). Pass additive: true to
 *     only price/query pairs missing from the existing cached matrix.
 *
 * POST /.netlify/functions/compute-distance-matrix
 * Body: { state: "GA", mode: "haversine"|"driving", additive?: true, adminSecret?: "..." }
 *
 * Requires env var: GOOGLE_MAPS_API_KEY (only for driving mode)
 *
 * Matrix Blobs key: distance-matrix/{STATE}
 * Matrix entry key format: "{techKey}|{locationCode}"
 * e.g. "robert-medley|GA1001" → { distanceMi: 12.3, durationMin: 18, type: "driving" }
 */

const { getStore, connectLambda } = require("@netlify/blobs");
const { createClient } = require("@supabase/supabase-js");

const MATRIX_URL = "https://maps.googleapis.com/maps/api/distancematrix/json";
const DEST_BATCH = 10; // destinations per Distance Matrix API call (9 techs × 10 = 90 elements, under 100-element limit)
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
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (mode === "driving" && !apiKey)
    return json(500, { error: "GOOGLE_MAPS_API_KEY env var not set (required for driving mode)" });

  // Same paid-action gate as compute-site-distance-matrix.js (2026-08-18).
  // Both functions check the same DISTANCE_MATRIX_ADMIN_PASSWORD and share
  // the same brute-force lockout counter below (2026-09-02) -- guessing
  // against either endpoint counts against the same limit, since they
  // guard the same secret.
  if (mode === "driving") {
    const requiredSecret = process.env.DISTANCE_MATRIX_ADMIN_PASSWORD;
    if (!requiredSecret) {
      return json(500, { error: "DISTANCE_MATRIX_ADMIN_PASSWORD is not configured -- refusing to run a paid build until it is set." });
    }

    // Brute-force lockout (2026-09-02): shared across compute-distance-matrix.js
    // and compute-site-distance-matrix.js via the same Blobs key, since both
    // check the same password. A few wrong guesses locks out ALL driving-mode
    // builds (both functions) for 24h -- makes even a short admin password
    // impractical to brute-force (a 4-digit PIN is 10,000 combos; 5 guesses
    // then a 24h lockout means an attacker gets ~5 guesses/day, not 10,000/minute).
    const authStore = getStore("dispatch");
    const failKey = "distance-matrix-failed-attempts";
    const MAX_FAILED_ATTEMPTS = 5;
    const LOCKOUT_HOURS = 24;
    const failData = (await authStore.get(failKey, { type: "json" })) || { count: 0, lockedUntil: null };

    if (failData.lockedUntil && Date.now() < new Date(failData.lockedUntil).getTime()) {
      const minsLeft = Math.ceil((new Date(failData.lockedUntil).getTime() - Date.now()) / 60000);
      return json(429, {
        error: `Too many incorrect admin-secret attempts -- locked out for ${minsLeft} more minute(s) (shared lockout across both distance-matrix build functions).`,
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

    // Correct password -- clear any accumulated failed-attempt count.
    if (failData.count) await authStore.setJSON(failKey, { count: 0, lockedUntil: null });

    // Additive builds only touch a handful of new pairs -- the 24h
    // "already ran" cooldown below exists to prevent repeat FULL-price
    // rebuilds, so it doesn't apply to additive. A much shorter loop-guard
    // applies to additive instead, just to catch a genuine runaway/stuck
    // loop -- not a cost concern, additive builds are cheap by design.
    if (additive) {
      const ADDITIVE_COOLDOWN_MINUTES = 2;
      const addCooldownKey = "distance-matrix-cooldown/additive/" + state;
      const lastAdd = await authStore.get(addCooldownKey, { type: "text" });
      if (lastAdd) {
        const minsSince = (Date.now() - new Date(lastAdd).getTime()) / 60000;
        if (minsSince < ADDITIVE_COOLDOWN_MINUTES) {
          return json(429, {
            error: `An additive build for ${state} already ran ${minsSince.toFixed(1)} min ago -- please wait ${(ADDITIVE_COOLDOWN_MINUTES - minsSince).toFixed(1)} more minute(s) before running it again (loop-guard, not a cost concern).`,
          });
        }
      }
      await authStore.set(addCooldownKey, new Date().toISOString());
    }

    if (!additive) {
      const COOLDOWN_HOURS = 24;
      const cooldownStore = getStore("dispatch");
      const cooldownKey = "distance-matrix-cooldown/tech-site/" + state;
      const lastRun = await cooldownStore.get(cooldownKey, { type: "text" });
      if (lastRun) {
        const hoursSince = (Date.now() - new Date(lastRun).getTime()) / 36e5;
        if (hoursSince < COOLDOWN_HOURS) {
          return json(429, {
            error: `A driving-mode tech-to-site build for ${state} already ran ${hoursSince.toFixed(1)}h ago -- please wait ${(COOLDOWN_HOURS - hoursSince).toFixed(1)}h before running it again.`,
          });
        }
      }
      await cooldownStore.set(cooldownKey, new Date().toISOString());
    }
  }

  const store = getStore("dispatch");

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const [{ data: sites, error: sitesErr }, { data: techs, error: techsErr }] = await Promise.all([
    supabase.from("sites").select("site_code, lat, lng").eq("state", state),
    supabase.from("technicians").select("slug, lat, lng, active").eq("home_state", state),
  ]);
  if (sitesErr) return json(500, { error: "sites fetch failed: " + sitesErr.message });
  if (techsErr) return json(500, { error: "technicians fetch failed: " + techsErr.message });

  // Filter to entries that have geocoded coords and are active
  const techEntries = (techs || [])
    .filter((t) => t.lat != null && t.lng != null && t.active !== false)
    .map((t) => [t.slug, { lat: t.lat, lng: t.lng }]);
  const locEntries = (sites || [])
    .filter((s) => s.lat != null && s.lng != null)
    .map((s) => [s.site_code, { lat: s.lat, lng: s.lng }]);

  if (techEntries.length === 0)
    return json(400, {
      error: "No techs with lat/lng found for " + state + ". Run geocode-addresses first.",
    });
  if (locEntries.length === 0)
    return json(400, {
      error: "No locations with lat/lng found for " + state + ". Run geocode-addresses first.",
    });

  const matrix = {};
  const meta = {
    state,
    mode,
    additive,
    computedAt: new Date().toISOString(),
    techCount: techEntries.length,
    locationCount: locEntries.length,
    failedPairs: [],
  };

  // ── HAVERSINE MODE (always a full rebuild -- it's free) ────────────────
  if (mode === "haversine") {
    for (const [techKey, tech] of techEntries) {
      for (const [locCode, loc] of locEntries) {
        const mi = haversineDistance(tech.lat, tech.lng, loc.lat, loc.lng);
        matrix[techKey + "|" + locCode] = {
          distanceMi: Math.round(mi * 10) / 10,
          type: "haversine",
        };
      }
    }
  }

  // ── DRIVING MODE (Google Maps Distance Matrix API) ─────────────────────
  if (mode === "driving" && !additive) {
    const origins = techEntries
      .map(([, t]) => `${t.lat},${t.lng}`)
      .join("|");

    for (let i = 0; i < locEntries.length; i += DEST_BATCH) {
      const batch = locEntries.slice(i, i + DEST_BATCH);
      const destinations = batch.map(([, l]) => `${l.lat},${l.lng}`).join("|");

      const url =
        MATRIX_URL +
        "?origins=" +
        encodeURIComponent(origins) +
        "&destinations=" +
        encodeURIComponent(destinations) +
        "&units=imperial" +
        "&key=" +
        apiKey;

      try {
        const res = await fetch(url);
        const data = await res.json();

        if (data.status !== "OK") {
          meta.failedPairs.push({
            batchStart: i,
            reason: "API status: " + data.status,
          });
          continue;
        }

        data.rows.forEach((row, ti) => {
          const [techKey] = techEntries[ti];
          row.elements.forEach((el, di) => {
            const [locCode] = batch[di];
            if (el.status === "OK") {
              matrix[techKey + "|" + locCode] = {
                distanceMi: Math.round((el.distance.value / 1609.34) * 10) / 10,
                durationMin: Math.round(el.duration.value / 60),
                distanceText: el.distance.text,
                durationText: el.duration.text,
                type: "driving",
              };
            } else {
              meta.failedPairs.push({
                techKey,
                locCode,
                reason: "Element status: " + el.status,
              });
              // Fall back to haversine for this pair
              const [, tech] = techEntries[ti];
              const [, loc] = batch[di];
              const mi = haversineDistance(tech.lat, tech.lng, loc.lat, loc.lng);
              matrix[techKey + "|" + locCode] = {
                distanceMi: Math.round(mi * 10) / 10,
                type: "haversine-fallback",
              };
            }
          });
        });
      } catch (err) {
        meta.failedPairs.push({
          batchStart: i,
          reason: "Network error: " + err.message,
        });
      }

      // Brief pause between API batches
      if (i + DEST_BATCH < locEntries.length) await sleep(150);
    }
  }

  // ── DRIVING MODE, ADDITIVE (only new tech/site pairs) ───────────────────
  if (mode === "driving" && additive) {
    const existing = await store.get("distance-matrix/" + state, { type: "json" });
    const existingMatrix = (existing && existing.matrix) || {};

    const techMap = new Map(techEntries);
    const locMap = new Map(locEntries);

    // Carry over every existing pair whose tech AND site both still exist
    // and are still active -- this is what quietly drops a departed tech
    // (or a removed/renamed site) at zero cost, no API call needed.
    let prunedCount = 0;
    for (const [key, val] of Object.entries(existingMatrix)) {
      const [techKey, locCode] = key.split("|");
      if (techMap.has(techKey) && locMap.has(locCode)) {
        matrix[key] = val;
      } else {
        prunedCount++;
      }
    }

    // Find every pair that SHOULD exist but doesn't yet (new tech, new
    // site, or both), grouped by tech so each tech only needs one origin
    // per API call.
    const missingByTech = new Map(); // techKey -> [locCode, ...]
    for (const [techKey] of techEntries) {
      for (const [locCode] of locEntries) {
        const key = techKey + "|" + locCode;
        if (!matrix[key]) {
          if (!missingByTech.has(techKey)) missingByTech.set(techKey, []);
          missingByTech.get(techKey).push(locCode);
        }
      }
    }

    let addedCount = 0;
    for (const [techKey, missingLocCodes] of missingByTech) {
      const tech = techMap.get(techKey);
      for (let i = 0; i < missingLocCodes.length; i += DEST_BATCH) {
        const batchCodes = missingLocCodes.slice(i, i + DEST_BATCH);
        const destinations = batchCodes
          .map((code) => { const l = locMap.get(code); return `${l.lat},${l.lng}`; })
          .join("|");

        const url =
          MATRIX_URL +
          "?origins=" + encodeURIComponent(`${tech.lat},${tech.lng}`) +
          "&destinations=" + encodeURIComponent(destinations) +
          "&units=imperial" +
          "&key=" + apiKey;

        try {
          const res = await fetch(url);
          const data = await res.json();

          if (data.status !== "OK") {
            meta.failedPairs.push({ techKey, batchStart: i, reason: "API status: " + data.status });
          } else {
            const row = data.rows[0];
            row.elements.forEach((el, di) => {
              const locCode = batchCodes[di];
              const key = techKey + "|" + locCode;
              if (el.status === "OK") {
                matrix[key] = {
                  distanceMi: Math.round((el.distance.value / 1609.34) * 10) / 10,
                  durationMin: Math.round(el.duration.value / 60),
                  distanceText: el.distance.text,
                  durationText: el.duration.text,
                  type: "driving",
                };
              } else {
                meta.failedPairs.push({ techKey, locCode, reason: "Element status: " + el.status });
                const loc = locMap.get(locCode);
                const mi = haversineDistance(tech.lat, tech.lng, loc.lat, loc.lng);
                matrix[key] = { distanceMi: Math.round(mi * 10) / 10, type: "haversine-fallback" };
              }
              addedCount++;
            });
          }
        } catch (err) {
          meta.failedPairs.push({ techKey, batchStart: i, reason: "Network error: " + err.message });
        }

        await sleep(150);
      }
    }

    meta.addedCount = addedCount;
    meta.prunedCount = prunedCount;
    meta.reusedCount = Object.keys(matrix).length - addedCount;
  }

  await store.setJSON("distance-matrix/" + state, { meta, matrix });

  return json(200, {
    ok: true,
    state,
    mode,
    additive,
    entryCount: Object.keys(matrix).length,
    meta,
  });
};
