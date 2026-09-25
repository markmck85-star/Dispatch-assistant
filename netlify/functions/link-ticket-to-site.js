/**
 * link-ticket-to-site.js — v3 — updated 2026-09-25
 *
 * Netlify Function — updates a ticket's site_id, used right after the
 * auto-triggered "Add Location" toast (for a previously-unmatched ticket)
 * successfully creates a new site record.
 *
 * v3 (2026-09-25): FIXED a real, confirmed gap Mark found live on FL1141.
 * v2's own header comment (below, kept for history) claimed this file was
 * "deliberately minimal for the board-side of things" because "the
 * existing auto-surface logic in index.html's _processDispatchCore picks
 * it up and creates the board assignment on the very next dispatch
 * generation" -- that assumption was simply wrong. _processDispatchCore's
 * auto-surface logic only RESURFACES or ENRICHES an assignment row that
 * ALREADY EXISTS in Supabase; it never creates a brand-new one. The only
 * place that ever inserts a fresh assignments row from a ticket is
 * autoAddTicketToBoard() in mailgun-inbound.js -- and that only ever ran
 * once, at the ticket's own original ingestion time. A ticket that
 * arrived before its site existed had site_id null then, so that insert
 * never happened -- and nothing ever went back and ran it once this file
 * later gave the ticket a real site_id. Confirmed live: FL1141's ticket
 * (WO 00153398) got a correct site link, showed correctly on the
 * watchdog log and state console, but sat with ZERO assignment row on
 * ANY date -- "Generate Dispatches" and changing the board's day both
 * had nothing to surface, no matter how many times either ran, because
 * the underlying row was never created in the first place. Mailgun-
 * inbound.js already solved this exact problem for its OWN sibling-sweep
 * path back on 2026-09-02 (see that file's autoAddTicketToBoard extraction
 * comment) -- this file just never got the same treatment. Fixed by
 * calling that same, now-exported function here too, for both the
 * primary ticket and every swept sibling, right after each one's site_id
 * is set -- mirroring exactly what mailgun-inbound.js's own sibling-sweep
 * does, just triggered from a toast instead of a later inbound email.
 * Scoped to ticket_kind 'trouble'/'maintenance' only, same restriction
 * the sibling-sweep already uses -- install/site_survey tickets go
 * through the separate placeholder-site flow (lib/placeholder-sites.js)
 * and are excluded from get-unmatched-tickets.js/this toast path
 * entirely, so they're not expected to reach here.
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
 * -> { ok: true, siblingsLinked: N, boardRowsAdded: N } | { ok: false, error }
 */
const { createClient } = require("@supabase/supabase-js");
const { autoAddTicketToBoard } = require("./mailgun-inbound.js");

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

// v3 (2026-09-25): thin wrapper around autoAddTicketToBoard for one
// already-fetched ticket row -- non-fatal on any failure (logged, not
// thrown), same "board push is best-effort, never blocks the core
// site-link result" convention mailgun-inbound.js itself already follows
// for both of its own call sites.
async function pushTicketToBoard(supabase, siteId, siteCode, ticketRow) {
  if (!['trouble', 'maintenance'].includes(ticketRow.ticket_kind || 'trouble')) return false;
  try {
    await autoAddTicketToBoard({
      supabase,
      siteId,
      ticketKind: ticketRow.ticket_kind,
      dueDateRaw: ticketRow.due_at,
      slaEndIso: ticketRow.sla_ends_at,
      // This ticket's own raw text had no embedded site code (that's why
      // it needed manual/toast resolution in the first place) -- pass the
      // resolved site code itself so getTimezoneForSiteCode/
      // nextWorkDayStrForSiteCode use the right state's rules instead of
      // silently defaulting to GA's.
      rawSiteCode: siteCode,
      woNum: ticketRow.wo_number,
      newTicketId: ticketRow.id,
      receivedAtIso: ticketRow.received_at,
      issueCategory: ticketRow.issue_category,
      issueDetail: ticketRow.issue_detail,
      description: ticketRow.description,
    });
    return true;
  } catch (boardEx) {
    console.error(`[link-ticket-to-site] Auto-add-to-board for ${ticketRow.wo_number} failed (non-fatal):`, boardEx.message);
    return false;
  }
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

    // v3: select the fields autoAddTicketToBoard needs, not just id --
    // was previously fetched nowhere at all here since this file never
    // called it.
    const { data: primaryTicket, error: primaryFetchErr } = await supabase
      .from("tickets")
      .select("id, wo_number, ticket_kind, due_at, sla_ends_at, issue_category, issue_detail, description, received_at")
      .eq("id", ticketId)
      .maybeSingle();
    if (primaryFetchErr) return json(500, { ok: false, error: primaryFetchErr.message });
    if (!primaryTicket) return json(404, { ok: false, error: `No ticket found with id ${ticketId}` });

    const { error } = await supabase.from("tickets").update({ site_id: site.id }).eq("id", ticketId);
    if (error) return json(500, { ok: false, error: error.message });

    let boardRowsAdded = 0;
    if (await pushTicketToBoard(supabase, site.id, siteCode, primaryTicket)) boardRowsAdded++;

    // Sweep up any other open, still-unmatched ticket for this same code
    // (e.g. a second trouble ticket that came in for the same new site
    // before this toast got filled out) so it doesn't sit around
    // prompting its own redundant toast now that the site exists.
    let siblingsLinked = 0;
    const { data: siblings, error: siblingsErr } = await supabase
      .from("tickets")
      .select("id, attributes, wo_number, ticket_kind, due_at, sla_ends_at, issue_category, issue_detail, description, received_at")
      .is("site_id", null)
      .neq("id", ticketId)
      .eq("status", "open");
    if (!siblingsErr && siblings) {
      const matchedSiblings = siblings.filter((t) => t.attributes && t.attributes.rawSiteCode === siteCode);
      const siblingIds = matchedSiblings.map((t) => t.id);
      if (siblingIds.length) {
        const { error: sweepErr } = await supabase.from("tickets").update({ site_id: site.id }).in("id", siblingIds);
        if (!sweepErr) {
          siblingsLinked = siblingIds.length;
          // v3: same board push per swept sibling, mirroring mailgun-
          // inbound.js's own address-sweep sibling loop exactly.
          for (const sib of matchedSiblings) {
            if (await pushTicketToBoard(supabase, site.id, siteCode, sib)) boardRowsAdded++;
          }
        }
      }
    }

    return json(200, { ok: true, siblingsLinked, boardRowsAdded });
  } catch (e) {
    return json(500, { ok: false, error: e.message });
  }
};
