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
 * leave wide margins either side; fit to a tall 800×1400 screen they leave a
 * band below the page, where the bottom-corner zones live.
 *
 * Every zone is driven both ways a reader hits it — a mouse click and a
 * touch tap — on and off. RTL (the default): the LEFT zones turn forward.
 */

const MARGIN = { x: 80, y: 540 };
const RIGHT_MARGIN = { x: 1840, y: 540 };
/** Inside the desktop screen-edge strip (`edgeButtonWidth` defaults wider). */
const SCREEN_EDGE = { x: 3, y: 540 };
const RIGHT_SCREEN_EDGE = { x: 1916, y: 540 };
const TALL = { width: 800, height: 1400 };
/** Below the page on the tall screen, left of centre / right of centre. */
const BELOW_LEFT = { x: 150, y: 1380 };
const BELOW_RIGHT = { x: 650, y: 1380 };

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

/** What a point hits, and whether that is inside the viewport wrapper. */
function targetAt(page: Page, point: { x: number; y: number }) {
  return page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return {
      tag: el?.tagName.toLowerCase() ?? null,
      zone: el?.hasAttribute('data-page-turn-zone') ?? false,
      inWrapper: !!el?.closest('[data-mokuro-reader]')
    };
  }, point);
}

function marginTarget(page: Page) {
  return targetAt(page, MARGIN);
}

const BUTTON = { tag: 'button', zone: false, inWrapper: true };
const INERT_ZONE = { tag: 'div', zone: true, inWrapper: true };

/** A press, then — when it should not turn — long enough for a late turn to show. */
async function expectNoTurn(page: Page, press: () => Promise<void>) {
  const before = await shownPages(page);
  await press();
  await page.waitForTimeout(600);
  expect(await shownPages(page)).toEqual(before);
}

async function expectTurnTo(page: Page, press: () => Promise<void>, to: number[]) {
  await press();
  await expect.poll(() => shownPages(page)).toEqual(to);
}

async function setup(page: Page, settings: Record<string, unknown>) {
  const volume = writeSyntheticVolume('TapTurnTest', 6);
  await gotoApp(page);
  // Single pages, so a turn moves the shown index by exactly one.
  await setSettings(page, { singlePageView: 'single', ...settings });
  await importVolume(page, volume);
  await openReader(page, volume);
  return volume;
}

/** The side-margin points really are beside the page (wide screen). */
async function expectSideMargins(page: Page) {
  const rect = await pageRect(page);
  expect(rect.left).toBeGreaterThan(MARGIN.x + 100);
  expect(rect.right).toBeLessThan(RIGHT_MARGIN.x - 100);
}

/** The below-page points really are below the page (tall screen). */
async function expectBottomBand(page: Page) {
  const bottom = await page.evaluate(
    () => document.querySelector('#manga-panel [data-page-index]')!.getBoundingClientRect().bottom
  );
  expect(bottom).toBeLessThan(BELOW_LEFT.y - 40);
}

test.describe('tap page edges to turn pages (#54)', () => {
  test('on (default): a click in the margin or on the screen edge turns the page', async ({
    page
  }) => {
    await setup(page, { mobile: false });
    await expectSideMargins(page);
    expect(await shownPages(page)).toEqual([0]);
    expect(await marginTarget(page)).toEqual(BUTTON);
    // The screen-edge strip sits outside the wrapper, over the margin.
    expect((await targetAt(page, SCREEN_EDGE)).tag).toBe('button');

    await expectTurnTo(page, () => page.mouse.click(MARGIN.x, MARGIN.y), [1]);
    await expectTurnTo(page, () => page.mouse.click(SCREEN_EDGE.x, SCREEN_EDGE.y), [2]);
    // And back: the right side turns backward.
    await expectTurnTo(page, () => page.mouse.click(RIGHT_MARGIN.x, RIGHT_MARGIN.y), [1]);
    await expectTurnTo(page, () => page.mouse.click(RIGHT_SCREEN_EDGE.x, RIGHT_SCREEN_EDGE.y), [0]);
  });

  test('off: a margin click does nothing, a margin ctrl+wheel still zooms', async ({ page }) => {
    await setup(page, { mobile: false, tapPageEdgesToTurn: false });
    await expectSideMargins(page);
    expect(await shownPages(page)).toEqual([0]);
    // The margin is still inside the viewport wrapper — an inert zone — and
    // the screen-edge strips are gone, so the edge hits that zone too.
    expect(await marginTarget(page)).toEqual(INERT_ZONE);
    expect(await targetAt(page, SCREEN_EDGE)).toEqual(INERT_ZONE);
    expect(await targetAt(page, RIGHT_MARGIN)).toEqual(INERT_ZONE);
    expect(await targetAt(page, RIGHT_SCREEN_EDGE)).toEqual(INERT_ZONE);

    for (const point of [MARGIN, SCREEN_EDGE, RIGHT_MARGIN, RIGHT_SCREEN_EDGE]) {
      await expectNoTurn(page, () => page.mouse.click(point.x, point.y));
    }
    // Turning still works by key (only the taps are gone).
    await expectTurnTo(page, () => page.keyboard.press('ArrowLeft'), [1]);
    for (const point of [MARGIN, SCREEN_EDGE, RIGHT_MARGIN, RIGHT_SCREEN_EDGE]) {
      await expectNoTurn(page, () => page.mouse.click(point.x, point.y));
    }
    await expectTurnTo(page, () => page.keyboard.press('ArrowRight'), [0]);

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

    const tap = (page: Page, point: { x: number; y: number }) => () =>
      page.touchscreen.tap(point.x, point.y);

    test('on (default): a tap in the margin or on the screen edge turns the page', async ({
      page
    }) => {
      await setup(page, { mobile: false });
      await expectSideMargins(page);
      expect(await shownPages(page)).toEqual([0]);

      await expectTurnTo(page, tap(page, MARGIN), [1]);
      await expectTurnTo(page, tap(page, SCREEN_EDGE), [2]);
      await expectTurnTo(page, tap(page, RIGHT_MARGIN), [1]);
      await expectTurnTo(page, tap(page, RIGHT_SCREEN_EDGE), [0]);
    });

    test('on, mobile layout: a tap in the margin turns the page', async ({ page }) => {
      await setup(page, { mobile: true });
      await expectSideMargins(page);
      expect(await marginTarget(page)).toEqual(BUTTON);

      await expectTurnTo(page, tap(page, MARGIN), [1]);
      await expectTurnTo(page, tap(page, RIGHT_MARGIN), [0]);
    });

    test('off: a tap in the margin or on the screen edge does nothing', async ({ page }) => {
      await setup(page, { mobile: false, tapPageEdgesToTurn: false });
      await expectSideMargins(page);
      await expectTurnTo(page, () => page.keyboard.press('ArrowLeft'), [1]);

      for (const point of [MARGIN, SCREEN_EDGE, RIGHT_MARGIN, RIGHT_SCREEN_EDGE]) {
        expect(await targetAt(page, point)).toEqual(INERT_ZONE);
        await expectNoTurn(page, tap(page, point));
      }
    });

    test('off, mobile layout: a tap in either margin does nothing', async ({ page }) => {
      await setup(page, { mobile: true, tapPageEdgesToTurn: false });
      await expectSideMargins(page);
      await expectTurnTo(page, () => page.keyboard.press('ArrowLeft'), [1]);

      for (const point of [MARGIN, RIGHT_MARGIN]) {
        expect(await targetAt(page, point)).toEqual(INERT_ZONE);
        await expectNoTurn(page, tap(page, point));
      }
    });

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

  test.describe('below the page (tall screen)', () => {
    test.use({ viewport: TALL, hasTouch: true });

    test('on (default): a click or a tap below the page turns it', async ({ page }) => {
      await setup(page, { mobile: false });
      await expectBottomBand(page);
      expect(await targetAt(page, BELOW_LEFT)).toEqual(BUTTON);

      await expectTurnTo(page, () => page.mouse.click(BELOW_LEFT.x, BELOW_LEFT.y), [1]);
      await expectTurnTo(page, () => page.touchscreen.tap(BELOW_LEFT.x, BELOW_LEFT.y), [2]);
      await expectTurnTo(page, () => page.mouse.click(BELOW_RIGHT.x, BELOW_RIGHT.y), [1]);
      await expectTurnTo(page, () => page.touchscreen.tap(BELOW_RIGHT.x, BELOW_RIGHT.y), [0]);
    });

    test('off: a click or a tap below the page does nothing', async ({ page }) => {
      await setup(page, { mobile: false, tapPageEdgesToTurn: false });
      await expectBottomBand(page);
      await expectTurnTo(page, () => page.keyboard.press('ArrowLeft'), [1]);

      for (const point of [BELOW_LEFT, BELOW_RIGHT]) {
        expect(await targetAt(page, point)).toEqual(INERT_ZONE);
        await expectNoTurn(page, () => page.mouse.click(point.x, point.y));
        await expectNoTurn(page, () => page.touchscreen.tap(point.x, point.y));
      }
    });
  });
});
