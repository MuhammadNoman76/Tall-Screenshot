import { loadSettings, saveSettings } from '../settings.js';

const $ = (id) => document.getElementById(id);
let tab = null;
let live = false;

init().catch((e) => showError(e.message));

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const [settings, commands] = await Promise.all([loadSettings(), chrome.commands.getAll()]);

  $('customValue').value = settings.customValue;
  $('customUnit').value = settings.customUnit;
  $('customFrom').value = settings.customFrom;
  $('hideFixed').checked = settings.hideFixed;
  $('colorFormat').value = settings.colorFormat;
  renderHistory(settings.colorFormat);
  $('maxHeight').value = settings.maxHeight;
  $('delay').value = settings.delay;

  for (const kbd of document.querySelectorAll('kbd[data-cmd]')) {
    const shortcut = commands.find((c) => c.name === kbd.dataset.cmd)?.shortcut;
    kbd.textContent = shortcut || '';
    kbd.hidden = !shortcut;
  }

  if (tab) await showPageAccess(tab);
}

// Chrome protects some pages from extensions. Say what still works there.
async function showPageAccess(tab) {
  const url = tab.url || ''; // Chrome hides the URL of its own pages from extensions
  let text = '';
  let keep = null; // selector of buttons that stay enabled; null = all
  if (/^file:/i.test(url) && !(await chrome.extension.isAllowedFileSchemeAccess())) {
    text = 'To use Tall Screenshot on files from your computer, turn on "Allow access to file URLs" in its settings.';
    $('fixAccess').hidden = false;
  } else if (/^(view-source|about|devtools):/i.test(url)) {
    text = "Chrome doesn't let extensions capture this kind of page.";
    keep = ':not(*)'; // nothing
  } else if (!(await canRunOn(tab.id))) {
    text = "Chrome protects this page (the Web Store and browser pages), so no extension can scroll it or draw on it. You can still capture what's on screen with Visible area.";
    keep = '[data-mode="visible"]';
  }
  if (!text) return;
  $('blockedText').textContent = text;
  $('blocked').hidden = false;
  if (keep) {
    for (const b of document.querySelectorAll('.action, .tool, #customGo')) b.disabled = !b.matches(keep);
  }
}

// Asking Chrome directly is the only reliable test: protected pages vary by version.
async function canRunOn(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: () => true });
    return true;
  } catch {
    return false;
  }
}

$('fixAccess').addEventListener('click', () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }));

// ---------------------------------------------------------------- capture

for (const button of document.querySelectorAll('.action, .tool')) {
  button.addEventListener('click', () => start(button.dataset.mode));
}

$('customGo').addEventListener('click', () => {
  const value = parseFloat($('customValue').value);
  if (!(value > 0)) {
    showError('Enter a length greater than 0.');
    $('customValue').focus();
    return;
  }
  const opts = { value, unit: $('customUnit').value, from: $('customFrom').value };
  saveSettings({ customValue: value, customUnit: opts.unit, customFrom: opts.from });
  start('custom', opts);
});
$('customValue').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('customGo').click();
});

async function start(mode, opts = {}) {
  $('error').hidden = true;
  const showsProgress = mode === 'full' || mode === 'custom';
  if (showsProgress) showProgress(mode, opts);
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'tss:start', tabId: tab.id, mode, opts });
  } catch (e) {
    res = { ok: false, error: e.message };
  }
  if (!res?.ok) {
    hideProgress();
    showError(res?.error || 'Could not start the capture.');
    return;
  }
  // Selecting and the tools happen on the page itself; visible captures finish instantly.
  if (!showsProgress) window.close();
}

// Progress arrives straight from the content script's messages to the service worker.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!live || !tab || sender.tab?.id !== tab.id) return;
  if (msg.type === 'tss:grab' && msg.progress) {
    const { done, total } = msg.progress;
    $('pLen').textContent = `${Math.round(done).toLocaleString()} px`;
    $('pBar').style.width = `${Math.min(100, (done / Math.max(1, total)) * 100)}%`;
    $('pSub').textContent = `of ${Math.round(total).toLocaleString()} px · scrolling automatically…`;
  } else if (msg.type === 'tss:done') {
    $('pTitle').textContent = 'Opening editor…';
  } else if (msg.type === 'tss:cancelled') {
    window.close();
  } else if (msg.type === 'tss:error') {
    hideProgress();
    showError(msg.error);
  }
});

function showProgress(mode, opts) {
  live = true;
  $('pTitle').textContent = mode === 'full' ? 'Capturing full page' : `Capturing ${opts.value} ${opts.unit}`;
  $('main').hidden = true;
  $('progress').hidden = false;
  $('stopBtn').focus();
}

function hideProgress() {
  live = false;
  $('progress').hidden = true;
  $('main').hidden = false;
}

const sendToTab = (type) => chrome.tabs.sendMessage(tab.id, { type }).catch(() => {});

$('stopBtn').addEventListener('click', () => {
  $('stopBtn').disabled = true;
  $('stopBtn').textContent = 'Stopping…';
  sendToTab('tss:stop');
});
$('abortBtn').addEventListener('click', () => sendToTab('tss:abort'));
document.addEventListener('keydown', (e) => {
  if (live && e.key === 'Escape') {
    e.preventDefault();
    sendToTab('tss:stop');
  }
});

// --------------------------------------------------------------- settings

$('hideFixed').addEventListener('change', (e) => saveSettings({ hideFixed: e.target.checked }));
$('colorFormat').addEventListener('change', (e) => {
  saveSettings({ colorFormat: e.target.value });
  renderHistory(e.target.value);
});

// ----------------------------------------------------------- color history

async function renderHistory(format) {
  const { colorHistory = [] } = await chrome.storage.local.get({ colorHistory: [] });
  const { fromHex, format: formatColor } = globalThis.tallShotColor;
  $('history').hidden = !colorHistory.length;
  $('swatches').replaceChildren(...colorHistory.map((hex) => {
    const text = formatColor(fromHex(hex), format);
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = hex;
    b.title = text;
    b.setAttribute('aria-label', `Copy ${text}`);
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        miniToast(`Copied ${text}`);
      } catch (e) {
        miniToast(`Couldn't copy: ${e.message}`);
      }
    });
    return b;
  }));
}

$('clearColors').addEventListener('click', async () => {
  await chrome.storage.local.set({ colorHistory: [] });
  renderHistory($('colorFormat').value);
});

let toastTimer = 0;
function miniToast(text) {
  $('miniToast').textContent = text;
  $('miniToast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('miniToast').classList.remove('show'), 1600);
}

function bindNumber(id, min, max) {
  $(id).addEventListener('change', (e) => {
    const n = Math.round(Math.min(max, Math.max(min, Number(e.target.value) || 0)));
    e.target.value = n;
    saveSettings({ [id]: n });
  });
}
bindNumber('maxHeight', 1000, 200000);
bindNumber('delay', 0, 5000);

$('shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

// ---------------------------------------------------------------- helpers

function showError(text) {
  $('error').textContent = text;
  $('error').hidden = false;
}

