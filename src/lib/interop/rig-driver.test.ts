/**
 * `__mokuroInterop` v1 (the interop rig's driver): the contract's shape, and
 * that each method drives the app's own stores and functions. The provider
 * layer is faked; the catalog database and the editor's persist path are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { writable, type Writable } from 'svelte/store';
import type { Page } from '$lib/types';
import type { SyncProvider } from '$lib/util/sync/provider-interface';

vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false }));
vi.mock('$lib/catalog/thumbnails', () => ({ generateThumbnail: vi.fn() }));
vi.mock('$lib/util/progress-tracker', () => ({
  progressTrackerStore: { addProcess: vi.fn(), updateProcess: vi.fn(), removeProcess: vi.fn() }
}));
vi.mock('$lib/catalog/db', async () => {
  const { CatalogDexieV3 } =
    await vi.importActual<typeof import('$lib/catalog/db-v3')>('$lib/catalog/db-v3');
  return { db: new CatalogDexieV3('mokuro_v3_rig_driver_test') };
});

/** The order the app's functions were called in. */
const h = vi.hoisted(() => ({ calls: [] as string[] }));

const provider = vi.hoisted(() => ({
  type: 'webdav' as const,
  login: vi.fn(async () => {}),
  getStatus: vi.fn(() => ({ serverCompilesMetadata: true }) as Record<string, unknown>)
}));

vi.mock('$lib/util/sync/provider-manager', () => ({
  providerManager: {
    getOrLoadProvider: vi.fn(async () => {
      h.calls.push('getOrLoadProvider');
      return provider;
    }),
    setCurrentProvider: vi.fn(async () => {
      h.calls.push('setCurrentProvider');
    }),
    updateStatus: vi.fn(),
    logout: vi.fn(async () => {}),
    getActiveProvider: vi.fn(() => null as unknown)
  }
}));
vi.mock('$lib/util/sync/unified-cloud-manager', async () => {
  const { writable } = await import('svelte/store');
  return {
    unifiedCloudManager: {
      cloudFiles: writable(new Map()),
      getAllCloudVolumes: vi.fn(() => []),
      isSyncing: writable(false),
      isFetching: writable(false),
      fetchAllCloudVolumes: vi.fn(async () => {
        h.calls.push('fetchAllCloudVolumes');
      }),
      syncProgress: vi.fn(async () => {
        h.calls.push('syncProgress');
        return {
          totalProviders: 1,
          succeeded: 1,
          failed: 0,
          results: [{ provider: 'webdav', success: true }]
        };
      }),
      deleteManagedVolume: vi.fn(async () => {
        h.calls.push('deleteManagedVolume');
      }),
      whenListingWorkSettled: vi.fn(async () => {
        h.calls.push('whenListingWorkSettled');
      }),
      listingWorkPending: vi.fn(() => false)
    }
  };
});
vi.mock('$lib/util/sync/active-provider-status', async () => {
  const { writable } = await import('svelte/store');
  return { activeProviderStatus: writable<Record<string, unknown> | null>(null) };
});
vi.mock('$lib/catalog/cloud-bunko-marker', () => ({
  cloudBunkoStatus: vi.fn(() => undefined),
  cloudBunkoMergesDuplicates: vi.fn(() => false)
}));
vi.mock('$lib/metadata/layer-sync', () => ({
  scheduleLayerPush: vi.fn(),
  publishCuratedLayer: vi.fn(async () => 'published'),
  pullOwnEditLayerBeforeEdit: vi.fn(async () => 'none' as const),
  listedCuratedLayerFile: vi.fn(async () => null),
  clearPendingLayerDelete: vi.fn(),
  deleteCloudLayerFile: vi.fn(),
  unpublishCuratedLayer: vi.fn()
}));
vi.mock('$lib/metadata/series-file-sync', () => ({
  settleSeriesFileWrites: vi.fn(async () => {
    h.calls.push('settleSeriesFileWrites');
  }),
  seriesFileWritesPending: vi.fn(() => false)
}));
vi.mock('$lib/metadata/catalog-file-sync', () => ({
  settleCatalogFileWrites: vi.fn(async () => {
    h.calls.push('settleCatalogFileWrites');
  }),
  catalogFileWritePending: vi.fn(() => false)
}));
vi.mock('$lib/metadata/series-backfill', () => ({
  settleSeriesBackfills: vi.fn(async () => {
    h.calls.push('settleSeriesBackfills');
  }),
  seriesBackfillsPending: vi.fn(() => false)
}));
vi.mock('$lib/metadata/spine-offsets', async () => ({
  ...(await vi.importActual<typeof import('$lib/metadata/spine-offsets')>(
    '$lib/metadata/spine-offsets'
  )),
  scheduleSpineOffsetWrite: vi.fn(async () => undefined),
  flushSpineOffsetWrites: vi.fn(async () => {})
}));
vi.mock('$lib/reading-history/history-db', () => ({
  historyDb: () => ({
    devices: { toArray: async () => [{ device: 'dev-b' }, { device: 'dev-a' }] }
  })
}));
vi.mock('$lib/reading-history/history-sync', () => ({
  historySyncAllowed: vi.fn(() => true)
}));
vi.mock('$lib/reader/paged-progress', () => ({ recordPagedPageView: vi.fn() }));
vi.mock('$lib/settings/volume-data', async () => {
  const { writable } = await import('svelte/store');
  return {
    volumes: writable<Record<string, unknown>>({}),
    updateVolumeSetting: vi.fn(),
    deleteVolume: vi.fn(() => {
      h.calls.push('deleteVolumeStats');
    })
  };
});
vi.mock('$lib/import', () => ({
  deleteVolumeCompletely: vi.fn(async () => {
    h.calls.push('deleteVolumeCompletely');
  }),
  importFiles: vi.fn(async () => ({
    success: true,
    imported: 0,
    failed: 0,
    errors: [],
    queued: 0,
    awaitingReview: 0
  }))
}));
/** The backup queue as the card's Backup sees it; a spec plays the upload (`bq.finish`). */
const bq = vi.hoisted(() => ({
  queued: [] as Array<Record<string, unknown>>,
  settle: null as null | (() => void)
}));
vi.mock('$lib/util/backup-queue', () => ({
  backupQueue: {
    queueVolumeForBackup: vi.fn((volume: Record<string, unknown>) => {
      h.calls.push('queueVolumeForBackup');
      bq.queued.push(volume);
    }),
    isVolumeInBackupQueue: vi.fn((uuid: string) => bq.queued.some((v) => v.volume_uuid === uuid))
  },
  backupQueueSettled: vi.fn(
    () =>
      new Promise<void>((resolve) => {
        bq.settle = () => {
          h.calls.push('settled');
          resolve();
        };
      })
  )
}));
vi.mock('$lib/util/upload-failures', async () => {
  const { writable } = await import('svelte/store');
  return { uploadFailures: writable<Record<string, unknown>>({}) };
});
vi.mock('$lib/util/hash-router', () => ({ nav: { toReader: vi.fn(), toSeries: vi.fn() } }));
/** The download queue as the cards see it; a spec plays the worker (`finishDownload`). */
const dq = vi.hoisted(() => ({ queued: [] as Array<Record<string, unknown>> }));
vi.mock('$lib/util/download-queue', async () => {
  const { writable } = await import('svelte/store');
  const store = writable<Array<{ volumeUuid: string }>>([]);
  return {
    downloadQueue: {
      subscribe: store.subscribe,
      queueVolume: vi.fn((volume: Record<string, unknown>) => {
        if (!volume.cloudFileId) return; // as the queue: nothing to download it from
        dq.queued.push(volume);
        store.update((q) => [...q, { volumeUuid: volume.volume_uuid as string }]);
      }),
      finish: (uuid: string) => store.update((q) => q.filter((i) => i.volumeUuid !== uuid))
    }
  };
});
vi.mock('$lib/util/series-rename', () => ({
  executeRenameSeries: vi.fn(async (_old: string, next: string) => ({
    finalTitle: next,
    renamedCount: 1,
    failures: []
  }))
}));
vi.mock('$lib/util/volume-editor', () => ({
  renameVolumeInCloud: vi.fn(async () => {
    h.calls.push('renameVolumeInCloud');
  }),
  updateVolumeInDb: vi.fn(async () => {
    h.calls.push('updateVolumeInDb');
  }),
  updateVolumeStats: vi.fn(() => {
    h.calls.push('updateVolumeStats');
  })
}));
vi.mock('$lib/util/sync/metadata-permissions', () => ({
  canDeleteSeriesOnServer: vi.fn(() => ({ allowed: true }))
}));
vi.mock('$lib/util/volume-sidecars', () => ({ downloadFileBlob: vi.fn() }));
vi.mock('$lib/util/modals', () => ({ promptConfirmation: vi.fn() }));
vi.mock('$lib/util/snackbar', () => ({ showSnackbar: vi.fn() }));

import { db } from '$lib/catalog/db';
import {
  clearAllLayers,
  getLayerPages,
  listLayerIds,
  putLayerWithPages
} from '$lib/catalog/layer-store';
import { cloudBunkoMergesDuplicates, cloudBunkoStatus } from '$lib/catalog/cloud-bunko-marker';
import { publishCuratedLayer, pullOwnEditLayerBeforeEdit } from '$lib/metadata/layer-sync';
import { flushSpineOffsetWrites, scheduleSpineOffsetWrite } from '$lib/metadata/spine-offsets';
import { seriesFileWritesPending } from '$lib/metadata/series-file-sync';
import { historySyncAllowed } from '$lib/reading-history/history-sync';
import { recordPagedPageView } from '$lib/reader/paged-progress';
import { updateVolumeSetting, volumes as volumeDataStore } from '$lib/settings/volume-data';
import { nav } from '$lib/util/hash-router';
import { executeRenameSeries } from '$lib/util/series-rename';
import { activeProviderStatus } from '$lib/util/sync/active-provider-status';
import { canDeleteSeriesOnServer } from '$lib/util/sync/metadata-permissions';
import { providerManager } from '$lib/util/sync/provider-manager';
import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
import { renameVolumeInCloud, updateVolumeInDb } from '$lib/util/volume-editor';
import { downloadQueue } from '$lib/util/download-queue';
import { queueStatusStore } from '$lib/catalog/server-ocr-pending';
import { importFiles } from '$lib/import';
import { getImportUiBridge } from '$lib/import/import-ui';
import type { ReviewGroup } from '$lib/import/image-only-review';
import { reviewSession, type GroupDecision } from '$lib/import/review-session';
import { backupQueue } from '$lib/util/backup-queue';
import { uploadFailures } from '$lib/util/upload-failures';
import { RIG_CAPABILITIES, install } from './rig-driver';

const statusStore = activeProviderStatus as unknown as Writable<Record<string, unknown> | null>;

/** Every v1 method, by the contract (`__mokuroInterop`). */
const V1_METHODS = [
  'connectWebDAV',
  'connectMega',
  'connectDrive',
  'connectOneDrive',
  'logout',
  'sync',
  'library',
  'open',
  'setPage',
  'progress',
  'renameVolume',
  'renameSeries',
  'deleteVolume',
  'setSpineOffset',
  'editFirstBlock',
  'publishCurated',
  'selectLayer',
  'providerStatus',
  'controlState',
  'historyStatus',
  // Additions within v1 (the rig's dav and api suites).
  'showSeries',
  'pendingOcr',
  // ...and the direct suite.
  'idle',
  // ...and the shared suite.
  'importVolume',
  'backupVolume',
  // ...and the spine offset scenario (S8).
  'settleSeriesWrites'
];

/** The download worker's end: the volume is installed (or not), then leaves the queue. */
async function finishDownload(uuid: string, installed: boolean) {
  if (installed) {
    await db.volumes.update(uuid, { metadata_only: undefined });
    await db.volume_ocr.put({ volume_uuid: uuid, pages: PAGES });
  }
  (downloadQueue as unknown as { finish: (u: string) => void }).finish(uuid);
}

function pg(text: string, img_path = 'p.png'): Page {
  return {
    version: '0.2.1',
    img_width: 100,
    img_height: 100,
    img_path,
    blocks: [{ box: [0, 0, 10, 10], vertical: true, font_size: 10, lines: [text] }]
  };
}

const PAGES = [pg('あい'), pg('うえ', 'q.png')];

beforeEach(async () => {
  delete (globalThis as Record<string, unknown>).__mokuroInterop;
  h.calls.length = 0;
  dq.queued.length = 0;
  bq.queued.length = 0;
  bq.settle = null;
  reviewSession.set({ pending: [], decided: 0 });
  (uploadFailures as unknown as Writable<Record<string, unknown>>).set({});
  queueStatusStore.set({});
  vi.clearAllMocks();
  vi.mocked(providerManager.getActiveProvider).mockReturnValue(null);
  statusStore.set(null);
  (volumeDataStore as ReturnType<typeof writable>).set({});
  (unifiedCloudManager.cloudFiles as ReturnType<typeof writable>).set(new Map());
  vi.mocked(unifiedCloudManager.getAllCloudVolumes).mockReturnValue([]);
  (unifiedCloudManager.isSyncing as ReturnType<typeof writable>).set(false);
  (unifiedCloudManager.isFetching as ReturnType<typeof writable>).set(false);
  await Promise.all([
    db.volumes.clear(),
    db.volume_ocr.clear(),
    db.series_metadata.clear(),
    db.series_index.clear(),
    clearAllLayers(db)
  ]);
  await db.volumes.bulkPut([
    {
      volume_uuid: 'v1',
      series_uuid: 's1',
      series_title: 'Series A',
      volume_title: 'Vol 1',
      mokuro_version: '0.2.1',
      page_count: 2,
      character_count: 4,
      page_char_counts: [2, 4]
    },
    {
      volume_uuid: 'v2',
      series_uuid: 's1',
      series_title: 'Series A',
      volume_title: 'Vol 2',
      mokuro_version: '0.2.1',
      page_count: 2,
      character_count: 4,
      page_char_counts: [2, 4],
      metadata_only: true
    }
  ]);
  await db.volume_ocr.put({ volume_uuid: 'v1', pages: PAGES });
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__mokuroInterop;
});

/** The cache's state (what it holds now), without publishing it to `cloudFiles`. */
function cached(...paths: string[]) {
  vi.mocked(unifiedCloudManager.getAllCloudVolumes).mockReturnValue(
    paths.map((path) => ({ path, provider: 'webdav', fileId: path, modifiedTime: '', size: 0 }))
  );
}

/** The listing, held by the cache and published by `cloudFiles`. */
function listed(...paths: string[]) {
  const map = new Map<string, unknown[]>();
  for (const path of paths) {
    const folder = path.split('/')[0];
    map.set(folder, [...(map.get(folder) ?? []), { path, provider: 'webdav', fileId: path }]);
  }
  (unifiedCloudManager.cloudFiles as ReturnType<typeof writable>).set(map);
  cached(...paths);
}

describe('install()', () => {
  it('exposes apiVersion 1, every v1 method and the capabilities as string[]', () => {
    const driver = install();
    const g = (globalThis as Record<string, unknown>).__mokuroInterop as Record<string, unknown>;
    expect(g).toBe(driver);
    expect(g.apiVersion).toBe(1);
    for (const name of V1_METHODS) expect(typeof g[name], name).toBe('function');
    expect(Array.isArray(g.capabilities)).toBe(true);
    expect((g.capabilities as unknown[]).every((c) => typeof c === 'string')).toBe(true);
  });

  it('lists only the contract capability names', () => {
    expect([...RIG_CAPABILITIES].sort()).toEqual(
      [
        'history',
        'positions',
        'edit-layers-personal',
        'edit-layers-curated',
        'provenance',
        'case-merge-rename',
        'dedup'
      ].sort()
    );
  });

  it('installs once', () => {
    expect(install()).toBe(install());
  });
});

describe('connect', () => {
  it('connectWebDAV runs the cloud screen sequence: login, make current, list, sync', async () => {
    const result = await install().connectWebDAV({
      url: 'http://127.0.0.1:9/dav',
      username: 'alice',
      password: 'pw'
    });
    expect(providerManager.getOrLoadProvider).toHaveBeenCalledWith('webdav');
    expect(provider.login).toHaveBeenCalledWith({
      serverUrl: 'http://127.0.0.1:9/dav',
      username: 'alice',
      password: 'pw'
    });
    expect(providerManager.setCurrentProvider).toHaveBeenCalledWith(provider);
    expect(h.calls).toEqual([
      'getOrLoadProvider',
      'setCurrentProvider',
      'fetchAllCloudVolumes',
      'fetchAllCloudVolumes',
      'syncProgress'
    ]);
    expect(result.sync).toEqual({ ok: true, errors: [] });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('publishes the status after the listing where the cloud screen does: not for WebDAV', async () => {
    const driver = install();
    await driver.connectWebDAV({ url: 'http://127.0.0.1:9/dav' });
    expect(providerManager.updateStatus).not.toHaveBeenCalled();
    for (const connect of [driver.connectMega, driver.connectDrive, driver.connectOneDrive]) {
      vi.mocked(providerManager.updateStatus).mockClear();
      await connect({ email: 'a@example.test', password: 'pw' });
      expect(providerManager.updateStatus).toHaveBeenCalledTimes(1);
    }
  });

  it('connectMega passes the account; connectDrive and connectOneDrive pass none', async () => {
    const driver = install();
    await driver.connectMega({ email: 'a@example.test', password: 'pw' });
    expect(providerManager.getOrLoadProvider).toHaveBeenLastCalledWith('mega');
    expect(provider.login).toHaveBeenLastCalledWith({ email: 'a@example.test', password: 'pw' });
    await driver.connectDrive();
    expect(providerManager.getOrLoadProvider).toHaveBeenLastCalledWith('google-drive');
    expect(provider.login).toHaveBeenLastCalledWith(undefined);
    await driver.connectOneDrive();
    expect(providerManager.getOrLoadProvider).toHaveBeenLastCalledWith('onedrive');
  });

  it('a refused login rejects and connects nothing', async () => {
    provider.login.mockRejectedValueOnce(new Error('401 Unauthorized'));
    await expect(install().connectWebDAV({ url: 'http://127.0.0.1:9/dav' })).rejects.toThrow('401');
    expect(providerManager.setCurrentProvider).not.toHaveBeenCalled();
  });

  it('logout is the provider manager logout', async () => {
    await install().logout();
    expect(providerManager.logout).toHaveBeenCalled();
  });
});

describe('sync()', () => {
  it('lists, then runs the unified progress sync', async () => {
    expect(await install().sync()).toEqual({ ok: true, errors: [] });
    expect(h.calls).toEqual(['fetchAllCloudVolumes', 'syncProgress']);
  });

  it('reports a failed provider sync and a missing provider', async () => {
    vi.mocked(unifiedCloudManager.syncProgress).mockResolvedValueOnce({
      totalProviders: 1,
      succeeded: 0,
      failed: 1,
      results: [{ provider: 'webdav', success: false, error: '507 Insufficient Storage' }]
    });
    expect(await install().sync()).toEqual({ ok: false, errors: ['507 Insufficient Storage'] });
    vi.mocked(unifiedCloudManager.syncProgress).mockResolvedValueOnce({
      totalProviders: 0,
      succeeded: 0,
      failed: 0,
      results: []
    });
    expect(await install().sync()).toEqual({ ok: false, errors: ['Not connected'] });
  });
});

describe('idle()', () => {
  const syncing = () => unifiedCloudManager.isSyncing as ReturnType<typeof writable>;
  const fetching = () => unifiedCloudManager.isFetching as ReturnType<typeof writable>;
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('resolves at once when no sync and no listing is in flight', async () => {
    await expect(install().idle()).resolves.toBeUndefined();
  });

  it('waits out a background sync and a listing, both', async () => {
    syncing().set(true);
    fetching().set(true);
    let done = false;
    const idle = install()
      .idle()
      .then(() => (done = true));
    await settle();
    expect(done).toBe(false);
    syncing().set(false);
    await settle();
    expect(done).toBe(false);
    fetching().set(false);
    await idle;
    expect(done).toBe(true);
  });
});

describe('settleSeriesWrites()', () => {
  it("waits out the listings' work, then the backfills, then runs the series.json and catalog.json writes", async () => {
    // A listing's backfill queues series.json writes after the listing (and
    // the sync) resolved; those writes queue catalog.json behind them.
    await install().settleSeriesWrites();
    expect(h.calls).toEqual([
      'whenListingWorkSettled',
      'settleSeriesBackfills',
      'settleSeriesFileWrites',
      'settleCatalogFileWrites'
    ]);
  });

  it('goes round again while settling queued more', async () => {
    vi.mocked(seriesFileWritesPending).mockReturnValueOnce(true);
    await install().settleSeriesWrites();
    expect(h.calls.filter((c) => c === 'whenListingWorkSettled')).toHaveLength(2);
    expect(h.calls.filter((c) => c === 'settleSeriesFileWrites')).toHaveLength(2);
  });

  it('gives up, saying so, while writes keep being queued', async () => {
    vi.mocked(unifiedCloudManager.listingWorkPending).mockReturnValue(true);
    await expect(install().settleSeriesWrites()).rejects.toThrow(/still being queued/);
    vi.mocked(unifiedCloudManager.listingWorkPending).mockReturnValue(false);
  });
});

describe('library()', () => {
  it('lists the catalog rows with their cloud path, OCR state and layers', async () => {
    await putLayerWithPages(db, {
      volume_uuid: 'v1',
      layer_id: 'edit',
      name: 'Edit',
      kind: 'edit',
      created_at: 't',
      updated_at: 't',
      pages: PAGES
    });
    listed('Series A/Vol 1.cbz');
    const lib = await install().library();
    expect(lib).toEqual({
      volumes: [
        {
          id: 'v1',
          series: 'Series A',
          title: 'Vol 1',
          cloudPath: 'Series A/Vol 1.cbz',
          hasOcr: true,
          layers: ['edit']
        },
        {
          id: 'v2',
          series: 'Series A',
          title: 'Vol 2',
          cloudPath: null,
          hasOcr: false,
          layers: []
        }
      ]
    });
  });

  it('reads the cache once, however many rows it lists', async () => {
    listed('Series A/Vol 1.cbz', 'Series A/Vol 2.cbz');
    await install().library();
    expect(unifiedCloudManager.getAllCloudVolumes).toHaveBeenCalledTimes(1);
  });

  it('includes a cloud-only volume as its placeholder', async () => {
    listed('Series B/Vol 9.cbz');
    const lib = await install().library();
    const cloudOnly = lib.volumes.find((v) => v.series === 'Series B');
    expect(cloudOnly).toMatchObject({
      title: 'Vol 9',
      cloudPath: 'Series B/Vol 9.cbz',
      hasOcr: false
    });
    expect(typeof cloudOnly?.id).toBe('string');
  });
});

describe('importing and backing up', () => {
  /** What the upload modal's import does with an image-only archive: offer it for review. */
  function importOffersReview(decisions: GroupDecision[]) {
    vi.mocked(importFiles).mockImplementationOnce(async (files: File[]) => {
      const file = files[0];
      h.calls.push(`importFiles:${file.webkitRelativePath}:${file.name}:${file.size}`);
      const group: ReviewGroup = {
        id: 'g1',
        series: 'Rig Series',
        candidates: [{ id: 'c1', basePath: 'Rig Series/Vol 3', source: file.name }],
        ownUuids: ['u3'],
        matches: new Map(),
        existingCount: 2
      };
      getImportUiBridge().reviewImageOnly([group], (_id, decision) => {
        decisions.push(decision);
        if (decision.action !== 'import') return;
        // The queue saves the volume under the names the decision gave it.
        void db.volumes.put({
          volume_uuid: 'u3',
          series_uuid: 's-rig',
          series_title: decision.naming.series,
          volume_title: decision.naming.mode === 'folder' ? 'Vol 3' : 'Rig Series 03',
          mokuro_version: '',
          page_count: 2,
          character_count: 0,
          page_char_counts: []
        });
      });
      return { success: true, imported: 0, failed: 0, errors: [], queued: 0, awaitingReview: 1 };
    });
  }

  it('importVolume imports the archive as picked in its series folder and keeps its names in the review', async () => {
    const decisions: GroupDecision[] = [];
    importOffersReview(decisions);
    const bytes = 'PK\u0003\u0004 an archive';
    const result = await install().importVolume({
      path: 'Rig Series/Vol 3.cbz',
      base64: btoa(bytes)
    });
    expect(result).toEqual({ id: 'u3' });
    expect(h.calls).toContain(`importFiles:Rig Series/Vol 3.cbz:Vol 3.cbz:${bytes.length}`);
    // The dialog's answer for keeping the names: the folder's series, the file's own name.
    expect(decisions).toEqual([
      {
        action: 'import',
        naming: { series: 'Rig Series', mode: 'folder', start: 3, overrides: {} }
      }
    ]);
  });

  it('importVolume refuses a path that is not <Series>/<Volume>.<ext>', async () => {
    await expect(install().importVolume({ path: 'Vol 3.cbz', base64: '' })).rejects.toThrow(
      /Series/
    );
    expect(importFiles).not.toHaveBeenCalled();
  });

  it('importVolume fails when the import does', async () => {
    vi.mocked(importFiles).mockResolvedValueOnce({
      success: false,
      imported: 0,
      failed: 1,
      errors: ['not an archive'],
      queued: 0,
      awaitingReview: 0
    });
    await expect(
      install().importVolume({ path: 'Rig Series/Vol 3.cbz', base64: btoa('x') })
    ).rejects.toThrow('not an archive');
  });

  it("backupVolume is the card's Backup, to the end of the run (its metadata writes included)", async () => {
    listed('Series A/Vol 1.cbz');
    let done = false;
    const backing = install()
      .backupVolume('v1')
      .then((r) => {
        done = true;
        return r;
      });
    await vi.waitFor(() => expect(bq.queued).toHaveLength(1));
    expect(bq.queued[0]).toMatchObject({ volume_uuid: 'v1', volume_title: 'Vol 1' });
    await vi.waitFor(() => expect(bq.settle).not.toBeNull());
    expect(done).toBe(false);
    bq.settle!();
    expect(await backing).toEqual({ cloudPath: 'Series A/Vol 1.cbz' });
    expect(h.calls).toEqual(['queueVolumeForBackup', 'settled']);
  });

  it('backupVolume answers why an upload failed', async () => {
    const backing = install().backupVolume('v1');
    await vi.waitFor(() => expect(bq.settle).not.toBeNull());
    (uploadFailures as unknown as Writable<Record<string, unknown>>).set({
      v1: { volume_uuid: 'v1', reason: 'Storage is full' }
    });
    bq.settle!();
    expect(await backing).toEqual({ cloudPath: null, error: 'Storage is full' });
  });

  // A failure from an earlier run stays recorded until an upload succeeds: a
  // run that neither uploads nor fails (a series closed while queued) must not
  // answer with it.
  it('backupVolume does not answer with a failure an earlier run recorded', async () => {
    listed('Series A/Vol 1.cbz');
    const failures = uploadFailures as unknown as Writable<Record<string, unknown>>;
    failures.set({
      v1: { volume_uuid: 'v1', reason: 'Storage is full', at: '2026-11-01T00:00:00Z' }
    });
    const backing = install().backupVolume('v1');
    await vi.waitFor(() => expect(bq.settle).not.toBeNull());
    bq.settle!();
    expect(await backing).toEqual({ cloudPath: 'Series A/Vol 1.cbz' });
  });

  it('backupVolume answers a failure this run recorded over an earlier one', async () => {
    const failures = uploadFailures as unknown as Writable<Record<string, unknown>>;
    failures.set({ v1: { volume_uuid: 'v1', reason: 'Old', at: '2026-11-01T00:00:00Z' } });
    const backing = install().backupVolume('v1');
    await vi.waitFor(() => expect(bq.settle).not.toBeNull());
    failures.set({
      v1: { volume_uuid: 'v1', reason: 'Storage is full', at: '2026-11-02T00:00:00Z' }
    });
    bq.settle!();
    expect(await backing).toEqual({ cloudPath: null, error: 'Storage is full' });
  });

  it('backupVolume refuses what the queue refuses', async () => {
    vi.mocked(backupQueue.queueVolumeForBackup).mockImplementationOnce(() => 'refused');
    await expect(install().backupVolume('v1')).rejects.toThrow('could not be queued');
  });
});

describe('reading', () => {
  it('open navigates to the reader for the volume', async () => {
    expect(await install().open('v1')).toEqual({ id: 'v1' });
    expect(nav.toReader).toHaveBeenCalledWith('s1', 'v1');
    expect(downloadQueue.queueVolume).not.toHaveBeenCalled();
  });

  it("open downloads a volume not on this device first, as the card's Download does", async () => {
    listed('Series A/Vol 2.cbz');
    const opening = install().open('v2');
    await vi.waitFor(() => expect(dq.queued).toHaveLength(1));
    // The metadata-only row, with the listed archive to download it from.
    expect(dq.queued[0]).toMatchObject({
      volume_uuid: 'v2',
      cloudFileId: 'Series A/Vol 2.cbz',
      cloudProvider: 'webdav'
    });
    expect(nav.toReader).not.toHaveBeenCalled();
    await finishDownload('v2', true);
    expect(await opening).toEqual({ id: 'v2' });
    expect(nav.toReader).toHaveBeenCalledWith('s1', 'v2');
  });

  it('open downloads a cloud-only volume from its placeholder', async () => {
    listed('Series B/Vol 9.cbz');
    const id = (await install().library()).volumes.find((v) => v.series === 'Series B')!.id;
    const opening = install().open(id);
    await vi.waitFor(() => expect(dq.queued).toHaveLength(1));
    expect(dq.queued[0]).toMatchObject({ volume_uuid: id, cloudFileId: 'Series B/Vol 9.cbz' });
    // The download lands on the placeholder's uuid.
    await db.volumes.put({
      volume_uuid: id,
      series_uuid: 's9',
      series_title: 'Series B',
      volume_title: 'Vol 9',
      mokuro_version: '0.2.1',
      page_count: 2,
      character_count: 4,
      page_char_counts: [2, 4]
    });
    await finishDownload(id, true);
    expect(await opening).toEqual({ id });
    expect(nav.toReader).toHaveBeenCalledWith('s9', id);
  });

  // The series.json index lands in the background after a listing: a volume the
  // spec listed before it came carries the id its path gave, and its placeholder now
  // carries the real one. The card the user saw still downloads.
  it('open downloads a cloud-only volume listed before its series index arrived', async () => {
    listed('Series B/Vol 9.cbz');
    const listedId = (await install().library()).volumes.find((v) => v.series === 'Series B')!.id;
    await db.series_index.put({
      series_key: 'series b',
      series_title: 'Series B',
      file: {
        version: 2,
        series_title: 'Series B',
        external_ids: {},
        titles: {},
        synonyms: [],
        updated_at: '2026-10-29T00:00:00.000Z',
        volumes: [
          {
            volume_uuid: 'real-9',
            volume_title: 'Vol 9',
            page_count: 2,
            character_count: 4,
            mokuro_version: '0.2.1'
          }
        ]
      },
      source: { provider: 'webdav', path: 'Series B/series.json', size: 1, modifiedTime: '' },
      fetched_at: '2026-10-29T00:00:00.000Z'
    } as never);
    expect((await install().library()).volumes.find((v) => v.series === 'Series B')!.id).toBe(
      'real-9'
    );

    const opening = install().open(listedId);
    await vi.waitFor(() => expect(dq.queued).toHaveLength(1));
    expect(dq.queued[0]).toMatchObject({
      volume_uuid: 'real-9',
      cloudFileId: 'Series B/Vol 9.cbz'
    });
    await db.volumes.put({
      volume_uuid: 'real-9',
      series_uuid: 's9',
      series_title: 'Series B',
      volume_title: 'Vol 9',
      mokuro_version: '0.2.1',
      page_count: 2,
      character_count: 4,
      page_char_counts: [2, 4]
    });
    await finishDownload('real-9', true);
    expect(await opening).toEqual({ id: 'real-9' });
  });

  // Once the index is in, the app may make the placeholder a metadata-only row of its
  // own (a cover request, the series backfill), which shadows the placeholder. The
  // card is that row now, under the real uuid, and still downloads.
  it('open downloads a volume listed as a placeholder that has since become a row', async () => {
    listed('Series B/Vol 9.cbz');
    const listedId = (await install().library()).volumes.find((v) => v.series === 'Series B')!.id;
    await db.volumes.put({
      volume_uuid: 'real-9',
      series_uuid: 's9',
      series_title: 'Series B',
      volume_title: 'Vol 9',
      mokuro_version: '0.2.1',
      page_count: 2,
      character_count: 4,
      page_char_counts: [2, 4],
      metadata_only: true
    });
    expect((await install().library()).volumes.filter((v) => v.series === 'Series B')).toEqual([
      expect.objectContaining({ id: 'real-9' })
    ]);

    const opening = install().open(listedId);
    await vi.waitFor(() => expect(dq.queued).toHaveLength(1));
    expect(dq.queued[0]).toMatchObject({
      volume_uuid: 'real-9',
      cloudFileId: 'Series B/Vol 9.cbz'
    });
    await finishDownload('real-9', true);
    expect(await opening).toEqual({ id: 'real-9' });
    expect(nav.toReader).toHaveBeenCalledWith('s9', 'real-9');
  });

  it('open fails, and goes nowhere, when the download did not install the volume', async () => {
    listed('Series A/Vol 2.cbz');
    const opening = install().open('v2');
    await vi.waitFor(() => expect(dq.queued).toHaveLength(1));
    await finishDownload('v2', false);
    await expect(opening).rejects.toThrow('Vol 2 was not installed');
    expect(nav.toReader).not.toHaveBeenCalled();
  });

  it('open refuses a volume with no cloud copy to download', async () => {
    await expect(install().open('v2')).rejects.toThrow('nowhere to download');
    await expect(install().open('nope')).rejects.toThrow('No volume nope');
  });

  it("showSeries is the catalog card's click: the series page by its title", async () => {
    await install().showSeries('Series A');
    expect(nav.toSeries).toHaveBeenCalledWith('Series A');
  });

  it("pendingOcr is what the volume's card shows of the server's queue", async () => {
    expect(await install().pendingOcr('v2')).toBeNull();
    queueStatusStore.set({
      ['series a\u0000vol 2']: {
        jobs: [{ kind: 'ocr', id: 'mokuro', state: 'queued', eta: null, progress: null }],
        held: null
      }
    });
    expect(await install().pendingOcr('v2')).toMatchObject({
      title: 'Server OCR',
      inline: 'Server OCR: Text queued'
    });
  });

  it('setPage records a paged page turn against the primary pages', async () => {
    (volumeDataStore as ReturnType<typeof writable>).set({
      v1: { progress: 2, completed: true }
    });
    expect(await install().setPage('v1', 2)).toEqual({ page: 2, completed: true });
    expect(recordPagedPageView).toHaveBeenCalledWith('v1', 2, PAGES);
    await expect(install().setPage('v1', 3)).rejects.toThrow('outside');
  });

  it('progress reads the progress store', () => {
    (volumeDataStore as ReturnType<typeof writable>).set({
      v1: { progress: 1, completed: false }
    });
    expect(install().progress('v1')).toEqual({ page: 1, completed: false });
    expect(install().progress('nope')).toEqual({ page: 0, completed: false });
  });
});

describe('renames and deletes', () => {
  it('renameVolume sanitizes, then the cloud rename gates the local one', async () => {
    expect(await install().renameVolume('v1', 'Vol 1: Start')).toEqual({ title: 'Vol 1： Start' });
    expect(renameVolumeInCloud).toHaveBeenCalledWith(
      expect.objectContaining({ volume_uuid: 'v1' }),
      'Series A',
      'Vol 1： Start'
    );
    expect(updateVolumeInDb).toHaveBeenCalledWith('v1', { volume_title: 'Vol 1： Start' });
    expect(h.calls).toEqual(['renameVolumeInCloud', 'updateVolumeInDb', 'updateVolumeStats']);
  });

  it('a refused cloud rename changes nothing locally', async () => {
    vi.mocked(renameVolumeInCloud).mockRejectedValueOnce(new Error('403 Forbidden'));
    await expect(install().renameVolume('v1', 'Other')).rejects.toThrow('403');
    expect(updateVolumeInDb).not.toHaveBeenCalled();
  });

  it("renameSeries is the series editor rename, for the card's series uuid", async () => {
    // A second series uuid under the same title (a re-import): the card is the
    // first row's series, and the editor renames only that uuid's volumes.
    await db.volumes.put({
      volume_uuid: 'v3',
      series_uuid: 's2',
      series_title: 'Series A',
      volume_title: 'Vol 3',
      mokuro_version: '0.2.1',
      page_count: 2,
      character_count: 4,
      page_char_counts: [2, 4]
    });
    expect(await install().renameSeries('series a', ' Series Z ')).toEqual({
      finalTitle: 'Series Z',
      renamedCount: 1,
      failures: []
    });
    expect(executeRenameSeries).toHaveBeenCalledWith('Series A', 'Series Z', 's1');
  });

  it('renameSeries refuses what the editor refuses: no rows, nothing renamed', async () => {
    await expect(install().renameSeries('Nope', 'Other')).rejects.toThrow('Nothing to rename');
    expect(executeRenameSeries).not.toHaveBeenCalled();

    vi.mocked(executeRenameSeries).mockResolvedValueOnce({
      finalTitle: 'Other',
      renamedCount: 0,
      failures: []
    });
    await expect(install().renameSeries('Series A', 'Other')).rejects.toThrow('Nothing to rename');
  });

  it('renameSeries to the same name renames nothing', async () => {
    expect(await install().renameSeries('Series A', 'Series A ')).toEqual({
      finalTitle: 'Series A',
      renamedCount: 0,
      failures: []
    });
    expect(executeRenameSeries).not.toHaveBeenCalled();
  });

  it('deleteVolume deletes the listed cloud copy before the local volume', async () => {
    vi.mocked(providerManager.getActiveProvider).mockReturnValue(
      provider as unknown as SyncProvider
    );
    listed('Series A/Vol 1.cbz');
    expect(await install().deleteVolume('v1')).toEqual({ cloud: 'deleted' });
    expect(unifiedCloudManager.deleteManagedVolume).toHaveBeenCalledWith('Series A', 'Vol 1', 'v1');
    expect(h.calls).toEqual(['deleteManagedVolume', 'deleteVolumeCompletely', 'deleteVolumeStats']);
  });

  it('reads the listing the cache holds now, not its lagged emission', async () => {
    // A rename's moves reach the cache at once; `cloudFiles` publishes them on
    // the coalesced trailing edge (CACHE_MUTATION_COALESCE_MS) after.
    vi.mocked(providerManager.getActiveProvider).mockReturnValue(
      provider as unknown as SyncProvider
    );
    listed('Series A/Vol 0.cbz');
    cached('Series A/Vol 1.cbz', 'history/dev-a/2026-10.events');
    const { volumes } = await install().library();
    expect(volumes.map((v) => [v.title, v.cloudPath])).toEqual([
      ['Vol 1', 'Series A/Vol 1.cbz'],
      ['Vol 2', null]
    ]);
    expect(await install().deleteVolume('v1')).toEqual({ cloud: 'deleted' });
  });

  it('deleteVolume skips the cloud when the account may not delete there', async () => {
    vi.mocked(providerManager.getActiveProvider).mockReturnValue(
      provider as unknown as SyncProvider
    );
    vi.mocked(canDeleteSeriesOnServer).mockReturnValueOnce({ allowed: false });
    listed('Series A/Vol 1.cbz');
    expect(await install().deleteVolume('v1')).toEqual({ cloud: 'not-permitted' });
    expect(unifiedCloudManager.deleteManagedVolume).not.toHaveBeenCalled();
    expect(h.calls).toEqual(['deleteVolumeCompletely', 'deleteVolumeStats']);
  });

  it('setSpineOffset writes through the shelf writer at once', async () => {
    await install().setSpineOffset('Series A', 3);
    expect(scheduleSpineOffsetWrite).toHaveBeenCalledWith('Series A', { spineOffset: 3 });
    expect(flushSpineOffsetWrites).toHaveBeenCalled();
  });

  it('setSpineOffset skips a value the shelf already shows, as the card does', async () => {
    // No record and no published value: 0 is what is shown.
    await install().setSpineOffset('Series A', 0);
    expect(scheduleSpineOffsetWrite).not.toHaveBeenCalled();

    await db.series_metadata.put({
      series_key: 'series a',
      series_title: 'Series A',
      external_ids: {},
      titles: {},
      synonyms: [],
      spine_offset: 3
    } as never);
    await install().setSpineOffset('Series A', 3);
    expect(scheduleSpineOffsetWrite).not.toHaveBeenCalled();

    await install().setSpineOffset('Series A', 4);
    expect(scheduleSpineOffsetWrite).toHaveBeenCalledWith('Series A', { spineOffset: 4 });
  });
});

describe('editing and layers', () => {
  it('editFirstBlock saves the primary through the editor path (and its edit layer)', async () => {
    expect(await install().editFirstBlock('v1', 2, 'なおした')).toEqual({ layerId: null });
    const ocr = await db.volume_ocr.get('v1');
    expect(ocr?.pages[1].blocks[0].lines).toEqual(['なおした']);
    expect((await getLayerPages(db, 'v1', 'edit'))?.[1].blocks[0].lines).toEqual(['なおした']);
    expect(await listLayerIds(db, 'v1')).toEqual(expect.arrayContaining(['edit', 'original']));
  });

  it('editFirstBlock on the primary pulls the account overlay first, as the reader does', async () => {
    vi.mocked(pullOwnEditLayerBeforeEdit).mockClear();
    await install().editFirstBlock('v1', 1, 'さきに');
    expect(pullOwnEditLayerBeforeEdit).toHaveBeenCalledWith('v1');
  });

  it('editFirstBlock edits nothing when the overlay could not be fetched', async () => {
    vi.mocked(pullOwnEditLayerBeforeEdit).mockResolvedValueOnce('failed');
    await expect(install().editFirstBlock('v1', 1, 'だめ')).rejects.toThrow(
      "Couldn't fetch this account's corrections"
    );
    expect((await db.volume_ocr.get('v1'))?.pages[0].blocks[0].lines).toEqual(['あい']);
    expect(await listLayerIds(db, 'v1')).not.toContain('edit');
  });

  it('editFirstBlock on a shared layer edits the account copy instead', async () => {
    await putLayerWithPages(db, {
      volume_uuid: 'v1',
      layer_id: 'curated',
      name: 'Curated',
      kind: 'edit',
      created_at: 't',
      updated_at: 't',
      pages: PAGES
    });
    (volumeDataStore as ReturnType<typeof writable>).set({
      v1: { progress: 1, completed: false, settings: { ocrLayer: 'curated' } }
    });
    expect(await install().editFirstBlock('v1', 1, 'わたしの')).toEqual({ layerId: 'edit' });
    expect(pullOwnEditLayerBeforeEdit).toHaveBeenCalledWith('v1');
    expect(updateVolumeSetting).toHaveBeenCalledWith('v1', 'ocrLayer', 'edit');
    expect((await getLayerPages(db, 'v1', 'edit'))?.[0].blocks[0].lines).toEqual(['わたしの']);
    expect((await getLayerPages(db, 'v1', 'curated'))?.[0].blocks[0].lines).toEqual(['あい']);
    expect((await db.volume_ocr.get('v1'))?.pages[0].blocks[0].lines).toEqual(['あい']);
  });

  it('editFirstBlock refuses the read-only original layer, as the reader does', async () => {
    await putLayerWithPages(db, {
      volume_uuid: 'v1',
      layer_id: 'original',
      name: 'Original',
      kind: 'original',
      created_at: 't',
      updated_at: 't',
      pages: PAGES
    });
    (volumeDataStore as ReturnType<typeof writable>).set({
      v1: { progress: 1, completed: false, settings: { ocrLayer: 'original' } }
    });
    await expect(install().editFirstBlock('v1', 1, 'だめ')).rejects.toThrow(
      'The original layer is read-only'
    );
    expect((await getLayerPages(db, 'v1', 'original'))?.[0].blocks[0].lines).toEqual(['あい']);
    expect((await db.volume_ocr.get('v1'))?.pages[0].blocks[0].lines).toEqual(['あい']);
    expect(updateVolumeSetting).not.toHaveBeenCalled();
  });

  it('publishCurated is the Publish action with its confirmation answered', async () => {
    expect(await install().publishCurated('v1')).toEqual({
      outcome: 'published',
      message: 'Your corrections are now the shared corrections'
    });
    expect(publishCuratedLayer).toHaveBeenCalledWith('v1');
    vi.mocked(publishCuratedLayer).mockResolvedValueOnce('refused');
    expect((await install().publishCurated('v1')).outcome).toBe('refused');
  });

  it('selectLayer sets the displayed layer; null shows the primary', async () => {
    await install().selectLayer('v1', 'curated');
    expect(updateVolumeSetting).toHaveBeenLastCalledWith('v1', 'ocrLayer', 'curated');
    await install().selectLayer('v1', null);
    expect(updateVolumeSetting).toHaveBeenLastCalledWith('v1', 'ocrLayer', undefined);
  });
});

describe('status', () => {
  it('providerStatus is the connected provider status, as plain JSON', () => {
    expect(install().providerStatus()).toBeNull();
    statusStore.set({ isAuthenticated: true, isReadOnly: false });
    expect(install().providerStatus()).toEqual({ isAuthenticated: true, isReadOnly: false });
  });

  it('providerStatus reads what the app last published, publishing nothing itself', () => {
    // The banner and the read-only gates read the store: a provider change the
    // app never published is one the user never sees, and a spec must not either.
    install().providerStatus();
    expect(providerManager.updateStatus).not.toHaveBeenCalled();
  });

  it('controlState reads the marker store for the connected provider', () => {
    expect(install().controlState()).toEqual({
      marker: null,
      serverCompilesMetadata: false,
      held: false
    });
    vi.mocked(providerManager.getActiveProvider).mockReturnValue(
      provider as unknown as SyncProvider
    );
    const marker = { fresh: true, holder: null };
    vi.mocked(cloudBunkoStatus).mockReturnValue(marker);
    vi.mocked(cloudBunkoMergesDuplicates).mockReturnValue(true);
    expect(install().controlState()).toEqual({
      marker,
      serverCompilesMetadata: true,
      held: true
    });
    expect(cloudBunkoStatus).toHaveBeenCalledWith('webdav');
  });

  it('historyStatus is the history gate and the known devices', async () => {
    expect(await install().historyStatus()).toEqual({
      enabled: false,
      devices: ['dev-a', 'dev-b']
    });
    vi.mocked(providerManager.getActiveProvider).mockReturnValue(
      provider as unknown as SyncProvider
    );
    expect(await install().historyStatus()).toEqual({
      enabled: true,
      devices: ['dev-a', 'dev-b']
    });
    expect(historySyncAllowed).toHaveBeenCalledWith({ serverCompilesMetadata: true });
  });
});
