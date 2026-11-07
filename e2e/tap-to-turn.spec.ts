import { test, expect, type Page } from '@playwright/test';
import { gotoApp } from './helpers/app';
import { writeSyntheticVolume, type SyntheticVolume } from './helpers/synthetic-volume';

/**
 * "Tap page edges to turn pages" (#54) in the real paged reader.
 *
 * Off, a tap in the margin beside the page must not turn it — but the margins
 * must stay INSIDE the paged viewport's wrapper, where its gesture tracker,
 * wheel listener and `touch-action: none` live, so a swipe, wheel or
 * ctrl+wheel zoom that starts beside the page still works.
 *
 * The synthetic pages are 600×900 portraits: fit to a 1920×1080 screen they
 * leave wide margins either side.
 */

const MARGIN = { x: 80, y: 540 };

async function importVolume(page: Page, volume: SyntheticVolume) {
  // The navbar's upload icon (stats, progress tracker, settings, upload, cloud).
  await page.locator('nav div.md\\:order-2 > button').nth(3).click();
  const chooser = page.waitForEvent('filechooser');
  await page.locator('dialog button', { hasText: 'choose files' }).click();
  await (await chooser).setFiles([volume.mokuro, volume.cbz]);
  await page.locator('dialog button', { hasText: /^\s*Import\s*$/ }).click();
  await expect
    .poll(
      () =>
        page.evaluate(async (uuid) => {
          const { db } = await import('/src/lib/catalog/db.ts');
          return (await db.volume_files.get(uuid)) != null;
        }, volume.volumeUuid),
      { timeout: 60_000, message: 'the import never saved the volume' }
    )
    .toBe(true);
}

async function setSettings(page: Page, values: Record<string, unknown>) {
  await page.evaluate(async (values) => {
    const { updateSetting } = await import('/src/lib/settings/settings.ts');
    for (const [key, value] of Object.entries(values)) updateSetting(key as never, value);
  }, values);
}

async function openReader(page: Page, volume: SyntheticVolume) {
  // Set the route, and set it again whenever it bounced back to the catalog.
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ series, vol }) => {
            const target = `#/reader/${series}/${vol}`;
            if (window.location.hash !== target) {
              window.location.hash = target;
              return false;
            }
            return !!document.querySelector('#manga-panel [data-page-index]');
          },
          { series: volume.seriesUuid, vol: volume.volumeUuid }
        ),
      { timeout: 30000, intervals: [100, 200, 400, 800] }
    )
    .toBe(true);
  await expect(page.locator('#manga-panel [data-page-index]').first()).toBeVisible({
    timeout: 20000
  });
  // Let the open settle (page-in transition, fit) before measuring.
  await page.waitForTimeout(600);
}

function shownPages(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('#manga-panel [data-page-index]')]
      .map((el) => Number(el.dataset.pageIndex))
      .sort((a, b) => a - b)
  );
}

async function pageRect(page: Page) {
  return page.evaluate(() => {
    const r = document.querySelector('#manga-panel [data-page-index]')!.getBoundingClientRect();
    return { left: r.left, right: r.right, width: r.width };
  });
}

/** What the margin point hits, and whether that is inside the viewport wrapper. */
function marginTarget(page: Page) {
  return page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return {
      tag: el?.tagName.toLowerCase() ?? null,
      zone: el?.hasAttribute('data-page-turn-zone') ?? false,
      inWrapper: !!el?.closest('[data-mokuro-reader]')
    };
  }, MARGIN);
}

async function setup(page: Page, settings: Record<string, unknown>) {
  const volume = writeSyntheticVolume('TapTurnTest', 6);
  await gotoApp(page);
  // Single pages, so a turn moves the shown index by exactly one.
  await setSettings(page, { singlePageView: 'single', ...settings });
  await importVolume(page, volume);
  await openReader(page, volume);
  const rect = await pageRect(page);
  // The margin point really is beside the page.
  expect(rect.left).toBeGreaterThan(MARGIN.x + 100);
  return volume;
}

test.describe('tap page edges to turn pages (#54)', () => {
  test('on (default): a click in the margin turns the page', async ({ page }) => {
    await setup(page, { mobile: false });
    expect(await shownPages(page)).toEqual([0]);
    expect(await marginTarget(page)).toEqual({ tag: 'button', zone: false, inWrapper: true });

    await page.mouse.click(MARGIN.x, MARGIN.y);
    await expect.poll(() => shownPages(page)).toEqual([1]);
  });

  test('off: a margin click does nothing, a margin ctrl+wheel still zooms', async ({ page }) => {
    await setup(page, { mobile: false, tapPageEdgesToTurn: false });
    expect(await shownPages(page)).toEqual([0]);
    // The margin is still inside the viewport wrapper — an inert zone.
    expect(await marginTarget(page)).toEqual({ tag: 'div', zone: true, inWrapper: true });

    await page.mouse.click(MARGIN.x, MARGIN.y);
    await page.waitForTimeout(600);
    expect(await shownPages(page)).toEqual([0]);

    const before = await pageRect(page);
    await page.mouse.move(MARGIN.x, MARGIN.y);
    await page.keyboard.down('Control');
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, -100);
      await page.waitForTimeout(80);
    }
    await page.keyboard.up('Control');
    await expect
      .poll(async () => (await pageRect(page)).width, { timeout: 5000 })
      .toBeGreaterThan(before.width * 1.05);
    expect(await shownPages(page)).toEqual([0]);
  });

  test.describe('touch', () => {
    test.use({ hasTouch: true });

    test('off: a swipe that starts in the margin still turns the page', async ({ page }) => {
      await setup(page, { mobile: true, tapPageEdgesToTurn: false });
      expect(await shownPages(page)).toEqual([0]);
      expect(await marginTarget(page)).toEqual({ tag: 'div', zone: true, inWrapper: true });

      // A quick rightward swipe from the left margin. RTL (the default): a
      // swipe to the right reveals the left side, i.e. the next page.
      const cdp = await page.context().newCDPSession(page);
      const at = (x: number) => [{ x, y: MARGIN.y, id: 1 }];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(MARGIN.x) });
      for (let step = 1; step <= 6; step++) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: at(MARGIN.x + step * 120)
        });
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect.poll(() => shownPages(page)).toEqual([1]);
    });
  });
});
