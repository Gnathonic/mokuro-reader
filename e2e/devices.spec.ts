import { test, expect, type Browser, type Page } from '@playwright/test';
import { WebDavStub } from './helpers/webdav-stub';
import { gotoApp } from './helpers/app';

/**
 * Device views (phase 4) on the reading-speed page, in a real browser over
 * the real stores: a single-device user sees no device anywhere; once the
 * history holds another device's reading, the page asks to name this one
 * and lists reading per device, and a name given in either place sticks
 * across a reload. The other device is planted the way a sync would import
 * it: its facts row plus its `page` events, then the recorded-events signal.
 */

const VOL_OWN = 'e2e-devices-own';
const VOL_PHONE = 'e2e-devices-phone';
const PHONE = 'e2e-phone-0001';
const PHONE_LABEL = 'Phone · Android · Chrome';

/** Three 300-char pages read for a minute each, on this device. */
async function readHere(page: Page) {
  await page.evaluate(async (volume) => {
    const { recordEvent } = await import('/src/lib/reading-history/record.ts');
    const { updateProgress } = await import('/src/lib/settings/volume-data.ts');
    const { setIdleOverride } = await import('/src/lib/settings/tracking-data.ts');
    setIdleOverride(12);
    for (let p = 1; p <= 3; p++) {
      await recordEvent({
        kind: 'page',
        volume,
        first_page: p,
        last_page: p,
        page_chars: [300],
        chars_before: (p - 1) * 300,
        dwell_ms: 60_000,
        layout: 'single',
        orientation: 'portrait',
        viewport: { w: 400, h: 800 }
      });
      // The device split counts volumes with a record, as the page does.
      updateProgress(volume, p, p * 300);
    }
  }, VOL_OWN);
}

/** The same reading by another device, as a sync would import it. */
async function readOnPhone(page: Page) {
  await page.evaluate(
    async ({ volume, device }) => {
      const { historyDb } = await import('/src/lib/reading-history/history-db.ts');
      const { notifyEventsRecorded } = await import('/src/lib/reading-history/record.ts');
      const db = historyDb();
      const now = Date.now();
      await db.devices.put({
        device,
        class: 'phone',
        os: 'Android',
        browser: 'Chrome',
        first_seen: new Date(now - 86_400_000).toISOString(),
        last_seen: new Date(now).toISOString()
      });
      const events = [1, 2, 3].map((p) => ({
        kind: 'page' as const,
        volume,
        first_page: p,
        last_page: p,
        page_chars: [300],
        chars_before: (p - 1) * 300,
        dwell_ms: 60_000,
        layout: 'single' as const,
        orientation: 'portrait' as const,
        viewport: { w: 400, h: 800 },
        device,
        seq: p,
        t: now - (4 - p) * 60_000
      }));
      await db.reading_events.bulkAdd(events);
      notifyEventsRecorded(events);
      (await import('/src/lib/settings/volume-data.ts')).updateProgress(volume, 3, 900);
    },
    { volume: VOL_PHONE, device: PHONE }
  );
}

/** Counted time for a volume, once the stats store has caught up. */
async function countedMs(page: Page, volume: string): Promise<number> {
  return page.evaluate(async (volume) => {
    const stats = await import('/src/lib/reading-history/stats-store.ts');
    stats.flushReadingStats();
    let ms = 0;
    stats.readingStats.subscribe((s) => (ms = s.byVolume.get(volume)?.timeMs ?? 0))();
    return ms;
  }, volume);
}

async function openStats(page: Page) {
  await page.evaluate(() => (window.location.hash = '#/reading-speed'));
  await expect(page.getByRole('heading', { name: 'Reading Speed History' })).toBeVisible();
}

test.describe('device views on the stats page', () => {
  test('one device shows none; a second brings the banner and the device list, and names stick', async ({
    page
  }) => {
    await gotoApp(page);
    await readHere(page);
    await expect.poll(() => countedMs(page, VOL_OWN), { timeout: 15000 }).toBeGreaterThan(0);
    await openStats(page);
    await expect(page.getByText('Achievements', { exact: true })).toBeVisible();
    await expect(page.getByTestId('device-banner')).toHaveCount(0);
    await expect(page.getByTestId('device-stats')).toHaveCount(0);

    await readOnPhone(page);
    const banner = page.getByTestId('device-banner');
    await expect(banner).toContainText('You read on 2 devices — name this one?', {
      timeout: 15000
    });
    const card = page.getByTestId('device-stats');
    const rows = card.getByTestId('device-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('This device');
    await expect(rows.nth(1).getByTestId('device-name')).toHaveText(PHONE_LABEL);
    await expect(rows.nth(1)).toContainText('3 min');
    await expect(rows.nth(1)).toContainText('900 chars');
    await expect(rows.nth(1)).toContainText('50% of time');

    // Inline rename of the other device.
    await rows.nth(1).getByRole('button', { name: PHONE_LABEL }).click();
    const field = rows.nth(1).getByRole('textbox');
    await expect(field).toBeFocused();
    await field.fill('Pixel 8');
    await field.press('Enter');
    await expect(rows.nth(1).getByTestId('device-name')).toHaveText('Pixel 8');

    // Name this device from the banner: it stays put, confirmed.
    const own = banner.getByRole('textbox');
    await own.fill('Work laptop');
    await own.press('Enter');
    await expect(banner).toContainText('Saved.');
    await expect(rows.nth(0).getByTestId('device-name')).toHaveText('Work laptop');

    // Both names survive a reload; a named device is not asked again.
    await gotoApp(page);
    await openStats(page);
    await expect(page.getByTestId('device-stats').getByTestId('device-name')).toHaveText(
      ['Work laptop', 'Pixel 8'],
      { timeout: 15000 }
    );
    await expect(page.getByTestId('device-banner')).toHaveCount(0);
  });

  test('"Not now" hides the banner in this browser, across reloads', async ({ page }) => {
    await gotoApp(page);
    await readHere(page);
    await readOnPhone(page);
    await openStats(page);
    const banner = page.getByTestId('device-banner');
    await expect(banner).toBeVisible({ timeout: 15000 });
    await banner.getByRole('button', { name: 'Not now' }).click();
    await expect(banner).toHaveCount(0);

    await gotoApp(page);
    await openStats(page);
    // The device list proves the stats are in; the banner still stays away.
    await expect(page.getByTestId('device-stats').getByTestId('device-row')).toHaveCount(2, {
      timeout: 15000
    });
    await expect(page.getByTestId('device-banner')).toHaveCount(0);
  });
});

/**
 * Device views (phase 4) through the REAL app and sync. Browser contexts (each
 * its own IndexedDB, so its own device id) share an in-memory WebDAV server; a
 * third device — an old tablet that no longer runs — is planted on the server
 * as its `device.json` and one month of events.
 *
 * - A single-device user never sees a device: no banner, no per-device card,
 *   no Devices block. Converted legacy history is not a device.
 * - With three devices the reading-speed page asks to name this one, lists a
 *   row per device (twin generated labels told apart), renames inline; the
 *   cloud screen corrects a class, merges and unmerges; every choice reaches
 *   the other device through `volume-data.json` → `tracking.devices`.
 * - The position offer names the device the reading comes from.
 */

const STUB = 'http://stub.test';
const ROOT = '/mokuro-reader';
const SERIES = 'Devices Series';
const SERIES_UUID = 'e2e-devices-series';
const VOL = 'e2e-devices-volume';
const PAGES = 50;
const TABLET = 'e2e-old-tablet';

async function device(browser: Browser, stub: WebDavStub): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route(`${STUB}/**`, stub.handle);
  await gotoApp(page);
  await page.evaluate(async (serverUrl) => {
    const { providerManager } = await import('/src/lib/util/sync/provider-manager.ts');
    const provider = await providerManager.getOrLoadProvider('webdav');
    await provider.login({ serverUrl, username: '', password: '' });
    await providerManager.setCurrentProvider(provider);
  }, STUB);
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

async function go(page: Page, hash: string) {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
}

async function deviceId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const { historyDb } = await import('/src/lib/reading-history/history-db.ts');
    const { getOrCreateDeviceId } = await import('/src/lib/reading-history/record.ts');
    return getOrCreateDeviceId(historyDb());
  });
}

/** Raw ids of every device this one knows (the `devices` store's keys). */
async function deviceIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const { devices } = await import('/src/lib/reading-history/device-stats.ts');
    let views = new Map<string, unknown>();
    const stop = devices.subscribe((v) => (views = v));
    await new Promise((r) => setTimeout(r, 200));
    stop();
    return [...views.keys()].sort();
  });
}

/** The name this device's label carries in the synced `tracking.devices`. */
async function ownName(page: Page): Promise<string | undefined> {
  return page.evaluate(async () => {
    const { historyDb } = await import('/src/lib/reading-history/history-db.ts');
    const { getOrCreateDeviceId } = await import('/src/lib/reading-history/record.ts');
    const { deviceLabels } = await import('/src/lib/settings/tracking-data.ts');
    const id = await getOrCreateDeviceId(historyDb());
    let labels: Record<string, { name?: string }> = {};
    deviceLabels.subscribe((v) => (labels = v))();
    return labels[id]?.name;
  });
}

/** Read pages the way the reader records them: a 60 s view each, and the position. */
async function read(page: Page, pages: number[]) {
  await page.evaluate(
    async ({ VOL, pages }) => {
      const { recordEvent } = await import('/src/lib/reading-history/record.ts');
      const { updateProgress } = await import('/src/lib/settings/volume-data.ts');
      for (const p of pages) {
        await recordEvent({
          kind: 'page',
          volume: VOL,
          first_page: p,
          last_page: p,
          page_chars: [300],
          chars_before: (p - 1) * 300,
          dwell_ms: 60_000,
          layout: 'single',
          orientation: 'portrait',
          viewport: { w: 400, h: 800 }
        });
        updateProgress(VOL, p, p * 300);
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    { VOL, pages }
  );
}

/** This volume's figures once the stats have counted. */
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

async function plan(page: Page) {
  return page.evaluate(async (VOL) => {
    const { positionPlanFor } = await import('/src/lib/reading-history/position-store.ts');
    return positionPlanFor(VOL);
  }, VOL);
}

/** Install a 50-page volume locally (as a download would have left it). */
async function installVolume(page: Page) {
  await page.evaluate(
    async ({ SERIES, SERIES_UUID, VOL, PAGES }) => {
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
        blocks: []
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
        character_count: 0,
        page_char_counts: pages.map(() => 0),
        thumbnail: new File([blob], 'thumb.webp', { type: 'image/webp' })
      });
      await db.volume_ocr.put({ volume_uuid: VOL, pages });
      await db.volume_files.put({ volume_uuid: VOL, files });
      const { updateSetting } = await import('/src/lib/settings/index.ts');
      updateSetting('continuousScroll', false);
      updateSetting('singlePageView', 'single');
    },
    { SERIES, SERIES_UUID, VOL, PAGES }
  );
}

/**
 * A third device that no longer runs: its facts and one month of its events,
 * planted on the server as it would have uploaded them (encoded in-page by the
 * real codec).
 */
async function plantTablet(page: Page, stub: WebDavStub) {
  const bytes = await page.evaluate(
    async ({ TABLET, VOL }) => {
      const { encodeSegment } = await import('/src/lib/reading-history/segment-codec.ts');
      const events = [1, 2].map((p) => ({
        device: TABLET,
        seq: p,
        t: Date.UTC(2026, 2, 20, 12, p),
        kind: 'page' as const,
        volume: VOL,
        first_page: p,
        last_page: p,
        page_chars: [300],
        chars_before: (p - 1) * 300,
        dwell_ms: 60_000,
        layout: 'single' as const,
        orientation: 'portrait' as const,
        viewport: { w: 800, h: 1280 }
      }));
      return Array.from(await encodeSegment(TABLET, '2026-03', events));
    },
    { TABLET, VOL }
  );
  const mtime = 'Fri, 20 Mar 2026 12:05:00 GMT';
  stub.file(`${ROOT}/history/${TABLET}/2026-03.events`, Buffer.from(bytes), mtime);
  stub.file(
    `${ROOT}/history/${TABLET}/device.json`,
    Buffer.from(
      JSON.stringify({
        device: TABLET,
        class: 'tablet',
        os: 'Android',
        browser: 'Chrome',
        first_seen: '2026-03-02T10:00:00.000Z',
        last_seen: '2026-03-20T12:05:00.000Z'
      })
    ),
    mtime
  );
}

/** A converted page turn (phase 2b): keyed `legacy:<volume>`, never a device. */
async function plantLegacy(page: Page) {
  await page.evaluate(async () => {
    const { historyDb } = await import('/src/lib/reading-history/history-db.ts');
    const { notifyEventsRecorded } = await import('/src/lib/reading-history/record.ts');
    const t = Date.UTC(2026, 5, 1, 12);
    const event = {
      device: 'legacy:e2e-devices-legacy',
      seq: t,
      t,
      kind: 'page' as const,
      volume: 'e2e-devices-legacy',
      first_page: 1,
      last_page: 1,
      page_chars: [300],
      chars_before: 0,
      dwell_ms: 60_000,
      layout: 'unknown' as const,
      orientation: 'unknown' as const,
      viewport: null
    };
    await historyDb().reading_events.put(event);
    notifyEventsRecorded([event]);
  });
}

test.describe('device views through sync', () => {
  test('a single-device user sees no device anywhere, legacy history included', async ({
    browser
  }) => {
    const stub = new WebDavStub();
    const page = await device(browser, stub);
    await read(page, [1, 2]);
    await plantLegacy(page);
    await sync(page);

    await go(page, '#/reading-speed');
    // The stats have counted and the device list is loaded: exactly this device.
    await expect.poll(async () => (await figures(page)).timeMs, { timeout: 15000 }).toBe(120_000);
    const own = await deviceId(page);
    await expect.poll(() => deviceIds(page), { timeout: 15000 }).toEqual([own]);
    await expect(page.getByRole('heading', { name: 'Reading Speed History' })).toBeVisible();
    await expect(page.getByTestId('device-stats')).toHaveCount(0);
    await expect(page.getByTestId('device-banner')).toHaveCount(0);

    await go(page, '#/cloud');
    await expect(page.getByRole('heading', { name: 'Storage' })).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('devices-settings')).toHaveCount(0);
  });

  test('three devices: name this one, rename, correct a class, merge and unmerge — all synced', async ({
    browser
  }) => {
    test.setTimeout(180_000);
    const stub = new WebDavStub();
    const laptop = await device(browser, stub);
    const phone = await device(browser, stub);
    await plantTablet(laptop, stub);

    await read(phone, [3, 4]);
    await sync(phone);
    await read(laptop, [5, 6]);
    await sync(laptop);
    await sync(phone);

    // The laptop: three devices hold reading, so the page asks to name this one.
    await go(laptop, '#/reading-speed');
    const banner = laptop.getByTestId('device-banner');
    await expect(banner).toContainText('You read on 3 devices — name this one?', {
      timeout: 15000
    });
    const card = laptop.getByTestId('device-stats');
    const rows = card.getByTestId('device-row');
    await expect(rows).toHaveCount(3);
    await expect(
      card.getByRole('button', { name: 'Tablet · Android · Chrome', exact: true })
    ).toBeVisible();
    // Laptop and phone run the same browser: one generated label, told apart.
    const twins = card.getByRole('button', { name: /^Desktop · / });
    await expect(twins).toHaveCount(2);
    const twinLabels = (await twins.allTextContents()).map((l) => l.trim());
    expect(new Set(twinLabels).size).toBe(2);
    for (const label of twinLabels) expect(label).toContain('(since ');
    await expect(rows.filter({ hasText: 'This device' })).toHaveCount(1);

    // Entry point 3: the banner names this device, confirms, and closes.
    const bannerField = banner.getByRole('textbox', { name: 'Device name' });
    await bannerField.fill('Work laptop');
    await bannerField.press('Enter');
    await expect(banner).toContainText('Saved.');
    await banner.getByRole('button', { name: 'Close' }).click();
    await expect(banner).toBeHidden();
    await expect(rows.filter({ hasText: 'This device' })).toContainText('Work laptop');

    // Entry point 2: rename another device in place.
    await card.getByRole('button', { name: 'Tablet · Android · Chrome', exact: true }).click();
    const inline = card.getByRole('textbox', { name: 'Device name' });
    await inline.fill('Old tablet');
    await inline.press('Enter');
    await expect(card.getByRole('button', { name: 'Old tablet', exact: true })).toBeVisible();

    // Entry point 1: the cloud screen corrects the phone's detected class.
    await go(laptop, '#/cloud');
    const settings = laptop.getByTestId('devices-settings');
    await expect(settings).toBeVisible({ timeout: 15000 });
    const phoneRow = settings
      .getByTestId('device-row')
      .filter({ hasNotText: 'This device' })
      .filter({ has: laptop.getByPlaceholder(/^Desktop · /) });
    await expect(phoneRow).toHaveCount(1);
    await phoneRow.getByRole('combobox', { name: 'Device type' }).selectOption({ label: 'Phone' });
    await expect(
      settings.getByTestId('device-row').filter({ has: laptop.getByPlaceholder(/^Phone · /) })
    ).toHaveCount(1);
    await sync(laptop);

    // The phone sees every choice the laptop made.
    await sync(phone);
    await go(phone, '#/reading-speed');
    const phoneCard = phone.getByTestId('device-stats');
    const phoneRows = phoneCard.getByTestId('device-row');
    await expect(phoneCard.getByRole('button', { name: 'Work laptop', exact: true })).toBeVisible({
      timeout: 15000
    });
    await expect(phoneCard.getByRole('button', { name: 'Old tablet', exact: true })).toBeVisible();
    await expect(phoneRows.filter({ hasText: 'This device' })).toContainText('Phone · ');
    const phoneBanner = phone.getByTestId('device-banner');
    await expect(phoneBanner).toContainText('You read on 3 devices — name this one?');

    // The phone merges the old tablet into the laptop.
    await go(phone, '#/cloud');
    const phoneSettings = phone.getByTestId('devices-settings');
    await expect(phoneSettings).toBeVisible({ timeout: 15000 });
    await phoneSettings
      .getByTestId('device-row')
      .filter({ has: phone.getByPlaceholder('Tablet · Android · Chrome') })
      .getByRole('button', { name: 'Merge into…' })
      .click();
    const dialog = phone.getByRole('dialog');
    await dialog
      .getByRole('combobox', { name: 'Merge into' })
      .selectOption({ label: 'Work laptop' });
    await dialog.getByRole('button', { name: 'Merge', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(phoneSettings.getByRole('button', { name: 'Unmerge' })).toHaveCount(1);
    await sync(phone);

    await go(phone, '#/reading-speed');
    await expect(phoneRows).toHaveCount(2, { timeout: 15000 });
    await expect(phoneCard.getByRole('button', { name: 'Old tablet', exact: true })).toHaveCount(0);
    await expect(phoneBanner).toContainText('You read on 2 devices — name this one?');

    // "Not now" is remembered by this browser.
    await phoneBanner.getByRole('button', { name: 'Not now' }).click();
    await expect(phoneBanner).toBeHidden();
    await phone.reload();
    await expect(phone.getByTestId('device-stats')).toBeVisible({ timeout: 30000 });
    await expect(phone.getByTestId('device-banner')).toBeHidden();

    // The merge reaches the laptop; unmerging there brings the tablet back.
    await sync(laptop);
    await go(laptop, '#/reading-speed');
    await expect(rows).toHaveCount(2, { timeout: 15000 });
    await go(laptop, '#/cloud');
    await settings.getByRole('button', { name: 'Unmerge' }).click();
    await go(laptop, '#/reading-speed');
    await expect(rows).toHaveCount(3, { timeout: 15000 });
    await expect(card.getByRole('button', { name: 'Old tablet', exact: true })).toBeVisible();

    // The device UUID is never shown.
    await expect(card).not.toContainText(TABLET);
    await expect(card).not.toContainText(await deviceId(laptop));
    await go(laptop, '#/cloud');
    await expect(settings).not.toContainText(TABLET);
  });

  test('the position offer names the device it comes from', async ({ browser }) => {
    test.setTimeout(150_000);
    const stub = new WebDavStub();
    const phone = await device(browser, stub);
    const laptop = await device(browser, stub);
    await installVolume(laptop);

    await read(phone, [38, 39, 40]);
    await sync(phone);
    await sync(laptop);
    await sync(phone); // the phone now knows the laptop

    // The phone names itself on the cloud screen.
    await go(phone, '#/cloud');
    const own = phone
      .getByTestId('devices-settings')
      .getByTestId('device-row')
      .filter({ hasText: 'This device' });
    const field = own.getByRole('textbox', { name: 'Device name' });
    await expect(field).toBeVisible({ timeout: 15000 });
    await field.fill('Pixel 8');
    await field.press('Enter');
    await expect.poll(() => ownName(phone), { timeout: 10000 }).toBe('Pixel 8');

    // The phone reads on; the laptop never pulls it, turns one page and syncs.
    await read(phone, [41, 42, 43, 44]);
    await sync(phone);
    await read(laptop, [41]);
    await sync(laptop);
    await expect
      .poll(() => plan(laptop), { timeout: 10000 })
      .toMatchObject({ offer: { page: 44, ownDevice: false } });

    await go(laptop, `#/reader/${SERIES_UUID}/${VOL}`);
    const offer = laptop.getByTestId('position-offer');
    await expect(offer).toBeVisible({ timeout: 20000 });
    await expect(offer).toContainText('You also read to page 44 on Pixel 8');
    await expect(offer).not.toContainText(await deviceId(phone));
  });
});
