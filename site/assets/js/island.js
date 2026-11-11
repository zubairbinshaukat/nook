/* Nook site: the island in the header (landing page only, deferred).
   It opens on hover, tap or Enter, and works like the app's own island, with sample sessions. */
(function () {
  'use strict';
  var d = document;
  var isl = d.querySelector('[data-island]');
  if (!isl) return;
  var q = function (s) { return isl.querySelector(s); };
  var qa = function (s) { return Array.prototype.slice.call(isl.querySelectorAll(s)); };
  var pill = q('.isl-pill'), sumEl = q('[data-isl-sum]'), sumS = q('[data-isl-sum-s]'), dotsEl = q('[data-isl-dots]');
  var tabs = qa('[role="tab"]'), panes = qa('.isl-pane');
  var bc = { proj: q('[data-bc="proj"]'), chip: q('[data-bc="chip"]'), task: q('[data-bc="task"]'), ask: q('[data-bc-ask]'), subs: q('[data-bc-subs]') };
  var countEl = q('[data-count]');
  var mqReduce = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ---------- sessions (sample data) ---------- */
  var LABEL = { working: 'Working', thinking: 'Thinking', need: 'Needs you', done: 'Done' };
  var D = {
    korus: { p: 'korus-api', st: 'need', t: 'Wants to run npm test' },
    portfolio: { p: 'portfolio', st: 'thinking', t: 'Thinking…' },
    docs: { p: 'docs-site', st: 'working', t: 'Checking the query plan' },
    billing: { p: 'billing-svc', st: 'done', t: 'Finished the refactor' }
  };
  var ORDER = ['korus', 'portfolio', 'docs', 'billing'], sel = 'korus';
  var btn = {};
  qa('.wb[data-id]').forEach(function (b) { btn[b.getAttribute('data-id')] = b; });

  function render() {
    var c = { working: 0, thinking: 0, need: 0, done: 0 };
    ORDER.forEach(function (id) {
      var s = D[id], b = btn[id];
      c[s.st]++;
      b.setAttribute('data-st', s.st);
      b.querySelector('.wbs').textContent = LABEL[s.st];
      b.setAttribute('aria-pressed', id === sel ? 'true' : 'false');
    });
    var s = D[sel];
    bc.proj.textContent = s.p;
    bc.chip.textContent = LABEL[s.st]; bc.chip.setAttribute('data-st', s.st);
    bc.task.textContent = s.t;
    bc.ask.hidden = s.st !== 'need';
    bc.subs.hidden = sel !== 'docs';
    if (countEl) countEl.textContent = ORDER.length;
    var busy = c.working + c.thinking, parts = [];
    if (busy) parts.push(busy + ' working');
    if (c.need) parts.push(c.need + ' needs you');
    if (c.done && !c.need) parts.push(c.done + ' done');
    sumEl.textContent = parts.join(' · ');
    sumEl.style.color = sumS.style.color = c.need ? 'var(--need)' : '';
    sumS.textContent = c.need ? c.need + ' needs you' : busy ? busy + ' working' : c.done + ' done';
    dotsEl.innerHTML = '';
    ORDER.forEach(function (id) {
      var i = d.createElement('i'); i.style.setProperty('--c', 'var(--' + D[id].st + ')'); dotsEl.appendChild(i);
    });
  }
  function setSt(id, st, task) { D[id].st = st; if (task) D[id].t = task; render(); }
  function select(id) { sel = id; render(); }

  /* ---------- open, close, views ---------- */
  var pinned = false, hoverT = null, closeT = null, replayT = null;
  function isOpen() { return isl.classList.contains('open'); }
  function setOpen(open) {
    if (open === isOpen()) return;
    isl.classList.toggle('open', open);
    pill.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) isl.classList.add('seen');   /* the visitor found it: stop pointing at it */
    if (!open) pinned = false;
  }
  function view(v) {
    isl.setAttribute('data-view', v);
    var t = v === 'shelf' ? 'shelf' : 'home';
    tabs.forEach(function (b) {
      var on = b.getAttribute('data-tab') === t;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    panes.forEach(function (p) { p.hidden = p.getAttribute('data-pane') !== v; });
  }
  function answer(a) {
    clearTimeout(replayT);
    if (a === 'allow') setSt('korus', 'working', 'Running npm test');
    else setSt('korus', 'thinking', 'Thinking about another way…');
    replayT = setTimeout(function () { setSt('korus', 'need', 'Wants to run npm test'); }, 9000);
  }

  /* hover opens (with a short intent delay), leaving closes (with a grace period); a click pins it open */
  isl.addEventListener('pointerenter', function (e) {
    if (e.pointerType !== 'mouse') return;
    clearTimeout(closeT); clearTimeout(hoverT);
    hoverT = setTimeout(function () { setOpen(true); }, 70);
  });
  isl.addEventListener('pointerleave', function (e) {
    if (e.pointerType !== 'mouse') return;
    clearTimeout(hoverT); clearTimeout(closeT);
    if (pinned) return;
    closeT = setTimeout(function () {
      if (!isl.matches(':hover') && !isl.querySelector(':focus-visible')) setOpen(false);
    }, 420);
  });
  d.addEventListener('pointerdown', function (e) {
    if (!isOpen() || isl.contains(e.target)) return;
    setOpen(false);
  }, { passive: true });
  isl.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen()) { setOpen(false); pill.focus({ preventScroll: true }); }
  });

  isl.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button') : null;
    if (!b) return;
    if (b === pill) {
      if (e.pointerType === 'mouse') { pinned = true; setOpen(true); } else setOpen(!isOpen());
    } else if (b.hasAttribute('data-isl-close')) {
      setOpen(false); pill.focus({ preventScroll: true });
    } else if (b.hasAttribute('data-answer')) {
      answer(b.getAttribute('data-answer'));
    } else if (b.hasAttribute('data-id')) {
      select(b.getAttribute('data-id'));
    } else if (b.hasAttribute('data-go')) {
      view(b.getAttribute('data-go'));
    } else if (b.getAttribute('role') === 'tab') {
      view(b.getAttribute('data-tab'));
    }
  });
  tabs.forEach(function (t, i) {
    t.addEventListener('keydown', function (e) {
      var n = -1;
      if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
      if (n < 0) return;
      e.preventDefault(); view(tabs[n].getAttribute('data-tab')); tabs[n].focus();
    });
  });

  /* touch: swipe sideways on the panel to change tab (the Shelf strip keeps its own sideways scroll) */
  var sx = 0, sy = 0, swipeOk = false;
  isl.addEventListener('touchstart', function (e) {
    var t = e.touches[0]; sx = t.clientX; sy = t.clientY;
    swipeOk = e.touches.length === 1 && !e.target.closest('.shelfrow, .isl-pill, .code');
  }, { passive: true });
  isl.addEventListener('touchend', function (e) {
    if (!swipeOk || !isOpen()) return;
    var t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) < 56 || Math.abs(dy) > 40) return;
    view(dx < 0 ? 'shelf' : 'home');
  }, { passive: true });

  /* a gentle live feel while it is open: the machine's numbers and the subagents' progress */
  var meters = qa('[data-meter][data-live]'), bars = qa('.sbar b'), val = {};
  meters.forEach(function (m) { val[m.getAttribute('data-meter')] = parseFloat(m.getAttribute('data-v')); });
  if (!mqReduce.matches) {
    setInterval(function () {
      if (d.hidden || !isOpen()) return;
      meters.forEach(function (m) {
        var k = m.getAttribute('data-meter');
        val[k] = Math.max(6, Math.min(94, val[k] + (Math.random() * 8 - 4)));
        var v = Math.round(val[k]);
        m.style.setProperty('--p', (v / 100).toFixed(2));
        qa('[data-out="' + k + '"]').forEach(function (o) { o.textContent = v + '%'; });
      });
      bars.forEach(function (s) {
        var p = parseFloat(s.style.getPropertyValue('--p') || '.5') + Math.random() * 0.12;
        s.style.setProperty('--p', (p > 0.95 ? 0.15 : p).toFixed(2));
      });
    }, 2200);
  }
  render();
})();
