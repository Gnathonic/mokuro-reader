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

test('device swap lands on the newest position, not the last one written', async ({ browser }) => {
  const stub = new WebDavStub();
  const { phone, laptop } = await bothAtForty(browser, stub);
  const tablet = await device(browser, stub);
  await installVolume(tablet);
  await sync(tablet);

  // The phone's push stalls on its read of the file: it reads to p.44 FIRST,
  // but its merge lands only after the tablet's newer p.47 is up.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let held = false;
  await phone.route(`**${POSITIONS}`, async (route) => {
    if (route.request().method() === 'GET') {
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
