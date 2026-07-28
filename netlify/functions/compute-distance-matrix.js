/**
 * compute-distance-matrix.js
 * Admin-triggered function.  Reads stored lat/lng from Supabase (sites and
 * technicians tables), then builds a full technician↔location distance
 * matrix for a state and writes it to Blobs at distance-matrix/{STATE}.
 *
 * v2 (2026-07-28): migrated input from the old Blobs "locations/{STATE}"
 * and "technicians/{STATE}" keys to Supabase, matching the same migration
 * done to geocode-addresses.js and compute-site-distance-matrix.js the
 * same day. Output (the computed matrix itself) is unchanged -- still
 * cached in Blobs, since index.html already reads from there.
 *
 * Two modes:
 *   haversine (default, free) — straight-line distance using stored lat/lng.
 *     Fast, no external API call.  Requires geocode-addresses to have run first.
 *
 *   driving (optional, costs ~$5–$6 per full GA+FL refresh) — actual drive
 *     distance + duration via Google Maps Distance Matrix API.
 *     Batches 25 locations per API request (5 techs × 25 = 125 elements/call,
 *     well under the 625-element limit per request).
 *
 * POST /.netlify/functions/compute-distance-matrix
 * Body: { state: "GA", mode: "haversine"|"driving" }
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
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (mode === "driving" && !apiKey)
    return json(500, { error: "GOOGLE_MAPS_API_KEY env var not set (required for driving mode)" });

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
    computedAt: new Date().toISOString(),
    techCount: techEntries.length,
    locationCount: locEntries.length,
    failedPairs: [],
  };

  // ── HAVERSINE MODE ────────────────────────────────────────────────────────
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
  if (mode === "driving") {
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

  await store.setJSON("distance-matrix/" + state, { meta, matrix });

  return json(200, {
    ok: true,
    state,
    mode,
    entryCount: Object.keys(matrix).length,
    meta,
  });
};
