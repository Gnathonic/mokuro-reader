import { test, expect, type Page } from '@playwright/test';
import { inflateSync } from 'node:zlib';
import { join } from 'node:path';
import { gotoApp } from './helpers/app';
import { importVolume } from './helpers/import-volume';
import { writeSyntheticVolume, type SyntheticVolume } from './helpers/synthetic-volume';

/**
 * Page brightness/contrast in the real reader:
 *
 *  - #362: the adjustment switches off and on (B, or the drawer toggle) and
 *    keeps its values;
 *  - #363: while a slider is held or stepped from the keyboard, the settings
 *    drawer's backdrop stops dimming the page — and nothing moves — and the
 *    drawer reopens where it was scrolled to.
 *
 * Set E2E_SHOT_DIR to keep the screenshots the assertions are made on.
 */

const GREY: [number, number, number] = [128, 128, 128];

async function pixel(page: Page, x: number, y: number): Promise<[number, number, number]> {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    if (type === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return [raw[1], raw[2], raw[3]];
}

async function shot(page: Page, name: string) {
  const dir = process.env.E2E_SHOT_DIR;
  if (dir) await page.screenshot({ path: join(dir, `${name}.png`) });
}

async function openReader(page: Page, volume: SyntheticVolume) {
  await gotoApp(page);
  await importVolume(page, volume);
  await page.evaluate(
    ([series, vol]) => (window.location.hash = `#/reader/${series}/${vol}`),
    [volume.seriesUuid, volume.volumeUuid]
  );
  const pageEl = page.locator('#manga-panel [data-page-index]').first();
  await expect(pageEl).toBeVisible({ timeout: 30000 });
  const box = (await pageEl.boundingBox())!;
  // Left part of the page, clear of the OCR box and of the drawer (right quarter).
  return { x: Math.round(box.x + box.width * 0.15), y: Math.round(box.y + box.height * 0.85) };
}

async function openDrawer(page: Page) {
  await page.locator('button.reader-hud.right-3').click();
  await expect(page.locator('#settings')).toBeVisible();
}

async function closeDrawer(page: Page) {
  await page.locator('#settings button[type="button"]', { hasText: /^\s*Close\s*$/ }).click();
  await expect(page.locator('#settings')).toBeHidden();
}

const storedProfile = (page: Page) =>
  page.evaluate(() => {
    const profiles = JSON.parse(localStorage.getItem('profiles') ?? '{}');
    const current = localStorage.getItem('currentProfile') ?? 'Desktop';
    // Stored either bare or JSON-quoted, depending on the writer.
    const name = profiles[current] ? current : JSON.parse(current);
    return profiles[name] ?? {};
  });

const backdropColour = (page: Page) =>
  page.evaluate(
    () => getComputedStyle(document.querySelector('dialog#settings')!, '::backdrop').backgroundColor
  );

test('B switches brightness/contrast off and on, keeping the values (#362)', async ({ page }) => {
  const volume = writeSyntheticVolume('AdjustToggle', 3, GREY);
  const probe = await openReader(page, volume);
  const [r0] = await pixel(page, probe.x, probe.y);
  expect(Math.abs(r0 - GREY[0])).toBeLessThan(6);

  // Brightness 130% through the real slider (keyboard steps of 5).
  await openDrawer(page);
  const slider = page.locator('#page-adjust-pageBrightness');
  await slider.scrollIntoViewIfNeeded();
  await slider.focus();
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
  await expect(page.getByText('Brightness: 130%')).toBeVisible();
  await closeDrawer(page);

  const brightened = Math.round(GREY[0] * 1.3);
  await expect
    .poll(async () => (await pixel(page, probe.x, probe.y))[0])
    .toBeGreaterThan(brightened - 6);
  await shot(page, '362-1-adjusted');

  // B: off — the page renders unadjusted, the values stay.
  await page.keyboard.press('b');
  await expect(page.getByText('Brightness/Contrast Off')).toBeVisible();
  await expect.poll(async () => (await pixel(page, probe.x, probe.y))[0]).toBeLessThan(GREY[0] + 6);
  await expect(page.locator('.pageImage').first()).toHaveCSS('filter', 'none');
  await shot(page, '362-2-off');
  expect(await storedProfile(page)).toMatchObject({
    pageAdjustEnabled: false,
    pageBrightness: 130
  });

  // The drawer toggle shows it off, the slider still at 130.
  await openDrawer(page);
  const toggle = page.getByRole('checkbox', { name: /Brightness & contrast/ });
  await expect(toggle).not.toBeChecked();
  await expect(page.getByText('Brightness: 130%')).toBeVisible();
  await closeDrawer(page);

  // B again: back on, same values.
  await page.keyboard.press('b');
  await expect(page.getByText('Brightness/Contrast On')).toBeVisible();
  await expect
    .poll(async () => (await pixel(page, probe.x, probe.y))[0])
    .toBeGreaterThan(brightened - 6);
  await expect(page.locator('.pageImage').first()).toHaveCSS(
    'filter',
    'brightness(1.3) contrast(1)'
  );
  await shot(page, '362-3-on-again');
  expect(await storedProfile(page)).toMatchObject({ pageAdjustEnabled: true, pageBrightness: 130 });

  // Continuous scroll: the same key, the same filter.
  await page.keyboard.press('v');
  await expect.poll(async () => (await storedProfile(page)).continuousScroll).toBe(true);
  await expect(page.locator('.pageImage').first()).toHaveCSS(
    'filter',
    'brightness(1.3) contrast(1)'
  );
  await page.keyboard.press('b');
  await expect(page.getByText('Brightness/Contrast Off')).toBeVisible();
  await expect(page.locator('.pageImage').first()).toHaveCSS('filter', 'none');
});

test('the backdrop stops dimming the page while a slider is adjusted (#363)', async ({ page }) => {
  const volume = writeSyntheticVolume('AdjustPreview', 3, GREY);
  const probe = await openReader(page, volume);

  await openDrawer(page);
  const slider = page.locator('#page-adjust-pageBrightness');
  await slider.scrollIntoViewIfNeeded();
  const drawerBox = await page.locator('#settings').boundingBox();
  const sliderBox = (await slider.boundingBox())!;

  // Idle: dimmed.
  const dimmed = await backdropColour(page);
  expect(dimmed).not.toBe('rgba(0, 0, 0, 0)');
  const [rDim] = await pixel(page, probe.x, probe.y);
  expect(rDim).toBeLessThan(GREY[0] - 30);
  await shot(page, '363-1-idle-dimmed');

  // Press on the thumb (100% sits at a third of the track): the page is shown
  // as it is, undimmed, while the pointer is held.
  const thumbX = sliderBox.x + sliderBox.width * ((100 - 50) / 150);
  const thumbY = sliderBox.y + sliderBox.height / 2;
  await page.mouse.move(thumbX, thumbY);
  await page.mouse.down();
  await expect.poll(() => backdropColour(page)).toBe('rgba(0, 0, 0, 0)');
  const [rHeld] = await pixel(page, probe.x, probe.y);
  expect(rHeld).toBeGreaterThan(GREY[0] - 10);

  // Drag right: the page follows the thumb, still undimmed.
  await page.mouse.move(thumbX + sliderBox.width * 0.2, thumbY, { steps: 5 });
  await expect
    .poll(async () => (await pixel(page, probe.x, probe.y))[0])
    .toBeGreaterThan(GREY[0] + 20);
  await shot(page, '363-2-dragging-undimmed');
  // Nothing moved or resized.
  expect(await page.locator('#settings').boundingBox()).toEqual(drawerBox);
  expect(await slider.boundingBox()).toEqual(sliderBox);

  // Released: dimmed again.
  await page.mouse.up();
  await expect.poll(() => backdropColour(page)).toBe(dimmed);
  await shot(page, '363-3-released-dimmed');

  // Keyboard: an adjusting key clears it until the slider loses focus.
  await slider.focus();
  await expect.poll(() => backdropColour(page)).toBe(dimmed);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => backdropColour(page)).toBe('rgba(0, 0, 0, 0)');
  await page.keyboard.press('Tab');
  await expect.poll(() => backdropColour(page)).toBe(dimmed);

  // The on/off switch: each flip shows the page undimmed for a moment, so
  // on and off can be compared from inside the drawer — then dims again.
  const toggle = page.getByRole('checkbox', { name: /Brightness & contrast/ });
  const toggleLabel = page.locator('#settings label').filter({ has: toggle });
  await toggleLabel.scrollIntoViewIfNeeded();
  await toggleLabel.click();
  await expect(toggle).not.toBeChecked();
  expect(await backdropColour(page)).toBe('rgba(0, 0, 0, 0)');
  const [rFlipped] = await pixel(page, probe.x, probe.y);
  expect(rFlipped).toBeGreaterThan(GREY[0] - 10);
  await shot(page, '363-4-toggle-flip-undimmed');
  await expect.poll(() => backdropColour(page), { timeout: 4000 }).toBe(dimmed);
  expect(await page.locator('#settings').boundingBox()).toEqual(drawerBox);
});

test('the drawer reopens where it was scrolled to (#363)', async ({ page }) => {
  const volume = writeSyntheticVolume('AdjustScroll', 3, GREY);
  await openReader(page, volume);

  await openDrawer(page);
  const slider = page.locator('#page-adjust-pageBrightness');
  await slider.scrollIntoViewIfNeeded();
  const scrolled = await page.evaluate(() => document.querySelector('dialog#settings')!.scrollTop);
  expect(scrolled).toBeGreaterThan(200);
  // Close the way a reader would from there: a click beside the drawer.
  await page.mouse.click(100, 500);
  await expect(page.locator('#settings')).toBeHidden();

  await openDrawer(page);
  await expect
    .poll(() => page.evaluate(() => document.querySelector('dialog#settings')!.scrollTop))
    .toBe(scrolled);
  await expect(slider).toBeInViewport();

  // Keyboard focus came back with the view: it sits on a control the user can
  // see, so the first Tab moves on from there instead of snapping the drawer
  // back to the top where the dialog first put focus.
  const focusedInView = () =>
    page.evaluate(() => {
      const dlg = document.querySelector('dialog#settings')!;
      const el = document.activeElement as HTMLElement | null;
      if (!el || !dlg.contains(el) || el === dlg) return false;
      const d = dlg.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return r.bottom > d.top && r.top < d.bottom;
    });
  await expect.poll(focusedInView).toBe(true);
  await page.keyboard.press('Tab');
  await expect.poll(focusedInView).toBe(true);
  const afterTab = await page.evaluate(() => document.querySelector('dialog#settings')!.scrollTop);
  expect(Math.abs(afterTab - scrolled)).toBeLessThan(200);
});
