import { test, expect, type Browser, type Page } from '@playwright/test';
import { gotoApp } from './helpers/app';
import { WebDavStub } from './helpers/webdav-stub';

/**
 * Long pauses (phase 3b) through the REAL reader, stats page and sync. The
 * page clock is Playwright's: time flows normally, and `fastForward` carries a
 * view past its cap the way a reader who walked away would.
 *
 * - At the cap a prompt asks; "Still reading" counts the time in full and the
 *   timer runs on; away, it says how long the page has been open. An answer
 *   splits the view, so a later page turn loses nothing.
 * - Unanswered (a page turn), the pause counts typical time and waits on the
 *   reading-speed page, provisional, where it can be answered later.
 * - "Always do this" appears once three pauses are answered; the default then
 *   answers views that reach the cap, with no prompt.
 * - Without an override, "Still reading" widens `k`, and the rest of the view
 *   runs on the wider cap.
 * - Answers and the default sync; the latest answer wins on every device.
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

/** The review list as the stats page sees it: every pause's answer, newest first. */
async function review(page: Page) {
  return page.evaluate(async () => {
    const stats = await import('/src/lib/reading-history/stats-store.ts');
    const { pauseReview } = await import('/src/lib/reading-history/pause-review.ts');
    stats.flushReadingStats();
    let state:
      | { pauses: Array<{ answer: string | null }>; unanswered: number; answered: number }
      | undefined;
    pauseReview.subscribe((s) => (state = s))();
    return {
      unanswered: state!.unanswered,
      answered: state!.answered,
      answers: state!.pauses.map((p) => p.answer)
    };
  });
}

async function pauseDefaultOf(page: Page) {
  return page.evaluate(async () => {
    const { pauseDefault } = await import('/src/lib/settings/tracking-data.ts');
    let value: string | null = null;
    pauseDefault.subscribe((v) => (value = v))();
    return value;
  });
}

async function livePauseOf(page: Page) {
  return page.evaluate(async () => {
    const { livePause } = await import('/src/lib/reading-history/pause-watch.ts');
    let value: unknown = null;
    livePause.subscribe((v) => (value = v))();
    return value;
  });
}

test('a long pause is asked about at its cap; unanswered it waits on the stats page', async ({
  browser
}) => {
  const page = await device(browser, { clock: true });
  await installVolume(page, 20);
  // A 1-minute manual cutoff: every view's cap, with or without a pace.
  await page.evaluate(async () => {
    const { setIdleOverride } = await import('/src/lib/settings/tracking-data.ts');
    setIdleOverride(1);
  });
  await expect.poll(async () => (await statsState(page)).overrideMs).toBe(60_000);
  await openReader(page);
  const timer = timerOf(page);
  const prompt = page.getByTestId('long-pause');
  await expect(prompt).toBeHidden();

  // Page 1 stays open past its cap: the prompt asks right then.
  await page.clock.fastForward('01:05');
  await expect(prompt).toContainText('Still reading?');
  // "Always do this" is not offered before three answers.
  await expect(prompt.getByRole('checkbox')).toHaveCount(0);
  await prompt.getByRole('button', { name: /^Still reading/ }).click();
  await expect(prompt).toBeHidden();
  // The override is the cap, so nothing widens; the reader says where it is set.
  await expect(page.getByText(/Manual cutoff is 1 min/)).toBeVisible();
  // The view was split at the answer: the 65 s counted, the timer runs on.
  await expect(timer).toContainText('Active');
  await expect(timer).toContainText('Minutes read: 1', { timeout: 15000 });

  // Away: the same page sits 10 more minutes. The prompt says how long.
  await page.clock.fastForward('10:00');
  await expect(prompt).toContainText('has been open');
  await expect(prompt).toContainText(/\b10\s?m/);
  await prompt.getByRole('button', { name: /^Don.t count/ }).click();
  await expect(prompt).toBeHidden();
  // The timer drops the uncounted minute it was holding at the cap: only the
  // 65 s answered "Still reading" stand.
  await expect(timer).toContainText(/Minutes read: 1\b/);

  // Page 2 runs past its cap, and the reader turns on without answering.
  await page.keyboard.press('ArrowLeft');
  await page.clock.fastForward('01:30');
  await expect(prompt).toContainText('Still reading?');
  await page.keyboard.press('ArrowLeft');
  await expect(prompt).toBeHidden();

  // The unanswered pause waits on the reading-speed page, provisional.
  await page.evaluate(() => (window.location.hash = '#/reading-speed'));
  const card = page.getByTestId('long-pauses');
  await expect(card).toContainText('Long pauses to review (1)', { timeout: 15000 });
  await expect(card.getByTestId('long-pause-row')).toHaveCount(1);
  await expect(card.getByTestId('long-pause-row')).toContainText('provisional');
  await expect
    .poll(async () => (await review(page)).answers, { timeout: 15000 })
    .toEqual([null, 'none', 'full']);
  // 65 s in full + 10 min not counted + page 2's 90 s as typical (the 1-min cap).
  const before = (await figures(page)).timeMs;
  expect(before).toBeGreaterThanOrEqual(125_000);
  expect(before).toBeLessThan(150_000);

  // Answered later: page 2 counts all of its 90 s.
  await card
    .getByTestId('long-pause-row')
    .getByRole('button', { name: 'All', exact: true })
    .click();
  await expect(card).toContainText('Long pauses to review (0)');
  await expect
    .poll(async () => (await figures(page)).timeMs - before, { timeout: 15000 })
    .toBeGreaterThanOrEqual(30_000);
  expect((await figures(page)).timeMs - before).toBeLessThan(45_000);
  await card.getByRole('button', { name: /Show answered/ }).click();
  await expect(card.getByTestId('long-pause-row')).toHaveCount(3);
  await expect(card.getByRole('button', { name: 'All', exact: true, pressed: true })).toHaveCount(
    2
  );
  await expect(card.getByRole('button', { name: 'None', exact: true, pressed: true })).toHaveCount(
    1
  );

  // Answers are history: a reload keeps all three.
  await page.reload();
  await expect(page.getByTestId('long-pauses')).toContainText('Long pauses to review (0)', {
    timeout: 30000
  });
  await expect.poll(async () => (await review(page)).answered, { timeout: 15000 }).toBe(3);

  // Three answers in: the next prompt offers to stop asking.
  await openReader(page);
  await page.clock.fastForward('01:05');
  await expect(prompt).toContainText('Still reading?');
  await prompt.getByRole('checkbox', { name: /Always do this/i }).check();
  await prompt.getByRole('button', { name: /^Don.t count/ }).click();
  await expect(prompt).toBeHidden();
  expect(await pauseDefaultOf(page)).toBe('none');

  // With a standing default, a view past its cap is not asked about…
  await page.clock.fastForward('01:05');
  expect(await livePauseOf(page)).toBeNull();
  await expect(prompt).toBeHidden();

  // …and the default is its answer once the view ends.
  await page.evaluate(() => (window.location.hash = '#/catalog'));
  await expect
    .poll(async () => (await review(page)).answers, { timeout: 15000 })
    .toEqual(['none', 'none', 'full', 'none', 'full']);
  expect((await review(page)).unanswered).toBe(0);
});

test('"Still reading" widens the cutoff, and the rest of the view runs on it', async ({
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
  await expect(prompt).toContainText('Still reading?');
  await prompt.getByRole('button', { name: /^Still reading/ }).click();
  await expect(page.getByText(/Cutoff widened to ~\d+ min/)).toBeVisible();
  // k fits this view with headroom: 121 s × 1.5 / 40 s = 4.5, up to a half step = 5.
  await expect.poll(async () => (await statsState(page)).k, { timeout: 15000 }).toBe(5);

  // The rest of the view runs on the wider cap (5 × 40 s = 200 s): no prompt at 125 s…
  await page.clock.fastForward('02:05');
  expect(await livePauseOf(page)).toBeNull();
  await expect(prompt).toBeHidden();
  await expect(timerOf(page)).toContainText('Active');
  // …and past it, the prompt asks again.
  await page.clock.fastForward('01:20');
  await expect(prompt).toContainText('Still reading?');

  // Leaving with the prompt up leaves that pause to review.
  await page.evaluate(() => (window.location.hash = '#/catalog'));
  await expect
    .poll(async () => (await review(page)).answers, { timeout: 15000 })
    .toEqual([null, 'full']);
  const volume = await figures(page);
  // Page 1 credited once though the view was split; ~121 s in full + 60 s typical.
  expect(volume.chars).toBe(200);
  expect(volume.timeMs).toBeGreaterThanOrEqual(181_000);
  expect(volume.timeMs).toBeLessThan(200_000);
});

test('answers and the standing default sync; the latest answer wins', async ({ browser }) => {
  const stub = new WebDavStub();
  const laptop = await device(browser, { stub });
  const phone = await device(browser, { stub });

  // The laptop left a page open 10 minutes (no pace: a 5-minute cap), answered
  // "don't count", and made "typical" its standing default.
  const target = await laptop.evaluate(async (VOL) => {
    const { recordEvent, recordResolve } = await import('/src/lib/reading-history/record.ts');
    const { updateProgress } = await import('/src/lib/settings/volume-data.ts');
    const { setPauseDefault } = await import('/src/lib/settings/tracking-data.ts');
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
    setPauseDefault('typical');
    return target;
  }, VOL);
  await sync(laptop);
  await sync(phone);

  await expect
    .poll(async () => (await figures(phone)).timeMs, { timeout: 15000 })
    .toBe((await figures(laptop)).timeMs);
  expect(await figures(phone)).toMatchObject({ timeMs: 0, chars: 300 });
  expect((await review(phone)).answers).toEqual(['none']);
  expect(await pauseDefaultOf(phone)).toBe('typical');

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
  await expect
    .poll(async () => (await review(phone)).answers, { timeout: 15000 })
    .toEqual(['full']);
  expect((await figures(phone)).timeMs).toBe(600_000);
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

test('the prompt goes when the view ends without a page turn, and the pause waits to review', async ({
  browser
}) => {
  const page = await device(browser, { clock: true });
  const OTHER = 'e2e-pause-volume-2';
  await installVolume(page, 20);
  await installVolume(page, 20, OTHER);
  await page.evaluate(async () => {
    const { setIdleOverride } = await import('/src/lib/settings/tracking-data.ts');
    setIdleOverride(1);
  });
  await expect.poll(async () => (await statsState(page)).overrideMs).toBe(60_000);
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

  // A hidden tab ends the view: the prompt goes, the pause stays unanswered.
  await page.clock.fastForward('01:05');
  await expect(prompt).toContainText('Still reading?');
  await setHidden(true);
  await expect(prompt).toBeHidden();
  expect(await livePauseOf(page)).toBeNull();
  await setHidden(false);
  await expect(timer).toContainText('Active');

  // So does the timer's pause click.
  await page.clock.fastForward('01:05');
  await expect(prompt).toContainText('Still reading?');
  await timer.click();
  await expect(timer).toContainText('Paused');
  await expect(prompt).toBeHidden();
  expect(await livePauseOf(page)).toBeNull();
  await page.keyboard.press('ArrowLeft');
  await expect(timer).toContainText('Active');

  // And leaving the reader: the next volume opens with no prompt carried over.
  await page.clock.fastForward('01:05');
  await expect(prompt).toContainText('Still reading?');
  await page.evaluate(() => (window.location.hash = '#/catalog'));
  await expect(prompt).toBeHidden();
  expect(await livePauseOf(page)).toBeNull();
  await openReader(page, OTHER);
  expect(await livePauseOf(page)).toBeNull();
  await expect(prompt).toBeHidden();
  await page.evaluate(() => (window.location.hash = '#/catalog'));

  // Each of the three is a provisional pause on the review list.
  await expect
    .poll(async () => (await review(page)).answers, { timeout: 15000 })
    .toEqual([null, null, null]);
  expect((await review(page)).unanswered).toBe(3);
});
