/**
 * cancel-requests.js — added 2026-10-22
 *
 * Neumo/ITI cancellation requests detected by mailgun-inbound.js are stored
 * on tickets.cancel_request_*. Nothing is cancelled automatically; a
 * dispatcher confirms or keeps each one here.
 *
 * GET  ?state=IN                     -> { ok, items: [...] } pending requests
 * POST { wo_number, action: 'confirm'|'keep', by }
 *   confirm: closes the ticket locally (manually_resolved_at + note) and
 *            marks the site's upcoming planned/notified stops 'removed'.
 *   keep:    dismisses the flag (ticket stays open).
 */
const { createClient } = require("@supabase/supabase-js");

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(obj),
  };
}

function todayET() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { ok: false, error: "Supabase env vars not configured" });
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    if (event.httpMethod === "GET") {
      const state = ((event.queryStringParameters || {}).state || "").trim().toUpperCase();
      const { data, error } = await supabase
        .from("tickets")
        .select("id, wo_number, site_id, site_text, issue_category, cancel_request_at, cancel_request_confidence, cancel_request_excerpt, cancel_request_sender, sites(site_code, name, state)")
        .eq("status", "open")
        .is("manually_resolved_at", null)
        .not("cancel_request_at", "is", null)
        .is("cancel_request_resolved_at", null)
        .order("cancel_request_at", { ascending: false })
        .limit(200);
      if (error) return json(500, { ok: false, error: error.message });
      const items = (data || [])
        .filter((t) => !state || (t.sites && t.sites.state === state))
        .map((t) => ({
          woNumber: t.wo_number,
          siteCode: t.sites ? t.sites.site_code : null,
          siteName: t.sites ? t.sites.name : t.site_text,
          state: t.sites ? t.sites.state : null,
          category: t.issue_category,
          requestedAt: t.cancel_request_at,
          confidence: t.cancel_request_confidence,
          excerpt: t.cancel_request_excerpt,
          sender: t.cancel_request_sender,
        }));
      return json(200, { ok: true, items });
    }

    if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method Not Allowed" });
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "Invalid JSON body" }); }
    const { wo_number, action, by } = body;
    if (!wo_number || !["confirm", "keep"].includes(action)) {
      return json(400, { ok: false, error: "wo_number and action (confirm|keep) required" });
    }

    const { data: t, error: tErr } = await supabase
      .from("tickets").select("id, site_id").eq("wo_number", wo_number).maybeSingle();
    if (tErr) return json(500, { ok: false, error: tErr.message });
    if (!t) return json(404, { ok: false, error: `No ticket with WO ${wo_number}` });

    const now = new Date().toISOString();
    const upd = { cancel_request_resolved_at: now, cancel_request_resolution: action === "confirm" ? "confirmed" : "kept" };
    if (action === "confirm") {
      upd.manually_resolved_at = now;
      upd.manually_resolved_note = [by, "Cancelled per Neumo request"].filter(Boolean).join(": ");
    }
    const { error: uErr } = await supabase.from("tickets").update(upd).eq("id", t.id);
    if (uErr) return json(500, { ok: false, error: uErr.message });

    let removed = 0;
    if (action === "confirm") {
      // Only this ticket's own board stops, and only upcoming ones.
      const { data: rows, error: rErr } = await supabase
        .from("assignments")
        .update({ status: "removed", updated_at: now })
        .eq("ticket_id", t.id)
        .in("status", ["planned", "notified"])
        .gte("dispatch_date", todayET())
        .select("id");
      if (rErr) console.error("[cancel-requests] assignment removal failed:", rErr.message);
      else removed = (rows || []).length;
    }
    return json(200, { ok: true, removedStops: removed });
  } catch (e) {
    return json(500, { ok: false, error: e.message });
  }
};
