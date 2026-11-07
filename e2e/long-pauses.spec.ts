import { test, expect, type Browser, type Page } from '@playwright/test';
import { gotoApp } from './helpers/app';
import { WebDavStub } from './helpers/webdav-stub';

/**
 * Long pauses (phase 3b) through the REAL reader, settings and sync. The page
 * clock is Playwright's: time flows normally, and `fastForward` carries a view
 * past its cap the way a reader who walked away would.
 *
 * - At the cap the timer stops and a prompt says so. Unanswered (a page turn,
 *   a hidden tab, a pause click, leaving) or closed, the view counts up to its
 *   cap. "Still reading" counts all of it and the timer runs on; two minutes
 *   past the cap the copy says how long the page was open and offers Keep /
 *   Count all / Count none. Every answer splits the view.
 * - Under the automatic cutoff "Still reading" widens `k`, and the rest of the
 *   view runs on the wider cap; the settings card shows the stretch and resets it.
 * - "Don't ask again" turns the prompt off; that setting syncs, newest wins.
 * - Answers sync; the latest answer wins on every device.
 */

const STUB = 'http://stub.test';
const SERIES = 'Pause Series';
const SERIES_UUID = 'e2e-pause-series';
const VOL = 'e2e-pause-volume';
const VOL_1 = VOL;
const PAGES = 6;

async function device(
  browser: Browser,
  opts: { stub?: WebDavStub; clock?: boolean } = {}
): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  // Before the app loads, so every timer it arms runs on the page clock.
  if (opts.clock) await page.clock.install();
  if (opts.stub) await page.route(`${STUB}/**`, opts.stub.handle);
  await gotoApp(page);
  if (opts.stub) {
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

/** Install a volume whose every page holds `charsPerPage` characters of OCR text. */
async function installVolume(page: Page, charsPerPage: number, VOL = VOL_1) {
  await page.evaluate(
    async ({ SERIES, SERIES_UUID, VOL, PAGES, charsPerPage }) => {
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
            lines: ['あ'.repeat(charsPerPage)],
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
        character_count: PAGES * charsPerPage,
        page_char_counts: pages.map((_, i) => (i + 1) * charsPerPage),
        thumbnail: new File([blob], 'thumb.webp', { type: 'image/webp' })
      });
      await db.volume_ocr.put({ volume_uuid: VOL, pages });
      await db.volume_files.put({ volume_uuid: VOL, files });
      const { updateSetting } = await import('/src/lib/settings/index.ts');
      updateSetting('continuousScroll', false);
      updateSetting('singlePageView', 'single');
      updateSetting('showTimer', true);
    },
    { SERIES, SERIES_UUID, VOL, PAGES, charsPerPage }
  );
}

function timerOf(page: Page) {
  return page.locator('button.reader-hud', { hasText: 'Minutes read' });
}

/** Open the volume in the reader and wait until its first view is open. */
async function openReader(page: Page, VOL = VOL_1) {
  await page.evaluate(
    ({ SERIES_UUID, VOL }) => {
      window.location.hash = `#/reader/${SERIES_UUID}/${VOL}`;
    },
    { SERIES_UUID, VOL }
  );
  await expect(timerOf(page)).toContainText('Active', { timeout: 45000 });
}

/** The counted state the reader's pause timer is armed from (forces the pending count). */
async function statsState(page: Page) {
  return page.evaluate(async () => {
    const stats = await import('/src/lib/reading-history/stats-store.ts');
    stats.flushReadingStats();
    let state: { pace: number | null; idle: { k: number; overrideMs: number | null } } | undefined;
    stats.readingStats.subscribe((s) => (state = s))();
    return { pace: state!.pace, k: state!.idle.k, overrideMs: state!.idle.overrideMs };
  });
}

/** This volume's figures, once the stats have counted. */
async function figures(page: Page) {
  return page.evaluate(async (VOL) => {
    const stats = await import('/src/lib/reading-history/stats-store.ts');
    const { volumesWithTrash } = await import('/src/lib/settings/volume-data.ts');
    stats.flushReadingStats();
    let state: Parameters<typeof stats.figuresFor>[0] | undefined;
    stats.readingStats.subscribe((s) => (state = s))();
    let records: Record<string, never> = {};
    volumesWithTrash.subscribe((v) => (records = v as never))();
    return stats.figuresFor(state!, VOL, records[VOL]);
  }, VOL);
}

async function askOf(page: Page) {
  return page.evaluate(async () => {
    const { askOnLongPause } = await import('/src/lib/settings/tracking-data.ts');
    let value: boolean | null = null;
    askOnLongPause.subscribe((v) => (value = v))();
    return value;
  });
}

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

async function livePauseOf(page: Page) {
  return page.evaluate(async () => {
    const { livePause } = await import('/src/lib/reading-history/pause-watch.ts');
    let value: unknown = null;
    livePause.subscribe((v) => (value = v))();
    return value;
  });
}

/** The prompt's copy, without its buttons. */
function copyOf(page: Page) {
  return page.getByTestId('long-pause').locator('p');
}

/** A manual cutoff of `minutes`, set where the reader reads it from. */
async function setCutoff(page: Page, minutes: number) {
  await page.evaluate(async (minutes) => {
    const { setIdleOverride } = await import('/src/lib/settings/tracking-data.ts');
    setIdleOverride(minutes);
  }, minutes);
  await expect.poll(async () => (await statsState(page)).overrideMs).toBe(minutes * 60_000);
}

test('at the cap the timer stops and the prompt says so; each answer counts as it says', async ({
  browser
}) => {
  test.setTimeout(150_000);
  const page = await device(browser, { clock: true });
  await installVolume(page, 20);
  // A 1-minute manual cutoff: every view's cap, with or without a pace.
  await setCutoff(page, 1);
  await openReader(page);
  const timer = timerOf(page);
  const prompt = page.getByTestId('long-pause');
  await expect(prompt).toBeHidden();
  const timeMs = async () => (await figures(page)).timeMs;

  // Page 1 stays open past its cap: the timer stops, and the prompt says so.
  await page.clock.fastForward('01:05');
  await expect(copyOf(page)).toHaveText('No page turn for 1 min, so the timer stopped.');
  await expect(timer).toContainText('Idle');
  await expect(timer).toContainText(/Minutes read: 1\b/);
  await expect(prompt.getByRole('button')).toHaveText(['✕', 'Still reading', 'Don’t ask again']);
  await expect(prompt.getByRole('button', { name: 'Close', exact: true })).toBeVisible();

  // Close: the view counts up to the cap and the timer starts again from now.
  await prompt.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(prompt).toBeHidden();
  await expect(timer).toContainText('Active');
  await expect.poll(timeMs, { timeout: 15000 }).toBe(60_000);

  // "Still reading" counts the whole view and the timer goes on. Under a fixed
  // cutoff nothing widens; the snackbar says where the cutoff is set.
  await page.clock.fastForward('01:05');
  await expect(copyOf(page)).toHaveText('No page turn for 1 min, so the timer stopped.');
  await prompt.getByRole('button', { name: 'Still reading', exact: true }).click();
  await expect(prompt).toBeHidden();
  await expect(
    page.getByText(
      'The timer stops after 1 min on every page. Change it in Settings → Reading timer.'
    )
  ).toBeVisible();
  await expect(timer).toContainText('Active');
  await expect.poll(timeMs, { timeout: 15000 }).toBeGreaterThanOrEqual(125_000);
  expect(await timeMs()).toBeLessThan(135_000);
  expect((await statsState(page)).k).toBe(3);
  await expect(timer).toContainText(/Minutes read: 2\b/);

  // Away: two minutes past the cap the copy says how long the page was open.
  await page.clock.fastForward('04:00');
  await expect(copyOf(page)).toHaveText('This page was open 4 min. 1 min counted.');
  await expect(prompt.getByRole('button')).toHaveText([
    '✕',
    'Keep 1 min',
    'Count all 4 min',
    'Count none',
    'Don’t ask again'
  ]);
  // "Count none": none of the four minutes count.
  const beforeNone = await timeMs();
  await prompt.getByRole('button', { name: 'Count none', exact: true }).click();
  await expect(prompt).toBeHidden();
  await expect(timer).toContainText('Active');
  await expect(timer).toContainText(/Minutes read: 2\b/);
  await page.waitForTimeout(300);

  // Page 2, away: "Count all" counts every minute it was open. The turn ends
  // page 1's short reopened view, recorded after the "Count none" one.
  await page.keyboard.press('ArrowLeft');
  await expect.poll(timeMs, { timeout: 15000 }).toBeGreaterThan(beforeNone);
  const beforeAll = await timeMs();
  expect(beforeAll).toBeLessThan(beforeNone + 2000);
  await page.clock.fastForward('04:00');
  await expect(copyOf(page)).toHaveText('This page was open 4 min. 1 min counted.');
  await prompt.getByRole('button', { name: 'Count all 4 min', exact: true }).click();
  await expect(prompt).toBeHidden();
  await expect.poll(timeMs, { timeout: 15000 }).toBeGreaterThanOrEqual(beforeAll + 240_000);
  expect(await timeMs()).toBeLessThan(beforeAll + 250_000);
  await expect(timer).toContainText(/Minutes read: 6\b/);

  // Page 3, away: "Keep" counts up to the cap.
  await page.keyboard.press('ArrowLeft');
  await expect.poll(timeMs).toBeGreaterThan(beforeAll + 240_000);
  const beforeKeep = await timeMs();
  await page.clock.fastForward('04:00');
  await expect(copyOf(page)).toHaveText('This page was open 4 min. 1 min counted.');
  await prompt.getByRole('button', { name: 'Keep 1 min', exact: true }).click();
  await expect(prompt).toBeHidden();
  await expect.poll(timeMs, { timeout: 15000 }).toBe(beforeKeep + 60_000);

  // Page 4: the reader turns on without answering. The prompt goes, and the
  // pause counts up to the cap — never the minutes past it.
  await page.keyboard.press('ArrowLeft');
  await expect.poll(timeMs).toBeGreaterThan(beforeKeep + 60_000);
  const beforeTurn = await timeMs();
  await page.clock.fastForward('03:00');
  await expect(prompt).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(prompt).toBeHidden();
  await expect.poll(timeMs, { timeout: 15000 }).toBe(beforeTurn + 60_000);

  // Answers are history: a reload counts the same.
  const total = await timeMs();
  await page.evaluate(() => (window.location.hash = '#/catalog'));
  await page.reload();
  await expect.poll(timeMs, { timeout: 30000 }).toBeGreaterThanOrEqual(total);
  expect(await timeMs()).toBeLessThan(total + 2000);
});

test('"Still reading" widens the automatic cutoff; unanswered, a pause counts up to it', async ({
  browser
}) => {
  const page = await device(browser, { clock: true });
  await installVolume(page, 200);
  // A pace: 30 views of another volume at 200 ms per character.
  await page.evaluate(async () => {
    const { recordEvent } = await import('/src/lib/reading-history/record.ts');
    for (let i = 0; i < 30; i++) {
      await recordEvent({
        kind: 'page',
        volume: 'e2e-pause-pace',
        first_page: i + 1,
        last_page: i + 1,
        page_chars: [300],
        chars_before: i * 300,
        dwell_ms: 60_000,
        layout: 'single',
        orientation: 'portrait',
        viewport: { w: 400, h: 800 }
      });
    }
  });
  await expect.poll(async () => (await statsState(page)).pace, { timeout: 15000 }).toBe(200);
  await openReader(page);
  const prompt = page.getByTestId('long-pause');

  // 200 characters × 200 ms = 40 s expected; × k = 3 → a 2-minute cap.
  await page.clock.fastForward('02:01');
  await expect(copyOf(page)).toHaveText('No page turn for 2 min, so the timer stopped.');
  await prompt.getByRole('button', { name: 'Still reading', exact: true }).click();
  // k fits this view with headroom: 121 s × 1.5 / 40 s = 4.5, up to a half step = 5,
  // so pages like this one now get 5 × 40 s = 200 s.
  await expect(
    page.getByText('Pages like this now get about 3 min before the timer stops.')
  ).toBeVisible();
  await expect.poll(async () => (await statsState(page)).k, { timeout: 15000 }).toBe(5);

  // The rest of the view runs on the wider cap: no prompt at 125 s…
  await page.clock.fastForward('02:05');
  expect(await livePauseOf(page)).toBeNull();
  await expect(prompt).toBeHidden();
  await expect(timerOf(page)).toContainText('Active');
  // …and past it, the prompt says so again.
  await page.clock.fastForward('01:20');
  await expect(copyOf(page)).toHaveText('No page turn for 3 min, so the timer stopped.');

  // (200 s), not the typical time old builds counted (40 s, held at the 60 s floor).
  // (200 s), not the 40 s a page like this typically takes.
  await page.evaluate(() => (window.location.hash = '#/catalog'));
  await expect(prompt).toBeHidden();
  await expect
    .poll(async () => (await figures(page)).timeMs, { timeout: 15000 })
    .toBeGreaterThan(0);
  const volume = await figures(page);
  // Page 1 credited once though the view was split; ~121 s in full + the 200 s cap.
  expect(volume.chars).toBe(200);
  expect(volume.timeMs).toBeGreaterThanOrEqual(321_000);
  expect(volume.timeMs).toBeLessThan(330_000);

  // The settings say how far the answers stretched the automatic cutoff; Reset undoes it.
  const settings = await openTimerSettings(page);
  await expect(settings.getByLabel('Stop the timer after')).toHaveValue('auto');
  const stretch = settings.getByText(
    'Your “Still reading” answers made the automatic cutoff 1.7× longer.'
  );
  await expect(stretch).toBeVisible();
  // The Reset beside that line (the drawer's own Reset resets every setting).
  await stretch.locator('xpath=..').getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(stretch).toBeHidden();
  await expect.poll(async () => (await statsState(page)).k, { timeout: 15000 }).toBe(3);
});

test('"Don’t ask again" turns the prompt off; the setting syncs, the latest wins', async ({
  browser
}) => {
  test.setTimeout(150_000);
  const stub = new WebDavStub();
  const laptop = await device(browser, { stub, clock: true });
  const phone = await device(browser, { stub });
  await installVolume(laptop, 20);
  await setCutoff(laptop, 1);
  await openReader(laptop);
  const timer = timerOf(laptop);
  const prompt = laptop.getByTestId('long-pause');
  const timeMs = async () => (await figures(laptop)).timeMs;

  await laptop.clock.fastForward('01:05');
  await expect(copyOf(laptop)).toHaveText('No page turn for 1 min, so the timer stopped.');
  await prompt.getByRole('button', { name: 'Don’t ask again', exact: true }).click();
  await expect(prompt).toBeHidden();
  await expect(
    laptop.getByText('The reader won’t ask again. Turn it back on in Settings → Reading timer.')
  ).toBeVisible();
  expect(await askOf(laptop)).toBe(false);
  // It keeps the cutoff for this page, and the timer starts again from now.
  await expect(timer).toContainText('Active');
  await expect.poll(timeMs, { timeout: 15000 }).toBe(60_000);

  // The next long pause is not asked about: the timer just stops at the cap…
  await laptop.clock.fastForward('01:05');
  await expect(timer).toContainText('Idle');
  expect(await livePauseOf(laptop)).toBeNull();
  await expect(prompt).toBeHidden();
  // …and the pause counts up to it.
  await laptop.keyboard.press('ArrowLeft');
  await expect.poll(timeMs, { timeout: 15000 }).toBe(120_000);

  // The setting shows off, with the cutoff the user chose.
  const settings = await openTimerSettings(laptop);
  const ask = settings.getByRole('checkbox', { name: 'Ask if I’m still reading' });
  await expect(ask).not.toBeChecked();
  await expect(settings.getByLabel('Stop the timer after')).toHaveValue('1');

  // It reaches the phone with the next sync…
  await sync(laptop);
  await sync(phone);
  await expect.poll(() => askOf(phone), { timeout: 15000 }).toBe(false);
  const phoneSettings = await openTimerSettings(phone);
  const phoneAsk = phoneSettings.getByRole('checkbox', { name: 'Ask if I’m still reading' });
  await expect(phoneAsk).not.toBeChecked();
  await expect(phoneSettings.getByLabel('Stop the timer after')).toHaveValue('1');

  // …and turned back on there, that newer choice comes back to the laptop.
  // The toggle's input is visually hidden: a user clicks its label.
  await phoneSettings.getByText('Ask if I’m still reading', { exact: true }).click();
  await expect(phoneAsk).toBeChecked();
  expect(await askOf(phone)).toBe(true);
  await sync(phone);
  await sync(laptop);
  await expect.poll(() => askOf(laptop), { timeout: 15000 }).toBe(true);
  await expect(ask).toBeChecked();
});

test('answers sync between devices; the latest answer wins', async ({ browser }) => {
  const stub = new WebDavStub();
  const laptop = await device(browser, { stub });
  const phone = await device(browser, { stub });

  // The laptop left a page open 10 minutes (no pace: a 5-minute cap) and
  // answered "count none".
  const target = await laptop.evaluate(async (VOL) => {
    const { recordEvent, recordResolve } = await import('/src/lib/reading-history/record.ts');
    const { updateProgress } = await import('/src/lib/settings/volume-data.ts');
    const event = await recordEvent({
      kind: 'page',
      volume: VOL,
      first_page: 1,
      last_page: 1,
      page_chars: [300],
      chars_before: 0,
      dwell_ms: 600_000,
      layout: 'single',
      orientation: 'portrait',
      viewport: { w: 400, h: 800 }
    });
    updateProgress(VOL, 1, 300);
    const target: [string, number] = [event!.device, event!.seq];
    await recordResolve(VOL, target, 'none');
    return target;
  }, VOL);
  await sync(laptop);
  await sync(phone);

  await expect
    .poll(async () => (await figures(phone)).timeMs, { timeout: 15000 })
    .toBe((await figures(laptop)).timeMs);
  expect(await figures(phone)).toMatchObject({ timeMs: 0, chars: 300 });

  // Changed later on the laptop: every device takes the newer answer.
  await laptop.evaluate(
    async ({ VOL, target }) => {
      const { recordResolve } = await import('/src/lib/reading-history/record.ts');
      await recordResolve(VOL, target, 'full');
    },
    { VOL, target }
  );
  await sync(laptop);
  await sync(phone);
  await expect.poll(async () => (await figures(phone)).timeMs, { timeout: 15000 }).toBe(600_000);
  expect((await figures(laptop)).timeMs).toBe(600_000);
});

test('the reader arms its pause timer on the real clock without error', async ({ browser }) => {
  // The other reader tests run on Playwright's clock, whose timers are plain
  // functions; the native ones throw when called off `window`.
  const page = await device(browser);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await installVolume(page, 20);
  await openReader(page);
  await page.keyboard.press('ArrowLeft');
  await expect(timerOf(page)).toContainText('Active');
  expect(errors.filter((e) => /Illegal invocation|setTimeout|clearTimeout/i.test(e))).toEqual([]);
});

test('the prompt goes when the view ends without a page turn, and the pause counts its cap', async ({
  browser
}) => {
  const page = await device(browser, { clock: true });
  const OTHER = 'e2e-pause-volume-2';
  await installVolume(page, 20);
  await installVolume(page, 20, OTHER);
  await setCutoff(page, 1);
  await openReader(page);
  const timer = timerOf(page);
  const prompt = page.getByTestId('long-pause');
  const setHidden = (hidden: boolean) =>
    page.evaluate((hidden) => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => (hidden ? 'hidden' : 'visible')
      });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);

  // A hidden tab ends the view: the prompt goes, unanswered.
  await page.clock.fastForward('01:05');
  await expect(copyOf(page)).toHaveText('No page turn for 1 min, so the timer stopped.');
  await setHidden(true);
  await expect(prompt).toBeHidden();
  expect(await livePauseOf(page)).toBeNull();
  await setHidden(false);
  await expect(timer).toContainText('Active');

  // So does the timer's pause click.
  await page.clock.fastForward('01:05');
  await expect(prompt).toBeVisible();
  await timer.click();
  await expect(timer).toContainText('Paused');
  await expect(prompt).toBeHidden();
  expect(await livePauseOf(page)).toBeNull();
  await page.keyboard.press('ArrowLeft');
  await expect(timer).toContainText('Active');

  // And leaving the reader: the next volume opens with no prompt carried over.
  await page.clock.fastForward('01:05');
  await expect(prompt).toBeVisible();
  await page.evaluate(() => (window.location.hash = '#/catalog'));
  await expect(prompt).toBeHidden();
  expect(await livePauseOf(page)).toBeNull();
  await openReader(page, OTHER);
  expect(await livePauseOf(page)).toBeNull();
  await expect(prompt).toBeHidden();
  await page.evaluate(() => (window.location.hash = '#/catalog'));

  // Each of the three pauses counts up to the 1-minute cap.
  await expect.poll(async () => (await figures(page)).timeMs, { timeout: 15000 }).toBe(180_000);
});
