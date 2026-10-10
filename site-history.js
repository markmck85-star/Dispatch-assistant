/* site-history.js
 *
 * ONE shared Visit History popup for every dispatch page (dispatch board,
 * State Console, Saturday On-Call). Before this file existed each page had
 * its own copy of this code and the copies drifted apart, so a feature added
 * on the board (View Note, ticket emails, BlueFolder entries) never reached
 * the other pages. Change the popup HERE and every page gets it.
 *
 * Usage on a page:
 *   <script src="/site-history.js"></script>
 *   showSiteHistory('FL1072');                      // open the popup
 *   viewSourceEmail(inboundEmailId, siteCode);      // open one ticket email
 *
 * Optional per-page hook (State Console uses this):
 *   SiteHistory.configure({ onSendToBoard: function (email) { ... } });
 *   Adds a "Send to Dispatch Board" button to the ticket email viewer.
 *   email = { subject, sender, dateStr, bodyText, siteCode }
 *
 * Backend: GET /.netlify/functions/get-site-history, get-source-email and
 * POST /.netlify/functions/mark-site-restocked (all already exist).
 */
(function () {
  'use strict';
  if (window.SiteHistory) return;

  var cfg = {
    markRestocked: true,   // "Mark Restocked" button in the popup header
    forwardEmail: true,    // "Forward" button in the ticket email viewer
    onSendToBoard: null    // function (email) -> adds a "Send to Dispatch Board" button
  };

  var st = null;           // { code, visits, hasMore, totalVisits, shipments }
  var currentCode = null;  // site code the popup is open for (Mark Restocked uses it)
  var lastEmail = null;    // last ticket email shown (Forward / Send to Board use it)

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtDate(iso, withYear) {
    if (!iso) return 'Unknown date';
    var o = { month: 'short', day: 'numeric' };
    if (withYear !== false) o.year = 'numeric';
    return new Date(iso).toLocaleDateString('en-US', o);
  }

  // ── Popup shell (built on first use, so pages need no markup of their own) ──
  function ensureOverlay() {
    var o = document.getElementById('siteHistoryOverlay');
    if (o) return o;
    o = document.createElement('div');
    o.id = 'siteHistoryOverlay';
    o.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:9999;';
    o.onclick = function (e) { if (e.target === o) closeSiteHistory(); };
    o.innerHTML =
      '<div style="background:#fff;color:#333;max-width:600px;margin:40px auto;padding:20px;border-radius:8px;max-height:80vh;overflow-y:auto;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;text-align:left;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:8px;">' +
          '<h3 id="siteHistoryTitle" style="margin:0;color:#222;font-size:17px;line-height:1.3;">Visit History</h3>' +
          '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">' +
            '<button type="button" id="siteHistoryMarkBtn" onclick="markSiteRestockedFromModal()" style="background:#2e7d32;color:#fff;border:none;border-radius:6px;padding:6px 10px;font-size:12px;cursor:pointer;">✅ Mark Restocked</button>' +
            '<button type="button" onclick="printSiteHistory()" style="background:#6c757d;color:#fff;border:none;border-radius:6px;padding:6px 10px;font-size:12px;cursor:pointer;">🖨️ Save as PDF</button>' +
            '<button type="button" onclick="closeSiteHistory()" aria-label="Close" style="background:none;border:none;font-size:20px;cursor:pointer;color:#222;">&times;</button>' +
          '</div>' +
        '</div>' +
        '<div id="siteHistoryBody" style="font-size:13px;color:#333;">Loading…</div>' +
      '</div>';
    document.body.appendChild(o);
    return o;
  }

  function closeSiteHistory() {
    var o = document.getElementById('siteHistoryOverlay');
    if (o) o.style.display = 'none';
    currentCode = null;
  }

  // ── Second-level popup: ticket email or closing note, over the history list ──
  function closeSourceEmail() {
    var el = document.getElementById('sourceEmailOverlay');
    if (el) el.remove();
  }

  function openSub(innerHtml) {
    closeSourceEmail();
    var o = document.createElement('div');
    o.id = 'sourceEmailOverlay';
    o.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;width:100%;height:100%;height:100dvh;background:rgba(0,0,0,0.55);z-index:2147483000;display:flex;align-items:flex-start;justify-content:center;padding:10px;padding-top:max(10px,env(safe-area-inset-top));overflow-y:auto;-webkit-overflow-scrolling:touch;box-sizing:border-box;';
    o.onclick = function (e) { if (e.target === o) closeSourceEmail(); };
    o.innerHTML =
      '<div style="background:#fff;color:#1a1a1a;border-radius:10px;max-width:640px;width:100%;max-height:calc(100dvh - 20px);overflow-y:auto;padding:18px 16px 20px;position:relative;box-sizing:border-box;margin:0;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;text-align:left;">' +
        '<button type="button" onclick="closeSourceEmail()" aria-label="Close" style="position:absolute;top:10px;right:10px;background:#eee;border:none;border-radius:16px;width:32px;height:32px;font-size:18px;cursor:pointer;color:#333;">✕</button>' +
        '<div id="sourceEmailBody">' + innerHtml + '</div>' +
      '</div>';
    document.body.appendChild(o);
    o.scrollTop = 0;
    return document.getElementById('sourceEmailBody');
  }

  async function viewSourceEmail(inboundEmailId, siteCode) {
    var body = openSub('Loading…');
    lastEmail = null;
    try {
      var res = await fetch('/.netlify/functions/get-source-email?id=' + encodeURIComponent(inboundEmailId));
      var data = await res.json();
      if (!body.isConnected) return; // closed while loading
      if (!data.ok) { body.textContent = 'Failed to load email: ' + (data.error || 'unknown error'); return; }
      var dateStr = data.receivedAt
        ? new Date(data.receivedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
        : '';
      lastEmail = { subject: data.subject, sender: data.sender, dateStr: dateStr, bodyText: data.bodyText, siteCode: siteCode || null };
      var btns = '';
      if (cfg.forwardEmail) {
        btns += '<button type="button" onclick="forwardSourceEmail()" style="background:#2e7d5b;color:#fff;border:none;border-radius:6px;padding:7px 14px;font-size:13px;cursor:pointer;margin:0 8px 12px 0;">↪ Forward</button>';
      }
      if (typeof cfg.onSendToBoard === 'function') {
        btns += '<button type="button" onclick="SiteHistory.sendToBoard()" style="background:#2a5b9e;color:#fff;border:none;border-radius:6px;padding:7px 14px;font-size:13px;cursor:pointer;margin:0 8px 12px 0;">📋 Send to Dispatch Board</button>';
      }
      body.innerHTML =
        '<div style="font-weight:600;font-size:16px;margin-bottom:4px;padding-right:36px;">' + esc(data.subject) + '</div>' +
        '<div style="color:#666;font-size:13px;margin-bottom:12px;">' + (data.sender ? esc(data.sender) + ' · ' : '') + esc(dateStr) + '</div>' +
        (btns ? '<div>' + btns + '</div>' : '') +
        '<div style="white-space:pre-wrap;font-size:14px;line-height:1.5;border-top:1px solid #eee;padding-top:12px;">' + (esc(data.bodyText) || '<span style="color:#999;">(empty body)</span>') + '</div>';
    } catch (e) {
      if (body.isConnected) body.textContent = 'Failed to load email: ' + e.message;
    }
  }

  function forwardSourceEmail() {
    if (!lastEmail) return;
    var fwdSubject = 'Fwd: ' + (lastEmail.subject || '(no subject)');
    var fwdBody = '---------- Forwarded message ----------\nFrom: ' + (lastEmail.sender || '(unknown sender)') +
      '\nDate: ' + lastEmail.dateStr + '\nSubject: ' + (lastEmail.subject || '(no subject)') + '\n\n' + (lastEmail.bodyText || '');
    window.location.href = 'mailto:?subject=' + encodeURIComponent(fwdSubject) + '&body=' + encodeURIComponent(fwdBody);
  }

  function sendToBoard() {
    if (lastEmail && typeof cfg.onSendToBoard === 'function') cfg.onSendToBoard(lastEmail);
  }

  function viewClosingNoteFromHistory(i) {
    var v = st && st.visits && st.visits[i];
    if (!v || !v.closing_note) return;
    var body = openSub('');
    body.innerHTML =
      '<div style="font-weight:600;font-size:16px;margin-bottom:6px;padding-right:36px;">' + (v.source === 'bluefolder' ? '📁 BlueFolder note' : '📝 Closing Note') + '</div>' +
      '<div style="font-size:12px;color:#666;margin-bottom:12px;">' + esc(v.started_at ? fmtDate(v.started_at) : '') + ' · ' + esc(v.tech_name_raw || '') + (v.wo_number ? ' · WO ' + esc(v.wo_number) : '') + '</div>' +
      '<div style="white-space:pre-wrap;font-size:14px;line-height:1.5;border-top:1px solid #eee;padding-top:12px;">' + esc(v.closing_note) + '</div>';
  }

  // ── Visit list ──
  function kindInfo(v) {
    var isRestockLike = v.is_restock || /preventative/i.test(v.remediation || '');
    var label = v.source === 'bluefolder'
      ? ('BlueFolder' + (v.remediation && v.remediation !== 'BlueFolder' ? ' · ' + v.remediation : ''))
      : v.source === 'email_ticket'
        ? (v.remediation || 'Ticket')
        : (isRestockLike ? 'Restock' : (v.remediation || 'Service'));
    return { color: isRestockLike ? '#2e7d32' : '#c62828', label: label };
  }

  function upsLink(num) {
    return '<a href="https://www.ups.com/track?loc=en_US&tracknum=' + encodeURIComponent(num) + '" target="_blank" rel="noopener" style="color:#1565c0;">' + esc(num) + '</a>';
  }

  function returnStatusHtml(s) {
    if (!s.return_broken_part) return '';
    return s.returned_at
      ? '<span style="color:#2e7d32;">Returned ' + fmtDate(s.returned_at, false) + '</span>'
      : '<span style="color:#c62828;">Return still needed</span>';
  }

  function renderSiteHistoryBody() {
    var body = document.getElementById('siteHistoryBody');
    if (!body || !st) return;
    var html = st.visits.map(function (v, i) {
      var k = kindInfo(v);
      var dur = v.duration_min != null ? Math.round(v.duration_min) + ' min' : '';
      var reviewNote = v.needs_review ? ' <span style="color:#999;font-size:11px;">(site match unconfirmed)</span>' : '';
      var sa = v.appointment_number
        ? (v.inbound_email_id
            ? '<div><button type="button" onclick="viewSourceEmail(\'' + esc(v.inbound_email_id) + '\', \'' + esc(st.code) + '\')" style="background:none;border:none;padding:0;color:#1a56c4;font-weight:600;text-decoration:underline;cursor:pointer;font-size:inherit;font-family:inherit;">' + esc(v.appointment_number) + '</button></div>'
            : '<div style="color:#333;font-weight:600;">' + esc(v.appointment_number) + '</div>')
        : '';
      var ticketBtn = (v.source === 'email_ticket' && v.inbound_email_id)
        ? '<button type="button" onclick="viewSourceEmail(\'' + esc(v.inbound_email_id) + '\', \'' + esc(st.code) + '\')" style="background:none;border:none;padding:0;margin-top:4px;color:#1a56c4;font-weight:600;text-decoration:underline;cursor:pointer;font-size:12px;font-family:inherit;">✉️ View ticket email</button>'
        : '';
      var noteBtn = v.closing_note
        ? '<button type="button" onclick="viewClosingNoteFromHistory(' + i + ')" style="background:none;border:none;padding:0;margin-top:4px;color:#1b7a3d;font-weight:600;text-decoration:underline;cursor:pointer;font-size:12px;font-family:inherit;">' + (v.source === 'bluefolder' ? '📁 View BlueFolder note' : '📝 View Note') + '</button>'
        : '';
      return '<div style="padding:8px 0;border-bottom:1px solid #eee;">' +
        '<div><strong>' + esc(fmtDate(v.started_at)) + '</strong> — <span style="color:' + k.color + ';">' + esc(k.label) + '</span>' + (dur ? ' · ' + dur : '') + '</div>' +
        '<div style="color:#555;">' + esc(v.tech_name_raw || 'Unknown tech') + (v.remediation_detail ? ' — ' + esc(v.remediation_detail) : '') + reviewNote + '</div>' +
        sa +
        (v.wo_number ? '<div style="color:#999;font-size:11px;">' + (v.source === 'bluefolder' ? 'BF' : 'WO') + ' ' + esc(v.wo_number) + '</div>' : '') +
        ticketBtn +
        (ticketBtn && noteBtn ? '<br>' : '') +
        noteBtn +
      '</div>';
    }).join('');

    if (st.hasMore) {
      html += '<button type="button" onclick="loadMoreSiteHistory()" id="siteHistoryLoadMoreBtn" style="width:100%;padding:10px;margin-top:8px;background:#eee;border:1px solid #ccc;border-radius:6px;cursor:pointer;color:#333;">Load 15 more (' + (st.totalVisits - st.visits.length) + ' remaining)</button>';
    }

    if (st.shipments && st.shipments.length) {
      html += '<h4 style="margin:16px 0 4px;font-size:13px;color:#333;">Related Shipments</h4>' + st.shipments.map(function (s) {
        var tracking = [];
        if (s.outbound_tracking) tracking.push('Out: ' + upsLink(s.outbound_tracking));
        if (s.inbound_tracking) tracking.push('In: ' + upsLink(s.inbound_tracking));
        var rs = returnStatusHtml(s);
        return '<div style="padding:8px 0;border-bottom:1px solid #eee;">' +
          '<div><strong>' + esc(fmtDate(s.received_at)) + '</strong> — WO ' + esc(s.wo_number || '?') + (s.warehouse_name ? ' · ' + esc(s.warehouse_name) : '') + '</div>' +
          '<div style="color:#555;font-size:12px;">' + tracking.join(' · ') + '</div>' +
          (rs ? '<div style="font-size:12px;">' + rs + '</div>' : '') +
        '</div>';
      }).join('');
    }
    body.innerHTML = html;
  }

  async function loadMoreSiteHistory() {
    if (!st) return;
    var btn = document.getElementById('siteHistoryLoadMoreBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
    try {
      // offset counts closed-ticket visits only; email-ticket / BlueFolder
      // entries are merged into the first page on top of those.
      var offset = st.visits.filter(function (v) { return !v.source || v.source === 'site_visit'; }).length;
      var res = await fetch('/.netlify/functions/get-site-history?code=' + encodeURIComponent(st.code) + '&offset=' + offset);
      var data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
      st.visits = st.visits.concat(data.visits || []);
      st.hasMore = data.hasMore;
      st.totalVisits = data.totalVisits;
      var seen = {};
      st.shipments.forEach(function (s) { seen[s.wo_number + '|' + s.outbound_tracking] = true; });
      (data.shipments || []).forEach(function (s) {
        var key = s.wo_number + '|' + s.outbound_tracking;
        if (!seen[key]) { st.shipments.push(s); seen[key] = true; }
      });
      renderSiteHistoryBody();
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = 'Error loading more -- tap to retry'; }
    }
  }

  async function showSiteHistory(code) {
    var overlay = ensureOverlay();
    var title = document.getElementById('siteHistoryTitle');
    var body = document.getElementById('siteHistoryBody');
    var markBtn = document.getElementById('siteHistoryMarkBtn');
    if (markBtn) markBtn.style.display = cfg.markRestocked ? '' : 'none';
    currentCode = code;
    title.textContent = 'Visit History — ' + code;
    body.innerHTML = 'Loading…';
    overlay.style.display = 'block';
    try {
      var res = await fetch('/.netlify/functions/get-site-history?code=' + encodeURIComponent(code));
      var data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
      if (currentCode !== code) return; // popup was closed or reopened for another site
      title.textContent = 'Visit History — ' + data.site.name + ' (' + data.site.code + ')';
      if (!data.visits.length) {
        body.innerHTML = '<em>No visit history found for this site yet.</em>';
        st = null;
        return;
      }
      st = { code: code, visits: data.visits, hasMore: data.hasMore, totalVisits: data.totalVisits, shipments: data.shipments || [] };
      renderSiteHistoryBody();
    } catch (err) {
      if (currentCode === code) body.innerHTML = '<span style="color:#c62828;">Error loading history: ' + esc(err.message) + '</span>';
    }
  }

  // ── Mark Restocked (records a manual confirmation; does not touch the overdue math) ──
  async function markSiteRestockedFromModal() {
    var code = currentCode;
    if (!code) return;
    if (!confirm('Mark ' + code + ' as restocked today?')) return;
    var note = prompt('Optional note (e.g. "opportunistic, done alongside GA1011"):', '') || null;
    try {
      var res = await fetch('/.netlify/functions/mark-site-restocked', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site_code: code, note: note })
      });
      var data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
      alert(code + ' marked as restocked.');
    } catch (err) {
      alert('Failed to mark restocked: ' + err.message);
    }
  }

  // ── Save as PDF (opens a printable page of the FULL history) ──
  async function printSiteHistory(ev) {
    if (!st || !st.visits.length) {
      alert('No visit history loaded to export yet.');
      return;
    }
    var e = ev || window.event;
    var btn = e && e.target;
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
    try {
      while (st.hasMore) {
        var before = st.visits.length;
        await loadMoreSiteHistory();
        if (st.visits.length === before) break; // a failed page must not loop forever
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🖨️ Save as PDF'; }
    }

    var titleText = document.getElementById('siteHistoryTitle').textContent;
    var generatedOn = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    var content = '<div class="print-header"><div class="print-title">' + esc(titleText) + '</div>' +
      '<div class="print-date">Exported ' + generatedOn + ' · ' + (st.totalVisits || st.visits.length) + ' visits</div></div>';

    content += st.visits.map(function (v) {
      var k = kindInfo(v);
      var dur = v.duration_min != null ? Math.round(v.duration_min) + ' min' : '';
      var reviewNote = v.needs_review ? ' <span style="color:#999;font-size:11px;">(site match unconfirmed)</span>' : '';
      return '<div class="print-stop">' +
        '<div><strong>' + esc(fmtDate(v.started_at)) + '</strong> — <span style="color:' + k.color + ';">' + esc(k.label) + '</span>' + (dur ? ' · ' + dur : '') + '</div>' +
        '<div class="print-stop-addr">' + esc(v.tech_name_raw || 'Unknown tech') + (v.remediation_detail ? ' — ' + esc(v.remediation_detail) : '') + reviewNote + '</div>' +
        (v.appointment_number ? '<div style="color:#333;font-weight:600;">' + esc(v.appointment_number) + '</div>' : '') +
        (v.wo_number ? '<div style="color:#999;font-size:11px;">' + (v.source === 'bluefolder' ? 'BF' : 'WO') + ' ' + esc(v.wo_number) + '</div>' : '') +
      '</div>';
    }).join('');

    if (st.shipments && st.shipments.length) {
      content += '<h4 style="margin:16px 0 4px;">Related Shipments</h4>' + st.shipments.map(function (s) {
        var tracking = [];
        if (s.outbound_tracking) tracking.push('Out: ' + esc(s.outbound_tracking));
        if (s.inbound_tracking) tracking.push('In: ' + esc(s.inbound_tracking));
        var rs = returnStatusHtml(s);
        return '<div class="print-stop">' +
          '<div><strong>' + esc(fmtDate(s.received_at)) + '</strong> — WO ' + esc(s.wo_number || '?') + (s.warehouse_name ? ' · ' + esc(s.warehouse_name) : '') + '</div>' +
          '<div class="print-stop-addr">' + tracking.join(' · ') + '</div>' +
          (rs ? '<div>' + rs + '</div>' : '') +
        '</div>';
      }).join('');
    }

    var docTitle = titleText.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_');
    var html = '<!DOCTYPE html>\n<html><head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<title>' + esc(docTitle) + '</title>\n<style>\n' +
      "  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 16px; font-size: 15px; color: #222; max-width: 700px; margin: 0 auto; }\n" +
      '  .print-btn { display: block; width: 100%; padding: 14px; background: #007bff; color: white; border: none; border-radius: 8px; font-size: 17px; font-weight: 600; margin-bottom: 16px; cursor: pointer; }\n' +
      '  .print-header { margin-bottom: 16px; border-bottom: 2px solid #333; padding-bottom: 8px; }\n' +
      '  .print-title { font-size: 20px; font-weight: bold; }\n' +
      '  .print-date { font-size: 14px; color: #555; margin-top: 2px; }\n' +
      '  .print-stop { padding: 8px 0; border-bottom: 1px solid #eee; }\n' +
      '  .print-stop:last-child { border-bottom: none; }\n' +
      '  .print-stop-addr { font-size: 13px; color: #555; margin-top: 2px; }\n' +
      '  @media print { .print-btn { display: none; } body { padding: 0; } }\n' +
      '</style>\n</head><body>\n<button class="print-btn" onclick="window.print()">🖨️ Save as PDF / Print</button>\n' + content + '</body></html>';

    var blob = new Blob([html], { type: 'text/html' });
    var blobUrl = URL.createObjectURL(blob);
    var printWin = window.open(blobUrl, '_blank');
    if (!printWin) {
      alert('Please allow popups to export this, or long-press the Save as PDF button and choose "Open in new tab".');
      URL.revokeObjectURL(blobUrl);
      return;
    }
    setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 10000);
  }

  // Escape closes the top-most popup only.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (document.getElementById('sourceEmailOverlay')) { closeSourceEmail(); return; }
    var o = document.getElementById('siteHistoryOverlay');
    if (o && o.style.display !== 'none') closeSiteHistory();
  });

  // Public API. The bare globals keep every existing onclick="showSiteHistory(...)"
  // and viewSourceEmail(...) call on the pages working unchanged.
  window.SiteHistory = {
    configure: function (opts) { for (var k in (opts || {})) cfg[k] = opts[k]; },
    show: showSiteHistory,
    close: closeSiteHistory,
    sendToBoard: sendToBoard
  };
  window.showSiteHistory = showSiteHistory;
  window.closeSiteHistory = closeSiteHistory;
  window.viewSourceEmail = viewSourceEmail;
  window.closeSourceEmail = closeSourceEmail;
  window.forwardSourceEmail = forwardSourceEmail;
  window.viewClosingNoteFromHistory = viewClosingNoteFromHistory;
  window.loadMoreSiteHistory = loadMoreSiteHistory;
  window.printSiteHistory = printSiteHistory;
  window.markSiteRestockedFromModal = markSiteRestockedFromModal;
})();
