import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudVolumeWithProvider } from './unified-cloud-manager';

/**
 * The upload-storm fix, pinned END TO END through the REAL cache stack:
 * `unifiedCloudManager.blindUploadFile` → provider `cache.add` → the
 * provider cache's coalesced store → `cacheManager.allFiles` →
 * `unifiedCloudManager.cloudFiles`.
 *
 * Unlike `unified-cloud-manager.test.ts`, the cache manager and the WebDAV
 * cache here are the PRODUCTION implementations — only the network-touching
 * modules are mocked. That is the point: the storm lived in the seam between
 * `performUpload`'s `cache.add` and the store the placeholder/matcher
 * pipeline derives from, and a mocked cache manager cannot witness it.
 *
 * The two properties, each the negation of a real defect:
 *
 * - A serial upload stream costs `cloudFiles` subscribers ONE re-derive per
 *   quiet window, not one per file (the observed storm: a full placeholder
 *   regeneration + matcher scan over 2,222 archives per uploaded sidecar).
 * - The sidecar-backfill drain's read path (`getCloudVolumesBySeries`) sees
 *   every `add` IMMEDIATELY, even while the emission is pending — lag there
 *   would make the drain re-upload a file it just uploaded.
 */

const getActiveProvider = vi.fn();
vi.mock('$lib/util/sync/provider-manager', () => ({
  providerManager: {
    getActiveProvider: () => getActiveProvider()
  }
}));

vi.mock('$lib/util/sync/unified-sync-service', () => ({
  unifiedSyncService: {
    isSyncing: { subscribe: vi.fn() },
    syncProvider: vi.fn()
  }
}));

vi.mock('$lib/util/compress-volume', () => ({
  generateVolumeSidecarsFromDb: vi.fn()
}));

vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: {
      toArray: async () => [],
      get: async () => undefined
    }
  }
}));

vi.mock('$lib/metadata/store', () => ({
  getSeriesMetadataForTitle: vi.fn(async () => undefined),
  getAllSeriesMetadata: vi.fn(async () => ({})),
  getSeriesMetadataByFoldedTitle: vi.fn(async () => []),
  getSeriesMetadataByFoldedTitles: vi.fn(async () => []),
  upsertFromSeriesFile: vi.fn(async () => true)
}));

vi.mock('$lib/metadata/series-index', async () => {
  const actual = await vi.importActual<typeof import('$lib/metadata/series-index')>(
    '$lib/metadata/series-index'
  );
  return {
    indexNeedsRefresh: actual.indexNeedsRefresh,
    sourceStampChanged: actual.sourceStampChanged,
    getSeriesIndex: vi.fn(async () => undefined),
    putSeriesIndex: vi.fn(async () => {}),
    deleteSeriesIndex: vi.fn(async () => {}),
    moveSeriesIndexKey: vi.fn(async () => {})
  };
});

vi.mock('$lib/metadata/catalog-index', async () => {
  const actual = await vi.importActual<typeof import('$lib/metadata/catalog-index')>(
    '$lib/metadata/catalog-index'
  );
  return {
    catalogNeedsRefresh: actual.catalogNeedsRefresh,
    getCatalogIndex: vi.fn(async () => undefined),
    dropCatalogEntries: vi.fn(async () => {}),
    putCatalogIndex: vi.fn(async () => {}),
    moveCatalogIndexKey: vi.fn(async () => {})
  };
});

vi.mock('$lib/metadata/series-index-sync', () => ({
  refreshSeriesIndexes: vi.fn(async () => {})
}));

vi.mock('$lib/metadata/catalog-index-sync', () => ({
  refreshCatalogIndex: vi.fn(async () => {})
}));

vi.mock('$lib/metadata/series-file-sync', () => ({
  reconcileMissingMetadataFiles: vi.fn(async () => {}),
  markListingFresh: vi.fn()
}));

const isAuthenticated = vi.fn(() => true);
const listCloudVolumes = vi.fn(async (): Promise<unknown[]> => []);
vi.mock('$lib/util/sync/providers/webdav/webdav-provider', () => ({
  webdavProvider: {
    isAuthenticated: () => isAuthenticated(),
    listCloudVolumes: () => listCloudVolumes()
  }
}));

import { CACHE_MUTATION_COALESCE_MS } from './coalesced-cache-store';
import { cacheManager } from './cache-manager';
import { webdavCache } from './providers/webdav/webdav-cache';
import { unifiedCloudManager } from './unified-cloud-manager';

/**
 * The WebDAV upload shape: a PUT answers with a fileId and NO server mtime,
 * so `performUpload`'s cache entry is provisional — the same entries the
 * live storm was made of.
 */
function makeBlindProvider() {
  return {
    type: 'webdav' as const,
    blindUploadFile: vi.fn(async (path: string) => ({ fileId: `id-${path}` })),
    uploadFile: vi.fn(async (path: string) => ({ fileId: `id-${path}` }))
  };
}

describe('cache emission coalescing through the real cache stack', () => {
  let seen: Map<string, CloudVolumeWithProvider[]>[];
  let unsubscribe: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    getActiveProvider.mockReturnValue(makeBlindProvider());
    isAuthenticated.mockReturnValue(true);
    listCloudVolumes.mockResolvedValue([]);
    webdavCache.clear();
    cacheManager.registerCache('webdav', webdavCache);
    cacheManager.setActiveProvider('webdav');

    seen = [];
    unsubscribe = unifiedCloudManager.cloudFiles.subscribe((map) => {
      seen.push(map);
    });
    // Drop the subscribe-time replay; only real emissions count below.
    seen.length = 0;
  });

  afterEach(() => {
    unsubscribe();
    webdavCache.clear();
    vi.useRealTimers();
  });

  const pathsIn = (map: Map<string, CloudVolumeWithProvider[]>): string[] =>
    [...map.values()].flat().map((file) => file.path);

  it('collapses a serial burst of blind uploads to ONE cloudFiles emission — one subscriber re-derive per window, not per file', async () => {
    for (let vol = 1; vol <= 4; vol++) {
      await unifiedCloudManager.blindUploadFile(`Series A/Vol ${vol}.mokuro`, new Blob(['{}']));
      await unifiedCloudManager.blindUploadFile(`Series A/Vol ${vol}.webp`, new Blob(['img']));
    }

    // Eight uploads, zero emissions so far: with publish-per-add (the storm)
    // this is 8.
    expect(seen).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(CACHE_MUTATION_COALESCE_MS);

    expect(seen).toHaveLength(1);
    // ...and the one emission carries the CURRENT map: every upload of the
    // burst, not a snapshot from when the window opened.
    expect(pathsIn(seen[0]).sort()).toEqual([
      'Series A/Vol 1.mokuro',
      'Series A/Vol 1.webp',
      'Series A/Vol 2.mokuro',
      'Series A/Vol 2.webp',
      'Series A/Vol 3.mokuro',
      'Series A/Vol 3.webp',
      'Series A/Vol 4.mokuro',
      'Series A/Vol 4.webp'
    ]);

    await vi.advanceTimersByTimeAsync(10 * CACHE_MUTATION_COALESCE_MS);
    expect(seen).toHaveLength(1);
  });

  it("shows an upload's cache add to the drain's read path IMMEDIATELY, while the store emission is still pending", async () => {
    await unifiedCloudManager.blindUploadFile('Series A/Vol 1.mokuro', new Blob(['{}']));

    // The exact read the sidecar-backfill drain re-derives "sidecar missing"
    // from before each upload. Lag here re-uploads a just-uploaded file.
    const listed = unifiedCloudManager.getCloudVolumesBySeries('Series A');
    expect(listed.map((file) => file.path)).toEqual(['Series A/Vol 1.mokuro']);

    // While the emission is GENUINELY pending — without this the assertion
    // above would also pass under publish-per-add and pin nothing.
    expect(seen).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(CACHE_MUTATION_COALESCE_MS);
    expect(seen).toHaveLength(1);
    expect(pathsIn(seen[0])).toEqual(['Series A/Vol 1.mokuro']);
  });

  it('lets a full listing install supersede a pending add emission — nothing fires afterwards to clobber the fresh listing', async () => {
    listCloudVolumes.mockResolvedValue([
      {
        provider: 'webdav',
        fileId: 'cbz-1',
        path: 'Series A/Vol 1.cbz',
        modifiedTime: '2026-08-25T00:00:00.000Z',
        size: 100
      }
    ]);

    // Arms the coalescing window...
    await unifiedCloudManager.blindUploadFile('Series A/Vol 1.mokuro', new Blob(['{}']));
    expect(seen).toHaveLength(0);

    // ...and the whole-account fetch completes inside it.
    await webdavCache.fetch();

    // The install published immediately (full listings are one-shot and
    // consumers wait on them)...
    expect(seen).toHaveLength(1);
    expect(pathsIn(seen[0])).toEqual(['Series A/Vol 1.cbz']);

    // ...and the pre-fetch map never fires afterwards over the top of it.
    await vi.advanceTimersByTimeAsync(10 * CACHE_MUTATION_COALESCE_MS);
    expect(seen).toHaveLength(1);
    expect(pathsIn(seen[seen.length - 1])).toEqual(['Series A/Vol 1.cbz']);
  });

  it("cancels a pending add emission on clear (logout/account switch) — the dead account's files never reach subscribers", async () => {
    await unifiedCloudManager.blindUploadFile('Series A/Vol 1.mokuro', new Blob(['{}']));
    expect(seen).toHaveLength(0);

    // What logout and provider switching route through.
    webdavCache.clear();

    await vi.advanceTimersByTimeAsync(10 * CACHE_MUTATION_COALESCE_MS);

    // Exactly the clear's own empty publish; no emission — before or after —
    // ever carried the dead account's file, and no timer survived teardown.
    expect(seen).toHaveLength(1);
    expect(seen[0].size).toBe(0);
    expect(seen.some((map) => pathsIn(map).length > 0)).toBe(false);
  });
});
