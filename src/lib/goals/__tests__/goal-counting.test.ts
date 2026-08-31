import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/catalog/db', () => ({
  db: { volumes: { get: vi.fn().mockResolvedValue(undefined), bulkGet: vi.fn(async () => []) } }
}));

import { VolumeData } from '$lib/settings/volume-data';
import { isCompletedInPeriod, partialProgressInPeriod } from '../goal-counting';
import { mergeSnapshotEntries, type GoalSnapshotEntry } from '../goals-file';

const START = new Date(2026, 0, 1);
const END = new Date(2027, 0, 1);
const NOW = new Date(2026, 7, 30).getTime();

describe('isCompletedInPeriod', () => {
  it('counts a volume ONCE however many times it was finished in the period', () => {
    // The live header used to count EVENTS while the snapshot and the Completed
    // list counted VOLUMES, so a series read twice in a year showed 20 in the
    // header over 10 cards — and then dropped to 10 permanently the moment the
    // period closed and the header switched to the snapshot.
    const twice = new VolumeData({
      completed: true,
      completedAt: '2026-11-01T00:00:00.000Z',
      archivedReads: [
        {
          at: new Date(2026, 5, 1).getTime(),
          pages: 200,
          chars: 5000,
          completed: true,
          completedAt: '2026-02-01T00:00:00.000Z'
        }
      ]
    });

    expect(isCompletedInPeriod(twice, START, END, NOW)).toBe(true);
    // A boolean, not a count — that IS the guarantee.
    expect(typeof isCompletedInPeriod(twice, START, END, NOW)).toBe('boolean');
  });

  it('is false when every completion falls outside the period', () => {
    const lastYear = new VolumeData({ completed: true, completedAt: '2025-06-01T00:00:00.000Z' });
    expect(isCompletedInPeriod(lastYear, START, END, NOW)).toBe(false);
  });
});

describe('partialProgressInPeriod', () => {
  const turnsIn2026 = [
    [new Date(2026, 2, 1).getTime(), 10, 100],
    [new Date(2026, 2, 2).getTime(), 20, 200]
  ] as [number, number, number][];

  it('grants credit for an unfinished volume read inside the period', () => {
    const partway = new VolumeData({ progress: 20, recentPageTurns: turnsIn2026 });
    expect(partialProgressInPeriod(partway, 200, START, END)).toBeGreaterThan(0);
  });

  it('grants nothing while the volume sits finished at the end of the period', () => {
    // `bucketVolumes` puts a finished volume in no section, so credit here
    // would show in the header with nothing on screen accounting for it.
    // `progress` tracks the last turn — a fixture where they disagree is not a
    // state `updateProgress` can produce.
    const finishedAndIdle = new VolumeData({
      progress: 199,
      completed: true,
      completedAt: '2025-06-01T00:00:00.000Z',
      recentPageTurns: [
        [new Date(2026, 2, 1).getTime(), 198, 1980],
        [new Date(2026, 2, 2).getTime(), 199, 1990]
      ]
    });
    expect(partialProgressInPeriod(finishedAndIdle, 200, START, END)).toBe(0);
  });

  it('grants nothing when the volume length is unknown', () => {
    const cloudOnly = new VolumeData({ progress: 20, recentPageTurns: turnsIn2026 });
    expect(partialProgressInPeriod(cloudOnly, 0, START, END)).toBe(0);
  });
});

describe('mergeSnapshotEntries — completion beats a fraction', () => {
  const snap = (over: Partial<GoalSnapshotEntry> = {}): GoalSnapshotEntry => ({
    goalType: 'year',
    periodKey: '2026',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    closedAt: '2027-01-01T00:00:00.000Z',
    completed: {},
    partialProgress: {},
    lastUpdated: '2027-01-01T00:00:00.000Z',
    ...over
  });

  it('never leaves one volume in both maps, in either merge order', () => {
    // The laptop last synced in December and froze the year with the volume at
    // 40%; the phone froze it as finished. Unioned naively, the closed year
    // counted that single volume as 1.4 volumes — forever, since nothing
    // rewrites a snapshot.
    const laptop = snap({ partialProgress: { v: 0.4 } });
    const phone = snap({ completed: { v: '2026-12-28T00:00:00.000Z' } });

    for (const merged of [
      mergeSnapshotEntries(laptop, phone),
      mergeSnapshotEntries(phone, laptop)
    ]) {
      expect(Object.keys(merged.completed)).toEqual(['v']);
      expect(merged.partialProgress).toEqual({});
    }
  });

  it('keeps a fraction for a volume nobody finished', () => {
    const a = snap({ partialProgress: { v: 0.4 } });
    const b = snap({ partialProgress: { v: 0.9 } });
    expect(mergeSnapshotEntries(a, b).partialProgress).toEqual({ v: 0.9 });
  });

  it('picks period bounds deterministically, so two devices stop re-uploading at each other', () => {
    const a = snap({ startDate: '2026-01-01', endDate: '2026-12-31' });
    const b = snap({ startDate: '2026-01-01', endDate: '2027-01-01' });

    const ab = mergeSnapshotEntries(a, b);
    const ba = mergeSnapshotEntries(b, a);
    expect(ab.startDate).toBe(ba.startDate);
    expect(ab.endDate).toBe(ba.endDate);
  });
});

describe('partialProgressInPeriod judges completion AS OF the period end', () => {
  const dec = new Date(2026, 11, 20).getTime();
  const turns = (pages: number[]) =>
    pages.map((p, i) => [dec + i * 1000, p, p * 10]) as [number, number, number][];

  it('keeps in-period reading when the volume is finished AFTER the period ends', () => {
    // 160 pages into a 200-page volume on 31 December, finished on 2 January.
    // "Is it finished right now" is evaluated when the snapshot is BUILT, which
    // is after the period closed — so it erased December's reading from the
    // frozen 2026 record, permanently.
    const finishedInJanuary = new VolumeData({
      progress: 200,
      completed: true,
      completedAt: '2027-01-02T00:00:00.000Z',
      recentPageTurns: [
        ...turns([100, 160]),
        [new Date(2027, 0, 2).getTime(), 200, 2000] as [number, number, number]
      ]
    });

    expect(partialProgressInPeriod(finishedInJanuary, 200, START, END)).toBeGreaterThan(0);
  });

  it('credits a restarted volume the user is actively re-reading', () => {
    // "Has it ever been finished" excluded every volume with an older
    // completion, so a restarted series read to 80% showed 0.00 in the header
    // above a list rendering that same book at 80%.
    const restarted = new VolumeData({
      progress: 160,
      archivedReads: [
        {
          at: new Date(2026, 0, 15).getTime(),
          pages: 200,
          chars: 5000,
          completed: true,
          completedAt: '2025-06-10T00:00:00.000Z'
        }
      ],
      recentPageTurns: turns([20, 90, 160])
    });

    expect(partialProgressInPeriod(restarted, 200, START, END)).toBeGreaterThan(0);
  });

  it('still refuses credit for paging around near the end of a finished volume', () => {
    // Finished, and still sitting at the end at the period's close: the reading
    // is a revisit, and bucketVolumes shows the volume in no section, so credit
    // here would appear in the header with nothing to account for it.
    const revisited = new VolumeData({
      progress: 199,
      completed: true,
      completedAt: '2025-06-01T00:00:00.000Z',
      recentPageTurns: turns([198, 199])
    });

    expect(partialProgressInPeriod(revisited, 200, START, END)).toBe(0);
  });

  it('falls back to stored progress when no turn precedes the instant', () => {
    const noTurns = new VolumeData({ progress: 200, completed: true });
    expect(partialProgressInPeriod(noTurns, 200, START, END)).toBe(0);
  });
});
