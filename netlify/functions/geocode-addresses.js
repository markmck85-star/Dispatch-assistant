/**
 * geocode-addresses.js
 * Admin-triggered function.  Geocodes location addresses and/or technician
 * home addresses for a given state, then writes lat/lng back into each
 * Blobs record.  Idempotent: records that already have valid coords are
 * skipped unless `force: true` is sent.
 *
 * POST /.netlify/functions/geocode-addresses
 * Body: { state: "GA", type: "locations"|"techs"|"all", force: false }
 *
 * Requires env var: GOOGLE_MAPS_API_KEY
 *
 * Parallel-batch strategy: runs up to CONCURRENCY geocode calls at once so
 * the whole operation finishes well inside Netlify's 10 s function limit
 * even for GA (119 locations) or FL (93 locations).
 */

const { getStore, connectLambda } = require("@netlify/blobs");

const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const CONCURRENCY = 8; // parallel requests per batch

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

/**
 * Call Google Geocoding API for one address.
 * Returns { lat, lng, formatted } or null on failure.
 */
async function geocodeOne(address, apiKey) {
  if (!address || address.trim().length < 8) return { error: "address too short" };
  // Skip placeholder / TBD values
  if (/\bTBD\b|PLACEHOLDER|Address TBD/i.test(address)) return { error: "TBD/placeholder" };
  try {
    const url =
      GEOCODE_URL +
      "?address=" +
      encodeURIComponent(address.trim()) +
      "&key=" +
      apiKey;
    const res = await fetch(url);
    if (!res.ok) return { error: "HTTP " + res.status };
    const data = await res.json();
    if (data.status !== "OK" || !data.results?.length) return { error: data.status + (data.error_message ? ": " + data.error_message : "") };
    const loc = data.results[0].geometry.location;
    return {
      lat: loc.lat,
      lng: loc.lng,
      formatted: data.results[0].formatted_address,
    };
  } catch(e) {
    return { error: "exception: " + e.message };
  }
}

/**
 * Run an array of async tasks with bounded concurrency.
 * tasks: array of () => Promise
 */
async function runBatched(tasks, concurrency) {
  const results = [];
  let i = 0;
  while (i < tasks.length) {
    const batch = tasks.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map((t) => t()));
    results.push(...batchResults);
    i += concurrency;
  }
  return results;
}

exports.handler = async (event) => {
  connectLambda(event);

  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return json(500, { error: "GOOGLE_MAPS_API_KEY env var not set" });

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const state = String(payload.state || "").trim().toUpperCase();
  if (!state || !/^[A-Z]{2}$/.test(state))
    return json(400, { error: "Valid 2-letter state required" });

  const type = payload.type || "all"; // "locations" | "techs" | "all"
  const force = payload.force === true;

  const store = getStore("dispatch");

  const results = {
    locations: { total: 0, geocoded: 0, skipped: 0, failed: [] },
    techs: { total: 0, geocoded: 0, skipped: 0, failed: [] },
  };

  // ── GEOCODE LOCATIONS ─────────────────────────────────────────────────────
  if (type === "locations" || type === "all") {
    const locations =
      (await store.get("locations/" + state, { type: "json" })) || {};
    const codes = Object.keys(locations);
    results.locations.total = codes.length;

    const tasks = codes.map((code) => async () => {
      const loc = locations[code];
      if (!force && loc.lat && loc.lng) {
        results.locations.skipped++;
        return;
      }
      const addr = (loc.address || "").trim();
      const geo = await geocodeOne(addr, apiKey);
      if (geo?.lat) {
        locations[code].lat = geo.lat;
        locations[code].lng = geo.lng;
        locations[code].geoFormatted = geo.formatted;
        locations[code].geoAt = new Date().toISOString();
        results.locations.geocoded++;
      } else {
        results.locations.failed.push({ code, address: addr.substring(0,40), reason: geo?.error || "No result" });
      }
    });

    await runBatched(tasks, CONCURRENCY);
    await store.setJSON("locations/" + state, locations);
  }

  // ── GEOCODE TECHNICIANS ───────────────────────────────────────────────────
  if (type === "techs" || type === "all") {
    const techs =
      (await store.get("technicians/" + state, { type: "json" })) || {};
    const keys = Object.keys(techs);
    results.techs.total = keys.length;

    const tasks = keys.map((key) => async () => {
      const tech = techs[key];
      if (!force && tech.lat && tech.lng) {
        results.techs.skipped++;
        return;
      }
      const addr = (tech.homeAddress || tech.startLocation || "").trim();
      const geo = await geocodeOne(addr, apiKey);
      if (geo?.lat) {
        techs[key].lat = geo.lat;
        techs[key].lng = geo.lng;
        techs[key].geoFormatted = geo.formatted;
        techs[key].geoAt = new Date().toISOString();
        results.techs.geocoded++;
      } else {
        results.techs.failed.push({ key, address: addr.substring(0,40), reason: geo?.error || "No result" });
      }
    });

    await runBatched(tasks, CONCURRENCY);
    await store.setJSON("technicians/" + state, techs);
  }

  return json(200, { ok: true, state, type, force, results });
};
