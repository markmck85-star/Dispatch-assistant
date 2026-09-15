// resolve-restock-review.js
//
// A dispatcher's confirm/reject action from restock-tracker.html's review
// toast (see get-restock-review-queue.js). Confirming sets
// included_restock=true (same effect as a high-confidence auto-match);
// rejecting just clears the pending flag and leaves included_restock
// alone. Either way restock_review_pending is cleared so the item drops
// off the toast, and the decision/timestamp are kept for a basic audit
// trail rather than silently disappearing.
//
// POST body: { id: <site_visits.id>, decision: 'confirmed' | 'rejected' }

const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
    body: JSON.stringify(obj),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'POST required' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    return json(400, { ok: false, error: 'Malformed JSON body' });
  }

  const { id, decision } = body;
  if (!id || !['confirmed', 'rejected'].includes(decision)) {
    return json(400, { ok: false, error: "id and decision ('confirmed' or 'rejected') are required" });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const update = {
    restock_review_pending: false,
    restock_review_decision: decision,
    restock_review_resolved_at: new Date().toISOString(),
  };
  if (decision === 'confirmed') {
    update.included_restock = true;
    update.included_restock_source = 'closing_note_confirmed';
  }

  const { error } = await supabase.from('site_visits').update(update).eq('id', id);
  if (error) return json(500, { ok: false, error: 'Update failed: ' + error.message });

  return json(200, { ok: true, id, decision });
};
