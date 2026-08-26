import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$app/environment', () => ({ browser: true }));
const catalogRows = new Map<string, Record<string, unknown>>();
const bulkGet = vi.fn(async (uuids: string[]) => uuids.map((uuid) => catalogRows.get(uuid)));
const toArray = vi.fn(async () => {
  // The whole-table read this module used to do. Left in the double ON PURPOSE
  // and made loud: `enrichAllOrphanedVolumes` reads only the orphans' rows now,
  // and a silent fallback here would let a regression back to a full scan —
  // every installed volume's thumbnail blob deserialized — pass unnoticed.
  throw new Error('volumes.toArray(): the whole table must not be scanned here');
});
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: {
      get: vi.fn().mockResolvedValue(undefined),
      bulkGet: (uuids: string[]) => bulkGet(uuids),
      toArray: () => toArray()
    }
  }
}));

import {
  VolumeData,
  archiveAndResetVolumes,
  clearVolumes,
  enrichAllOrphanedVolumes,
  isOrphanedVolumeData,
  parseVolumesFromJson,
  registerCompletionListener,
  totalStats,
  updateProgress,
  volumes,
  volumesWithTrash
} from './volume-data';

describe('VolumeData.archivedReads', () => {
  it('round-trips through toJSON/fromJSON and is omitted when empty', () => {
    const empty = new VolumeData({ progress: 3 });
    expect(empty.archivedReads).toEqual([]);
    expect('archivedReads' in empty.toJSON()).toBe(false);

    const withReads = new VolumeData({
      archivedReads: [{ at: 1000, pages: 200, chars: 5000, completed: true }]
    });
    const json = withReads.toJSON();
    expect(json.archivedReads).toEqual([{ at: 1000, pages: 200, chars: 5000, completed: true }]);
    expect(VolumeData.fromJSON(JSON.stringify(json)).archivedReads).toEqual(
      withReads.archivedReads
    );
  });

  it('drops malformed archived entries', () => {
    const v = new VolumeData({
      archivedReads: [
        { at: 1, pages: 2, chars: 3, completed: false },
        { at: 'x' } as any,
        null as any
      ]
    });
    expect(v.archivedReads).toEqual([{ at: 1, pages: 2, chars: 3, completed: false }]);
  });
});

describe('archiveAndResetVolumes', () => {
  beforeEach(() => clearVolumes());

  it('archives progress/chars/completed and resets to the start, keeping stats', () => {
    updateProgress('vol-1', 200, 5000, true);
    updateProgress('vol-2', 40, 900, false);
    // simulate accumulated time + sessions on vol-1
    const before = get(volumes)['vol-1'];
    expect(before.completed).toBe(true);

    archiveAndResetVolumes(['vol-1', 'vol-2', 'vol-untouched']);

    const v1 = get(volumes)['vol-1'];
    expect(v1.progress).toBe(0);
    expect(v1.chars).toBe(0);
    expect(v1.completed).toBe(false);
    expect(v1.archivedReads).toHaveLength(1);
    expect(v1.archivedReads[0]).toMatchObject({ pages: 200, chars: 5000, completed: true });
    expect(v1.recentPageTurns.length).toBe(before.recentPageTurns.length); // history kept

    const v2 = get(volumes)['vol-2'];
    expect(v2.archivedReads[0]).toMatchObject({ pages: 40, chars: 900, completed: false });
    expect(v2.progress).toBe(0);

    expect(get(volumes)['vol-untouched']).toBeUndefined(); // never created
  });

  it('is a no-op for volumes with no progress', () => {
    updateProgress('vol-3', 0, 0, false);
    archiveAndResetVolumes(['vol-3']);
    expect(get(volumes)['vol-3'].archivedReads).toEqual([]);
  });
});

describe('registerCompletionListener', () => {
  beforeEach(() => clearVolumes());

  it('fires once on the false→true transition only', () => {
    const listener = vi.fn();
    const unregister = registerCompletionListener(listener);

    updateProgress('vol-1', 10, 100, false);
    expect(listener).not.toHaveBeenCalled();

    updateProgress('vol-1', 200, 5000, true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('vol-1');

    updateProgress('vol-1', 199, 4900, true); // still completed → no new event
    expect(listener).toHaveBeenCalledTimes(1);

    unregister();
    updateProgress('vol-1', 1, 0, false);
    updateProgress('vol-1', 200, 5000, true);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('totalStats with archived reads', () => {
  beforeEach(() => clearVolumes());

  it('keeps lifetime chars/pages after a restart', () => {
    updateProgress('vol-1', 200, 5000, true);
    const before = get(totalStats)!;
    expect(before.charsRead).toBe(5000);
    expect(before.pagesRead).toBe(200);

    archiveAndResetVolumes(['vol-1']);
    const after = get(totalStats)!;
    expect(after.charsRead).toBe(5000);
    expect(after.pagesRead).toBe(200);
    expect(after.completed).toBe(0);

    updateProgress('vol-1', 50, 1000, false); // re-reading
    expect(get(totalStats)!.charsRead).toBe(6000);
  });
});

describe('parseVolumesFromJson', () => {
  it('never turns the reserved series section into a phantom volume', () => {
    const parsed = parseVolumesFromJson(
      JSON.stringify({
        'vol-1': { progress: 3 },
        series: { 'one piece': { read_count: 2, lastUpdated: '2026-08-20T00:00:00.000Z' } }
      })
    );

    expect(Object.keys(parsed)).toEqual(['vol-1']);
  });
});

describe('isOrphanedVolumeData', () => {
  it('does not call a fully-populated record titled "Volume 3" an orphan', () => {
    // This predicate used to end in `volume_title.startsWith('Volume ')`. The
    // clause was aimed at `processVolumeSpeedData`'s display placeholder
    // (`Volume <8 hex>...`), which is never written to a reading record — what
    // it actually matched was "Volume 1", "Volume 3" and every other perfectly
    // ordinary mokuro volume title. Such a record was an orphan FOREVER, no
    // matter how complete it was, and on the stats page that meant it was
    // offered for deletion.
    expect(
      isOrphanedVolumeData(
        new VolumeData({
          series_uuid: 'series-real',
          series_title: 'Real Series',
          volume_title: 'Volume 3'
        })
      )
    ).toBe(false);
  });

  it('still catches every record that genuinely has nothing to join on', () => {
    // The negative control: dropping one clause must not have hollowed the
    // predicate out.
    const orphans = [
      new VolumeData({ series_title: 'Real Series', volume_title: 'Volume 3' }), // no uuid
      new VolumeData({
        series_uuid: 'missing-series-info',
        series_title: 'Real Series',
        volume_title: 'Volume 3'
      }),
      new VolumeData({ series_uuid: 'series-real', volume_title: 'Volume 3' }), // no series title
      new VolumeData({
        series_uuid: 'series-real',
        series_title: '[Missing Series Info]',
        volume_title: 'Volume 3'
      }),
      new VolumeData({ series_uuid: 'series-real', series_title: 'Real Series' }) // no volume title
    ];
    for (const orphan of orphans) expect(isOrphanedVolumeData(orphan)).toBe(true);
  });
});

describe('enrichAllOrphanedVolumes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    catalogRows.clear();
    clearVolumes();
  });

  it('resolves an orphan the moment a row for it exists — which is what the sweep creates', () => {
    volumesWithTrash.set({ 'uuid-swept': new VolumeData({ completed: true, chars: 5000 }) });
    expect(isOrphanedVolumeData(get(volumes)['uuid-swept'])).toBe(true);

    // The row `materializeHistoryRows` mints, mid-visit.
    catalogRows.set('uuid-swept', {
      volume_uuid: 'uuid-swept',
      series_uuid: 'series-swept',
      series_title: 'Swept Series',
      volume_title: 'Swept Series v01'
    });

    return enrichAllOrphanedVolumes().then(() => {
      const after = get(volumes)['uuid-swept'];
      expect(after.series_title).toBe('Swept Series');
      expect(after.volume_title).toBe('Swept Series v01');
      expect(isOrphanedVolumeData(after)).toBe(false);
      // Progress is carried over, not reset.
      expect(after.chars).toBe(5000);
      expect(after.completed).toBe(true);
    });
  });

  it("reads only the orphans' rows, and touches IndexedDB not at all when there are none", async () => {
    volumesWithTrash.set({
      'uuid-orphan': new VolumeData({ completed: true, chars: 1 }),
      'uuid-fine': new VolumeData({
        series_uuid: 'series-real',
        series_title: 'Real Series',
        volume_title: 'Volume 3',
        completed: true,
        chars: 1
      })
    });

    await enrichAllOrphanedVolumes();
    // Not the whole table, and not the healthy record's row either.
    expect(bulkGet).toHaveBeenCalledWith(['uuid-orphan']);

    // Nothing orphaned left (the row lookup found nothing, but the healthy
    // record was never a candidate) — so a second pass, which now runs after
    // every sweep, costs no read at all.
    bulkGet.mockClear();
    volumesWithTrash.set({ 'uuid-fine': get(volumes)['uuid-fine'] });
    await enrichAllOrphanedVolumes();
    expect(bulkGet).not.toHaveBeenCalled();
  });
});
