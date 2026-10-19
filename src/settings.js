export const DEFAULTS = Object.freeze({
  hideFixed: true,
  maxHeight: 30000,
  delay: 0,
  format: 'png',
  customValue: 3,
  customUnit: 'screens',
  customFrom: 'top',
  colorFormat: 'hex',
});

export async function loadSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
}

export function saveSettings(patch) {
  return chrome.storage.local.set(patch);
}
