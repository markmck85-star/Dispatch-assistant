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
  if (v instanceof Date && !isNaN(v.getTime())) {
    // +12h so a value a few seconds before midnight (a SheetJS quirk) still
    // lands on the right calendar day.
    return new Date(v.getTime() + 12 * 3600 * 1000).toISOString().slice(0, 10);
  }
  const s = cellText(v);
  const d = new Date(s);
  return s && !isNaN(d.getTime()) ? new Date(d.getTime() + 12 * 3600 * 1000).toISOString().slice(0, 10) : null;
}

const FORM_BUCKET = /^(\d+)\s*-\s*(\d+)$/;
const JOURNAL_BUCKET = /^(?:LT\s*)?\.\d+$/i;

function classify(name) {
  const n = String(name || '').toUpperCase();
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
      if (/^inv(entory)? date:?$/i.test(t)) out.invDate = toIsoDate(row[c + 1]);
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
    forms: pick('forms').map((i) => ({ code: i.code, name: i.name, year: (/\((\d{4})\)/.exec(i.name) || [])[1] || null, par: i.par, count: i.count, inTransit: i.inTransit, toOrder: i.toOrder })),
    ribbon: pick('ribbon').map((i) => ({ code: i.code, name: i.name, par: i.par, count: i.count, inTransit: i.inTransit, toOrder: i.toOrder })),
    journal: pick('journal').map((i) => ({ code: i.code, name: i.name, par: i.par, count: i.count, inTransit: i.inTransit, toOrder: i.toOrder })),
    cleaningCards: pick('cleaning_cards').map((i) => ({ code: i.code, name: i.name, par: i.par, count: i.count, inTransit: i.inTransit, toOrder: i.toOrder })),
    partialsPresent: out.partials.some((p) => p.partialRolls > 0),
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
