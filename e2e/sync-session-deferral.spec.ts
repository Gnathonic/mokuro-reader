import { test, expect, type Page } from '@playwright/test';
import { WebDavStub } from './helpers/webdav-stub';
import {
  POSITIONS,
  ROOT,
  VOL,
  counter,
  device,
  installVolume,
  openVolume,
  positionsFile,
  progress,
  read,
  sync
} from './helpers/positions';

/**
 * Page turns made while reading do not re-upload `volume-data.json`
 * (`src/lib/util/sync/volume-data-deferral.ts`). Two devices (browser
 * contexts) share one in-memory WebDAV server.
 *
 * Device A reads on with the reader open. The activity tracker's progress
 * sync runs mid-session and leaves `volume-data.json` alone, because
 * `positions.json` already carries the page to device B. When A leaves the
 * reader, the flush that ends the session uploads `volume-data.json`. A third
 * device then gets the page from that file alone, with `positions.json` gone.
 */

const VOLUME_DATA = `${ROOT}/volume-data.json`;

function volumeDataFile(stub: WebDavStub): Record<string, { progress?: number }> {
  const entry = stub.files.get(VOLUME_DATA);
  return entry ? JSON.parse(entry.body.toString()) : {};
}

const volumeDataPuts = (stub: WebDavStub, from = 0) =>
  stub.log.slice(from).filter((l) => l.method === 'PUT' && l.path === VOLUME_DATA).length;

/** Wait until no progress sync is running on this device. */
async function syncIdle(page: Page) {
  await page.evaluate(async () => {
    const { unifiedCloudManager } = await import('/src/lib/util/sync/unified-cloud-manager.ts');
    let syncing = true;
    const unsubscribe = unifiedCloudManager.isSyncing.subscribe((v) => (syncing = v));
    const deadline = Date.now() + 30000;
    while (syncing && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    unsubscribe();
    if (syncing) throw new Error('the sync did not finish');
  });
}

test('a turn mid-session reaches the other device through positions.json; volume-data.json goes up when the reader closes', async ({
  browser
}) => {
  test.setTimeout(120000);
  const stub = new WebDavStub();
  const a = await device(browser, stub);
  const b = await device(browser, stub);
  await installVolume(a);
  await installVolume(b);

  // Both at p.40, synced through both files.
  await read(a, [38, 39, 40]);
  await sync(a);
  await expect.poll(() => positionsFile(stub)[VOL]?.[1], { timeout: 15000 }).toBe(40);
  await sync(b);
  expect(await progress(b)).toBe(40);
  expect(volumeDataFile(stub)[VOL]?.progress).toBe(40);

  // A opens the reader and reads on, three pages.
  await openVolume(a);
  await expect(counter(a, 40)).toBeVisible({ timeout: 20000 });
  await syncIdle(a); // the foreground sync the reader's mount asks for
  const logFrom = stub.log.length;
  const trackerSync = a.waitForEvent('console', {
    predicate: (m) => m.text().includes('Auto-syncing after 5s inactivity'),
    timeout: 30000
  });
  const deferred = a.waitForEvent('console', {
    predicate: (m) => /volume-data\.json upload deferred.*1 volume/.test(m.text()),
    timeout: 30000
  });
  for (const page of [41, 42, 43]) {
    await a.keyboard.press('ArrowLeft');
    await expect(counter(a, page)).toBeVisible();
  }

  // The activity tracker's sync runs 5 s after the last turn, mid-session,
  // and defers the upload.
  await trackerSync;
  await deferred;
  await syncIdle(a);
  expect(volumeDataPuts(stub, logFrom)).toBe(0);
  expect(volumeDataFile(stub)[VOL]?.progress).toBe(40);
  // That sync did read the cloud copy (a conditional read of the file).
  expect(stub.log.slice(logFrom).some((l) => l.path === VOLUME_DATA)).toBe(true);
  // positions.json carries the page.
  await expect.poll(() => positionsFile(stub)[VOL]?.[1], { timeout: 15000 }).toBe(43);

  // B sees A's page through positions.json (its position check).
  await b.evaluate(async () => {
    const { unifiedCloudManager } = await import('/src/lib/util/sync/unified-cloud-manager.ts');
    const { syncPositions } = await import('/src/lib/positions/positions-sync.ts');
    await syncPositions(unifiedCloudManager.getActiveProvider()!);
  });
  expect(await progress(b)).toBe(43);
  expect(volumeDataPuts(stub, logFrom)).toBe(0);

  // A leaves the reader: the flush that ends the session uploads the file,
  // although no page was turned since the deferring sync.
  await a.evaluate(() => {
    window.location.hash = '#/catalog';
  });
  await expect.poll(() => volumeDataFile(stub)[VOL]?.progress, { timeout: 15000 }).toBe(43);
  expect(volumeDataPuts(stub, logFrom)).toBe(1);

  // A device that never saw positions.json gets the page from volume-data.json.
  stub.files.delete(POSITIONS);
  const c = await device(browser, stub);
  await installVolume(c);
  await sync(c);
  expect(await progress(c)).toBe(43);
  // And B's full sync, with positions.json still gone, keeps it.
  await sync(b);
  expect(await progress(b)).toBe(43);
  expect(stub.files.has(POSITIONS)).toBe(false);
});

test('hiding the tab ends the session: the deferred volume-data.json goes up', async ({
  browser
}) => {
  test.setTimeout(120000);
  const stub = new WebDavStub();
  const a = await device(browser, stub);
  await installVolume(a);
  await read(a, [38, 39, 40]);
  await sync(a);
  expect(volumeDataFile(stub)[VOL]?.progress).toBe(40);

  await openVolume(a);
  await expect(counter(a, 40)).toBeVisible({ timeout: 20000 });
  await syncIdle(a);
  const logFrom = stub.log.length;
  const deferred = a.waitForEvent('console', {
    predicate: (m) => /volume-data\.json upload deferred/.test(m.text()),
    timeout: 30000
  });
  await a.keyboard.press('ArrowLeft');
  await expect(counter(a, 41)).toBeVisible();
  await deferred;
  await syncIdle(a);
  expect(volumeDataPuts(stub, logFrom)).toBe(0);

  // The reader stays open; the tab goes to the background.
  await a.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => volumeDataFile(stub)[VOL]?.progress, { timeout: 15000 }).toBe(41);
  expect(volumeDataPuts(stub, logFrom)).toBe(1);
});
