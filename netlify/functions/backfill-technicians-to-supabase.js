/**
 * backfill-technicians-to-supabase.js — ONE-TIME USE, safe to delete after running
 *
 * save-technician.js started syncing every save to Supabase's `technicians`
 * table on top of its existing Blobs write (the admin panel's Locations/
 * Technicians tabs still read and write Blobs, which remains the source of
 * truth for the admin UI) -- but that sync only fires when someone actually
 * hits "Save Technician" again. Anyone whose Blobs record predates that
 * change, and who hasn't been re-saved since, never got a matching row
 * created in Supabase. Confirmed 2026-08-15: Sean Reich, Nyzier Moore, and
 * Robert Medley all show correctly as Active in the admin panel (Blobs) but
 * were missing from the RMA shipments technician dropdown, which reads the
 * Supabase `technicians` table.
 *
 * This walks every state's Blobs technician list and upserts each record
 * into Supabase using the exact same slug/field mapping save-technician.js
 * already uses, so the two stores end up consistent going forward.
 *
 * Visit once in a browser:
 *   https://mcrdispatch.net/.netlify/functions/backfill-technicians-to-supabase?confirm=yes
 *
 * Safe to run more than once (upsert on slug, never duplicates). Delete this
 * file from netlify/functions/ once you've confirmed the RMA shipments page
 * shows everyone.
 */
const { getStore, connectLambda } = require("@netlify/blobs");
const { createClient } = require("@supabase/supabase-js");

const STATES = ["GA", "FL", "NC", "SC", "MI", "IN", "OH", "NV", "IL", "MN", "WV", "OR", "CO", "ID"];

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  connectLambda(event);
  const confirm = (event.queryStringParameters || {}).confirm;
  if (confirm !== "yes") {
    return json(400, { error: "Add ?confirm=yes to the URL to run this backfill." });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: "Supabase env vars not configured" });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const store = getStore("dispatch");

  const results = {};
  const errors = [];

  for (const state of STATES) {
    let techs;
    try {
      techs = (await store.get("technicians/" + state, { type: "json" })) || {};
    } catch (err) {
      errors.push(`${state}: Blobs read failed -- ${err.message}`);
      continue;
    }

    const slugs = Object.keys(techs);
    if (slugs.length === 0) {
      results[state] = 0;
      continue;
    }

    // Same field mapping as save-technician.js's sync block, so a record
    // backfilled here looks identical to one that arrived via a normal save.
    const rows = slugs.map((slug) => {
      const t = techs[slug];
      const row = {
        slug,
        name: t.name,
        home_state: t.state || state,
        phone: t.phone || null,
        email: t.email || null,
        sms_address: t.smsAddress || null,
        home_address: t.homeAddress || null,
        active: t.active !== false,
      };
      if (t.lat != null && t.lng != null) {
        row.lat = t.lat;
        row.lng = t.lng;
        row.geocoded_at = t.geoAt || null;
      }
      return row;
    });

    const { error } = await supabase.from("technicians").upsert(rows, { onConflict: "slug" });
    if (error) {
      errors.push(`${state}: Supabase upsert failed -- ${error.message}`);
      continue;
    }
    results[state] = rows.length;
  }

  return json(200, {
    ok: errors.length === 0,
    techniciansWritten: results,
    totalWritten: Object.values(results).reduce((a, b) => a + b, 0),
    errors,
    message: errors.length === 0
      ? "Done. Check the RMA shipments technician dropdown for each state. You can delete this function file now."
      : "Completed with some errors -- see the errors array. Safe to re-run.",
  });
};
