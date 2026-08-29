import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { CloudFileMetadata } from '$lib/util/sync/provider-interface';

/**
 * The local→cloud half of a catalog refresh: HEALING. A local fact edit that
 * never reached the cloud (a silently dropped best-effort push) leaves the
 * catalog's per-entry facts stamp behind the local one forever — the cloud
 * file's own stamp never moves, so a heal that only ran "when the catalog
 * changed" would never run at all. The refresh therefore compares stamps on
 * EVERY listing, schedules a series.json write for each series whose local
 * facts are strictly newer (or missing from the catalog entirely), and then
 * schedules a catalog write for providers where this client is the producer.
 */

vi.mock('$lib/catalog/thumbnails', () => ({ generateThumbnail: vi.fn() }));
vi.mock('$lib/util/progress-tracker', () => ({
  progressTrackerStore: { addProcess: vi.fn(), updateProcess: vi.fn(), removeProcess: vi.fn() }
}));

vi.mock('$lib/catalog/db', async () => {
  const { default: Dexie } = await import('dexie');
  const db = new Dexie('catalog-index-sync-heal-test');
  db.version(1).stores({ series_metadata: 'series_key', catalog_index: 'id' });
  return { db };
});

const {
  getActiveProvider,
  scheduleSeriesFileWrite,
  scheduleCatalogFileWrite,
  cloudVolumeTitlesFor
} = vi.hoisted(() => ({
  getActiveProvider: vi.fn(),
  scheduleSeriesFileWrite: vi.fn(),
  scheduleCatalogFileWrite: vi.fn(),
  cloudVolumeTitlesFor: vi.fn()
}));
vi.mock('$lib/util/sync/provider-manager', () => ({ providerManager: { getActiveProvider } }));
vi.mock('./series-file-sync', () => ({ scheduleSeriesFileWrite }));
vi.mock('./catalog-file-sync', () => ({ scheduleCatalogFileWrite }));
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: { cloudVolumeTitlesFor }
}));

import { db } from '$lib/catalog/db';
import { refreshCatalogIndex } from './catalog-index-sync';

const CATALOG_STAMP = 'Wed, 27 Aug 2026 10:00:00 GMT';

function catalogFile(entries: Array<Record<string, unknown>>) {
  return {
    version: 1,
    updated_at: '2026-08-27T10:00:00.000Z',
    series: entries
  };
}

function entry(series_title: string, updated_at: string, extra: Record<string, unknown> = {}) {
  return { series_title, updated_at, external_ids: { anilist: 1 }, ...extra };
}

function listing(catalog: unknown): Map<string, CloudFileMetadata[]> {
  const file = (path: string): CloudFileMetadata => ({
    provider: 'webdav',
    fileId: path,
    path,
    modifiedTime: CATALOG_STAMP,
    size: JSON.stringify(catalog).length
  });
  return new Map([['catalog.json', [file('catalog.json')]]]);
}

function provider(catalog: unknown, serverCompilesMetadata: boolean) {
  return {
    type: 'webdav',
    serverCompilesMetadata,
    downloadFile: vi.fn(async () => new Blob([JSON.stringify(catalog)]))
  };
}

async function seedLocal(series_title: string, facts_updated_at: string) {
  await db.series_metadata.put({
    series_key: series_title.toLowerCase(),
    folded_key: series_title.toLowerCase(),
    series_title,
    external_ids: { anilist: 99 },
    titles: { native: `${series_title} 日本語` },
    synonyms: [],
    updated_at: facts_updated_at,
    facts_updated_at
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  cloudVolumeTitlesFor.mockReturnValue(new Set(['Volume 01']));
});

afterEach(async () => {
  await db.series_metadata.clear();
  await db.catalog_index.clear();
});

describe('facts healing from the catalog refresh', () => {
  it('schedules a series write when local facts are strictly newer than the entry', async () => {
    const catalog = catalogFile([entry('Dr Stone', '2026-08-20T00:00:00.000Z')]);
    getActiveProvider.mockReturnValue(provider(catalog, true));
    await seedLocal('Dr Stone', '2026-08-25T00:00:00.000Z');

    await refreshCatalogIndex(listing(catalog), 'webdav');

    expect(scheduleSeriesFileWrite).toHaveBeenCalledWith('Dr Stone', { fromCloudListing: true });
  });

  it('schedules a series write when the catalog lacks the series entirely', async () => {
    const catalog = catalogFile([entry('Other Series', '2026-08-20T00:00:00.000Z')]);
    getActiveProvider.mockReturnValue(provider(catalog, true));
    await seedLocal('Dr Stone', '2026-08-25T00:00:00.000Z');

    await refreshCatalogIndex(listing(catalog), 'webdav');

    expect(scheduleSeriesFileWrite).toHaveBeenCalledWith('Dr Stone', { fromCloudListing: true });
  });

  it('does not heal when the entry stamp equals or beats the local one', async () => {
    const catalog = catalogFile([
      entry('Equal', '2026-08-25T00:00:00.000Z'),
      entry('Newer', '2026-08-26T00:00:00.000Z')
    ]);
    getActiveProvider.mockReturnValue(provider(catalog, true));
    await seedLocal('Equal', '2026-08-25T00:00:00.000Z');
    await seedLocal('Newer', '2026-08-25T00:00:00.000Z');

    await refreshCatalogIndex(listing(catalog), 'webdav');

    expect(scheduleSeriesFileWrite).not.toHaveBeenCalled();
    expect(scheduleCatalogFileWrite).not.toHaveBeenCalled();
  });

  it('never heals a series the cloud holds no volumes for — facts get no folder', async () => {
    const catalog = catalogFile([entry('Other Series', '2026-08-20T00:00:00.000Z')]);
    getActiveProvider.mockReturnValue(provider(catalog, true));
    await seedLocal('Local Only', '2026-08-25T00:00:00.000Z');
    cloudVolumeTitlesFor.mockReturnValue(new Set());

    await refreshCatalogIndex(listing(catalog), 'webdav');

    expect(scheduleSeriesFileWrite).not.toHaveBeenCalled();
  });

  it('heals on a listing whose catalog stamp has NOT changed — the dropped-push case', async () => {
    const catalog = catalogFile([entry('Dr Stone', '2026-08-20T00:00:00.000Z')]);
    getActiveProvider.mockReturnValue(provider(catalog, true));

    // First refresh caches the catalog; no local facts yet, nothing to heal.
    await refreshCatalogIndex(listing(catalog), 'webdav');
    expect(scheduleSeriesFileWrite).not.toHaveBeenCalled();

    // A local edit lands... and its push is silently dropped. The cloud stamp
    // is untouched, so the next refresh takes the needs-no-refresh path — the
    // heal must still run there, off the cached copy.
    await seedLocal('Dr Stone', '2026-08-25T00:00:00.000Z');
    await refreshCatalogIndex(listing(catalog), 'webdav');

    expect(scheduleSeriesFileWrite).toHaveBeenCalledWith('Dr Stone', { fromCloudListing: true });
  });

  it('finishes by scheduling a catalog write, which is a producer-side concern', async () => {
    const catalog = catalogFile([entry('Dr Stone', '2026-08-20T00:00:00.000Z')]);
    getActiveProvider.mockReturnValue(provider(catalog, false));
    await seedLocal('Dr Stone', '2026-08-25T00:00:00.000Z');

    await refreshCatalogIndex(listing(catalog), 'webdav');

    expect(scheduleSeriesFileWrite).toHaveBeenCalledTimes(1);
    expect(scheduleCatalogFileWrite).toHaveBeenCalledTimes(1);
  });
});
