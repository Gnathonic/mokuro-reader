import { test, expect, type Page } from '@playwright/test';
import { gotoApp } from './helpers/app';
import { writeSyntheticVolume, type SyntheticVolume } from './helpers/synthetic-volume';

/**
 * Tap-to-turn (#54) in the real paged reader: two regions, one control each.
 *
 * - The page IMAGE's own left / right edge: `edgeButtonWidth` px (the slider,
 *   0 = off). On desktop the same control also runs down the screen's edge,
 *   but only where the page is under it (a page zoomed past the screen).
 * - OUTSIDE the image — the background beside and below the page:
 *   `tapOutsideImageToTurn` (the toggle). Off, those zones stay as inert boxes
 *   INSIDE the paged viewport's wrapper, where its gesture tracker, wheel
 *   listener and `touch-action: none` live, so a swipe, wheel or ctrl+wheel
 *   zoom that starts beside the page still works.
 *
 * The synthetic pages are 600×900 portraits: fit to a 1920×1080 screen they
 * leave wide margins either side; fit to a tall 800×1400 screen they leave a
 * band below the page, where the bottom zones live.
 *
 * Every zone is driven both ways a reader hits it — a mouse click and a
 * touch tap. RTL (the default): the LEFT zones turn forward.
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
    return { left: r.left, right: r.right, width: r.width, top: r.top, bottom: r.bottom };
  });
}

/** Points ON the page image, just inside its left / right edge, and its centre. */
async function pageEdgePoints(page: Page) {
  const r = await pageRect(page);
  const y = Math.round((r.top + r.bottom) / 2);
  return {
    left: { x: Math.round(r.left + 8), y },
    right: { x: Math.round(r.right - 8), y },
    centre: { x: Math.round((r.left + r.right) / 2), y }
  };
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

/**
 * A quick rightward touch swipe from the left margin. RTL (the default): a
 * swipe to the right reveals the left side, i.e. the next page.
 */
async function swipeRightFromMargin(page: Page) {
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
  await cdp.detach();
}

const BUTTON = { tag: 'button', zone: false, inWrapper: true };
const INERT_ZONE = { tag: 'div', zone: true, inWrapper: true };
/** A desktop screen-edge strip: a button outside the viewport wrapper. */
const SCREEN_STRIP = { tag: 'button', zone: false, inWrapper: false };

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

test.describe('tap to turn pages: one region, one control (#54)', () => {
  test('defaults: the background, the page edges and the screen edges all turn', async ({
    page
  }) => {
    await setup(page, { mobile: false });
    await expectSideMargins(page);
    expect(await shownPages(page)).toEqual([0]);
    expect(await marginTarget(page)).toEqual(BUTTON);
    // The screen-edge strip sits outside the wrapper, over the background.
    expect(await targetAt(page, SCREEN_EDGE)).toEqual(SCREEN_STRIP);
    const edge = await pageEdgePoints(page);
    expect(await targetAt(page, edge.left)).toEqual(BUTTON);

    await expectTurnTo(page, () => page.mouse.click(MARGIN.x, MARGIN.y), [1]);
    await expectTurnTo(page, () => page.mouse.click(SCREEN_EDGE.x, SCREEN_EDGE.y), [2]);
    await expectTurnTo(page, () => page.mouse.click(edge.left.x, edge.left.y), [3]);
    // And back: the right side turns backward.
    await expectTurnTo(page, () => page.mouse.click(edge.right.x, edge.right.y), [2]);
    await expectTurnTo(page, () => page.mouse.click(RIGHT_MARGIN.x, RIGHT_MARGIN.y), [1]);
    await expectTurnTo(page, () => page.mouse.click(RIGHT_SCREEN_EDGE.x, RIGHT_SCREEN_EDGE.y), [0]);
    // The page's middle is neither region.
    await expectNoTurn(page, () => page.mouse.click(edge.centre.x, edge.centre.y));
  });

  test('toggle off: the background is inert, the page edges still turn', async ({ page }) => {
    await setup(page, { mobile: false, tapOutsideImageToTurn: false, edgeButtonWidth: 40 });
    await expectSideMargins(page);
    expect(await shownPages(page)).toEqual([0]);
    expect(await marginTarget(page)).toEqual(INERT_ZONE);
    expect(await targetAt(page, RIGHT_MARGIN)).toEqual(INERT_ZONE);
    // The screen strip is the page-edge control; over the background it defers
    // to the toggle, so it is there but does not turn.
    expect(await targetAt(page, SCREEN_EDGE)).toEqual(SCREEN_STRIP);

    for (const point of [MARGIN, SCREEN_EDGE, RIGHT_MARGIN, RIGHT_SCREEN_EDGE]) {
      await expectNoTurn(page, () => page.mouse.click(point.x, point.y));
    }
    const edge = await pageEdgePoints(page);
    await expectTurnTo(page, () => page.mouse.click(edge.left.x, edge.left.y), [1]);
    await expectTurnTo(page, () => page.mouse.click(edge.right.x, edge.right.y), [0]);

    // A ctrl+wheel in the inert background still zooms.
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

  test('slider at 0: the page edges do not turn, the background still does', async ({ page }) => {
    await setup(page, { mobile: false, tapOutsideImageToTurn: true, edgeButtonWidth: 0 });
    await expectSideMargins(page);
    const edge = await pageEdgePoints(page);
    // No strip on the page: the point is the page itself.
    expect((await targetAt(page, edge.left)).tag).not.toBe('button');
    await expectNoTurn(page, () => page.mouse.click(edge.left.x, edge.left.y));
    await expectNoTurn(page, () => page.mouse.click(edge.right.x, edge.right.y));
    // No screen strips either: the screen edge is plain background here.
    expect(await targetAt(page, SCREEN_EDGE)).toEqual(BUTTON);
    await expectTurnTo(page, () => page.mouse.click(MARGIN.x, MARGIN.y), [1]);
    await expectTurnTo(page, () => page.mouse.click(SCREEN_EDGE.x, SCREEN_EDGE.y), [2]);
    await expectTurnTo(page, () => page.mouse.click(RIGHT_MARGIN.x, RIGHT_MARGIN.y), [1]);
  });

  test('both off: no tap turns the page; the keys still do', async ({ page }) => {
    await setup(page, { mobile: false, tapOutsideImageToTurn: false, edgeButtonWidth: 0 });
    await expectSideMargins(page);
    const edge = await pageEdgePoints(page);
    expect(await targetAt(page, SCREEN_EDGE)).toEqual(INERT_ZONE);
    for (const point of [MARGIN, SCREEN_EDGE, edge.left, edge.right, RIGHT_MARGIN]) {
      await expectNoTurn(page, () => page.mouse.click(point.x, point.y));
    }
    await expectTurnTo(page, () => page.keyboard.press('ArrowLeft'), [1]);
    await expectTurnTo(page, () => page.keyboard.press('ArrowRight'), [0]);
  });

  test('zoomed past the screen, the screen edge is the page edge: the slider decides', async ({
    page
  }) => {
    // Background off, so only the page-edge control can turn.
    await setup(page, {
      mobile: false,
      tapOutsideImageToTurn: false,
      edgeButtonWidth: 40,
      zoomDefault: 'zoomFitToWidth'
    });
    // Zoom further in at the centre, so the page's own edges leave the screen.
    await page.mouse.move(960, 540);
    await page.keyboard.down('Control');
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, -100);
      await page.waitForTimeout(80);
    }
    await page.keyboard.up('Control');
    await expect
      .poll(async () => (await pageRect(page)).left, { timeout: 5000 })
      .toBeLessThan(-300);
    await page.waitForTimeout(500);
    const rect = await pageRect(page);
    expect(rect.right).toBeGreaterThan(1920 + 300);
    expect(await targetAt(page, SCREEN_EDGE)).toEqual(SCREEN_STRIP);

    await expectTurnTo(page, () => page.mouse.click(SCREEN_EDGE.x, SCREEN_EDGE.y), [1]);
  });

  test.describe('touch', () => {
    test.use({ hasTouch: true });

    const tap = (page: Page, point: { x: number; y: number }) => () =>
      page.touchscreen.tap(point.x, point.y);

    test('defaults: a tap on the background, a page edge or a screen edge turns', async ({
      page
    }) => {
      await setup(page, { mobile: false });
      await expectSideMargins(page);
      const edge = await pageEdgePoints(page);

      await expectTurnTo(page, tap(page, MARGIN), [1]);
      await expectTurnTo(page, tap(page, SCREEN_EDGE), [2]);
      await expectTurnTo(page, tap(page, edge.left), [3]);
      await expectTurnTo(page, tap(page, edge.right), [2]);
      await expectTurnTo(page, tap(page, RIGHT_MARGIN), [1]);
      await expectTurnTo(page, tap(page, RIGHT_SCREEN_EDGE), [0]);
    });

    test('mobile layout, defaults: background and page-edge taps turn', async ({ page }) => {
      await setup(page, { mobile: true });
      await expectSideMargins(page);
      expect(await marginTarget(page)).toEqual(BUTTON);
      const edge = await pageEdgePoints(page);

      await expectTurnTo(page, tap(page, MARGIN), [1]);
      await expectTurnTo(page, tap(page, edge.left), [2]);
      await expectTurnTo(page, tap(page, edge.right), [1]);
      await expectTurnTo(page, tap(page, RIGHT_MARGIN), [0]);
    });

    test('toggle off: background taps do nothing, page-edge taps still turn', async ({ page }) => {
      await setup(page, { mobile: false, tapOutsideImageToTurn: false });
      await expectSideMargins(page);
      for (const point of [MARGIN, SCREEN_EDGE, RIGHT_MARGIN, RIGHT_SCREEN_EDGE]) {
        await expectNoTurn(page, tap(page, point));
      }
      const edge = await pageEdgePoints(page);
      await expectTurnTo(page, tap(page, edge.left), [1]);
    });

    test('mobile layout, toggle off: a tap in either margin does nothing', async ({ page }) => {
      await setup(page, { mobile: true, tapOutsideImageToTurn: false });
      await expectSideMargins(page);
      await expectTurnTo(page, () => page.keyboard.press('ArrowLeft'), [1]);

      for (const point of [MARGIN, RIGHT_MARGIN]) {
        expect(await targetAt(page, point)).toEqual(INERT_ZONE);
        await expectNoTurn(page, tap(page, point));
      }
    });

    test('toggle off: a swipe that starts in the margin still turns the page', async ({ page }) => {
      await setup(page, { mobile: true, tapOutsideImageToTurn: false });
      expect(await shownPages(page)).toEqual([0]);
      expect(await marginTarget(page)).toEqual(INERT_ZONE);

      await swipeRightFromMargin(page);
      await expect.poll(() => shownPages(page)).toEqual([1]);
    });

    // Swipe-to-flip is a Mobile feature: a Desktop-profile tablet user with
    // the background off is left with the page edges and the keys.
    test('toggle off, Mobile off: the same swipe does not turn the page', async ({ page }) => {
      await setup(page, { mobile: false, tapOutsideImageToTurn: false });
      expect(await shownPages(page)).toEqual([0]);
      expect(await marginTarget(page)).toEqual(INERT_ZONE);

      await expectNoTurn(page, () => swipeRightFromMargin(page));
      await expectTurnTo(page, () => page.keyboard.press('ArrowLeft'), [1]);
    });
  });

  test.describe('below the page (tall screen)', () => {
    test.use({ viewport: TALL, hasTouch: true });

    test('toggle on (default): a click or a tap below the page turns it', async ({ page }) => {
      await setup(page, { mobile: false });
      await expectBottomBand(page);
      expect(await targetAt(page, BELOW_LEFT)).toEqual(BUTTON);

      await expectTurnTo(page, () => page.mouse.click(BELOW_LEFT.x, BELOW_LEFT.y), [1]);
      await expectTurnTo(page, () => page.touchscreen.tap(BELOW_LEFT.x, BELOW_LEFT.y), [2]);
      await expectTurnTo(page, () => page.mouse.click(BELOW_RIGHT.x, BELOW_RIGHT.y), [1]);
      await expectTurnTo(page, () => page.touchscreen.tap(BELOW_RIGHT.x, BELOW_RIGHT.y), [0]);
    });

    test('toggle off: a click or a tap below the page does nothing', async ({ page }) => {
      await setup(page, { mobile: false, tapOutsideImageToTurn: false });
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
