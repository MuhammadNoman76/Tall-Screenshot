import { getSession, getFrames } from '../db.js';
import { loadSettings, saveSettings } from '../settings.js';

// Chrome refuses canvases beyond 32,767 px per side or ~268M px in area; stay
// under both (and leave memory headroom) by scaling only when we must.
const MAX_SIDE = 32000;
const MAX_AREA = 160_000_000;
const ZOOMS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const state = {
  session: null,
  frames: [],
  captureScale: 1, // image px per page CSS px at full quality
  regions: [], // undo stack; each region is in page CSS px relative to the capture
  canvas: null,
  scale: 1, // image px per page CSS px of the current canvas
  zoom: 'fit',
  crop: null, // { x, y, w, h } in image px while cropping
  encoded: new Map(), // format -> Promise<Blob> for the current canvas
};

init().catch((e) => fail(`Couldn't open this screenshot: ${e.message}`));

// ------------------------------------------------------------------ loading

async function init() {
  const sid = new URLSearchParams(location.search).get('s');
  const [settings, session, frames] = await Promise.all([
    loadSettings(),
    sid ? getSession(sid) : null,
    sid ? getFrames(sid) : [],
  ]);
  $('format').value = settings.format;
  if (!session || session.status !== 'ready' || !frames.length) {
    fail('This screenshot is no longer available. The 5 most recent captures are kept.');
    return;
  }

  await Promise.all(frames.map(async (f) => {
    const dv = new DataView(await f.blob.slice(16, 24).arrayBuffer()); // PNG IHDR width/height
    f.imgW = dv.getUint32(0);
    f.imgH = dv.getUint32(4);
    f.fs = frameScale(f);
  }));
  state.session = session;
  state.frames = frames;
  state.captureScale = Math.max(...frames.map((f) => f.fs));

  document.title = `${session.title || 'Screenshot'} · Tall Screenshot`;
  $('title').textContent = session.title || hostOf(session.url) || 'Screenshot';
  $('title').title = session.url || '';
  for (const id of ['cropBtn', 'copyBtn', 'saveBtn']) $(id).disabled = false;

  await show({ x: 0, y: 0, w: session.w, h: session.h });
  $('status').hidden = true;
  $('wrap').hidden = false;
  applyZoom();
}

// Device pixels per CSS pixel of a frame. The capture may or may not include the
// page scrollbar, so match the image width against both viewport widths.
function frameScale({ imgW, vp }) {
  if (Math.abs(imgW - vp.iw * vp.dpr) <= 2) return imgW / vp.iw;
  if (Math.abs(imgW - vp.cw * vp.dpr) <= 2) return imgW / vp.cw;
  return imgW / vp.iw;
}

function fitScale(w, h, preferred) {
  return Math.min(preferred, MAX_SIDE / w, MAX_SIDE / h, Math.sqrt(MAX_AREA / (w * h)));
}

// Stitches `region` from the stored frames at the best scale the browser allows.
async function render(region) {
  const scale = fitScale(region.w, region.h, state.captureScale);
  const W = Math.max(1, Math.round(region.w * scale));
  const H = Math.max(1, Math.round(region.h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('The image is too large for this browser.');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingQuality = 'high';

  const jobs = [];
  for (const f of state.frames) {
    const x0 = Math.max(region.x, f.dest.x);
    const x1 = Math.min(region.x + region.w, f.dest.x + f.crop.w);
    const y0 = Math.max(region.y, f.dest.y);
    const y1 = Math.min(region.y + region.h, f.dest.y + f.crop.h);
    if (x1 - x0 <= 0 || y1 - y0 <= 0) continue;
    // Source rect in the frame's device pixels; destination edges are rounded the
    // same way for neighbouring frames, so strips meet without seams.
    const sx0 = clamp(Math.round((f.crop.x + x0 - f.dest.x) * f.fs), 0, f.imgW);
    const sx1 = clamp(Math.round((f.crop.x + x1 - f.dest.x) * f.fs), 0, f.imgW);
    const sy0 = clamp(Math.round((f.crop.y + y0 - f.dest.y) * f.fs), 0, f.imgH);
    const sy1 = clamp(Math.round((f.crop.y + y1 - f.dest.y) * f.fs), 0, f.imgH);
    const dx0 = Math.round((x0 - region.x) * scale);
    const dx1 = Math.round((x1 - region.x) * scale);
    const dy0 = Math.round((y0 - region.y) * scale);
    const dy1 = Math.round((y1 - region.y) * scale);
    if (sx1 <= sx0 || sy1 <= sy0 || dx1 <= dx0 || dy1 <= dy0) continue;
    jobs.push(async () => {
      const bmp = await createImageBitmap(f.blob, sx0, sy0, sx1 - sx0, sy1 - sy0);
      ctx.drawImage(bmp, dx0, dy0, dx1 - dx0, dy1 - dy0);
      bmp.close();
    });
  }
  // A few decodes in parallel is fastest without ballooning memory on huge pages.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, async () => {
    while (next < jobs.length) await jobs[next++]();
  }));
  return { canvas, scale };
}

async function show(region, { push = true } = {}) {
  const { canvas, scale } = await render(region);
  if (push) state.regions.push(region);
  const old = state.canvas;
  if (old) {
    old.remove();
    old.width = old.height = 0; // release the pixel buffer right away
  }
  state.canvas = canvas;
  state.scale = scale;
  state.encoded.clear();
  $('wrap').prepend(canvas);
  $('undoBtn').disabled = state.regions.length < 2;
  $('sub').textContent = `${canvas.width.toLocaleString()} × ${canvas.height.toLocaleString()} px · ${hostOf(state.session.url)}`;
  const notes = [];
  if (state.session.note) notes.push(state.session.note);
  if (scale < state.captureScale - 1e-3) {
    notes.push(`This capture is taller than the browser's image size limit, so it's saved at ${Math.round((scale / state.captureScale) * 100)}% resolution. Crop to a smaller area to get full resolution back.`);
  }
  $('notice').textContent = notes.join(' ');
  $('notice').hidden = !notes.length;
  applyZoom();
}

async function withBusy(text, fn) {
  const status = $('status');
  $('statusText').textContent = text;
  status.classList.add('overlay');
  status.hidden = false;
  try {
    return await fn();
  } finally {
    status.hidden = true;
  }
}

function fail(message) {
  $('status').innerHTML = '';
  $('status').classList.remove('overlay');
  $('status').hidden = false;
  $('status').append(Object.assign(document.createElement('p'), { textContent: message }));
  $('title').textContent = 'Tall Screenshot';
}

// --------------------------------------------------------------------- zoom

const region = () => state.regions.at(-1);
const fitZoom = () => Math.min(1, Math.max(0.05, ($('stage').clientWidth - 48) / region().w));
const effectiveZoom = () => (state.zoom === 'fit' ? fitZoom() : state.zoom);

function applyZoom() {
  if (!state.canvas || !region()) return;
  const z = effectiveZoom();
  const wrap = $('wrap');
  wrap.style.width = `${region().w * z}px`;
  wrap.style.height = `${region().h * z}px`;
  $('zoomLabel').textContent = state.zoom === 'fit' ? `Fit · ${Math.round(z * 100)}%` : `${Math.round(z * 100)}%`;
  if (state.crop) drawCrop();
}

function setZoom(zoom) {
  const stage = $('stage');
  const ratio = stage.scrollTop / Math.max(1, stage.scrollHeight - stage.clientHeight);
  state.zoom = zoom;
  applyZoom();
  stage.scrollTop = ratio * (stage.scrollHeight - stage.clientHeight);
}

function zoomStep(dir) {
  const z = effectiveZoom();
  const next = dir > 0 ? ZOOMS.find((v) => v > z + 1e-3) : [...ZOOMS].reverse().find((v) => v < z - 1e-3);
  if (next) setZoom(next);
}

$('zoomIn').addEventListener('click', () => zoomStep(1));
$('zoomOut').addEventListener('click', () => zoomStep(-1));
$('zoomLabel').addEventListener('click', () => setZoom(state.zoom === 'fit' ? 1 : 'fit'));
$('stage').addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  zoomStep(e.deltaY < 0 ? 1 : -1);
}, { passive: false });
addEventListener('resize', () => { if (state.zoom === 'fit') applyZoom(); });

// --------------------------------------------------------------------- crop

let drag = null;
let scrollRaf = 0;

function startCrop() {
  if (state.crop || !state.canvas) return;
  state.crop = { x: 0, y: 0, w: state.canvas.width, h: state.canvas.height };
  $('croplayer').hidden = false;
  $('cropbar').hidden = false;
  $('cropBtn').classList.add('active');
  $('wrap').classList.add('cropping');
  drawCrop();
  applyZoom();
}

function endCrop() {
  state.crop = null;
  drag = null;
  $('croplayer').hidden = true;
  $('cropbar').hidden = true;
  $('cropBtn').classList.remove('active');
  $('wrap').classList.remove('cropping');
  applyZoom();
}

async function applyCrop() {
  if (!state.crop) return;
  readInputs();
  const c = state.crop;
  const { width: W, height: H } = state.canvas;
  if (c.w < 1 || c.h < 1) return;
  endCrop();
  if (c.x === 0 && c.y === 0 && c.w === W && c.h === H) return;
  const r = region();
  const s = state.scale;
  try {
    await withBusy('Cropping…', () => show({ x: r.x + c.x / s, y: r.y + c.y / s, w: c.w / s, h: c.h / s }));
  } catch (e) {
    toast(`Couldn't crop: ${e.message}`, true);
    return;
  }
  $('stage').scrollTop = 0;
  toast(`Cropped to ${state.canvas.width.toLocaleString()} × ${state.canvas.height.toLocaleString()} px`);
}

async function undo() {
  if (state.regions.length < 2) return;
  if (state.crop) endCrop();
  const dropped = state.regions.pop();
  try {
    await withBusy('Restoring…', () => show(region(), { push: false }));
  } catch (e) {
    state.regions.push(dropped);
    toast(`Couldn't undo: ${e.message}`, true);
  }
}

function drawCrop() {
  const { x, y, w, h } = state.crop;
  const k = parseFloat($('wrap').style.width) / state.canvas.width;
  const px = (v) => `${v * k}px`;
  Object.assign($('cropbox').style, { left: px(x), top: px(y), width: px(w), height: px(h) });
  Object.assign($('shadeT').style, { left: 0, right: 0, top: 0, height: px(y) });
  Object.assign($('shadeB').style, { left: 0, right: 0, top: px(y + h), bottom: 0 });
  Object.assign($('shadeL').style, { left: 0, top: px(y), width: px(x), height: px(h) });
  Object.assign($('shadeR').style, { left: px(x + w), right: 0, top: px(y), height: px(h) });
  $('dims').textContent = `${w.toLocaleString()} × ${h.toLocaleString()}`;
  $('cropbox').classList.toggle('full', isFullCrop());
  for (const [id, v] of [['cx', x], ['cy', y], ['cw', w], ['ch', h]]) {
    if (document.activeElement !== $(id)) $(id).value = v;
  }
}

function isFullCrop() {
  const c = state.crop;
  return c.x === 0 && c.y === 0 && c.w === state.canvas.width && c.h === state.canvas.height;
}

function readInputs() {
  if (!state.crop) return;
  const { width: W, height: H } = state.canvas;
  const num = (id, fallback) => {
    const n = Math.round(Number($(id).value));
    return Number.isFinite(n) ? n : fallback;
  };
  const x = clamp(num('cx', state.crop.x), 0, W - 1);
  const y = clamp(num('cy', state.crop.y), 0, H - 1);
  const w = clamp(num('cw', state.crop.w), 1, W - x);
  const h = clamp(num('ch', state.crop.h), 1, H - y);
  state.crop = { x, y, w, h };
  drawCrop();
  for (const [id, v] of [['cx', x], ['cy', y], ['cw', w], ['ch', h]]) $(id).value = v;
}

for (const id of ['cx', 'cy', 'cw', 'ch']) {
  $(id).addEventListener('change', readInputs);
}

function imagePoint(clientX, clientY) {
  const r = state.canvas.getBoundingClientRect();
  const k = r.width / state.canvas.width;
  return {
    x: clamp((clientX - r.left) / k, 0, state.canvas.width),
    y: clamp((clientY - r.top) / k, 0, state.canvas.height),
  };
}

function updateDrag() {
  const p = imagePoint(drag.pointer.x, drag.pointer.y);
  const { width: W, height: H } = state.canvas;
  const o = drag.orig;
  let x0 = o.x;
  let y0 = o.y;
  let x1 = o.x + o.w;
  let y1 = o.y + o.h;
  if (drag.handle === 'move') {
    x0 = clamp(o.x + p.x - drag.start.x, 0, W - o.w);
    y0 = clamp(o.y + p.y - drag.start.y, 0, H - o.h);
    x1 = x0 + o.w;
    y1 = y0 + o.h;
  } else if (drag.handle === 'new') {
    x0 = Math.min(drag.start.x, p.x);
    x1 = Math.max(drag.start.x, p.x);
    y0 = Math.min(drag.start.y, p.y);
    y1 = Math.max(drag.start.y, p.y);
  } else {
    if (drag.handle.includes('w')) x0 = Math.min(p.x, x1 - 1);
    if (drag.handle.includes('e')) x1 = Math.max(p.x, x0 + 1);
    if (drag.handle.includes('n')) y0 = Math.min(p.y, y1 - 1);
    if (drag.handle.includes('s')) y1 = Math.max(p.y, y0 + 1);
  }
  const X0 = Math.round(x0);
  const Y0 = Math.round(y0);
  state.crop = { x: X0, y: Y0, w: Math.max(1, Math.round(x1) - X0), h: Math.max(1, Math.round(y1) - Y0) };
  drawCrop();
}

// While dragging near the top/bottom of the view, keep scrolling so tall crops are easy.
function autoScroll() {
  if (scrollRaf) return;
  const step = () => {
    scrollRaf = 0;
    if (!drag) return;
    const stage = $('stage');
    const r = stage.getBoundingClientRect();
    const y = drag.pointer.y;
    const edge = 48;
    const d = y > r.bottom - edge ? y - (r.bottom - edge) : y < r.top + edge ? y - (r.top + edge) : 0;
    if (!d) return;
    const before = stage.scrollTop;
    stage.scrollTop += Math.sign(d) * Math.min(60, 4 + Math.abs(d) * 0.7);
    if (stage.scrollTop === before) return;
    updateDrag();
    scrollRaf = requestAnimationFrame(step);
  };
  scrollRaf = requestAnimationFrame(step);
}

$('wrap').addEventListener('pointerdown', (e) => {
  if (!state.crop || e.button !== 0) return;
  e.preventDefault();
  let handle = e.target.closest('[data-h]')?.dataset.h || 'new';
  // Until something is selected the box covers the whole image, so dragging draws a new one.
  if (handle === 'move' && isFullCrop()) handle = 'new';
  drag = {
    handle,
    start: imagePoint(e.clientX, e.clientY),
    orig: { ...state.crop },
    pointer: { x: e.clientX, y: e.clientY },
  };
  $('wrap').setPointerCapture(e.pointerId);
});
$('wrap').addEventListener('pointermove', (e) => {
  if (!drag) return;
  drag.pointer = { x: e.clientX, y: e.clientY };
  updateDrag();
  autoScroll();
});
const endDrag = () => {
  if (!drag) return;
  // A click without a drag shouldn't throw away the current box.
  if (drag.handle === 'new' && (state.crop.w < 4 || state.crop.h < 4)) {
    state.crop = drag.orig;
    drawCrop();
  }
  drag = null;
};
$('wrap').addEventListener('pointerup', endDrag);
$('wrap').addEventListener('pointercancel', endDrag);

$('cropBtn').addEventListener('click', () => (state.crop ? endCrop() : startCrop()));
$('cropApply').addEventListener('click', applyCrop);
$('cropCancel').addEventListener('click', endCrop);
$('undoBtn').addEventListener('click', undo);

// ------------------------------------------------------------------- export

function encode(format) {
  if (!state.encoded.has(format)) {
    const canvas = state.canvas;
    const blob = new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('the image is too large to encode'))),
        MIME[format],
        format === 'png' ? undefined : 0.92,
      );
    });
    blob.catch(() => state.encoded.delete(format));
    state.encoded.set(format, blob);
  }
  return state.encoded.get(format);
}

async function download() {
  if (!state.canvas) return;
  const format = $('format').value;
  try {
    const blob = await withBusy('Preparing download…', () => encode(format));
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: fileName(format) });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    toast(`Downloaded · ${formatBytes(blob.size)}`);
  } catch (e) {
    toast(`Couldn't save: ${e.message}`, true);
  }
}

async function copy() {
  if (!state.canvas) return;
  try {
    // Hand the clipboard a promise so the click still counts as a user gesture.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': encode('png') })]);
    toast('Copied to clipboard');
  } catch (e) {
    toast(`Couldn't copy: ${e.message}`, true);
  }
}

function fileName(format) {
  const d = new Date(state.session.created);
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} at ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
  const base = (state.session.title || hostOf(state.session.url) || 'Screenshot')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, '');
  return `${base || 'Screenshot'} ${stamp}.${format === 'jpeg' ? 'jpg' : format}`;
}

$('saveBtn').addEventListener('click', download);
$('copyBtn').addEventListener('click', copy);
$('format').addEventListener('change', (e) => saveSettings({ format: e.target.value }));

// ---------------------------------------------------------------- keyboard

document.addEventListener('keydown', (e) => {
  const typing = e.target.matches?.('input, select, textarea');
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Enter' && state.crop) {
    e.preventDefault();
    applyCrop();
  } else if (e.key === 'Escape' && state.crop) {
    e.preventDefault();
    endCrop();
  } else if (typing) {
    // leave other keys to the field
  } else if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    download();
  } else if (mod && e.key.toLowerCase() === 'c' && !getSelection().toString()) {
    e.preventDefault();
    copy();
  } else if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undo();
  } else if (mod) {
    // leave browser shortcuts alone
  } else if (e.key.toLowerCase() === 'c') {
    state.crop ? endCrop() : startCrop();
  } else if (e.key === '+' || e.key === '=') {
    zoomStep(1);
  } else if (e.key === '-') {
    zoomStep(-1);
  } else if (e.key === '0') {
    setZoom('fit');
  } else if (e.key === '1') {
    setZoom(1);
  }
});

// ------------------------------------------------------------------ helpers

let toastTimer = 0;
function toast(text, isError = false) {
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), isError ? 5000 : 2200);
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function formatBytes(n) {
  return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}
