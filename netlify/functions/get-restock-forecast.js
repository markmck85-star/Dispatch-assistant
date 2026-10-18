/**
 * get-restock-forecast.js — v1, 2026-10-17
 *
 * Estimated forms-roll counts per site for a chosen date, from each site's
 * own usage rate (site_usage_rates) and its last restock that mentioned forms
 * (Postgres function estimate_site_counts). Also flags sites that already
 * have a stop on the board that day.
 *
 * v4: tech mode measures from the technician's home OR any open stop and adds detourMi (extra
 * miles to fit the site into that day's route).
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
      .select("status, technician_id, site_id, sequence_order, sites(site_code), tickets(ticket_kind), technicians(name)")
      .eq("dispatch_date", date);
    const planned = {};
    const stops = [];
    const techs = {};
    const techStops = {};
    (asg.data || []).forEach((a) => {
      if (a.status === "cancelled" || a.status === "removed") return;
      const code = a.sites && a.sites.site_code;
      if (a.technician_id && a.technicians) techs[a.technician_id] = a.technicians.name;
      if (a.technician_id && code) (techStops[a.technician_id] = techStops[a.technician_id] || []).push({ siteId: a.site_id, code, seq: a.sequence_order, status: a.status });
      if (code) {
        planned[code] = (a.tickets && a.tickets.ticket_kind) || "stop";
        stops.push({ siteCode: code, name: names[code] || "", tech: (a.technicians && a.technicians.name) || "", status: a.status });
      }
    });

    // v5: what count Neumo has actually called each site at, by the weekday of the list
    // (site_restock_thresholds, rebuilt from the dispatch-list emails after each reader run).
    const thrRows = await fetchAll(() => supabase.from("site_restock_thresholds").select("site_id, mid_median, mid_n, thu_median, thu_n, fri_median, fri_n").order("site_id"));
    const thr = {};
    thrRows.forEach((t) => { thr[idToCode[t.site_id]] = t; });
    const rnd = (v) => (v == null ? null : Math.round(Number(v)));

    // v6: compare each site's estimated count with the count Neumo usually lists it at on that
    // weekday's list. Needs at least 3 past lists for that weekday; weekends have no list.
    const dow = new Date(date + "T12:00:00Z").getUTCDay();
    const dayKey = { 1: "Mid", 2: "Mid", 3: "Mid", 4: "Thu", 5: "Fri" }[dow] || null;
    const listFlag = (r, t) => {
      if (!dayKey || !t) return {};
      const callAt = rnd(t[{ Mid: "mid_median", Thu: "thu_median", Fri: "fri_median" }[dayKey]]);
      const callN = t[{ Mid: "mid_n", Thu: "thu_n", Fri: "fri_n" }[dayKey]] || 0;
      if (callAt == null || callN < 3) return { callN };
      const est = Number(r.est_count), perDay = Number(r.forms_per_day) || 0;
      // likely = already at or under the usual call point; next day = one more day of use gets it there
      const flag = est <= callAt ? "likely" : est <= callAt + perDay ? "next" : null;
      return { callAt, callN, listFlag: flag };
    };

    const rows = (est.data || []).map((r) => ({
      ...listFlag(r, thr[r.site_code]),
      thrMid: rnd((thr[r.site_code] || {}).mid_median), thrMidN: (thr[r.site_code] || {}).mid_n || 0,
      thrThu: rnd((thr[r.site_code] || {}).thu_median), thrThuN: (thr[r.site_code] || {}).thu_n || 0,
      thrFri: rnd((thr[r.site_code] || {}).fri_median), thrFriN: (thr[r.site_code] || {}).fri_n || 0,
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
    if (techNear) {
      // Technician's day: distance from home or from any open stop, plus the extra
      // miles to fit each site into the route (home > stop 1 > ... > home).
      // Uses stored driving distances; a missing pair falls back to straight-line x 1.3 (approx).
      const tq = await supabase.from("technicians").select("id, name, lat, lng").eq("id", techNear).limit(1);
      const home = tq.data && tq.data[0];
      if (!home) return json(200, { date, near: null, stops, techs: Object.keys(techs).map((id) => ({ id, name: techs[id] })), rows: [] });
      const homeMap = {};
      (await fetchAll(() => supabase.from("tech_site_distances").select("site_id, distance_mi, duration_min")
        .eq("mode", "driving").eq("technician_id", techNear).order("site_id")))
        .forEach((d) => { homeMap[d.site_id] = d; });
      const open = (techStops[techNear] || []).filter((x) => x.status === "planned" || x.status === "notified")
        .sort((a, b) => (a.seq || 0) - (b.seq || 0));
      const pair = {};
      const key = (a, b) => (a < b ? a + "|" + b : b + "|" + a);
      for (const st of open) {
        const m = await fetchAll(() => supabase.from("site_site_distances").select("site_a, site_b, distance_mi, duration_min")
          .eq("mode", "driving").or("site_a.eq." + st.siteId + ",site_b.eq." + st.siteId).order("site_a").order("site_b"));
        m.forEach((d) => { pair[key(d.site_a, d.site_b)] = d; });
      }
      const H = { home: true, lat: home.lat, lng: home.lng };
      const node = (id) => { const c = siteRows.find((x) => x.id === id); return { id, lat: c && c.lat, lng: c && c.lng }; };
      const dist = (u, v) => {
        let st = null;
        if (u.home && !v.home) st = homeMap[v.id];
        else if (v.home && !u.home) st = homeMap[u.id];
        else if (!u.home && !v.home) st = pair[key(u.id, v.id)];
        if (st) return { mi: Number(st.distance_mi), min: Number(st.duration_min), approx: false };
        if (u.lat != null && v.lat != null && u.lng != null && v.lng != null) {
          return { mi: miles(u, v) * 1.3, min: null, approx: true };
        }
        return null;
      };
      const route = [H].concat(open.map((x) => node(x.siteId)), [H]);
      const stopNodes = route.slice(1, -1);
      const onRoute = new Set(open.map((x) => x.code));
      out = [];
      rows.forEach((r) => {
        if (onRoute.has(r.siteCode)) return;
        const c = byCode[r.siteCode];
        if (!c) return;
        const X = { id: c.id, lat: c.lat, lng: c.lng };
        let near1 = null;
        [H].concat(stopNodes).forEach((u) => {
          const d = dist(u, X);
          if (d && (!near1 || d.mi < near1.mi)) near1 = d;
        });
        if (!near1 || near1.mi > radius) return;
        r.distMiles = Math.round(near1.mi * 10) / 10;
        r.driveMin = near1.min;
        r.distApprox = near1.approx;
        if (stopNodes.length) {
          let best = null, approx = false;
          for (let i = 0; i < route.length - 1; i++) {
            const a = dist(route[i], X), b = dist(X, route[i + 1]), base = dist(route[i], route[i + 1]);
            if (!a || !b || !base) continue;
            const extra = a.mi + b.mi - base.mi;
            if (best === null || extra < best) { best = extra; approx = a.approx || b.approx || base.approx; }
          }
          if (best !== null) { r.detourMi = Math.round(Math.max(0, best) * 10) / 10; r.detourApprox = approx; }
        }
        out.push(r);
      });
      out.sort((a, b) => a.estCount - b.estCount);
    } else if (origin) {
      const stored = {};
      const m = await fetchAll(() => supabase.from("site_site_distances").select("site_a, site_b, distance_mi, duration_min")
        .eq("mode", "driving").or("site_a.eq." + origin.id + ",site_b.eq." + origin.id).order("site_a").order("site_b"));
      m.forEach((d) => { const c = idToCode[d.site_a === origin.id ? d.site_b : d.site_a]; if (c) stored[c] = d; });
      out = [];
      rows.forEach((r) => {
        if (r.siteCode === siteNear) return;
        const st = stored[r.siteCode];
        const c = byCode[r.siteCode];
        if (st) { r.distMiles = Number(st.distance_mi); r.driveMin = Number(st.duration_min); r.distApprox = false; }
        else if (c && c.lat != null && origin.lat != null) { r.distMiles = Math.round(miles(origin, c) * 1.3 * 10) / 10; r.driveMin = null; r.distApprox = true; }
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
