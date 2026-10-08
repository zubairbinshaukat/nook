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

/* ---------- direct download: Download buttons (a[data-download]) start the installer, then explain SmartScreen ----------
   Without JS, without fetch or <dialog>, or with a modifier key, the plain link to the release page works as before.
   The only network request is one GET to GitHub's API for the latest release; nothing is sent about the visitor. */
(function () {
  'use strict';
  var d = document;
  var API = 'https://api.github.com/repos/zubairbinshaukat/nook/releases/latest';
  var PAGE = 'https://github.com/zubairbinshaukat/nook/releases/latest';
  var PREFIX = 'https://github.com/zubairbinshaukat/nook/releases/download/';
  var NAME = /^Nook-Windows-[\d.]+-setup\.exe$/;
  var buttons = Array.prototype.slice.call(d.querySelectorAll('a[data-download]'));
  if (!buttons.length || typeof window.fetch !== 'function' || typeof window.AbortController !== 'function') return;
  if (typeof window.HTMLDialogElement !== 'function' || typeof window.HTMLDialogElement.prototype.showModal !== 'function') return;

  var dlg = null, parts = null, busy = false, opener = null;

  function el(tag, cls, text) {
    var n = d.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

  function build() {
    dlg = el('dialog', 'dl-modal');
    dlg.setAttribute('aria-labelledby', 'dl-title');
    var body = el('div', 'dl-body');
    var title = el('h2'); title.id = 'dl-title';
    var lead = el('p', 'dl-lead');
    var warn = el('p', 'dl-warn');
    warn.appendChild(d.createTextNode('Windows SmartScreen will warn about it, because the installer is not code-signed yet. Choose '));
    warn.appendChild(el('strong', '', 'More info'));
    warn.appendChild(d.createTextNode(', then '));
    warn.appendChild(el('strong', '', 'Run anyway'));
    warn.appendChild(d.createTextNode('.'));
    var fig = el('figure', 'dl-shot');
    var img = el('img', 'dl-img');
    img.src = '/assets/img/shots/install-smartscreen.webp';
    img.width = 960; img.height = 640; img.loading = 'lazy'; img.decoding = 'async';
    img.alt = 'The Windows SmartScreen dialog "Windows protected your PC" with More info expanded and the Run anyway button visible.';
    img.addEventListener('error', function () { fig.hidden = true; });
    fig.appendChild(img);
    var verify = el('p', 'dl-verify');
    var va = el('a', '', 'How to verify the download'); va.href = '/guides/install/#verify';
    verify.appendChild(va);
    var acts = el('div', 'dl-actions');
    var gh = el('a', 'btn btn-ghost', 'Download didn’t start? Get it from GitHub');
    gh.href = PAGE; gh.target = '_blank'; gh.rel = 'noopener noreferrer';
    var close = el('button', 'btn btn-primary', 'Close'); close.type = 'button';
    acts.appendChild(gh); acts.appendChild(close);
    [title, lead, warn, fig, verify, acts].forEach(function (n) { body.appendChild(n); });
    dlg.appendChild(body);
    d.body.appendChild(dlg);
    close.addEventListener('click', function () { dlg.close(); });
    /* a click on the backdrop lands on the dialog itself (the padding lives in .dl-body) */
    dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener('close', function () {
      var o = opener; opener = null;
      if (o && o.focus) { try { o.focus(); } catch (e) {} }
    });
    parts = { title: title, lead: lead };
  }

  function show(res) {
    if (!dlg) build();
    parts.title.textContent = res.url ? 'Your download has started' : 'Get the installer from GitHub';
    var lead = parts.lead;
    while (lead.firstChild) lead.removeChild(lead.firstChild);
    var file = res.name || 'Nook-Windows-<version>-setup.exe';
    if (res.url) {
      lead.appendChild(d.createTextNode('Look for '));
      lead.appendChild(el('code', '', file));
      lead.appendChild(d.createTextNode(' in your Downloads folder.'));
    } else {
      lead.appendChild(d.createTextNode('The release page is open in a new tab. Pick the file that ends in '));
      lead.appendChild(el('code', '', '-setup.exe'));
      lead.appendChild(d.createTextNode(' (' + file + '), not the source code.'));
    }
    if (!dlg.open) dlg.showModal();
  }

  /* resolves to {url, name}, or {} when the request fails, times out, is rate limited or finds no installer */
  function latest() {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, 6000);
    return fetch(API, { headers: { Accept: 'application/vnd.github+json' }, signal: ctl.signal })
      .then(function (r) { if (!r.ok) throw new Error('http'); return r.json(); })
      .then(function (j) {
        var assets = (j && j.assets) || [];
        for (var i = 0; i < assets.length; i++) {
          var a = assets[i];
          if (a && typeof a.name === 'string' && NAME.test(a.name) && typeof a.browser_download_url === 'string' &&
              a.browser_download_url.indexOf(PREFIX) === 0) return { url: a.browser_download_url, name: a.name };
        }
        return {};
      })
      .catch(function () { return {}; })
      .then(function (r) { clearTimeout(timer); return r; });
  }

  function onClick(e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (busy) return;
    busy = true;
    var btn = e.currentTarget;
    latest().then(function (res) {
      if (!dlg || !dlg.open) opener = btn;
      if (res.url) { window.location.href = res.url; }
      else { try { window.open(PAGE, '_blank', 'noopener,noreferrer'); } catch (err) {} }
      show(res);
      busy = false;
    });
  }

  buttons.forEach(function (b) { b.addEventListener('click', onClick); });
})();
