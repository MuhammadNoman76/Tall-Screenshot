// Injected on demand for the inspection tools: a color picker with a magnifier
// and a ruler that measures distances to the nearest edges, dragged boxes and
// element sizes. Both read pixels from a screenshot of the visible tab, which is
// refreshed whenever the page scrolls or resizes.
(() => {
  const alive = () => {
    try { return !!chrome.runtime?.id; } catch { return false; }
  };
  // Re-injection is a no-op unless the previous copy was orphaned by an extension reload.
  if (window.__tallShotTools?.alive?.()) return;
  const tools = (window.__tallShotTools = { alive, active: null });

  const HOST_TAG = 'tall-shot-tools';
  const TOLERANCE = 12; // per-channel difference that counts as an edge
  const CELLS = 11; // magnifier shows CELLS × CELLS screen pixels
  const CELL = 12; // CSS px per magnified pixel
  const LOUPE = CELLS * CELL;
  const FONT = 'font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;';

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const nextPaint = () => new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, 150);
  });

  // ------------------------------------------------------------------ pixels

  async function readScreen() {
    const res = await chrome.runtime.sendMessage({ type: 'tss:shot' });
    if (!res?.ok) throw new Error(res?.error || "Couldn't read the screen.");
    const bin = atob(res.dataUrl.slice(res.dataUrl.indexOf(',') + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    return {
      canvas,
      w: canvas.width,
      h: canvas.height,
      data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
      scale: canvas.width / innerWidth, // screen pixels per CSS pixel
    };
  }

  const rgbAt = (shot, x, y) => {
    const i = (y * shot.w + x) * 4;
    return [shot.data[i], shot.data[i + 1], shot.data[i + 2]];
  };

  const devicePoint = (shot, p) => ({
    x: clamp(Math.floor(p.x * shot.scale), 0, shot.w - 1),
    y: clamp(Math.floor(p.y * shot.scale), 0, shot.h - 1),
  });

  // ----------------------------------------------------------------- colors

  const { toHex, format: formatColor } = globalThis.tallShotColor; // from color.js, injected first

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Not a secure page, or focus is elsewhere: fall back to a temporary textarea.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed!important;left:-9999px!important;top:0!important;opacity:0!important;';
      document.documentElement.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
      return ok;
    }
  }

  async function remember(hex) {
    const { colorHistory = [] } = await chrome.storage.local.get({ colorHistory: [] });
    await chrome.storage.local.set({ colorHistory: [hex, ...colorHistory.filter((c) => c !== hex)].slice(0, 16) });
  }

  // ----------------------------------------------------------------- overlay

  const BASE_CSS = `
    .layer { position: fixed; inset: 0; cursor: crosshair; ${FONT} font-size: 12px; color: #fff; }
    .ui.hidden { visibility: hidden; }
    [hidden] { display: none !important; }
    .hint { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); padding: 8px 14px; border-radius: 999px;
      background: rgba(20, 18, 30, .94); font-size: 13px; white-space: nowrap; box-shadow: 0 10px 30px rgba(0, 0, 0, .35); pointer-events: none; }
    .hint.top { bottom: auto; top: 20px; }
    .hint b { color: #c4b5fd; font-weight: 600; }
  `;

  function mount(css, html, interactive = true) {
    const host = document.createElement(HOST_TAG);
    host.style.cssText = `all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;display:block!important;pointer-events:${interactive ? 'auto' : 'none'}!important;`;
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${BASE_CSS}${css}</style>${html}`;
    document.documentElement.appendChild(host);
    return { host, $: (q) => root.querySelector(q) };
  }

  function toast(text, swatch) {
    const t = mount(`
      .t { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); display: flex; align-items: center; gap: 8px;
        padding: 8px 14px 8px 8px; border-radius: 10px; background: rgba(20, 18, 30, .94); color: #fff; ${FONT} font-size: 13px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, .35); white-space: nowrap; }
      i { width: 20px; height: 20px; border-radius: 6px; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .3); }
      .t.plain { padding-left: 14px; }`, '<div class="t"><i></i><span></span></div>', false);
    t.$('span').textContent = text;
    if (swatch) t.$('i').style.background = swatch;
    else {
      t.$('i').hidden = true;
      t.$('.t').classList.add('plain');
    }
    setTimeout(() => t.host.remove(), 1800);
  }

  // Shared plumbing for both tools: the full-page layer, screenshot refreshes
  // (with our own UI hidden), scrolling through the layer, and Esc to exit.
  function overlay(css, html, hint) {
    const { host, $ } = mount(css, `<div class="layer"><div class="ui">${html}<div class="hint">${hint}</div></div></div>`);
    const ov = { host, $, layer: $('.layer'), ui: $('.ui'), shot: null, stale: true, pointer: null };
    const cleanups = [];
    ov.on = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      cleanups.push(() => target.removeEventListener(type, fn, opts));
    };

    let raf = 0;
    ov.redraw = () => {
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; ov.draw?.(); });
    };

    let running = null;
    let again = false;
    let timer = 0;
    ov.refresh = () => {
      if (running) {
        again = true;
        return running;
      }
      running = (async () => {
        do {
          again = false;
          ov.ui.classList.add('hidden');
          await nextPaint();
          try {
            ov.shot = await readScreen();
          } catch (e) {
            ov.exit();
            toast(e.message);
            return;
          } finally {
            ov.ui.classList.remove('hidden');
          }
        } while (again);
        ov.stale = false;
        ov.redraw();
      })().finally(() => { running = null; });
      return running;
    };

    const markStale = () => {
      ov.stale = true;
      ov.onStale?.();
      ov.redraw();
      clearTimeout(timer);
      timer = setTimeout(ov.refresh, 220);
    };
    ov.on(window, 'scroll', markStale, true);
    ov.on(window, 'resize', markStale);

    // The layer covers the page, so pass wheel scrolling to whatever is underneath.
    ov.on(ov.layer, 'wheel', (e) => {
      e.preventDefault();
      const under = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el !== host);
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? innerHeight : 1;
      scrollerFor(under).scrollBy({ left: e.deltaX * unit, top: e.deltaY * unit, behavior: 'instant' });
    }, { passive: false });

    ov.on(ov.layer, 'pointermove', (e) => {
      ov.pointer = { x: e.clientX, y: e.clientY };
      const hint = $('.hint');
      hint.classList.toggle('top', e.clientY > innerHeight - 90 && Math.abs(e.clientX - innerWidth / 2) < 340);
      ov.onMove?.(e);
      ov.redraw();
    });
    ov.on(ov.layer, 'contextmenu', (e) => {
      e.preventDefault();
      ov.exit();
    });
    ov.on(window, 'keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        ov.exit();
      } else {
        ov.onKey?.(e);
      }
    }, true);

    ov.exit = () => {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      for (const off of cleanups.splice(0)) off();
      host.remove();
      if (tools.active === ov) tools.active = null;
    };

    ov.refresh();
    return ov;
  }

  function scrollerFor(el) {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      if (n.scrollHeight > n.clientHeight + 1 && /(auto|scroll|overlay)/.test(getComputedStyle(n).overflowY)) return n;
    }
    return document.scrollingElement || document.documentElement;
  }

  // ------------------------------------------------------------ color picker

  const PICKER_CSS = `
    .loupe { position: fixed; width: ${LOUPE}px; height: ${LOUPE}px; border-radius: 50%; overflow: hidden; background: #888;
      box-shadow: 0 0 0 3px #fff, 0 0 0 4px rgba(0, 0, 0, .3), 0 10px 30px rgba(0, 0, 0, .4); pointer-events: none; }
    .loupe canvas { display: block; width: 100%; height: 100%; }
    .chip { position: fixed; display: flex; align-items: center; gap: 8px; padding: 6px 10px 6px 6px; border-radius: 10px;
      background: rgba(20, 18, 30, .94); box-shadow: 0 10px 30px rgba(0, 0, 0, .35); pointer-events: none; white-space: nowrap;
      font-variant-numeric: tabular-nums; }
    .sw { width: 22px; height: 22px; border-radius: 6px; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .3); }
    .chip b { font-size: 13px; letter-spacing: .02em; }
    .chip span { opacity: .65; }
  `;

  function colorPicker(settings) {
    const ov = overlay(PICKER_CSS,
      '<div class="loupe" hidden><canvas></canvas></div><div class="chip" hidden><i class="sw"></i><b></b><span></span></div>',
      'Click to copy a color · arrow keys for 1px steps · <b>Esc</b> to exit');
    const loupe = ov.$('.loupe');
    const chip = ov.$('.chip');
    const canvas = ov.$('canvas');
    const dpr = devicePixelRatio || 1;
    canvas.width = canvas.height = Math.round(LOUPE * dpr);
    const ctx = canvas.getContext('2d');

    const current = () => {
      if (!ov.shot || !ov.pointer) return null;
      const d = devicePoint(ov.shot, ov.pointer);
      return rgbAt(ov.shot, d.x, d.y);
    };

    ov.draw = () => {
      const p = ov.pointer;
      const ready = p && ov.shot && !ov.stale;
      loupe.hidden = chip.hidden = !ready;
      if (!ready) return;
      const { x, y } = devicePoint(ov.shot, p);
      const half = (CELLS - 1) / 2;
      const size = canvas.width;
      const cell = size / CELLS;
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = '#888';
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(ov.shot.canvas, x - half, y - half, CELLS, CELLS, 0, 0, size, size);
      ctx.strokeStyle = 'rgba(0, 0, 0, .1)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 1; i < CELLS; i++) {
        const v = Math.round(i * cell) + 0.5;
        ctx.moveTo(v, 0); ctx.lineTo(v, size);
        ctx.moveTo(0, v); ctx.lineTo(size, v);
      }
      ctx.stroke();
      const c0 = Math.round(half * cell);
      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = '#000';
      ctx.strokeRect(c0 - dpr, c0 - dpr, cell + 2 * dpr, cell + 2 * dpr);
      ctx.strokeStyle = '#fff';
      ctx.strokeRect(c0, c0, cell, cell);

      const rgb = rgbAt(ov.shot, x, y);
      chip.querySelector('.sw').style.background = toHex(rgb);
      chip.querySelector('b').textContent = toHex(rgb);
      chip.querySelector('span').textContent = `rgb(${rgb.join(', ')})`;

      const gap = 22;
      const left = p.x + gap + LOUPE > innerWidth - 8 ? p.x - gap - LOUPE : p.x + gap;
      const top = p.y + gap + LOUPE + 44 > innerHeight - 8 ? p.y - gap - LOUPE - 44 : p.y + gap;
      Object.assign(loupe.style, { left: `${left}px`, top: `${top}px` });
      Object.assign(chip.style, { left: `${left}px`, top: `${top + LOUPE + 10}px` });
    };

    const pick = () => {
      const rgb = current();
      if (!rgb || ov.stale) return;
      const text = formatColor(rgb, settings.colorFormat);
      // Start the copy inside the click/keypress so it still counts as a user gesture.
      const copied = copyText(text);
      ov.exit();
      remember(toHex(rgb)).catch(() => {});
      copied.then((ok) => toast(ok ? `Copied ${text}` : `${text} (copy blocked by this page)`, toHex(rgb)));
    };

    ov.on(ov.layer, 'click', (e) => {
      ov.pointer = { x: e.clientX, y: e.clientY };
      pick();
    });
    ov.onKey = (e) => {
      const step = e.shiftKey ? 10 : 1;
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (moves[e.key]) {
        e.preventDefault();
        const p = ov.pointer || { x: innerWidth / 2, y: innerHeight / 2 };
        ov.pointer = { x: clamp(p.x + moves[e.key][0], 0, innerWidth - 1), y: clamp(p.y + moves[e.key][1], 0, innerHeight - 1) };
        ov.redraw();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pick();
      }
    };
    return ov;
  }

  // -------------------------------------------------------------------- ruler

  const RULER = '#ff3d71';
  const ELEMENT = '#3b82f6';
  const MEASURE_CSS = `
    .lh, .lv { position: fixed; background: ${RULER}; pointer-events: none; box-shadow: 0 0 0 1px rgba(255, 255, 255, .6); }
    .lh { height: 1px; }
    .lv { width: 1px; }
    .lh::before, .lh::after, .lv::before, .lv::after { content: ""; position: absolute; background: ${RULER}; }
    .lh::before, .lh::after { top: -4px; width: 1px; height: 9px; }
    .lh::before { left: 0; } .lh::after { right: 0; }
    .lv::before, .lv::after { left: -4px; width: 9px; height: 1px; }
    .lv::before { top: 0; } .lv::after { bottom: 0; }
    .tag { position: fixed; padding: 3px 7px; border-radius: 6px; background: ${RULER}; font-weight: 600;
      font-variant-numeric: tabular-nums; white-space: nowrap; pointer-events: none; box-shadow: 0 2px 8px rgba(0, 0, 0, .25); }
    .box { position: fixed; outline: 1px solid ${RULER}; background: rgba(255, 61, 113, .12); pointer-events: none; }
    .el { position: fixed; outline: 1px solid ${ELEMENT}; background: rgba(59, 130, 246, .15); pointer-events: none; }
    .tag.blue { background: ${ELEMENT}; }
  `;

  // Walks outward from (x, y) until the color changes: the bounds of the area under the cursor.
  function edgesAt(shot, x, y) {
    const [r0, g0, b0] = rgbAt(shot, x, y);
    const { data, w, h } = shot;
    const differs = (px, py) => {
      const i = (py * w + px) * 4;
      return Math.abs(data[i] - r0) > TOLERANCE || Math.abs(data[i + 1] - g0) > TOLERANCE || Math.abs(data[i + 2] - b0) > TOLERANCE;
    };
    let l = x;
    while (l > 0 && !differs(l - 1, y)) l--;
    let r = x;
    while (r < w - 1 && !differs(r + 1, y)) r++;
    let t = y;
    while (t > 0 && !differs(x, t - 1)) t--;
    let b = y;
    while (b < h - 1 && !differs(x, b + 1)) b++;
    return { l, r, t, b };
  }

  // Shrinks a dragged box (screen pixels, end-exclusive) to the content inside it.
  function snapBox(shot, x0, y0, x1, y1) {
    const bg = rgbAt(shot, x0, y0);
    const same = (x, y) => {
      const c = rgbAt(shot, x, y);
      return Math.abs(c[0] - bg[0]) <= TOLERANCE && Math.abs(c[1] - bg[1]) <= TOLERANCE && Math.abs(c[2] - bg[2]) <= TOLERANCE;
    };
    const row = (y, a, b) => { for (let x = a; x < b; x++) if (!same(x, y)) return false; return true; };
    const col = (x, a, b) => { for (let y = a; y < b; y++) if (!same(x, y)) return false; return true; };
    let [X0, Y0, X1, Y1] = [x0, y0, x1, y1];
    while (Y0 < Y1 && row(Y0, X0, X1)) Y0++;
    while (Y1 > Y0 && row(Y1 - 1, X0, X1)) Y1--;
    while (X0 < X1 && col(X0, Y0, Y1)) X0++;
    while (X1 > X0 && col(X1 - 1, Y0, Y1)) X1--;
    return X1 > X0 && Y1 > Y0 ? [X0, Y0, X1, Y1] : [x0, y0, x1, y1];
  }

  const fmt = (v) => String(Math.round(v * 10) / 10);

  function describe(el) {
    let s = el.localName;
    if (el.id) s += `#${el.id}`;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean)[0] : '';
    if (cls) s += `.${cls}`;
    return s.length > 40 ? `${s.slice(0, 39)}…` : s;
  }

  function measurer() {
    const ov = overlay(MEASURE_CSS,
      '<div class="lh" hidden></div><div class="lv" hidden></div><div class="tag" id="t" hidden></div>'
      + '<div class="box" hidden></div><div class="tag" id="bt" hidden></div>'
      + '<div class="el" hidden></div><div class="tag blue" id="et" hidden></div>',
      'Move to measure · drag to measure a box · hold <b>Shift</b> for elements · <b>Esc</b> to exit');
    const lh = ov.$('.lh');
    const lv = ov.$('.lv');
    const tag = ov.$('#t');
    const boxEl = ov.$('.box');
    const boxTag = ov.$('#bt');
    const elBox = ov.$('.el');
    const elTag = ov.$('#et');
    let drag = null; // CSS px start point while dragging
    let box = null; // CSS px rect of the finished (snapped) box
    let shift = false;

    const place = (el, x, y) => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      el.style.left = `${clamp(x, 4, innerWidth - w - 4)}px`;
      el.style.top = `${clamp(y, 4, innerHeight - h - 4)}px`;
    };
    const showRect = (el, r) => Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });

    ov.draw = () => {
      const p = ov.pointer;
      const ready = p && ov.shot && !ov.stale;

      // Box being dragged, or the last measured box.
      const live = drag && p ? {
        x: Math.min(drag.x, p.x), y: Math.min(drag.y, p.y), w: Math.abs(p.x - drag.x), h: Math.abs(p.y - drag.y),
      } : null;
      const r = live || box;
      boxEl.hidden = boxTag.hidden = !r;
      if (r) {
        showRect(boxEl, r);
        boxTag.hidden = false;
        boxTag.textContent = `${fmt(r.w)} × ${fmt(r.h)}`;
        place(boxTag, r.x, r.y + r.h + 6 > innerHeight - 30 ? r.y - 26 : r.y + r.h + 6);
      }

      // Hold Shift: size of the element under the cursor.
      const el = shift && p ? document.elementsFromPoint(p.x, p.y).find((n) => n !== ov.host) : null;
      elBox.hidden = elTag.hidden = !el;
      if (el) {
        const rc = el.getBoundingClientRect();
        showRect(elBox, { x: rc.left, y: rc.top, w: rc.width, h: rc.height });
        elTag.textContent = `${describe(el)}  ${fmt(rc.width)} × ${fmt(rc.height)}`;
        place(elTag, rc.left, rc.top - 26 < 4 ? rc.bottom + 6 : rc.top - 26);
      }

      // Crosshair to the nearest edges.
      const lines = ready && !drag && !el;
      lh.hidden = lv.hidden = tag.hidden = !lines;
      if (!lines) return;
      const s = ov.shot;
      const d = devicePoint(s, p);
      const e = edgesAt(s, d.x, d.y);
      const k = 1 / s.scale;
      Object.assign(lh.style, { left: `${e.l * k}px`, top: `${d.y * k}px`, width: `${(e.r + 1 - e.l) * k}px` });
      Object.assign(lv.style, { left: `${d.x * k}px`, top: `${e.t * k}px`, height: `${(e.b + 1 - e.t) * k}px` });
      tag.textContent = `${Math.round((e.r + 1 - e.l) * k)} × ${Math.round((e.b + 1 - e.t) * k)}`;
      place(tag, p.x + 14, p.y + 14);
    };

    ov.onStale = () => { box = null; };
    ov.onMove = (e) => {
      shift = e.shiftKey;
    };
    ov.on(ov.layer, 'pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      ov.layer.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY };
      box = null;
      ov.redraw();
    });
    ov.on(ov.layer, 'pointerup', (e) => {
      if (!drag) return;
      const x0 = Math.min(drag.x, e.clientX);
      const y0 = Math.min(drag.y, e.clientY);
      const w = Math.abs(e.clientX - drag.x);
      const h = Math.abs(e.clientY - drag.y);
      drag = null;
      if ((w < 3 && h < 3) || !ov.shot || ov.stale) {
        box = null;
      } else {
        const s = ov.shot;
        const [X0, Y0, X1, Y1] = snapBox(s,
          clamp(Math.floor(x0 * s.scale), 0, s.w - 1), clamp(Math.floor(y0 * s.scale), 0, s.h - 1),
          clamp(Math.ceil((x0 + w) * s.scale), 1, s.w), clamp(Math.ceil((y0 + h) * s.scale), 1, s.h));
        box = { x: X0 / s.scale, y: Y0 / s.scale, w: (X1 - X0) / s.scale, h: (Y1 - Y0) / s.scale };
      }
      ov.redraw();
    });
    const onShift = (e) => {
      if (e.key !== 'Shift' || shift === (e.type === 'keydown')) return;
      shift = e.type === 'keydown';
      ov.redraw();
    };
    ov.onKey = onShift;
    ov.on(window, 'keyup', onShift, true);
    return ov;
  }

  // ---------------------------------------------------------------- messages

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'tss:tool') {
      tools.active?.exit();
      tools.active = msg.tool === 'color' ? colorPicker(msg.settings || {}) : measurer();
      sendResponse({ ok: true });
    } else if (msg?.type === 'tss:tool-exit') {
      tools.active?.exit();
      sendResponse({ ok: true });
    }
  });
})();
