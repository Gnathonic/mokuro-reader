import { describe, expect, it } from 'vitest';
import { endedViewMs, liveMinutes } from './live-view';

const MIN = 60_000;

describe('liveMinutes', () => {
  it('adds the open view, up to its cap, to the counted time', () => {
    expect(liveMinutes(10 * MIN, { since: 0 }, 2 * MIN, 5 * MIN)).toBe(12);
    expect(liveMinutes(10 * MIN, { since: 0 }, 60 * MIN, 5 * MIN)).toBe(15);
  });

  it('is the counted time alone with no open view', () => {
    expect(liveMinutes(10 * MIN + 59_000, null, 999, 5 * MIN)).toBe(10);
  });
});

describe('liveMinutes past the cap (phase 3b)', () => {
  it('counts what the answer says: full, typical, none', () => {
    const open = { since: 0 };
    expect(liveMinutes(0, open, 20 * MIN, 5 * MIN, 2 * MIN, 'full')).toBe(20);
    expect(liveMinutes(0, open, 20 * MIN, 5 * MIN, 2 * MIN, 'typical')).toBe(2);
    expect(liveMinutes(0, open, 20 * MIN, 5 * MIN, 2 * MIN, 'none')).toBe(0);
  });

  it('unanswered, the timer stops at the cap while the prompt asks', () => {
    expect(liveMinutes(0, { since: 0 }, 20 * MIN, 5 * MIN, 2 * MIN, null)).toBe(5);
  });

  it('under the cap an unanswered view counts its whole dwell', () => {
    expect(liveMinutes(0, { since: 0 }, 3 * MIN, 5 * MIN, 2 * MIN, null)).toBe(3);
  });
});

describe('endedViewMs (phase 3b)', () => {
  const page = (dwell_ms: number | null, chars = 400) => ({ dwell_ms, page_chars: [chars] });
  // 300 ms/char, k = 3: a 400-char page expects 2 min, cap 6 min.
  const idle = { k: 3, overrideMs: null };

  it('is what the stats will count for the view that just ended', () => {
    expect(endedViewMs(page(3 * MIN), null, 300, idle)).toBe(3 * MIN);
    expect(endedViewMs(page(10 * MIN), null, 300, idle)).toBe(2 * MIN); // provisional: typical
    expect(endedViewMs(page(10 * MIN), 'none', 300, idle)).toBe(0);
    expect(endedViewMs(page(10 * MIN), 'typical', 300, idle)).toBe(2 * MIN);
    expect(endedViewMs(page(10 * MIN), 'full', 300, idle)).toBe(10 * MIN);
  });

  it('is 0 for a view of unknown dwell', () => {
    expect(endedViewMs(page(null), null, 300, idle)).toBe(0);
  });
});
