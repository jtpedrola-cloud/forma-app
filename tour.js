/* Forma guided tour. Portable: no dependencies, no storage, no app globals. Plain script, sets window.FormaTour.
 * Node: module.exports = FormaTour (the engine needs a DOM, so require() only exposes the shape).
 *
 *   FormaTour.start(steps, opts) -> Promise<'done'|'skip'|'stop'>   resolves when the tour ends
 *
 *   step = {
 *     target:    CSS selector string, or a function returning an Element (called after tab + before, so it can find
 *                things that only exist on that tab). If nothing is found within ~1.2 s the step still shows,
 *                centred, with the whole screen dimmed and no hole.
 *     title:     short heading.
 *     text:      one sentence.
 *     tab?:      name passed to opts.onTab(name) before the step shows (the app switches tab, then the tour waits
 *                for the target to appear).
 *     before?:   async function run after onTab and before the target is looked up (open a sheet, scroll a list...).
 *     placement?: 'auto' (default) | 'top' | 'bottom'. A preference: if the card does not fit on that side it flips.
 *   }
 *   opts = {
 *     onTab(name):  called when a step with `tab` is about to show (may return a Promise).
 *     onDone():     the last step's Done button.
 *     onSkip():     Skip button or Escape.
 *     theme: { accent }   CSS colour, overrides --acc for the tour only.
 *     startAt?: number    first step index (default 0).
 *   }
 *
 *   FormaTour.stop()      closes silently (no onDone/onSkip), resolves the start() promise with 'stop'.
 *   FormaTour.next() / FormaTour.back() / FormaTour.active (boolean) / FormaTour.version.
 *
 * Behaviour: 70% black full-screen dim with a rounded hole over the target (one SVG mask, animated between steps with
 * a CSS transition on the mask rect) and a soft accent glow. The card is max 320 px, 16 px from every screen edge,
 * flips above or below the target and never covers it. Taps outside the card are blocked while the tour is active
 * (the highlighted element is not tappable either). Escape skips, arrows move, Tab stays inside the card.
 * The overlay is role="dialog" aria-modal and focus moves into the card.
 *
 * Styles are injected once (id ft-style). Theme: reads --acc, --bg, --card, --txt, --line from :root when present,
 * with dark fallbacks. z-index 2147483000 so it sits above the app's sheets.
 * Integration: call FormaTour.start(steps,{onTab:name=>go(name)}) from a button or after setup; remember "seen" in
 * the app's own settings. Do not call it while another full-screen layer is mid-animation.
 */
(function (root) {
  'use strict';
  var FormaTour = { version: 1, active: false };

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    if (typeof module !== 'undefined' && module.exports) module.exports = FormaTour;
    return;
  }

  var PAD = 8, GAP = 14, EDGE = 16, CARD_W = 320;
  var S = null; // live session

  var CSS = [
    '#ft{position:fixed;inset:0;z-index:2147483000;touch-action:none;-webkit-tap-highlight-color:transparent;',
    '--ft-acc:var(--acc,#6aa0ff);--ft-bg:var(--card,var(--bg,#172033));--ft-txt:var(--txt,#fff);--ft-line:var(--line,#26324b);',
    'font-family:inherit;opacity:0;transition:opacity .25s ease}',
    '#ft.on{opacity:1}',
    '#ft svg{position:absolute;inset:0;width:100%;height:100%;display:block}',
    '#ft .ft-hole,#ft .ft-ring{transition:x .38s cubic-bezier(.4,0,.2,1),y .38s cubic-bezier(.4,0,.2,1),width .38s cubic-bezier(.4,0,.2,1),height .38s cubic-bezier(.4,0,.2,1),rx .38s,ry .38s,opacity .25s}',
    '#ft.nt .ft-hole,#ft.nt .ft-ring,#ft.nt .ft-card,#ft.nt .ft-arrow{transition:none}',
    '#ft .ft-ring{fill:none;stroke:var(--ft-acc);stroke-width:2;filter:drop-shadow(0 0 6px var(--ft-acc)) drop-shadow(0 0 16px var(--ft-acc))}',
    '#ft .ft-card{position:absolute;box-sizing:border-box;background:var(--ft-bg);color:var(--ft-txt);border:1px solid var(--ft-line);',
    'border-radius:18px;padding:16px 16px 12px;box-shadow:0 18px 50px rgba(0,0,0,.45),0 2px 8px rgba(0,0,0,.3);outline:none;',
    'transition:left .38s cubic-bezier(.4,0,.2,1),top .38s cubic-bezier(.4,0,.2,1);font-size:14px;line-height:1.45}',
    '#ft .ft-body{transition:opacity .18s ease,transform .18s ease}',
    '#ft .ft-body.out{opacity:0;transform:translateY(3px)}',
    '#ft .ft-top{display:flex;align-items:center;gap:10px;margin-bottom:8px}',
    '#ft .ft-count{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--ft-acc);white-space:nowrap}',
    '#ft .ft-bar{flex:1;height:3px;border-radius:2px;background:color-mix(in srgb,var(--ft-txt) 14%,transparent);overflow:hidden}',
    '#ft .ft-bar i{display:block;height:100%;width:0;border-radius:2px;background:var(--ft-acc);transition:width .38s cubic-bezier(.4,0,.2,1)}',
    '#ft .ft-title{margin:0 0 4px;font-size:17px;font-weight:750;line-height:1.25;letter-spacing:-.01em}',
    '#ft .ft-text{margin:0 0 14px;color:color-mix(in srgb,var(--ft-txt) 78%,transparent)}',
    '#ft .ft-btns{display:flex;align-items:center;gap:8px}',
    '#ft .ft-btns .sp{flex:1}',
    '#ft button{font:inherit;font-size:14px;font-weight:650;min-height:44px;padding:0 16px;border-radius:12px;border:0;cursor:pointer;',
    'background:transparent;color:var(--ft-txt);-webkit-appearance:none;appearance:none}',
    '#ft button.skip{padding:0 8px;margin-left:-8px;font-weight:550;color:color-mix(in srgb,var(--ft-txt) 62%,transparent)}',
    '#ft button.back{background:color-mix(in srgb,var(--ft-txt) 10%,transparent)}',
    '#ft button.next{background:var(--ft-acc);color:var(--ft-on,#fff);min-width:84px}',
    '#ft button:disabled{opacity:.35;cursor:default}',
    '#ft button:focus-visible{outline:2px solid var(--ft-acc);outline-offset:2px}',
    '#ft .ft-card:focus,#ft .ft-card:focus-visible{outline:none}',
    '#ft .ft-arrow{position:absolute;width:14px;height:14px;background:var(--ft-bg);transform:rotate(45deg);border:1px solid var(--ft-line);',
    'transition:left .38s cubic-bezier(.4,0,.2,1),opacity .2s}',
    '#ft .ft-arrow.up{top:-8px;border-right:0;border-bottom:0}',
    '#ft .ft-arrow.down{bottom:-8px;border-left:0;border-top:0}',
    '#ft .ft-arrow.none{opacity:0}',
    '@media (prefers-reduced-motion:reduce){#ft,#ft *{transition:none!important}}'
  ].join('');

  function el(tag, cls, parent) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }
  function svgEl(tag, attrs, parent) {
    var e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function injectCSS() {
    if (document.getElementById('ft-style')) return;
    var s = document.createElement('style');
    s.id = 'ft-style';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var frame = function () { return new Promise(function (r) { requestAnimationFrame(function () { r(); }); }); };

  // Best text colour on the accent: resolve whatever CSS colour it is to rgb through a probe element.
  function onAccent(host) {
    try {
      var p = el('span', '', host);
      p.style.cssText = 'position:absolute;visibility:hidden;color:var(--ft-acc)';
      var m = getComputedStyle(p).color.match(/[\d.]+/g);
      host.removeChild(p);
      if (!m) return '#fff';
      var c = m.slice(0, 3).map(function (v) { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
      var L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      return L > 0.45 ? '#0b1020' : '#fff';
    } catch (e) { return '#fff'; }
  }

  function findTarget(step) {
    var t = step.target;
    try {
      if (typeof t === 'function') return t() || null;
      if (typeof t === 'string') return document.querySelector(t);
    } catch (e) {}
    return null;
  }
  async function waitTarget(step) {
    if (!step.target) return null;
    var end = Date.now() + 1200, t = findTarget(step);
    while (!t && Date.now() < end) { await wait(60); t = findTarget(step); }
    return t;
  }

  function build(opts) {
    injectCSS();
    var host = el('div'); host.id = 'ft';
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-modal', 'true');
    host.setAttribute('aria-labelledby', 'ft-title');
    host.setAttribute('aria-describedby', 'ft-text');
    if (opts.theme && opts.theme.accent) host.style.setProperty('--ft-acc', opts.theme.accent);

    var svg = svgEl('svg', { 'aria-hidden': 'true', focusable: 'false' }, host);
    var mask = svgEl('mask', { id: 'ft-mask', maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: '100%', height: '100%' }, svgEl('defs', {}, svg));
    svgEl('rect', { x: 0, y: 0, width: '100%', height: '100%', fill: '#fff' }, mask);
    var hole = svgEl('rect', { 'class': 'ft-hole', x: 0, y: 0, width: 0, height: 0, rx: 14, ry: 14, fill: '#000' }, mask);
    svgEl('rect', { x: 0, y: 0, width: '100%', height: '100%', fill: 'rgba(0,0,0,.7)', mask: 'url(#ft-mask)' }, svg);
    var ring = svgEl('rect', { 'class': 'ft-ring', x: 0, y: 0, width: 0, height: 0, rx: 14, ry: 14 }, svg);

    var card = el('div', 'ft-card', host);
    card.tabIndex = -1;
    card.style.width = Math.min(CARD_W, window.innerWidth - 2 * EDGE) + 'px';
    var arrow = el('div', 'ft-arrow none', card);
    var body = el('div', 'ft-body', card);
    var top = el('div', 'ft-top', body);
    var count = el('span', 'ft-count', top);
    var bar = el('div', 'ft-bar', top); var fill = el('i', '', bar);
    var title = el('h2', 'ft-title', body); title.id = 'ft-title';
    var text = el('p', 'ft-text', body); text.id = 'ft-text';
    var btns = el('div', 'ft-btns', body);
    var skip = el('button', 'skip', btns); skip.type = 'button'; skip.textContent = 'Skip';
    el('span', 'sp', btns);
    var back = el('button', 'back', btns); back.type = 'button'; back.textContent = 'Back';
    var next = el('button', 'next', btns); next.type = 'button'; next.textContent = 'Next';
    count.setAttribute('aria-live', 'polite');

    document.body.appendChild(host);
    host.style.setProperty('--ft-on', onAccent(host));
    return { host: host, hole: hole, ring: ring, card: card, arrow: arrow, body: body, count: count, fill: fill,
      title: title, text: text, skip: skip, back: back, next: next };
  }

  function setRect(u, x, y, w, h, rad) {
    var els = [u.hole, u.ring];
    for (var i = 0; i < els.length; i++) {
      var e = els[i], st = e.style;
      st.x = x + 'px'; st.y = y + 'px'; st.width = w + 'px'; st.height = h + 'px'; st.rx = rad + 'px'; st.ry = rad + 'px';
      // attributes as a fallback for engines that do not map geometry CSS properties on SVG rects
      e.setAttribute('x', x); e.setAttribute('y', y); e.setAttribute('width', w); e.setAttribute('height', h);
      e.setAttribute('rx', rad); e.setAttribute('ry', rad);
    }
  }

  // Put the hole and the card where they belong for the current step. animate=false for scroll and resize.
  function layout(animate) {
    if (!S || !S.ui) return;
    var u = S.ui, vw = window.innerWidth, vh = window.innerHeight;
    u.host.classList.toggle('nt', !animate);
    var cw = Math.min(CARD_W, vw - 2 * EDGE);
    u.card.style.width = cw + 'px';
    var ch = u.card.offsetHeight;
    var t = S.target && S.target.isConnected ? S.target : null;
    var left, topPos, side = 'none', ax = 0;

    if (!t) {
      u.hole.style.opacity = u.ring.style.opacity = 0;
      left = (vw - cw) / 2; topPos = Math.max(EDGE, (vh - ch) / 2);
    } else {
      u.hole.style.opacity = u.ring.style.opacity = 1;
      var b = t.getBoundingClientRect();
      var x = b.left - PAD, y = b.top - PAD, w = b.width + 2 * PAD, h = b.height + 2 * PAD;
      var rad = 14;
      try { var br = parseFloat(getComputedStyle(t).borderTopLeftRadius); if (br > 0) rad = Math.min(28, br + PAD); } catch (e) {}
      rad = Math.min(rad, w / 2, h / 2);

      var below = vh - (y + h) - GAP - EDGE, above = y - GAP - EDGE;
      var pl = (S.step.placement || 'auto');
      var fitsB = below >= ch, fitsA = above >= ch, place;
      if (pl === 'top' && fitsA) place = 'top';
      else if (pl === 'bottom' && fitsB) place = 'bottom';
      else if (fitsB) place = 'bottom';
      else if (fitsA) place = 'top';
      else {
        // target too tall for a card beside it: keep the card whole at the bottom and trim the lit area above it
        place = 'bottom';
        var maxBottom = vh - EDGE - ch - GAP;
        if (y + h > maxBottom) { y = Math.max(EDGE, y); h = Math.max(48, maxBottom - y); }
      }
      setRect(u, x, y, w, h, rad);
      topPos = place === 'bottom' ? y + h + GAP : y - GAP - ch;
      if (place === 'bottom' && topPos + ch > vh - EDGE) topPos = vh - EDGE - ch;
      if (topPos < EDGE) topPos = EDGE;
      var cx = x + w / 2;
      left = Math.min(Math.max(cx - cw / 2, EDGE), vw - EDGE - cw);
      side = place === 'bottom' ? 'up' : 'down';
      ax = Math.min(Math.max(cx - left, 26), cw - 26) - 7;
    }
    u.card.style.left = left + 'px';
    u.card.style.top = topPos + 'px';
    u.arrow.className = 'ft-arrow ' + side;
    u.arrow.style.left = ax + 'px';
  }

  function schedule() {
    if (!S || S.raf) return;
    S.raf = requestAnimationFrame(function () { S.raf = 0; layout(false); });
  }

  async function show(i) {
    if (!S) return;
    var my = ++S.seq;
    S.i = i;
    var step = S.steps[i], u = S.ui, o = S.opts;
    S.step = step;
    u.body.classList.add('out');
    u.back.disabled = i === 0;
    u.next.disabled = true;
    try {
      if (step.tab && o.onTab) await o.onTab(step.tab);
      if (step.before) await step.before();
    } catch (e) { /* a broken hook must not trap the user in the tour */ }
    if (!S || my !== S.seq) return;
    var t = await waitTarget(step);
    if (!S || my !== S.seq) return;
    S.target = t;
    if (t) {
      try {
        var r0 = t.getBoundingClientRect(), tall = r0.height > window.innerHeight * 0.55;
        t.scrollIntoView({ block: tall ? 'start' : 'center', inline: 'nearest', behavior: 'instant' });
      } catch (e) { try { t.scrollIntoView(); } catch (e2) {} }
      await frame();
      if (!S || my !== S.seq) return;
    }
    u.count.textContent = (i + 1) + ' of ' + S.steps.length;
    u.fill.style.width = ((i + 1) / S.steps.length * 100) + '%';
    u.title.textContent = step.title || '';
    u.text.textContent = step.text || '';
    var last = i === S.steps.length - 1;
    u.next.textContent = last ? 'Done' : 'Next';
    u.skip.style.visibility = last ? 'hidden' : '';
    u.next.disabled = false;
    layout(S.shown);
    S.shown = true;
    requestAnimationFrame(function () { if (S && my === S.seq) { u.body.classList.remove('out'); layout(true); } });
    // layout can shift once fonts, images or a tab swap settle
    setTimeout(function () { if (S && my === S.seq) layout(true); }, 220);
    try { u.card.focus({ preventScroll: true }); } catch (e) {}
  }

  function finish(kind) {
    if (!S) return;
    var s = S; S = null;
    FormaTour.active = false;
    window.removeEventListener('resize', s.onResize);
    window.removeEventListener('scroll', s.onResize, true);
    document.removeEventListener('keydown', s.onKey, true);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', s.onResize);
    if (s.raf) cancelAnimationFrame(s.raf);
    var host = s.ui.host;
    host.classList.remove('on');
    setTimeout(function () { if (host.parentNode) host.parentNode.removeChild(host); }, 260);
    try { if (s.prevFocus && s.prevFocus.focus) s.prevFocus.focus({ preventScroll: true }); } catch (e) {}
    try {
      if (kind === 'done' && s.opts.onDone) s.opts.onDone();
      if (kind === 'skip' && s.opts.onSkip) s.opts.onSkip();
    } catch (e) { if (window.console) console.error(e); }
    s.resolve(kind);
  }

  FormaTour.start = function (steps, opts) {
    if (S) finish('stop');
    steps = (steps || []).filter(Boolean);
    opts = opts || {};
    return new Promise(function (resolve) {
      if (!steps.length) { resolve('stop'); return; }
      var ui = build(opts);
      S = { steps: steps, opts: opts, ui: ui, i: 0, seq: 0, target: null, step: steps[0], shown: false,
        raf: 0, resolve: resolve, prevFocus: document.activeElement };
      FormaTour.active = true;
      S.onResize = schedule;
      S.onKey = function (e) {
        if (!S) return;
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish('skip'); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); FormaTour.next(); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); FormaTour.back(); }
        else if (e.key === 'Enter' && document.activeElement === S.ui.card) { e.preventDefault(); FormaTour.next(); }
        else if (e.key === 'Tab') {
          var f = [S.ui.skip, S.ui.back, S.ui.next].filter(function (b) { return !b.disabled && b.style.visibility !== 'hidden'; });
          e.preventDefault();
          if (!f.length) return;
          var at = f.indexOf(document.activeElement);
          if (e.shiftKey) f[at <= 0 ? f.length - 1 : at - 1].focus();
          else f[at < 0 || at === f.length - 1 ? 0 : at + 1].focus();
        }
      };
      window.addEventListener('resize', S.onResize);
      window.addEventListener('scroll', S.onResize, true);
      if (window.visualViewport) window.visualViewport.addEventListener('resize', S.onResize);
      document.addEventListener('keydown', S.onKey, true);
      // block every tap, drag and wheel outside the card (the highlighted element is not tappable either)
      var block = function (e) { if (!ui.card.contains(e.target)) { e.preventDefault(); e.stopPropagation(); } };
      ['click', 'mousedown', 'pointerdown', 'touchstart', 'touchmove', 'wheel', 'contextmenu'].forEach(function (n) {
        ui.host.addEventListener(n, block, { passive: false });
      });
      ui.next.addEventListener('click', function () { FormaTour.next(); });
      ui.back.addEventListener('click', function () { FormaTour.back(); });
      ui.skip.addEventListener('click', function () { finish('skip'); });
      requestAnimationFrame(function () { ui.host.classList.add('on'); });
      show(Math.min(Math.max(opts.startAt | 0, 0), steps.length - 1));
    });
  };

  FormaTour.next = function () {
    if (!S || S.ui.next.disabled) return;
    if (S.i >= S.steps.length - 1) finish('done'); else show(S.i + 1);
  };
  FormaTour.back = function () {
    if (!S || S.i === 0) return;
    show(S.i - 1);
  };
  FormaTour.stop = function () { finish('stop'); };

  root.FormaTour = FormaTour;
  if (typeof module !== 'undefined' && module.exports) module.exports = FormaTour;
})(typeof window !== 'undefined' ? window : this);
