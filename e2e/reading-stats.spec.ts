import { test, expect, type Browser, type Page } from '@playwright/test';
import { gotoApp } from './helpers/app';
import { WebDavStub } from './helpers/webdav-stub';

/**
 * Reading stats from history (phase 3a) through the REAL reader and sync:
 * time and characters come from the views the reader records, a fast flip
 * through pages is skimmed (not read), the reader timer runs on the same
 * clock and pauses, and two devices that share a server compute the same
 * figures and share the "Stop the timer after" setting. A page left open past
 * that cutoff, unanswered, counts up to the cutoff.
 */

const STUB = 'http://stub.test';
const SERIES = 'Stats Series';
const SERIES_UUID = 'e2e-stats-series';
const VOL = 'e2e-stats-volume';
const PAGES = 12;
const CHARS_PER_PAGE = 20;

async function device(browser: Browser, stub?: WebDavStub): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  if (stub) await page.route(`${STUB}/**`, stub.handle);
  await gotoApp(page);
  if (stub) {
    await page.evaluate(async (serverUrl) => {
      const { providerManager } = await import('/src/lib/util/sync/provider-manager.ts');
      const provider = await providerManager.getOrLoadProvider('webdav');
      await provider.login({ serverUrl, username: '', password: '' });
      await providerManager.setCurrentProvider(provider);
    }, STUB);
  }
  return page;
}

async function sync(page: Page) {
  const result = await page.evaluate(async () => {
    const { unifiedCloudManager } = await import('/src/lib/util/sync/unified-cloud-manager.ts');
    await unifiedCloudManager.fetchAllCloudVolumes();
    return unifiedCloudManager.syncProgress({ silent: false });
  });
  expect(result.succeeded).toBe(1);
}

/** Install a volume whose every page holds `CHARS_PER_PAGE` characters of OCR text. */
async function installVolume(page: Page) {
  await page.evaluate(
    async ({ SERIES, SERIES_UUID, VOL, PAGES, CHARS_PER_PAGE }) => {
      const { db } = await import('/src/lib/catalog/db.ts');
      await db.open();
      const canvas = document.createElement('canvas');
      canvas.width = 200;
      canvas.height = 300;
      canvas.getContext('2d')!.fillRect(0, 0, 200, 300);
      const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), 'image/png'));
      const pages = Array.from({ length: PAGES }, (_, i) => ({
        version: '0.2.1',
        img_width: 200,
        img_height: 300,
        img_path: `${String(i + 1).padStart(3, '0')}.png`,
        blocks: [
          {
            box: [20, 20, 60, 280],
            vertical: true,
            font_size: 12,
            lines: ['あ'.repeat(CHARS_PER_PAGE)],
            lines_coords: [
              [
                [40, 20],
                [60, 20],
                [60, 280],
                [40, 280]
              ]
            ]
          }
        ]
      }));
      const files: Record<string, File> = {};
      for (const p of pages)
        files[p.img_path] = new File([blob], p.img_path, { type: 'image/png' });
      await db.volumes.put({
        volume_uuid: VOL,
        series_uuid: SERIES_UUID,
        series_title: SERIES,
        volume_title: 'Vol 1',
        mokuro_version: '0.2.1',
        page_count: PAGES,
        character_count: PAGES * CHARS_PER_PAGE,
        page_char_counts: pages.map((_, i) => (i + 1) * CHARS_PER_PAGE),
        thumbnail: new File([blob], 'thumb.webp', { type: 'image/webp' })
      });
      await db.volume_ocr.put({ volume_uuid: VOL, pages });
      await db.volume_files.put({ volume_uuid: VOL, files });
      const { updateSetting } = await import('/src/lib/settings/index.ts');
      updateSetting('continuousScroll', false);
      updateSetting('singlePageView', 'single');
      updateSetting('showTimer', true);
    },
    { SERIES, SERIES_UUID, VOL, PAGES, CHARS_PER_PAGE }
  );
}

/** This volume's figures and the lifetime totals, once the stats have counted. */
async function figures(page: Page) {
  return page.evaluate(async (VOL) => {
    const stats = await import('/src/lib/reading-history/stats-store.ts');
    const { totalStats } = await import('/src/lib/reading-history/total-stats.ts');
    const { volumesWithTrash } = await import('/src/lib/settings/volume-data.ts');
    stats.flushReadingStats();
    let state: Parameters<typeof stats.figuresFor>[0] | undefined;
    stats.readingStats.subscribe((s) => (state = s))();
    let records: Record<string, never> = {};
    volumesWithTrash.subscribe((v) => (records = v as never))();
    let totals: { charsSkipped: number } | undefined;
    totalStats.subscribe((t) => (totals = t))();
    return {
      volume: stats.figuresFor(state!, VOL, records[VOL]),
      skippedTotal: totals!.charsSkipped
    };
  }, VOL);
}

test('reading is counted from the views the reader records; a fast flip is skimmed', async ({
  browser
}) => {
  const page = await device(browser);
  await installVolume(page);
  await page.evaluate(
    ({ SERIES_UUID, VOL }) => {
      window.location.hash = `#/reader/${SERIES_UUID}/${VOL}`;
    },
    { SERIES_UUID, VOL }
  );
  await expect(page.locator('[data-page-index="0"]')).toBeVisible({ timeout: 45000 });

  // The timer runs on the same clock: active while a view is open.
  const timer = page.locator('button.reader-hud', { hasText: 'Minutes read' });
  await expect(timer).toContainText('Active');

  // Pages 1 and 2 read at a reading pace (20 chars in 2.5 s = 480 cpm).
  await page.waitForTimeout(2500);
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(2500);
  // Pages 3–7 flipped past (20 chars in ~0.15 s ≫ 1500 cpm), then page 8 read.
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(2500);

  // Pausing ends the view; the next page resumes.
  await timer.click();
  await expect(timer).toContainText('Paused');
  await page.keyboard.press('ArrowLeft');
  await expect(timer).toContainText('Active');
  await page.waitForTimeout(2500); // page 9, read

  // Leaving the reader ends the last view.
  await page.evaluate(() => (window.location.hash = '#/catalog'));
  await expect
    .poll(async () => (await figures(page)).volume.chars, { timeout: 15000 })
    .toBe(3 * CHARS_PER_PAGE + CHARS_PER_PAGE);
  const result = await figures(page);
  // Pages 1, 2, 8 and 9 read; 3–7 skimmed, apart.
  expect(result.volume.skippedChars).toBe(5 * CHARS_PER_PAGE);
  expect(result.skippedTotal).toBe(5 * CHARS_PER_PAGE);
  // About 8 s of reading: the dwell the reader saw, nothing invented.
  expect(result.volume.timeMs).toBeGreaterThan(7000);
  expect(result.volume.timeMs).toBeLessThan(20000);
});

/** The settings drawer with its Reader section open, from the catalog's navbar. */
async function openTimerSettings(page: Page) {
  await page.evaluate(() => (window.location.hash = '#/catalog'));
  // The navbar's settings button carries no label; it follows Progress Tracker.
  await page.locator('button[title="Progress Tracker"] + button').click();
  const drawer = page.locator('#settings');
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: 'Reader', exact: true }).click();
  await expect(drawer.getByRole('heading', { name: 'Reading timer', exact: true })).toBeVisible();
  return drawer;
}

test('two devices compute the same figures and share the idle cutoff', async ({ browser }) => {
  const stub = new WebDavStub();
  const laptop = await device(browser, stub);
  const phone = await device(browser, stub);

  // The laptop stops the timer after 15 minutes, in its settings.
  const settings = await openTimerSettings(laptop);
  const stopAfter = settings.getByLabel('Stop the timer after');
  await expect(stopAfter).toHaveValue('auto');
  await stopAfter.selectOption({ label: '15 minutes' });
  await expect(stopAfter).toHaveValue('15');

  // It has a pace (30 views of another volume at 200 ms per character), reads
  // three pages, and leaves a fourth open 20 minutes without answering: that
  // pause counts up to the cutoff (15 min), not the minute a page takes.
  await laptop.evaluate(async (VOL) => {
    const { recordEvent } = await import('/src/lib/reading-history/record.ts');
    const { updateProgress } = await import('/src/lib/settings/volume-data.ts');
    const view = (volume: string, p: number, dwell_ms: number) =>
      recordEvent({
        kind: 'page',
        volume,
        first_page: p,
        last_page: p,
        page_chars: [300],
        chars_before: (p - 1) * 300,
        dwell_ms,
        layout: 'single',
        orientation: 'portrait',
        viewport: { w: 400, h: 800 }
      });
    for (let p = 1; p <= 30; p++) await view('e2e-stats-pace', p, 60_000);
    for (let p = 1; p <= 4; p++) {
      await view(VOL, p, p === 4 ? 20 * 60_000 : 60_000);
      updateProgress(VOL, p, p * 300);
    }
  }, VOL);
  await expect
    .poll(async () => (await figures(laptop)).volume.timeMs, { timeout: 15000 })
    .toBe(3 * 60_000 + 15 * 60_000);
  await sync(laptop);
  await sync(phone);

  // The phone counts the same, which it can only do on the laptop's cutoff
  // (automatic would cap that pause at 3 × 60 s).
  await expect
    .poll(async () => (await figures(phone)).volume, { timeout: 15000 })
    .toEqual((await figures(laptop)).volume);
  expect((await figures(phone)).volume).toMatchObject({ timeMs: 18 * 60_000, chars: 1200 });
  const phoneSettings = await openTimerSettings(phone);
  await expect(phoneSettings.getByLabel('Stop the timer after')).toHaveValue('15');
});
