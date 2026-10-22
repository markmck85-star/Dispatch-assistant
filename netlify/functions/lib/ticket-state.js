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

module.exports = { isClosedAnyWay, reopenedAtOf, visitPredatesReopen, reopenClearFields };
