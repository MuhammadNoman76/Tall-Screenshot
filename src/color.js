// Color formatting shared by the picker (injected into pages) and the popup.
globalThis.tallShotColor = (() => {
  const toHex = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;

  const fromHex = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

  function toHsl([r, g, b]) {
    const R = r / 255;
    const G = g / 255;
    const B = b / 255;
    const max = Math.max(R, G, B);
    const min = Math.min(R, G, B);
    const l = (max + min) / 2;
    const d = max - min;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    let h = 0;
    if (d) {
      if (max === R) h = ((G - B) / d) % 6;
      else if (max === G) h = (B - R) / d + 2;
      else h = (R - G) / d + 4;
      h = Math.round(h * 60);
      if (h < 0) h += 360;
    }
    return `hsl(${h}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
  }

  function format(rgb, as) {
    if (as === 'rgb') return `rgb(${rgb.join(', ')})`;
    if (as === 'hsl') return toHsl(rgb);
    return toHex(rgb);
  }

  return { toHex, fromHex, toHsl, format };
})();
