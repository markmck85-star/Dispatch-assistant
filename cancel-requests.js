/* Cancel-request banner (shared by index.html and watchdog-log.html).
 * Shows tickets Neumo asked to cancel by email; a dispatcher confirms or
 * keeps each. Nothing is cancelled automatically.
 * Usage: window.initCancelRequests({ mount: element, state: 'IN' | '' }) */
(function () {
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  window.initCancelRequests = function (opts) {
    var mount = opts.mount;
    if (!mount) return;
    var items = [];

    function render() {
      if (!items.length) { mount.style.display = 'none'; mount.innerHTML = ''; return; }
      mount.style.display = '';
      mount.innerHTML =
        '<div style="background:#2a1a1a;border:2px solid #ef4444;border-radius:6px;padding:10px 12px;margin:10px 0;">' +
        '<div style="color:#fca5a5;font-weight:bold;font-size:14px;margin-bottom:6px;">🛑 Neumo asked to cancel ' + items.length + ' ticket' + (items.length === 1 ? '' : 's') + '</div>' +
        items.map(function (it, i) {
          var tag = it.confidence === 'clear'
            ? '<span style="background:#b91c1c;color:#fff;border-radius:3px;padding:1px 6px;font-size:11px;">Cancel requested</span>'
            : '<span style="background:#92400e;color:#fff;border-radius:3px;padding:1px 6px;font-size:11px;">Possible cancellation</span>';
          return '<div style="border-top:1px solid #4b2a2a;padding:8px 0;">' +
            '<div style="color:#fecaca;font-size:13px;">' + tag + ' <b>' + esc(it.siteCode || '') + '</b> ' + esc(it.siteName || '') + ' · WO ' + esc(it.woNumber) + (it.state ? ' · ' + esc(it.state) : '') + '</div>' +
            '<div style="color:#d1a5a5;font-size:12px;margin:3px 0 6px;">“' + esc(it.excerpt) + '” — ' + esc(it.sender) + '</div>' +
            '<button data-i="' + i + '" data-a="confirm" style="padding:6px 12px;background:#ef4444;color:#fff;border:none;border-radius:4px;font-weight:bold;font-size:12px;cursor:pointer;margin-right:6px;">Confirm cancel</button>' +
            '<button data-i="' + i + '" data-a="keep" style="padding:6px 12px;background:#333;color:#ccc;border:none;border-radius:4px;font-size:12px;cursor:pointer;">Keep ticket</button>' +
            '</div>';
        }).join('') + '</div>';
      mount.querySelectorAll('button[data-a]').forEach(function (b) {
        b.onclick = function () { act(items[+b.dataset.i], b.dataset.a, b); };
      });
    }

    function act(it, action, btn) {
      if (action === 'confirm' && !window.confirm('Cancel WO ' + it.woNumber + ' (' + (it.siteCode || it.siteName) + ')? This closes it here and removes it from the board.')) return;
      btn.disabled = true;
      fetch('/.netlify/functions/cancel-requests', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wo_number: it.woNumber, action: action })
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (!d.ok) throw new Error(d.error || 'failed');
        items = items.filter(function (x) { return x.woNumber !== it.woNumber; });
        render();
        if (typeof opts.onResolved === 'function') opts.onResolved(it, action, d);
      }).catch(function (e) { btn.disabled = false; alert('Could not update: ' + e.message); });
    }

    function load() {
      fetch('/.netlify/functions/cancel-requests' + (opts.state ? '?state=' + encodeURIComponent(opts.state) : ''))
        .then(function (r) { return r.json(); })
        .then(function (d) { if (d.ok) { items = d.items || []; render(); } })
        .catch(function () { /* silent */ });
    }
    load();
    setInterval(load, 5 * 60 * 1000);
  };
})();
