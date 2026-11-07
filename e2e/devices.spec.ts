import {
  test,
  expect,
  devices,
  type Browser,
  type BrowserContextOptions,
  type Page
} from '@playwright/test';
import { WebDavStub } from './helpers/webdav-stub';
import { gotoApp } from './helpers/app';

/**
 * Devices (phase 4) through the REAL app and sync. Browser contexts (each its
 * own IndexedDB, so its own device id) share an in-memory WebDAV server. There
 * is no device UI any more (no naming, merging or per-device stats); what is
 * left is the data the position offer names a device from.
 *
 * - Converted legacy history is never a device.
 * - The position offer names the device the reading comes from, by its
 *   generated label (`<class> · <OS> · <browser>`).
 */

const STUB = 'http://stub.test';
const SERIES = 'Devices Series';
const SERIES_UUID = 'e2e-devices-series';
const VOL = 'e2e-devices-volume';
const PAGES = 50;

async function device(
  browser: Browser,
  stub: WebDavStub,
  options: BrowserContextOptions = {}
): Promise<Page> {
  const context = await browser.newContext(options);
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

test.describe('devices through sync', () => {
  test('converted legacy history is never a device', async ({ browser }) => {
    const stub = new WebDavStub();
    const page = await device(browser, stub);
    await read(page, [1, 2]);
    await plantLegacy(page);
    await sync(page);

    // The stats have counted and the device list is loaded: exactly this device.
    await expect.poll(async () => (await figures(page)).timeMs, { timeout: 15000 }).toBe(120_000);
    const own = await deviceId(page);
    await expect.poll(() => deviceIds(page), { timeout: 15000 }).toEqual([own]);
  });

  test('the position offer names the device it comes from', async ({ browser }) => {
    test.setTimeout(150_000);
    const stub = new WebDavStub();
    // A phone, so its generated label differs from the laptop's.
    const phone = await device(browser, stub, devices['Pixel 7']);
    const laptop = await device(browser, stub);
    await installVolume(laptop);
    const phoneLabel = await phone.evaluate(async () => {
      const { readDeviceEnv, detectDeviceFacts } = await import(
        '/src/lib/reading-history/device-facts.ts'
      );
      const { generatedLabel } = await import('/src/lib/reading-history/devices.ts');
      return generatedLabel(detectDeviceFacts(readDeviceEnv()));
    });
    expect(phoneLabel).toMatch(/^Phone · Android · \S+$/);

    await read(phone, [38, 39, 40]);
    await sync(phone);
    await sync(laptop);

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
    await expect(offer).toContainText(`You also read to page 44 on ${phoneLabel}`);
    await expect(offer).not.toContainText(await deviceId(phone));
  });
});
