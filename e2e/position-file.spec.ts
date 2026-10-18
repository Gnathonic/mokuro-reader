import { test, expect, type Browser, type Page } from '@playwright/test';
import { gotoApp } from './helpers/app';
import { WebDavStub } from './helpers/webdav-stub';

/**
 * The device swap through `positions.json`, two devices (browser contexts)
 * sharing an in-memory WebDAV server.
 *
 * The phone reads on and only PUSHES its position (3 s after the turns): no
 * full sync, so the laptop's `volume-data.json` and history know nothing of
 * it. Picking up the laptop and opening the volume, the reader asks the
 * fixed-address file before it picks its page.
 */

const STUB = 'http://stub.test';
const ROOT = '/mokuro-reader';
const POSITIONS = `${ROOT}/positions.json`;
const SERIES = 'Swap Series';
const SERIES_UUID = 'e2e-swap-series';
const VOL = 'e2e-swap-volume';
const PAGES = 50;

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

/** Read pages the way the reader records them: a view each, and the position. */
async function read(page: Page, pages: number[]) {
  await page.evaluate(
    async ({ VOL, pages }) => {
      const { updateProgress } = await import('/src/lib/settings/volume-data.ts');
      const { recordEvent } = await import('/src/lib/reading-history/record.ts');
      for (const p of pages) {
        await recordEvent({
          kind: 'page',
          volume: VOL,
          first_page: p,
          last_page: p,
          page_chars: [0],
          chars_before: 0,
          dwell_ms: 5,
          layout: 'single',
          orientation: 'portrait',
          viewport: { w: 400, h: 800 }
        });
        updateProgress(VOL, p, 0);
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    { VOL, pages }
  );
}

async function progress(page: Page) {
  return page.evaluate(async (VOL) => {
    const { volumesWithTrash } = await import('/src/lib/settings/volume-data.ts');
    let all: Record<string, { progress: number }> = {};
    volumesWithTrash.subscribe((v) => (all = v))();
    return all[VOL]?.progress ?? null;
  }, VOL);
}

function positionsFile(stub: WebDavStub): Record<string, [number, number, number, string]> {
  const entry = stub.files.get(POSITIONS);
  return entry ? JSON.parse(entry.body.toString()).positions : {};
}

const positionPuts = (stub: WebDavStub) =>
  stub.log.filter((l) => l.method === 'PUT' && l.path === POSITIONS).length;

/** Both devices hold the volume at p.40, synced; the phone has pushed its position. */
async function bothAtForty(browser: Browser, stub: WebDavStub) {
  const phone = await device(browser, stub);
  const laptop = await device(browser, stub);
  await installVolume(phone);
  await installVolume(laptop);
  await read(phone, [38, 39, 40]);
  await sync(phone);
  // The push follows the turns: the file exists before the laptop lists.
  await expect.poll(() => positionsFile(stub)[VOL]?.[1], { timeout: 15000 }).toBe(40);
  await sync(laptop);
  expect(await progress(laptop)).toBe(40);
  return { phone, laptop };
}

/** The phone reads on and only pushes; the laptop has not seen it. */
async function phoneReadsOn(phone: Page, stub: WebDavStub, pages: number[]) {
  const before = positionPuts(stub);
  await read(phone, pages);
  await expect.poll(() => positionPuts(stub), { timeout: 15000 }).toBeGreaterThan(before);
  expect(positionsFile(stub)[VOL][1]).toBe(pages.at(-1));
}

async function openVolume(page: Page) {
  await page.evaluate(
    ({ SERIES_UUID, VOL }) => {
      window.location.hash = `#/reader/${SERIES_UUID}/${VOL}`;
    },
    { SERIES_UUID, VOL }
  );
}

const counter = (page: Page, n: number) => page.getByText(`${n} / ${PAGES}`, { exact: true });

test('the picked-up device opens where the other one stopped', async ({ browser }) => {
  const stub = new WebDavStub();
  const { phone, laptop } = await bothAtForty(browser, stub);
  await phoneReadsOn(phone, stub, [41, 42, 43, 44]);

  await openVolume(laptop);
  await expect(counter(laptop, 44)).toBeVisible({ timeout: 20000 });
  await expect(laptop.getByText(/Continued from .+, p\.44/)).toBeVisible();
  await expect(counter(laptop, 40)).toHaveCount(0);
  expect(await progress(laptop)).toBe(44);
});

test('a slow check opens the local page, then moves before any page turn', async ({ browser }) => {
  const stub = new WebDavStub();
  const { phone, laptop } = await bothAtForty(browser, stub);
  await phoneReadsOn(phone, stub, [41, 42, 43, 44]);

  stub.delays.set(POSITIONS, 2500);
  const opened = Date.now();
  await openVolume(laptop);
  // The reader does not wait for the slow answer: the local page first…
  await expect(counter(laptop, 40)).toBeVisible({ timeout: 20000 });
  expect(Date.now() - opened).toBeLessThan(2500);
  // …then the late answer moves it, since no page was turned here.
  await expect(counter(laptop, 44)).toBeVisible({ timeout: 10000 });
  await expect(laptop.getByText(/Continued from .+, p\.44/)).toBeVisible();
});

test('after a page turn the late answer does not move the page', async ({ browser }) => {
  const stub = new WebDavStub();
  const { phone, laptop } = await bothAtForty(browser, stub);
  await phoneReadsOn(phone, stub, [41, 42, 43, 44]);
  // volume-data.json carries p.44 too — and both answers are slow, so the
  // user turns a page before either lands. (The phase 2c offer for p.44 needs
  // the phone's history, which only a fresh listing brings.)
  await sync(phone);
  stub.delays.set(POSITIONS, 2500);
  stub.delays.set(`${ROOT}/volume-data.json`, 2500);

  await openVolume(laptop);
  await expect(counter(laptop, 40)).toBeVisible({ timeout: 20000 });
  await laptop.keyboard.press('ArrowLeft');
  await expect(counter(laptop, 41)).toBeVisible();

  // Every delayed answer lands, and the laptop's own turn goes up as the newest.
  await expect.poll(() => positionsFile(stub)[VOL]?.[1], { timeout: 15000 }).toBe(41);
  await expect(counter(laptop, 41)).toBeVisible();
  expect(await progress(laptop)).toBe(41);
  await expect(laptop.getByText(/Continued from/)).toHaveCount(0);
});

test('opening and closing without turning writes no position', async ({ browser }) => {
  const stub = new WebDavStub();
  const { laptop } = await bothAtForty(browser, stub);
  const before = positionsFile(stub)[VOL];
  const logFrom = stub.log.length;

  await openVolume(laptop);
  await expect(counter(laptop, 40)).toBeVisible({ timeout: 20000 });
  // Long enough for a push (3 s) to have gone out, had opening claimed one.
  await laptop.waitForTimeout(4000);
  await laptop.evaluate(() => {
    window.location.hash = '#/catalog';
  });
  await laptop.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await laptop.waitForTimeout(1000);

  expect(stub.log.slice(logFrom).filter((l) => l.method === 'PUT' && l.path === POSITIONS)).toEqual(
    []
  );
  expect(positionsFile(stub)[VOL]).toEqual(before);
});
