/**
 * mark-site-restocked.js — v1 — added 2026-08-08
 *
 * Netlify Function — lets a dispatcher manually confirm a site was
 * actually restocked, even though get-restock-schedule.js's automated
 * calculation only has visibility into confirmed restock-type visits.
 * Built after a real case: GA1112 (Effingham County) showed "Overdue
 * (visited)" -- the "(visited)" already meant the algorithm noticed SOME
 * visit happened since the last confirmed restock (e.g. a trouble
 * ticket), just without confidence it included a restock. Mark's
 * experience is that a site with recent trouble-ticket activity has
 * often been restocked opportunistically during that same visit, and
 * wanted a way to say so directly rather than watch it sit "overdue"
 * indefinitely. Deliberately doesn't touch the actual overdue algorithm
 * or fabricate a fake site_visits row -- this is a separate, visible
 * manual signal the frontend displays alongside the computed status,
 * same pattern as mark-ticket-resolved.js for tickets.
 *
 * POST /.netlify/functions/mark-site-restocked
 * body: { site_code, note (optional) }
 * -> { ok: true } | { ok: false, error }
 *
 * 2026-10-07 additions (restock tracker history popup):
 *   Count a specific visit as a restock, dated on that visit:
 *     body: { site_code, visit_date (the visit's started_at), appointment_number, note }
 *     (visit_date is stored in visit_date_covered; get-restock-schedule.js
 *      counts it as a restock on that date. Omitting visit_date keeps the old
 *      behavior, which the schedule reads as "the latest visit so far".)
 *   Stop counting a visit that was confirmed:
 *     body: { site_code, uncount: true, visit_date }
 *   Clear a "not a restock" mark:
 *     body: { site_code, clear_not_restock: true, appointment_number }
 *
 * Undo (removes the most recent confirmation for that site):
 * body: { site_code, undo: true }
 * -> { ok: true } | { ok: false, error }
 */
const { createClient } = require("@supabase/supabase-js");

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(obj),
  };
}

// Same resolution rule as get-restock-schedule.js (visitTimes ascending, ms).
function resolveConfirmationVisit(conf, visitTimes) {
  const vdc = conf.visit_date_covered ? new Date(conf.visit_date_covered).getTime() : null;
  if (vdc != null && visitTimes.includes(vdc)) return vdc;
  const at = conf.confirmed_at ? new Date(conf.confirmed_at).getTime() : null;
  if (at == null) return null;
  let best = null;
  for (const t of visitTimes) { if (t <= at) best = t; else break; }
  return best;
}

async function loadVisitTimes(supabase, siteId) {
  const times = [];
  let from = 0;
  while (true) {
    const { data: page, error } = await supabase
      .from("site_visits").select("started_at")
      .eq("site_id", siteId).not("started_at", "is", null)
      .order("started_at", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(error.message);
    if (!page || !page.length) break;
    for (const r of page) times.push(new Date(r.started_at).getTime());
    if (page.length < 1000) break;
    from += 1000;
  }
  return times;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method Not Allowed" });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { ok: false, error: "Supabase env vars not configured" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { ok: false, error: "Invalid JSON body" });
  }

  const { site_code, note, undo, not_restock, appointment_number, visit_date, uncount, clear_not_restock } = body;
  if (!site_code) return json(400, { ok: false, error: "site_code is required" });

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: site, error: siteErr } = await supabase
      .from("sites").select("id").eq("site_code", site_code).maybeSingle();
    if (siteErr) return json(500, { ok: false, error: siteErr.message });
    if (!site) return json(404, { ok: false, error: `No site found with code ${site_code}` });

    if (clear_not_restock) {
      if (!appointment_number) return json(400, { ok: false, error: "appointment_number is required" });
      const { error: delAck } = await supabase
        .from("site_nonrestock_acks").delete()
        .eq("site_id", site.id).eq("appointment_number", appointment_number);
      if (delAck) return json(500, { ok: false, error: delAck.message });
      return json(200, { ok: true });
    }

    if (uncount) {
      const target = visit_date ? new Date(visit_date).getTime() : NaN;
      if (isNaN(target)) return json(400, { ok: false, error: "valid visit_date is required" });
      const times = await loadVisitTimes(supabase, site.id);
      const { data: confs, error: confsErr } = await supabase
        .from("site_manual_restock_confirmations")
        .select("id, confirmed_at, visit_date_covered").eq("site_id", site.id);
      if (confsErr) return json(500, { ok: false, error: confsErr.message });
      const ids = (confs || []).filter((c) => resolveConfirmationVisit(c, times) === target).map((c) => c.id);
      if (ids.length) {
        const { error: delErr } = await supabase
          .from("site_manual_restock_confirmations").delete().in("id", ids);
        if (delErr) return json(500, { ok: false, error: delErr.message });
      }
      return json(200, { ok: true, removed: ids.length });
    }

    if (not_restock) {
      if (appointment_number) {
        const { data: existingAck } = await supabase
          .from("site_nonrestock_acks").select("id")
          .eq("site_id", site.id).eq("appointment_number", appointment_number).limit(1);
        if (existingAck && existingAck.length) return json(200, { ok: true, not_restock: true });
      }
      const { error: insAck } = await supabase
        .from("site_nonrestock_acks")
        .insert({
          site_id: site.id,
          appointment_number: appointment_number || null,
          note: note || "Closing notes were not a restock",
        });
      if (insAck) return json(500, { ok: false, error: insAck.message });
      return json(200, { ok: true, not_restock: true });
    }

    if (undo) {
      const { data: latest, error: latestErr } = await supabase
        .from("site_manual_restock_confirmations")
        .select("id").eq("site_id", site.id)
        .order("confirmed_at", { ascending: false }).limit(1).maybeSingle();
      if (latestErr) return json(500, { ok: false, error: latestErr.message });
      if (!latest) return json(200, { ok: true }); // nothing to undo
      const { error: delErr } = await supabase
        .from("site_manual_restock_confirmations").delete().eq("id", latest.id);
      if (delErr) return json(500, { ok: false, error: delErr.message });
      return json(200, { ok: true });
    }

    let coveredAt = new Date().toISOString();
    if (visit_date) {
      const vd = new Date(visit_date);
      if (isNaN(vd.getTime())) return json(400, { ok: false, error: "invalid visit_date" });
      coveredAt = vd.toISOString();
      // Already counted? Don't stack duplicates for the same visit.
      const times = await loadVisitTimes(supabase, site.id);
      const { data: confs } = await supabase
        .from("site_manual_restock_confirmations")
        .select("confirmed_at, visit_date_covered").eq("site_id", site.id);
      const t = vd.getTime();
      if ((confs || []).some((c) => resolveConfirmationVisit(c, times) === t)) {
        return json(200, { ok: true, already: true });
      }
    }
    const { error: insErr } = await supabase
      .from("site_manual_restock_confirmations")
      .insert({ site_id: site.id, note: note || null, visit_date_covered: coveredAt });
    if (insErr) return json(500, { ok: false, error: insErr.message });

    return json(200, { ok: true });
  } catch (e) {
    return json(500, { ok: false, error: e.message });
  }
};
