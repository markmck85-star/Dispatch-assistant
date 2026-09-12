/**
 * get-latest-dispatch.js — v2 (2026-09-12)
 *
 * Rewritten to read from the real Supabase inbound_emails table instead of
 * the old Netlify Blobs store this file was still pointed at. Found live:
 * mailgun-inbound.js has written every inbound email (including dispatch
 * lists) to Supabase for months now, but nothing ever updated THIS specific
 * read function to match -- it was still querying a Blobs key
 * ("inbound/latest-dispatch") that nothing has written to since before the
 * Supabase migration, so it silently returned found:false for every real
 * dispatch list received since then, no matter how recently or correctly
 * it parsed. This is why the "new dispatch list" banner never fired for
 * Mark's forwarded 9/11/26 list despite it landing and parsing fine in
 * inbound_emails, and why the 2026-09-12 page-load fix (preferring the
 * server's latest dispatch over stale local cache) had nothing real to
 * find either, despite being correctly wired to call this same endpoint.
 *
 * GET /.netlify/functions/get-latest-dispatch?state=MI
 * GET /.netlify/functions/get-latest-dispatch  (global latest, any state)
 * -> { ok, found, body, dispatchType: 'restock', receivedAt, inboundKey, states }
 */
const { createClient } = require("@supabase/supabase-js");

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return json(405, { error: "Method Not Allowed" });

  const state = String((event.queryStringParameters || {}).state || "").trim().toUpperCase();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(200, { ok: true, found: false });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // Pull a handful of the most recent dispatch-list emails rather than
    // just one -- lets the optional ?state filter below skip past a recent
    // list that doesn't happen to mention the requested state (e.g. one of
    // Neumo's separate CA/HI/MI-only lists) without an extra round trip.
    const { data, error } = await supabase
      .from("inbound_emails")
      .select("id, body_text, received_at, mailgun_message_id")
      .eq("classified_as", "dispatch_list")
      .order("received_at", { ascending: false })
      .limit(10);

    if (error || !data || data.length === 0) return json(200, { ok: true, found: false });

    const codeRe = /\b([A-Z]{2})\d{3,5}\b/g;
    function statesIn(text) {
      const found = new Set();
      let m;
      while ((m = codeRe.exec(text || "")) !== null) found.add(m[1]);
      return [...found];
    }

    let row = data[0];
    if (state) {
      row = data.find(r => statesIn(r.body_text).includes(state));
      if (!row) return json(200, { ok: true, found: false });
    }

    return json(200, {
      ok: true,
      found: true,
      body: row.body_text,
      dispatchType: "restock",
      receivedAt: row.received_at,
      inboundKey: row.mailgun_message_id || row.id,
      states: statesIn(row.body_text),
    });
  } catch (err) {
    return json(200, { ok: true, found: false });
  }
};
