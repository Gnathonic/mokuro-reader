import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  adoptPosition,
  applyMissedRestart,
  archiveAndResetVolumes,
  jumpToPosition,
  markVolumeAsUnread,
  registerPositionListener,
  clearVolumes,
  deleteVolume,
  initializeVolume,
  enrichAllOrphanedVolumes,
  isOrphanedVolumeData,
  parseVolumesFromJson,
  registerCompletionHold,
  projectedTurnsOf,
  registerCompletionListener,
  releaseHeldCompletion,
  restoreVolumePosition,
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

describe('VolumeData.completedAt', () => {
  beforeEach(() => {
    clearVolumes();
  });

  it('round-trips through toJSON/fromJSON and is omitted when absent', () => {
    expect('completedAt' in new VolumeData({ progress: 3 }).toJSON()).toBe(false);

    const stamp = '2026-03-04T05:06:07.000Z';
    const json = new VolumeData({ completed: true, completedAt: stamp }).toJSON();
    expect(json.completedAt).toBe(stamp);
    expect(VolumeData.fromJSON(JSON.stringify(json)).completedAt).toBe(stamp);
  });

  it('drops an unparseable stamp instead of carrying an Invalid Date into a goal period', () => {
    expect(new VolumeData({ completedAt: 'last tuesday' as string }).completedAt).toBeUndefined();
    expect(new VolumeData({ completedAt: 42 as unknown as string }).completedAt).toBeUndefined();
  });

  it('dates a SECOND reading, so a re-read counts toward the new period', async () => {
    const { _resetHistoryTurns, _setHistoryTurnsForTest } = await import(
      '$lib/reading-history/turns-store'
    );
    vi.useFakeTimers();
    try {
      // Write-once meant a volume finished in 2025, paged back to the start and
      // read cover to cover again in 2026 kept its 2025 date: the 2026 goal never
      // counted it, and `bucketVolumes` dropped it from every section too,
      // because it IS finished — just not in this period.
      vi.setSystemTime(new Date('2025-06-01T00:00:00.000Z'));
      updateProgress('vol-1', 100, 5000, true);
      expect(get(volumes)['vol-1'].completedAt).toBe('2025-06-01T00:00:00.000Z');

      // Page back to the start: the flag falls, the date stays.
      vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'));
      updateProgress('vol-1', 1, 5000);
      expect(get(volumes)['vol-1'].completedAt).toBe('2025-06-01T00:00:00.000Z');
      // The reader records that view of page 1 in reading history.
      _setHistoryTurnsForTest(
        new Map([['vol-1', [[Date.parse('2026-03-01T00:00:00.000Z'), 1, 50]]]])
      );

      // Read it through again: a second completion gets its own date, in the
      // period it actually happened in.
      vi.setSystemTime(new Date('2026-03-20T00:00:00.000Z'));
      updateProgress('vol-1', 100, 6000, true);
      expect(get(volumes)['vol-1'].completedAt).toBe('2026-03-20T00:00:00.000Z');
    } finally {
      vi.useRealTimers();
      _resetHistoryTurns();
    }
  });

  it('does NOT re-date when the flag merely dips and rises near the end', () => {
    // The flag falls on any page below the last-page window, on the
    // reader-settings page input and on toggleHasCover. Treating a bare
    // false->true edge as a new completion meant "tap back twice, forward
    // once" in a volume finished last year re-dated it into this year's goal.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2025-06-01T00:00:00.000Z'));
      updateProgress('vol-1', 100, 5000, true);
      const original = get(volumes)['vol-1'].completedAt;

      vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'));
      updateProgress('vol-1', 99, 5000, true); // still inside the last-page window
      updateProgress('vol-1', 98, 5000); // flag falls
      updateProgress('vol-1', 99, 5000, true); // and rises again

      expect(get(volumes)['vol-1'].completedAt).toBe(original);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is stamped once at the false->true edge and does not move afterwards', () => {
    updateProgress('vol-1', 100, 5000, true);
    const first = get(volumes)['vol-1'].completedAt;
    expect(first).toBeTruthy();

    // Re-reporting completion (the reader calls updateProgress on every page
    // change) must not walk the date forward.
    updateProgress('vol-1', 100, 5000, true);
    expect(get(volumes)['vol-1'].completedAt).toBe(first);
  });

  it('survives a `completed: false` write, because the default means "caller said nothing"', () => {
    // `toggleHasCover` and the reader-settings page input both call
    // updateProgress without the flag; neither means "un-read this volume".
    updateProgress('vol-1', 100, 5000, true);
    const stamp = get(volumes)['vol-1'].completedAt;

    updateProgress('vol-1', 42, 5000);
    expect(get(volumes)['vol-1'].completed).toBe(false);
    expect(get(volumes)['vol-1'].completedAt).toBe(stamp);
  });

  it('is cleared by the explicit un-read', async () => {
    const { markVolumeAsUnread } = await import('./volume-data');
    updateProgress('vol-1', 100, 5000, true);
    expect(get(volumes)['vol-1'].completedAt).toBeTruthy();

    markVolumeAsUnread('vol-1');
    expect(get(volumes)['vol-1'].completedAt).toBeUndefined();
  });

  it('rides onto the archived pass on restart, so past periods keep counting it', () => {
    updateProgress('vol-1', 100, 5000, true);
    const stamp = get(volumes)['vol-1'].completedAt;

    archiveAndResetVolumes(['vol-1']);

    const after = get(volumes)['vol-1'];
    expect(after.completedAt).toBeUndefined();
    expect(after.progress).toBe(0);
    expect(after.archivedReads).toHaveLength(1);
    // `at` is when restart was pressed; `completedAt` is when the pass finished.
    expect(after.archivedReads[0].completed).toBe(true);
    expect(after.archivedReads[0].completedAt).toBe(stamp);
  });

  it('is not carried on a delete tombstone', async () => {
    const { deleteVolume } = await import('./volume-data');
    updateProgress('vol-1', 100, 5000, true);
    deleteVolume('vol-1');

    const tombstone = get(volumesWithTrash)['vol-1'];
    expect(tombstone.deletedOn).toBeTruthy();
    expect(tombstone.completedAt).toBeUndefined();
  });
});

describe('VolumeData.settings.ocrLayer', () => {
  it('round-trips a string layer id and drops anything else', () => {
    const v = new VolumeData({ settings: { ocrLayer: 'gcv' } });
    expect(v.settings.ocrLayer).toBe('gcv');
    expect(VolumeData.fromJSON(JSON.stringify(v)).settings.ocrLayer).toBe('gcv');
    expect(
      new VolumeData({ settings: { ocrLayer: 3 as unknown as string } }).settings.ocrLayer
    ).toBeUndefined();
    expect(new VolumeData({}).toJSON().settings).toBeUndefined();
  });
});

describe('VolumeData.forgotAt', () => {
  beforeEach(() => clearVolumes());

  it('round-trips through the synced JSON', () => {
    const json = new VolumeData({ forgotAt: '2026-10-05T18:00:00.000Z' }).toJSON();
    expect(json.forgotAt).toBe('2026-10-05T18:00:00.000Z');
    expect(new VolumeData(json).forgotAt).toBe('2026-10-05T18:00:00.000Z');
  });

  it('drops a junk value', () => {
    expect(new VolumeData({ forgotAt: 'not a date' }).forgotAt).toBeUndefined();
    expect(new VolumeData({}).toJSON()).not.toHaveProperty('forgotAt');
  });

  it('opening a volume whose stats were forgotten remembers when', () => {
    updateProgress('vol-f', 40, 4000);
    deleteVolume('vol-f');
    const deletedOn = get(volumesWithTrash)['vol-f'].deletedOn;

    initializeVolume('vol-f');

    const record = get(volumesWithTrash)['vol-f'];
    expect(record.deletedOn).toBeUndefined();
    expect(record.forgotAt).toBe(deletedOn);
  });

  it('a later forget moves the horizon on; reading never clears it', () => {
    initializeVolume('vol-g');
    expect(get(volumesWithTrash)['vol-g'].forgotAt).toBeUndefined();
    updateProgress('vol-g', 3, 30);
    deleteVolume('vol-g');
    initializeVolume('vol-g');
    const horizon = get(volumesWithTrash)['vol-g'].forgotAt;
    expect(horizon).toBeDefined();
    updateProgress('vol-g', 4, 40);
    expect(get(volumesWithTrash)['vol-g'].forgotAt).toBe(horizon);
  });
});

describe('page turns after the cut-over', () => {
  beforeEach(async () => {
    clearVolumes();
    const { _resetHistoryTurns } = await import('$lib/reading-history/turns-store');
    _resetHistoryTurns();
  });

  it('a page turn no longer grows the record', () => {
    volumesWithTrash.set({
      v: new VolumeData({
        progress: 2,
        recentPageTurns: [
          [1, 1, 10],
          [2, 2, 20]
        ]
      })
    });
    updateProgress('v', 3, 30);
    expect(get(volumesWithTrash).v.recentPageTurns).toHaveLength(2);
    expect(get(volumesWithTrash).v.progress).toBe(3);
  });

  it('stats read projected turns once loaded; the stored record keeps its own', async () => {
    const { _setHistoryTurnsForTest } = await import('$lib/reading-history/turns-store');
    volumesWithTrash.set({ v: new VolumeData({ progress: 2 }) });
    _setHistoryTurnsForTest(
      new Map([
        [
          'v',
          [
            [1, 1, 10],
            [2, 2, 20]
          ]
        ]
      ])
    );
    expect(get(volumes).v.recentPageTurns).toEqual([
      [1, 1, 10],
      [2, 2, 20]
    ]);
    expect(get(volumesWithTrash).v.recentPageTurns).toEqual([]);
  });

  it("a record's unconverted turns count beside the projection (another device's, merged from the file)", async () => {
    const { _setHistoryTurnsForTest } = await import('$lib/reading-history/turns-store');
    volumesWithTrash.set({
      v: new VolumeData({
        progress: 9,
        recentPageTurns: [
          [2, 2] as never, // the same turn as the projection's, without chars
          [9, 9, 90]
        ]
      })
    });
    _setHistoryTurnsForTest(
      new Map([
        [
          'v',
          [
            [1, 1, 10],
            [2, 2, 20]
          ]
        ]
      ])
    );
    expect(get(volumes).v.recentPageTurns).toEqual([
      [1, 1, 10],
      [2, 2, 20],
      [9, 9, 90]
    ]);
    expect(projectedTurnsOf('v', get(volumesWithTrash).v)).toEqual([
      [1, 1, 10],
      [2, 2, 20],
      [9, 9, 90]
    ]);
    expect(get(volumesWithTrash).v.recentPageTurns).toEqual([
      [2, 2],
      [9, 9, 90]
    ]);
  });

  it('keeps record identity across emissions when the record holds turns too', async () => {
    const { _setHistoryTurnsForTest } = await import('$lib/reading-history/turns-store');
    volumesWithTrash.set({
      v: new VolumeData({ progress: 9, recentPageTurns: [[9, 9, 90]] }),
      w: new VolumeData({ progress: 1 })
    });
    _setHistoryTurnsForTest(new Map([['v', [[1, 1, 10]] as [number, number, number][]]]));
    const first = get(volumes).v;
    expect(first.recentPageTurns).toEqual([
      [1, 1, 10],
      [9, 9, 90]
    ]);
    volumesWithTrash.update((all) => ({ ...all, w: new VolumeData({ progress: 2 }) }));
    expect(get(volumes).v).toBe(first);
  });

  it("before history loads, or for a volume it has nothing for, the record's own turns stand", async () => {
    volumesWithTrash.set({ v: new VolumeData({ progress: 2, recentPageTurns: [[9, 9, 90]] }) });
    expect(get(volumes).v.recentPageTurns).toEqual([[9, 9, 90]]);
    const { _setHistoryTurnsForTest } = await import('$lib/reading-history/turns-store');
    _setHistoryTurnsForTest(new Map([['other', [[1, 1, 1]]]]));
    expect(get(volumes).v.recentPageTurns).toEqual([[9, 9, 90]]);
  });

  it('keeps record identity across emissions when nothing about it changed', async () => {
    const { _setHistoryTurnsForTest } = await import('$lib/reading-history/turns-store');
    const turns = new Map([['v', [[1, 1, 10]] as [number, number, number][]]]);
    volumesWithTrash.set({
      v: new VolumeData({ progress: 1 }),
      w: new VolumeData({ progress: 1 })
    });
    _setHistoryTurnsForTest(turns);
    const first = get(volumes).v;
    volumesWithTrash.update((all) => ({ ...all, w: new VolumeData({ progress: 2 }) }));
    expect(get(volumes).v).toBe(first);
  });

  it('a re-read is re-dated from projected turns alone', async () => {
    const { _setHistoryTurnsForTest } = await import('$lib/reading-history/turns-store');
    const done = '2026-01-01T00:00:00.000Z';
    volumesWithTrash.set({
      v: new VolumeData({ progress: 3, completed: false, completedAt: done })
    });
    const now = Date.now();
    _setHistoryTurnsForTest(new Map([['v', [[now - 5000, 1, 10]]]]));
    updateProgress('v', 10, 100, true);
    expect(get(volumesWithTrash).v.completedAt).not.toBe(done);
  });

  it('a localStorage write that throws (quota) never breaks a store update', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => updateProgress('q', 1, 1)).not.toThrow();
    spy.mockRestore();
    warn.mockRestore();
  });

  it("a record's forget horizon hides earlier projected turns (forgets older than history events)", async () => {
    const { _setHistoryTurnsForTest } = await import('$lib/reading-history/turns-store');
    volumesWithTrash.set({
      v: new VolumeData({ progress: 2, forgotAt: new Date(5000).toISOString() })
    });
    _setHistoryTurnsForTest(
      new Map([
        [
          'v',
          [
            [1000, 1, 10],
            [6000, 2, 20]
          ]
        ]
      ])
    );
    expect(get(volumes).v.recentPageTurns).toEqual([[6000, 2, 20]]);
  });
});

describe('cross-device position writers', () => {
  beforeEach(() => clearVolumes());

  it('jumpToPosition moves the position, wins the next merge, and fires no completion', async () => {
    const { jumpToPosition, registerCompletionListener } = await import('./volume-data');
    const heard: string[] = [];
    const stop = registerCompletionListener((id: string) => heard.push(id));
    volumesWithTrash.set({
      v: new VolumeData({
        progress: 41,
        chars: 410,
        lastProgressUpdate: '2026-01-01T00:00:00.000Z'
      })
    });
    jumpToPosition('v', 120, 1200, true, Date.UTC(2026, 2, 5));
    const r = get(volumesWithTrash).v;
    expect(r).toMatchObject({ progress: 120, chars: 1200, completed: true });
    expect(Date.parse(r.lastProgressUpdate)).toBeGreaterThan(
      Date.parse('2026-01-01T00:00:00.000Z')
    );
    // Dated when that reading finished, not when the jump happened.
    expect(r.completedAt).toBe(new Date(Date.UTC(2026, 2, 5)).toISOString());
    expect(heard).toEqual([]);
    stop?.();
  });

  it('applyMissedRestart resets the position and archives the missed pass at the given stamp', async () => {
    const { applyMissedRestart } = await import('./volume-data');
    volumesWithTrash.set({
      v: new VolumeData({
        progress: 61,
        chars: 610,
        completed: true,
        completedAt: '2026-01-01T00:00:00.000Z',
        archivedReads: [{ at: 5000, pages: 200, chars: 2000, completed: true }],
        lastProgressUpdate: '2026-01-01T00:00:00.000Z'
      })
    });
    applyMissedRestart('v', 11_000);
    const r = get(volumesWithTrash).v;
    expect(r).toMatchObject({ progress: 0, chars: 0, completed: false });
    expect(r.completedAt).toBeUndefined();
    // This device's own pass (read without seeing the restart) is archived,
    // with its completion date, so goal credit survives. Its stamp is the
    // missed reading's own (not this device's clock), so every device that
    // re-applies the same restart archives the pass under ONE key and the
    // merge keeps it once.
    expect(r.archivedReads).toEqual([
      { at: 5000, pages: 200, chars: 2000, completed: true },
      {
        at: 11_000,
        pages: 61,
        chars: 610,
        completed: true,
        completedAt: '2026-01-01T00:00:00.000Z'
      }
    ]);
    expect(Date.parse(r.lastProgressUpdate)).toBeGreaterThan(
      Date.parse('2026-01-01T00:00:00.000Z')
    );
  });

  it('applyMissedRestart replaces an archive already made under the same stamp', async () => {
    const { applyMissedRestart } = await import('./volume-data');
    volumesWithTrash.set({
      v: new VolumeData({
        progress: 70,
        chars: 700,
        archivedReads: [
          { at: 5000, pages: 200, chars: 2000, completed: true },
          { at: 11_000, pages: 61, chars: 610, completed: false }
        ]
      })
    });
    applyMissedRestart('v', 11_000);
    expect(get(volumesWithTrash).v.archivedReads).toEqual([
      { at: 5000, pages: 200, chars: 2000, completed: true },
      { at: 11_000, pages: 70, chars: 700, completed: false }
    ]);
  });
});

describe('VolumeData legacyStats', () => {
  it('round-trips a valid snapshot and drops a malformed one', () => {
    const snap = { time_ms: 60_000, chars: 5, before: 1_700_000_000_000 };
    const ok = new VolumeData({ legacyStats: snap });
    expect(ok.legacyStats).toEqual(snap);
    expect(JSON.parse(JSON.stringify(ok)).legacyStats).toEqual(snap);
    const zero = { time_ms: 0, chars: 0, before: 5 };
    expect(JSON.parse(JSON.stringify(new VolumeData({ legacyStats: zero }))).legacyStats).toEqual(
      zero
    );
    for (const bad of [
      { time_ms: -1, chars: 0, before: 5 },
      { time_ms: 1, chars: 'x', before: 5 },
      { time_ms: 1, chars: 1 }
    ]) {
      expect(new VolumeData({ legacyStats: bad } as never).legacyStats).toBeUndefined();
    }
  });
});

describe('parseVolumesFromJson reserved sections', () => {
  it('never reads the tracking section as a volume', () => {
    const parsed = parseVolumesFromJson(
      JSON.stringify({ 'vol-1': { progress: 2 }, tracking: { idle: { lastUpdated: 'x' } } })
    );
    expect(Object.keys(parsed)).toEqual(['vol-1']);
  });
});

describe('position stamps (positions.json)', () => {
  beforeEach(() => {
    clearVolumes();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-16T12:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('re-reporting the current page changes nothing and stamps nothing', () => {
    updateProgress('v', 40, 4000, false);
    const before = get(volumesWithTrash).v.lastProgressUpdate;
    vi.advanceTimersByTime(60_000);
    updateProgress('v', 40, 4000, false);
    expect(get(volumesWithTrash).v.lastProgressUpdate).toBe(before);
    // chars omitted = "unchanged", the same as passing the current value.
    updateProgress('v', 40, undefined, false);
    expect(get(volumesWithTrash).v.lastProgressUpdate).toBe(before);
  });

  it('opening a volume that has no position yet stamps none', () => {
    initializeVolume('fresh');
    updateProgress('fresh', 0, 0, false);
    expect(get(volumesWithTrash).fresh.lastProgressUpdate).toBe(new Date(0).toISOString());
  });

  it('a real page turn stamps and notifies', () => {
    updateProgress('v', 40, 4000, false);
    const seen: string[] = [];
    const stop = registerPositionListener((v) => seen.push(v));
    vi.advanceTimersByTime(1000);
    updateProgress('v', 40, 4000, false); // no-op: no notice
    updateProgress('v', 41, 4100, false);
    expect(seen).toEqual(['v']);
    stop();
  });

  it('archiveAndResetVolumes notifies once per reset volume', () => {
    updateProgress('w', 3, 30, false);
    updateProgress('z', 0, 0, false);
    const seen: string[] = [];
    const stop = registerPositionListener((v) => seen.push(v));
    archiveAndResetVolumes(['w', 'z', 'missing']);
    expect(seen).toEqual(['w']);
    stop();
  });

  it('jumpToPosition and applyMissedRestart each notify once', () => {
    updateProgress('v', 40, 4000, false);
    const seen: string[] = [];
    const stop = registerPositionListener((v) => seen.push(v));
    jumpToPosition('v', 50, 5000, false);
    applyMissedRestart('v', 11_000);
    expect(seen).toEqual(['v', 'v']);
    stop();
  });

  it('markVolumeAsUnread notifies', () => {
    updateProgress('v', 40, 4000, true);
    const seen: string[] = [];
    const stop = registerPositionListener((v) => seen.push(v));
    markVolumeAsUnread('v');
    expect(seen).toContain('v');
    stop();
  });

  it('adoptPosition takes the remote stamp, only when newer', () => {
    updateProgress('v', 40, 4000, false);
    const local = Date.parse(get(volumesWithTrash).v.lastProgressUpdate!);
    expect(adoptPosition('v', 120, 12000, false, local - 1)).toBe(false);
    expect(adoptPosition('v', 120, 12000, false, local)).toBe(false);
    expect(get(volumesWithTrash).v.progress).toBe(40);
    expect(adoptPosition('v', 120, 12000, false, local + 1)).toBe(true);
    expect(get(volumesWithTrash).v).toMatchObject({
      progress: 120,
      chars: 12000,
      lastProgressUpdate: new Date(local + 1).toISOString()
    });
  });

  it('the same page with other chars (an adopted figure) stamps nothing and keeps the stored chars', () => {
    // The page input set to the page already shown, or the scroll reader's
    // edge nav at the last page: this device turned nothing, so it must not
    // become the newest reader just because its own count of the characters
    // up to that page differs from the one the other device stored.
    updateProgress('v', 40, 4000, false);
    const remote = Date.parse(get(volumesWithTrash).v.lastProgressUpdate!) + 1000;
    expect(adoptPosition('v', 60, 18_000, false, remote)).toBe(true);
    vi.advanceTimersByTime(60_000);
    const seen: string[] = [];
    const stop = registerPositionListener((v) => seen.push(v));
    updateProgress('v', 60, 6000, false);
    stop();
    expect(get(volumesWithTrash).v).toMatchObject({
      progress: 60,
      chars: 18_000,
      lastProgressUpdate: new Date(remote).toISOString()
    });
    expect(seen).toEqual([]);
    // Completing on that page IS a change.
    updateProgress('v', 60, 6000, true);
    expect(get(volumesWithTrash).v.completed).toBe(true);
    expect(get(volumesWithTrash).v.lastProgressUpdate).not.toBe(new Date(remote).toISOString());
  });

  it('adoptPosition creates a record for a volume this device never opened', () => {
    expect(adoptPosition('n', 7, 70, undefined, 1000)).toBe(true);
    expect(get(volumesWithTrash).n).toMatchObject({ progress: 7, chars: 70 });
  });

  it('adoptPosition refuses a deleted record', () => {
    updateProgress('v', 40, 4000, false);
    deleteVolume('v');
    expect(adoptPosition('v', 120, 12000, false, Date.now() + 1000)).toBe(false);
    expect(get(volumesWithTrash).v.progress).not.toBe(120);
  });

  it('adoptPosition does not notify', () => {
    const seen: string[] = [];
    const stop = registerPositionListener((v) => seen.push(v));
    adoptPosition('v', 120, 12000, false, Date.now());
    expect(seen).toEqual([]);
    stop();
  });

  it('adoptPosition completed: undefined keeps the flag; true dates completedAt at setAt when absent', () => {
    updateProgress('v', 200, 9000, true);
    const at = Date.now() + 1000;
    expect(adoptPosition('v', 199, 8900, undefined, at)).toBe(true);
    expect(get(volumesWithTrash).v.completed).toBe(true);

    updateProgress('u', 10, 100, false);
    const later = Date.now() + 2000;
    expect(adoptPosition('u', 200, 9000, true, later)).toBe(true);
    expect(get(volumesWithTrash).u).toMatchObject({
      completed: true,
      completedAt: new Date(later).toISOString()
    });
  });
});

describe('held completions and restores (look-up visits)', () => {
  let heard: string[];
  let stops: Array<() => void>;
  beforeEach(() => {
    clearVolumes();
    heard = [];
    stops = [registerCompletionListener((id) => heard.push(id))];
  });
  afterEach(() => stops.forEach((stop) => stop()));

  it('a held completion is announced once at release, if still completed', () => {
    stops.push(registerCompletionHold((volume) => volume === 'v'));
    updateProgress('v', 200, 5000, true);
    expect(heard).toEqual([]);
    expect(get(volumesWithTrash).v.completed).toBe(true);
    releaseHeldCompletion('v');
    expect(heard).toEqual(['v']);
  });

  it('a held completion whose flag fell before release is never announced', () => {
    stops.push(registerCompletionHold(() => true));
    updateProgress('v', 200, 5000, true);
    updateProgress('v', 150, 4000, false);
    releaseHeldCompletion('v');
    expect(heard).toEqual([]);
  });

  it('releasing twice announces once (hidden, then closed)', () => {
    stops.push(registerCompletionHold(() => true));
    updateProgress('v', 200, 5000, true);
    releaseHeldCompletion('v');
    releaseHeldCompletion('v');
    expect(heard).toEqual(['v']);
  });

  it('the flag falling and rising again within one hold is one notice', () => {
    stops.push(registerCompletionHold(() => true));
    updateProgress('v', 200, 5000, true);
    updateProgress('v', 199, 4900, false);
    updateProgress('v', 200, 5000, true);
    releaseHeldCompletion('v');
    expect(heard).toEqual(['v']);
  });

  it('no hold registered → completion announced at once, as today', () => {
    updateProgress('v', 200, 5000, true);
    expect(heard).toEqual(['v']);
  });

  it('restoreVolumePosition puts values and stamp back; announce controls the position notice; deletedOn → false', () => {
    const moved: string[] = [];
    stops.push(registerPositionListener((id) => moved.push(id)));
    updateProgress('v', 41, 4100, false);
    moved.length = 0;
    const stamp = Date.parse('2026-10-01T00:00:00.000Z');
    expect(
      restoreVolumePosition('v', { progress: 40, chars: 4000, completed: false }, stamp, {
        announce: false
      })
    ).toBe(true);
    const record = get(volumesWithTrash).v;
    expect([record.progress, record.chars, record.completed]).toEqual([40, 4000, false]);
    expect(record.lastProgressUpdate).toBe('2026-10-01T00:00:00.000Z');
    expect(moved).toEqual([]);

    const done = '2026-09-01T00:00:00.000Z';
    restoreVolumePosition(
      'v',
      { progress: 200, chars: 5000, completed: true, completedAt: done },
      stamp + 1,
      { announce: true }
    );
    expect(get(volumesWithTrash).v.completedAt).toBe(done);
    expect(moved).toEqual(['v']);

    // 0 = "never": the epoch, as an untouched record has.
    restoreVolumePosition('v', { progress: 0, chars: 0, completed: false }, 0, { announce: false });
    expect(get(volumesWithTrash).v.lastProgressUpdate).toBe(new Date(0).toISOString());
    expect(get(volumesWithTrash).v.completedAt).toBeUndefined();

    expect(
      restoreVolumePosition('missing', { progress: 1, chars: 0, completed: false }, 0, {
        announce: false
      })
    ).toBe(false);
    expect(get(volumesWithTrash).missing).toBeUndefined();
    deleteVolume('v');
    expect(
      restoreVolumePosition('v', { progress: 40, chars: 4000, completed: false }, stamp, {
        announce: false
      })
    ).toBe(false);
  });

  it('a restore drops a held completion: a look-up from the last page of a finished volume announces nothing', () => {
    stops.push(registerCompletionHold(() => true));
    const done = '2026-09-01T00:00:00.000Z';
    restoreVolumePosition(
      'v',
      { progress: 200, chars: 5000, completed: true, completedAt: done },
      1000,
      { announce: false }
    );
    updateProgress('v', 199, 4900, false); // paged back…
    updateProgress('v', 200, 5000, true); // …and home: the flag rose again
    restoreVolumePosition(
      'v',
      { progress: 200, chars: 5000, completed: true, completedAt: done },
      1000,
      { announce: false }
    );
    releaseHeldCompletion('v');
    expect(heard).toEqual([]);
  });
});
