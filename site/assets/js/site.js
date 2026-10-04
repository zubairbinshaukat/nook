/* Nook site: shared behaviour (landing page + guide pages).
   Everything is guarded: pages work without Lenis, without JS, and with reduced motion. */
(function () {
  'use strict';
  var d = document, root = d.documentElement;
  var $ = function (s, c) { return (c || d).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || d).querySelectorAll(s)); };
  var mqReduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  var reduce = mqReduce.matches;
  var lenis = null;

  /* ---------- theme ---------- */
  var themeBtn = $('[data-theme-toggle]');
  function currentTheme() {
    var t = root.getAttribute('data-theme');
    if (t) return t;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  function syncThemeBtn() {
    if (!themeBtn) return;
    var light = currentTheme() === 'light';
    themeBtn.setAttribute('aria-pressed', light ? 'true' : 'false');
    themeBtn.setAttribute('aria-label', light ? 'Switch to dark theme' : 'Switch to light theme');
    var m = $('meta[name="theme-color"][data-dyn]');
    if (m) m.setAttribute('content', light ? '#F6F5F8' : '#0B0B0F');
  }
  if (themeBtn) {
    syncThemeBtn();
    themeBtn.addEventListener('click', function () {
      var next = currentTheme() === 'light' ? 'dark' : 'light';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('nook-theme', next); } catch (e) {}
      syncThemeBtn();
    });
  }

  /* ---------- mobile menu ---------- */
  var menuBtn = $('[data-menu-toggle]'), links = $('[data-nav-links]');
  function setMenu(open) {
    if (!menuBtn || !links) return;
    links.classList.toggle('open', open);
    menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  if (menuBtn && links) {
    menuBtn.addEventListener('click', function () { setMenu(!links.classList.contains('open')); });
    links.addEventListener('click', function (e) { if (e.target.closest('a')) setMenu(false); });
    d.addEventListener('keydown', function (e) { if (e.key === 'Escape') setMenu(false); });
  }

  /* ---------- scroll driven bits ---------- */
  var nav = $('.nav'), bar = $('[data-progress]'), toTop = $('[data-to-top]'), parallax = $('[data-parallax]');
  var ticking = false, lastY = -1;
  function onScroll(y) {
    if (y === lastY) return;
    lastY = y;
    if (nav) nav.classList.toggle('scrolled', y > 8);
    if (bar) {
      var max = root.scrollHeight - window.innerHeight;
      bar.style.transform = 'scaleX(' + (max > 0 ? Math.min(1, y / max) : 0).toFixed(4) + ')';
    }
    if (toTop) toTop.classList.toggle('show', y > 900);
    if (parallax && !reduce && y < 1400) {
      parallax.style.transform = 'translate3d(0,' + Math.min(y * 0.035, 36).toFixed(1) + 'px,0)';
    }
  }
  function nativeScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () { ticking = false; onScroll(window.scrollY || root.scrollTop); });
  }

  /* ---------- Lenis (optional enhancement) ---------- */
  function startLenis() {
    if (reduce || typeof window.Lenis !== 'function') return false;
    try {
      lenis = new window.Lenis({ lerp: 0.1, smoothWheel: true });
    } catch (e) { lenis = null; return false; }
    root.classList.add('lenis', 'lenis-smooth');
    lenis.on('scroll', function (e) { onScroll(e && typeof e.scroll === 'number' ? e.scroll : window.scrollY); });
    var raf = function (t) { lenis.raf(t); requestAnimationFrame(raf); };
    requestAnimationFrame(raf);
    return true;
  }
  function goTo(target, hash) {
    var off = -((nav ? nav.offsetHeight : 64) + 12);
    if (lenis) lenis.scrollTo(target, { offset: off, duration: 1.1 });
    else target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    if (hash) { try { history.pushState(null, '', hash); } catch (e) {} }
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    try { target.focus({ preventScroll: true }); } catch (e) {}
  }
  d.addEventListener('click', function (e) {
    var a = e.target.closest ? e.target.closest('a[href^="#"]') : null;
    if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey) return;
    var id = a.getAttribute('href');
    if (id === '#' || id.length < 2) return;
    var t = null;
    try { t = d.getElementById(decodeURIComponent(id.slice(1))); } catch (err) {}
    if (!t) return;
    e.preventDefault();
    goTo(t, id);
  });
  if (toTop) toTop.addEventListener('click', function (e) {
    e.preventDefault();
    if (lenis) lenis.scrollTo(0, { duration: 1.2 }); else window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
  });
  $$('[data-top]').forEach(function (b) {
    b.addEventListener('click', function (e) {
      e.preventDefault();
      if (lenis) lenis.scrollTo(0, { duration: 1.4 }); else window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
    });
  });

  if (!startLenis()) window.addEventListener('scroll', nativeScroll, { passive: true });
  else window.addEventListener('scroll', nativeScroll, { passive: true });
  onScroll(window.scrollY || 0);
  window.addEventListener('resize', function () { lastY = -1; nativeScroll(); }, { passive: true });

  /* ---------- reveal on scroll ---------- */
  var revealEls = $$('.reveal');
  if (revealEls.length && 'IntersectionObserver' in window && !reduce) {
    $$('[data-stagger]').forEach(function (g) {
      $$('.reveal', g).forEach(function (el, i) { el.style.transitionDelay = Math.min(i, 8) * 70 + 'ms'; });
    });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    root.classList.add('reveal-ready');
    revealEls.forEach(function (el) { io.observe(el); });
  }

  /* ---------- copy buttons ---------- */
  $$('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var src = d.getElementById(btn.getAttribute('data-copy'));
      if (!src) return;
      var txt = src.textContent.trim(), old = btn.textContent;
      function done(ok) { btn.textContent = ok ? 'Copied' : 'Press Ctrl+C'; setTimeout(function () { btn.textContent = old; }, 1800); }
      try {
        navigator.clipboard.writeText(txt).then(function () { done(true); }, function () { done(false); });
      } catch (e) {
        try { var r = d.createRange(); r.selectNodeContents(src); var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); done(false); } catch (e2) {}
      }
    });
  });

  /* ---------- island demo ---------- */
  var isl = $('[data-island]');
  if (isl) {
    var pill = $('.isl-pill', isl), closeBtn = $('[data-isl-close]', isl), sum = $('[data-isl-sum]', isl), dots = $('[data-isl-dots]', isl);
    var tabs = $$('[role="tab"]', isl), panes = $$('[role="tabpanel"]', isl);
    var pinned = false, hover = false, closeT = null;
    var LABEL = { working: 'working', thinking: 'thinking', need: 'needs you', done: 'done', error: 'error' };

    var setOpen = function (open) {
      isl.classList.toggle('open', open);
      pill.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (!open) pinned = false;
    };
    var selectTab = function (name, focus) {
      isl.setAttribute('data-tab', name);
      tabs.forEach(function (t) {
        var on = t.getAttribute('data-tab') === name;
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.tabIndex = on ? 0 : -1;
        if (on && focus) t.focus();
      });
      panes.forEach(function (p) { p.hidden = p.getAttribute('data-pane') !== name; });
    };
    var scheduleClose = function () {
      clearTimeout(closeT);
      closeT = setTimeout(function () {
        if (!hover && !pinned && !isl.contains(d.activeElement)) setOpen(false);
      }, 420);
    };
    selectTab('sessions');

    isl.addEventListener('pointerenter', function (e) {
      if (e.pointerType !== 'mouse') return;
      hover = true; clearTimeout(closeT); setOpen(true);
    });
    isl.addEventListener('pointerleave', function (e) {
      if (e.pointerType !== 'mouse') return;
      hover = false; scheduleClose();
    });
    pill.addEventListener('click', function () {
      var open = !isl.classList.contains('open');
      pinned = open; setOpen(open);
    });
    if (closeBtn) closeBtn.addEventListener('click', function () { setOpen(false); pill.focus(); });
    isl.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isl.classList.contains('open')) { setOpen(false); pill.focus(); }
    });
    isl.addEventListener('focusout', function (e) {
      if (!e.relatedTarget || !isl.contains(e.relatedTarget)) { pinned = false; scheduleClose(); }
    });
    d.addEventListener('pointerdown', function (e) {
      if (isl.classList.contains('open') && !isl.contains(e.target)) { pinned = false; hover = false; setOpen(false); }
    }, { passive: true });

    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { selectTab(t.getAttribute('data-tab')); });
      t.addEventListener('keydown', function (e) {
        var n = -1;
        if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
        else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') n = 0;
        else if (e.key === 'End') n = tabs.length - 1;
        if (n < 0) return;
        e.preventDefault(); selectTab(tabs[n].getAttribute('data-tab'), true);
      });
    });

    /* session rows + summary */
    var rows = $$('.srow[data-row]', isl);
    function refresh() {
      var c = { working: 0, thinking: 0, need: 0, done: 0 };
      rows.forEach(function (r) { var s = r.getAttribute('data-st'); if (c[s] !== undefined) c[s]++; });
      var busy = c.working + c.thinking, parts = [];
      if (busy) parts.push(busy + ' working');
      if (c.need) parts.push(c.need + ' needs you');
      if (!parts.length) parts.push(c.done + ' done');
      if (sum) {
        sum.textContent = parts.join(' · ');
        sum.style.color = c.need ? 'var(--need)' : '';
      }
      if (dots) {
        dots.innerHTML = '';
        rows.forEach(function (r) {
          var i = d.createElement('i'); i.style.setProperty('--c', 'var(--' + r.getAttribute('data-st') + ')'); dots.appendChild(i);
        });
      }
    }
    function setRow(r, st, task) {
      r.setAttribute('data-st', st);
      var ch = $('.chip', r); if (ch) { ch.textContent = ({ working: 'Working', thinking: 'Thinking', need: 'Needs you', done: 'Done' })[st] || st; }
      var tk = $('.s-task', r); if (tk && task) tk.textContent = task;
      var x = $('.srow-x', r); if (x && r.hasAttribute('data-ask')) x.hidden = st !== 'need';
      refresh();
    }
    var askRow = $('.srow[data-ask]', isl), replayT = null;
    $$('[data-answer]', isl).forEach(function (b) {
      b.addEventListener('click', function () {
        if (!askRow) return;
        var allow = b.getAttribute('data-answer') === 'allow';
        setRow(askRow, allow ? 'working' : 'thinking', allow ? 'Running npm test' : 'Thinking about another way…');
        clearTimeout(replayT);
        replayT = setTimeout(function () {
          setRow(askRow, 'need', 'Wants to run npm test');
        }, 9000);
      });
    });
    refresh();

    /* gentle live feel: sample usage + subagent progress (skipped under reduced motion) */
    if (!reduce) {
      var meters = $$('[data-meter]', isl), subs = $$('.sbar b', isl), sysEl = $('[data-isl-sys]', isl);
      var val = {};
      meters.forEach(function (m) { val[m.getAttribute('data-meter')] = parseFloat(m.getAttribute('data-v')); });
      setInterval(function () {
        if (d.hidden || !isl.classList.contains('open')) return;
        meters.forEach(function (m) {
          var k = m.getAttribute('data-meter');
          if (m.getAttribute('data-live') !== '1') return;
          val[k] = Math.max(6, Math.min(94, val[k] + (Math.random() * 8 - 4)));
          var v = Math.round(val[k]);
          m.style.setProperty('--p', (v / 100).toFixed(2));
          var o = m.querySelector('[data-out="' + k + '"]'); if (o) o.textContent = v + '%';
        });
        subs.forEach(function (s) {
          var p = parseFloat(s.style.getPropertyValue('--p') || '.5') + Math.random() * 0.12;
          s.style.setProperty('--p', (p > 0.95 ? 0.15 : p).toFixed(2));
        });
        if (sysEl) sysEl.textContent = 'CPU ' + Math.round(val.cpu) + '% · RAM ' + Math.round(val.ram) + '%';
      }, 2200);
    }
  }
})();


/* ---------- deep-linked FAQ answers: open the <details> a #hash points at ---------- */
(function () {
  function openHash() {
    var id = location.hash.slice(1);
    if (!id) return;
    var el = document.getElementById(id);
    if (el && el.tagName === 'DETAILS') el.open = true;
  }
  openHash();
  window.addEventListener('hashchange', openHash);
})();
