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
