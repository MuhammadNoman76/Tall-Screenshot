# Chrome Web Store listing — copy & paste

Everything the developer dashboard asks for, in the order it asks.

## Package

Upload `dist/tall-screenshot-1.0.0.zip` (build it with `scripts/package.ps1`).

## Store listing tab

**Item name** (from the manifest): Tall Screenshot – Full Page & Custom Length

**Summary** (from the manifest, 132 characters max): Full-page and custom-length screenshots with a crop editor, plus a color picker and an on-page ruler.

**Category:** Tools (under Productivity)  
**Language:** English

**Description:**

```
Capture the whole page — or exactly as much as you want.

Tall Screenshot takes long screenshots that are stitched pixel-perfectly, and lets YOU decide how long they are:

• Full page — the page scrolls by itself. Click "Stop" or press Esc the moment you have enough.
• Select area — drag a box. Keep dragging past the bottom of the screen and the page scrolls with you, so the area can be any height.
• Custom length — capture 3 screens, 5,000 px, or any length, from the top or from where you are.
• Visible area — just what's on screen, instantly.

BUILT-IN EDITOR
• Crop by dragging or by typing exact sizes, with handles and auto-scroll for tall images
• Undo with no quality loss
• Copy to clipboard, or download as PNG, JPG or WebP

COLOR PICKER
• A magnifier shows every pixel under your mouse
• Click to copy the color as HEX, RGB or HSL
• Recent colors are saved in the popup for one-click copying

RULER
• Move the mouse to measure the distance between edges
• Drag a box and it snaps to the content inside
• Hold Shift to see any element's exact size

SMART CAPTURE
• Sticky headers and cookie bars appear once, not on every screen
• Works on app-style pages that scroll an inner panel (mail, chat, docs)
• Waits for lazy-loaded images
• Handles high-DPI and zoomed screens

PRIVATE BY DESIGN
Everything happens on your computer. No accounts, no uploads, no tracking. The extension can only see the tab you use it on, and only when you ask.

Keyboard shortcuts: Alt+Shift+F (full page), Alt+Shift+S (select area), Alt+Shift+V (visible area), Alt+Shift+C (pick color). Change them at chrome://extensions/shortcuts.
```

**Graphic assets** (all in this folder):

| Field | File |
| --- | --- |
| Store icon (128×128) | `store-icon-128.png` |
| Screenshots (1280×800, 24-bit PNG) | `screenshot-1.png` … `screenshot-5.png` |
| Small promo tile (440×280, 24-bit PNG) | `promo-small-440x280.png` |
| Marquee promo tile (1400×560, 24-bit PNG) | `promo-marquee-1400x560.png` |
| Global promo video | optional, leave empty |

**Additional fields:** Official URL: None · Homepage URL and Support URL below · Mature content: off.

**Homepage URL:** https://github.com/MuhammadNoman76/Tall-Screenshot  
**Support URL:** https://github.com/MuhammadNoman76/Tall-Screenshot/issues

## Privacy practices tab

**Single purpose description:**

```
Tall Screenshot captures and inspects the visual content of the web page the user is viewing: it takes full-page, custom-length and area screenshots that the user can crop and save, and lets the user pick colors and measure sizes on the same page.
```

**Permission justifications:**

| Permission | Justification |
| --- | --- |
| activeTab | Takes a screenshot of the current tab (tabs.captureVisibleTab) and runs the capture or inspection script in it, only after the user clicks the toolbar button, presses one of the extension's keyboard shortcuts or chooses a right-click menu item. |
| scripting | Injects the extension's own bundled script into the active tab on user action, to scroll the page for full-page captures, draw the area-selection overlay, and show the color picker magnifier and ruler. No remote code is used. |
| storage | Saves the user's settings (maximum capture length, color format, and so on) and the list of recently picked colors, locally on the device. |
| contextMenus | Adds "Tall Screenshot" items to the right-click menu so captures and tools can be started from there. |

**Host permissions:** none requested.

**Are you using remote code?** No, I am not using remote code.

**Data usage:** leave every data type unchecked (the extension collects no user data), then tick all three certifications:

- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** https://github.com/MuhammadNoman76/Tall-Screenshot/blob/main/PRIVACY.md

## Distribution tab

- Payments: Free
- Visibility: Public
- Regions: All regions
