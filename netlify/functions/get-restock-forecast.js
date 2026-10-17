/**
 * get-restock-forecast.js — v1, 2026-10-17
 *
 * Estimated forms-roll counts per site for a chosen date, from each site's
 * own usage rate (site_usage_rates) and its last restock that mentioned forms
 * (Postgres function estimate_site_counts). Also flags sites that already
 * have a stop on the board that day.
 *
 * v3: optional &near=SITECODE (or tech:TECHNICIAN_ID for distance from that technician's home) &radius=MILES adds distMiles / driveMin / distApprox to each
 * row (stored driving distance when the distance matrix has the pair, otherwise
 * straight-line x 1.3, marked approximate) and keeps only sites inside the radius.
 * Also returns stops: the sites with an active assignment on that date, for the
 * page's "near a stop" picker.
 *
 * GET /.netlify/functions/get-restock-forecast?date=YYYY-MM-DD[&near=GA1076&radius=40]
 * -> { date, stops, rows: [ { siteCode, name, state, formsPerDay, lastRestock,
 *                      daysSince, estCount, planned } ] }
 */
const { createClient } = require("@supabase/supabase-js");

// PostgREST returns at most 1000 rows per request (sites alone is 1300+), so page through.
async function fetchAll(makeQuery) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await makeQuery().range(from, from + 999);
    if (error) throw new Error(error.message);
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return all;
}

function miles(a, b) {
  const R = 3959, rad = (x) => (x * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(obj),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return json(405, { error: "Method Not Allowed" });
  const date = String((event.queryStringParameters || {}).date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(400, { error: "date query param required, YYYY-MM-DD" });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: "Supabase env vars not configured" });
  }
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const est = await supabase.rpc("estimate_site_counts", { on_date: date });
    if (est.error) return json(500, { error: "Forecast failed: " + est.error.message });

    const siteRows = await fetchAll(() => supabase.from("sites").select("id, site_code, name, lat, lng").order("id"));
    const names = {};
    const idToCode = {};
    const byCode = {};
    siteRows.forEach((s) => { names[s.site_code] = s.name; idToCode[s.id] = s.site_code; byCode[s.site_code] = s; });
    // v2: sites with only 2 clean intervals are included but flagged low confidence
    const rates = await supabase.from("site_usage_rates").select("site_id, intervals");
    const intervals = {};
    (rates.data || []).forEach((r) => { intervals[idToCode[r.site_id]] = r.intervals; });

    const asg = await supabase
      .from("assignments")
      .select("status, technician_id, sites(site_code), tickets(ticket_kind), technicians(name)")
      .eq("dispatch_date", date);
    const planned = {};
    const stops = [];
    const techs = {};
    (asg.data || []).forEach((a) => {
      if (a.status === "cancelled" || a.status === "removed") return;
      const code = a.sites && a.sites.site_code;
      if (a.technician_id && a.technicians) techs[a.technician_id] = a.technicians.name;
      if (code) {
        planned[code] = (a.tickets && a.tickets.ticket_kind) || "stop";
        stops.push({ siteCode: code, name: names[code] || "", tech: (a.technicians && a.technicians.name) || "", status: a.status });
      }
    });

    const rows = (est.data || []).map((r) => ({
      siteCode: r.site_code,
      name: names[r.site_code] || "",
      state: r.state,
      formsPerDay: Number(r.forms_per_day),
      lastRestock: r.last_forms_restock,
      daysSince: r.days_since,
      estCount: r.est_count,
      lowConfidence: (intervals[r.site_code] || 0) < 3,
      planned: planned[r.site_code] || null,
    }));
    let out = rows;
    const near = String((event.queryStringParameters || {}).near || "").trim();
    const radius = Math.min(500, Math.max(1, Number((event.queryStringParameters || {}).radius) || 40));
    const techNear = /^tech:/i.test(near) ? near.slice(5) : "";
    const siteNear = !techNear ? near.toUpperCase() : "";
    const origin = siteNear ? byCode[siteNear] : null;
    if (techNear || origin) {
      // stored driving distances: from one stop, or from a technician's home
      const stored = {};
      if (techNear) {
        const m = await fetchAll(() => supabase.from("tech_site_distances").select("site_id, distance_mi, duration_min")
          .eq("mode", "driving").eq("technician_id", techNear).order("site_id"));
        m.forEach((d) => { const c = idToCode[d.site_id]; if (c) stored[c] = d; });
      } else {
        const m = await fetchAll(() => supabase.from("site_site_distances").select("site_a, site_b, distance_mi, duration_min")
          .eq("mode", "driving").or("site_a.eq." + origin.id + ",site_b.eq." + origin.id).order("site_a").order("site_b"));
        m.forEach((d) => { const c = idToCode[d.site_a === origin.id ? d.site_b : d.site_a]; if (c) stored[c] = d; });
      }
      out = [];
      rows.forEach((r) => {
        if (r.siteCode === siteNear) return;
        const st = stored[r.siteCode];
        const c = byCode[r.siteCode];
        if (st) { r.distMiles = Number(st.distance_mi); r.driveMin = Number(st.duration_min); r.distApprox = false; }
        else if (origin && c && c.lat != null && origin.lat != null) { r.distMiles = Math.round(miles(origin, c) * 1.3 * 10) / 10; r.driveMin = null; r.distApprox = true; }
        else return;
        if (r.distMiles <= radius) out.push(r);
      });
      out.sort((a, b) => a.estCount - b.estCount);
    } else {
      rows.sort((a, b) => a.estCount - b.estCount);
    }
    const techList = Object.keys(techs).map((id) => ({ id, name: techs[id] }));
    return json(200, { date, near: (techNear || origin) ? near : null, stops, techs: techList, rows: out });
  } catch (e) {
    return json(500, { error: String(e.message || e) });
  }
};
