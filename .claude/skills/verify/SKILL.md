---
name: verify
description: Verify reader features end-to-end by importing a synthetic volume through the real upload modal and driving the reader with Playwright. Use when a change needs runtime observation in the actual app (not unit tests).
---

# Verifying mokuro-reader changes end-to-end

## Launch

```bash
npm run dev -- --port 5199 --strictPort   # dedicated port; NEVER bare 5173 (other worktrees own it)
```

Browser: Playwright from `node_modules`, executablePath
`~/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome` (note `chrome-linux64`, not `chrome-linux`).
Headless is fine. Don't drive the user's Chrome (stale service worker, port collisions, hidden-window rAF freeze).

## Synthetic volume fixture

The import needs a `.mokuro` + matching `.cbz` (same basename):

- Pages: ImageMagick solid-color portraits with page numbers:
  `magick -size 1400x2000 xc:"#d8f0ff" -bordercolor black -border 8 -resize 1400x2000\! -gravity center -pointsize 400 -annotate 0 "1" 001.png`
- `vol1.cbz`: `zip -j vol1.cbz *.png`
- `vol1.mokuro` (all fields required): `{version, title, title_uuid, volume, volume_uuid, chars, pages: [{version, img_width, img_height, blocks: [], img_path}]}`

## Import through the real UI

1. Navbar icon cluster: `div.flex.gap-5 > button` — nth(2) is the upload icon → opens the Import modal (`<dialog>`).
2. **Gotcha:** `getByRole()` fails to match buttons inside the flowbite modal `<dialog>` — use CSS locators (`page.locator('dialog button', { hasText: ... })`) or `page.evaluate` with `textContent.trim()` matching.
3. `waitForEvent('filechooser')` + click the `choose files` button, `setFiles([vol1.mokuro, vol1.cbz])`, then click the exact-text `Import` button.
4. Wait for `text=GapTest` in the catalog, click series → volume → reader (`#/reader/<title>/<uuid>`).

## Driving the reader

- RTL default: `ArrowLeft` = forward. Auto view mode pairs pages (cover shows alone first).
- Page elements: `#manga-panel [data-page-index]` — measure `getBoundingClientRect()` for gap/scale/pan assertions (natural page width 1400 → scale = rect.width/1400).
- Wheel with modifiers: `page.keyboard.down('Control'/'Shift')` + `page.mouse.wheel(0, ±100)` — Playwright applies held modifiers to the wheel event. CDP does NOT swap deltaY→deltaX under shift the way real input does; handlers reading `deltaY || deltaX` cover both.
- Reader toast: search text nodes for the notification string.
- Reader settings drawer: `button.reader-hud.right-3` (there are 3 `.reader-hud` buttons; `.first()` is the page-counter). Toggle labels (e.g. "Continuous scroll") are clickable once the drawer opens; close by clicking far from the drawer.
- Persisted settings check: `JSON.parse(localStorage.getItem('profiles'))[currentProfile]`.

## Known noise

- `[pageerror] Unexpected token '<'` on first dev-server load — pre-existing dev artifact, unrelated to features.
