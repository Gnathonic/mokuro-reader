import { inflateRawSync } from 'node:zlib';
import { test, expect, type Browser, type Page } from '@playwright/test';
import { gotoApp } from './helpers/app';
import { WebDavStub } from './helpers/webdav-stub';

/**
 * "Mark as read" counting pages not read in the app (#224), through the real
 * catalog: the ask-first sheet (a modal on a wide screen, a bottom sheet on a
 * phone), Count / Don't count, Undo back to the page it was on, the bulk
 * sheet from the series menu and "Mark as read up to here", the stats page's
 * "counted when marked read" lines with Recent Speed unmoved, and a credit
 * reaching another device through sync (a format-2 history segment).
 */

const STUB = 'http://stub.test';
const SERIES = 'Credit Series';
const SERIES_UUID = 'e2e-credit-series';
const VOL1 = 'e2e-credit-vol-1';
const VOL2 = 'e2e-credit-vol-2';
const PAGES = 60;
const CHARS = 100;
const MIN = 60_000;

async function device(
  browser: Browser,
  viewport = { width: 1280, height: 900 },
  stub?: WebDavStub
) {
  const context = await browser.newContext({ viewport });
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

/**
 * Two volumes of `PAGES` pages, `CHARS` characters each. Vol 1 was read here
 * up to page 40, one minute a page (100 chars/min, 40 min: a rough recent
 * speed), and its position is page 40.
 */
async function installSeries(page: Page) {
  await page.evaluate(
    async ({ SERIES, SERIES_UUID, VOL1, VOL2, PAGES, CHARS, MIN }) => {
      const { db } = await import('/src/lib/catalog/db.ts');
      await db.open();
      const canvas = document.createElement('canvas');
      canvas.width = 200;
      canvas.height = 300;
      canvas.getContext('2d')!.fillRect(0, 0, 200, 300);
      const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), 'image/png'));
      for (const [uuid, title] of [
        [VOL1, 'Vol 1'],
        [VOL2, 'Vol 2']
      ]) {
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
              lines: ['あ'.repeat(CHARS)]
            }
          ]
        }));
        const files: Record<string, File> = {};
        for (const p of pages)
          files[p.img_path] = new File([blob], p.img_path, { type: 'image/png' });
        await db.volumes.put({
          volume_uuid: uuid,
          series_uuid: SERIES_UUID,
          series_title: SERIES,
          volume_title: title,
          mokuro_version: '0.2.1',
          page_count: PAGES,
          character_count: PAGES * CHARS,
          page_char_counts: pages.map((_, i) => (i + 1) * CHARS),
          // A finished cover (typed, sized): the thumbnail pass would otherwise rewrite
          // the row a moment later, which re-creates every card and closes an open menu.
          thumbnail: new File([blob], 'thumb.png', { type: 'image/png' }),
          thumbnail_width: 200,
          thumbnail_height: 300
        });
        await db.volume_ocr.put({ volume_uuid: uuid, pages });
        await db.volume_files.put({ volume_uuid: uuid, files });
      }
      const { recordEvent } = await import('/src/lib/reading-history/record.ts');
      const { updateProgress } = await import('/src/lib/settings/volume-data.ts');
      const start = Date.now() - 2 * 60 * MIN;
      for (let p = 1; p <= 40; p++) {
        await recordEvent(
          {
            kind: 'page',
            volume: VOL1,
            first_page: p,
            last_page: p,
            page_chars: [CHARS],
            chars_before: (p - 1) * CHARS,
            dwell_ms: MIN,
            layout: 'single',
            orientation: 'portrait',
            viewport: { w: 400, h: 800 }
          },
          start + p * MIN
        );
      }
      updateProgress(VOL1, 40, 40 * CHARS);
    },
    { SERIES, SERIES_UUID, VOL1, VOL2, PAGES, CHARS, MIN }
  );
}

/** A volume's figures, and the recent speed, once the stats have counted. */
async function figures(page: Page, volume: string) {
  return page.evaluate(async (volume) => {
    const stats = await import('/src/lib/reading-history/stats-store.ts');
    const { volumesWithTrash } = await import('/src/lib/settings/volume-data.ts');
    stats.flushReadingStats();
    let state: Parameters<typeof stats.figuresFor>[0] | undefined;
    stats.readingStats.subscribe((s) => (state = s))();
    let records: Record<string, { progress: number; completed: boolean }> = {};
    volumesWithTrash.subscribe((v) => (records = v as never))();
    const f = stats.figuresFor(state!, volume, records[volume] as never);
    return {
      chars: f.chars,
      timeMs: f.timeMs,
      credit: f.credit,
      recentCpm: Math.round(state!.recent.charsPerMinute),
      progress: records[volume]?.progress ?? 0,
      completed: records[volume]?.completed ?? false
    };
  }, volume);
}

async function openSeries(page: Page) {
  await page.evaluate((title) => {
    window.location.hash = `#/series/${encodeURIComponent(title)}`;
  }, SERIES);
  await expect(page.locator(`#volume-menu-${VOL1}`)).toBeVisible({ timeout: 30000 });
}

async function cardMenu(page: Page, volume: string, item: string) {
  await page.locator(`#volume-menu-${volume}`).click();
  await page.getByRole('button', { name: item, exact: true }).click();
}

const sheet = (page: Page) => page.getByTestId('mark-read-sheet');
const snackbar = (page: Page) => page.getByTestId('snackbar');

test('the sheet counts the pages not read here; Undo returns to the page; the stats say so', async ({
  browser
}) => {
  const page = await device(browser);
  await installSeries(page);
  await expect.poll(async () => (await figures(page, VOL1)).chars).toBe(40 * CHARS);
  const before = await figures(page, VOL1);
  expect(before.recentCpm).toBe(100);
  await openSeries(page);

  // Escape cancels: nothing written, and the series page stays (no "go back").
  await cardMenu(page, VOL1, 'Mark as read');
  await expect(sheet(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toBeHidden();
  expect(await page.evaluate(() => window.location.hash)).toContain('#/series/');
  expect(await figures(page, VOL1)).toMatchObject({ progress: 40, completed: false });

  await cardMenu(page, VOL1, 'Mark as read');
  await expect(sheet(page)).toContainText('Mark “Vol 1” as read');
  await expect(sheet(page)).toContainText('20 of its 60 pages weren’t read in this app.');
  const estimate = page.getByTestId('mark-read-estimate');
  // 2,000 characters at the recent 100 chars/min, from 40 minutes of reading: rough.
  await expect(estimate).toContainText('20 pages · 2,000 characters · about 20 min');
  await expect(estimate).toContainText('At your recent speed, 100 chars/min (rough estimate).');
  // Wide screen: a centred modal, not a bottom sheet; Don't count has the focus.
  const box = (await sheet(page).boundingBox())!;
  expect(box.y).toBeGreaterThan(40);
  expect(box.y + box.height).toBeLessThan(900 - 40);
  await expect(page.getByTestId('mark-read-skip')).toBeFocused();
  await page.getByTestId('mark-read-count').click();
  await expect(sheet(page)).toBeHidden();
  await expect(snackbar(page)).toContainText(
    'Marked Vol 1 as read · counted 2,000 characters, 20 min'
  );
  await expect
    .poll(async () => (await figures(page, VOL1)).credit)
    .toEqual({ timeMs: 20 * MIN, chars: 2000 });
  expect(await figures(page, VOL1)).toMatchObject({
    chars: 60 * CHARS,
    timeMs: 60 * MIN,
    completed: true,
    // Speed never moves for what was counted.
    recentCpm: 100
  });

  // Undo: back to page 40, the credit taken back.
  await snackbar(page).getByRole('button', { name: 'Undo' }).click();
  await expect
    .poll(async () => await figures(page, VOL1))
    .toMatchObject({ progress: 40, completed: false, credit: { timeMs: 0, chars: 0 } });

  // Again, with a bound and a typed time.
  await cardMenu(page, VOL1, 'Mark as read');
  await page.getByRole('button', { name: /Adjust/ }).click();
  await page.getByTestId('mark-read-up-to').fill('50');
  await expect(estimate).toContainText('10 pages · 1,000 characters · about 10 min');
  await page.getByTestId('mark-read-minutes').fill('15');
  await expect(estimate).toContainText('10 pages · 1,000 characters · 15 min');
  await page.getByTestId('mark-read-count').click();
  await expect
    .poll(async () => (await figures(page, VOL1)).credit)
    .toEqual({ timeMs: 15 * MIN, chars: 1000 });

  // The stats page: the counted part named under the tiles, Recent Speed unmoved.
  await page.evaluate(() => (window.location.hash = '#/reading-speed'));
  await expect(page.getByTestId('credit-chars')).toHaveText('1,000 counted when marked read');
  await expect(page.getByTestId('credit-time')).toHaveText('15 min counted when marked read');
  const recent = page.locator('p', { hasText: 'Recent Speed' }).locator('..');
  await expect(recent).toContainText('100');
});

test('phone: a bottom sheet; the bulk sheet from the series menu and "up to here"; Don’t ask again', async ({
  browser
}) => {
  const page = await device(browser, { width: 390, height: 844 });
  await installSeries(page);
  await expect.poll(async () => (await figures(page, VOL1)).chars).toBe(40 * CHARS);
  await openSeries(page);

  // The series menu: every unfinished volume ticked.
  await page.locator('#series-menu').click();
  await page.getByRole('button', { name: 'Mark volumes as read…' }).click();
  await expect(sheet(page)).toContainText('Mark volumes as read');
  const list = page.getByTestId('mark-read-list');
  await expect(list).toContainText('Vol 1');
  await expect(list).toContainText('20 of 60 pages not read here');
  await expect(list).toContainText('60 pages not read here');
  // A bottom sheet: full width, flush with the bottom of the screen.
  const box = (await sheet(page).boundingBox())!;
  expect(Math.round(box.width)).toBe(390);
  expect(Math.round(box.y + box.height)).toBe(844);
  await expect(page.getByTestId('mark-read-estimate')).toContainText(
    '2 volumes · 80 pages · 8,000 characters · about 1 h 20 min'
  );
  // Only Vol 1 this time.
  await list.getByText('Vol 2').click();
  await expect(page.getByTestId('mark-read-estimate')).toContainText(
    '1 volume · 20 pages · 2,000 characters · about 20 min'
  );
  await page.getByTestId('mark-read-count').click();
  await expect(snackbar(page)).toContainText('Marked 1 volume as read');
  await expect.poll(async () => (await figures(page, VOL1)).completed).toBe(true);
  expect((await figures(page, VOL2)).completed).toBe(false);

  // "Up to here" on Vol 2: Vol 1 is read, so only Vol 2 is offered. Don't count.
  await cardMenu(page, VOL2, 'Mark as read up to here');
  await expect(list).not.toContainText('Vol 1');
  await page.getByTestId('mark-read-skip').click();
  await expect.poll(async () => (await figures(page, VOL2)).completed).toBe(true);
  expect((await figures(page, VOL2)).credit).toEqual({ timeMs: 0, chars: 0 });

  // Un-read Vol 1: the credit goes with the mark.
  await cardMenu(page, VOL1, 'Mark as unread');
  await expect(snackbar(page)).toContainText('Marked Vol 1 as unread · removed 20 min counted');
  await expect.poll(async () => (await figures(page, VOL1)).credit.chars).toBe(0);

  // Don't ask again: the answer becomes the setting, and the next mark asks no more.
  await cardMenu(page, VOL1, 'Mark as read');
  await page.getByTestId('mark-read-dont-ask').check();
  await expect(sheet(page)).toContainText('Change this in Settings → Reader → Reading timer.');
  await page.getByTestId('mark-read-count').click();
  await expect.poll(async () => (await figures(page, VOL1)).credit.chars).toBe(2000);
  const policy = await page.evaluate(
    () => JSON.parse(localStorage.getItem('tracking-data') || '{}').markRead?.unread
  );
  expect(policy).toBe('count');
  await cardMenu(page, VOL1, 'Mark as unread');
  await expect.poll(async () => (await figures(page, VOL1)).completed).toBe(false);
  await cardMenu(page, VOL1, 'Mark as read');
  await expect(snackbar(page)).toContainText('Marked Vol 1 as read · counted');
  await expect(sheet(page)).toBeHidden();
});

test('a credit reaches another device through sync, and counts the same there', async ({
  browser
}) => {
  const stub = new WebDavStub();
  const laptop = await device(browser, undefined, stub);
  const phone = await device(browser, undefined, stub);
  await installSeries(laptop);
  await expect.poll(async () => (await figures(laptop, VOL1)).chars).toBe(40 * CHARS);
  await openSeries(laptop);
  await cardMenu(laptop, VOL1, 'Mark as read');
  await laptop.getByTestId('mark-read-count').click();
  await expect
    .poll(async () => (await figures(laptop, VOL1)).credit)
    .toEqual({ timeMs: 20 * MIN, chars: 2000 });
  await sync(laptop);
  // The month segment that holds the credit is format 2, with a kind-6 row.
  const segments = [...stub.files.entries()]
    .filter(([path, entry]) => path.endsWith('.events') && !entry.dir)
    .map(([, entry]) => JSON.parse(inflateRawSync(entry.body).toString('utf8')));
  const credited = segments.filter((s) => s.rows.some((row: unknown[]) => row[0] === 6));
  expect(credited.map((s) => s.format)).toEqual([2]);
  await sync(phone);
  await expect
    .poll(async () => (await figures(phone, VOL1)).credit, { timeout: 15000 })
    .toEqual({ timeMs: 20 * MIN, chars: 2000 });
  expect((await figures(phone, VOL1)).chars).toBe(60 * CHARS);
});
