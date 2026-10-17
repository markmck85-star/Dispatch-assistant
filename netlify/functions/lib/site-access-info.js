// site-access-info.js
//
// Pulls the site access details out of a Neumo ticket email: Operating Hours,
// Phone and Time Zone. Added 2026-10-17 because some states (Indiana first)
// have locations with limited access, and the hours were only ever visible in
// the raw email.
//
//   parseSiteAccess(text) -> { operatingHours, sitePhone, siteTimeZone }  (each null when absent)
//   hoursForDay(hoursText, weekdayIdx) -> "9am-5pm" | "Closed" | null
//        weekdayIdx: 0=Sun .. 6=Sat. null means the text could not be read
//        confidently, so callers should show the full string instead.

function parseSiteAccess(raw) {
  const out = { operatingHours: null, sitePhone: null, siteTimeZone: null };
  if (!raw || typeof raw !== 'string') return out;
  const text = raw.replace(/\s+/g, ' ');
  const STOP = '(?=\\s*(?:Time\\s+Zone\\s*:|Phone\\s*:|Operating\\s+Hours\\s*:|Address\\s*:|Line\\s+Item\\s+Number|Account\\s+Name|ATM\\s+ID|SST\\s+Name|PC\\s+Name|Thank\\s+you)|$)';
  const h = text.match(new RegExp('Operating\\s+Hours\\s*:\\s*(.*?)' + STOP, 'i'));
  if (h && h[1].trim() && h[1].trim().length <= 200) out.operatingHours = h[1].trim();
  const p = text.match(new RegExp('Phone\\s*:\\s*([\\d()+.\\- ]{7,25}?)' + STOP, 'i'));
  if (p && p[1].trim()) out.sitePhone = p[1].trim();
  const z = text.match(/Time\s+Zone\s*:\s*([A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)/i);
  if (z) out.siteTimeZone = z[1];
  return out;
}

const DAY_ALIASES = [
  ['sun', 'sunday'], ['mon', 'monday'], ['tue', 'tues', 'tuesday'], ['wed', 'weds', 'wednesday'],
  ['thu', 'thur', 'thurs', 'thursday'], ['fri', 'friday'], ['sat', 'saturday'],
];
function dayIndex(tok) {
  const t = tok.toLowerCase();
  for (let i = 0; i < 7; i++) if (DAY_ALIASES[i].includes(t)) return i;
  return -1;
}

function hoursForDay(hoursText, weekdayIdx) {
  if (!hoursText || typeof hoursText !== 'string') return null;
  // Segments look like "Tues 9am – 6:30pm", "Wed/Thur/Fri 9am – 5pm", "Mon-Fri 8-5", "Sat Closed".
  const segs = hoursText.split(/[,;]|\band\b/i).map(s => s.trim()).filter(Boolean);
  let found = null;
  for (const seg of segs) {
    const m = seg.match(/^((?:[A-Za-z]+)(?:\s*[\/&-]\s*[A-Za-z]+)*)\s*:?\s*(.+)$/);
    if (!m) return null;
    const days = new Set();
    const dayPart = m[1];
    const parts = dayPart.split(/\s*([\/&-])\s*/);
    // parts: tok, sep, tok, sep, tok ...
    let prev = null, sep = null;
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) { sep = parts[i]; continue; }
      const idx = dayIndex(parts[i]);
      if (idx < 0) return null; // unrecognised day word: do not guess
      if (sep === '-' && prev !== null) {
        for (let d = prev; ; d = (d + 1) % 7) { days.add(d); if (d === idx) break; }
      } else days.add(idx);
      prev = idx; sep = null;
    }
    if (days.has(weekdayIdx)) found = m[2].trim().replace(/\s*[–—-]\s*/g, '-').replace(/\s+/g, ' ');
  }
  return found || 'Closed';
}

module.exports = { parseSiteAccess, hoursForDay };
