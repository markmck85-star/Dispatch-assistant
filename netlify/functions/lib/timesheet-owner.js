/**
 * netlify/functions/lib/timesheet-owner.js  (v1, 2026-10-25)
 *
 * Whose timesheet is it when the sheet's own NAME cells are blank? Falls back to the address the
 * sheet was emailed from: the exact address on a technician card, or the company mailbox name
 * (rthomas@, randy.thomas@, randythomas@). Mail passed along by the office says nothing about the
 * owner, so those addresses never resolve. Never guesses: two possible people means no answer.
 */
const OFFICE_ADDRESSES = new Set(['tkadri@mcrtechservice.com', 'mbecker@mcrtechservice.com', 'expense@mcrtechservice.com', 'inventory@mcrtechservice.com', 'dispatch@mcrdispatch.net']);

function addressOf(s) { const m = String(s || '').match(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/); return m ? m[0].toLowerCase() : ''; }
function words(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ').split(/\s+/).filter(Boolean); }

async function resolveTechnicianNameFromSender(supabase, sender) {
  const addr = addressOf(sender);
  if (!addr || OFFICE_ADDRESSES.has(addr)) return null;
  const { data, error } = await supabase.from('technicians').select('id, name, email, active').eq('active', true);
  if (error || !data) return null;
  const byCard = data.filter((t) => String(t.email || '').toLowerCase().split(/[,;\s]+/).includes(addr));
  if (byCard.length === 1) return byCard[0].name;
  if (byCard.length > 1) return null;
  if (/@mcrtechservice\.com$/.test(addr)) {
    const local = addr.split('@')[0];
    const byLocal = data.filter((t) => {
      const w = words(t.name); const first = w[0] || ''; const last = w.length > 1 ? w[w.length - 1] : '';
      return first && last && (local === first[0] + last || local === first + last || local === first + '.' + last);
    });
    if (byLocal.length === 1) return byLocal[0].name;
  }
  return null;
}

module.exports = { resolveTechnicianNameFromSender, addressOf };
