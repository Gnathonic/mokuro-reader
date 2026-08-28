import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
// Imported for its side effect as much as its export: the counter installs its
// `IDBDatabase.transaction` wrapper at module load, and Dexie binds that method
// once when it opens a database — so it must be in place before the Dexie
// instance below is ever used. See `idb-op-counter.ts`.
import { countIdbOps } from '$lib/catalog/__tests__/idb-op-counter';
import type { VolumeMetadata } from '$lib/types';

/**
 * The lazy per-volume sidecar backfill (`sidecar-backfill.ts`): installed
 * volumes whose cloud archive predates the sidecar convention get their
 * `.mokuro`/cover uploaded from local data — without ever fetching a listing,
 * without retrying failures in-session, and never for a read-only provider.
 *
 * `unifiedCloudManager` is mocked with the REAL manager's contract: its
 * `uploadFile` appends the uploaded file to the same listing fixture every
 * accessor reads, mirroring the `cache.add` the real `uploadFile` performs
 * (asserted directly in `unified-cloud-manager.test.ts`) — which is exactly
 * the mechanism the convergence tests below pin.
 *
 * `db` is a REAL Dexie over `fake-indexeddb`, not a hand-rolled stub — same
 * discipline as `history-rows.test.ts`. The sweep trigger's contract (Finding
 * 2's fix) is about which Dexie OPERATIONS it issues: keys-only reads before
 * ever touching a row, and `db.volumes.toArray()`/`.getAll` never called in
 * the steady state. A stub with hand-written `.toArray()`/`.get()` methods
 * would make that property untestable — `countIdbOps` intercepts real
 * `IDBObjectStore`/`IDBIndex` prototype methods, and a plain JS function
 * triggers none of them.
 */

// ---------------------------------------------------------------------------
// Shared fixture state (hoisted so the vi.mock factories can close over it).
// ---------------------------------------------------------------------------

const cloud = vi.hoisted(() => {
  const state = {
    files: [] as Array<Record<string, unknown> & { path: string }>,
    // `undefined` by default, matching a provider that cannot report an
    // account scope — `attemptKey` must fall back to `provider.type` alone in
    // that case (Finding 4's "a null scope behaves as today").
    accountScope: undefined as string | undefined
  };
  const listCloudVolumes = vi.fn(async () => [...state.files]);
  const provider = {
    type: 'webdav',
    listCloudVolumes,
    getStatus: () => ({ accountScope: state.accountScope }),
    // Worker-path capability, toggled per test. `undefined` (the beforeEach
    // reset) keeps every pre-existing test on the serial main-thread path —
    // the drain requires `=== true`.
    supportsWorkerUpload: undefined as boolean | undefined,
    uploadConcurrencyLimit: 4
  };
  const fetchAllCloudVolumes = vi.fn(async () => {});
  const uploadFile = vi.fn();
  const defaultUpload = async (path: string, blob: Blob) => {
    // Mirrors the real `unifiedCloudManager.uploadFile`: the upload lands in
    // the provider's listing cache immediately (`cache.add`), so every later
    // cache read sees it without any listing fetch.
    state.files.push({
      provider: 'webdav',
      fileId: `up-${path}`,
      path,
      modifiedTime: new Date().toISOString(),
      size: blob.size
    });
    return `up-${path}`;
  };
  const foldKey = (value: string) =>
    value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  const getCloudVolumesBySeries = (title: string) =>
    state.files.filter((file) => file.path.startsWith(`${title}/`));
  const resolveCloudFolderTitle = (title: string) => {
    if (getCloudVolumesBySeries(title).length > 0) return title;
    const folders = new Set(state.files.map((file) => file.path.split('/')[0]));
    for (const folder of [...folders].sort()) {
      if (foldKey(folder) === foldKey(title)) return folder;
    }
    return title;
  };
  return {
    state,
    provider,
    uploadFile,
    defaultUpload,
    fetchAllCloudVolumes,
    manager: {
      getActiveProvider: () => provider,
      getAllCloudVolumes: () => [...state.files],
      getCloudVolumesBySeries,
      resolveCloudFolderTitle,
      // The backfill must use the WRITE-AND-FORGET path: on Google Drive the
      // ordinary uploadFile refetches the whole listing after every upload.
      // All upload assertions in this suite read the `uploadFile` spy, which
      // here records the BLIND uploads; the ordinary method throws so any
      // regression back to it fails every upload test loudly.
      blindUploadFile: uploadFile,
      uploadFile: (() => {
        throw new Error('sidecar backfill must upload through blindUploadFile');
      }) as never,
      fetchAllCloudVolumes
    }
  };
});

const gate = vi.hoisted(() => ({ writable: true }));
const cacheState = vi.hoisted(() => ({ loaded: true }));
const scheduleSeriesFileWrite = vi.hoisted(() => vi.fn());

/**
 * The provider cache's `add` — what the worker path's completion handler
 * calls directly (the main-thread path's adds happen inside the real
 * `blindUploadFile`, mirrored by the fixture's `defaultUpload`). The
 * beforeEach default implementation pushes the entry into the same listing
 * fixture, mirroring production: a cache add IS what the next eligibility
 * check reads.
 */
const cacheAdd = vi.hoisted(() => vi.fn());

/**
 * Fake shared worker pool for the DEFERRED feed's parallel dispatch tests.
 * `addTask` only records; each test settles tasks itself via
 * `complete`/`fail`, so dispatch timing and completion order are fully under
 * test control.
 */
const workerPool = vi.hoisted(() => {
  interface FakeTask {
    id: string;
    data?: Record<string, unknown>;
    provider?: string;
    providerConcurrencyLimit?: number;
    memoryRequirement?: number;
    onComplete?: (result: unknown, done: () => void) => void;
    onError?: (error: unknown) => void;
    settled?: boolean;
  }
  const state = { tasks: [] as FakeTask[] };
  const incrementPoolUsers = vi.fn();
  const decrementPoolUsers = vi.fn();
  const addTask = vi.fn((task: FakeTask) => {
    state.tasks.push(task);
  });
  return {
    state,
    addTask,
    incrementPoolUsers,
    decrementPoolUsers,
    /** Tasks dispatched to the pool and not yet completed/failed by the test. */
    open: () => state.tasks.filter((task) => !task.settled),
    complete: (task: FakeTask, result: unknown) => {
      task.settled = true;
      task.onComplete?.(result, () => {});
    },
    fail: (task: FakeTask, error: string) => {
      task.settled = true;
      task.onError?.({ type: 'error', error });
    }
  };
});

const workerCreds = vi.hoisted(() => ({
  getUploadWorkerCredentials: vi.fn(async () => ({
    webdavUrl: 'https://dav.example',
    webdavUsername: 'user',
    webdavPassword: 'secret'
  }))
}));

const downloadQueueMock = vi.hoisted(() => {
  let value: unknown[] = [];
  const subs = new Set<(v: unknown[]) => void>();
  return {
    subscribe(fn: (v: unknown[]) => void) {
      subs.add(fn);
      fn(value);
      return () => subs.delete(fn);
    },
    set(v: unknown[]) {
      value = v;
      subs.forEach((fn) => fn(value));
    }
  };
});

vi.mock('./unified-cloud-manager', () => ({ unifiedCloudManager: cloud.manager }));
vi.mock('./cache-manager', () => ({
  cacheManager: { getCache: () => ({ isLoaded: () => cacheState.loaded, add: cacheAdd }) }
}));
// The worker plumbing the DEFERRED feed dynamically imports. The pool mock
// hands tasks to the fixture above instead of real Workers; the credentials
// helper is the module the backup queue shares.
vi.mock('../file-processing-pool', () => ({
  getFileProcessingPool: async () => ({ addTask: workerPool.addTask }),
  incrementPoolUsers: workerPool.incrementPoolUsers,
  decrementPoolUsers: workerPool.decrementPoolUsers
}));
vi.mock('../upload-worker-credentials', () => ({
  getUploadWorkerCredentials: workerCreds.getUploadWorkerCredentials
}));
/**
 * A REAL Dexie over `fake-indexeddb`, not a stub — see the module doc above
 * for why this suite needs the real thing rather than a hand-rolled `db`.
 */
vi.mock('$lib/catalog/db', async () => {
  const { CatalogDexieV3 } =
    await vi.importActual<typeof import('$lib/catalog/db-v3')>('$lib/catalog/db-v3');
  const db = new CatalogDexieV3('mokuro_v3_sidecar_backfill_test');
  // `saveVolume` (used by the import-feed tests below) fires a background
  // `processThumbnails` whenever a volume lands without a cover. Its
  // whole-table scan would bleed IndexedDB operations into a LATER test's
  // `countIdbOps` window; this suite is not about thumbnail recovery, so it
  // is inert here.
  db.processThumbnails = async () => {};
  return { db };
});
vi.mock('$lib/metadata/series-backfill', () => ({
  hasWritableNonServerProvider: () => gate.writable
}));
vi.mock('$lib/metadata/series-file-sync', () => ({ scheduleSeriesFileWrite }));
vi.mock('$lib/util/download-queue', () => ({ downloadQueue: downloadQueueMock }));
// `loadVolumeSidecars` stays REAL (it reads the mocked db), so the `.mokuro`
// asserted below is byte-for-byte what the backup/export paths serialize.
// These two are imported by `volume-sidecars.ts` for its series-file export
// helper only; stubbed so their own import graphs stay out of this suite.
vi.mock('$lib/metadata/store', () => ({ getSeriesMetadataForTitle: vi.fn(async () => []) }));
vi.mock('$lib/metadata/series-index', () => ({ getSeriesIndex: vi.fn(async () => undefined) }));

import { db } from '$lib/catalog/db';
import {
  _drainForTests,
  _resetSidecarBackfillForTests,
  queueSidecarBackfillForVolume,
  queueSidecarBackfillFromImport,
  sweepInstalledVolumesForSidecarBackfill
} from './sidecar-backfill';
// REAL import pipeline pieces for the import-feed tests: `saveVolume` writes
// through the mocked-to-real Dexie above, and the sidecar builders are the
// production serializers whose byte-identity the tests below pin.
import { saveVolume } from '$lib/import/database';
import type { ProcessedVolume } from '$lib/import/types';
import { buildVolumeSidecarsFromData, loadVolumeSidecars } from '$lib/util/volume-sidecars';
// The WORKER feed's serializer (runs inside `unified-file-worker.ts` in
// production) and the real main schema, for the byte-identity three-way below.
import { generateVolumeSidecarsFromDb } from '$lib/util/compress-volume';
import { CatalogDexieV3 } from '$lib/catalog/db-v3';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listed(path: string, size = 1_000): Record<string, unknown> & { path: string } {
  return {
    provider: 'webdav',
    fileId: `id-${path}`,
    path,
    modifiedTime: '2026-08-01T00:00:00Z',
    size
  };
}

function installedVolume(overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    volume_uuid: 'uuid-1',
    series_uuid: 'series-uuid-1',
    series_title: 'Legacy Series',
    volume_title: 'Volume 01',
    mokuro_version: '0.2.1',
    page_count: 2,
    character_count: 42,
    page_char_counts: [10, 42],
    thumbnail: new File([new Uint8Array([1, 2, 3, 4])], 'thumb.webp', { type: 'image/webp' }),
    ...overrides
  } as VolumeMetadata;
}

/** Write an installed volume row AND its OCR row to the real db. */
async function withOcr(
  volume: VolumeMetadata,
  pages: unknown[] = [{ img_width: 100 }]
): Promise<void> {
  await db.volumes.put(volume);
  await db.volume_ocr.put({ volume_uuid: volume.volume_uuid, pages } as never);
}

/** Await the drain to completion, across any re-kick its `finally` performs. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await _drainForTests();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function uploadedPaths(): string[] {
  return cloud.uploadFile.mock.calls.map((call) => call[0] as string);
}

beforeEach(async () => {
  _resetSidecarBackfillForTests();
  await db.volumes.clear();
  await db.volume_ocr.clear();
  await db.volume_files.clear();
  cloud.state.files.length = 0;
  cloud.state.accountScope = undefined;
  cloud.uploadFile.mockReset();
  cloud.uploadFile.mockImplementation(cloud.defaultUpload);
  cloud.fetchAllCloudVolumes.mockClear();
  cloud.provider.listCloudVolumes.mockClear();
  cloud.provider.supportsWorkerUpload = undefined;
  cloud.provider.uploadConcurrencyLimit = 4;
  scheduleSeriesFileWrite.mockClear();
  gate.writable = true;
  cacheState.loaded = true;
  downloadQueueMock.set([]);
  workerPool.state.tasks.length = 0;
  workerPool.addTask.mockClear();
  workerPool.incrementPoolUsers.mockClear();
  workerPool.decrementPoolUsers.mockClear();
  workerCreds.getUploadWorkerCredentials.mockClear();
  cacheAdd.mockReset();
  // Mirror of production: `cache.add` puts the entry where every cache read
  // (the listing fixture) sees it — that IS the convergence mechanism.
  cacheAdd.mockImplementation((path: string, entry: Record<string, unknown>) => {
    cloud.state.files.push({ ...entry, path });
  });
});

// ---------------------------------------------------------------------------
// The feature
// ---------------------------------------------------------------------------

describe('sidecar backfill — the sweep trigger', () => {
  it('uploads both missing sidecars for an installed volume the listing shows bare', async () => {
    await withOcr(installedVolume());
    cloud.state.files.push(listed('Legacy Series/Volume 01.cbz'));

    await sweepInstalledVolumesForSidecarBackfill();
    await settle();

    expect(uploadedPaths().sort()).toEqual([
      'Legacy Series/Volume 01.mokuro',
      'Legacy Series/Volume 01.webp'
    ]);

    // The `.mokuro` is the shared serialization (`buildMokuroMetadata` via
    // `loadVolumeSidecars`), not a reinvention: real title/uuid/chars/pages.
    const mokuroCall = cloud.uploadFile.mock.calls.find((call) =>
      (call[0] as string).endsWith('.mokuro')
    );
    const parsed = JSON.parse(await (mokuroCall![1] as File).text());
    expect(parsed).toMatchObject({
      version: '0.2.1',
      title: 'Legacy Series',
      title_uuid: 'series-uuid-1',
      volume: 'Volume 01',
      volume_uuid: 'uuid-1',
      chars: 42
    });
    expect(parsed.pages).toEqual([{ img_width: 100 }]);

    // No `series.json` write rides this upload — see the dedicated "series.json
    // writes" describe block below (Finding 1) for the pinned, positive-control
    // version of this assertion.
    expect(scheduleSeriesFileWrite).not.toHaveBeenCalled();
  });

  it('never fetches a listing anywhere in the flow', async () => {
    await withOcr(installedVolume());
    cloud.state.files.push(listed('Legacy Series/Volume 01.cbz'));

    await sweepInstalledVolumesForSidecarBackfill();
    await settle();

    // Positive control first: the flow really ran all the way to uploads.
    expect(cloud.uploadFile).toHaveBeenCalledTimes(2);
    expect(cloud.fetchAllCloudVolumes).not.toHaveBeenCalled();
    expect(cloud.provider.listCloudVolumes).not.toHaveBeenCalled();
  });

  it('leaves a volume alone when both sidecars are already listed', async () => {
    await withOcr(installedVolume());
    cloud.state.files.push(
      listed('Legacy Series/Volume 01.cbz'),
      listed('Legacy Series/Volume 01.mokuro'),
      listed('Legacy Series/Volume 01.webp')
    );

    await sweepInstalledVolumesForSidecarBackfill();
    await settle();

    expect(cloud.uploadFile).not.toHaveBeenCalled();
    expect(scheduleSeriesFileWrite).not.toHaveBeenCalled();
  });

  it('uploads only the missing HALF when the other sidecar exists', async () => {
    await withOcr(installedVolume());
    cloud.state.files.push(
      listed('Legacy Series/Volume 01.cbz'),
      listed('Legacy Series/Volume 01.mokuro')
    );

    await sweepInstalledVolumesForSidecarBackfill();
    await settle();

    expect(uploadedPaths()).toEqual(['Legacy Series/Volume 01.webp']);
  });

  it('uploads only the cover for an image-only installed volume — never an empty mokuro', async () => {
    // No OCR row, mokuro_version '' — the image-only convention.
    await db.volumes.put(installedVolume({ mokuro_version: '' }));
    cloud.state.files.push(listed('Legacy Series/Volume 01.cbz'));

    await sweepInstalledVolumesForSidecarBackfill();
    await settle();

    expect(uploadedPaths()).toEqual(['Legacy Series/Volume 01.webp']);
    expect(uploadedPaths().some((path) => path.endsWith('.mokuro'))).toBe(false);
  });

  it('skips a volume whose archive is absent from the listing — silently, creating nothing', async () => {
    const debugSpy = vi.spyOn(console, 'debug');
    // Enqueued FIRST (insertion order = drain order): a crash here instead of
    // a silent skip would show up as noise on the spy, not just as a missing
    // upload. The folder exists but holds someone ELSE's archive; a second
    // volume's whole folder is missing; a third volume qualifies and must
    // still be served after the two skips.
    await withOcr(installedVolume());
    await withOcr(
      installedVolume({ volume_uuid: 'uuid-2', series_title: 'Unlisted', volume_title: 'V' })
    );
    await withOcr(
      installedVolume({ volume_uuid: 'uuid-3', volume_title: 'Volume 03', thumbnail: undefined })
    );
    cloud.state.files.push(
      listed('Legacy Series/Some Other Volume.cbz'),
      listed('Legacy Series/Volume 03.cbz')
    );

    await sweepInstalledVolumesForSidecarBackfill();
    queueSidecarBackfillForVolume('uuid-1');
    queueSidecarBackfillForVolume('uuid-2');
    await settle();

    expect(uploadedPaths()).toEqual(['Legacy Series/Volume 03.mokuro']);
    expect(debugSpy).not.toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  it('ignores placeholder and metadata-only rows', async () => {
    await db.volumes.put(installedVolume({ isPlaceholder: true } as Partial<VolumeMetadata>));
    await db.volumes.put(
      installedVolume({
        volume_uuid: 'uuid-2',
        metadata_only: true
      } as Partial<VolumeMetadata>)
    );
    cloud.state.files.push(listed('Legacy Series/Volume 01.cbz'));

    await sweepInstalledVolumesForSidecarBackfill();
    await settle();

    expect(cloud.uploadFile).not.toHaveBeenCalled();
  });

  it('names the sidecars after the ARCHIVE stem, not the local spelling', async () => {
    // Local title composed (NFC), cloud folder/file decomposed (NFD): they
    // fold alike, and the upload must land beside the archive's spelling.
    const nfdSeries = 'ポケモン'.normalize('NFD');
    const nfdVolume = 'ポケモン 1'.normalize('NFD');
    await withOcr(
      installedVolume({
        series_title: 'ポケモン'.normalize('NFC'),
        volume_title: 'ポケモン 1'.normalize('NFC')
      })
    );
    cloud.state.files.push(listed(`${nfdSeries}/${nfdVolume}.cbz`));

    await sweepInstalledVolumesForSidecarBackfill();
    await settle();

    expect(uploadedPaths().sort()).toEqual([
      `${nfdSeries}/${nfdVolume}.mokuro`,
      `${nfdSeries}/${nfdVolume}.webp`
    ]);
  });

  it('never queues an already-converged volume, even in a folder with a genuine gap', async () => {
    // Same folder as the gap volume, so folder-level scoping alone cannot
    // save this test — only the per-volume wantsMokuro/wantsCover pre-filter
    // can keep the converged volume out of `pending`.
    await withOcr(installedVolume({ volume_uuid: 'bare-1', volume_title: 'Volume 01' }));
    await withOcr(installedVolume({ volume_uuid: 'covered-1', volume_title: 'Volume 02' }));
    cloud.state.files.push(
      listed('Legacy Series/Volume 01.cbz'),
      listed('Legacy Series/Volume 02.cbz'),
      listed('Legacy Series/Volume 02.mokuro'),
      listed('Legacy Series/Volume 02.webp')
    );

    const counts = await countIdbOps(async () => {
      await sweepInstalledVolumesForSidecarBackfill();
      await settle();
    });

    // Positive control: the genuine gap really got backfilled.
    expect(uploadedPaths().sort()).toEqual([
      'Legacy Series/Volume 01.mokuro',
      'Legacy Series/Volume 01.webp'
    ]);
    // If the converged volume had entered `pending`, `drain()` would have
    // run `backfillOne` for it too, costing at least one more
    // `db.volumes.get` (its own authoritative re-check) beyond what
    // processing the bare volume alone costs: the folder-scoped `bulkGet`
    // (one `get` per key, per `idb-op-counter.ts`'s own doc) reads BOTH
    // rows (2), `backfillOne` re-reads the bare volume once more (1), and
    // `loadVolumeSidecars` reads it a third time (1) — 4 total. A pre-filter
    // that let the covered volume through would add a 5th: `backfillOne`'s
    // own re-read of it before its inner check returns early.
    expect(counts['volumes.get'] ?? 0).toBe(4);
  });

  it('never uploads a PNG thumbnail as a cover sidecar — hasCoverSidecarExtension rejects it', async () => {
    await withOcr(
      installedVolume({
        thumbnail: new File([new Uint8Array([1, 2, 3, 4])], 'thumb.png', { type: 'image/png' })
      })
    );
    cloud.state.files.push(listed('Legacy Series/Volume 01.cbz'));

    await sweepInstalledVolumesForSidecarBackfill();
    await settle();

    // The `.mokuro` still uploads — only the cover half is rejected, because
    // a PNG has no recognized cover-sidecar extension (`hasCoverSidecarExtension`,
    // `cloud-sidecar-stamps.ts`). This is the reason that export exists: an
    // upload here would land as a listing entry no cover lookup ever finds.
    expect(uploadedPaths()).toEqual(['Legacy Series/Volume 01.mokuro']);
    expect(uploadedPaths().some((path) => path.endsWith('.png'))).toBe(false);
  });
});

describe('sidecar backfill — the sweep never scans blobs it does not need (Finding 2)', () => {
  it('the steady state (every archive already has both sidecars) deserializes zero blob bytes and never scans the whole table', async () => {
    // A fully converged library: several installed volumes, each row
    // carrying a real thumbnail blob, and the listing already showing BOTH
    // sidecars for every one of them.
    for (let i = 1; i <= 5; i++) {
      const title = `Volume ${String(i).padStart(2, '0')}`;
      await withOcr(installedVolume({ volume_uuid: `uuid-${i}`, volume_title: title }));
      cloud.state.files.push(
        listed(`Legacy Series/${title}.cbz`),
        listed(`Legacy Series/${title}.mokuro`),
        listed(`Legacy Series/${title}.webp`)
      );
    }

    const counts = await countIdbOps(async () => {
      await sweepInstalledVolumesForSidecarBackfill();
      await settle();
    });

    // Positive control: there really were installed rows carrying
    // thumbnails that an unconditional `db.volumes.toArray()` would have
    // deserialized.
    expect(await db.volumes.count()).toBe(5);
    expect(cloud.uploadFile).not.toHaveBeenCalled();

    expect(counts['volumes.getAll'] ?? 0).toBe(0);
    expect(counts['volumes.bytes'] ?? 0).toBe(0);
    // Stronger than the two above: NO transaction against `volumes` opens at
    // all — not even the keys-only `orderBy().uniqueKeys()` read. Without
    // this, dropping just the `gapFolderKeys.size === 0` early return (and
    // relying on the LATER `matchingLiterals.length === 0` guard to still
    // bail before any bytes are read) would pass the two assertions above
    // while quietly issuing one index-only transaction per listing on a
    // fully converged library — verified: removing that one early return
    // leaves this suite green except for this line.
    expect(counts['transactions'] ?? 0).toBe(0);
  });

  it('a gap in one folder never scans blobs from an unrelated, fully-converged folder', async () => {
    // The gap folder: one bare archive to backfill.
    await withOcr(installedVolume({ volume_uuid: 'gap-1', series_title: 'Gap Series' }));
    cloud.state.files.push(listed('Gap Series/Volume 01.cbz'));

    // A large, unrelated, fully-converged folder sitting in the same table —
    // its rows carry big thumbnails a whole-table scan would have paid for.
    const bigBlob = new Uint8Array(200 * 1024);
    for (let i = 1; i <= 10; i++) {
      const title = `Volume ${String(i).padStart(2, '0')}`;
      await withOcr(
        installedVolume({
          volume_uuid: `conv-${i}`,
          series_title: 'Converged Series',
          volume_title: title,
          thumbnail: new File([bigBlob], 'thumb.webp', { type: 'image/webp' })
        })
      );
      cloud.state.files.push(
        listed(`Converged Series/${title}.cbz`),
        listed(`Converged Series/${title}.mokuro`),
        listed(`Converged Series/${title}.webp`)
      );
    }

    const counts = await countIdbOps(async () => {
      await sweepInstalledVolumesForSidecarBackfill();
      await settle();
    });

    // Positive control: the gap really got backfilled, and there really was
    // ~2 MB of converged-folder thumbnails on the table.
    expect(uploadedPaths().sort()).toEqual([
      'Gap Series/Volume 01.mokuro',
      'Gap Series/Volume 01.webp'
    ]);
    expect(counts['volumes.getAll'] ?? 0).toBe(0);
    // Only the gap volume's own tiny (4-byte) thumbnail can have been
    // deserialized, however many times its row was re-read — nowhere near
    // the 2 MB the converged folder carries.
    expect(counts['volumes.bytes'] ?? 0).toBeLessThan(1024);
  });
});

describe('sidecar backfill — series.json writes (Finding 1)', () => {
  it('the sweep trigger never schedules a series.json write, even after uploading both sidecars', async () => {
    await withOcr(installedVolume());
    cloud.state.files.push(listed('Legacy Series/Volume 01.cbz'));

    await sweepInstalledVolumesForSidecarBackfill();
    await settle();

    // Positive control: the upload really happened — this is the exact
    // moment the old code scheduled a write.
    expect(cloud.uploadFile).toHaveBeenCalledTimes(2);
    // `uploadFile`'s cache entry is stamped with the CLIENT clock
    // (`new Date().toISOString()`), and `cloud-sidecar-stamps.ts` forbids a
    // `series.json` built from that. Only the next REAL listing's reconcile
    // pass may publish this folder's stamp.
    expect(scheduleSeriesFileWrite).not.toHaveBeenCalled();
  });

  it('the install trigger never schedules a series.json write, even after uploading both sidecars', async () => {
    await withOcr(installedVolume());
    cloud.state.files.push(listed('Legacy Series/Volume 01.cbz'));

    queueSidecarBackfillForVolume('uuid-1');
    await settle();

    expect(cloud.uploadFile).toHaveBeenCalledTimes(2);
    expect(scheduleSeriesFileWrite).not.toHaveBeenCalled();
  });
});

describe('sidecar backfill — convergence', () => {
  it('a successful upload converges: the next sweep finds nothing to do', async () => {
    await withOcr(installedVolume());
    cloud.state.files.push(listed('Legacy Series/Volume 01.cbz'));

    await sweepInstalledVolumesForSidecarBackfill();
    await settle();
    expect(cloud.uploadFile).toHaveBeenCalledTimes(2);

    // A NEW session's sweep (session memory cleared, cap reset) against the
    // SAME cache the uploads updated: the volume no longer qualifies. This is
    // convergence via the cache the upload path mutates — no listing fetch
    // happened between the two sweeps (asserted below), so the only way this
    // passes is that the uploads themselves became visible to the check.
    _resetSidecarBackfillForTests();
    await sweepInstalledVolumesForSidecarBackfill();
    await settle();

    expect(cloud.uploadFile).toHaveBeenCalledTimes(2);
    expect(cloud.fetchAllCloudVolumes).not.toHaveBeenCalled();
  });

  it('a failed upload is not retried within the session', async () => {
    await withOcr(installedVolume({ thumbnail: undefined }));
    cloud.state.files.push(listed('Legacy Series/Volume 01.cbz'));
    cloud.uploadFile.mockRejectedValue(new Error('quota exceeded'));

    await sweepInstalledVolumesForSidecarBackfill();
    await settle();
    // Positive control: the first sweep really attempted the upload.
    expect(cloud.uploadFile).toHaveBeenCalledTimes(1);
    expect(scheduleSeriesFileWrite).not.toHaveBeenCalled();

    // The next listing load nominates it again; the session memory drops it.
    await sweepInstalledVolumesForSidecarBackfill();
    await settle();
    expect(cloud.uploadFile).toHaveBeenCalledTimes(1);

    // The install trigger cannot resurrect it either.
    queueSidecarBackfillForVolume('uuid-1');
    await settle();
    expect(cloud.uploadFile).toHaveBeenCalledTimes(1);
  });

  it('a failed MOKURO upload does not also upload the cover, and neither is retried', async () => {
    await withOcr(installedVolume());
    cloud.state.files.push(listed('Legacy Series/Volume 01.cbz'));
    cloud.uploadFile.mockRejectedValue(new Error('network down'));

    await sweepInstalledVolumesForSidecarBackfill();
    await settle();
    expect(cloud.uploadFile).toHaveBeenCalledTimes(1);
    expect(uploadedPaths()).toEqual(['Legacy Series/Volume 01.mokuro']);

    await sweepInstalledVolumesForSidecarBackfill();
    await settle();
    expect(cloud.uploadFile).toHaveBeenCalledTimes(1);
  });

  it('drains EVERY qualifying volume in one session — there is no session cap', async () => {
    // The user's ruling: "non-aggressive" is the serial drain plus the
    // download-idle wait, NOT a convergence cap. Measured against the real
    // library, a 25/session cap left 214 qualifying volumes waiting on ~9
    // artificial page reloads. A re-added cap fails this test.
    const total = 30;
    for (let i = 1; i <= total; i++) {
      await withOcr(
        installedVolume({
          volume_uuid: `uuid-${i}`,
          volume_title: `Volume ${String(i).padStart(2, '0')}`,
          thumbnail: undefined
        })
      );
      cloud.state.files.push(listed(`Legacy Series/Volume ${String(i).padStart(2, '0')}.cbz`));
    }

    await sweepInstalledVolumesForSidecarBackfill();
    await settle();
    expect(cloud.uploadFile).toHaveBeenCalledTimes(total);
  });
});

describe('sidecar backfill — gates', () => {
  it('a read-only provider enqueues nothing, uploads nothing, and logs nothing', async () => {
    const debugSpy = vi.spyOn(console, 'debug');
    gate.writable = false;
    await withOcr(installedVolume());
    cloud.state.files.push(listed('Legacy Series/Volume 01.cbz'));

    await sweepInstalledVolumesForSidecarBackfill();
    queueSidecarBackfillForVolume('uuid-1');
    await settle();

    expect(cloud.uploadFile).not.toHaveBeenCalled();
    expect(scheduleSeriesFileWrite).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
    debugSpy.mockRestore();

    // ...and it accumulated no retry queue: flipping writable later does not
    // release stale work by itself.
    gate.writable = true;
    await settle();
    expect(cloud.uploadFile).not.toHaveBeenCalled();
  });

  it('does nothing while the provider cache has not finished loading', async () => {
    cacheState.loaded = false;
    await withOcr(installedVolume());
    cloud.state.files.push(listed('Legacy Series/Volume 01.cbz'));

    await sweepInstalledVolumesForSidecarBackfill();
    await settle();

    expect(cloud.uploadFile).not.toHaveBeenCalled();
  });

  it('a provider that flips read-only mid-drain drops the rest of the queue', async () => {
    for (let i = 1; i <= 3; i++) {
      await withOcr(
        installedVolume({
          volume_uuid: `uuid-${i}`,
          volume_title: `Volume ${i}`,
          thumbnail: undefined
        })
      );
      cloud.state.files.push(listed(`Legacy Series/Volume ${i}.cbz`));
    }
    cloud.uploadFile.mockImplementation(async (path: string, blob: Blob) => {
      // The first upload "fails with a permission error" and the provider
      // flips to read-only, the way WebDAV write tolerance does.
      gate.writable = false;
      throw new Error('403');
    });

    await sweepInstalledVolumesForSidecarBackfill();
    await settle();

    expect(cloud.uploadFile).toHaveBeenCalledTimes(1);
  });
});

describe('sidecar backfill — the install trigger', () => {
  it('converges on the same check: a bare volume uploads, a covered one does not', async () => {
    await withOcr(installedVolume());
    await withOcr(
      installedVolume({ volume_uuid: 'uuid-2', volume_title: 'Volume 02', thumbnail: undefined })
    );
    cloud.state.files.push(
      listed('Legacy Series/Volume 01.cbz'),
      listed('Legacy Series/Volume 02.cbz'),
      listed('Legacy Series/Volume 02.mokuro')
    );

    queueSidecarBackfillForVolume('uuid-2'); // fully covered → nothing
    await settle();
    expect(cloud.uploadFile).not.toHaveBeenCalled();

    queueSidecarBackfillForVolume('uuid-1'); // bare → both sidecars
    await settle();
    expect(uploadedPaths().sort()).toEqual([
      'Legacy Series/Volume 01.mokuro',
      'Legacy Series/Volume 01.webp'
    ]);
  });

  it('defers behind an active download queue and runs once it drains', async () => {
    await withOcr(installedVolume());
    cloud.state.files.push(listed('Legacy Series/Volume 01.cbz'));

    downloadQueueMock.set([{ volumeUuid: 'something-downloading' }]);
    queueSidecarBackfillForVolume('uuid-1');

    // Give the drain every chance to (wrongly) proceed: macrotask flushes
    // clear all pending microtask chains, so anything not genuinely blocked
    // on the queue store would have uploaded by now.
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cloud.uploadFile).not.toHaveBeenCalled();

    downloadQueueMock.set([]);
    await settle();
    expect(cloud.uploadFile).toHaveBeenCalledTimes(2);
  });
});

describe('sidecar backfill — attempted-session memory is per ACCOUNT (Finding 4)', () => {
  it('switching to a different account of the same provider type does not inherit the old account’s failure memory', async () => {
    await withOcr(installedVolume({ thumbnail: undefined }));
    cloud.state.files.push(listed('Legacy Series/Volume 01.cbz'));
    cloud.state.accountScope = 'webdav:https://a.example.com|user';
    cloud.uploadFile.mockRejectedValueOnce(new Error('quota exceeded'));

    queueSidecarBackfillForVolume('uuid-1');
    await settle();
    expect(cloud.uploadFile).toHaveBeenCalledTimes(1);

    // Same provider TYPE, a DIFFERENT account: must not inherit account A's
    // "attempted, failed" memory. This is the `cloud_covers`-style keying
    // Finding 4 asks for — the attempt key folds in the account scope, not
    // just the provider type.
    cloud.state.accountScope = 'webdav:https://b.example.com|user';
    queueSidecarBackfillForVolume('uuid-1');
    await settle();
    expect(cloud.uploadFile).toHaveBeenCalledTimes(2);
  });

  it('a null account scope behaves as today — one attempt per provider type, not per account', async () => {
    await withOcr(installedVolume({ thumbnail: undefined }));
    cloud.state.files.push(listed('Legacy Series/Volume 01.cbz'));
    cloud.state.accountScope = undefined;
    cloud.uploadFile.mockRejectedValueOnce(new Error('quota exceeded'));

    queueSidecarBackfillForVolume('uuid-1');
    await settle();
    expect(cloud.uploadFile).toHaveBeenCalledTimes(1);

    // The scope stays absent: the failure is remembered, exactly like before
    // Finding 4's fix.
    queueSidecarBackfillForVolume('uuid-1');
    await settle();
    expect(cloud.uploadFile).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The IMPORT feed: a cloud download's in-memory data uploads immediately
// ---------------------------------------------------------------------------

/**
 * A cloud download's import output, as `processVolumeData` would hand it to
 * `saveVolume`: pages still carrying the pipeline-only `cumulativeChars`
 * (which `saveVolume` strips into `page_char_counts`), a generated cover
 * Blob, and unicode-bearing OCR blocks so the byte-identity assertion below
 * exercises real serialization, not just ASCII.
 */
function processedVolumeFixture(
  uuid = 'imp-1',
  overrides: {
    volumeTitle?: string;
    thumbnail?: Blob | null;
    mokuroVersion?: string;
  } = {}
): ProcessedVolume {
  return {
    metadata: {
      volumeUuid: uuid,
      seriesUuid: 'series-uuid-1',
      series: 'Legacy Series',
      volume: overrides.volumeTitle ?? 'Volume 01',
      mokuroVersion: overrides.mokuroVersion ?? '0.2.1',
      pageCount: 2,
      chars: 42,
      thumbnail:
        overrides.thumbnail !== undefined
          ? overrides.thumbnail
          : new Blob([new Uint8Array([9, 9, 9, 9])], { type: 'image/webp' }),
      thumbnailWidth: 4,
      thumbnailHeight: 4,
      sourceType: 'cloud',
      spineWidth: 12
    },
    ocrData: {
      volume_uuid: uuid,
      pages: [
        {
          img_path: 'p1.jpg',
          img_width: 100,
          img_height: 200,
          blocks: [{ box: [1, 2, 3, 4], font_size: 20, lines: ['「テスト」'] }],
          cumulativeChars: 10
        },
        {
          img_path: 'p2.jpg',
          img_width: 100,
          img_height: 200,
          blocks: [],
          cumulativeChars: 42
        }
      ]
    },
    fileData: {
      volume_uuid: uuid,
      files: {
        'p1.jpg': new File(['x'], 'p1.jpg', { type: 'image/jpeg' }),
        'p2.jpg': new File(['y'], 'p2.jpg', { type: 'image/jpeg' })
      }
    },
    nestedSources: []
  } as unknown as ProcessedVolume;
}

describe('sidecar backfill — the import feed (in-memory upload at download completion)', () => {
  it('serializes the .mokuro byte-identically across all three feeds: import-time, loadVolumeSidecars, and the worker feed', async () => {
    const processed = processedVolumeFixture();
    const saved = await saveVolume(processed, { preserveTitles: true });
    cloud.state.files.push(listed('Legacy Series/Volume 01.cbz'));

    queueSidecarBackfillFromImport(saved, 'webdav');
    await settle();

    // Positive control: the import feed really uploaded a mokuro.
    const mokuroCall = cloud.uploadFile.mock.calls.find((call) =>
      (call[0] as string).endsWith('.mokuro')
    );
    expect(mokuroCall).toBeDefined();
    const importedBytes = new Uint8Array(await (mokuroCall![1] as File).arrayBuffer());
    expect(importedBytes.length).toBeGreaterThan(0);

    // What a future backup/export would re-serialize from Dexie.
    const fromDb = await loadVolumeSidecars('imp-1');
    expect(fromDb.mokuroFile).not.toBeNull();
    const dbBytes = new Uint8Array(await fromDb.mokuroFile!.arrayBuffer());

    // THE contract: byte-for-byte identical, or every such volume's published
    // size mismatches its re-serialization and `isSidecarStale` re-pulls it.
    expect(importedBytes).toEqual(dbBytes);

    // The WORKER feed's serializer (`generateVolumeSidecarsFromDb`, run by
    // `unified-file-worker.ts`'s `upload-sidecars` mode) reads its OWN Dexie
    // connection to `mokuro_v3` — this suite's mocked db deliberately lives
    // under a test name, so mirror the exact committed rows there and run the
    // real thing.
    const workerSide = new CatalogDexieV3();
    try {
      const volumeRow = await db.volumes.get('imp-1');
      const ocrRow = await db.volume_ocr.get('imp-1');
      expect(volumeRow).toBeDefined();
      expect(ocrRow).toBeDefined();
      await workerSide.volumes.put(volumeRow!);
      await workerSide.volume_ocr.put(ocrRow!);

      const workerSidecars = await generateVolumeSidecarsFromDb('imp-1');
      expect(workerSidecars.mokuro).toBeDefined();
      const workerBytes = new Uint8Array(await workerSidecars.mokuro!.blob.arrayBuffer());
      // Same rows, same `buildMokuroMetadata`, NO title overrides: the worker
      // upload is byte-for-byte the import-time/backup serialization.
      expect(workerBytes).toEqual(dbBytes);
    } finally {
      await workerSide.volumes.clear();
      await workerSide.volume_ocr.clear();
      workerSide.close();
    }

    // Teeth (permanent negative control): serializing the UNSTRIPPED pipeline
    // pages — `cumulativeChars` still present — would NOT match. If this ever
    // starts matching, the equality above has gone vacuous.
    const unstripped = buildVolumeSidecarsFromData(saved.metadata, processed.ocrData.pages);
    const unstrippedBytes = new Uint8Array(await unstripped.mokuroFile!.arrayBuffer());
    expect(unstrippedBytes).not.toEqual(dbBytes);
  });

  it('uploads both sidecars from memory with ZERO IndexedDB operations', async () => {
    const processed = processedVolumeFixture();
    const saved = await saveVolume(processed, { preserveTitles: true });
    cloud.state.files.push(listed('Legacy Series/Volume 01.cbz'));

    const counts = await countIdbOps(async () => {
      queueSidecarBackfillFromImport(saved, 'webdav');
      await settle();
    });

    // Positive control: the flow really ran all the way to both uploads.
    expect(uploadedPaths().sort()).toEqual([
      'Legacy Series/Volume 01.mokuro',
      'Legacy Series/Volume 01.webp'
    ]);
    // The point of the feed: the OCR rows just written are NOT re-read...
    expect(counts['volume_ocr.get'] ?? 0).toBe(0);
    // ...and in fact nothing is: no row read, no transaction at all.
    expect(counts['volumes.get'] ?? 0).toBe(0);
    expect(counts['transactions'] ?? 0).toBe(0);
  });

  it('control: the DEFERRED path for the same volume DOES read volume_ocr — the meter sees what the import feed avoids', async () => {
    const processed = processedVolumeFixture();
    await saveVolume(processed, { preserveTitles: true });
    cloud.state.files.push(listed('Legacy Series/Volume 01.cbz'));

    const counts = await countIdbOps(async () => {
      queueSidecarBackfillForVolume('imp-1');
      await settle();
    });

    expect(uploadedPaths().sort()).toEqual([
      'Legacy Series/Volume 01.mokuro',
      'Legacy Series/Volume 01.webp'
    ]);
    expect(counts['volume_ocr.get'] ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('uploads nothing when the listing already shows both sidecars', async () => {
    const processed = processedVolumeFixture();
    const saved = await saveVolume(processed, { preserveTitles: true });
    cloud.state.files.push(
      listed('Legacy Series/Volume 01.cbz'),
      listed('Legacy Series/Volume 01.mokuro'),
      listed('Legacy Series/Volume 01.webp')
    );

    queueSidecarBackfillFromImport(saved, 'webdav');
    await settle();

    expect(cloud.uploadFile).not.toHaveBeenCalled();
  });

  it('uploads only the missing HALF when the other sidecar exists', async () => {
    // Also the "uploads nothing" test's positive control: same fixture, same
    // call, one sidecar removed from the listing — and the feed acts. The
    // no-op above is therefore the wants-check saying no, not an early bail.
    const processed = processedVolumeFixture();
    const saved = await saveVolume(processed, { preserveTitles: true });
    cloud.state.files.push(
      listed('Legacy Series/Volume 01.cbz'),
      listed('Legacy Series/Volume 01.webp')
    );

    queueSidecarBackfillFromImport(saved, 'webdav');
    await settle();

    expect(uploadedPaths()).toEqual(['Legacy Series/Volume 01.mokuro']);
  });

  it("declines when the download's provider is no longer the active one — the deferred safety net heals it", async () => {
    const processed = processedVolumeFixture();
    const saved = await saveVolume(processed, { preserveTitles: true });
    cloud.state.files.push(listed('Legacy Series/Volume 01.cbz'));

    // The archive downloaded from Drive, but by import completion the user
    // switched to WebDAV (the fixture's active provider).
    queueSidecarBackfillFromImport(saved, 'google-drive');
    await settle();
    expect(cloud.uploadFile).not.toHaveBeenCalled();

    // The decline poisoned nothing: the safety-net nomination that follows it
    // at the call site still backfills, from the database, via the drain.
    queueSidecarBackfillForVolume('imp-1');
    await settle();
    expect(uploadedPaths().sort()).toEqual([
      'Legacy Series/Volume 01.mokuro',
      'Legacy Series/Volume 01.webp'
    ]);
  });

  it('a failed upload never throws into the import, and the attempted-set blocks same-session retries', async () => {
    const processed = processedVolumeFixture();
    const saved = await saveVolume(processed, { preserveTitles: true });
    cloud.state.files.push(listed('Legacy Series/Volume 01.cbz'));
    cloud.uploadFile.mockRejectedValue(new Error('quota exceeded'));

    // Fire-and-forget contract: the import's own call path sees no throw.
    expect(() => queueSidecarBackfillFromImport(saved, 'webdav')).not.toThrow();
    await settle();
    // Positive control: the upload really was attempted (mokuro first, and
    // the cover is not tried after the failure — same rule as the drain).
    expect(cloud.uploadFile).toHaveBeenCalledTimes(1);

    // Attempted-set: neither the safety-net nomination nor a fresh sweep
    // retries within this session.
    queueSidecarBackfillForVolume('imp-1');
    await sweepInstalledVolumesForSidecarBackfill();
    await settle();
    expect(cloud.uploadFile).toHaveBeenCalledTimes(1);

    // A NEW session (fresh page load) re-derives the gap from the listing and
    // heals it — the failed import-time attempt did not strand the volume.
    _resetSidecarBackfillForTests();
    cloud.uploadFile.mockImplementation(cloud.defaultUpload);
    await sweepInstalledVolumesForSidecarBackfill();
    await settle();
    expect(uploadedPaths().sort()).toEqual([
      'Legacy Series/Volume 01.mokuro',
      'Legacy Series/Volume 01.mokuro',
      'Legacy Series/Volume 01.webp'
    ]);
  });

  it('a PNG thumbnail uploads only the mokuro — hasCoverSidecarExtension rejects the cover half', async () => {
    const processed = processedVolumeFixture('imp-1', {
      thumbnail: new Blob([new Uint8Array([9, 9, 9, 9])], { type: 'image/png' })
    });
    const saved = await saveVolume(processed, { preserveTitles: true });
    cloud.state.files.push(listed('Legacy Series/Volume 01.cbz'));

    queueSidecarBackfillFromImport(saved, 'webdav');
    await settle();

    expect(uploadedPaths()).toEqual(['Legacy Series/Volume 01.mokuro']);
    expect(uploadedPaths().some((path) => path.endsWith('.png'))).toBe(false);
  });

  it('a volume whose thumbnail generation failed uploads only the mokuro', async () => {
    const processed = processedVolumeFixture('imp-1', { thumbnail: null });
    const saved = await saveVolume(processed, { preserveTitles: true });
    cloud.state.files.push(listed('Legacy Series/Volume 01.cbz'));

    queueSidecarBackfillFromImport(saved, 'webdav');
    await settle();

    expect(uploadedPaths()).toEqual(['Legacy Series/Volume 01.mokuro']);
  });

  it('recovers the cover once background thumbnail recovery fills a failed-generation gap (Finding 1)', async () => {
    // A failed thumbnail generation: `saveVolume` writes the row with
    // `thumbnail: undefined` and (in production) fires background
    // `db.processThumbnails(1)` recovery — stubbed inert in this suite (see
    // the `$lib/catalog/db` mock above), so the recovery is simulated by hand
    // below instead of relying on the real one to race this test.
    const processed = processedVolumeFixture('imp-1', { thumbnail: null });
    const saved = await saveVolume(processed, { preserveTitles: true });
    cloud.state.files.push(listed('Legacy Series/Volume 01.cbz'));

    queueSidecarBackfillFromImport(saved, 'webdav');
    await settle();

    // Positive control: the import feed really ran, and really uploaded only
    // the mokuro — there was no thumbnail yet to send as a cover.
    expect(uploadedPaths()).toEqual(['Legacy Series/Volume 01.mokuro']);

    // The background recovery lands moments later and fills the row.
    const recoveredThumbnail = new File([new Uint8Array([5, 5, 5, 5])], 'thumb.webp', {
      type: 'image/webp'
    });
    await db.volumes.update('imp-1', {
      thumbnail: recoveredThumbnail,
      thumbnail_width: 4,
      thumbnail_height: 4
    });

    // The safety-net nomination — called right after the import feed at the
    // real call site (`download-queue.ts`'s `queueSidecarBackfillForVolume`
    // right after `queueSidecarBackfillFromImport`) — must still be able to
    // pick the volume back up: the import feed must NOT have marked it
    // attempted while its thumbnail was still missing.
    queueSidecarBackfillForVolume('imp-1');
    await settle();

    // The cover uploads now — and ONLY the cover: the mokuro already sits in
    // the provider's listing cache from the first upload (`uploadFile` adds
    // to it directly), so the re-derived wants-check excludes it rather than
    // sending a second copy.
    expect(uploadedPaths().sort()).toEqual([
      'Legacy Series/Volume 01.mokuro',
      'Legacy Series/Volume 01.webp'
    ]);
    expect(cloud.uploadFile).toHaveBeenCalledTimes(2);
  });

  it('import-time success makes the safety net and the sweep no-op, in-session without touching the DB and across sessions via the cache', async () => {
    const processed = processedVolumeFixture();
    const saved = await saveVolume(processed, { preserveTitles: true });
    cloud.state.files.push(listed('Legacy Series/Volume 01.cbz'));

    queueSidecarBackfillFromImport(saved, 'webdav');
    await settle();
    // Positive control: the import feed really uploaded both.
    expect(cloud.uploadFile).toHaveBeenCalledTimes(2);

    // Same session: the safety-net nomination fired right after by the call
    // site, and the next sweep, both no-op — without a single IndexedDB op.
    const counts = await countIdbOps(async () => {
      queueSidecarBackfillForVolume('imp-1');
      await sweepInstalledVolumesForSidecarBackfill();
      await settle();
    });
    expect(cloud.uploadFile).toHaveBeenCalledTimes(2);
    expect(counts['transactions'] ?? 0).toBe(0);

    // A NEW session, same provider cache: the upload's own cache adds are what
    // the sweep now sees — convergence with no listing fetch (asserted).
    _resetSidecarBackfillForTests();
    await sweepInstalledVolumesForSidecarBackfill();
    await settle();
    expect(cloud.uploadFile).toHaveBeenCalledTimes(2);
    expect(cloud.fetchAllCloudVolumes).not.toHaveBeenCalled();
  });

  it('does not wait for the download queue: uploads while the batch is still running', async () => {
    const processed = processedVolumeFixture();
    const saved = await saveVolume(processed, { preserveTitles: true });
    cloud.state.files.push(listed('Legacy Series/Volume 01.cbz'));
    // Other downloads still in flight — the deferred drain would park here.
    downloadQueueMock.set([{ volumeUuid: 'still-downloading' }]);

    queueSidecarBackfillFromImport(saved, 'webdav');
    await settle();

    expect(uploadedPaths().sort()).toEqual([
      'Legacy Series/Volume 01.mokuro',
      'Legacy Series/Volume 01.webp'
    ]);
  });

  it('an import finishing mid-batch wakes a drain parked on the download-queue-idle wait', async () => {
    // A deferred candidate parks the drain on the idle wait first...
    await withOcr(
      installedVolume({
        volume_uuid: 'uuid-deferred',
        volume_title: 'Volume 02',
        thumbnail: undefined
      })
    );
    cloud.state.files.push(listed('Legacy Series/Volume 02.cbz'));
    downloadQueueMock.set([{ volumeUuid: 'batch-item' }]);
    queueSidecarBackfillForVolume('uuid-deferred');
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    // Positive control: genuinely parked, nothing uploaded.
    expect(cloud.uploadFile).not.toHaveBeenCalled();

    // ...then an import completes mid-batch. NOT `settle()` here — the drain
    // deliberately stays parked for the deferred volume while the queue is
    // busy, so awaiting its completion would deadlock; macrotask flushes give
    // the wake-up every chance to run without awaiting the parked drain.
    const processed = processedVolumeFixture();
    const saved = await saveVolume(processed, { preserveTitles: true });
    cloud.state.files.push(listed('Legacy Series/Volume 01.cbz'));
    queueSidecarBackfillFromImport(saved, 'webdav');
    for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));

    // The import's sidecars are up NOW; the deferred volume still waits.
    expect(uploadedPaths().sort()).toEqual([
      'Legacy Series/Volume 01.mokuro',
      'Legacy Series/Volume 01.webp'
    ]);

    // The batch ends: the deferred volume gets its turn.
    downloadQueueMock.set([]);
    await settle();
    expect(uploadedPaths().sort()).toEqual([
      'Legacy Series/Volume 01.mokuro',
      'Legacy Series/Volume 01.webp',
      'Legacy Series/Volume 02.mokuro'
    ]);
  });
});

// ---------------------------------------------------------------------------
// The DEFERRED feed through the worker pool: bounded parallel uploads
// ---------------------------------------------------------------------------

function paddedVolumeTitle(index: number): string {
  return `Volume ${String(index).padStart(2, '0')}`;
}

/**
 * Seed `count` installed volumes (rows + OCR + listed archives, no sidecars)
 * and flip the provider worker-capable. Returns the uuids in seed order —
 * which is also the drain's dispatch order (`pending` iterates insertion
 * order).
 */
async function seedWorkerBatch(count: number): Promise<string[]> {
  cloud.provider.supportsWorkerUpload = true;
  const uuids: string[] = [];
  for (let index = 1; index <= count; index++) {
    const uuid = `wp-${index}`;
    await withOcr(installedVolume({ volume_uuid: uuid, volume_title: paddedVolumeTitle(index) }));
    cloud.state.files.push(listed(`Legacy Series/${paddedVolumeTitle(index)}.cbz`));
    uuids.push(uuid);
  }
  return uuids;
}

/** Macrotask-flush until `predicate` holds; throws (with `label`) if it never does. */
async function flushUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`flushUntil: ${label}`);
}

/** A handful of macrotask turns, for "and nothing further happens" windows. */
async function flushTurns(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function taskFor(volumeUuid: string) {
  return workerPool.state.tasks.find(
    (task) => (task.data as Record<string, unknown> | undefined)?.volumeUuid === volumeUuid
  );
}

/** A worker `upload-sidecars` completion for both sidecars of `stem`. */
function workerCompletion(
  stem: string,
  opts: { mokuroMtime?: string | null; coverMtime?: string | null } = {}
): Record<string, unknown> {
  const mtime = (value: string | null | undefined) =>
    value === null ? {} : { modifiedTime: value ?? '2026-08-28T00:00:00Z' };
  return {
    type: 'complete',
    sidecarResults: [
      {
        kind: 'mokuro',
        extension: 'mokuro',
        fileId: `w-${stem}.mokuro`,
        ...mtime(opts.mokuroMtime),
        size: 128
      },
      {
        kind: 'cover',
        extension: 'webp',
        fileId: `w-${stem}.webp`,
        ...mtime(opts.coverMtime),
        size: 4
      }
    ]
  };
}

describe('sidecar backfill — the deferred feed uploads through the worker pool', () => {
  it('a batch of 5 dispatches at most 3 at a time and completes all 5, fetching no listing', async () => {
    const uuids = await seedWorkerBatch(5);

    await sweepInstalledVolumesForSidecarBackfill();
    await flushUntil(() => workerPool.addTask.mock.calls.length >= 3, 'first wave dispatched');

    // THE bound: 3 in flight, and — given every chance — NOTHING more is
    // dispatched while none has completed. (An unbounded drain dispatches all
    // 5 here.)
    await flushTurns();
    expect(workerPool.addTask).toHaveBeenCalledTimes(3);
    expect(workerPool.open()).toHaveLength(3);

    // Dispatch order is nomination order, and every task carries the worker
    // message plus the pool discipline fields.
    const first = taskFor(uuids[0]);
    expect(first).toBeDefined();
    expect(first!.data).toMatchObject({
      mode: 'upload-sidecars',
      provider: 'webdav',
      volumeUuid: 'wp-1',
      seriesTitle: 'Legacy Series',
      sidecarStem: 'Volume 01',
      wantMokuro: true,
      wantCover: true,
      credentials: { webdavUrl: 'https://dav.example' }
    });
    expect(first!.provider).toBe('webdav:upload');
    expect(first!.providerConcurrencyLimit).toBe(3);
    expect(workerCreds.getUploadWorkerCredentials).toHaveBeenCalledWith(
      cloud.provider,
      'Legacy Series'
    );

    // Completions free slots one at a time; the bound holds throughout.
    workerPool.complete(first!, workerCompletion('Volume 01'));
    await flushUntil(() => workerPool.addTask.mock.calls.length >= 4, 'fourth dispatched');
    await flushTurns();
    expect(workerPool.addTask).toHaveBeenCalledTimes(4);
    expect(workerPool.open()).toHaveLength(3);

    for (const task of workerPool.open()) {
      workerPool.complete(
        task,
        workerCompletion((task.data as { sidecarStem: string }).sidecarStem)
      );
      await flushTurns(2);
    }
    await flushUntil(() => workerPool.addTask.mock.calls.length >= 5, 'fifth dispatched');
    for (const task of workerPool.open()) {
      workerPool.complete(
        task,
        workerCompletion((task.data as { sidecarStem: string }).sidecarStem)
      );
    }
    await settle();

    // All 5 volumes healed: every completion cache-added both sidecars, the
    // main-thread upload spy stayed untouched, and nothing fetched a listing.
    expect(workerPool.addTask).toHaveBeenCalledTimes(5);
    expect(cacheAdd).toHaveBeenCalledTimes(10);
    expect(cloud.uploadFile).not.toHaveBeenCalled();
    expect(cloud.fetchAllCloudVolumes).not.toHaveBeenCalled();
    expect(cloud.provider.listCloudVolumes).not.toHaveBeenCalled();

    // Pool user bookkeeping: counted in once for the batch, out once at the end.
    expect(workerPool.incrementPoolUsers).toHaveBeenCalledTimes(1);
    expect(workerPool.decrementPoolUsers).toHaveBeenCalledTimes(1);

    // Convergence: a fresh sweep finds nothing left to do.
    await sweepInstalledVolumesForSidecarBackfill();
    await settle();
    expect(workerPool.addTask).toHaveBeenCalledTimes(5);
  });

  it('downloads starting mid-batch let in-flight uploads finish but pause new dispatches until idle', async () => {
    await seedWorkerBatch(5);

    await sweepInstalledVolumesForSidecarBackfill();
    await flushUntil(() => workerPool.addTask.mock.calls.length >= 3, 'first wave dispatched');
    expect(workerPool.addTask).toHaveBeenCalledTimes(3);

    // A user-driven download starts mid-batch.
    downloadQueueMock.set([{ volumeUuid: 'user-download' }]);

    // Everything in flight completes — and its completions are honored (cache
    // adds land) — but NO new dispatch happens while the queue is busy.
    for (const task of workerPool.open()) {
      workerPool.complete(
        task,
        workerCompletion((task.data as { sidecarStem: string }).sidecarStem)
      );
    }
    await flushTurns(12);
    expect(cacheAdd).toHaveBeenCalledTimes(6);
    expect(workerPool.addTask).toHaveBeenCalledTimes(3);

    // The queue drains: the remaining two volumes get their turn.
    downloadQueueMock.set([]);
    await flushUntil(() => workerPool.addTask.mock.calls.length >= 5, 'rest dispatched');
    for (const task of workerPool.open()) {
      workerPool.complete(
        task,
        workerCompletion((task.data as { sidecarStem: string }).sidecarStem)
      );
    }
    await settle();
    expect(cacheAdd).toHaveBeenCalledTimes(10);
  });

  it('one failed volume neither stops the batch nor retries in-session; the rest complete', async () => {
    const uuids = await seedWorkerBatch(3);
    await sweepInstalledVolumesForSidecarBackfill();
    await flushUntil(() => workerPool.addTask.mock.calls.length === 3, 'all three dispatched');

    // The middle volume's worker dies mid-upload.
    workerPool.fail(taskFor(uuids[1])!, 'worker crashed');
    workerPool.complete(taskFor(uuids[0])!, workerCompletion('Volume 01'));
    workerPool.complete(taskFor(uuids[2])!, workerCompletion('Volume 03'));
    await settle();

    // The two survivors converged; the failure added nothing.
    const addedPaths = cacheAdd.mock.calls.map((call) => call[0] as string).sort();
    expect(addedPaths).toEqual([
      'Legacy Series/Volume 01.mokuro',
      'Legacy Series/Volume 01.webp',
      'Legacy Series/Volume 03.mokuro',
      'Legacy Series/Volume 03.webp'
    ]);

    // No in-session retry: the failed volume is attempted-marked, so a fresh
    // sweep re-nominates nothing (the survivors are converged via the cache).
    await sweepInstalledVolumesForSidecarBackfill();
    await settle();
    expect(workerPool.addTask).toHaveBeenCalledTimes(3);
  });

  it('a partial worker completion cache-adds what DID upload and still counts as attempted', async () => {
    await seedWorkerBatch(1);
    queueSidecarBackfillForVolume('wp-1');
    await flushUntil(() => workerPool.addTask.mock.calls.length === 1, 'dispatched');

    // The mokuro made it; the cover upload failed inside the worker.
    const completion = workerCompletion('Volume 01') as { sidecarResults: unknown[] };
    workerPool.complete(taskFor('wp-1')!, {
      type: 'complete',
      sidecarResults: [completion.sidecarResults[0]],
      error: 'cover PUT failed'
    });
    await settle();

    expect(cacheAdd).toHaveBeenCalledTimes(1);
    expect(cacheAdd.mock.calls[0][0]).toBe('Legacy Series/Volume 01.mokuro');

    // Attempted: the cover is NOT retried this session (next session's sweep
    // re-derives the remaining gap from a fresh listing).
    await sweepInstalledVolumesForSidecarBackfill();
    await settle();
    expect(workerPool.addTask).toHaveBeenCalledTimes(1);
  });

  it('the completion cache add carries the worker-reported server mtime — and marks a missing one provisional', async () => {
    await seedWorkerBatch(1);
    queueSidecarBackfillForVolume('wp-1');
    await flushUntil(() => workerPool.addTask.mock.calls.length === 1, 'dispatched');

    workerPool.complete(
      taskFor('wp-1')!,
      workerCompletion('Volume 01', { mokuroMtime: '2026-08-28T12:34:56Z', coverMtime: null })
    );
    await settle();

    const entryFor = (path: string) =>
      cacheAdd.mock.calls.find((call) => call[0] === path)?.[1] as
        | Record<string, unknown>
        | undefined;

    // Server mtime present: cached as server truth.
    expect(entryFor('Legacy Series/Volume 01.mokuro')).toMatchObject({
      provider: 'webdav',
      fileId: 'w-Volume 01.mokuro',
      modifiedTime: '2026-08-28T12:34:56Z',
      modifiedTimeProvisional: false,
      size: 128
    });
    // No server mtime: a client-clock entry, explicitly provisional — the
    // stamp publishers must never mistake it for a server fact.
    const coverEntry = entryFor('Legacy Series/Volume 01.webp');
    expect(coverEntry).toMatchObject({ modifiedTimeProvisional: true, size: 4 });
    expect(typeof coverEntry?.modifiedTime).toBe('string');
  });

  it('re-derives eligibility at dispatch time: a volume that converged while others were in flight is never dispatched', async () => {
    const uuids = await seedWorkerBatch(4);
    await sweepInstalledVolumesForSidecarBackfill();
    await flushUntil(() => workerPool.addTask.mock.calls.length >= 3, 'first wave dispatched');
    expect(workerPool.addTask).toHaveBeenCalledTimes(3);

    // While the first three fly, another device publishes wp-4's sidecars —
    // the listing cache (which every check reads) now shows them.
    cloud.state.files.push(
      listed('Legacy Series/Volume 04.mokuro'),
      listed('Legacy Series/Volume 04.webp')
    );

    for (const task of workerPool.open()) {
      workerPool.complete(
        task,
        workerCompletion((task.data as { sidecarStem: string }).sidecarStem)
      );
    }
    await settle();

    // wp-4 was nominated but never dispatched: the pre-dispatch re-derive saw
    // no gap left.
    expect(workerPool.addTask).toHaveBeenCalledTimes(3);
    expect(taskFor(uuids[3])).toBeUndefined();
  });

  it('an import arriving at full capacity is served on the main thread immediately, without a worker slot', async () => {
    await seedWorkerBatch(4);
    await sweepInstalledVolumesForSidecarBackfill();
    await flushUntil(() => workerPool.addTask.mock.calls.length >= 3, 'at capacity');
    expect(workerPool.addTask).toHaveBeenCalledTimes(3);

    // A cloud download finishes importing while all three slots are busy.
    const processed = processedVolumeFixture('imp-99', { volumeTitle: 'Volume 99' });
    const saved = await saveVolume(processed, { preserveTitles: true });
    cloud.state.files.push(listed('Legacy Series/Volume 99.cbz'));
    queueSidecarBackfillFromImport(saved, 'webdav');

    // Served NOW — main thread, blind upload — while every worker task is
    // still open and the fourth deferred volume still waits.
    await flushUntil(
      () => uploadedPaths().includes('Legacy Series/Volume 99.mokuro'),
      'import served at capacity'
    );
    expect(uploadedPaths().sort()).toEqual([
      'Legacy Series/Volume 99.mokuro',
      'Legacy Series/Volume 99.webp'
    ]);
    expect(workerPool.open()).toHaveLength(3);
    expect(workerPool.addTask).toHaveBeenCalledTimes(3);

    for (const task of workerPool.open()) {
      workerPool.complete(
        task,
        workerCompletion((task.data as { sidecarStem: string }).sidecarStem)
      );
      await flushTurns(2);
    }
    await flushUntil(() => workerPool.addTask.mock.calls.length >= 4, 'fourth dispatched');
    workerPool.complete(workerPool.open()[0], workerCompletion('Volume 04'));
    await settle();
    expect(workerPool.addTask).toHaveBeenCalledTimes(4);
  });

  it('a provider that cannot upload from a worker falls back to the serial main-thread path', async () => {
    await seedWorkerBatch(2);
    cloud.provider.supportsWorkerUpload = false;

    await sweepInstalledVolumesForSidecarBackfill();
    await settle();

    expect(workerPool.addTask).not.toHaveBeenCalled();
    expect(uploadedPaths().sort()).toEqual([
      'Legacy Series/Volume 01.mokuro',
      'Legacy Series/Volume 01.webp',
      'Legacy Series/Volume 02.mokuro',
      'Legacy Series/Volume 02.webp'
    ]);
  });
});
