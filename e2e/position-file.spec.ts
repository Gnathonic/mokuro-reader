import { test, expect, type Browser, type Page } from '@playwright/test';
import { WebDavStub } from './helpers/webdav-stub';
import {
  POSITIONS,
  ROOT,
  VOL,
  counter,
  device,
  installVolume,
  openVolume,
  positionPuts,
  positionsFile,
  progress,
  read,
  sync
} from './helpers/positions';

/**
 * The device swap through `positions.json`, two devices (browser contexts)
 * sharing an in-memory WebDAV server.
 *
 * The phone reads on and only PUSHES its position (3 s after the turns): no
 * full sync, so the laptop's `volume-data.json` and history know nothing of
 * it. Picking up the laptop and opening the volume, the reader asks the
 * fixed-address file before it picks its page.
 */

/** The full library listing every sync waits for: `Depth: infinity` on the reader root. */
function isLibraryListing(request: {
  method(): string;
  url(): string;
  headers(): Record<string, string>;
}) {
  return (
    request.method() === 'PROPFIND' &&
    request.headers()['depth'] === 'infinity' &&
    /\/mokuro-reader\/?$/.test(new URL(request.url()).pathname)
  );
}

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

  // The answer is held far longer than an open takes, even under parallel
  // workers: an open that waited for it could not show a page before it.
  const SLOW = 6000;
  stub.delays.set(POSITIONS, SLOW);
  const opened = Date.now();
  await openVolume(laptop);
  // The reader does not wait for the slow answer: the local page first…
  await expect(counter(laptop, 40)).toBeVisible({ timeout: 20000 });
  expect(Date.now() - opened).toBeLessThan(SLOW);
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

test('device swap lands on the newest position, not the last one written', async ({ browser }) => {
  const stub = new WebDavStub();
  const { phone, laptop } = await bothAtForty(browser, stub);
  const tablet = await device(browser, stub);
  await installVolume(tablet);
  await sync(tablet);

  // The phone's push stalls on its read of the file: it reads to p.44 FIRST,
  // but its merge lands only after the tablet's newer p.47 is up. The read
  // starts with the file's stamp (a PROPFIND: the phone holds the bytes it
  // last saw) and downloads only when that moved — whichever comes first is
  // held, so the server answers it with what it holds once released.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let held = false;
  await phone.route(`**${POSITIONS}`, async (route) => {
    if (!held && ['GET', 'PROPFIND'].includes(route.request().method())) {
      held = true;
      await gate;
    }
    await route.fallback();
  });
  await read(phone, [41, 42, 43, 44]);
  await expect.poll(() => held, { timeout: 15000 }).toBe(true);

  await phoneReadsOn(tablet, stub, [45, 46, 47]);
  release();
  // The phone's run finishes by adopting the newer position…
  await expect.poll(() => progress(phone), { timeout: 15000 }).toBe(47);
  // …and its later write keeps it: p.44 is older, whoever wrote last.
  expect(positionsFile(stub)[VOL][1]).toBe(47);

  await openVolume(laptop);
  await expect(counter(laptop, 47)).toBeVisible({ timeout: 20000 });
  await expect(laptop.getByText(/Continued from .+, p\.47/)).toBeVisible();
  expect(await progress(laptop)).toBe(47);
});

test("a cold start adopts the other device's position before the slow listing lands", async ({
  browser
}) => {
  const stub = new WebDavStub();
  const { phone, laptop } = await bothAtForty(browser, stub);
  await phoneReadsOn(phone, stub, [41, 42, 43, 44]);

  // The laptop starts cold, and its library listing (the Depth: infinity
  // PROPFIND every sync waits for) hangs until released.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let listingsHeld = 0;
  await laptop.route('http://stub.test/**', async (route) => {
    const request = route.request();
    if (isLibraryListing(request)) {
      listingsHeld++;
      await gate;
    }
    await route.fallback();
  });
  const putsBefore = positionPuts(stub);
  await laptop.reload();
  await expect.poll(() => listingsHeld, { timeout: 20000 }).toBeGreaterThan(0);

  // Before any listing: the position is already here, read by path.
  await expect.poll(() => progress(laptop), { timeout: 15000 }).toBe(44);
  await openVolume(laptop);
  await expect(counter(laptop, 44)).toBeVisible({ timeout: 20000 });
  expect(listingsHeld).toBeGreaterThan(0);
  // The probe only reads: no write before the listing can show every copy.
  expect(positionPuts(stub)).toBe(putsBefore);

  release();
  await sync(laptop);
  expect(await progress(laptop)).toBe(44);
  expect(positionsFile(stub)[VOL][1]).toBe(44);
});

test('smart sort moves the series the other device read, from the probe alone', async ({
  browser
}) => {
  const stub = new WebDavStub();
  const { phone, laptop } = await bothAtForty(browser, stub);

  // The laptop also has another series, read here AFTER the phone's p.40.
  await laptop.evaluate(async () => {
    const { db } = await import('/src/lib/catalog/db.ts');
    const thumb = new File([new Uint8Array([0])], 'thumb.webp', { type: 'image/webp' });
    await db.volumes.put({
      volume_uuid: 'e2e-other-volume',
      series_uuid: 'e2e-other-series',
      series_title: 'Other Series',
      volume_title: 'Vol 1',
      mokuro_version: '0.2.1',
      page_count: 50,
      character_count: 0,
      page_char_counts: Array(50).fill(0),
      thumbnail: thumb
    });
    const { updateProgress } = await import('/src/lib/settings/volume-data.ts');
    const { recordEvent } = await import('/src/lib/reading-history/record.ts');
    for (const p of [2, 3, 4]) {
      await recordEvent({
        kind: 'page',
        volume: 'e2e-other-volume',
        first_page: p,
        last_page: p,
        page_chars: [0],
        chars_before: 0,
        dwell_ms: 5,
        layout: 'single',
        orientation: 'portrait',
        viewport: { w: 400, h: 800 }
      });
      updateProgress('e2e-other-volume', p, 0);
      await new Promise((r) => setTimeout(r, 5));
    }
  });

  // Its own push lands first (the two devices never write at once here).
  await expect.poll(() => positionsFile(stub)['e2e-other-volume']?.[1], { timeout: 15000 }).toBe(4);

  /** Series titles in catalog order (smart sort is the default). */
  const order = async () =>
    laptop.evaluate(() => {
      const text = document.body.innerText;
      return ['Swap Series', 'Other Series']
        .map((title) => [title, text.indexOf(title)] as const)
        .filter(([, at]) => at >= 0)
        .sort((a, b) => a[1] - b[1])
        .map(([title]) => title);
    });
  await laptop.evaluate(() => (window.location.hash = '#/catalog'));
  await expect.poll(order, { timeout: 20000 }).toEqual(['Other Series', 'Swap Series']);

  // Then the phone reads on in Swap Series and only pushes its position.
  await phoneReadsOn(phone, stub, [41, 42, 43, 44]);

  // Cold start, listing held: only the probe can bring the phone's reading.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await laptop.route('http://stub.test/**', async (route) => {
    const request = route.request();
    if (isLibraryListing(request)) await gate;
    await route.fallback();
  });
  await laptop.reload();
  await expect.poll(() => progress(laptop), { timeout: 15000 }).toBe(44);
  await expect.poll(order, { timeout: 20000 }).toEqual(['Swap Series', 'Other Series']);
  release();
});

test('a cold start merges progress and history before the slow listing lands', async ({
  browser
}) => {
  const stub = new WebDavStub();
  const { phone, laptop } = await bothAtForty(browser, stub);
  // The phone reads on and runs a FULL sync: volume-data.json and its history
  // segment carry p.44. positions.json is taken away, so only those can.
  await read(phone, [41, 42, 43, 44]);
  await sync(phone);
  stub.files.delete(POSITIONS);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let listingsHeld = 0;
  await laptop.route('http://stub.test/**', async (route) => {
    if (isLibraryListing(route.request())) {
      listingsHeld++;
      await gate;
    }
    await route.fallback();
  });
  const writes = () =>
    stub.log.filter((l) => ['PUT', 'DELETE', 'MOVE', 'MKCOL'].includes(l.method)).length;
  await laptop.reload();
  await expect.poll(() => listingsHeld, { timeout: 20000 }).toBeGreaterThan(0);
  const writesBefore = writes();

  // Progress, from volume-data.json read by path:
  await expect.poll(() => progress(laptop), { timeout: 15000 }).toBe(44);
  // History, from history/ listed on its own: the phone's p.44 view is here.
  const phoneViews = () =>
    laptop.evaluate(async (VOL) => {
      const { getVolumeEvents } = await import('/src/lib/reading-history/turns-store.ts');
      const { historyDb } = await import('/src/lib/reading-history/history-db.ts');
      const { getOrCreateDeviceId } = await import('/src/lib/reading-history/record.ts');
      const own = await getOrCreateDeviceId(historyDb());
      return getVolumeEvents(VOL)
        .filter((e) => e.kind === 'page' && e.device !== own)
        .map((e) => (e as { first_page: number }).first_page)
        .sort((a, b) => a - b);
    }, VOL);
  await expect.poll(phoneViews, { timeout: 15000 }).toContain(44);
  await openVolume(laptop);
  await expect(counter(laptop, 44)).toBeVisible({ timeout: 20000 });

  // All of it before the listing, and read-only.
  expect(listingsHeld).toBeGreaterThan(0);
  expect(writes()).toBe(writesBefore);

  release();
  await sync(laptop);
  expect(await progress(laptop)).toBe(44);
});
