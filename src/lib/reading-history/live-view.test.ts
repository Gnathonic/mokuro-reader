import { describe, expect, it } from 'vitest';
import { liveMinutes } from './live-view';

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
  it('counts what the answer says: full, typical, none; unanswered = typical', () => {
    const open = { since: 0 };
    expect(liveMinutes(0, open, 20 * MIN, 5 * MIN, 2 * MIN, 'full')).toBe(20);
    expect(liveMinutes(0, open, 20 * MIN, 5 * MIN, 2 * MIN, 'typical')).toBe(2);
    expect(liveMinutes(0, open, 20 * MIN, 5 * MIN, 2 * MIN, 'none')).toBe(0);
    expect(liveMinutes(0, open, 20 * MIN, 5 * MIN, 2 * MIN, null)).toBe(2);
  });

  it('under the cap an unanswered view counts its whole dwell', () => {
    expect(liveMinutes(0, { since: 0 }, 3 * MIN, 5 * MIN, 2 * MIN, null)).toBe(3);
  });
});
