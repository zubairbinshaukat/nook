/* Nook site: the island in the header (landing page only, deferred).
   One file: the island itself, a scripted tour, and the sound.
   - The island works without the tour; the tour drives it with the same functions a visitor uses.
   - Sound is made with the Web Audio API from the notes of the app's own sounds
     (windows/scripts/make-sounds.mjs). No audio files, off until the visitor turns it on. */
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
  var cur = d.querySelector('[data-cursor]');
  var btnSnd = d.querySelector('[data-snd]'), btnRe = d.querySelector('[data-replay]'), sndText = d.querySelector('[data-snd-t]');
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

  /* ---------- sound ---------- */
  var ac = null, soundOn = false;
  var N = { C5: 523.25, E5: 659.25, G5: 783.99, B5: 987.77, C6: 1046.5 };
  var SND = {
    finish: [[0, .5, N.C5], [.15, .5, N.E5], [.3, .5, N.G5], [.45, .7, N.C6, { gain: .9 }]],
    approval: [[0, .4, N.E5], [.3, .57, N.B5, { gain: .9 }]],
    approve: [[0, .22, N.C5], [.18, .4, N.G5]],
    open: [[0, .45, 400, { to: 800, gain: .8 }]],
    pop: [[0, .3, 900, { to: 300 }]]
  };
  function audio() {
    if (!ac) {
      var C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      try { ac = new C(); } catch (e) { return null; }
    }
    if (ac.state === 'suspended' && ac.resume) ac.resume();
    return ac;
  }
  function play(name) {
    if (!soundOn) return;
    var c = audio(); if (!c) return;
    var t0 = c.currentTime + .02;
    (SND[name] || []).forEach(function (n) {
      var o = n[3] || {}, osc = c.createOscillator(), g = c.createGain(), at = t0 + n[0], end = at + n[1];
      osc.type = 'sine';
      osc.frequency.setValueAtTime(n[2], at);
      if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, end);
      g.gain.setValueAtTime(.0001, at);
      g.gain.linearRampToValueAtTime(.16 * (o.gain || 1), at + .006);
      g.gain.exponentialRampToValueAtTime(.0001, end);
      osc.connect(g); g.connect(c.destination);
      osc.start(at); osc.stop(end + .03);
    });
  }

  /* ---------- open, close, views ---------- */
  var running = false, pinned = false, hoverT = null, closeT = null, replayT = null;
  function isOpen() { return isl.classList.contains('open'); }
  function setOpen(open, quiet) {
    if (open === isOpen()) return;
    isl.classList.toggle('open', open);
    pill.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open && !quiet) play('open');
    if (open && !running) isl.classList.add('seen');   /* the visitor found it: stop pointing at it */
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
    if (a === 'allow') { setSt('korus', 'working', 'Running npm test'); play('approve'); }
    else { setSt('korus', 'thinking', 'Thinking about another way…'); play('pop'); }
    replayT = setTimeout(function () { setSt('korus', 'need', 'Wants to run npm test'); }, 9000);
  }

  /* hover opens (with a short intent delay), leaving closes (with a grace period); a click pins it open */
  isl.addEventListener('pointerenter', function (e) {
    if (e.pointerType !== 'mouse') return;
    if (running) stop();                      /* a visitor who goes for the island ends the tour */
    clearTimeout(closeT); clearTimeout(hoverT);
    hoverT = setTimeout(function () { setOpen(true); }, 70);
  });
  isl.addEventListener('pointerleave', function (e) {
    if (e.pointerType !== 'mouse' || running) return;
    clearTimeout(hoverT); clearTimeout(closeT);
    if (pinned) return;
    closeT = setTimeout(function () {
      if (!isl.matches(':hover') && !isl.querySelector(':focus-visible')) setOpen(false);
    }, 420);
  });
  d.addEventListener('pointerdown', function (e) {
    if (running || !isOpen() || isl.contains(e.target)) return;
    setOpen(false);
  }, { passive: true });
  isl.addEventListener('keydown', function (e) {
    if (running) stop();
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

  /* ---------- the tour ---------- */
  var timers = [];
  function at(ms, fn) { timers.push(setTimeout(function () { if (running) fn(); }, ms)); }
  function glow(color) {
    isl.style.setProperty('--g', color);
    isl.classList.remove('pop'); void isl.offsetWidth; isl.classList.add('pop');
  }
  function moveTo(el) {
    var r = el.getBoundingClientRect();
    cur.style.transform = 'translate3d(' + (r.left + r.width * .55).toFixed(1) + 'px,' + (r.top + r.height * .55).toFixed(1) + 'px,0)';
  }
  function tap() { cur.classList.remove('tap'); void cur.offsetWidth; cur.classList.add('tap'); }
  function reset() {
    clearTimeout(replayT);
    setOpen(false, true); view('home'); sel = 'korus';
    D.korus.st = 'working'; D.korus.t = 'Running the tests';
    D.portfolio.st = 'thinking'; D.portfolio.t = 'Thinking…';
    D.docs.st = 'working'; D.docs.t = 'Checking the query plan';
    D.billing.st = 'working'; D.billing.t = 'Refactoring invoices';
    render();
  }
  function stop() {
    running = false;
    timers.forEach(clearTimeout); timers = [];
    isl.classList.remove('touring');
    if (cur) cur.classList.remove('show', 'tap');
  }
  function start() {
    stop(); running = true;
    isl.classList.add('touring');
    reset();
    cur.style.transition = 'none';
    cur.style.transform = 'translate3d(' + (innerWidth * .72).toFixed(0) + 'px,' + (innerHeight * .5).toFixed(0) + 'px,0)';
    void cur.offsetWidth;
    cur.style.transition = '';
    var t = 1000;
    at(t, function () { cur.classList.add('show'); });
    t += 600;
    /* 1. Claude finishes a task: the island glows green and chimes */
    at(t, function () { setSt('billing', 'done', 'Finished the refactor'); glow('var(--done)'); play('finish'); });
    t += 2400;
    /* 2. another session needs a decision */
    at(t, function () { setSt('korus', 'need', 'Wants to run npm test'); glow('var(--need)'); play('approval'); });
    t += 1700;
    /* 3. the cursor opens the island */
    at(t, function () { moveTo(pill); });
    t += 1200;
    at(t, function () { tap(); setOpen(true); });
    t += 2500;
    /* 4. it allows the request */
    at(t, function () { moveTo(q('[data-answer="allow"]')); });
    t += 1200;
    at(t, function () { tap(); answer('allow'); });
    t += 2200;
    /* 5. it looks at another session, then the Shelf, then comes back */
    at(t, function () { moveTo(btn.docs); });
    t += 1100;
    at(t, function () { tap(); select('docs'); });
    t += 2400;
    at(t, function () { moveTo(q('[data-tab="shelf"]')); });
    t += 1100;
    at(t, function () { tap(); view('shelf'); });
    t += 2400;
    at(t, function () { moveTo(q('[data-tab="home"]')); });
    t += 1100;
    at(t, function () { tap(); view('home'); select('korus'); });
    t += 1700;
    /* 6. the island folds back into the notch */
    at(t, function () { cur.classList.remove('show'); setOpen(false, true); });
    t += 900;
    at(t, function () { stop(); });
  }

  /* the visitor takes over the moment they touch the island */
  isl.addEventListener('pointerdown', function () { if (running) stop(); }, { passive: true });
  d.addEventListener('visibilitychange', function () { if (d.hidden && running) stop(); });

  function lowEnd() {
    var c = navigator.connection;
    if (c && (c.saveData || /^(slow-2g|2g)$/.test(c.effectiveType || ''))) return true;
    if (navigator.deviceMemory && navigator.deviceMemory < 2) return true;
    if (navigator.hardwareConcurrency && navigator.hardwareConcurrency < 2) return true;
    return false;
  }

  if (btnSnd) {
    btnSnd.hidden = false;
    btnSnd.addEventListener('click', function () {
      soundOn = !soundOn;
      btnSnd.setAttribute('aria-pressed', soundOn ? 'true' : 'false');
      if (sndText) sndText.textContent = soundOn ? 'Sound on' : 'Sound off';
      if (!soundOn) return;
      audio();                                   /* created inside the click, so the browser allows it */
      if (mqReduce.matches) play('finish'); else start();
    });
  }
  if (btnRe && !mqReduce.matches) {
    btnRe.hidden = false;
    btnRe.addEventListener('click', start);
  }

  /* a slow connection, saved data, little memory or reduced motion: the static island is enough */
  if (mqReduce.matches || lowEnd()) return;
  var go = function () { if (!running && (window.scrollY || 0) < 300 && !d.hidden) start(); };
  /* the notch drops in and the hint shows first; the tour starts a moment later */
  var begin = function () { setTimeout(function () { if (window.requestIdleCallback) requestIdleCallback(go, { timeout: 2000 }); else go(); }, 2800); };
  if (d.readyState === 'complete') begin(); else window.addEventListener('load', begin, { once: true });
})();
