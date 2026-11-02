import { describe, expect, it } from 'vitest';
import { convertLegacyRecord } from './legacy';

describe('convertLegacyRecord', () => {
  it('turns each page turn into a deterministic legacy page event with dwell to the next turn', () => {
    const out = convertLegacyRecord('vol-1', {
      recentPageTurns: [
        [2000, 5, 500],
        [1000, 4, 400]
      ]
    });
    expect(out).toEqual([
      {
        device: 'legacy:vol-1',
        seq: 1000,
        t: 1000,
        kind: 'page',
        volume: 'vol-1',
        first_page: 4,
        last_page: 4,
        page_chars: [0],
        chars_before: 400,
        dwell_ms: 1000,
        layout: 'unknown',
        orientation: 'unknown',
        viewport: null
      },
      {
        device: 'legacy:vol-1',
        seq: 2000,
        t: 2000,
        kind: 'page',
        volume: 'vol-1',
        first_page: 5,
        last_page: 5,
        page_chars: [0],
        chars_before: 500,
        dwell_ms: null,
        layout: 'unknown',
        orientation: 'unknown',
        viewport: null
      }
    ]);
  });

  it('is identical on every device for the same turns, and keeps one event per timestamp', () => {
    const a = convertLegacyRecord('v', {
      recentPageTurns: [
        [1, 1, 10],
        [1, 2, 20]
      ]
    });
    expect(a).toHaveLength(1);
    expect(
      convertLegacyRecord('v', {
        recentPageTurns: [
          [1, 1, 10],
          [1, 2, 20]
        ]
      })
    ).toEqual(a);
  });

  it('converts archived reads to restart events', () => {
    expect(convertLegacyRecord('v', { archivedReads: [{ at: 77 }] })).toEqual([
      { device: 'legacy:v', seq: 77, t: 77, kind: 'restart', volume: 'v' }
    ]);
  });
});
