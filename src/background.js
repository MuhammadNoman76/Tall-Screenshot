import { putFrame, putSession, deleteSession, prune } from './db.js';
import { loadSettings } from './settings.js';

const POPUP = 'src/popup/popup.html';
const TITLE = 'Tall Screenshot';
const BRAND = '#7C3AED';
const CAPTURE_GAP = 510; // Chrome allows 2 captureVisibleTab calls per second
const MODES = {
  'capture-full': 'full',
  'capture-select': 'select',
  'capture-visible': 'visible',
  'pick-color': 'color',
  measure: 'measure',
};
const TOOLS = new Set(['color', 'measure']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCapture = 0;
const writes = new Map(); // sid -> promise of that capture's pending frame writes
const capturing = new Set(); // tab ids with a capture (or selection) in progress

// ------------------------------------------------------------- entry points

chrome.runtime.onInstalled.addListener(() => {
  const ignore = () => void chrome.runtime.lastError;
  chrome.contextMenus.removeAll(() => {
    ignore();
    const contexts = ['page', 'frame', 'selection', 'link', 'image', 'video', 'editable'];
    chrome.contextMenus.create({ id: 'tss', title: TITLE, contexts }, ignore);
    const items = [
      ['full', 'Capture full page'],
      ['select', 'Select area…'],
      ['visible', 'Capture visible area'],
      ['sep', null],
      ['color', 'Pick a color'],
      ['measure', 'Measure'],
    ];
    for (const [mode, title] of items) {
      chrome.contextMenus.create(title
        ? { id: `tss:${mode}`, parentId: 'tss', title, contexts }
        : { id: `tss:${mode}`, parentId: 'tss', type: 'separator', contexts }, ignore);
    }
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const mode = String(info.menuItemId).split(':')[1];
  if (mode && mode !== 'sep') start(tab, mode, {}, 'menu').catch((e) => flagError(tab?.id, e.message));
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  const mode = MODES[command];
  if (!mode) return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  start(tab, mode, {}, 'shortcut').catch((e) => flagError(tab?.id, e.message));
});

// The popup is switched off while capturing, so a toolbar click means "stop".
chrome.action.onClicked.addListener(async (tab) => {
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'tss:stop' });
    if (res?.busy) return;
  } catch {
    // Content script is gone (page navigated); fall through and restore the popup.
  }
  await endCapture(tab.id);
  chrome.action.openPopup?.().catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && capturing.has(tabId)) endCapture(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => capturing.delete(tabId));

// ----------------------------------------------------------------- messages

const handlers = {
  async 'tss:start'(msg) {
    return start(await chrome.tabs.get(msg.tabId), msg.mode, msg.opts || {}, 'popup');
  },

  // The color picker and ruler read pixels from a fresh screenshot of the viewport.
  async 'tss:shot'(msg, sender) {
    if (!(await chrome.tabs.get(sender.tab.id)).active) throw new Error('Switch back to this tab to keep using the tool.');
    return { ok: true, dataUrl: await captureVisible(sender.tab.windowId) };
  },

  async 'tss:grab'(msg, sender) {
    const tab = sender.tab;
    if (!(await chrome.tabs.get(tab.id)).active) throw new Error('Capture stopped because the tab was switched.');
    const dataUrl = await captureVisible(tab.windowId);

    // Store in the background so the page can scroll on immediately.
    const { sid, i, crop, dest, vp } = msg;
    const write = (writes.get(sid) || Promise.resolve()).then(async () => {
      const blob = await (await fetch(dataUrl)).blob();
      await putFrame({ sid, i, blob, crop, dest, vp });
    });
    write.catch(() => {});
    writes.set(sid, write);

    if (msg.progress) {
      const pct = Math.min(99, Math.floor((msg.progress.done / Math.max(1, msg.progress.total)) * 100));
      chrome.action.setBadgeText({ tabId: tab.id, text: `${pct}%` }).catch(() => {});
    }
    return { ok: true };
  },

  async 'tss:done'(msg, sender) {
    const tab = sender.tab;
    try {
      await writes.get(msg.sid);
      writes.delete(msg.sid);
      await putSession({
        sid: msg.sid,
        status: 'ready',
        created: Date.now(),
        w: msg.w,
        h: msg.h,
        frames: msg.frames,
        title: msg.title,
        url: msg.url,
        note: msg.note,
      });
    } catch (e) {
      await endCapture(tab.id, msg.sid);
      flagError(tab.id, `Couldn't save the screenshot: ${e.message}`);
      throw e;
    }
    await endCapture(tab.id);
    await openEditor(tab, msg.sid);
  },

  async 'tss:cancelled'(msg, sender) {
    await endCapture(sender.tab.id, msg.sid);
  },

  async 'tss:error'(msg, sender) {
    await endCapture(sender.tab.id, msg.sid);
    flagError(sender.tab.id, msg.error);
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler || (msg.type !== 'tss:start' && !sender.tab)) return false;
  handler(msg, sender).then(
    (res) => sendResponse(res ?? { ok: true }),
    (err) => sendResponse({ ok: false, error: err?.message || String(err) }),
  );
  return true;
});

// ------------------------------------------------------------------ capture

async function start(tab, mode, opts, source) {
  if (!tab?.id) throw new Error('No tab to capture.');
  if (capturing.has(tab.id)) {
    // Pressing a shortcut again mid-capture stops it.
    await chrome.tabs.sendMessage(tab.id, { type: 'tss:stop' }).catch(() => {});
    return { ok: true, stopped: true };
  }
  if (TOOLS.has(mode)) return startTool(tab, mode);

  const settings = await loadSettings();
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content.js'] });
  } catch (e) {
    // Chrome won't let extensions script some pages (the Web Store, chrome:// pages,
    // data: URLs), but usually still allows a plain screenshot of what's on screen.
    return captureVisibleOnly(tab, mode, e);
  }
  // An open color picker or ruler would end up in the screenshot.
  await chrome.tabs.sendMessage(tab.id, { type: 'tss:tool-exit' }).catch(() => {});

  const sid = crypto.randomUUID();
  await putSession({ sid, status: 'capturing', created: Date.now() });
  prune().catch(() => {});

  capturing.add(tab.id);
  if (mode !== 'visible') await showBusy(tab.id, mode);

  let res;
  try {
    res = await chrome.tabs.sendMessage(tab.id, {
      type: 'tss:run',
      sid,
      mode,
      opts,
      settings,
      // When started from the popup, the popup itself shows progress and the Stop button.
      hud: source !== 'popup' && (mode === 'full' || mode === 'custom'),
    });
  } catch (e) {
    res = { ok: false, error: e.message };
  }
  if (!res?.ok) {
    await endCapture(tab.id, sid);
    throw new Error(res?.error || 'Could not start the capture.');
  }
  return { ok: true, sid };
}

// Screenshot without any script in the page: no scrolling, just what's on screen.
async function captureVisibleOnly(tab, mode, injectFailure) {
  let dataUrl;
  try {
    dataUrl = await captureVisible(tab.windowId);
  } catch {
    throw new Error(injectError(tab.url, injectFailure));
  }
  const blob = await (await fetch(dataUrl)).blob();
  const dv = new DataView(await blob.slice(16, 24).arrayBuffer()); // PNG IHDR width/height
  const imgW = dv.getUint32(0);
  const imgH = dv.getUint32(4);
  // The tab's size is in CSS pixels, which recovers the display scale (125%, 150%…).
  const w = tab.width || imgW;
  const h = imgH * (w / imgW);
  const vp = { iw: w, ih: h, cw: w, ch: h, dpr: imgW / w };
  const sid = crypto.randomUUID();
  await putFrame({ sid, i: 0, blob, crop: { x: 0, y: 0, w, h }, dest: { x: 0, y: 0 }, vp });
  await putSession({
    sid,
    status: 'ready',
    created: Date.now(),
    w,
    h,
    frames: 1,
    title: tab.title,
    url: tab.url,
    note: mode === 'visible' ? undefined : "Chrome doesn't let extensions scroll this page, so only the visible part was captured. You can crop it here.",
  });
  prune().catch(() => {});
  await openEditor(tab, sid);
  return { ok: true, sid, visibleOnly: true };
}

function openEditor(tab, sid) {
  return chrome.tabs.create({
    url: chrome.runtime.getURL(`src/editor/editor.html?s=${sid}`),
    index: tab.index + 1,
    openerTabId: tab.id,
  });
}

async function startTool(tab, tool) {
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/color.js', 'src/inspect.js'] });
  } catch (e) {
    throw new Error(injectError(tab.url, e, true));
  }
  const settings = await loadSettings();
  const res = await chrome.tabs.sendMessage(tab.id, { type: 'tss:tool', tool, settings }).catch((e) => ({ error: e.message }));
  if (!res?.ok) throw new Error(res?.error || 'Could not start the tool.');
  return { ok: true };
}

async function captureVisible(windowId) {
  for (let attempt = 0; ; attempt++) {
    const wait = lastCapture + CAPTURE_GAP - Date.now();
    if (wait > 0) await sleep(wait);
    lastCapture = Date.now();
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (e) {
      if (attempt < 5 && /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(e?.message || '')) continue;
      throw e;
    }
  }
}

async function endCapture(tabId, discardSid) {
  capturing.delete(tabId);
  await Promise.all([
    chrome.action.setPopup({ tabId, popup: POPUP }),
    chrome.action.setTitle({ tabId, title: TITLE }),
    chrome.action.setBadgeText({ tabId, text: '' }),
  ]).catch(() => {});
  if (discardSid) {
    await writes.get(discardSid)?.catch(() => {});
    writes.delete(discardSid);
    await deleteSession(discardSid).catch(() => {});
  }
}

async function showBusy(tabId, mode) {
  await Promise.all([
    chrome.action.setPopup({ tabId, popup: '' }),
    chrome.action.setTitle({ tabId, title: mode === 'select' ? `${TITLE} – click to cancel selection` : `${TITLE} – click to stop and open the editor` }),
    chrome.action.setBadgeBackgroundColor({ tabId, color: BRAND }),
    chrome.action.setBadgeText({ tabId, text: mode === 'select' ? '…' : '0%' }),
  ]).catch(() => {});
}

function flagError(tabId, message) {
  if (!tabId) return;
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#DC2626' }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: '!' }).catch(() => {});
  chrome.action.setTitle({ tabId, title: `${TITLE} – ${message}` }).catch(() => {});
  setTimeout(() => {
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
    chrome.action.setTitle({ tabId, title: TITLE }).catch(() => {});
  }, 8000);
}

function injectError(url = '', err, tool = false) {
  if (/^file:/i.test(url)) {
    return 'To use Tall Screenshot on files from your computer, turn on "Allow access to file URLs" for it in chrome://extensions.';
  }
  if (tool) {
    return "Chrome protects this page, so extensions can't draw on it and the color picker and ruler can't run here. A visible-area screenshot still works.";
  }
  if (/cannot access|cannot be scripted|chrome:\/\/ url/i.test(err?.message || '')) {
    return "Chrome doesn't let extensions capture this kind of page (for example view-source: pages and blank tabs).";
  }
  return `This page can't be captured: ${err?.message || err}`;
}
