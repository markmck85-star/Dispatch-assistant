/**
 * get-technicians.js — v2 — Phase 2 Stage 3 (techs read cutover)
 *
 * Now reads from Supabase `technicians` (source of truth going forward)
 * instead of Blobs. Falls back to the old Blobs read if Supabase isn't
 * configured or the query errors, matching the same pattern used in the
 * companion get-locations.js rewrite.
 *
 * Returned shape is unchanged from the Blobs version so index.html doesn't
 * need any changes: an object keyed by tech slug, each value shaped like
 * { name, state, phone, email, homeAddress, smsAddress, active, lat, lng,
 *   geoFormatted, geoAt }.
 */

const { getStore, connectLambda } = require("@netlify/blobs");
const { createClient } = require("@supabase/supabase-js");

function getDispatchStore() {
  return getStore("dispatch");
}

async function readFromBlobs(state) {
  try {
    const store = getDispatchStore();
    const data = await store.get("technicians/" + state, { type: "json" });
    return data || {};
  } catch (err) {
    return {};
  }
}

exports.handler = async (event) => {
  connectLambda(event);
  const params = event.queryStringParameters || {};
  const state = (params.state || "").trim().toUpperCase();

  if (!state || !/^[A-Z]{2}$/.test(state)) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing or invalid state parameter" }),
    };
  }

  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

      const { data: techs, error: techErr } = await supabase
        .from("technicians")
        .select("slug, name, home_state, phone, email, home_address, sms_address, active, lat, lng, geocoded_at")
        .eq("home_state", state);

      if (techErr) throw techErr;

      const result = {};
      for (const t of (techs || [])) {
        result[t.slug] = {
          name: t.name,
          state: t.home_state,
          phone: t.phone || "",
          email: t.email || "",
          homeAddress: t.home_address || "",
          smsAddress: t.sms_address || "",
          active: t.active !== false,
          ...(t.lat != null && t.lng != null ? {
            lat: t.lat,
            lng: t.lng,
            geoAt: t.geocoded_at || null,
          } : {}),
        };
      }

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result),
      };
    } catch (err) {
      console.error("[get-technicians] Supabase read failed, falling back to Blobs:", err.message);
      const fallback = await readFromBlobs(state);
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fallback),
      };
    }
  }

  // Supabase not configured -- old behavior
  const data = await readFromBlobs(state);
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  };
};
