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
    getStatus: () => ({ accountScope: state.accountScope })
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
      uploadFile,
      fetchAllCloudVolumes
    }
  };
});

const gate = vi.hoisted(() => ({ writable: true }));
const cacheState = vi.hoisted(() => ({ loaded: true }));
const scheduleSeriesFileWrite = vi.hoisted(() => vi.fn());

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
  cacheManager: { getCache: () => ({ isLoaded: () => cacheState.loaded }) }
}));
/**
 * A REAL Dexie over `fake-indexeddb`, not a stub — see the module doc above
 * for why this suite needs the real thing rather than a hand-rolled `db`.
 */
vi.mock('$lib/catalog/db', async () => {
  const { CatalogDexieV3 } =
    await vi.importActual<typeof import('$lib/catalog/db-v3')>('$lib/catalog/db-v3');
  return { db: new CatalogDexieV3('mokuro_v3_sidecar_backfill_test') };
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
  MAX_SIDECAR_BACKFILLS_PER_SESSION,
  _drainForTests,
  _resetSidecarBackfillForTests,
  queueSidecarBackfillForVolume,
  sweepInstalledVolumesForSidecarBackfill
} from './sidecar-backfill';

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
  cloud.state.files.length = 0;
  cloud.state.accountScope = undefined;
  cloud.uploadFile.mockReset();
  cloud.uploadFile.mockImplementation(cloud.defaultUpload);
  cloud.fetchAllCloudVolumes.mockClear();
  cloud.provider.listCloudVolumes.mockClear();
  scheduleSeriesFileWrite.mockClear();
  gate.writable = true;
  cacheState.loaded = true;
  downloadQueueMock.set([]);
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

  it('caps one session at MAX_SIDECAR_BACKFILLS_PER_SESSION volumes', async () => {
    const total = MAX_SIDECAR_BACKFILLS_PER_SESSION + 1;
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
    expect(cloud.uploadFile).toHaveBeenCalledTimes(MAX_SIDECAR_BACKFILLS_PER_SESSION);

    // Still capped when the next listing nominates the leftover volume.
    await sweepInstalledVolumesForSidecarBackfill();
    await settle();
    expect(cloud.uploadFile).toHaveBeenCalledTimes(MAX_SIDECAR_BACKFILLS_PER_SESSION);
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
