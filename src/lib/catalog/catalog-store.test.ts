import { describe, expect, it, vi } from 'vitest';
import type { VolumeMetadata } from '$lib/types';

/**
 * The `catalog` store re-groups, re-resolves display titles for and re-sorts the whole
 * library on every emission of its inputs. It used to join `catalogSettings`, an object
 * store that emits on EVERY settings write — including per-wheel-tick ones like
 * `pagedGap` — so scrolling a slider rebuilt the catalog. It now joins the primitive
 * `preferredTitleLanguage`, which dedupes by string value.
 *
 * Everything except the settings module is mocked so the store graph is: fake volumes →
 * catalog ← real settings.
 */
const {
  volumeRecord,
  cloudFiles,
  seriesMetadataMap,
  seriesIndexMap,
  routeParams,
  generatePlaceholders
} = vi.hoisted(() => {
  // vi.mock factories are hoisted above imports, so the stores they close over are
  // hand-rolled here rather than built with svelte/store's `writable`.
  function createStore<T>(initial: T) {
    let value = initial;
    const subs = new Set<(v: T) => void>();
    return {
      subscribe(fn: (v: T) => void) {
        subs.add(fn);
        fn(value);
        return () => subs.delete(fn);
      },
      set(v: T) {
        value = v;
        subs.forEach((fn) => fn(value));
      }
    };
  }

  const volume = {
    volume_uuid: 'v1',
    series_uuid: 's1',
    series_title: 'One Piece',
    volume_title: 'Volume 1',
    mokuro_version: '0.4.11',
    page_count: 10,
    character_count: 100,
    page_char_counts: [10, 20]
  };

  return {
    volumeRecord: { v1: volume } as Record<string, unknown>,
    cloudFiles: createStore(new Map<string, unknown>()),
    seriesMetadataMap: createStore(new Map<string, unknown>()),
    seriesIndexMap: createStore(new Map<string, unknown>()),
    routeParams: createStore({} as Record<string, string>),
    generatePlaceholders: vi.fn(() => [] as unknown[])
  };
});

vi.mock('$lib/catalog/db', () => ({ db: {} }));
// The `volumes` readable wraps liveQuery; emit a fixed record once instead of touching IndexedDB.
vi.mock('dexie', () => ({
  liveQuery: () => ({
    subscribe: ({ next }: { next: (v: unknown) => void }) => {
      next(volumeRecord);
      return { unsubscribe() {} };
    }
  })
}));
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: { cloudFiles }
}));
// Only the cloud scan is stubbed; the path index and the cloud-field lookup a
// metadata-only row is decorated with are the real ones.
vi.mock('$lib/catalog/placeholders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/catalog/placeholders')>();
  return { ...actual, generatePlaceholders };
});
vi.mock('$lib/util/hash-router', () => ({ routeParams }));
vi.mock('$lib/util/download-volume-repair', () => ({
  getLegacyImageOnlyVolumeUuid: () => undefined
}));
vi.mock('$lib/metadata/store', () => ({ seriesMetadataMap }));
vi.mock('$lib/metadata/series-index', () => ({ seriesIndexMap }));
vi.mock('$lib/catalog/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/catalog/catalog')>();
  return { ...actual, deriveSeriesFromVolumes: vi.fn(actual.deriveSeriesFromVolumes) };
});

import { catalog, volumesWithPlaceholders } from '$lib/catalog';
import { deriveSeriesFromVolumes } from '$lib/catalog/catalog';
import { updateCatalogSetting, updateSetting } from '$lib/settings/settings';

describe('catalog store recomputes', () => {
  it('rebuilds only when the title language actually changes', () => {
    const derive = vi.mocked(deriveSeriesFromVolumes);
    derive.mockClear();

    let latest: ReturnType<typeof deriveSeriesFromVolumes> | null = null;
    const unsubscribe = catalog.subscribe((value) => (latest = value));

    expect(derive).toHaveBeenCalledTimes(1);
    expect((latest as unknown as Array<{ title: string }>)[0].title).toBe('One Piece');

    // An unrelated setting (this one fires once per wheel tick in the reader)
    updateSetting('pagedGap', 12);
    updateSetting('pagedGap', 13);
    expect(derive).toHaveBeenCalledTimes(1);

    // A different catalog setting object-identity change, still not the language
    updateCatalogSetting('stackCount', 4);
    expect(derive).toHaveBeenCalledTimes(1);

    // The language itself does rebuild the catalog
    updateCatalogSetting('preferredTitleLanguage', 'romaji');
    expect(derive).toHaveBeenCalledTimes(2);
    expect(derive).toHaveBeenLastCalledWith(
      expect.any(Array) as unknown as VolumeMetadata[],
      expect.any(Map),
      'romaji'
    );

    // Re-selecting the same language is a no-op
    updateCatalogSetting('preferredTitleLanguage', 'romaji');
    expect(derive).toHaveBeenCalledTimes(2);

    unsubscribe();
  });
});

/**
 * `volumesWithPlaceholders` now also joins the cached `series.json` indexes, so
 * cloud-only volumes can carry their real uuid and counts. That store is a
 * Dexie liveQuery: it re-runs (and emits a brand-new Map of brand-new row
 * objects) on ANY write to the table, including writes that change nothing this
 * store cares about. Rebuilding the placeholder set on each of those would
 * re-run the whole cloud scan — and its OCR-upgrade side effects — per write.
 */
describe('volumesWithPlaceholders', () => {
  const cloudListing = new Map<string, unknown>([
    [
      'One Piece',
      [
        {
          provider: 'webdav',
          fileId: 'f1',
          path: 'One Piece/Volume 2.cbz',
          modifiedTime: '2026-08-17T00:00:00.000Z',
          size: 42
        }
      ]
    ]
  ]);

  function indexRecord(fetched_at: string) {
    return {
      series_key: 'one piece',
      series_title: 'One Piece',
      file: { version: 2, series_title: 'One Piece', volumes: [] },
      source: { provider: 'webdav', path: 'One Piece/series.json', size: 1, modifiedTime: 't' },
      fetched_at
    };
  }

  it('passes the index to generatePlaceholders and recomputes only on real changes', () => {
    const generate = vi.mocked(generatePlaceholders);
    generate.mockClear();
    cloudFiles.set(cloudListing);
    seriesIndexMap.set(new Map([['one piece', indexRecord('2026-08-17T00:00:00.000Z')]]));

    const unsubscribe = volumesWithPlaceholders.subscribe(() => {});

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenLastCalledWith(
      cloudListing,
      expect.any(Array),
      expect.any(Map) as unknown as Map<string, unknown>
    );

    // A liveQuery re-emission carrying the same records (fresh Map, fresh row
    // objects) must NOT rebuild the placeholders.
    seriesIndexMap.set(new Map([['one piece', indexRecord('2026-08-17T00:00:00.000Z')]]));
    seriesIndexMap.set(new Map([['one piece', indexRecord('2026-08-17T00:00:00.000Z')]]));
    expect(generate).toHaveBeenCalledTimes(1);

    // A refresh that actually stored something new does.
    seriesIndexMap.set(new Map([['one piece', indexRecord('2026-08-17T09:00:00.000Z')]]));
    expect(generate).toHaveBeenCalledTimes(2);

    // As does a new series arriving in the index.
    seriesIndexMap.set(
      new Map([
        ['one piece', indexRecord('2026-08-17T09:00:00.000Z')],
        ['naruto', { ...indexRecord('2026-08-17T09:00:00.000Z'), series_key: 'naruto' }]
      ])
    );
    expect(generate).toHaveBeenCalledTimes(3);

    unsubscribe();
    cloudFiles.set(new Map());
  });

  it('decorates a metadata-only row with the cloud file it can be downloaded from', () => {
    // The row shadows its own placeholder (generatePlaceholders skips a path
    // that has a local row), so without this join there would be no fileId to
    // download it with.
    volumeRecord.v2 = {
      volume_uuid: 'v2',
      series_uuid: 's1',
      series_title: 'One Piece',
      volume_title: 'Volume 2',
      mokuro_version: '0.4.11',
      page_count: 10,
      character_count: 100,
      page_char_counts: [],
      metadata_only: true
    };
    cloudFiles.set(new Map(cloudListing));

    let latest: Record<string, VolumeMetadata> = {};
    const unsubscribe = volumesWithPlaceholders.subscribe((value) => (latest = value));

    expect(latest.v2.cloudFileId).toBe('f1');
    expect(latest.v2.cloudProvider).toBe('webdav');
    expect(latest.v2.metadata_only).toBe(true);
    // The stored row is never decorated — the fileId belongs to the listing.
    expect(volumeRecord.v2).not.toHaveProperty('cloudFileId');
    // An installed row is left exactly as it came out of the database.
    expect(latest.v1).toBe(volumeRecord.v1);

    unsubscribe();
    delete volumeRecord.v2;
    cloudFiles.set(new Map());
  });
});
