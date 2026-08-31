import { describe, expect, it } from 'vitest';
import { VolumeData } from '$lib/settings/volume-data';
import type { GoalPeriod, GoalSnapshot } from '$lib/goals/types';
import {
  bucketVolumes,
  computeVolumeStats,
  createEntriesWithSortData,
  groupCompletedEntriesBySeries,
  pickNextPerSeries,
  signedDaysUntil,
  sortEntries,
  type TrackerVolumeStats
} from '../progress-tracker-helpers';

const PERIOD: GoalPeriod = {
  goalType: 'year',
  periodKey: '2026',
  label: '2026',
  start: new Date(2026, 0, 1),
  end: new Date(2027, 0, 1)
};

const NOW = new Date(2026, 7, 30, 12).getTime();

function vol(over: Partial<ConstructorParameters<typeof VolumeData>[0]> = {}) {
  return new VolumeData(over);
}

describe('computeVolumeStats', () => {
  it('separates "zero pages" from "length unknown"', () => {
    const entries: [string, VolumeData][] = [
      ['installed', vol({ progress: 50 })],
      ['cloud-only', vol({ progress: 50 })]
    ];
    const stats = computeVolumeStats(
      entries,
      { installed: { page_count: 200 } },
      {
        installed: 50,
        'cloud-only': 50
      }
    );

    expect(stats.installed.lengthUnknown).toBe(false);
    expect(stats.installed.remainingPages).toBe(150);
    // No catalog row and no index page count: we do not know how long it is.
    expect(stats['cloud-only'].lengthUnknown).toBe(true);
  });

  it('treats a stop on page 1 as not started', () => {
    const stats = computeVolumeStats([['a', vol()]], { a: { page_count: 100 } }, { a: 1 });
    expect(stats.a.currentPage).toBe(0);
    expect(stats.a.progressPercent).toBe(0);
  });

  it('never reports negative remaining pages', () => {
    const stats = computeVolumeStats([['a', vol()]], { a: { page_count: 100 } }, { a: 130 });
    expect(stats.a.remainingPages).toBe(0);
  });
});

describe('bucketVolumes', () => {
  const stats = (over: Partial<TrackerVolumeStats> = {}): TrackerVolumeStats => ({
    progressPercent: 0,
    progressPercentString: '0%',
    remainingPages: 0,
    currentPage: 0,
    totalPages: 0,
    lengthUnknown: true,
    ...over
  });

  it('counts a volume finished on another device, whose pages are not on this one', () => {
    // The goal ring in the header counted this volume while the Completed list
    // below it did not list it: the old gate required currentPage >= totalPages
    // FIRST, and totalPages is 0 for a volume this device never downloaded.
    const cloudFinished = vol({
      completed: true,
      completedAt: '2026-03-01T00:00:00.000Z',
      progress: 180
    });

    const buckets = bucketVolumes(
      [['v', cloudFinished]],
      { v: stats({ currentPage: 180 }) },
      PERIOD,
      null,
      NOW
    );

    expect(buckets.completedVolumes.map(([id]) => id)).toEqual(['v']);
    expect(buckets.currentlyReading).toEqual([]);
  });

  it('keeps a NOT-ON-DEVICE volume in Currently Reading when its length is known', () => {
    // The pages are elsewhere, but a metadata-only row or a series.json index
    // supplies the count — so there is a real progress bar and a real target,
    // and the volume belongs in the list.
    const buckets = bucketVolumes(
      [['v', vol({ progress: 40 })]],
      { v: stats({ currentPage: 40, totalPages: 200, lengthUnknown: false }) },
      PERIOD,
      null,
      NOW
    );

    expect(buckets.currentlyReading.map(([id]) => id)).toEqual(['v']);
  });

  it('leaves a volume of UNKNOWN length out of both actionable lists', () => {
    // Synced progress for a series this device has never opened: no row, so no
    // page count, no cover and nothing to open or download. Rendering one card
    // per volume produced a wall of "0% (0p)". They come back the moment
    // `patchProgressHolesWhenListingReady` mints their rows.
    const buckets = bucketVolumes(
      [
        ['reading', vol({ progress: 40 })],
        ['untouched', vol()]
      ],
      { reading: stats({ currentPage: 40 }), untouched: stats() },
      PERIOD,
      null,
      NOW
    );

    expect(buckets.currentlyReading).toEqual([]);
    expect(buckets.futureReads).toEqual([]);
  });

  it('still lists a COMPLETED volume of unknown length — a title is enough', () => {
    const finished = vol({ completed: true, completedAt: '2026-03-01T00:00:00.000Z' });
    const buckets = bucketVolumes(
      [['v', finished]],
      { v: stats({ currentPage: 180 }) },
      PERIOD,
      null,
      NOW
    );

    expect(buckets.completedVolumes.map(([id]) => id)).toEqual(['v']);
  });

  it('does not count a completion that falls outside the active period', () => {
    const lastYear = vol({ completed: true, completedAt: '2025-03-01T00:00:00.000Z' });
    const buckets = bucketVolumes(
      [['v', lastYear]],
      { v: stats({ currentPage: 200, totalPages: 200, lengthUnknown: false }) },
      PERIOD,
      null,
      NOW
    );

    expect(buckets.completedVolumes).toEqual([]);
    // Finished, so it is not offered as something to read either.
    expect(buckets.currentlyReading).toEqual([]);
    expect(buckets.futureReads).toEqual([]);
  });

  it('counts a pass finished in the period and since restarted', () => {
    const restarted = vol({
      progress: 0,
      archivedReads: [
        {
          at: new Date(2026, 11, 20).getTime(),
          pages: 200,
          chars: 5000,
          completed: true,
          completedAt: '2026-03-01T00:00:00.000Z'
        }
      ]
    });

    const buckets = bucketVolumes(
      [['v', restarted]],
      { v: stats({ totalPages: 200, lengthUnknown: false }) },
      PERIOD,
      null,
      NOW
    );

    expect(buckets.completedVolumes.map(([id]) => id)).toEqual(['v']);
  });

  it('defers to a closed period snapshot rather than re-deriving it', () => {
    const snapshot: GoalSnapshot = {
      goalType: 'year',
      periodKey: '2026',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      closedAt: '2027-01-01T00:00:00.000Z',
      completed: { recorded: '2026-05-01T00:00:00.000Z' },
      partialProgress: {},
      lastUpdated: '2027-01-01T00:00:00.000Z'
    };

    const finished = vol({ completed: true, completedAt: '2026-05-01T00:00:00.000Z' });
    const alsoFinished = vol({ completed: true, completedAt: '2026-06-01T00:00:00.000Z' });

    const buckets = bucketVolumes(
      [
        ['recorded', finished],
        ['not-in-snapshot', alsoFinished]
      ],
      {
        recorded: stats({ totalPages: 10, lengthUnknown: false }),
        'not-in-snapshot': stats({ totalPages: 10, lengthUnknown: false })
      },
      PERIOD,
      snapshot,
      NOW
    );

    expect(buckets.completedVolumes.map(([id]) => id)).toEqual(['recorded']);
  });

  it('puts an untouched volume of known length in Future Reads', () => {
    const buckets = bucketVolumes(
      [['v', vol()]],
      { v: stats({ totalPages: 200, lengthUnknown: false }) },
      PERIOD,
      null,
      NOW
    );
    expect(buckets.futureReads.map(([id]) => id)).toEqual(['v']);
  });
});

describe('pickNextPerSeries', () => {
  it('offers one volume per series and skips series already being read', () => {
    const future: [string, VolumeData][] = [
      ['a2', vol({ series_uuid: 'A', volume_title: 'Vol 2' })],
      ['a1', vol({ series_uuid: 'A', volume_title: 'Vol 1' })],
      ['b1', vol({ series_uuid: 'B', volume_title: 'Vol 1' })]
    ];
    const reading: [string, VolumeData][] = [['b0', vol({ series_uuid: 'B' })]];

    // Lowest volume title wins within a series; B is excluded entirely.
    expect(pickNextPerSeries(future, reading).map(([id]) => id)).toEqual(['a1']);
  });

  it('keeps every volume that has no series', () => {
    const future: [string, VolumeData][] = [
      ['x', vol({ volume_title: 'One' })],
      ['y', vol({ volume_title: 'Two' })]
    ];
    expect(
      pickNextPerSeries(future, [])
        .map(([id]) => id)
        .sort()
    ).toEqual(['x', 'y']);
  });
});

describe('signedDaysUntil', () => {
  const today = new Date(2026, 7, 30);

  it('goes negative for an overdue deadline, so the sort can rank them', () => {
    expect(signedDaysUntil('2026-08-30', today)).toBe(1);
    expect(signedDaysUntil('2026-08-29', today)).toBe(0);
    expect(signedDaysUntil('2026-08-20', today)).toBe(-9);
    expect(signedDaysUntil('2026-07-30', today)).toBe(-30);
  });

  it('returns null for a deadline it cannot parse', () => {
    expect(signedDaysUntil('soon', today)).toBeNull();
    expect(signedDaysUntil('', today)).toBeNull();
  });
});

describe('sortEntries', () => {
  const base = {
    volumeData: vol(),
    remainingPages: 0,
    targetPagesPerPeriod: null as number | null,
    pagesReadInPeriod: 0,
    pagesToGoal: null as number | null,
    daysUntilDeadline: null as number | null,
    lastProgressUpdate: 0,
    hasDeadline: false
  };

  it('orders overdue deadlines by how overdue they are', () => {
    // With an unsigned day count every overdue volume tied at 0, so the most
    // urgent could sort last.
    const entries = [
      { ...base, volumeId: 'due-soon', hasDeadline: true, daysUntilDeadline: 3 },
      { ...base, volumeId: 'very-late', hasDeadline: true, daysUntilDeadline: -30 },
      { ...base, volumeId: 'a-bit-late', hasDeadline: true, daysUntilDeadline: -2 }
    ];

    expect(sortEntries(entries, 'deadline').map((e) => e.volumeId)).toEqual([
      'very-late',
      'a-bit-late',
      'due-soon'
    ]);
  });

  it('puts entries with no deadline last', () => {
    const entries = [
      { ...base, volumeId: 'none' },
      { ...base, volumeId: 'has', hasDeadline: true, daysUntilDeadline: 5 }
    ];
    expect(sortEntries(entries, 'deadline').map((e) => e.volumeId)).toEqual(['has', 'none']);
  });

  it('treats a NaN target as absent instead of corrupting the comparator', () => {
    const entries = [
      { ...base, volumeId: 'nan', targetPagesPerPeriod: Number.NaN },
      { ...base, volumeId: 'real', targetPagesPerPeriod: 12 }
    ];
    expect(sortEntries(entries, 'pages-per-period').map((e) => e.volumeId)).toEqual([
      'real',
      'nan'
    ]);
  });

  it('sorts fewest remaining pages first', () => {
    const entries = [
      { ...base, volumeId: 'far', remainingPages: 180 },
      { ...base, volumeId: 'close', remainingPages: 4 }
    ];
    expect(sortEntries(entries, 'fewest-pages').map((e) => e.volumeId)).toEqual(['close', 'far']);
  });
});

describe('groupCompletedEntriesBySeries', () => {
  it('groups on the series title the rest of the app keys by, not series_uuid', () => {
    // Volumes imported in separate batches get different series_uuids, which
    // split one series into several groups here while every other series
    // surface showed it as one.
    const entries = createEntriesWithSortData(
      [
        ['v1', vol({ series_uuid: 'uuid-a', series_title: 'Dr. STONE', volume_title: 'Vol 1' })],
        ['v2', vol({ series_uuid: 'uuid-b', series_title: 'Dr. STONE', volume_title: 'Vol 2' })]
      ],
      {},
      {},
      'daily',
      0
    );

    const groups = groupCompletedEntriesBySeries(entries, {
      v1: '2026-03-01T00:00:00.000Z',
      v2: '2026-04-01T00:00:00.000Z'
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].completedCount).toBe(2);
    expect(groups[0].completedLabel).toBe('2 volumes');
    expect(groups[0].representativeEntry.volumeId).toBe('v2');
  });

  it('gives each series-less volume its own bucket rather than lumping them together', () => {
    const entries = createEntriesWithSortData(
      [
        ['v1', vol({ volume_title: 'Loose 1' })],
        ['v2', vol({ series_title: '[Missing Series Info]', volume_title: 'Loose 2' })]
      ],
      {},
      {},
      'daily',
      0
    );

    const groups = groupCompletedEntriesBySeries(entries, {});
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.completedCount === 1)).toBe(true);
  });
});
