/**
 * geocode-one.js — added 2026-08-30
 *
 * Read-only, single-address geocode. No Supabase reads/writes at all --
 * deliberately separate from geocode-addresses.js, which is a batch
 * admin tool that geocodes existing sites/techs and writes lat/lng back
 * to the database. This one exists for the "new location from ticket"
 * toast: the address there belongs to a site that doesn't exist in the
 * system yet, so there's nothing to write to and nothing to look up --
 * just geocode the raw string and hand back coordinates for a live
 * haversine distance preview against already-loaded technician coords.
 *
 * POST /.netlify/functions/geocode-one
 * Body: { address: "1056 Rogers Plaza SW Wyoming, MI 49509" }
 * -> { ok: true, lat, lng, formatted } | { ok: false, error }
 *
 * Requires env var: GOOGLE_MAPS_API_KEY (same key geocode-addresses.js uses)
 */

const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return json(500, { ok: false, error: "GOOGLE_MAPS_API_KEY env var not set" });

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { ok: false, error: "Invalid JSON body" });
  }

  const address = String(payload.address || "").trim();
  if (address.length < 8) return json(400, { ok: false, error: "address too short" });
  if (/\bTBD\b|PLACEHOLDER|Address TBD/i.test(address)) {
    return json(400, { ok: false, error: "address looks like a placeholder" });
  }

  try {
    const url = GEOCODE_URL + "?address=" + encodeURIComponent(address) + "&key=" + apiKey;
    const res = await fetch(url);
    if (!res.ok) return json(502, { ok: false, error: "HTTP " + res.status });
    const data = await res.json();
    if (data.status !== "OK" || !data.results?.length) {
      return json(200, { ok: false, error: data.status + (data.error_message ? ": " + data.error_message : "") });
    }
    const loc = data.results[0].geometry.location;
    return json(200, { ok: true, lat: loc.lat, lng: loc.lng, formatted: data.results[0].formatted_address });
  } catch (e) {
    return json(500, { ok: false, error: "exception: " + e.message });
  }
};
