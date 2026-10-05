import { describe, expect, it } from 'vitest';
import { convertLegacyRecord } from './legacy';
import { projectTurns } from './project-turns';
import type { ReadingEvent } from './types';

const native = (
  t: number,
  page: number,
  dwell: number,
  device = 'dev-a',
  seq = t
): ReadingEvent => ({
  device,
  seq,
  t,
  kind: 'page',
  volume: 'v',
  first_page: page,
  last_page: page + 1,
  page_chars: [10, 20],
  chars_before: page * 100,
  dwell_ms: dwell,
  layout: 'double',
  orientation: 'landscape',
  viewport: { w: 1, h: 1 }
});

describe('projectTurns', () => {
  it('a native view becomes a turn at its start, with chars through its last page', () => {
    expect(projectTurns([native(1000, 3, 5000)]).get('v')).toEqual([[1000, 4, 330]]);
  });

  it('a phase-1 reading recorded both ways counts once: covered legacy turns are dropped', () => {
    const legacy = convertLegacyRecord('v', {
      recentPageTurns: [
        [1500, 3, 300],
        [9000, 9, 900]
      ]
    });
    const turns = projectTurns([native(1000, 3, 5000), ...legacy]).get('v');
    expect(turns).toEqual([
      [1000, 4, 330],
      [9000, 9, 900]
    ]);
  });

  it('merges devices and legacy in time order', () => {
    // 5000 is more than COVER_SLACK_MS from either native view, so it counts.
    const turns = projectTurns([
      native(10000, 1, 100, 'dev-b', 1),
      native(1000, 7, 100, 'dev-a', 1),
      ...convertLegacyRecord('v', { recentPageTurns: [[5000, 2, 200]] })
    ]).get('v')!;
    expect(turns.map((t) => t[0])).toEqual([1000, 5000, 10000]);
  });

  it('a forget hides everything recorded before it, on every device, legacy included', () => {
    const forget: ReadingEvent = {
      device: 'dev-a',
      seq: 99,
      t: 4000,
      kind: 'forget',
      volume: 'v',
      before: 4000
    };
    const turns = projectTurns([
      ...convertLegacyRecord('v', { recentPageTurns: [[1000, 1, 10]] }),
      native(2000, 2, 100, 'dev-b', 7),
      forget,
      native(6000, 1, 100, 'dev-a', 100)
    ]).get('v');
    expect(turns).toEqual([[6000, 2, 130]]);
  });

  it('a 2-tuple legacy turn projects back as a 2-tuple', () => {
    const legacy = convertLegacyRecord('v', { recentPageTurns: [[1000, 4]] });
    expect(projectTurns(legacy).get('v')).toEqual([[1000, 4]]);
  });
});
