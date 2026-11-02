import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { WebDavStub } from './helpers/webdav-stub';
import {
  POSITIONS,
  ROOT,
  device,
  installVolume,
  positionPuts,
  read,
  sync
} from './helpers/positions';

/**
 * BASELINE: what a page turn costs on the wire today, on a warm device with a
 * realistic library (300 read volumes in `volume-data.json`).
 *
 *   W1  turn + position push   — the `positions.json` PUT the turn arms
 *   W2  turn + full sync       — the sync the activity tracker runs after a turn
 *   W3  idle sync              — the same sync with nothing changed
 *
 * Prints `BANDWIDTH_JSON {...}` (and writes it to `$BANDWIDTH_OUT` when set),
 * so a change can prove its saving against these numbers.
 *
 * The stub does not model: HTTP 304 / ETag revalidation, Content-Encoding
 * (bytes are the raw bodies), PROPFIND header overhead (request/response
 * headers are not counted), CORS preflights (counted separately, not in the
 * window totals), or any provider other than WebDAV (Drive's post-upload
 * listing, MEGA, OneDrive).
 */

const OUT = process.env.BANDWIDTH_OUT;
const SEEDED_VOLUMES = 300;
const VOLUME_DATA = `${ROOT}/volume-data.json`;

interface Window {
  requests: number;
  preflights: number;
  bytesUp: number;
  bytesDown: number;
  byRequest: Record<string, { count: number; up: number; down: number }>;
  byPath: Record<string, { up: number; down: number }>;
}

function measure(stub: WebDavStub, from: number, preflightsFrom: number): Window {
  const entries = stub.log.slice(from);
  const w: Window = {
    requests: entries.length,
    preflights: stub.preflights - preflightsFrom,
    bytesUp: 0,
    bytesDown: 0,
    byRequest: {},
    byPath: {}
  };
  for (const e of entries) {
    const key = `${e.method} ${e.path}`;
    const r = (w.byRequest[key] ??= { count: 0, up: 0, down: 0 });
    r.count++;
    r.up += e.reqBytes;
    r.down += e.resBytes;
    const p = (w.byPath[e.path] ??= { up: 0, down: 0 });
    p.up += e.reqBytes;
    p.down += e.resBytes;
    w.bytesUp += e.reqBytes;
    w.bytesDown += e.resBytes;
  }
  return w;
}

/** Seed read volumes through the app's own store, so the file is the real shape. */
async function seedLibrary(page: Page, count: number) {
  await page.evaluate(async (count) => {
    const { updateProgress } = await import('/src/lib/settings/volume-data.ts');
    for (let i = 0; i < count; i++) {
      const uuid = `e2e-bw-vol-${String(i).padStart(3, '0')}`;
      updateProgress(uuid, 10 + (i % 150), 1000 + i * 37);
    }
  }, count);
}

/**
 * The sync the activity tracker would run. `flush()` fires `syncProgress`
 * without returning its promise, so we wait on the sync flag instead: it must
 * go true (the sync started) and then false (it ended).
 */
async function trackerSync(page: Page) {
  await page.evaluate(async () => {
    const { activityTracker } = await import('/src/lib/util/activity-tracker.ts');
    const { unifiedCloudManager } = await import('/src/lib/util/sync/unified-cloud-manager.ts');
    let syncing = false;
    let sawStart = false;
    const unsubscribe = unifiedCloudManager.isSyncing.subscribe((v) => {
      syncing = v;
      if (v) sawStart = true;
    });
    activityTracker.recordActivity();
    activityTracker.flush();
    const deadline = Date.now() + 30000;
    while (!sawStart && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    while (syncing && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    unsubscribe();
    if (!sawStart) throw new Error('the tracker never started a sync');
    if (syncing) throw new Error('the sync did not finish');
    // Anything the sync kicked off behind its result (progress resolution).
    await new Promise((r) => setTimeout(r, 1500));
  });
}

test('baseline: bytes and requests of a page-turn sync', async ({ browser }) => {
  test.setTimeout(120000);
  const stub = new WebDavStub();
  const page = await device(browser, stub);
  await installVolume(page);
  await seedLibrary(page, SEEDED_VOLUMES);
  await sync(page);
  // Warm: the cloud holds the full file and the first position push has settled.
  expect(stub.files.has(VOLUME_DATA)).toBe(true);
  await page.waitForTimeout(4500);
  await sync(page);
  await page.waitForTimeout(500);

  // W1: turn + position push.
  let from = stub.log.length;
  let preflightsFrom = stub.preflights;
  const putsBefore = positionPuts(stub);
  await read(page, [5]);
  await expect.poll(() => positionPuts(stub), { timeout: 15000 }).toBeGreaterThan(putsBefore);
  await page.waitForTimeout(500);
  const w1 = measure(stub, from, preflightsFrom);

  // W2: another turn + the tracker's full progress sync.
  await read(page, [6]);
  // Let the second turn's own position push settle first, so W2 is the sync alone.
  await expect.poll(() => positionPuts(stub), { timeout: 15000 }).toBeGreaterThan(putsBefore + 1);
  await page.waitForTimeout(500);
  from = stub.log.length;
  preflightsFrom = stub.preflights;
  await trackerSync(page);
  const w2 = measure(stub, from, preflightsFrom);

  // W3: idle sync, nothing changed.
  from = stub.log.length;
  preflightsFrom = stub.preflights;
  await trackerSync(page);
  const w3 = measure(stub, from, preflightsFrom);

  const result = {
    seededVolumes: SEEDED_VOLUMES,
    volumeDataBytes: stub.files.get(VOLUME_DATA)?.body.length ?? 0,
    positionsBytes: stub.files.get(POSITIONS)?.body.length ?? 0,
    windows: { W1_turn_position_push: w1, W2_turn_full_sync: w2, W3_idle_sync: w3 }
  };
  console.log(`BANDWIDTH_JSON ${JSON.stringify(result)}`);
  if (OUT) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(result, null, 2));
  }

  // Sanity only: this is a baseline.
  expect(result.volumeDataBytes).toBeGreaterThan(SEEDED_VOLUMES * 50);
  expect(w1.byRequest[`PUT ${POSITIONS}`]?.count).toBeGreaterThanOrEqual(1);
  expect(w2.byRequest[`GET ${VOLUME_DATA}`]?.count).toBeGreaterThanOrEqual(1);
  expect(w3.byRequest[`GET ${VOLUME_DATA}`]?.count).toBeGreaterThanOrEqual(1);
});
