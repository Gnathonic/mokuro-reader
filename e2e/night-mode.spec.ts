import { test, expect, type Page } from '@playwright/test';
import http from 'node:http';

/**
 * E2E coverage for the night-mode red filter.
 *
 * Night mode has to tint EVERY pixel the user can see, including surfaces that
 * a `filter` on the root element never reaches:
 *
 *   - content a browser extension injects into <body> or <html>,
 *   - a cross-origin iframe (how Yomitan renders its dictionary popup),
 *   - the top layer: modal dialogs, popovers (every Flowbite dropdown), and
 *     ::backdrop,
 *   - the propagated canvas background.
 *
 * It also has to tint each of them exactly ONCE. The transform is
 * luminance -> red channel, which is not idempotent: a second pass multiplies
 * the red channel by 0.2126 and the surface renders ~5x too dark. Non-modal
 * dialogs (Flowbite's Drawer calls show(), not showModal()) stay in normal flow
 * and so are already covered by the page-level overlays — filtering them again
 * via a bare `dialog` selector is the specific bug this asserts against.
 *
 * NOTE on the cross-origin case: Chrome only started refusing to paint SVG
 * reference filters onto cross-origin frames in 151, and Playwright's bundled
 * Chromium is older, so that assertion only has teeth when E2E_CHROMIUM points
 * at a real Chrome >= 151. Every other assertion here reproduces on the bundled
 * build.
 */

const FRAME_PORT = 8673;

// White and mid-grey patches, so we can check the tint value and not just "is red".
const FRAME_HTML = `<!doctype html><html><body style="margin:0">
<div style="position:absolute;left:0;top:0;width:60px;height:60px;background:#ffffff"></div>
<div style="position:absolute;left:60px;top:0;width:60px;height:60px;background:#808080"></div>
</body></html>`;

let frameServer: http.Server;

test.beforeAll(async () => {
  frameServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(FRAME_HTML);
  });
  await new Promise<void>((resolve) => frameServer.listen(FRAME_PORT, '127.0.0.1', resolve));
});

test.afterAll(async () => {
  await new Promise((resolve) => frameServer.close(resolve));
});

/** Injects the surfaces an extension (and the app itself) can put on screen. */
async function injectSurfaces(page: Page, framePort: number) {
  await page.evaluate((port) => {
    const box = 'position:fixed;top:0;width:60px;height:60px;z-index:2147483647;';
    const mk = (id: string, css: string, parent: Element) => {
      const el = document.createElement('div');
      el.id = id;
      el.style.cssText = css;
      parent.appendChild(el);
      return el;
    };

    mk('probe-body', box + 'left:0;background:#ffffff', document.body);
    mk('probe-html', box + 'left:60px;background:#ffffff', document.documentElement);

    const frame = document.createElement('iframe');
    frame.id = 'probe-frame';
    frame.style.cssText = box + 'left:120px;width:120px;border:0';
    frame.src = `http://127.0.0.1:${port}/`;
    document.documentElement.appendChild(frame);

    const pop = mk(
      'probe-popover',
      box + 'left:240px;background:#ffffff;margin:0;border:0',
      document.body
    );
    pop.setAttribute('popover', 'manual');
    pop.showPopover();

    const modal = document.createElement('dialog');
    modal.id = 'probe-modal';
    modal.style.cssText =
      'position:fixed;top:80px;left:0;margin:0;padding:0;border:0;width:60px;height:60px;background:#ffffff';
    document.body.appendChild(modal);
    modal.showModal();

    const nonModal = document.createElement('dialog');
    nonModal.id = 'probe-nonmodal';
    nonModal.style.cssText =
      'position:fixed;top:80px;left:60px;margin:0;padding:0;border:0;width:60px;height:60px;background:#ffffff;z-index:2147483647';
    document.body.appendChild(nonModal);
    nonModal.show();
  }, framePort);
  // let the cross-origin frame paint
  await page.waitForTimeout(600);
}

/**
 * Mirrors NightModeFilter.svelte: two max-z-index blend layers kept as the last
 * two children of <html>, plus the variable that drives the top-layer rules.
 */
async function setNightMode(page: Page, on: boolean) {
  await page.evaluate((active) => {
    const root = document.documentElement;
    root.querySelectorAll('.night-mode-layer').forEach((el) => el.remove());
    if (active) {
      for (const kind of ['desaturate', 'redden']) {
        const el = document.createElement('div');
        el.className = `night-mode-layer night-mode-${kind}`;
        root.appendChild(el);
      }
    }
    root.classList.toggle('night-mode', active);
    root.style.setProperty('--night-mode-filter', active ? 'url(#night-mode-filter)' : 'none');
  }, on);
  await page.waitForTimeout(300);
}

type Rgb = [number, number, number];

async function pixel(page: Page, x: number, y: number): Promise<Rgb> {
  const shot = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
  // A 1x1 PNG: decode via the browser rather than shipping a decoder.
  const data = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  }, shot.toString('base64'));
  return data as Rgb;
}

const SURFACES: Array<{ name: string; x: number; y: number }> = [
  { name: 'div injected into <body>', x: 30, y: 30 },
  { name: 'div injected into <html>', x: 90, y: 30 },
  { name: 'cross-origin iframe (white)', x: 150, y: 30 },
  { name: 'cross-origin iframe (grey)', x: 210, y: 30 },
  { name: 'popover (top layer)', x: 270, y: 30 },
  { name: 'modal dialog (top layer)', x: 30, y: 110 },
  { name: 'non-modal dialog', x: 90, y: 110 },
  { name: 'page background', x: 700, y: 600 }
];

test('night mode tints every visible surface exactly once', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto('/');
  await page.waitForTimeout(1200);
  await injectSurfaces(page, FRAME_PORT);

  await setNightMode(page, false);
  const before: Record<string, Rgb> = {};
  for (const s of SURFACES) before[s.name] = await pixel(page, s.x, s.y);

  await setNightMode(page, true);

  for (const s of SURFACES) {
    const [r, g, b] = await pixel(page, s.x, s.y);
    const [r0, g0, b0] = before[s.name];
    // Rec.709 luma of the untinted colour is what the red channel must become.
    const luma = 0.2126 * r0 + 0.7152 * g0 + 0.0722 * b0;

    expect(g, `${s.name}: green channel must be removed`).toBeLessThan(40);
    expect(b, `${s.name}: blue channel must be removed`).toBeLessThan(40);
    // Catches BOTH "not tinted at all" and "tinted twice" (~0.21x too dark).
    expect(
      Math.abs(r - luma),
      `${s.name}: red channel should be the luma of ${r0},${g0},${b0} (${luma.toFixed(0)}), got ${r}`
    ).toBeLessThan(20);
  }
});

test('turning night mode off restores the original colours', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto('/');
  await page.waitForTimeout(1200);
  await injectSurfaces(page, FRAME_PORT);

  await setNightMode(page, false);
  const before = await pixel(page, 30, 30);
  await setNightMode(page, true);
  await setNightMode(page, false);
  const after = await pixel(page, 30, 30);

  expect(after).toEqual(before);
});

/**
 * The desaturation and red passes are separate layers, so anything that paints
 * BETWEEN them gets reddened without being desaturated — greens and blues
 * collapse to black instead of becoming mid-red. Extensions routinely inject at
 * z-index 2147483647 (Yomitan included), which is exactly the value that used to
 * land in that gap. Saturated colours are the only probe that detects this:
 * white and grey render correctly either way.
 */
test('extension content at a maximal z-index is desaturated, not just reddened', async ({
  page
}) => {
  await page.setViewportSize({ width: 500, height: 400 });
  await page.goto('/');
  await page.waitForTimeout(1200);

  await page.evaluate((port) => {
    for (const [i, z] of [1000, 2147483646, 2147483647].entries()) {
      const f = document.createElement('iframe');
      f.className = 'probe-z';
      f.style.cssText = `position:fixed;left:0;top:${i * 50}px;width:240px;height:44px;border:0;z-index:${z}`;
      f.src = `http://127.0.0.1:${port}/`;
      document.documentElement.appendChild(f);
    }
  }, FRAME_PORT);
  await page.waitForTimeout(700);
  await setNightMode(page, true);

  // The served frame is white then mid-grey; add a saturated strip of our own by
  // sampling a green patch we inject alongside at the same z-index.
  await page.evaluate(() => {
    for (const [i, z] of [1000, 2147483646, 2147483647].entries()) {
      const d = document.createElement('div');
      d.style.cssText = `position:fixed;left:260px;top:${i * 50}px;width:44px;height:44px;background:#00ff00;z-index:${z}`;
      document.documentElement.appendChild(d);
    }
  });
  // Re-assert the layers the way the component's MutationObserver does.
  await setNightMode(page, true);

  for (let i = 0; i < 3; i++) {
    const [r, g, b] = await pixel(page, 282, i * 50 + 22);
    // Rec.601 desaturation of #00ff00 is 150; only-multiply would give 0.
    expect(r, `green patch ${i} must be desaturated before being reddened`).toBeGreaterThan(100);
    expect(g).toBeLessThan(40);
    expect(b).toBeLessThan(40);
  }
});

test('night mode does not unpin position:fixed elements', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto('/');
  await page.waitForTimeout(1200);

  // A filter on <body> (rather than the root) would re-anchor this to the
  // document and scroll it away — that is why the page-level tint is a blend
  // overlay pair on the root's pseudo-elements, not a filter on a wrapper.
  await page.evaluate(() => {
    const tall = document.createElement('div');
    tall.style.cssText = 'height:4000px';
    document.body.appendChild(tall);
    const hud = document.createElement('div');
    hud.id = 'probe-hud';
    hud.style.cssText = 'position:fixed;bottom:0;left:0;width:100px;height:40px;background:#fff';
    document.body.appendChild(hud);
  });

  await setNightMode(page, true);
  await page.evaluate(() => window.scrollTo(0, 1500));
  await page.waitForTimeout(300);

  const top = await page.evaluate(
    () => document.getElementById('probe-hud')!.getBoundingClientRect().top
  );
  expect(Math.round(top)).toBe(660); // 700px viewport - 40px element
});
