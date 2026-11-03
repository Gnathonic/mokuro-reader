import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { WebDavStub } from './helpers/webdav-stub';
import {
  POSITIONS,
  ROOT,
  VOL,
  device,
  installVolume,
  positionPuts,
  read,
  sync
} from './helpers/positions';

/**
 * What a page turn costs on the wire, on a warm device with a realistic
 * library (300 read volumes in `volume-data.json`), with the reader open on
 * the volume being read (a reading session, `util/sync/reading-session.ts`).
 *
 *   W1  turn + position push   — the `positions.json` PUT the turn arms
 *   W2  turn + full sync       — the sync the activity tracker runs after a turn
 *   W3  idle sync              — the same sync with nothing changed
 *   W4  session end            — the reader closes; its flush's sync
 *
 * Prints `BANDWIDTH_JSON {...}` (and writes it to `$BANDWIDTH_OUT` when set),
 * so a change can prove its saving against these numbers (the baseline before
 * the sync-bandwidth work: W1 7 requests / 25 KB down, W2 17 / 29 KB up /
 * 60 KB down, W3 6 / 57 KB down —
 * `docs/superpowers/specs/2026-11-02-sync-bandwidth-design.md`). The budgets
 * below each fail on that baseline, with headroom over what the work costs.
 *
 * Mid-session, a sync whose only change is the turned page leaves
 * `volume-data.json` alone (`volume-data-deferral.ts`): `positions.json`
 * already carries the page. The session's end uploads it (W4).
 *
 * Root-file reads are conditional (`root-file-memo.ts`): a PROPFIND Depth 0
 * per file, the body only when its `getetag` moved. The stub mints a strong
 * ETag on every write, as a real server does.
 *
 * The stub does not model: HTTP 304 (the reader never sends `If-None-Match`),
 * Content-Encoding (bytes are the raw bodies), PROPFIND header overhead
 * (request/response headers are not counted), CORS preflights (counted
 * separately, not in the window totals), or any provider other than WebDAV
 * (Drive's post-upload listing, MEGA, OneDrive).
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

/** The reader opens / closes the volume (what `ReaderView` notes on mount / leave). */
async function readerOpen(page: Page, open: boolean) {
  await page.evaluate(
    async ({ VOL, open }) => {
      const m = await import('/src/lib/positions/reader-open.ts');
      if (open) m.noteReaderOpened(VOL);
      else m.noteReaderClosed(VOL);
    },
    { VOL, open }
  );
}

const requestsOf = (w: Window, key: string) => w.byRequest[key]?.count ?? 0;

test('a page-turn sync stays within its request and byte budgets', async ({ browser }) => {
  test.setTimeout(120000);
  const stub = new WebDavStub();
  const page = await device(browser, stub);
  await installVolume(page);
  await seedLibrary(page, SEEDED_VOLUMES);
  // The volume being read is already in the file: a turn moves an existing
  // record (a first read adds one, which always uploads).
  await read(page, [4]);
  await sync(page);
  // Warm: the cloud holds the full file and the first position push has settled.
  expect(stub.files.has(VOLUME_DATA)).toBe(true);
  await page.waitForTimeout(4500);
  await sync(page);
  await page.waitForTimeout(500);
  const volumeDataPutsWarm = stub.log.filter(
    (l) => l.method === 'PUT' && l.path === VOLUME_DATA
  ).length;
  await readerOpen(page, true);

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

  // W4: the reader closes (BEFORE the flush, as ReaderView does); the flush's
  // sync ends the session and uploads what the session deferred.
  await readerOpen(page, false);
  from = stub.log.length;
  preflightsFrom = stub.preflights;
  await trackerSync(page);
  const w4 = measure(stub, from, preflightsFrom);

  const result = {
    seededVolumes: SEEDED_VOLUMES,
    volumeDataBytes: stub.files.get(VOLUME_DATA)?.body.length ?? 0,
    positionsBytes: stub.files.get(POSITIONS)?.body.length ?? 0,
    windows: {
      W1_turn_position_push: w1,
      W2_turn_full_sync: w2,
      W3_idle_sync: w3,
      W4_session_end: w4
    }
  };
  console.log(`BANDWIDTH_JSON ${JSON.stringify(result)}`);
  if (OUT) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(result, null, 2));
  }

  expect(result.volumeDataBytes).toBeGreaterThan(SEEDED_VOLUMES * 50);
  expect(volumeDataPutsWarm).toBeGreaterThanOrEqual(1);

  // Budgets. Baseline in brackets; each budget fails on it.
  //
  // No root file this device already holds is downloaded again — neither its
  // own last write nor an unchanged copy: no GET (body) and no HEAD probe.
  // [W1 positions.json GET 24 KB; W2 volume-data/positions/profiles 57 KB;
  // W3 the same 57 KB]
  const rootGets = (w: Window) =>
    Object.entries(w.byRequest)
      .filter(([key]) => /^(GET|HEAD) \/mokuro-reader\/[^/]+\.json$/.test(key))
      .reduce((n, [, r]) => n + r.count, 0);
  for (const w of [w1, w2, w3, w4]) expect(rootGets(w)).toBe(0);

  // W1: the turn's own positions.json PUT, and around it only stamps.
  // [7 requests, 25 KB down]
  expect(requestsOf(w1, `PUT ${POSITIONS}`)).toBeGreaterThanOrEqual(1);
  expect(requestsOf(w1, `GET ${POSITIONS}`)).toBe(0);
  expect(w1.bytesDown).toBeLessThan(5_000);
  expect(w1.requests).toBeLessThanOrEqual(6);

  // W2: mid-session, the turn rides positions.json; volume-data.json is
  // neither downloaded nor uploaded. [PUT 28.5 KB up, 60 KB down]
  expect(requestsOf(w2, `GET ${VOLUME_DATA}`)).toBe(0);
  expect(requestsOf(w2, `PUT ${VOLUME_DATA}`)).toBe(0);
  expect(requestsOf(w2, `DELETE ${VOLUME_DATA}`)).toBe(0);
  expect(w2.bytesUp).toBeLessThan(2_000); // the history events file
  expect(w2.bytesDown).toBeLessThan(10_000);
  expect(w2.requests).toBeLessThanOrEqual(14);

  // W3: idle, nothing goes up and only stamps come down. [6 requests, 57 KB]
  expect(w3.bytesUp).toBe(0);
  expect(w3.bytesDown).toBeLessThan(5_000);
  expect(w3.requests).toBeLessThanOrEqual(4);

  // W4: the session's end uploads the deferred volume-data.json once, still
  // without downloading any root file.
  expect(requestsOf(w4, `PUT ${VOLUME_DATA}`)).toBe(1);
  expect(w4.bytesDown).toBeLessThan(10_000);
  const cloudVolumeData = JSON.parse(stub.files.get(VOLUME_DATA)!.body.toString());
  expect(cloudVolumeData[VOL]?.progress).toBe(6);
});
