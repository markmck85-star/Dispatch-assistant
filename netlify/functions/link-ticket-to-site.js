/**
 * link-ticket-to-site.js — v2 — updated 2026-08-07
 *
 * Netlify Function — updates a ticket's site_id, used right after the
 * auto-triggered "Add Location" toast (for a previously-unmatched ticket)
 * successfully creates a new site record. Deliberately minimal for the
 * board-side of things -- rather than duplicating any assignment-creation
 * logic that already exists elsewhere: once a ticket has a real site_id,
 * the existing auto-surface logic in index.html's _processDispatchCore
 * (built 2026-08-05) picks it up and creates the board assignment on the
 * very next dispatch generation, the same way it already does for any
 * other ticket-linked stop.
 *
 * v2: Mark asked what happens if a second, different trouble ticket comes
 * in for the same new location before the first toast gets filled out --
 * it's not caught by the wo_number duplicate-prevention (different WO),
 * so it becomes its own separate unmatched ticket with its own separate
 * toast. Filling out the first toast only ever linked that ONE ticket, so
 * the second would sit unresolved and prompt an unnecessary second toast,
 * even though the site now genuinely exists. Fixed: after linking the
 * primary ticket, this also sweeps up and links every OTHER open ticket
 * that shares the same rawSiteCode (captured in attributes for nearly
 * every real ticket -- see get-unmatched-tickets.js v2) and still has no
 * site_id, so one toast resolution now clears every ticket for that site,
 * not just the one that happened to trigger it.
 *
 * POST /.netlify/functions/link-ticket-to-site
 * body: { ticketId, siteCode }
 * -> { ok: true, siblingsLinked: N } | { ok: false, error }
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

  const { ticketId, siteCode } = body;
  if (!ticketId || !siteCode) {
    return json(400, { ok: false, error: "ticketId and siteCode are both required" });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: site, error: siteErr } = await supabase
      .from("sites")
      .select("id")
      .eq("site_code", siteCode)
      .maybeSingle();
    if (siteErr) return json(500, { ok: false, error: siteErr.message });
    if (!site) return json(404, { ok: false, error: `No site found with code ${siteCode}` });

    const { error } = await supabase.from("tickets").update({ site_id: site.id }).eq("id", ticketId);
    if (error) return json(500, { ok: false, error: error.message });

    // Sweep up any other open, still-unmatched ticket for this same code
    // (e.g. a second trouble ticket that came in for the same new site
    // before this toast got filled out) so it doesn't sit around
    // prompting its own redundant toast now that the site exists.
    let siblingsLinked = 0;
    const { data: siblings, error: siblingsErr } = await supabase
      .from("tickets")
      .select("id, attributes")
      .is("site_id", null)
      .neq("id", ticketId)
      .eq("status", "open");
    if (!siblingsErr && siblings) {
      const siblingIds = siblings
        .filter((t) => t.attributes && t.attributes.rawSiteCode === siteCode)
        .map((t) => t.id);
      if (siblingIds.length) {
        const { error: sweepErr } = await supabase.from("tickets").update({ site_id: site.id }).in("id", siblingIds);
        if (!sweepErr) siblingsLinked = siblingIds.length;
      }
    }

    return json(200, { ok: true, siblingsLinked });
  } catch (e) {
    return json(500, { ok: false, error: e.message });
  }
};
