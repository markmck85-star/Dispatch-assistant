/**
 * geocode-addresses.js
 * Admin-triggered function. Geocodes location addresses and/or technician
 * home addresses for a given state, then writes lat/lng back into Supabase.
 * Idempotent: records that already have valid coords are skipped unless
 * `force: true` is sent.
 *
 * POST /.netlify/functions/geocode-addresses
 * Body: { state: "GA", type: "locations"|"techs"|"all", force: false }
 *
 * Requires env vars: GOOGLE_MAPS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * v2 (2026-07-28): rewritten to read/write Supabase sites/technicians
 * tables directly instead of the old Blobs "dispatch" store. This was the
 * real cause behind a new site (added via the dispatch-page toast, which
 * writes into Supabase now) never being findable by this function no
 * matter how many times it was run -- this function was still entirely
 * Blobs-based, left behind when get-locations.js/get-technicians.js were
 * migrated to Supabase-primary reads earlier this week. Same gap existed
 * in compute-site-distance-matrix.js and compute-distance-matrix.js,
 * fixed alongside this.
 *
 * Parallel-batch strategy unchanged: runs up to CONCURRENCY geocode calls
 * at once so the whole operation finishes well inside Netlify's function
 * time budget even for larger states.
 */

const { createClient } = require("@supabase/supabase-js");

const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const CONCURRENCY = 8;

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

async function geocodeOne(address, apiKey) {
  if (!address || address.trim().length < 8) return { error: "address too short" };
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
  } catch (e) {
    return { error: "exception: " + e.message };
  }
}

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

  const type = payload.type || "all";
  const force = payload.force === true;

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const results = {
    locations: { total: 0, geocoded: 0, skipped: 0, failed: [] },
    techs: { total: 0, geocoded: 0, skipped: 0, failed: [] },
  };

  // ── GEOCODE LOCATIONS (sites table) ────────────────────────────────────
  if (type === "locations" || type === "all") {
    const { data: sites, error: sitesErr } = await supabase
      .from("sites")
      .select("id, site_code, address, lat, lng")
      .eq("state", state);
    if (sitesErr) return json(500, { error: "sites fetch failed: " + sitesErr.message });

    results.locations.total = sites.length;

    const tasks = sites.map((site) => async () => {
      if (!force && site.lat != null && site.lng != null) {
        results.locations.skipped++;
        return;
      }
      const addr = (site.address || "").trim();
      const geo = await geocodeOne(addr, apiKey);
      if (geo?.lat) {
        const { error: updateErr } = await supabase
          .from("sites")
          .update({ lat: geo.lat, lng: geo.lng })
          .eq("id", site.id);
        if (updateErr) {
          results.locations.failed.push({ code: site.site_code, address: addr.substring(0, 40), reason: "write failed: " + updateErr.message });
        } else {
          results.locations.geocoded++;
        }
      } else {
        results.locations.failed.push({ code: site.site_code, address: addr.substring(0, 40), reason: geo?.error || "No result" });
      }
    });

    await runBatched(tasks, CONCURRENCY);
  }

  // ── GEOCODE TECHNICIANS ─────────────────────────────────────────────────
  if (type === "techs" || type === "all") {
    const { data: techs, error: techsErr } = await supabase
      .from("technicians")
      .select("id, slug, name, home_address, lat, lng")
      .eq("home_state", state);
    if (techsErr) return json(500, { error: "technicians fetch failed: " + techsErr.message });

    results.techs.total = techs.length;

    const tasks = techs.map((tech) => async () => {
      if (!force && tech.lat != null && tech.lng != null) {
        results.techs.skipped++;
        return;
      }
      const addr = (tech.home_address || "").trim();
      const geo = await geocodeOne(addr, apiKey);
      if (geo?.lat) {
        const { error: updateErr } = await supabase
          .from("technicians")
          .update({ lat: geo.lat, lng: geo.lng, geocoded_at: new Date().toISOString() })
          .eq("id", tech.id);
        if (updateErr) {
          results.techs.failed.push({ key: tech.slug || tech.name, address: addr.substring(0, 40), reason: "write failed: " + updateErr.message });
        } else {
          results.techs.geocoded++;
        }
      } else {
        results.techs.failed.push({ key: tech.slug || tech.name, address: addr.substring(0, 40), reason: geo?.error || "No result" });
      }
    });

    await runBatched(tasks, CONCURRENCY);
  }

  return json(200, { ok: true, state, type, force, results });
};
