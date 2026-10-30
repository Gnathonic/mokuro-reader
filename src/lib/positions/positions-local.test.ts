import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/catalog/db', () => ({
  db: { volumes: { get: vi.fn().mockResolvedValue(undefined), bulkGet: vi.fn(async () => []) } }
}));

import {
  clearVolumes,
  deleteVolume,
  updateProgress,
  volumesWithTrash
} from '$lib/settings/volume-data';
import {
  _resetPositionTracking,
  changedVolumes,
  clearChanged,
  initPositionTracking,
  ownChangedEntries
} from './positions-local';

let stop: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-16T12:00:00.000Z'));
  localStorage.clear();
  clearVolumes();
  _resetPositionTracking();
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('positions-local', () => {
  it('a page turn marks the volume; its entry carries the record stamp and this device', () => {
    stop = initPositionTracking();
    updateProgress('v', 41, 4100, false);
    expect(changedVolumes()).toEqual(['v']);
    const e = ownChangedEntries('me').v;
    expect(e).toEqual({
      t: Date.parse(get(volumesWithTrash).v.lastProgressUpdate),
      page: 41,
      chars: 4100,
      device: 'me'
    });
  });

  it('a turn during an upload survives clearChanged', () => {
    stop = initPositionTracking();
    updateProgress('v', 41, 4100, false);
    updateProgress('w', 3, 30, false);
    const built = ownChangedEntries('me');
    vi.advanceTimersByTime(1000);
    updateProgress('v', 42, 4200, false); // lands mid-upload
    clearChanged(built);
    expect(changedVolumes()).toEqual(['v']);
  });

  it('survives a reload via localStorage', () => {
    stop = initPositionTracking();
    updateProgress('v', 41, 4100, false);
    _resetPositionTracking({ keepStorage: true });
    expect(changedVolumes()).toEqual(['v']);
  });

  it('works in memory when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    _resetPositionTracking({ keepStorage: true });
    stop = initPositionTracking();
    updateProgress('v', 41, 4100, false);
    expect(changedVolumes()).toEqual(['v']);
    clearChanged(ownChangedEntries('me'));
    expect(changedVolumes()).toEqual([]);
  });

  it('a deleted record yields no entry', () => {
    stop = initPositionTracking();
    updateProgress('v', 41, 4100, false);
    deleteVolume('v');
    expect(ownChangedEntries('me')).toEqual({});
  });

  it('a record with no stamp yields no entry', () => {
    stop = initPositionTracking();
    volumesWithTrash.set({});
    updateProgress('v', 41, 4100, false);
    volumesWithTrash.update((all) => {
      const v = all.v;
      v.lastProgressUpdate = new Date(0).toISOString();
      return { ...all };
    });
    expect(ownChangedEntries('me')).toEqual({});
  });

  it('a volume another device moved after this device marked it yields no own entry', () => {
    stop = initPositionTracking();
    updateProgress('v', 41, 4100, false);
    // A volume-data merge replaces the record with the other device's newer
    // position — no position notice, it is not this device's news.
    volumesWithTrash.update((all) => {
      all.v.progress = 120;
      all.v.lastProgressUpdate = new Date(Date.now() + 5000).toISOString();
      return { ...all };
    });
    expect(ownChangedEntries('me')).toEqual({});
    clearChanged(ownChangedEntries('me'));
    expect(changedVolumes()).toEqual([]);
  });
});
