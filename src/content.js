// Injected on demand into the page being captured. Owns everything that has to
// happen inside the page: picking the scroll container, scrolling, hiding
// repeated fixed headers, the area-selection overlay and the on-page HUD.
// Pixels are grabbed by the service worker; this script tells it what to keep.
(() => {
  const alive = () => {
    try { return !!chrome.runtime?.id; } catch { return false; }
  };
  // Re-injection is a no-op unless the previous copy was orphaned by an extension reload.
  if (window.__tallShot?.alive?.()) return;
  window.__tallShot = { alive };

  const HOST_TAG = 'tall-shot-ui';
  const CAPTURE_GAP = 510; // Chrome allows 2 captureVisibleTab calls per second
  const CANCELLED = Symbol('cancelled');
  const state = { busy: false, stop: null, abort: null };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const send = (msg) => chrome.runtime.sendMessage(msg);
  // Fire-and-forget status messages; nothing useful to do if the worker can't be reached.
  const notify = (msg) => send(msg).catch(() => {});
  const inside = (r, x, y) => x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height;

  // Resolves once the current DOM state has been painted (with a fallback for throttled tabs).
  const nextPaint = () => new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, 150);
  });

  // ---------------------------------------------------------------- scrolling

  const viewEl = () => (document.compatMode === 'CSS1Compat' || !document.body ? document.documentElement : document.body);

  // A scroller exposes a uniform "content" coordinate system: y = 0 is the top
  // of the scrollable content, rect() is the visible window onto it.
  function windowScroller() {
    return {
      el: null,
      get y() { return window.scrollY; },
      to(y) { window.scrollTo({ left: window.scrollX, top: Math.max(0, Math.floor(y)), behavior: 'instant' }); },
      height() { return (document.scrollingElement || document.documentElement).scrollHeight; },
      rect() {
        const v = viewEl();
        return { left: 0, top: 0, width: v.clientWidth, height: v.clientHeight };
      },
    };
  }

  function elementScroller(el) {
    const box = () => {
      const r = el.getBoundingClientRect();
      const v = viewEl();
      const top = r.top + el.clientTop;
      const left = r.left + el.clientLeft;
      const t = Math.max(top, 0);
      const l = Math.max(left, 0);
      const b = Math.min(top + el.clientHeight, v.clientHeight);
      const rr = Math.min(left + el.clientWidth, v.clientWidth);
      return { left: l, top: t, width: Math.max(0, rr - l), height: Math.max(0, b - t), skip: t - top };
    };
    return {
      el,
      get y() { return el.scrollTop + box().skip; },
      to(y) { el.scrollTo({ top: Math.max(0, Math.floor(y - box().skip)), behavior: 'instant' }); },
      height() { return el.scrollHeight; },
      rect: box,
    };
  }

  // Most sites scroll the window; app-style pages (mail, chat, docs) scroll an
  // inner panel instead. Pick whichever actually holds the long content.
  function detectScroller() {
    const win = windowScroller();
    const vr = win.rect();
    const winRange = win.height() - vr.height;
    if (winRange > vr.height * 0.5 || !document.body) return win;

    let best = null;
    let bestArea = vr.width * vr.height * 0.15;
    for (const el of [document.body, ...document.body.querySelectorAll('*')]) {
      if (el.clientHeight < 80 || el.scrollHeight - el.clientHeight <= Math.max(winRange, 10)) continue;
      const r = el.getBoundingClientRect();
      const w = Math.min(r.right, vr.width) - Math.max(r.left, 0);
      const h = Math.min(r.bottom, vr.height) - Math.max(r.top, 0);
      if (w <= 0 || h <= 0 || w * h <= bestArea) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
      best = el;
      bestArea = w * h;
    }
    return best ? elementScroller(best) : win;
  }

  // --------------------------------------------------------- page preparation

  const PAGE_CSS = `
    [data-tss-hide], [data-tss-hide] * { visibility: hidden !important; }
    [data-tss-hide] { transition: none !important; animation: none !important; }
    [data-tss-unstick] { position: relative !important; inset: auto !important; }
    [data-tss-scroller] { scroll-behavior: auto !important; scroll-snap-type: none !important; }
  `;

  // Fixed headers would otherwise repeat on every screen. Top-anchored ones are
  // kept on the first screen, bottom-anchored ones (cookie bars, chat bubbles)
  // on the last, full-height ones (sidebars, backgrounds) everywhere. Sticky
  // elements fall back to their natural position whenever top bars are hidden.
  function collectFixed(vr) {
    const top = [];
    const bottom = [];
    const sticky = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el.localName === HOST_TAG) continue;
      const pos = getComputedStyle(el).position;
      if (pos === 'sticky') {
        sticky.push(el);
      } else if (pos === 'fixed') {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        if (r.bottom <= vr.top || r.top >= vr.top + vr.height || r.right <= vr.left || r.left >= vr.left + vr.width) continue;
        if (r.height >= vr.height * 0.6) continue;
        (r.top + r.height / 2 < vr.top + vr.height / 2 ? top : bottom).push(el);
      }
    }
    const toggle = (els, attr, on) => {
      for (const el of els) on ? el.setAttribute(attr, '') : el.removeAttribute(attr);
    };
    return {
      apply(showTop, showBottom) {
        toggle(top, 'data-tss-hide', !showTop);
        toggle(bottom, 'data-tss-hide', !showBottom);
        toggle(sticky, 'data-tss-unstick', !showTop);
      },
      restore() {
        toggle(top, 'data-tss-hide', false);
        toggle(bottom, 'data-tss-hide', false);
        toggle(sticky, 'data-tss-unstick', false);
      },
    };
  }

  // Keep the user from scrolling the page out from under the capture.
  function blockInput(onEscape) {
    const scrollKeys = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        onEscape();
      } else if (scrollKeys.has(e.key)) {
        e.preventDefault();
      }
    };
    const block = (e) => e.preventDefault();
    const opts = { capture: true, passive: false };
    addEventListener('keydown', onKey, true);
    addEventListener('wheel', block, opts);
    addEventListener('touchmove', block, opts);
    return () => {
      removeEventListener('keydown', onKey, true);
      removeEventListener('wheel', block, opts);
      removeEventListener('touchmove', block, opts);
    };
  }

  // ----------------------------------------------------------------------- UI

  const FONT = 'font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;';

  function mountUI(css, html, interactive) {
    const host = document.createElement(HOST_TAG);
    host.style.cssText = `all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;display:block!important;pointer-events:${interactive ? 'auto' : 'none'}!important;`;
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${css}</style>${html}`;
    document.documentElement.appendChild(host);
    return { host, $: (s) => root.querySelector(s) };
  }

  const HUD_CSS = `
    .hud { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); display: flex; align-items: center; gap: 10px;
      padding: 6px 6px 6px 14px; border-radius: 999px; background: rgba(20, 18, 30, .94); color: #fff; ${FONT}
      font-size: 13px; line-height: 1.2; box-shadow: 0 10px 30px rgba(0, 0, 0, .35); pointer-events: auto; white-space: nowrap; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #f43f5e; animation: pulse 1s ease-in-out infinite; }
    .len { font-variant-numeric: tabular-nums; color: #c4b5fd; min-width: 64px; }
    button { all: unset; cursor: pointer; padding: 7px 14px; border-radius: 999px; background: #7c3aed; color: #fff; font-weight: 600; }
    button:hover { background: #6d28d9; }
    button.x { background: rgba(255, 255, 255, .12); padding: 7px 10px; }
    button.x:hover { background: rgba(255, 255, 255, .2); }
    kbd { font: inherit; font-size: 11px; opacity: .55; }
    @keyframes pulse { 50% { opacity: .35; } }
  `;

  function createHud(onStop, onAbort) {
    const ui = mountUI(HUD_CSS, `
      <div class="hud" role="status">
        <span class="dot"></span><span>Capturing</span><span class="len">0 px</span><kbd>Esc</kbd>
        <button class="stop" title="Stop here and open the editor">Stop</button>
        <button class="x" title="Cancel capture" aria-label="Cancel">✕</button>
      </div>`, false);
    ui.$('.stop').addEventListener('click', onStop);
    ui.$('.x').addEventListener('click', onAbort);
    return {
      update(px, pct) { ui.$('.len').textContent = `${Math.round(px).toLocaleString()} px · ${pct}%`; },
      hide() { ui.host.style.setProperty('display', 'none', 'important'); },
      show() { ui.host.style.setProperty('display', 'block', 'important'); },
      remove() { ui.host.remove(); },
    };
  }

  const SELECT_CSS = `
    .layer { position: fixed; inset: 0; cursor: crosshair; touch-action: none; ${FONT} }
    .dim { position: fixed; inset: 0; background: rgba(15, 12, 30, .38); }
    .box { position: fixed; outline: 2px solid #8b5cf6; box-shadow: 0 0 0 200vmax rgba(15, 12, 30, .38); }
    .label { position: fixed; padding: 3px 7px; border-radius: 6px; background: #7c3aed; color: #fff; font-size: 12px;
      font-variant-numeric: tabular-nums; pointer-events: none; white-space: nowrap; }
    .hint { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); padding: 9px 16px; border-radius: 999px;
      background: rgba(20, 18, 30, .94); color: #fff; font-size: 13px; box-shadow: 0 10px 30px rgba(0, 0, 0, .35);
      pointer-events: none; white-space: nowrap; }
    .hint b { color: #c4b5fd; font-weight: 600; }
    [hidden] { display: none !important; }
  `;

  // Resolves with { scroller, region } or null when cancelled. Dragging near the
  // top/bottom edge (or using the wheel) scrolls, so the area can be any height.
  function selectArea() {
    return new Promise((resolve) => {
      const main = detectScroller();
      const ui = mountUI(SELECT_CSS, `
        <div class="layer">
          <div class="dim"></div><div class="box" hidden></div><div class="label" hidden></div>
          <div class="hint">Drag to select · drag past the edge or <b>scroll</b> to go taller · <b>Esc</b> to cancel</div>
        </div>`, true);
      const layer = ui.$('.layer');
      const dim = ui.$('.dim');
      const box = ui.$('.box');
      const label = ui.$('.label');
      const hint = ui.$('.hint');
      let scroller = main;
      let start = null;
      let cur = null;
      let pointer = null;
      let raf = 0;

      const pick = (x, y) => (main.el && !inside(main.rect(), x, y) ? windowScroller() : main);
      const toContent = () => {
        const vr = scroller.rect();
        return {
          x: clamp(pointer.x, vr.left, vr.left + vr.width),
          y: clamp(clamp(pointer.y, vr.top, vr.top + vr.height) - vr.top + scroller.y, 0, scroller.height()),
        };
      };
      const draw = () => {
        const vr = scroller.rect();
        const x0 = Math.min(start.x, cur.x);
        const y0 = Math.min(start.y, cur.y);
        const w = Math.abs(cur.x - start.x);
        const h = Math.abs(cur.y - start.y);
        Object.assign(box.style, { left: `${x0}px`, top: `${y0 - scroller.y + vr.top}px`, width: `${w}px`, height: `${h}px` });
        label.textContent = `${Math.round(w)} × ${Math.round(h)}`;
        Object.assign(label.style, {
          left: `${clamp(pointer.x + 14, 4, innerWidth - 110)}px`,
          top: `${clamp(pointer.y + 16, 4, innerHeight - 28)}px`,
        });
        box.hidden = label.hidden = false;
        dim.hidden = hint.hidden = true;
      };
      const update = () => {
        if (!start || !pointer) return;
        cur = toContent();
        draw();
      };
      const tick = () => {
        raf = 0;
        if (!start || !pointer) return;
        const vr = scroller.rect();
        const edge = 40;
        const below = pointer.y - (vr.top + vr.height - edge);
        const above = vr.top + edge - pointer.y;
        const d = below > 0 ? below : above > 0 ? -above : 0;
        if (!d) return;
        scroller.to(scroller.y + Math.sign(d) * Math.min(80, 6 + Math.abs(d) * 0.8));
        update();
        raf = requestAnimationFrame(tick);
      };
      const finish = (result) => {
        cancelAnimationFrame(raf);
        removeEventListener('keydown', onKey, true);
        removeEventListener('scroll', update, true);
        ui.host.remove();
        state.stop = state.abort = null;
        resolve(result);
      };
      const onKey = (e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopImmediatePropagation();
        finish(null);
      };
      addEventListener('keydown', onKey, true);
      addEventListener('scroll', update, true); // keyboard scrolling keeps the box anchored to content
      state.stop = state.abort = () => finish(null);

      layer.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        scroller = pick(e.clientX, e.clientY);
        pointer = { x: e.clientX, y: e.clientY };
        start = toContent();
        cur = { ...start };
        layer.setPointerCapture(e.pointerId);
        draw();
      });
      layer.addEventListener('pointermove', (e) => {
        pointer = { x: e.clientX, y: e.clientY };
        if (!start) return;
        update();
        if (!raf) raf = requestAnimationFrame(tick);
      });
      layer.addEventListener('pointerup', (e) => {
        if (!start) return;
        pointer = { x: e.clientX, y: e.clientY };
        update();
        const vr = scroller.rect();
        const w = Math.abs(cur.x - start.x);
        const h = Math.abs(cur.y - start.y);
        if (w < 5 || h < 5) {
          start = null;
          box.hidden = label.hidden = true;
          dim.hidden = hint.hidden = false;
          return;
        }
        finish({ scroller, region: { x: Math.min(start.x, cur.x) - vr.left, y: Math.min(start.y, cur.y), w, h } });
      });
      layer.addEventListener('wheel', (e) => {
        e.preventDefault();
        const s = start ? scroller : pick(e.clientX, e.clientY);
        const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? s.rect().height : 1;
        s.to(s.y + e.deltaY * unit);
        update();
      }, { passive: false });
      layer.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        finish(null);
      });
    });
  }

  // ------------------------------------------------------------------ capture

  // Scrolls through `region` (content coordinates of `scroller`) and asks the
  // service worker to grab each screen. Every frame records which slice of the
  // viewport is new, so overlap at the bottom, clamped scrolling and content that
  // grows while loading all stitch correctly.
  async function capture({ sid, scroller, region, hud, settings }) {
    const winStart = { x: window.scrollX, y: window.scrollY };
    const startY = scroller.y;
    let stopped = false;
    let aborted = false;
    state.stop = () => { stopped = true; };
    state.abort = () => { aborted = true; };

    const style = document.createElement('style');
    style.textContent = PAGE_CSS;
    (document.head || document.documentElement).appendChild(style);
    const scrollEl = scroller.el || document.documentElement;
    scrollEl.setAttribute('data-tss-scroller', '');
    const singleScreen = region.h <= scroller.rect().height + 1;
    const fixed = settings.hideFixed && !singleScreen ? collectFixed(scroller.rect()) : null;
    const unblock = blockInput(() => state.stop?.());
    const ui = hud ? createHud(() => state.stop?.(), () => state.abort?.()) : null;

    const settle = Math.max(0, Number(settings.delay) || 0);
    let covered = region.y;
    let frames = 0;
    let lastShot = -Infinity;
    const regionEnd = () => Math.min(region.y + region.h, scroller.height());
    const check = () => {
      if (aborted) throw CANCELLED;
      if (document.hidden) throw new Error('Capture stopped because the tab was hidden.');
    };

    try {
      const vr0 = scroller.rect();
      let target = region.y >= scroller.y - 1 && region.y + 1 < scroller.y + vr0.height ? null : region.y;
      // Top bars belong on the first screen only if it shows the page as the user saw
      // it: from the very top, or without scrolling. Otherwise they'd cover the area.
      const topBarsFirst = target === null || region.y < 1;

      for (;;) {
        if (target !== null) scroller.to(target);
        // The wait for Chrome's capture rate limit doubles as time for lazy content to load.
        const wait = Math.max(target !== null ? settle : 0, lastShot + CAPTURE_GAP - performance.now());
        if (wait > 0) await sleep(wait);
        check();

        if (fixed) {
          const lastScreen = scroller.y + scroller.rect().height >= regionEnd() - 0.5;
          const pageEnd = region.y + region.h >= scroller.height() - 1;
          fixed.apply(frames === 0 && topBarsFirst, lastScreen && pageEnd);
        }
        ui?.hide();
        await nextPaint();
        check();

        const vr = scroller.rect();
        const top = scroller.y;
        const end = regionEnd();
        const segStart = Math.max(covered, top);
        const segEnd = Math.min(top + vr.height, end);
        if (segEnd - segStart < 0.5 || vr.width < 1) {
          ui?.show();
          break;
        }

        const sentAt = performance.now();
        const v = viewEl();
        const res = await send({
          type: 'tss:grab',
          sid,
          i: frames,
          crop: { x: vr.left + region.x, y: vr.top + (segStart - top), w: Math.min(region.w, vr.width - region.x), h: segEnd - segStart },
          dest: { x: 0, y: segStart - region.y },
          vp: { iw: innerWidth, ih: innerHeight, cw: v.clientWidth, ch: v.clientHeight, dpr: devicePixelRatio },
          progress: { done: segEnd - region.y, total: end - region.y },
        });
        lastShot = sentAt;
        ui?.show();
        if (!res?.ok) throw new Error(res?.error || 'Screenshot failed.');
        frames++;
        covered = segEnd;
        ui?.update(covered - region.y, Math.min(100, Math.round(((covered - region.y) / Math.max(1, end - region.y)) * 100)));
        if (stopped || covered >= regionEnd() - 0.5) break;
        target = covered;
      }
      return { frames, w: region.w, h: covered - region.y };
    } finally {
      state.stop = state.abort = null;
      unblock();
      ui?.remove();
      fixed?.restore();
      style.remove();
      scrollEl.removeAttribute('data-tss-scroller');
      if (scroller.el) scroller.to(startY);
      window.scrollTo({ left: winStart.x, top: winStart.y, behavior: 'instant' });
    }
  }

  async function run({ sid, mode, opts = {}, hud, settings }) {
    try {
      let scroller;
      let region;
      if (mode === 'select') {
        const sel = await selectArea();
        if (!sel) {
          notify({ type: 'tss:cancelled', sid });
          return;
        }
        ({ scroller, region } = sel);
      } else if (mode === 'visible') {
        scroller = windowScroller();
        const vr = scroller.rect();
        region = { x: 0, y: scroller.y, w: vr.width, h: vr.height };
      } else {
        scroller = detectScroller();
        const vr = scroller.rect();
        const custom = mode === 'custom';
        const y = custom && opts.from === 'here' ? scroller.y : 0;
        const value = Number(opts.value) || 0;
        const h = custom ? (opts.unit === 'px' ? value : value * vr.height) : Number(settings.maxHeight) || 30000;
        region = { x: 0, y, w: vr.width, h: Math.max(1, h) };
      }

      const res = await capture({ sid, scroller, region, hud: !!hud, settings });
      if (!res.frames) {
        notify({ type: 'tss:cancelled', sid });
        return;
      }
      notify({ type: 'tss:done', sid, ...res, title: document.title, url: location.href });
    } catch (err) {
      notify(err === CANCELLED
        ? { type: 'tss:cancelled', sid }
        : { type: 'tss:error', sid, error: err?.message || String(err) });
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case 'tss:run':
        if (state.busy) {
          sendResponse({ ok: false, error: 'A capture is already running in this tab.' });
          break;
        }
        state.busy = true;
        sendResponse({ ok: true });
        run(msg).finally(() => { state.busy = false; });
        break;
      case 'tss:stop':
        sendResponse({ ok: true, busy: state.busy });
        state.stop?.();
        break;
      case 'tss:abort':
        sendResponse({ ok: true, busy: state.busy });
        state.abort?.();
        break;
    }
  });
})();
