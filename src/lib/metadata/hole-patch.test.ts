import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';

let progress: Record<string, { series_title?: string; deletedOn?: string }> = {};
vi.mock('$lib/settings', () => ({
  get volumes() {
    return readable(progress);
  }
}));

let localRows: Array<{ volume_uuid: string; series_title: string }> = [];
vi.mock('$lib/catalog/db', () => ({
  db: { volumes: { toArray: async () => localRows } }
}));

let indexes: Array<{ series_key: string }> = [];
vi.mock('$lib/metadata/series-index', () => ({
  listSeriesIndexes: async () => indexes
}));

const openSeries = vi.fn(async (_title: string) => {});
vi.mock('$lib/metadata/series-open', () => ({ openSeries: (t: string) => openSeries(t) }));

import { patchProgressHoles, resetHolePatchSessionForTests } from './hole-patch';

beforeEach(() => {
  vi.clearAllMocks();
  progress = {};
  localRows = [];
  indexes = [];
  resetHolePatchSessionForTests();
});

describe('patchProgressHoles', () => {
  it('pulls a series that progress references but nothing local knows', async () => {
    progress = { 'uuid-1': { series_title: 'Dr Stone' } };
    await expect(patchProgressHoles()).resolves.toEqual(['Dr Stone']);
    expect(openSeries).toHaveBeenCalledWith('Dr Stone');
  });

  it('ignores a series that already has a local row', async () => {
    progress = { 'uuid-1': { series_title: 'Dr Stone' } };
    localRows = [{ volume_uuid: 'uuid-1', series_title: 'Dr Stone' }];
    await expect(patchProgressHoles()).resolves.toEqual([]);
  });

  it('ignores a series whose index is already cached', async () => {
    progress = { 'uuid-1': { series_title: 'Dr Stone' } };
    indexes = [{ series_key: 'dr stone' }];
    await expect(patchProgressHoles()).resolves.toEqual([]);
  });

  it('ignores tombstones and records with no series title', async () => {
    progress = {
      'uuid-1': { series_title: 'Deleted', deletedOn: '2026-08-01T00:00:00.000Z' },
      'uuid-2': {},
      'uuid-3': { series_title: '   ' }
    };
    await expect(patchProgressHoles()).resolves.toEqual([]);
    expect(openSeries).not.toHaveBeenCalled();
  });

  it('de-duplicates by series and caps the run', async () => {
    progress = {
      a: { series_title: 'One' },
      b: { series_title: 'one' },
      c: { series_title: 'Two' },
      d: { series_title: 'Three' }
    };
    const pulled = await patchProgressHoles({ limit: 2 });
    expect(pulled).toHaveLength(2);
    expect(openSeries).toHaveBeenCalledTimes(2);
  });

  it('never rejects when an open fails', async () => {
    progress = { 'uuid-1': { series_title: 'Dr Stone' } };
    openSeries.mockRejectedValueOnce(new Error('offline'));
    await expect(patchProgressHoles()).resolves.toEqual([]);
  });

  it('does not re-attempt a series already tried this session, even if it is still a hole', async () => {
    // Nothing in localRows/indexes ever appears for this title — as if the
    // series is genuinely absent from the cloud (or the device is offline).
    progress = { 'uuid-1': { series_title: 'Ghost Series' } };

    await expect(patchProgressHoles()).resolves.toEqual(['Ghost Series']);
    expect(openSeries).toHaveBeenCalledTimes(1);

    // A later catalog open re-runs the patcher against the same still-dangling
    // progress record; it must not call openSeries again this session.
    await expect(patchProgressHoles()).resolves.toEqual([]);
    expect(openSeries).toHaveBeenCalledTimes(1);
  });

  it('does not count an attempt left off by the run cap against the session memory', async () => {
    progress = {
      a: { series_title: 'One' },
      b: { series_title: 'Two' }
    };
    const first = await patchProgressHoles({ limit: 1 });
    expect(first).toEqual(['One']);
    expect(openSeries).toHaveBeenCalledTimes(1);

    // 'Two' was deferred by the cap, not attempted — it must still be picked
    // up on the next run.
    const second = await patchProgressHoles({ limit: 1 });
    expect(second).toEqual(['Two']);
    expect(openSeries).toHaveBeenCalledTimes(2);
  });
});
