import { describe, expect, it } from 'vitest';
import { VolumeData } from '$lib/settings/volume-data';
import { completionEventsFor } from '../completed-at';

const NOW = Date.parse('2026-08-30T12:00:00.000Z');

describe('completionEventsFor', () => {
  it('reports the current pass', () => {
    const v = new VolumeData({ completed: true, completedAt: '2026-03-01T00:00:00.000Z' });
    expect(completionEventsFor(v, NOW)).toEqual(['2026-03-01T00:00:00.000Z']);
  });

  it('reports nothing for a volume that was never finished', () => {
    expect(completionEventsFor(new VolumeData({ progress: 12 }), NOW)).toEqual([]);
  });

  it('counts each finished archived pass, dated when it FINISHED not when restart was pressed', () => {
    const v = new VolumeData({
      archivedReads: [
        {
          // Restart pressed in December...
          at: Date.parse('2026-12-20T00:00:00.000Z'),
          pages: 200,
          chars: 5000,
          completed: true,
          // ...for a pass that actually finished in March.
          completedAt: '2026-03-01T00:00:00.000Z'
        }
      ],
      completed: true,
      completedAt: '2026-08-01T00:00:00.000Z'
    });

    expect(completionEventsFor(v, NOW)).toEqual([
      '2026-03-01T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z'
    ]);
  });

  it('ignores an archived pass that did not finish, and one with no date', () => {
    const v = new VolumeData({
      archivedReads: [
        { at: 1, pages: 10, chars: 1, completed: false, completedAt: '2026-01-01T00:00:00.000Z' },
        // Pre-existing entry from before the field existed: counts toward
        // lifetime totals elsewhere, but is never DATED into a goal period.
        { at: 2, pages: 200, chars: 5000, completed: true }
      ]
    });
    expect(completionEventsFor(v, NOW)).toEqual([]);
  });

  it('discards a stamp from a badly-skewed clock rather than parking the volume in a future period', () => {
    const v = new VolumeData({ completed: true, completedAt: '2027-01-01T00:00:00.000Z' });
    expect(completionEventsFor(v, NOW)).toEqual([]);
  });

  it('tolerates a stamp inside the clock-skew window', () => {
    const nearFuture = new Date(NOW + 60 * 1000).toISOString();
    const v = new VolumeData({ completed: true, completedAt: nearFuture });
    expect(completionEventsFor(v, NOW)).toEqual([nearFuture]);
  });
});
