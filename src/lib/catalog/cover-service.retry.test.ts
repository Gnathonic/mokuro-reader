import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';
import type { VolumeMetadata } from '$lib/types';
import type { CloudThumbnailResult } from './cloud-thumbnails';

/**
 * The retry-backoff SCHEDULE (`RETRY_DELAYS_MS` in `cover-service.ts`), under
 * fake timers — split out from `cover-service.test.ts` because real Dexie
 * (`fake-indexeddb`) hangs under `vi.useFakeTimers()`: its own internal
 * scheduling never fires once timers are faked and nothing pumps them. `db`
 * here is a plain in-memory stub (same pattern `series-backfill.test.ts`
 * uses) — everything resolves on microtasks alone, so fake timers only ever
 * advance the THINGS THIS FILE actually wants to control: `cover-service.ts`'s
 * own `sleep()` between attempts.
 */

vi.mock('$lib/util/sync/provider-manager', () => ({
  providerManager: {
    get status() {
      return readable({
        hasAnyAuthenticated: true,
        currentProviderType: 'webdav',
        providers: { webdav: { isReadOnly: false, serverCompilesMetadata: false } }
      });
    }
  }
}));

vi.mock('$lib/catalog/cover-install', () => ({
  installCoversForSeries: vi.fn(async () => 0)
}));

vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    getActiveProvider: vi.fn(() => null),
    resolveCloudFolderTitle: vi.fn((t: string) => t),
    getCloudVolumesBySeries: vi.fn(() => [])
  }
}));

vi.mock('$lib/metadata/series-file-sync', () => ({
  scheduleSeriesFileWrite: vi.fn()
}));

const { fetchCloudThumbnailMock } = vi.hoisted(() => ({
  fetchCloudThumbnailMock: vi.fn(async (_v: unknown) => null as CloudThumbnailResult | null)
}));
vi.mock('$lib/catalog/cloud-thumbnails', () => ({
  fetchCloudThumbnail: (...a: Parameters<typeof fetchCloudThumbnailMock>) =>
    fetchCloudThumbnailMock(...a),
  getCachedCloudThumbnail: vi.fn(() => undefined)
}));

const { volumeRows } = vi.hoisted(() => ({
  volumeRows: [] as VolumeMetadata[]
}));
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: {
      get: async (uuid: string) => volumeRows.find((v) => v.volume_uuid === uuid),
      // `cover-persist.ts`'s flush re-reads its whole batch with ONE keyed
      // bulk read rather than a `get` per entry.
      bulkGet: async (uuids: string[]) =>
        uuids.map((uuid) => volumeRows.find((v) => v.volume_uuid === uuid)),
      put: async (row: VolumeMetadata) => {
        volumeRows.push(row);
      },
      update: async (uuid: string, patch: Record<string, unknown>) => {
        const r = volumeRows.find((v) => v.volume_uuid === uuid);
        if (r) Object.assign(r, patch);
      }
    },
    transaction: async (_mode: string, _table: unknown, body: () => Promise<unknown>) => body()
  }
}));

// `cover-persist.ts`'s flush now consults the reading-state store
// (`$lib/settings/volume-data`) to tell a genuine relationship apart from a
// row minted purely by browsing. Hand-rolled (same pattern as
// `cover-persist.test.ts`) so `row()` below can mark itself as a
// relationship without touching real localStorage.
const readingHistory = vi.hoisted(() => {
  let value: Record<string, unknown> = {};
  const subs = new Set<(v: Record<string, unknown>) => void>();
  return {
    store: {
      subscribe(fn: (v: Record<string, unknown>) => void) {
        subs.add(fn);
        fn(value);
        return () => subs.delete(fn);
      }
    },
    set(next: Record<string, unknown>) {
      value = next;
      subs.forEach((fn) => fn(value));
    }
  };
});
vi.mock('$lib/settings/volume-data', () => ({
  volumes: readingHistory.store
}));

import { db } from '$lib/catalog/db';
import { _resetCoverPersistForTests } from './cover-persist';
import {
  _resetCoverServiceForTests,
  flushPendingCoverPersists,
  requestCover
} from './cover-service';

function coverResult(name = 'cover.webp'): CloudThumbnailResult {
  return { file: new File(['img'], name, { type: 'image/webp' }), width: 210, height: 297 };
}

/** A row this device has a RELATIONSHIP with — see the mock above. */
function row(uuid: string, overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
  readingHistory.set({ [uuid]: { progress: 1 } });
  return {
    volume_uuid: uuid,
    series_uuid: 's',
    series_title: 'One Piece',
    volume_title: 'Volume 01',
    mokuro_version: '0.4.11',
    page_count: 5,
    character_count: 50,
    page_char_counts: [50],
    metadata_only: true,
    cloudThumbnailFileId: 'c-1',
    ...overrides
  } as VolumeMetadata;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetCoverServiceForTests();
  _resetCoverPersistForTests();
  volumeRows.length = 0;
  readingHistory.set({});
});

afterEach(() => {
  _resetCoverPersistForTests();
  vi.useRealTimers();
});

describe('retry: a fetch that produces nothing is never permanently settled', () => {
  it('retries on the 0/2000/8000ms backoff when fetchCloudThumbnail returns null, and eventually delivers', async () => {
    // `fetchCloudThumbnail` never throws — a saturated provider or a timeout
    // both surface as `null` (see `cloud-thumbnails.ts`). Treating that as
    // "settled forever" is exactly the "no covers until I navigate away and
    // back" regression this schedule exists to prevent.
    await db.volumes.put(row('v-1'));
    fetchCloudThumbnailMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(coverResult());

    vi.useFakeTimers();
    requestCover(row('v-1'));

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCloudThumbnailMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchCloudThumbnailMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(8000);
    expect(fetchCloudThumbnailMock).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
    await flushPendingCoverPersists();
    const persisted = (await db.volumes.get('v-1')) as VolumeMetadata;
    expect(persisted.thumbnail_width).toBe(210);
  });

  it('gives up quietly after exhausting the schedule, but a LATER request tries again fresh', async () => {
    await db.volumes.put(row('v-1'));
    fetchCloudThumbnailMock.mockResolvedValue(null); // never succeeds during the first cycle

    vi.useFakeTimers();
    requestCover(row('v-1'));
    await vi.advanceTimersByTimeAsync(11000); // the whole 0/2000/8000 schedule
    expect(fetchCloudThumbnailMock).toHaveBeenCalledTimes(3);

    // Not blacklisted: a fresh call (any re-render) starts a new attempt cycle.
    fetchCloudThumbnailMock.mockResolvedValue(coverResult());
    requestCover(row('v-1'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCloudThumbnailMock).toHaveBeenCalledTimes(4);

    vi.useRealTimers();
    await flushPendingCoverPersists();
    const persisted = (await db.volumes.get('v-1')) as VolumeMetadata;
    expect(persisted.thumbnail_width).toBe(210);
  });
});
