/* Nook site: full-screen image viewer with zoom for the guide screenshots.
   Vanilla JS, no dependency. Without JS the images behave as before (progressive enhancement). */
(function () {
  'use strict';
  var d = document, root = d.documentElement;
  var SEL = '.shot-img';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var ICONS = {
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    prev: '<path d="M15 5l-7 7 7 7"/>',
    next: '<path d="M9 5l7 7-7 7"/>'
  };
  function svg(name) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + ICONS[name] + '</svg>';
  }

  var imgs = [];
  function collect() {
    imgs = Array.prototype.slice.call(d.querySelectorAll(SEL));
    imgs.forEach(function (im) {
      if (im.getAttribute('data-lb')) return;
      im.setAttribute('data-lb', '1');
      im.classList.add('lb-ready');
      im.setAttribute('tabindex', '0');
      im.setAttribute('role', 'button');
      im.setAttribute('aria-label', 'Enlarge image: ' + (im.getAttribute('alt') || 'screenshot'));
    });
  }
  function visibleImgs() {
    return imgs.filter(function (im) { return im.offsetParent !== null || im.getClientRects().length > 0; });
  }

  /* ---- state of the open viewer (null when closed) ---- */
  var S = null;
  var opening = false, closedAt = 0;

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  function open(im) {
    if (S || opening || Date.now() - closedAt < 400) return;
    opening = true;
    var list = visibleImgs();
    var idx = Math.max(0, list.indexOf(im));
    load(im, function (pic) {
      opening = false;
      if (S) return;
      build(list, idx, pic);
    });
  }

  /* Decode the displayed source first, so the overlay never shows a half-loaded picture. */
  function load(im, cb) {
    var src = im.currentSrc || im.src;
    var pic = new Image();
    pic.decoding = 'async';
    var done = false;
    function fin() { if (done) return; done = true; cb(pic); }
    pic.onload = function () { (pic.decode ? pic.decode().catch(function () {}) : Promise.resolve()).then(fin); };
    pic.onerror = fin;
    pic.src = src;
    if (pic.complete) pic.onload();
  }

  function build(list, idx, firstPic) {
    var el = d.createElement('div');
    el.className = 'lb';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('data-lenis-prevent', '');
    el.innerHTML =
      '<div class="lb-bar">' +
        '<span class="lb-count" aria-live="polite"></span>' +
        '<button type="button" class="lb-btn lb-out" aria-label="Zoom out">' + svg('minus') + '</button>' +
        '<button type="button" class="lb-btn lb-in-btn" aria-label="Zoom in">' + svg('plus') + '</button>' +
        '<button type="button" class="lb-btn lb-fit" aria-label="Fit to screen">' + svg('fit') + '</button>' +
        '<button type="button" class="lb-btn lb-x" aria-label="Close">' + svg('close') + '</button>' +
      '</div>' +
      '<div class="lb-stage">' +
        '<img class="lb-img" alt="" draggable="false">' +
        '<button type="button" class="lb-btn lb-nav lb-prev" aria-label="Previous image">' + svg('prev') + '</button>' +
        '<button type="button" class="lb-btn lb-nav lb-next" aria-label="Next image">' + svg('next') + '</button>' +
      '</div>' +
      '<div class="lb-cap"></div>';

    var scrollY = window.pageYOffset || root.scrollTop || 0;
    var sbw = Math.max(0, window.innerWidth - root.clientWidth);
    var prevPad = d.body.style.paddingRight, prevTop = d.body.style.top;
    d.body.style.top = (-scrollY) + 'px';
    if (sbw) d.body.style.paddingRight = sbw + 'px';
    d.body.classList.add('lb-lock');
    d.body.appendChild(el);

    S = {
      el: el, list: list, idx: idx, opener: list[idx],
      stage: el.querySelector('.lb-stage'), img: el.querySelector('.lb-img'),
      cap: el.querySelector('.lb-cap'), count: el.querySelector('.lb-count'),
      prev: el.querySelector('.lb-prev'), next: el.querySelector('.lb-next'),
      x: el.querySelector('.lb-x'),
      nw: 1, nh: 1, fw: 1, fh: 1, sw: 1, sh: 1, z: 1, zmax: 3, tx: 0, ty: 0,
      ptrs: {}, tap: null, lastTap: null, gesture: null,
      scrollY: scrollY, prevPad: prevPad, prevTop: prevTop, token: 0
    };
    show(idx, firstPic);
    wire();
    requestAnimationFrame(function () { if (S) S.el.classList.add('lb-in'); });
    S.x.focus({ preventScroll: true });
  }

  function show(idx, pic) {
    var im = S.list[idx];
    S.idx = idx;
    var token = ++S.token;
    function apply(p) {
      if (!S || token !== S.token) return;
      S.img.src = p.src;
      S.nw = p.naturalWidth || im.naturalWidth || im.width || 1;
      S.nh = p.naturalHeight || im.naturalHeight || im.height || 1;
      S.img.alt = im.getAttribute('alt') || '';
      S.z = 1; S.tx = 0; S.ty = 0;
      layout(false);
    }
    var alt = im.getAttribute('alt') || 'Screenshot';
    S.el.setAttribute('aria-label', alt);
    var fig = im.closest('figure');
    var fc = fig && fig.querySelector('figcaption');
    S.cap.textContent = '';
    if (fc && fc.textContent.trim()) {
      var sp = d.createElement('span');
      sp.textContent = fc.textContent.trim();
      S.cap.appendChild(sp);
    }
    var many = S.list.length > 1;
    S.prev.hidden = S.next.hidden = !many;
    S.count.textContent = many ? (idx + 1) + ' / ' + S.list.length : '';
    if (pic) apply(pic); else load(im, apply);
  }

  /* Compute the fit size for the current stage and apply the transform. */
  function layout(animate) {
    if (!S) return;
    var r = S.stage.getBoundingClientRect();
    S.sw = r.width; S.sh = r.height;
    var pad = 16;
    var fit = Math.min((S.sw - pad) / S.nw, (S.sh - pad) / S.nh, 1);
    if (!(fit > 0)) fit = 1;
    S.fw = S.nw * fit; S.fh = S.nh * fit;
    S.img.style.width = S.fw + 'px';
    S.img.style.height = S.fh + 'px';
    S.zmax = Math.max(3, Math.min(6, 4 * S.nw / S.fw));
    S.z = clamp(S.z, 1, S.zmax);
    render(animate);
  }

  function clampPan() {
    var mx = Math.max(0, (S.fw * S.z - S.sw) / 2 + 8);
    var my = Math.max(0, (S.fh * S.z - S.sh) / 2 + 8);
    if (S.fw * S.z <= S.sw) mx = 0;
    if (S.fh * S.z <= S.sh) my = 0;
    S.tx = clamp(S.tx, -mx, mx);
    S.ty = clamp(S.ty, -my, my);
  }

  function render(animate) {
    clampPan();
    var im = S.img.style;
    im.transition = animate && !reduce ? 'transform .18s ease' : 'none';
    im.transform = 'translate(' + (S.tx - S.fw * S.z / 2) + 'px,' + (S.ty - S.fh * S.z / 2) + 'px) scale(' + S.z + ')';
    S.stage.classList.toggle('lb-zoomed', S.z > 1.001);
    S.el.querySelector('.lb-out').disabled = S.z <= 1.001;
    S.el.querySelector('.lb-in-btn').disabled = S.z >= S.zmax - 0.001;
  }

  /* Zoom to newZ keeping the stage point (px, py), given in client coordinates, fixed. */
  function zoomAt(newZ, px, py, animate) {
    var r = S.stage.getBoundingClientRect();
    var cx = px - r.left - r.width / 2, cy = py - r.top - r.height / 2;
    newZ = clamp(newZ, 1, S.zmax);
    var k = newZ / S.z;
    S.tx = cx - (cx - S.tx) * k;
    S.ty = cy - (cy - S.ty) * k;
    S.z = newZ;
    if (newZ <= 1.0001) { S.tx = 0; S.ty = 0; }
    render(animate);
  }
  function stageCentre() {
    var r = S.stage.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  function zoomStep(f) { var c = stageCentre(); zoomAt(S.z * f, c.x, c.y, true); }
  function reset() { S.z = 1; S.tx = 0; S.ty = 0; render(true); }
  function go(delta) {
    if (S.list.length < 2) return;
    show((S.idx + delta + S.list.length) % S.list.length);
  }

  /* ---- events ---- */
  function wire() {
    var st = S.stage;
    S.el.querySelector('.lb-out').addEventListener('click', function () { zoomStep(1 / 1.5); });
    S.el.querySelector('.lb-in-btn').addEventListener('click', function () { zoomStep(1.5); });
    S.el.querySelector('.lb-fit').addEventListener('click', reset);
    S.x.addEventListener('click', close);
    S.prev.addEventListener('click', function () { go(-1); });
    S.next.addEventListener('click', function () { go(1); });
    S.el.addEventListener('click', function (e) { if (S && e.target === S.el) close(); });

    st.addEventListener('wheel', function (e) {
      e.preventDefault();
      var dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1);
      var f = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0018));
      zoomAt(S.z * f, e.clientX, e.clientY, false);
    }, { passive: false });

    st.addEventListener('click', function () { if (S && S.closeOnClick) close(); });
    st.addEventListener('pointerdown', onDown);
    st.addEventListener('pointermove', onMove);
    st.addEventListener('pointerup', onUp);
    st.addEventListener('pointercancel', onCancel);
    st.addEventListener('lostpointercapture', function (e) { delete S.ptrs[e.pointerId]; });

    d.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
    window.addEventListener('popstate', close);
  }
  function onResize() { if (S) { layout(false); setTimeout(function () { if (S) layout(false); }, 250); } }

  function count() { return Object.keys(S.ptrs).length; }
  function pair() {
    var k = Object.keys(S.ptrs), a = S.ptrs[k[0]], b = S.ptrs[k[1]];
    return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function onDown(e) {
    S.closeOnClick = false;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    S.ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
    try { S.stage.setPointerCapture(e.pointerId); } catch (x) {}
    if (count() === 1) {
      S.tap = { x: e.clientX, y: e.clientY, t: Date.now(), moved: false, multi: false };
      S.gesture = { type: 'pan', x: e.clientX, y: e.clientY };
    } else if (count() === 2) {
      if (S.tap) S.tap.multi = true;
      var p = pair();
      S.gesture = { type: 'pinch', d: p.d, x: p.x, y: p.y };
    }
  }
  function onMove(e) {
    var p = S.ptrs[e.pointerId];
    if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
    var g = S.gesture;
    if (!g) return;
    if (S.tap && Math.hypot(e.clientX - S.tap.x, e.clientY - S.tap.y) > 6) S.tap.moved = true;
    if (g.type === 'pinch' && count() >= 2) {
      var q = pair();
      var oz = S.z;
      zoomAt(S.z * (q.d / g.d), g.x, g.y, false);
      /* anchor on the previous midpoint, then follow the midpoint as it moves */
      if (S.z > 1.001 || oz > 1.001) { S.tx += q.x - g.x; S.ty += q.y - g.y; render(false); }
      g.d = q.d; g.x = q.x; g.y = q.y;
    } else if (g.type === 'pan' && count() === 1 && S.z > 1.001 && S.tap && S.tap.moved) {
      S.tx += e.clientX - g.x; S.ty += e.clientY - g.y;
      g.x = e.clientX; g.y = e.clientY;
      S.stage.classList.add('lb-drag');
      render(false);
    } else if (g.type === 'pan') {
      g.x = e.clientX; g.y = e.clientY;
    }
  }
  function onUp(e) {
    var had = S.ptrs[e.pointerId];
    delete S.ptrs[e.pointerId];
    try { S.stage.releasePointerCapture(e.pointerId); } catch (x) {}
    S.stage.classList.remove('lb-drag');
    var tap = S.tap;
    if (count() === 1) {
      /* pinch ended with one finger left: carry on as a pan from where it is */
      var k = Object.keys(S.ptrs)[0];
      S.gesture = { type: 'pan', x: S.ptrs[k].x, y: S.ptrs[k].y };
      if (S.tap) S.tap.moved = true;
      return;
    }
    if (count() > 0) return;
    S.gesture = null;
    S.tap = null;
    if (!had || !tap || tap.moved || tap.multi || Date.now() - tap.t > 500) { S.lastTap = null; return; }
    var r = S.img.getBoundingClientRect();
    var onImg = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!onImg) { S.closeOnClick = true; return; } /* close on the click that follows, or it would land on the page below */
    var now = Date.now(), lt = S.lastTap;
    if (lt && now - lt.t < 350 && Math.hypot(lt.x - e.clientX, lt.y - e.clientY) < 30) {
      S.lastTap = null;
      if (S.z > 1.001) { S.z = S.z; zoomAt(1, e.clientX, e.clientY, true); }
      else zoomAt(Math.min(2.5, S.zmax), e.clientX, e.clientY, true);
    } else {
      S.lastTap = { t: now, x: e.clientX, y: e.clientY };
    }
  }
  function onCancel(e) {
    delete S.ptrs[e.pointerId];
    S.stage.classList.remove('lb-drag');
    if (count() === 0) { S.gesture = null; S.tap = null; }
  }

  function onKey(e) {
    if (!S) return;
    var k = e.key;
    if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (k === 'Tab') {
      var f = Array.prototype.slice.call(S.el.querySelectorAll('button')).filter(function (b) { return !b.disabled && !b.hidden && b.getClientRects().length; });
      if (!f.length) { e.preventDefault(); return; }
      var i = f.indexOf(d.activeElement);
      e.preventDefault();
      if (e.shiftKey) f[i <= 0 ? f.length - 1 : i - 1].focus();
      else f[i < 0 || i === f.length - 1 ? 0 : i + 1].focus();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var onBtn = d.activeElement && d.activeElement.tagName === 'BUTTON' && (k === 'Enter' || k === ' ');
    if (onBtn) return; /* let the focused button handle it */
    if (k === '+' || k === '=') { e.preventDefault(); zoomStep(1.5); }
    else if (k === '-' || k === '_') { e.preventDefault(); zoomStep(1 / 1.5); }
    else if (k === '0') { e.preventDefault(); reset(); }
    else if (k.indexOf('Arrow') === 0) {
      e.preventDefault();
      if (S.z > 1.001) {
        var s = 80;
        if (k === 'ArrowLeft') S.tx += s; else if (k === 'ArrowRight') S.tx -= s;
        else if (k === 'ArrowUp') S.ty += s; else S.ty -= s;
        render(true);
      } else if (k === 'ArrowLeft' || k === 'ArrowUp') go(-1);
      else go(1);
    }
  }

  function close() {
    if (!S) return;
    var s = S;
    S = null;
    closedAt = Date.now();
    d.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onResize);
    window.removeEventListener('popstate', close);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', onResize);
    if (s.el.parentNode) s.el.parentNode.removeChild(s.el);
    d.body.classList.remove('lb-lock');
    d.body.style.top = s.prevTop;
    d.body.style.paddingRight = s.prevPad;
    window.scrollTo({ top: s.scrollY, left: 0, behavior: 'instant' });
    var back = s.list[s.idx] || s.opener;
    if (back && back.focus) { try { back.focus({ preventScroll: true }); } catch (e) { back.focus(); } }
    if (back && back.scrollIntoView && s.idx !== s.list.indexOf(s.opener)) back.scrollIntoView({ block: 'center' });
  }

  /* ---- page hooks ---- */
  function init() {
    collect();
    d.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var im = t.closest(SEL);
      if (im && im.getAttribute('data-lb')) { e.preventDefault(); open(im); }
    });
    d.addEventListener('keydown', function (e) {
      if (S || (e.key !== 'Enter' && e.key !== ' ')) return;
      var t = e.target;
      if (t && t.matches && t.matches(SEL) && t.getAttribute('data-lb')) {
        e.preventDefault();
        if (e.key === 'Enter') open(t); /* Space opens on keyup, so its keyup cannot hit the Close button */
      }
    });
    d.addEventListener('keyup', function (e) {
      if (S || e.key !== ' ') return;
      var t = e.target;
      if (t && t.matches && t.matches(SEL) && t.getAttribute('data-lb')) { e.preventDefault(); open(t); }
    });
  }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', init); else init();
})();