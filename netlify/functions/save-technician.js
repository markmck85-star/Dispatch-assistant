/**
 * save-technician.js  (updated — v2 with auto-geocode)
 * Saves a technician record to Blobs.  If a homeAddress is provided and
 * GOOGLE_MAPS_API_KEY is configured, automatically geocodes the address
 * and stores lat/lng in the record.  Re-geocoding is triggered whenever
 * homeAddress changes (detected by comparing against the stored value).
 *
 * POST /.netlify/functions/save-technician
 * Body: { name, state, phone, email, homeAddress, smsAddress, active }
 *
 * Optional env var: GOOGLE_MAPS_API_KEY (geocoding is skipped if absent)
 */

const { getStore, connectLambda } = require("@netlify/blobs");
const { createClient } = require("@supabase/supabase-js");

const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

function getDispatchStore() {
  return getStore("dispatch");
}

async function geocodeAddress(address, apiKey) {
  if (!apiKey || !address || address.trim().length < 8) return null;
  if (/\bTBD\b|PLACEHOLDER/i.test(address)) return null;
  try {
    const url =
      GEOCODE_URL +
      "?address=" +
      encodeURIComponent(address.trim()) +
      "&key=" +
      apiKey;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== "OK" || !data.results?.length) return null;
    const loc = data.results[0].geometry.location;
    return {
      lat: loc.lat,
      lng: loc.lng,
      formatted: data.results[0].formatted_address,
    };
  } catch {
    return null;
  }
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

  const name = String(payload.name || "").trim();
  if (!name) return json(400, { error: "Technician name is required" });

  const state = String(payload.state || payload.region || "").trim().toUpperCase();
  if (!state) return json(400, { error: "State/region is required" });

  const homeAddress = String(payload.homeAddress || "").trim();

  const store = getDispatchStore();
  const key = "technicians/" + state;
  const techKey = name.toLowerCase().replace(/\s+/g, "-");

  // Geocoding is a side calculation based only on the submitted address, not
  // on the rest of the stored record -- safe to do once, outside the
  // concurrency-safe retry loop below, so a conflict-triggered retry doesn't
  // waste an extra Google Maps API call re-geocoding the same address.
  const initial = (await store.get(key, { type: "json" })) || {};
  const initialPrev = initial[techKey] || {};

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  let lat = initialPrev.lat || null;
  let lng = initialPrev.lng || null;
  let geoFormatted = initialPrev.geoFormatted || null;
  let geoAt = initialPrev.geoAt || null;

  const addressChanged = homeAddress && homeAddress !== (initialPrev.homeAddress || "");
  const missingCoords = homeAddress && (!lat || !lng);

  if (apiKey && homeAddress && (addressChanged || missingCoords)) {
    const geo = await geocodeAddress(homeAddress, apiKey);
    if (geo) {
      lat = geo.lat;
      lng = geo.lng;
      geoFormatted = geo.formatted;
      geoAt = new Date().toISOString();
    }
  }

  const record = {
    name,
    state,
    phone: String(payload.phone || "").trim(),
    email: String(payload.email || "").trim(),
    homeAddress,
    smsAddress: String(payload.smsAddress || "").trim(),
    active: payload.active !== false,
    updatedAt: new Date().toISOString(),
  };
  if (lat != null && lng != null) {
    record.lat = lat;
    record.lng = lng;
    record.geoFormatted = geoFormatted;
    record.geoAt = geoAt;
  }

  // Netlify Blobs has no built-in locking -- same read-modify-write race as
  // save-location.js (see comments there), fixed the same way: optimistic
  // concurrency with a verified retry rather than a single unconditional
  // read-modify-write against the whole per-state blob.
  const MAX_ATTEMPTS = 6;
  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const current = await store.getWithMetadata(key, { type: "json" });
      const existing = (current && current.data) || {};
      const etag = current && current.etag;
      const prev = existing[techKey] || {};
      const merged = { ...prev, ...record };
      existing[techKey] = merged;

      const writeOpts = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
      await store.setJSON(key, existing, writeOpts);

      const verify = await store.get(key, { type: "json" });
      if (verify && JSON.stringify(verify[techKey]) === JSON.stringify(merged)) {
        // Additive Supabase sync (admin-panel-to-Supabase gap fix). Blobs is
        // still what the live app reads; this keeps the technicians table
        // (used by save-assignment.js/get-assignments.js lookups) from going
        // stale. Never blocks or fails the Blobs write above.
        if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
          try {
            const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
            const slug = techKey; // same derivation as the Blobs key, kept consistent across both stores
            const techRow = {
              slug,
              name,
              home_state: state,
              phone: merged.phone || null,
              email: merged.email || null,
              sms_address: merged.smsAddress || null,
              home_address: merged.homeAddress || null,
              active: merged.active !== false,
            };
            if (merged.lat != null && merged.lng != null) {
              techRow.lat = merged.lat;
              techRow.lng = merged.lng;
              techRow.geocoded_at = merged.geoAt || new Date().toISOString();
            }
            const { error: supaErr } = await supabase.from("technicians").upsert(techRow, { onConflict: "slug" });
            if (supaErr) console.error("[save-technician] Supabase sync failed (non-fatal):", supaErr.message);
          } catch (supaEx) {
            console.error("[save-technician] Supabase sync error (non-fatal):", supaEx.message);
          }
        }
        return json(200, { ok: true, technician: merged });
      }
      lastErr = new Error("Write did not verify -- concurrent update detected, retrying");
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 80 + Math.random() * 220));
  }

  return json(500, { error: "Failed to save technician after concurrent-write retries: " + (lastErr && lastErr.message) });
};
