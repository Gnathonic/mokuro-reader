import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import {
  MAX_ENTRIES,
  _resetRemoteReadsForTests,
  noteMergedRemoteReads,
  noteRemoteRead,
  noteRemoteReads,
  remoteReads
} from './remote-reads';

const iso = (t: number) => new Date(t).toISOString();

beforeEach(() => _resetRemoteReadsForTests());

describe('remote reads', () => {
  it('keeps the newest read per volume and persists it', () => {
    noteRemoteRead('v', 2000, 'phone');
    noteRemoteRead('v', 1000, 'tablet'); // older: ignored
    expect(get(remoteReads).get('v')).toEqual({ at: 2000, device: 'phone' });
    expect(JSON.parse(localStorage.getItem('reading-history:remote-reads')!)).toEqual({
      v: [2000, 'phone']
    });
  });

  it('caps the store at the newest entries', () => {
    noteRemoteReads(
      Array.from({ length: MAX_ENTRIES + 10 }, (_, i) => ({
        volume: `v${i}`,
        at: i + 1,
        device: null
      }))
    );
    const reads = get(remoteReads);
    expect(reads.size).toBe(MAX_ENTRIES);
    expect(reads.has('v0')).toBe(false);
    expect(reads.has(`v${MAX_ENTRIES + 9}`)).toBe(true);
  });

  it('ignores junk stamps', () => {
    noteRemoteRead('v', NaN, 'phone');
    noteRemoteRead('w', 0, 'phone');
    expect(get(remoteReads).size).toBe(0);
  });

  it('a volume-data.json merge notes every record it moved to a newer stamp', () => {
    noteMergedRemoteReads(
      {
        same: { lastProgressUpdate: iso(5000) },
        older: { lastProgressUpdate: iso(9000) },
        moved: { lastProgressUpdate: iso(1000) }
      },
      {
        same: { lastProgressUpdate: iso(5000), progress: 10 },
        older: { lastProgressUpdate: iso(9000), progress: 10 },
        moved: { lastProgressUpdate: iso(7000), progress: 10 },
        fresh: { lastProgressUpdate: iso(8000), progress: 3 },
        unopened: { lastProgressUpdate: iso(8000), progress: 1 },
        gone: { lastProgressUpdate: iso(8000), progress: 4, deletedOn: iso(8000) }
      }
    );
    expect(Object.fromEntries(get(remoteReads))).toEqual({
      moved: { at: 7000, device: null },
      fresh: { at: 8000, device: null }
    });
  });
});
