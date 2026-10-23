/**
 * get-open-dco-tickets.js -- v1 -- added 2026-10-23
 *
 * Netlify Function. Lists the decal change-out (DCO) tickets that are still
 * open for a state, so the dispatch board can show them even on a day with no
 * restock list.
 *
 * Why this exists: a DCO ticket is long-running work, but Neumo stamps it with
 * a "due" day (the day it was issued) and the board only shows stops saved on
 * the exact day being viewed. Once that day passed, an open DCO ticket was on
 * no board at all (Illinois, Oct 2026: tickets open in the tracker, nothing on
 * the dispatch page).
 *
 * GET /.netlify/functions/get-open-dco-tickets?state=IL&date=YYYY-MM-DD
 * -> { tickets: [ { woNumber, siteCode, siteName, techName, receivedAt, onBoard } ] }
 *
 * A ticket is listed when it is a maintenance ticket whose issue detail says
 * decal change, it is still open and not manually resolved, and no assignment
 * linked to it has been completed. onBoard is true when an active (planned or
 * notified) assignment for that ticket already exists on `date`.
 * Read only.
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

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (event.httpMethod !== "GET") return json(405, { error: "Method Not Allowed" });

  const qs = event.queryStringParameters || {};
  const state = String(qs.state || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) return json(400, { error: "state query param is required, e.g. IL" });
  const date = String(qs.date || "").trim();
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(400, { error: "date must be YYYY-MM-DD" });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: "Supabase env vars not configured" });
  }

  // Georgia's board also covers NC and SC.
  const states = state === "GA" ? ["GA", "NC", "SC"] : [state];

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data: tickets, error: tErr } = await supabase
      .from("tickets")
      .select("id, wo_number, site_id, received_at, manually_resolved_at")
      .eq("ticket_kind", "maintenance")
      .eq("status", "open")
      .ilike("issue_detail", "%decal change%")
      .not("site_id", "is", null)
      .order("received_at", { ascending: true })
      .limit(1000);
    if (tErr) return json(500, { error: "Ticket query failed: " + tErr.message });

    const open = (tickets || []).filter((t) => !t.manually_resolved_at);
    if (!open.length) return json(200, { tickets: [] });

    const siteIds = [...new Set(open.map((t) => t.site_id))];
    const { data: sites, error: sErr } = await supabase
      .from("sites")
      .select("id, site_code, name, state, primary_tech_id")
      .in("id", siteIds)
      .in("state", states);
    if (sErr) return json(500, { error: "Site query failed: " + sErr.message });
    const siteById = {};
    (sites || []).forEach((s) => { siteById[s.id] = s; });

    const mine = open.filter((t) => siteById[t.site_id]);
    if (!mine.length) return json(200, { tickets: [] });

    const techIds = [...new Set(mine.map((t) => siteById[t.site_id].primary_tech_id).filter(Boolean))];
    const techById = {};
    if (techIds.length) {
      const { data: techs, error: teErr } = await supabase.from("technicians").select("id, name").in("id", techIds);
      if (teErr) return json(500, { error: "Technician query failed: " + teErr.message });
      (techs || []).forEach((x) => { techById[x.id] = x.name; });
    }

    const { data: rows, error: aErr } = await supabase
      .from("assignments")
      .select("ticket_id, dispatch_date, status")
      .in("ticket_id", mine.map((t) => t.id));
    if (aErr) return json(500, { error: "Assignment query failed: " + aErr.message });
    const completed = new Set();
    const onBoardIds = new Set();
    (rows || []).forEach((r) => {
      if (r.status === "completed") completed.add(r.ticket_id);
      if (date && r.dispatch_date === date && (r.status === "planned" || r.status === "notified")) onBoardIds.add(r.ticket_id);
    });

    const out = mine
      .filter((t) => !completed.has(t.id))
      .map((t) => {
        const s = siteById[t.site_id];
        return {
          woNumber: t.wo_number,
          siteCode: s.site_code,
          siteName: s.name,
          techName: techById[s.primary_tech_id] || null,
          receivedAt: t.received_at,
          onBoard: onBoardIds.has(t.id),
        };
      });

    return json(200, { tickets: out });
  } catch (err) {
    return json(500, { error: "Unexpected error: " + err.message });
  }
};
