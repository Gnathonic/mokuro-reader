import { beforeEach, describe, expect, it, vi } from 'vitest';
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
 */

// ---------------------------------------------------------------------------
// Shared fixture state (hoisted so the vi.mock factories can close over it).
// ---------------------------------------------------------------------------

const cloud = vi.hoisted(() => {
  const state = { files: [] as Array<Record<string, unknown> & { path: string }> };
  const listCloudVolumes = vi.fn(async () => [...state.files]);
  const provider = { type: 'webdav', listCloudVolumes };
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

const dbState = vi.hoisted(() => ({
  volumes: [] as Array<Record<string, unknown> & { volume_uuid: string }>,
  ocr: new Map<string, { volume_uuid: string; pages: unknown[] }>()
}));

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
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: {
      toArray: async () => [...dbState.volumes],
      get: async (uuid: string) => dbState.volumes.find((v) => v.volume_uuid === uuid)
    },
    volume_ocr: { get: async (uuid: string) => dbState.ocr.get(uuid) }
  }
}));
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

function withOcr(volume: VolumeMetadata, pages: unknown[] = [{ img_width: 100 }]): void {
  dbState.volumes.push(volume as never);
  dbState.ocr.set(volume.volume_uuid, { volume_uuid: volume.volume_uuid, pages });
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

beforeEach(() => {
  _resetSidecarBackfillForTests();
  dbState.volumes.length = 0;
  dbState.ocr.clear();
  cloud.state.files.length = 0;
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
    withOcr(installedVolume());
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

    // The stamps ride the debounced series.json write, scheduled with the
    // refetch-suppression flag — the listing that showed the gap IS fresh.
    expect(scheduleSeriesFileWrite).toHaveBeenCalledTimes(1);
    expect(scheduleSeriesFileWrite).toHaveBeenCalledWith('Legacy Series', {
      fromCloudListing: true
    });
  });

  it('never fetches a listing anywhere in the flow', async () => {
    withOcr(installedVolume());
    cloud.state.files.push(listed('Legacy Series/Volume 01.cbz'));

    await sweepInstalledVolumesForSidecarBackfill();
    await settle();

    // Positive control first: the flow really ran all the way to uploads.
    expect(cloud.uploadFile).toHaveBeenCalledTimes(2);
    expect(cloud.fetchAllCloudVolumes).not.toHaveBeenCalled();
    expect(cloud.provider.listCloudVolumes).not.toHaveBeenCalled();
  });

  it('leaves a volume alone when both sidecars are already listed', async () => {
    withOcr(installedVolume());
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
    withOcr(installedVolume());
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
    dbState.volumes.push(installedVolume({ mokuro_version: '' }) as never);
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
    withOcr(installedVolume());
    withOcr(
      installedVolume({ volume_uuid: 'uuid-2', series_title: 'Unlisted', volume_title: 'V' })
    );
    withOcr(
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
    withOcr(installedVolume({ isPlaceholder: true } as Partial<VolumeMetadata>));
    withOcr(
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
    withOcr(
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
});

describe('sidecar backfill — convergence', () => {
  it('a successful upload converges: the next sweep finds nothing to do', async () => {
    withOcr(installedVolume());
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
    withOcr(installedVolume({ thumbnail: undefined }));
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
    withOcr(installedVolume());
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
      withOcr(
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
    withOcr(installedVolume());
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
    withOcr(installedVolume());
    cloud.state.files.push(listed('Legacy Series/Volume 01.cbz'));

    await sweepInstalledVolumesForSidecarBackfill();
    await settle();

    expect(cloud.uploadFile).not.toHaveBeenCalled();
  });

  it('a provider that flips read-only mid-drain drops the rest of the queue', async () => {
    for (let i = 1; i <= 3; i++) {
      withOcr(
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
    withOcr(installedVolume());
    withOcr(
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
    withOcr(installedVolume());
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
