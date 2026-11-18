import { test, expect, type Page } from '@playwright/test';
import { inflateSync } from 'node:zlib';
import { join } from 'node:path';
import { gotoApp } from './helpers/app';
import { importVolume } from './helpers/import-volume';
import { writeSyntheticVolume, type SyntheticVolume } from './helpers/synthetic-volume';

/**
 * Page brightness/contrast in the real reader:
 *
 *  - #362: the adjustment switches off and on (B, or a switch) and keeps its
 *    values;
 *  - #363: the values are adjusted over the page itself, in a small non-modal
 *    panel (A, the quick actions menu, or the drawer's Page image card) — no
 *    backdrop dims the page, nothing on screen flashes or moves while a
 *    slider is held, released or switched, the pages still turn, and Escape
 *    closes the panel without leaving the reader. The drawer reopens where it
 *    was scrolled to.
 *
 * Set E2E_SHOT_DIR to keep the screenshots the assertions are made on.
 */

const GREY: [number, number, number] = [128, 128, 128];
const PANEL = '[data-page-adjust-panel]';

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

async function openReader(page: Page, volume: SyntheticVolume, opts: { clock?: boolean } = {}) {
  // Before the app loads, so every timer it arms runs on the page clock.
  if (opts.clock) await page.clock.install();
  await gotoApp(page);
  await importVolume(page, volume);
  await page.evaluate(
    ([series, vol]) => (window.location.hash = `#/reader/${series}/${vol}`),
    [volume.seriesUuid, volume.volumeUuid]
  );
  const pageEl = page.locator('#manga-panel [data-page-index]').first();
  await expect(pageEl).toBeVisible({ timeout: 30000 });
  const box = (await pageEl.boundingBox())!;
  // Upper left part of the page: clear of the OCR box, the drawer (right
  // quarter) and the panel (bottom centre).
  return { x: Math.round(box.x + box.width * 0.15), y: Math.round(box.y + box.height * 0.25) };
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

const anyModal = (page: Page) => page.evaluate(() => !!document.querySelector('dialog:modal'));

/** Layout shifts from here on, read back with `shifts()`. */
async function watchShifts(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __shifts: number[] };
    w.__shifts = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__shifts.push((e as unknown as { value: number }).value);
    }).observe({ type: 'layout-shift' });
  });
}
const shifts = (page: Page) =>
  page.evaluate(() => (window as unknown as { __shifts: number[] }).__shifts);

const near = (a: number, b: number, tol = 6) => Math.abs(a - b) <= tol;

test('B switches brightness/contrast off and on, keeping the values (#362)', async ({ page }) => {
  const volume = writeSyntheticVolume('AdjustToggle', 3, GREY);
  const probe = await openReader(page, volume);
  const [r0] = await pixel(page, probe.x, probe.y);
  expect(near(r0, GREY[0])).toBe(true);

  // Brightness 130% through the panel's real slider (keyboard steps of 5).
  await page.keyboard.press('a');
  const slider = page.locator('#page-adjust-panel-pageBrightness');
  await expect(slider).toBeFocused();
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
  await expect(page.locator(`${PANEL} [data-value="pageBrightness"]`)).toHaveText('130%');
  await page.keyboard.press('Escape');
  await expect(page.locator(PANEL)).toBeHidden();

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

  // The drawer's switch shows it off, the value still 130.
  await openDrawer(page);
  const toggle = page.locator('#settings').getByRole('checkbox', { name: /Brightness & contrast/ });
  await expect(toggle).not.toBeChecked();
  await expect(page.getByText('Brightness 130% · Contrast 100%')).toBeVisible();
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

test('the panel adjusts over the undimmed page; nothing flashes or moves (#363)', async ({
  page
}) => {
  const volume = writeSyntheticVolume('AdjustPanel', 3, GREY);
  const probe = await openReader(page, volume);

  // From the drawer's Page image card: the drawer gives way to the panel.
  await openDrawer(page);
  await expect(page.getByText('Brightness 100% · Contrast 100%')).toBeVisible();
  await page.getByRole('button', { name: /Adjust over the page/ }).click();
  await expect(page.locator('#settings')).toBeHidden();
  const panel = page.locator(PANEL);
  await expect(panel).toBeVisible();
  // Nothing modal: no backdrop over the page.
  expect(await anyModal(page)).toBe(false);
  await expect.poll(async () => (await pixel(page, probe.x, probe.y))[0]).toBeLessThan(GREY[0] + 6);
  const [rIdle] = await pixel(page, probe.x, probe.y);
  expect(near(rIdle, GREY[0])).toBe(true);
  await shot(page, '363-1-panel-open');

  // Keyboard focus came with it once the drawer's dialog had closed (it is
  // still modal, the page inert, while the panel mounts): the arrows adjust
  // at once instead of turning the page or leaving the volume.
  const readerHash = await page.evaluate(() => location.hash);
  await expect(page.locator('#page-adjust-panel-pageBrightness')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator(`${PANEL} [data-value="pageBrightness"]`)).toHaveText('105%');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator(`${PANEL} [data-value="pageBrightness"]`)).toHaveText('100%');
  expect(await page.evaluate(() => location.hash)).toBe(readerHash);

  await watchShifts(page);
  const panelBox = (await panel.boundingBox())!;
  const slider = page.locator('#page-adjust-panel-pageBrightness');
  const sliderBox = (await slider.boundingBox())!;

  // Press on the thumb (100% sits at a third of the track) WITHOUT moving:
  // the page looks exactly as it did — no undimming flash.
  const thumbX = sliderBox.x + sliderBox.width * ((100 - 50) / 150);
  const thumbY = sliderBox.y + sliderBox.height / 2;
  await page.mouse.move(thumbX, thumbY);
  await page.mouse.down();
  const [rPressed] = await pixel(page, probe.x, probe.y);
  expect(near(rPressed, rIdle, 3)).toBe(true);

  // Drag right: the page follows the thumb.
  await page.mouse.move(thumbX + sliderBox.width * 0.2, thumbY, { steps: 5 });
  await expect
    .poll(async () => (await pixel(page, probe.x, probe.y))[0])
    .toBeGreaterThan(GREY[0] + 20);
  const [rDragged] = await pixel(page, probe.x, probe.y);
  await shot(page, '363-2-dragging');
  expect(await panel.boundingBox()).toEqual(panelBox);
  expect(await slider.boundingBox()).toEqual(sliderBox);

  // Released: the page stays exactly as dragged — no re-dimming.
  await page.mouse.up();
  const [rReleased] = await pixel(page, probe.x, probe.y);
  expect(near(rReleased, rDragged, 3)).toBe(true);
  expect(await anyModal(page)).toBe(false);

  // The switch, from the panel: off shows the page unadjusted, on brings the
  // value back; the panel does not change size or place either way.
  const label = page
    .locator(`${PANEL} label`)
    .filter({ has: page.getByRole('checkbox', { name: /Brightness & contrast/ }) });
  await label.click();
  await expect.poll(async () => (await pixel(page, probe.x, probe.y))[0]).toBeLessThan(GREY[0] + 6);
  await expect(page.locator('#page-adjust-panel-pageBrightness')).toBeVisible();
  await shot(page, '363-3-switched-off');
  expect(await panel.boundingBox()).toEqual(panelBox);
  await label.click();
  await expect
    .poll(async () => (await pixel(page, probe.x, probe.y))[0])
    .toBeGreaterThan(GREY[0] + 20);
  expect(await panel.boundingBox()).toEqual(panelBox);

  // Pages still turn under the open panel (focus off the slider first: a
  // focused slider keeps its arrows).
  const first = page.locator('#manga-panel [data-page-index]').first();
  const before = await first.getAttribute('data-page-index');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('ArrowLeft');
  await expect(first).not.toHaveAttribute('data-page-index', before!);
  await expect(panel).toBeVisible();

  // Through all of it: not one layout shift.
  expect(await shifts(page)).toEqual([]);
});

test('A opens the panel; Escape closes it and never leaves the reader (#363)', async ({ page }) => {
  const volume = writeSyntheticVolume('AdjustKeys', 3, GREY);
  await openReader(page, volume);
  const readerHash = await page.evaluate(() => location.hash);
  const panel = page.locator(PANEL);

  // A: open, focused on brightness — the arrows adjust at once.
  await page.keyboard.press('a');
  await expect(panel).toBeVisible();
  await expect(page.locator('#page-adjust-panel-pageBrightness')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator(`${PANEL} [data-value="pageBrightness"]`)).toHaveText('105%');
  await expect(page.locator('.pageImage').first()).toHaveCSS(
    'filter',
    'brightness(1.05) contrast(1)'
  );

  // B inside the panel flips the adjustment, with the reader's notice.
  await page.keyboard.press('b');
  await expect(page.getByText('Brightness/Contrast Off')).toBeVisible();
  await expect(page.locator(`${PANEL} input[type="checkbox"]`)).not.toBeChecked();
  await page.keyboard.press('b');
  await expect(page.locator(`${PANEL} input[type="checkbox"]`)).toBeChecked();

  // Escape from inside the panel: closed, still reading.
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  expect(await page.evaluate(() => location.hash)).toBe(readerHash);

  // Escape with focus out on the page: the same.
  await page.keyboard.press('a');
  await expect(panel).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  expect(await page.evaluate(() => location.hash)).toBe(readerHash);

  // A control opened over the panel takes the first Escape — the page-number
  // popover closes, the panel stays — and neither Escape leaves the reader
  // (on its own, the popover's Escape also means "back").
  await page.keyboard.press('a');
  await expect(panel).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator('#page-num').click();
  const popover = page.locator('[role="tooltip"]');
  await expect(popover).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();
  await expect(panel).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toBe(readerHash);
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  expect(await page.evaluate(() => location.hash)).toBe(readerHash);

  // From the drawer by keyboard: Enter on "Adjust over the page" lands on the
  // brightness slider, and the arrows adjust (not turn the page).
  await openDrawer(page);
  const adjustButton = page
    .locator('#settings')
    .getByRole('button', { name: /Adjust over the page/ });
  await adjustButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#settings')).toBeHidden();
  await expect(page.locator('#page-adjust-panel-pageBrightness')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator(`${PANEL} [data-value="pageBrightness"]`)).toHaveText('100%');
  expect(await page.evaluate(() => location.hash)).toBe(readerHash);
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();

  // A toggles it; opening the drawer puts it away (never both on screen).
  await page.keyboard.press('a');
  await expect(panel).toBeVisible();
  await page.keyboard.press('a');
  await expect(panel).toBeHidden();
  await page.keyboard.press('a');
  await expect(panel).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await openDrawer(page);
  await expect(panel).toBeHidden();
  await closeDrawer(page);

  // A further Escape on the bare reader still means "back", as before.
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => location.hash)).not.toBe(readerHash);
});

test('edit mode: with the panel open, Escape closes the text editor first, then the panel (#363)', async ({
  page
}) => {
  const volume = writeSyntheticVolume('AdjustEdit', 3, GREY);
  await openReader(page, volume);
  const readerHash = await page.evaluate(() => location.hash);
  const panel = page.locator(PANEL);
  const toolbar = page.locator('[data-edit-toolbar]');

  await page.keyboard.press('e');
  await expect(toolbar).toBeVisible();
  await page.keyboard.press('a');
  await expect(panel).toBeVisible();

  // Editing a text box's words with the panel still up: they type into the
  // box, not into the reader or the panel.
  const block = page.locator('.editBlock').first();
  await block.dblclick();
  const line = block.locator('[contenteditable]').first();
  await expect(line).toBeVisible();
  await line.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('かきく');
  await expect(panel).toBeVisible();

  // The first Escape is the editor's own: it closes and keeps the words. The
  // panel, edit mode and the reader all stay.
  await page.keyboard.press('Escape');
  await expect(page.locator('.editBlock.editing')).toHaveCount(0);
  await expect(block.locator('.line').first()).toHaveText('かきく');
  await expect(panel).toBeVisible();
  await expect(toolbar).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toBe(readerHash);

  // Then one thing per Escape, the latest first — the box's selection, then
  // the panel — and still edit mode, still the reader.
  for (let i = 0; i < 3 && (await panel.isVisible()); i++) {
    await page.keyboard.press('Escape');
    await expect(toolbar).toBeVisible();
    expect(await page.evaluate(() => location.hash)).toBe(readerHash);
  }
  await expect(panel).toBeHidden();
  await expect(block.locator('.line').first()).toHaveText('かきく');
  await expect(toolbar).toBeVisible();
});

test('night mode reaches the panel: it is page content, not top layer (#363)', async ({ page }) => {
  const volume = writeSyntheticVolume('AdjustNight', 3, GREY);
  await openReader(page, volume);
  await page.keyboard.press('a');
  const panel = page.locator(PANEL);
  await expect(panel).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('n');
  await expect(page.locator('html')).toHaveClass(/night-mode/);
  // A pixel of the panel's own (grey) background: red only under night mode.
  const box = (await panel.boundingBox())!;
  await expect
    .poll(async () => {
      const [, g, b] = await pixel(
        page,
        Math.round(box.x + 40),
        Math.round(box.y + box.height - 4)
      );
      return g + b;
    })
    .toBeLessThan(8);
  await shot(page, '363-4-night');
});

test('phone: the quick actions open the panel, clear of the menu button (#363)', async ({
  browser
}) => {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true
  });
  const page = await ctx.newPage();
  try {
    const volume = writeSyntheticVolume('AdjustPhone', 3, GREY);
    await openReader(page, volume);
    const fab = page.locator('button[aria-label="Quick actions menu"]');
    await fab.click();
    await page.getByRole('button', { name: 'Brightness and contrast' }).click();
    const panel = page.locator(PANEL);
    await expect(panel).toBeVisible();
    expect(await anyModal(page)).toBe(false);
    const p = (await panel.boundingBox())!;
    const f = (await fab.boundingBox())!;
    // Inside the viewport, above the menu button, and a small part of the screen.
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.x + p.width).toBeLessThanOrEqual(390);
    expect(p.y + p.height).toBeLessThanOrEqual(f.y);
    expect((p.width * p.height) / (390 * 844)).toBeLessThan(0.2);
    await shot(page, '363-5-phone');
  } finally {
    await ctx.close();
  }
});

/** Every control of `sel` is what a pointer at its centre reaches — nothing lies over it. */
const reachable = (page: Page, sel: string) =>
  page.evaluate((sel) => {
    const root = document.querySelector(sel)!;
    const controls = [...root.querySelectorAll('input, button')] as HTMLElement[];
    return controls.every((el) => {
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !!at && root.contains(at);
    });
  }, sel);

const apart = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;

type Rect = { x: number; y: number; width: number; height: number };

/**
 * Where each of `selectors` is (null when it is gone) at every one of the next
 * `frames` animation frames. A read right after a change races ahead of
 * whatever that change sets off — a ResizeObserver reports the frame after —
 * so "it did not move" is only proven over frames.
 */
const framesOf = (page: Page, selectors: string[], frames = 12) =>
  page.evaluate(
    async ({ selectors, frames }) => {
      const out: (Rect | null)[][] = selectors.map(() => []);
      for (let i = 0; i < frames; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        selectors.forEach((sel, j) => {
          const r = document.querySelector(sel)?.getBoundingClientRect();
          out[j].push(r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null);
        });
      }
      return out;
    },
    { selectors, frames }
  );

/** `sel`'s box once nothing is still settling: the same over a run of frames. */
async function settledBox(page: Page, sel: string): Promise<Rect> {
  const [frames] = await framesOf(page, [sel]);
  const last = frames[frames.length - 1]!;
  expect(frames.slice(-4)).toEqual(Array(4).fill(last));
  return last;
}

/** Each of `boxes` stays exactly where it is over the next frames. */
async function expectStill(page: Page, boxes: Record<string, Rect>) {
  const sels = Object.keys(boxes);
  const frames = await framesOf(page, sels);
  sels.forEach((sel, i) =>
    expect(frames[i], `${sel} moved`).toEqual(Array(frames[i].length).fill(boxes[sel]))
  );
}

const PROMPT = '[data-testid="long-pause"]';

for (const vp of [
  { name: 'desktop', width: 1920, height: 1080 },
  { name: 'phone', width: 390, height: 844 }
]) {
  test(`${vp.name}: the long-pause prompt and the panel never cover each other, and neither moves (#363)`, async ({
    browser
  }) => {
    test.setTimeout(120_000);
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    try {
      const volume = writeSyntheticVolume(`AdjustPause${vp.name}`, 3, GREY);
      await openReader(page, volume, { clock: true });
      // A 1-minute cutoff: the cap a cover (a page with no text) gets anyway.
      await page.evaluate(async () => {
        const { setIdleOverride } = await import('/src/lib/settings/tracking-data.ts');
        setIdleOverride(1);
      });
      const panel = page.locator(PANEL);
      const prompt = page.getByTestId('long-pause');
      const copy = prompt.locator('p');

      // Adjusting a cover past the cap: the prompt arrives while the panel is
      // open, and stacks above it. The panel keeps its place and every one of
      // its controls stays reachable.
      await page.keyboard.press('a');
      await expect(panel).toBeVisible();
      const panelBox = await settledBox(page, PANEL);
      await page.clock.fastForward('01:05');
      await expect(prompt).toBeVisible();
      let promptBox = await settledBox(page, PROMPT);
      await expectStill(page, { [PANEL]: panelBox, [PROMPT]: promptBox });
      expect(apart(panelBox, promptBox)).toBe(true);
      expect(promptBox.y + promptBox.height).toBeLessThanOrEqual(panelBox.y);
      expect(await reachable(page, PANEL)).toBe(true);
      expect(await reachable(page, PROMPT)).toBe(true);
      await shot(page, `363-6-${vp.name}-prompt-over-panel`);

      // The panel closing leaves the prompt where it is — not just at once,
      // but over the frames after, when the stacking would re-place it.
      await page.locator(`${PANEL} button[aria-label="Close"]`).click();
      await expect(panel).toBeHidden();
      await expectStill(page, { [PROMPT]: promptBox });

      // The other order: a prompt already waiting at its own place, then the
      // panel opens — above it; the prompt does not move.
      await prompt.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(prompt).toBeHidden();
      await page.clock.fastForward('01:05');
      await expect(copy).toHaveText(/so the timer stopped/);
      promptBox = await settledBox(page, PROMPT);
      await page.keyboard.press('a');
      await expect(panel).toBeVisible();
      const lifted = await settledBox(page, PANEL);
      await expectStill(page, { [PANEL]: lifted, [PROMPT]: promptBox });
      expect(apart(lifted, promptBox)).toBe(true);
      expect(lifted.y + lifted.height).toBeLessThanOrEqual(promptBox.y);
      expect(lifted.y).toBeGreaterThanOrEqual(0);
      expect(await reachable(page, PANEL)).toBe(true);
      expect(await reachable(page, PROMPT)).toBe(true);
      await shot(page, `363-7-${vp.name}-panel-over-prompt`);

      // The prompt turning into its longer "away" copy (more buttons; two
      // rows on a phone) grows neither it nor moves the panel above it: it
      // was as tall as that from the start.
      await page.clock.fastForward('02:05');
      await expect(copy).toHaveText(/This page was open/);
      await expectStill(page, { [PANEL]: lifted, [PROMPT]: promptBox });
      expect(await reachable(page, PANEL)).toBe(true);
      expect(await reachable(page, PROMPT)).toBe(true);
      await shot(page, `363-8-${vp.name}-away-under-panel`);

      // The prompt answered, the panel stays where it is (a finger may be on
      // its slider), and nothing takes the gap below it.
      await prompt.getByRole('button', { name: 'Count none', exact: true }).click();
      await expect(prompt).toBeHidden();
      await expectStill(page, { [PANEL]: lifted });
    } finally {
      await ctx.close();
    }
  });
}

test('the drawer reopens where it was scrolled to (#363)', async ({ page }) => {
  const volume = writeSyntheticVolume('AdjustScroll', 3, GREY);
  await openReader(page, volume);

  await openDrawer(page);
  const card = page.locator('#settings').getByText('Page image', { exact: true });
  await card.scrollIntoViewIfNeeded();
  const scrolled = await page.evaluate(() => document.querySelector('dialog#settings')!.scrollTop);
  expect(scrolled).toBeGreaterThan(200);
  // Close the way a reader would from there: a click beside the drawer.
  await page.mouse.click(100, 500);
  await expect(page.locator('#settings')).toBeHidden();

  await openDrawer(page);
  await expect
    .poll(() => page.evaluate(() => document.querySelector('dialog#settings')!.scrollTop))
    .toBe(scrolled);
  await expect(card).toBeInViewport();

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
