/* state-layout.js — dispatcher section order for the State Console.
 * Map and the state picker stay fixed. The blocks under the map can be
 * hidden or moved. Saved per signed-in username (sessionStorage dispatchUser),
 * so the phone and the office computer match for that login.
 */
(function () {
  'use strict';
  var BLOCKS = [
    { id: 'digest', title: 'Morning brief', sel: '#digestPanelHome' },
    { id: 'traffic', title: 'Traffic', sel: '#trafficPanelHome' },
    { id: 'restock', title: 'Restock status', sel: '#restockSection' },
    { id: 'tickets', title: 'Trouble and maintenance tickets', sel: '#ticketStatus' }
  ];
  var DEFAULTS = BLOCKS.map(function (b) { return { id: b.id, hidden: false }; });

  function userName() {
    try {
      var raw = sessionStorage.getItem('dispatchUser');
      var user = raw ? JSON.parse(raw) : null;
      if (user && user.username) return String(user.username);
    } catch (e) {}
    return 'shared';
  }
  function key() { return 'mcr_state_layout_v1:' + userName(); }
  function load() {
    try {
      var saved = JSON.parse(localStorage.getItem(key()) || 'null');
      if (!Array.isArray(saved) || !saved.length) return DEFAULTS.slice();
      var known = {};
      BLOCKS.forEach(function (b) { known[b.id] = true; });
      var out = saved.filter(function (s) { return s && known[s.id]; });
      DEFAULTS.forEach(function (d) {
        if (!out.some(function (s) { return s.id === d.id; })) out.push({ id: d.id, hidden: false });
      });
      return out;
    } catch (e) { return DEFAULTS.slice(); }
  }
  function save(order) {
    try { localStorage.setItem(key(), JSON.stringify(order)); } catch (e) {}
  }
  function wrap(el) {
    if (!el || el.closest('[data-layout-block]')) return el && el.closest('[data-layout-block]');
    var box = document.createElement('div');
    box.setAttribute('data-layout-block', '');
    el.parentNode.insertBefore(box, el);
    return box;
  }
  function blockEl(id) {
    if (id === 'digest') return wrap(document.querySelector('#digestPanelHome'));
    if (id === 'traffic') return wrap(document.querySelector('#trafficPanelHome'));
    if (id === 'restock') {
      var section = document.getElementById('restockSection');
      if (!section) return null;
      var box = wrap(section);
      var head = section.previousElementSibling;
      if (head && /Restock Status/.test(head.textContent || '') && !box.contains(head)) box.insertBefore(head, box.firstChild);
      return box;
    }
    if (id === 'tickets') {
      var start = document.getElementById('ticketStatus');
      var end = document.getElementById('updateDataSection');
      if (!start || !end) return null;
      var head = start.previousElementSibling;
      var box = wrap(head && /Trouble/.test(head.textContent || '') ? head : start);
      var node = box.nextSibling;
      while (node && node !== end) {
        var next = node.nextSibling;
        box.appendChild(node);
        node = next;
      }
      return box;
    }
    return null;
  }
  function apply() {
    var order = load();
    var anchor = document.getElementById('updateDataSection');
    order.forEach(function (item) {
      var el = blockEl(item.id);
      if (!el) return;
      el.style.display = item.hidden ? 'none' : '';
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(el, anchor);
    });
  }
  function title(id) {
    var b = BLOCKS.filter(function (x) { return x.id === id; })[0];
    return b ? b.title : id;
  }
  function openPanel() {
    var existing = document.getElementById('stateLayoutPanel');
    if (existing) { existing.remove(); return; }
    var order = load();
    var panel = document.createElement('div');
    panel.id = 'stateLayoutPanel';
    panel.style.cssText = 'margin:8px 0 12px;padding:10px;border:1px solid #444;border-radius:8px;background:#1e1e1e;';
    panel.innerHTML = '<div style="font-weight:700;color:#f0a500;margin-bottom:6px;">Page layout for ' + userName() + '</div>' +
      '<div style="font-size:12px;color:#999;margin-bottom:8px;">Map stays at the top. These blocks can be hidden or moved. Saved on this login.</div>' +
      '<div data-rows></div>' +
      '<button type="button" data-done style="margin-top:8px;padding:6px 12px;border-radius:6px;border:1px solid #555;background:#2a2a3e;color:#ccc;">Done</button>';
    function paint() {
      var rows = panel.querySelector('[data-rows]');
      rows.innerHTML = order.map(function (item, i) {
        return '<div style="display:flex;align-items:center;gap:6px;margin:4px 0;">' +
          '<input type="checkbox" data-show="' + item.id + '"' + (item.hidden ? '' : ' checked') + '>' +
          '<span style="flex:1;color:#ddd;">' + title(item.id) + '</span>' +
          '<button type="button" data-up="' + i + '"' + (i ? '' : ' disabled') + '>Up</button>' +
          '<button type="button" data-down="' + i + '"' + (i < order.length - 1 ? '' : ' disabled') + '>Down</button></div>';
      }).join('');
    }
    panel.addEventListener('click', function (e) {
      var t = e.target;
      if (t.hasAttribute('data-done')) { panel.remove(); return; }
      var up = t.getAttribute('data-up');
      var down = t.getAttribute('data-down');
      if (up != null) { up = Number(up); if (up > 0) { var a = order[up - 1]; order[up - 1] = order[up]; order[up] = a; } }
      if (down != null) { down = Number(down); if (down < order.length - 1) { var b = order[down + 1]; order[down + 1] = order[down]; order[down] = b; } }
      save(order); apply(); paint();
    });
    panel.addEventListener('change', function (e) {
      var id = e.target.getAttribute('data-show');
      if (!id) return;
      order.forEach(function (item) { if (item.id === id) item.hidden = !e.target.checked; });
      save(order); apply();
    });
    paint();
    var btn = document.getElementById('stateLayoutBtn');
    if (btn && btn.parentNode) btn.parentNode.insertBefore(panel, btn.nextSibling);
  }
  function mount() {
    if (document.getElementById('stateLayoutBtn')) { apply(); return; }
    var sel = document.getElementById('stateSel');
    if (!sel) return;
    var btn = document.createElement('button');
    btn.id = 'stateLayoutBtn';
    btn.type = 'button';
    btn.textContent = 'Layout';
    btn.style.cssText = 'margin:8px 0;padding:6px 12px;border-radius:6px;border:1px solid #555;background:#2a2a3e;color:#ccc;cursor:pointer;';
    btn.addEventListener('click', openPanel);
    sel.parentNode.insertBefore(btn, sel.nextSibling);
    apply();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
