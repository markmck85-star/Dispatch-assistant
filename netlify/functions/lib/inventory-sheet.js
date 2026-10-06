/**
 * lib/inventory-sheet.js
 * SAVE AS: netlify/functions/lib/inventory-sheet.js
 *
 * Reads a technician's weekly Neumo/ITI "INVENTORY COUNT SHEET" (.xlsx) and
 * returns the counts as plain data. Layout it was written against (the
 * Georgia sheet, revised 3/26/2026):
 *
 *   A4/B4   "Tech Name:" / name          D4/E4  "Inv Date:" / date
 *   header  Product Code | <warehouse> | Par | Inventory Count |
 *           In Transit or To Be Repaired | To Be Ordered | Comments
 *   item rows follow (product code in A, description in B)
 *   "Partial Counts" section further down: for each partial-roll product, a
 *   block of size buckets (608-800, 408-600, 208-400, 128-200, 0-120 forms; or
 *   .75 / .50 / .25 / LT .25 for journal paper) with a count per bucket.
 *   Partials are only reliable on month-end sheets (the sheet says so).
 *
 * Everything is found by label, not fixed cell addresses, so a sheet with
 * extra rows or other states' product lists still reads. Nothing is guessed:
 * unrecognized rows are simply left out, and `warnings` says what was off.
 *
 * Pure function (no database), so it can be tested on its own.
 */
const XLSX = require('xlsx');

function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}
function toNumber(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  const s = cellText(v);
  if (s && /^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return null;
}
// Product codes arrive as numbers or text, sometimes with a leading zero
// ("010101030" and 10101030 are the same item). Compare without leading zeros.
function normCode(v) {
  const s = cellText(v).replace(/\s+/g, '');
  if (!/^\d{5,}$/.test(s)) return null;
  return s.replace(/^0+/, '');
}
function toIsoDate(v) {
  const plus12 = (d) => new Date(d.getTime() + 12 * 3600 * 1000).toISOString().slice(0, 10);
  const sane = (iso) => (iso && iso >= "2024-01-01" && iso <= "2031-12-31" ? iso : null);
  if (v instanceof Date && !isNaN(v.getTime())) {
    // +12h so a value a few seconds before midnight (a SheetJS quirk) still
    // lands on the right calendar day.
    return sane(plus12(v));
  }
  if (typeof v === "number" && v > 40000 && v < 60000) {
    // Excel serial date stored as a plain number.
    return sane(plus12(new Date(Math.round((v - 25569) * 86400000))));
  }
  const s = cellText(v);
  if (!s) return null;
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return sane(`${iso[1]}-${iso[2]}-${iso[3]}`);
  const m = s.match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);
  if (m) {
    const yy = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return sane(`${yy}-${String(m[1]).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`);
  }
  const d = new Date(s);
  return !isNaN(d.getTime()) ? sane(plus12(d)) : null;
}

const FORM_BUCKET = /^(\d+)\s*-\s*(\d+)$/;
const JOURNAL_BUCKET = /^(?:LT\s*)?\.\d+$/i;

function classify(name) {
  const n = String(name || '').toUpperCase();
  // Whole-roll rows sometimes have "partials" glued into the size
  // ("FORM GA SST RED partials4X8.5 800/ROLL (2027)"). Those are still form rolls.
  // A real partials line leads with PARTIAL ("FORM, PARTIALS ..." / "FORM PARTIAL ...").
  // The Partial Counts section is parsed separately and does not come through here.
  if (/^FORM\b/.test(n) && !/^FORM\b[\s,]*PARTIAL/.test(n)) return 'forms';
  if (/PARTIAL/.test(n)) return 'partial';
  if (/^FORM\b/.test(n)) return 'forms';
  if (/RIBBON/.test(n)) return 'ribbon';
  // Journal PAPER only: "PRINTER, JOURNAL ... Paper Guide Extension" is a printer part.
  if (/^PAPER\b/.test(n) && /JOURNAL/.test(n)) return 'journal';
  if (/CLEANING CARD/.test(n)) return 'cleaning_cards';
  return null;
}

function parseInventoryGrid(grid) {
  const warnings = [];
  const out = { techName: null, invDate: null, warehouse: null, items: [], partials: [], summary: {}, warnings };

  // ---- header block
  for (let r = 0; r < Math.min(grid.length, 12); r++) {
    const row = grid[r] || [];
    for (let c = 0; c < row.length; c++) {
      const t = cellText(row[c]);
      if (/^tech name:?$/i.test(t)) out.techName = cellText(row[c + 1]) || null;
      // The date label varies ("Inv Date:", "Inventory Date", "Date:", or label and
      // value in one cell), so accept any "date" label and look in the same cell
      // and the next few cells to the right.
      if (!out.invDate && /^(inv(entory)?\.?\s*)?date\b/i.test(t)) {
        const sameCell = t.replace(/^[^:]*:/, "");
        out.invDate = toIsoDate(sameCell && sameCell !== t ? sameCell : null) ||
          toIsoDate(row[c + 1]) || toIsoDate(row[c + 2]) || toIsoDate(row[c + 3]);
      }
      if (/^whse/i.test(t)) out.warehouse = cellText(row[c + 1]) || null;
    }
  }
  if (!out.techName) warnings.push('Tech name not found');
  if (!out.invDate) warnings.push('Inventory date not found');

  // ---- item table
  let hdr = -1;
  let col = {};
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] || [];
    const texts = row.map(cellText);
    if (texts.some((t) => /^product code$/i.test(t)) && texts.some((t) => /inventory count/i.test(t))) {
      hdr = r;
      texts.forEach((t, c) => {
        if (/^product code$/i.test(t)) col.code = c;
        else if (/^par$/i.test(t)) col.par = c;
        else if (/inventory count/i.test(t)) col.count = c;
        else if (/in transit/i.test(t)) col.transit = c;
        else if (/to be ordered/i.test(t)) col.order = c;
        else if (/^comments?$/i.test(t)) col.comments = c;
      });
      col.name = (col.code || 0) + 1;
      break;
    }
  }
  if (hdr < 0 || col.count === undefined) {
    warnings.push('Item table header (Product Code / Inventory Count) not found');
    return out;
  }

  let partialStart = grid.length;
  for (let r = hdr + 1; r < grid.length; r++) {
    if (/^partial counts/i.test(cellText((grid[r] || [])[col.name]))) { partialStart = r; break; }
  }

  for (let r = hdr + 1; r < partialStart; r++) {
    const row = grid[r] || [];
    const name = cellText(row[col.name]);
    const par = toNumber(row[col.par]);
    const count = toNumber(row[col.count]);
    if (!name || (par === null && count === null)) continue; // section label ("GA SST") or blank
    const item = {
      row: r + 1,
      code: cellText(row[col.code]) || null,
      codeKey: normCode(row[col.code]),
      name,
      kind: classify(name),
      par,
      count,
      inTransit: toNumber(row[col.transit]),
      toOrder: toNumber(row[col.order]),
      comment: cellText(row[col.comments]) || null,
    };
    out.items.push(item);
  }

  // ---- partial counts (month-end only)
  const groups = [];
  let cur = null;
  for (let r = partialStart + 1; r < grid.length; r++) {
    const row = grid[r] || [];
    const bucket = cellText(row[col.par]); // the "Amount" column sits where Par does
    const isForm = FORM_BUCKET.test(bucket);
    const isJournal = JOURNAL_BUCKET.test(bucket) || /^LT\s*\.\d+$/i.test(bucket);
    if (isForm || isJournal) {
      const type = isForm ? 'forms' : 'journal';
      if (!cur || cur.type !== type) { cur = { type, rows: [] }; groups.push(cur); }
      cur.rows.push({ r, bucket, count: toNumber(row[col.count]), code: normCode(row[col.code]), codeRaw: cellText(row[col.code]) || null, label: cellText(row[col.name]) });
    } else if (cellText(row[col.name]) || cellText(row[col.code])) {
      // a note row ends the current group only if it carries no bucket
      if (cur && !normCode(row[col.code])) cur = null;
    } else {
      cur = null;
    }
  }
  for (const g of groups) {
    const idRow = g.rows.find((x) => x.code) || {};
    const buckets = g.rows.map((x) => {
      const m = FORM_BUCKET.exec(x.bucket);
      return { label: x.bucket, count: x.count, mid: m ? (Number(m[1]) + Number(m[2])) / 2 : null };
    });
    const filled = buckets.filter((b) => b.count);
    out.partials.push({
      type: g.type,
      code: idRow.codeRaw || null,
      codeKey: idRow.code || null,
      label: idRow.label || null,
      buckets,
      partialRolls: filled.reduce((s, b) => s + b.count, 0),
      approxForms: g.type === 'forms' ? Math.round(filled.reduce((s, b) => s + b.count * (b.mid || 0), 0)) : null,
    });
  }
  const byKey = {};
  for (const it of out.items) if (it.codeKey) byKey[it.codeKey] = it;
  for (const p of out.partials) {
    const hit = p.codeKey && byKey[p.codeKey];
    p.itemName = hit ? hit.name : null;
    if (p.label && hit && /GREEN|RED/i.test(p.label) && !new RegExp((/GREEN/i.test(hit.name) ? 'GREEN' : 'RED'), 'i').test(p.label)) {
      warnings.push(`Partial block for code ${p.code} is labelled "${p.label}" but that code is "${hit.name}" on the item list (template label mismatch)`);
    }
  }

  // ---- convenience summary for the products the stock check cares about
  const pick = (kind) => out.items.filter((i) => i.kind === kind);
  out.summary = {
    forms: pick('forms').map((i) => ({ code: i.code, name: i.name, year: (/\((\d{4})\)|\b(20\d{2})\b/.exec(i.name) || []).slice(1).find(Boolean) || null, par: i.par, count: i.count, inTransit: i.inTransit, toOrder: i.toOrder })),
    ribbon: pick('ribbon').map((i) => ({ code: i.code, name: i.name, par: i.par, count: i.count, inTransit: i.inTransit, toOrder: i.toOrder })),
    journal: pick('journal').map((i) => ({ code: i.code, name: i.name, par: i.par, count: i.count, inTransit: i.inTransit, toOrder: i.toOrder })),
    cleaningCards: pick('cleaning_cards').map((i) => ({ code: i.code, name: i.name, par: i.par, count: i.count, inTransit: i.inTransit, toOrder: i.toOrder })),
    partialsPresent: out.partials.some((p) => p.partialRolls > 0),
    // Partial-roll counts are only brought current on month-end sheets (the last
    // business day, or the Monday after a weekend month-end). On any other week
    // they are last month's numbers carried forward, so the stock check should
    // lean on whole-roll counts and treat partials as unchanged. Heuristic from
    // the sheet date: the last 3 days of a month, or the Monday/Tuesday right
    // after a month that ended on a weekend. (Sheets dated in the first few days
    // of a month after a weekday month-end, e.g. a Saturday the 3rd, are not.)
    partialsLikelyCurrent: (() => {
      if (!out.invDate) return null;
      const [y, m, d] = out.invDate.split('-').map(Number);
      const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
      if (d >= daysInMonth - 2) return true;
      const prevEnd = new Date(Date.UTC(y, m - 1, 0));      // last day of previous month
      const prevEndDow = prevEnd.getUTCDay();                // 0 Sun .. 6 Sat
      const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
      return d <= 3 && (prevEndDow === 6 || prevEndDow === 0) && (dow === 1 || dow === 2);
    })(),
  };
  if (!out.summary.forms.length) warnings.push('No registration-form rows recognized');
  return out;
}

function parseInventoryWorkbookBuffer(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  return parseInventoryGrid(grid);
}

module.exports = { parseInventoryWorkbookBuffer, parseInventoryGrid, normCode };
