/**
 * list-service-responses.js
 * Tickets closed from ITI service-response emails, with times and miles.
 * GET ?state=MI&testing=1
 */
const { createClient } = require("@supabase/supabase-js");

function json(status, obj) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

function onsiteMinutes(arrival, end) {
  if (!arrival || !end) return null;
  const a = new Date(arrival);
  const b = new Date(end);
  if (isNaN(a) || isNaN(b)) return null;
  const m = Math.round((b - a) / 60000);
  return m >= 0 && m < 24 * 60 ? m : null;
}

function isTesting(sr, siteText) {
  const s = `${sr.notes || ""} ${sr.callType || ""} ${sr.location || ""} ${siteText || ""} ${sr.component || ""}`;
  return /k2d|testing station|examiner|test office/i.test(s);
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
  const qs = event.queryStringParameters || {};
  const state = String(qs.state || "").toUpperCase();
  const testingOnly = qs.testing === "1" || qs.testing === "true";
  const limit = Math.min(500, Number(qs.limit || 300));

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await supabase
    .from("tickets")
    .select("wo_number, site_text, status, ticket_kind, manually_resolved_at, attributes")
    .not("attributes->service_response", "is", null)
    .order("manually_resolved_at", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) return json(500, { error: error.message });

  const rows = [];
  for (const t of data || []) {
    const sr = (t.attributes && t.attributes.service_response) || {};
    const blob = `${t.site_text || ""} ${sr.location || ""}`;
    if (state && !new RegExp("\\b" + state + "\\b|" + stateName(state), "i").test(blob)) continue;
    if (testingOnly && !isTesting(sr, t.site_text)) continue;
    rows.push({
      wo: t.wo_number,
      site: t.site_text,
      status: t.status,
      kind: t.ticket_kind,
      closedAt: t.manually_resolved_at,
      ticketNumber: sr.ticketNumber || t.wo_number,
      technician: sr.technician || "",
      location: sr.location || t.site_text || "",
      arrivalTime: sr.arrivalTime || "",
      endTime: sr.endTime || "",
      onsiteMin: onsiteMinutes(sr.arrivalTime, sr.endTime),
      travelTime: sr.travelTime || "",
      mileage: sr.mileage || "",
      notes: sr.notes || "",
      callType: sr.callType || "",
      testing: isTesting(sr, t.site_text),
    });
  }

  return json(200, { ok: true, count: rows.length, rows });
};

function stateName(code) {
  return ({ MI: "Michigan", OH: "Ohio", NV: "Nevada", CO: "Colorado", GA: "Georgia" })[code] || code;
}
