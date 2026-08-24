import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: {
      get: vi.fn().mockResolvedValue(undefined),
      toArray: vi.fn().mockResolvedValue([])
    }
  }
}));

import {
  VolumeData,
  archiveAndResetVolumes,
  clearVolumes,
  parseVolumesFromJson,
  registerCompletionListener,
  totalStats,
  updateProgress,
  volumes
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
