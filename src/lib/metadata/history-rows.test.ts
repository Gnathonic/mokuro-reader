import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
// Imported for its side effect as much as its export: the counter installs its
// `IDBDatabase.transaction` wrapper at module load, and Dexie binds that method
// once when it opens a database — so it must be in place before the Dexie
// instance below is ever used. See `idb-op-counter.ts`.
import { countIdbOps } from '$lib/catalog/__tests__/idb-op-counter';
import type { VolumeMetadata } from '$lib/types';
import type { SeriesFile, SeriesFileVolume } from './series-file';
import type { SeriesIndexRecord } from './series-index';

/**
 * A REAL Dexie over `fake-indexeddb`, not a stub.
 *
 * Everything this module's contract rests on is a property of the real thing:
 * that `primaryKeys()` reads keys without deserializing a row, that a nested
 * `db.transaction` joins its parent instead of committing separately, and that
 * `materializeSeriesVolumes`' own guards run against a real table. A hand-rolled
 * `db` double would make every one of those assertions vacuous.
 */
vi.mock('$lib/catalog/db', async () => {
  const { CatalogDexieV3 } =
    await vi.importActual<typeof import('$lib/catalog/db-v3')>('$lib/catalog/db-v3');
  return { db: new CatalogDexieV3('mokuro_v3_history_rows_test') };
});

const { progressStore } = vi.hoisted(() => {
  // `vi.mock` factories are hoisted above imports, so this store is hand-rolled
  // rather than built with svelte/store's `writable` — same constraint, and the
  // same shape, as the other suites in this codebase that mock a store.
  let value: Record<string, unknown> = {};
  const subscribers = new Set<(v: Record<string, unknown>) => void>();
  return {
    progressStore: {
      set(next: Record<string, unknown>) {
        value = next;
        subscribers.forEach((fn) => fn(value));
      },
      subscribe(fn: (v: Record<string, unknown>) => void) {
        subscribers.add(fn);
        fn(value);
        return () => subscribers.delete(fn);
      }
    }
  };
});
vi.mock('$lib/settings/volume-data', () => ({ volumes: progressStore }));

/**
 * The `.cbz` titles the cloud listing shows per series folder.
 *
 * Deliberately NOT a "return everything" stub: `materializeSeriesVolumes` gates
 * on this so a stale index cannot resurrect a deleted volume, and a double that
 * always answered yes would hold that gate permanently open and make the
 * "deleted volume is not resurrected" case below prove nothing.
 */
let listing = new Map<string, Set<string>>();
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    cloudVolumeTitlesFor: (title: string) => listing.get(title) ?? new Set<string>()
  }
}));

import { db } from '$lib/catalog/db';
import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
import {
  materializeHistoryRows,
  resetHistoryRowsSessionForTests,
  MAX_HISTORY_ROWS_PER_RUN,
  MAX_HISTORY_SERIES_PER_RUN
} from './history-rows';

function indexVolume(uuid: string, title: string, over: Partial<SeriesFileVolume> = {}) {
  return {
    volume_uuid: uuid,
    volume_title: title,
    page_count: 180,
    character_count: 12_000,
    mokuro_version: '0.2.1',
    ...over
  } satisfies SeriesFileVolume;
}

/** Cache a `series.json` for `seriesTitle` AND put its volumes in the listing. */
async function seedSeries(seriesTitle: string, volumes: SeriesFileVolume[]): Promise<void> {
  const file: SeriesFile = {
    version: 2,
    series_title: seriesTitle,
    external_ids: {},
    titles: {},
    synonyms: [],
    updated_at: '2026-08-01T00:00:00.000Z',
    volumes
  };
  const record: SeriesIndexRecord = {
    series_key: seriesTitle.trim().replace(/\s+/g, ' ').toLowerCase(),
    series_title: seriesTitle,
    file,
    source: {
      provider: 'google-drive',
      path: `${seriesTitle}/series.json`,
      size: 1,
      modifiedTime: '2026-08-01T00:00:00.000Z'
    },
    fetched_at: '2026-08-01T00:00:00.000Z'
  };
  await db.series_index.put(record);
  listing.set(seriesTitle, new Set(volumes.map((v) => v.volume_title)));
}

beforeEach(async () => {
  listing = new Map();
  progressStore.set({});
  resetHistoryRowsSessionForTests();
  await db.volumes.clear();
  await db.series_index.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('materializeHistoryRows', () => {
  it('gives a row to a volume the user only ever marked as finished', async () => {
    // The user's binding rule: "Even if we don't have page turn data or
    // recorded times, if the user has it marked-as-finished, it still counts."
    // Measured on their real library, exactly ONE of 726 qualifying entries
    // looked like this — which is precisely the record a narrower rule throws
    // away without anyone noticing.
    await seedSeries('Dr Stone', [indexVolume('uuid-finished', 'Dr Stone v01')]);
    progressStore.set({
      'uuid-finished': {
        completed: true,
        progress: 0,
        chars: 0,
        timeReadInMinutes: 0,
        recentPageTurns: [],
        sessions: [],
        archivedReads: []
      }
    });

    await expect(materializeHistoryRows()).resolves.toBe(1);

    const row = (await db.volumes.get('uuid-finished')) as VolumeMetadata;
    expect(row).toBeDefined();
    expect(row.series_title).toBe('Dr Stone');
    expect(row.volume_title).toBe('Dr Stone v01');
    expect(row.page_count).toBe(180);
    expect(row.character_count).toBe(12_000);
    expect(row.metadata_only).toBe(true);
  });

  it('resolves a legacy entry that carries no series_title at all, by uuid', async () => {
    // `series_title` is OPTIONAL on a reading-state entry and only backfilled
    // lazily on write, so entries written before that are uuid-and-nothing-else
    // forever. The uuid IS the key a `series.json` entry carries, so nothing
    // about the title is needed to place it.
    await seedSeries('Yotsuba to!', [indexVolume('uuid-legacy', 'Yotsuba to! v03')]);
    progressStore.set({ 'uuid-legacy': { progress: 42, chars: 9000 } });

    await expect(materializeHistoryRows()).resolves.toBe(1);

    const row = (await db.volumes.get('uuid-legacy')) as VolumeMetadata;
    expect(row.series_title).toBe('Yotsuba to!');
    expect(row.volume_title).toBe('Yotsuba to! v03');
  });

  it('leaves inert entries alone — and opens no write transaction for them', async () => {
    // The settings key every volume gets on import (`initializeVolume`). The
    // user's library had 1,349 of these against 726 real ones; materializing
    // them would nearly triple a table the catalog scans whole.
    await seedSeries('Dr Stone', [
      indexVolume('uuid-inert', 'Dr Stone v01'),
      indexVolume('uuid-read', 'Dr Stone v02')
    ]);
    progressStore.set({
      'uuid-inert': {
        progress: 0,
        chars: 0,
        completed: false,
        timeReadInMinutes: 0,
        recentPageTurns: [],
        sessions: [],
        archivedReads: []
      },
      'uuid-read': { chars: 500 }
    });

    await expect(materializeHistoryRows()).resolves.toBe(1);
    expect(await db.volumes.get('uuid-inert')).toBeUndefined();
    expect(await db.volumes.get('uuid-read')).toBeDefined();

    // And a run with ONLY inert entries must not even open a write
    // transaction: this sweep runs on every catalog and stats mount.
    await db.volumes.clear();
    progressStore.set({
      'uuid-inert': { progress: 0, chars: 0, completed: false, timeReadInMinutes: 0 }
    });
    const counts = await countIdbOps(async () => {
      await expect(materializeHistoryRows()).resolves.toBe(0);
    });
    expect(counts['tx.volumes.readwrite'] ?? 0).toBe(0);
  });

  it('mints metadata-only rows and never a thumbnail blob', async () => {
    // Rows carrying blobs is the exact problem the cover rearchitecture just
    // removed (11,354 rows / 417 MB). Covers are resolved per surface by cloud
    // path out of `cloud_covers`; a history row is a ROW, not a BLOB.
    await seedSeries('Dr Stone', [indexVolume('uuid-1', 'Dr Stone v01')]);
    progressStore.set({ 'uuid-1': { completed: true } });

    await materializeHistoryRows();

    const row = (await db.volumes.get('uuid-1')) as VolumeMetadata;
    expect(row.thumbnail).toBeUndefined();
    expect(row.thumbnail_width).toBeUndefined();
    expect(row.thumbnail_height).toBeUndefined();
  });

  it('does not resurrect a volume the cloud listing no longer shows', async () => {
    await seedSeries('Dr Stone', [
      indexVolume('uuid-gone', 'Dr Stone v01'),
      indexVolume('uuid-here', 'Dr Stone v02')
    ]);
    // The index is stale: v01 was deleted from the cloud.
    listing.set('Dr Stone', new Set(['Dr Stone v02']));
    progressStore.set({
      'uuid-gone': { completed: true },
      'uuid-here': { completed: true }
    });

    await expect(materializeHistoryRows()).resolves.toBe(1);
    expect(await db.volumes.get('uuid-gone')).toBeUndefined();
    expect(await db.volumes.get('uuid-here')).toBeDefined();
  });

  it('is a no-op on a second run, and reads no rows to decide that', async () => {
    await seedSeries('Dr Stone', [indexVolume('uuid-1', 'Dr Stone v01')]);
    progressStore.set({ 'uuid-1': { completed: true } });
    await expect(materializeHistoryRows()).resolves.toBe(1);

    const counts = await countIdbOps(async () => {
      await expect(materializeHistoryRows()).resolves.toBe(0);
    });
    expect(counts['tx.volumes.readwrite'] ?? 0).toBe(0);
    expect(counts['volumes.getAllKeys'] ?? 0).toBe(1);
    expect(counts['volumes.bytes'] ?? 0).toBe(0);
  });

  it('breaks a two-series uuid collision with the stored series_title', async () => {
    await seedSeries('Dr Stone', [indexVolume('uuid-dup', 'Dr Stone v01')]);
    await seedSeries('Zzz Other', [indexVolume('uuid-dup', 'Zzz Other v01')]);
    progressStore.set({ 'uuid-dup': { completed: true, series_title: 'Zzz Other' } });

    await expect(materializeHistoryRows()).resolves.toBe(1);
    const row = (await db.volumes.get('uuid-dup')) as VolumeMetadata;
    expect(row.series_title).toBe('Zzz Other');
  });

  describe('when a planned uuid cannot become a row', () => {
    it('does not let a series with no cloud listing starve a materializable one behind it', async () => {
      // The concrete case: an index cached while a DIFFERENT provider was
      // connected. `runRefresh` deliberately never cleans those, so the record
      // is in `series_index` forever while `cloudVolumeTitlesFor` reports an
      // empty folder for it forever — its batch is dropped every single run.
      await seedSeries('Aaa Stale', [indexVolume('uuid-stale', 'Aaa Stale v01')]);
      listing.delete('Aaa Stale');
      await seedSeries('Bbb Live', [indexVolume('uuid-live', 'Bbb Live v01')]);

      // Iteration order over the progress store is stable and puts the dead
      // series first, which is the whole mechanism: with one series slot per
      // run, it took that slot on every run and 'Bbb Live' never got one.
      progressStore.set({
        'uuid-stale': { completed: true },
        'uuid-live': { completed: true }
      });

      await expect(materializeHistoryRows({ seriesLimit: 1 })).resolves.toBe(0);
      expect(await db.volumes.get('uuid-live')).toBeUndefined();

      await expect(materializeHistoryRows({ seriesLimit: 1 })).resolves.toBe(1);
      expect(await db.volumes.get('uuid-live')).toBeDefined();
      // And the dead one is still dead — this is a scheduling fix, not a
      // licence to write a row the listing gate refused.
      expect(await db.volumes.get('uuid-stale')).toBeUndefined();
    });

    it('does not let a uuid `materializeSeriesVolumes` skips starve a writable one behind it', async () => {
      // Rule 2: a local row already owns 'Dr Stone v01' under a different uuid
      // (a re-OCR elsewhere, or a path-derived placeholder). The index entry is
      // skipped every run — it survives the listing gate, so this is the OTHER
      // half of the problem: the row cap is spent, not the series cap.
      await seedSeries('Dr Stone', [
        indexVolume('uuid-shadowed', 'Dr Stone v01'),
        indexVolume('uuid-writable', 'Dr Stone v02')
      ]);
      await db.volumes.put({
        volume_uuid: 'other-uuid-same-title',
        series_uuid: 'dr-stone',
        series_title: 'Dr Stone',
        volume_title: 'Dr Stone v01',
        mokuro_version: '0.2.1',
        page_count: 180,
        character_count: 12_000,
        page_char_counts: [],
        metadata_only: true
      } as VolumeMetadata);

      progressStore.set({
        'uuid-shadowed': { completed: true },
        'uuid-writable': { completed: true }
      });

      await expect(materializeHistoryRows({ limit: 1 })).resolves.toBe(0);
      expect(await db.volumes.get('uuid-writable')).toBeUndefined();

      await expect(materializeHistoryRows({ limit: 1 })).resolves.toBe(1);
      expect(await db.volumes.get('uuid-writable')).toBeDefined();
    });
  });

  describe('on a large library', () => {
    const SERIES = 12;
    const VOLUMES_PER_SERIES = 100;
    const READ_PER_SERIES = 25;

    beforeEach(async () => {
      const progress: Record<string, unknown> = {};
      for (let s = 0; s < SERIES; s++) {
        const seriesTitle = `Series ${String(s).padStart(2, '0')}`;
        const volumes: SeriesFileVolume[] = [];
        for (let v = 0; v < VOLUMES_PER_SERIES; v++) {
          const uuid = `s${s}-v${v}`;
          volumes.push(indexVolume(uuid, `${seriesTitle} v${String(v).padStart(3, '0')}`));
          // A quarter of each series was read; the rest carry the inert
          // settings key every import writes.
          progress[uuid] = v < READ_PER_SERIES ? { completed: true } : { progress: 0, chars: 0 };
        }
        await seedSeries(seriesTitle, volumes);
      }
      progressStore.set(progress);

      // Some volumes ARE installed, with real thumbnail blobs on their rows —
      // without these, "the sweep deserialized 0 bytes" would hold no matter
      // how it read the table.
      const blob = new File([new Uint8Array(64 * 1024)], 'cover.png', { type: 'image/png' });
      await db.volumes.bulkPut(
        Array.from({ length: 20 }, (_, i) => ({
          volume_uuid: `installed-${i}`,
          series_uuid: 'installed',
          series_title: 'Installed Series',
          volume_title: `Installed v${i}`,
          mokuro_version: '0.2.1',
          page_count: 1,
          character_count: 1,
          page_char_counts: [],
          thumbnail: blob
        })) as VolumeMetadata[]
      );
    });

    it('writes only the volumes with history, in ONE transaction, without reading a row', async () => {
      let created = 0;
      const counts = await countIdbOps(async () => {
        created = await materializeHistoryRows();
      });

      // Only the read quarter — not the 1,200 index entries, and not the
      // 900 inert ones.
      expect(created).toBe(SERIES * READ_PER_SERIES);
      expect(await db.volumes.count()).toBe(SERIES * READ_PER_SERIES + 20);

      // ONE readwrite transaction for twelve series. Dexie broadcasts
      // `storagemutated` once per readwrite commit, and on `volumes` that is
      // one full catalog re-derive — so a transaction per series is a
      // twelve-fold re-derive storm, which no correctness assertion can see.
      expect(counts['tx.volumes.readwrite']).toBe(1);

      // And the "does this already have a row" question was answered from
      // keys: no `getAll`, and not one byte of the 20 × 64 KB of thumbnails
      // on the installed rows was deserialized.
      expect(counts['volumes.getAllKeys'] ?? 0).toBeGreaterThanOrEqual(1);
      expect(counts['volumes.getAll'] ?? 0).toBe(0);
      expect(counts['volumes.bytes'] ?? 0).toBe(0);
    });

    it('honours the per-run cap and drains across runs', async () => {
      await expect(materializeHistoryRows({ limit: 40 })).resolves.toBe(40);
      expect(await db.volumes.count()).toBe(40 + 20);

      await expect(materializeHistoryRows({ limit: 40 })).resolves.toBe(40);
      expect(await db.volumes.count()).toBe(80 + 20);

      // Left to itself the default cap swallows the rest in one go: a sweep
      // that needed twenty page loads to finish would leave the stats views
      // wrong for most of them.
      expect(MAX_HISTORY_ROWS_PER_RUN).toBeGreaterThanOrEqual(SERIES * READ_PER_SERIES);
      await expect(materializeHistoryRows()).resolves.toBe(SERIES * READ_PER_SERIES - 80);
      await expect(materializeHistoryRows()).resolves.toBe(0);
    });

    it('bounds the SERIES a run touches, not just the rows it writes', async () => {
      // Each new series costs a `cloudVolumeTitlesFor` lookup, which on every
      // provider but Google Drive walks the whole cloud listing — twice. The
      // row cap cannot bound that; this one does.
      const listingLookups = vi.spyOn(unifiedCloudManager, 'cloudVolumeTitlesFor');

      await expect(materializeHistoryRows({ seriesLimit: 3 })).resolves.toBe(3 * READ_PER_SERIES);
      expect(listingLookups).toHaveBeenCalledTimes(3);

      // Untouched series are not lost — the next run takes the next three.
      await expect(materializeHistoryRows({ seriesLimit: 3 })).resolves.toBe(3 * READ_PER_SERIES);
      expect(MAX_HISTORY_SERIES_PER_RUN).toBeGreaterThanOrEqual(SERIES);
    });
  });
});
