/**
 * get-tech-availability.js — v1 — added 2026-07-21
 *
 * Netlify Function — reads BlueFolder-synced technician_availability rows
 * (written every 30 min by bluefolder-sync.js) for a date range, joined to
 * technician name so the frontend doesn't need its own id lookups. Only
 * available=false rows are returned -- absence of a row already means
 * "available" everywhere else in the app, so there's nothing useful to the
 * frontend in the available=true rows.
 *
 * GET /.netlify/functions/get-tech-availability?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 * -> { availability: [ { techName, day, reason, note } ] }
 *
 * startDate/endDate are both optional. Default window is today -> +60 days,
 * matching the same rolling window bluefolder-sync.js pulls from BlueFolder,
 * since there's no point caching further out than the source data covers.
 */
const { createClient } = require("@supabase/supabase-js");

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(obj),
  };
}

function isoDate(d) { return d.toISOString().slice(0, 10); }

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (event.httpMethod !== "GET") return json(405, { error: "Method Not Allowed" });

  const params = event.queryStringParameters || {};
  const today = new Date();
  const defaultEnd = new Date();
  defaultEnd.setDate(defaultEnd.getDate() + 60);

  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(params.startDate) ? params.startDate : isoDate(today);
  const endDate = /^\d{4}-\d{2}-\d{2}$/.test(params.endDate) ? params.endDate : isoDate(defaultEnd);

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: "Supabase env vars not configured" });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data, error } = await supabase
      .from("technician_availability")
      .select("day, reason, note, available, technicians(name)")
      .eq("available", false)
      .gte("day", startDate)
      .lte("day", endDate);

    if (error) return json(500, { error: "Query failed: " + error.message });

    const availability = (data || [])
      .filter(row => row.technicians) // defensive: skip any row with a dangling technician_id
      .map(row => ({
        techName: row.technicians.name,
        day: row.day,
        reason: row.reason,
        note: row.note,
      }));

    return json(200, { availability });
  } catch (err) {
    return json(500, { error: "Unexpected error: " + err.message });
  }
};
