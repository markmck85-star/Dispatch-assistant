// lib/ticket-state.js -- the one place that decides what "closed" and "reopened"
// mean for a ticket. Added 2026-10-22 after WO 00155464 (GA1126): Neumo added a
// second visit to a closed work order, and different screens disagreed about
// whether it was open (tickets.status, manually_resolved_at, and an attached
// Salesforce visit were each read by different code).
//
// The rules:
//   * A ticket is CLOSED if tickets.status is 'closed' OR it was resolved by
//     hand (manually_resolved_at: board Cancel, Mark resolved, cancel-request
//     confirm, mailbox closing).
//   * A new dispatch (or line item) from Neumo on a closed ticket REOPENS it,
//     whatever was done in the app before. Reopening stamps
//     attributes.reopenedAt (see mailgun-inbound.js reopenClosedTicket).
//   * A Salesforce visit only counts as closing a ticket if it started at or
//     after the latest reopen. Earlier visits belong to the earlier trip.
//
// Nothing here talks to the database; callers pass in rows they already have.

function isClosedAnyWay(ticket) {
  if (!ticket) return false;
  return ticket.status === 'closed' || !!ticket.manually_resolved_at;
}

function reopenedAtOf(ticket) {
  const a = ticket && ticket.attributes;
  const v = a && a.reopenedAt;
  const ms = v ? Date.parse(v) : NaN;
  return Number.isNaN(ms) ? null : ms;
}

// True when this visit (by its start time) happened before the ticket's most
// recent reopen, so it must not be treated as closing the reopened ticket.
function visitPredatesReopen(ticket, visitStartedAt) {
  const reopened = reopenedAtOf(ticket);
  if (reopened === null || !visitStartedAt) return false;
  const started = Date.parse(visitStartedAt);
  return !Number.isNaN(started) && started < reopened;
}

// Fields that put a closed ticket back to open and clear every earlier
// "this is done" marker, including a pending or resolved cancel request.
function reopenClearFields() {
  return {
    status: 'open',
    manually_resolved_at: null,
    manually_resolved_note: null,
    cancel_request_at: null,
    cancel_request_confidence: null,
    cancel_request_excerpt: null,
    cancel_request_sender: null,
    cancel_request_email_id: null,
    cancel_request_resolved_at: null,
    cancel_request_resolution: null,
  };
}

// When a ticket is closed by some path other than the board's own Done/Cancel
// (a service-response or mailbox closing email), its active board stops must
// close with it, or they sit 'planned'/'notified' forever. Found 2026-10-22:
// eight such stops. Returns how many stops were closed; never throws.
async function closeStopsForTickets(supabase, ticketIds, finalStatus) {
  try {
    const ids = (ticketIds || []).filter(Boolean);
    if (!ids.length) return 0;
    const { data, error } = await supabase
      .from('assignments')
      .update({ status: finalStatus || 'completed', updated_at: new Date().toISOString() })
      .in('ticket_id', ids)
      .in('status', ['planned', 'notified'])
      .select('id');
    if (error) {
      console.error('[ticket-state] closing stops for tickets failed:', error.message);
      return 0;
    }
    return (data || []).length;
  } catch (e) {
    console.error('[ticket-state] closing stops for tickets threw:', e.message);
    return 0;
  }
}

// A ticket whose board stop was marked Done (board or tech portal) stays open
// until Salesforce's closed report confirms a visit -- and when no visit ever
// matches, it stays open for weeks (24 such tickets found 2026-10-22). Rule:
// once every stop on a ticket is finished and the last one was finished more
// than a day ago, the ticket is treated as resolved locally. Neumo reopening
// the WO (see reopenClosedTicket in mailgun-inbound.js) overrides it, and a
// stop finished BEFORE the latest reopen never counts. Runs on every import;
// non-fatal; returns the number of tickets resolved.
async function sweepDoneStopTickets(supabase, opts) {
  try {
    const graceMs = (opts && opts.graceMs) || 24 * 3600 * 1000;
    const cutoff = new Date(Date.now() - graceMs).toISOString();
    const floor = new Date(Date.now() - 120 * 24 * 3600 * 1000).toISOString();
    const { data: done, error } = await supabase
      .from('assignments')
      .select('ticket_id, updated_at')
      .eq('status', 'completed')
      .not('ticket_id', 'is', null)
      .lt('updated_at', cutoff)
      .gt('updated_at', floor)
      .limit(2000);
    if (error || !done || !done.length) return 0;
    const lastDoneByTicket = {};
    for (const r of done) {
      const ms = Date.parse(r.updated_at);
      if (!(r.ticket_id in lastDoneByTicket) || ms > lastDoneByTicket[r.ticket_id]) lastDoneByTicket[r.ticket_id] = ms;
    }
    const ticketIds = Object.keys(lastDoneByTicket);
    const toResolve = [];
    for (let i = 0; i < ticketIds.length; i += 150) {
      const chunk = ticketIds.slice(i, i + 150);
      const { data: tickets } = await supabase
        .from('tickets')
        .select('id, status, manually_resolved_at, attributes')
        .in('id', chunk)
        .eq('status', 'open')
        .is('manually_resolved_at', null);
      if (!tickets || !tickets.length) continue;
      const { data: active } = await supabase
        .from('assignments')
        .select('ticket_id')
        .in('ticket_id', tickets.map((t) => t.id))
        .in('status', ['planned', 'notified']);
      const hasActive = new Set((active || []).map((a) => a.ticket_id));
      for (const t of tickets) {
        if (hasActive.has(t.id)) continue;
        const reopened = reopenedAtOf(t);
        if (reopened !== null && lastDoneByTicket[t.id] <= reopened) continue;
        toResolve.push(t.id);
      }
    }
    if (!toResolve.length) return 0;
    let resolved = 0;
    for (let i = 0; i < toResolve.length; i += 150) {
      const chunk = toResolve.slice(i, i + 150);
      const { data, error: uErr } = await supabase
        .from('tickets')
        .update({
          manually_resolved_at: new Date().toISOString(),
          manually_resolved_note: 'Stop marked done; no matching visit after a day (reopens if Neumo sends a new dispatch)',
        })
        .in('id', chunk)
        .eq('status', 'open')
        .is('manually_resolved_at', null)
        .select('id');
      if (uErr) console.error('[ticket-state] done-stop sweep update failed:', uErr.message);
      else resolved += (data || []).length;
    }
    return resolved;
  } catch (e) {
    console.error('[ticket-state] done-stop sweep threw:', e.message);
    return 0;
  }
}

module.exports = { isClosedAnyWay, reopenedAtOf, visitPredatesReopen, reopenClearFields, closeStopsForTickets, sweepDoneStopTickets };
