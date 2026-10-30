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
      })
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
  pullOwnEditLayerBeforeFork: vi.fn(async () => false),
  listedCuratedLayerFile: vi.fn(async () => null),
  clearPendingLayerDelete: vi.fn(),
  deleteCloudLayerFile: vi.fn(),
  unpublishCuratedLayer: vi.fn()
}));
vi.mock('$lib/metadata/spine-offsets', () => ({
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
  })
}));
vi.mock('$lib/util/hash-router', () => ({ nav: { toReader: vi.fn() } }));
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
import { publishCuratedLayer, pullOwnEditLayerBeforeFork } from '$lib/metadata/layer-sync';
import { flushSpineOffsetWrites, scheduleSpineOffsetWrite } from '$lib/metadata/spine-offsets';
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
  'historyStatus'
];

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
  vi.clearAllMocks();
  vi.mocked(providerManager.getActiveProvider).mockReturnValue(null);
  statusStore.set(null);
  (volumeDataStore as ReturnType<typeof writable>).set({});
  (unifiedCloudManager.cloudFiles as ReturnType<typeof writable>).set(new Map());
  await Promise.all([db.volumes.clear(), db.volume_ocr.clear(), clearAllLayers(db)]);
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

function listed(...paths: string[]) {
  const map = new Map<string, unknown[]>();
  for (const path of paths) {
    const folder = path.split('/')[0];
    map.set(folder, [...(map.get(folder) ?? []), { path, provider: 'webdav', fileId: path }]);
  }
  (unifiedCloudManager.cloudFiles as ReturnType<typeof writable>).set(map);
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

describe('reading', () => {
  it('open navigates to the reader for the volume', async () => {
    await install().open('v1');
    expect(nav.toReader).toHaveBeenCalledWith('s1', 'v1');
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

  it('renameSeries is the series editor rename', async () => {
    expect(await install().renameSeries('Series A', ' Series Z ')).toEqual({
      finalTitle: 'Series Z',
      renamedCount: 1,
      failures: []
    });
    expect(executeRenameSeries).toHaveBeenCalledWith('Series A', 'Series Z');
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
});

describe('editing and layers', () => {
  it('editFirstBlock saves the primary through the editor path (and its edit layer)', async () => {
    expect(await install().editFirstBlock('v1', 2, 'なおした')).toEqual({ layerId: null });
    const ocr = await db.volume_ocr.get('v1');
    expect(ocr?.pages[1].blocks[0].lines).toEqual(['なおした']);
    expect((await getLayerPages(db, 'v1', 'edit'))?.[1].blocks[0].lines).toEqual(['なおした']);
    expect(await listLayerIds(db, 'v1')).toEqual(expect.arrayContaining(['edit', 'original']));
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
    expect(pullOwnEditLayerBeforeFork).toHaveBeenCalledWith('v1');
    expect(updateVolumeSetting).toHaveBeenCalledWith('v1', 'ocrLayer', 'edit');
    expect((await getLayerPages(db, 'v1', 'edit'))?.[0].blocks[0].lines).toEqual(['わたしの']);
    expect((await getLayerPages(db, 'v1', 'curated'))?.[0].blocks[0].lines).toEqual(['あい']);
    expect((await db.volume_ocr.get('v1'))?.pages[0].blocks[0].lines).toEqual(['あい']);
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
