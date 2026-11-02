import { test, expect, type Browser, type Page } from '@playwright/test';
import { WebDavStub } from './helpers/webdav-stub';
import {
  POSITIONS,
  VOL,
  counter,
  device,
  installVolume,
  openVolume,
  positionsFile,
  read,
  sync
} from './helpers/positions';

/**
 * Look-up visits claim nothing: open a volume, page around, come back to the
 * page the visit started on having read (almost) nothing, and the position is
 * as it was — no newer stamp, nothing in `positions.json` that says otherwise.
 * The pages are picture pages (0 characters), so a page is read by dwell alone
 * (≥ 3 s).
 */

test.describe.configure({ timeout: 90_000 });

/** One device at p.40, synced and pushed. */
async function atForty(browser: Browser, stub: WebDavStub): Promise<Page> {
  const laptop = await device(browser, stub);
  await installVolume(laptop);
  await read(laptop, [38, 39, 40]);
  await sync(laptop);
  await expect.poll(() => positionsFile(stub)[VOL]?.[1], { timeout: 15000 }).toBe(40);
  return laptop;
}

async function stamp(page: Page): Promise<string | null> {
  return page.evaluate(async (VOL) => {
    const { volumesWithTrash } = await import('/src/lib/settings/volume-data.ts');
    let all: Record<string, { lastProgressUpdate: string }> = {};
    volumesWithTrash.subscribe((v) => (all = v))();
    return all[VOL]?.lastProgressUpdate ?? null;
  }, VOL);
}

/** Opened at p.40, the home view on screen a moment (the open check settled). */
async function openAtForty(laptop: Page) {
  await openVolume(laptop);
  await expect(counter(laptop, 40)).toBeVisible({ timeout: 20000 });
  await laptop.waitForTimeout(1500);
}

async function turn(laptop: Page, key: 'ArrowLeft' | 'ArrowRight', to: number) {
  await laptop.keyboard.press(key);
  await expect(counter(laptop, to)).toBeVisible();
}

const positionPutsSince = (stub: WebDavStub, from: number) =>
  stub.log.slice(from).filter((l) => l.method === 'PUT' && l.path === POSITIONS);

test('a look-up writes no position and keeps the stamp', async ({ browser }) => {
  const stub = new WebDavStub();
  const laptop = await atForty(browser, stub);
  const before = await stamp(laptop);
  const file = positionsFile(stub)[VOL];
  await openAtForty(laptop);
  const logFrom = stub.log.length;

  // RTL: ArrowLeft is forward. Two quick peeks and back.
  await turn(laptop, 'ArrowLeft', 41);
  await turn(laptop, 'ArrowLeft', 42);
  await turn(laptop, 'ArrowRight', 41);
  await turn(laptop, 'ArrowRight', 40);
  // Long enough for the 3 s push to have gone out, had the visit claimed one.
  await laptop.waitForTimeout(4000);

  expect(positionPutsSince(stub, logFrom)).toEqual([]);
  expect(await stamp(laptop)).toBe(before);
  expect(positionsFile(stub)[VOL]).toEqual(file);
});

test('a look-up whose peek went up ends with the file at the home page', async ({ browser }) => {
  const stub = new WebDavStub();
  const laptop = await atForty(browser, stub);
  await openAtForty(laptop);

  await turn(laptop, 'ArrowLeft', 41);
  // Stay on p.41 past the 3 s push: the peek's position leaves the device.
  await expect.poll(() => positionsFile(stub)[VOL]?.[1], { timeout: 10000 }).toBe(41);
  const peekAt = positionsFile(stub)[VOL][0];

  await turn(laptop, 'ArrowRight', 40);
  await expect.poll(() => positionsFile(stub)[VOL]?.[1], { timeout: 10000 }).toBe(40);
  // 1 ms above the upload it must beat: the visited page does not stick.
  expect(positionsFile(stub)[VOL][0]).toBe(peekAt + 1);
  expect(await stamp(laptop)).toBe(new Date(peekAt + 1).toISOString());
});

test('reading then coming home is reading', async ({ browser }) => {
  const stub = new WebDavStub();
  const laptop = await atForty(browser, stub);
  const before = await stamp(laptop);
  await openAtForty(laptop);

  // Three pages read (4 s each), then straight back to the start.
  for (const p of [41, 42, 43]) {
    await turn(laptop, 'ArrowLeft', p);
    await laptop.waitForTimeout(4000);
  }
  await turn(laptop, 'ArrowRight', 42);
  await turn(laptop, 'ArrowRight', 41);
  await turn(laptop, 'ArrowRight', 40);

  await expect.poll(() => positionsFile(stub)[VOL]?.[1], { timeout: 10000 }).toBe(40);
  const now = await stamp(laptop);
  expect(now).not.toBe(before);
  // The return turn's own fresh stamp, as any page turn: no restore happened.
  expect(positionsFile(stub)[VOL][0]).toBe(Date.parse(now!));
  expect(Date.parse(now!)).toBeGreaterThan(Date.parse(before!));
});
