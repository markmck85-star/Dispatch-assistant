/**
 * apply-service-responses.js
 *
 * Reads IMAP-pulled ITI "Technician Service Response" emails
 * (mailbox imap-mi / imap-oh / imap-nv / imap-co), parses the
 * Arrival/End/Travel/Mileage form, and closes a matching open ticket
 * when the match is strong enough.
 *
 * GET ?state=MI&dryRun=1
 * GET ?state=NV
 *
 * Does not invent Salesforce WOs. ITI ticket 152924 is not 00152924
 * in another state. Weak matches stay pending for review.
 */

const { createClient } = require("@supabase/supabase-js");

const MAILBOX = { MI: "imap-mi", OH: "imap-oh", NV: "imap-nv", CO: "imap-co" };

function json(status, obj) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

function unfoldBody(s) {
  return String(s || "")
    .replace(/=\r?\n/g, "")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function field(text, label) {
  const re = new RegExp(label + "\\s*:\\s*(.*?)(?=\\s+(?:Service Call Date|Technician|Component|Location|Contact|Ticket Number|Issue|Call Type|Status|Resolution and Notes|Arrival Time|End Time|Travel Time|Mileage|PCI Requirements)\\s*:|$)", "i");
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

function parseResponse(subject, body) {
  const text = unfoldBody((subject || "") + " " + (body || ""));
  const ticketFromSubject = (subject || "").match(/Ticket\s*#\s*([A-Za-z0-9-]+)/i);
  return {
    ticketNumber: field(text, "Ticket Number") || (ticketFromSubject && ticketFromSubject[1]) || null,
    technician: field(text, "Technician"),
    location: field(text, "Location"),
    component: field(text, "Component"),
    status: field(text, "Status"),
    notes: field(text, "Resolution and Notes"),
    arrivalTime: field(text, "Arrival Time"),
    endTime: field(text, "End Time"),
    travelTime: field(text, "Travel Time"),
    mileage: field(text, "Mileage"),
    callType: field(text, "Call Type"),
    issue: field(text, "Issue"),
  };
}

function isClosedStatus(s) {
  return /closed|complete|resolved/i.test(s || "");
}

function normalizeWo(n) {
  const raw = String(n || "").replace(/^#/, "").trim();
  if (!raw) return [];
  const digits = raw.replace(/\D/g, "");
  const out = new Set([raw, raw.toUpperCase()]);
  if (digits) {
    out.add(digits);
    out.add(digits.padStart(8, "0"));
  }
  return [...out];
}

function locTokens(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !["the", "and", "dmv", "otc", "county"].includes(w));
}

function locationScore(emailLoc, siteText) {
  const a = locTokens(emailLoc);
  const b = locTokens(siteText);
  if (!a.length || !b.length) return 0;
  let hit = 0;
  for (const w of a) if (b.includes(w)) hit += 1;
  return hit / a.length;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
  const qs = event.queryStringParameters || {};
  const state = String(qs.state || "").toUpperCase();
  if (!MAILBOX[state]) return json(400, { error: "state=MI|OH|NV|CO required" });
  const dryRun = !!(qs.dryRun);
  const limit = Math.min(80, Number(qs.limit || 40));

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: emails, error: eErr } = await supabase
    .from("inbound_emails")
    .select("id, subject, body_text, received_at, parse_status")
    .eq("mailbox", MAILBOX[state])
    .in("parse_status", ["pending", "failed"])
    .order("received_at", { ascending: false })
    .limit(limit);
  if (eErr) return json(500, { error: eErr.message });

  const { data: openTickets, error: tErr } = await supabase
    .from("tickets")
    .select("id, wo_number, status, ticket_kind, site_text, site_id, attributes")
    .eq("status", "open")
    .or("site_text.ilike.%" + state + "%,site_text.ilike.%" + stateName(state) + "%");
  if (tErr) return json(500, { error: tErr.message });

  const byWo = {};
  for (const t of openTickets || []) {
    for (const key of normalizeWo(t.wo_number)) {
      (byWo[key] = byWo[key] || []).push(t);
    }
  }

  const summary = { state, examined: 0, closed: 0, unmatched: 0, skippedNotClosed: 0, errors: [] };
  const details = [];

  for (const email of emails || []) {
    summary.examined += 1;
    const parsed = parseResponse(email.subject, email.body_text);
    if (!isClosedStatus(parsed.status) && !/Service Response/i.test(email.subject || "")) {
      summary.skippedNotClosed += 1;
      if (!dryRun) {
        await supabase.from("inbound_emails").update({ parse_status: "ignored", parse_error: "not a closed service response" }).eq("id", email.id);
      }
      continue;
    }

    let match = null;
    let reason = null;
    const woKeys = normalizeWo(parsed.ticketNumber);
    for (const k of woKeys) {
      const hits = byWo[k] || [];
      if (hits.length === 1) {
        match = hits[0];
        reason = "wo_number";
        break;
      }
    }

    if (!match && parsed.location) {
      const scored = (openTickets || [])
        .map((t) => ({ t, score: locationScore(parsed.location, t.site_text) }))
        .filter((x) => x.score >= 0.6)
        .sort((a, b) => b.score - a.score);
      if (scored.length === 1 || (scored.length > 1 && scored[0].score >= 0.85 && scored[0].score - scored[1].score >= 0.2)) {
        match = scored[0].t;
        reason = "location " + scored[0].score.toFixed(2);
      }
    }

    const payload = {
      source: "iti_service_response",
      ticketNumber: parsed.ticketNumber,
      technician: parsed.technician,
      location: parsed.location,
      arrivalTime: parsed.arrivalTime,
      endTime: parsed.endTime,
      travelTime: parsed.travelTime,
      mileage: parsed.mileage,
      notes: parsed.notes,
      callType: parsed.callType,
      inboundEmailId: email.id,
    };

    if (!match) {
      summary.unmatched += 1;
      details.push({ email: email.subject, ticketNumber: parsed.ticketNumber, location: parsed.location, match: null });
      if (!dryRun) {
        await supabase.from("inbound_emails").update({
          parse_status: "parsed",
          parse_error: JSON.stringify({ unmatched: true, ...payload }),
        }).eq("id", email.id);
      }
      continue;
    }

    const note = [
      parsed.notes || "Closed from ITI service response",
      parsed.arrivalTime ? "Arrival: " + parsed.arrivalTime : "",
      parsed.endTime ? "End: " + parsed.endTime : "",
      parsed.travelTime ? "Travel: " + parsed.travelTime : "",
      parsed.mileage ? "Mileage: " + parsed.mileage : "",
      parsed.technician ? "Tech: " + parsed.technician : "",
    ].filter(Boolean).join(" | ");

    details.push({ email: email.subject, ticketNumber: parsed.ticketNumber, matchedWo: match.wo_number, reason, travelTime: parsed.travelTime, mileage: parsed.mileage });

    if (!dryRun) {
      const attrs = Object.assign({}, match.attributes || {}, { service_response: payload });
      const { error: uErr } = await supabase.from("tickets").update({
        status: "closed",
        manually_resolved_at: new Date().toISOString(),
        manually_resolved_note: note.slice(0, 2000),
        attributes: attrs,
        updated_at: new Date().toISOString(),
      }).eq("id", match.id).eq("status", "open");
      if (uErr) {
        summary.errors.push(uErr.message);
        continue;
      }
      await supabase.from("inbound_emails").update({
        parse_status: "parsed",
        parse_error: null,
      }).eq("id", email.id);
      match.status = "closed";
    }
    summary.closed += 1;
  }

  return json(200, { ok: true, dryRun, ...summary, details: details.slice(0, 25) });
};

function stateName(code) {
  return ({ MI: "Michigan", OH: "Ohio", NV: "Nevada", CO: "Colorado" })[code] || code;
}
