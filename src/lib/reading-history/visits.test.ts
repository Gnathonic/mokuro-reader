import { describe, expect, it } from 'vitest';
import {
  VISIT_GAP_MS,
  eventKey,
  isLookupVisit,
  lookupVisits,
  readsPages,
  sameView,
  splitVisits,
  type ViewLike
} from './visits';
import type { ReadingEvent } from './types';

function v(first: number, last: number, dwell: number, chars: number, t: number): ViewLike {
  const pages = last - first + 1;
  return {
    t,
    first_page: first,
    last_page: last,
    dwell_ms: dwell,
    page_chars: Array.from({ length: pages }, () => chars / pages)
  };
}

let seq = 0;
function page(
  t: number,
  first: number,
  dwell: number,
  { device = 'dev-a', volume = 'vol', last = first, chars = 300 } = {}
): ReadingEvent {
  return {
    device,
    seq: ++seq,
    t,
    kind: 'page',
    volume,
    first_page: first,
    last_page: last,
    page_chars: Array.from({ length: last - first + 1 }, () => chars),
    chars_before: 0,
    dwell_ms: dwell,
    layout: 'single',
    orientation: 'portrait',
    viewport: null
  };
}

describe('isLookupVisit', () => {
  it('open p.40, two quick peeks, back to p.40 → look-up', () =>
    expect(
      isLookupVisit([
        v(40, 40, 5000, 300, 0),
        v(41, 41, 800, 300, 6000),
        v(42, 42, 900, 300, 7000),
        v(40, 40, 0, 300, 8000)
      ])
    ).toBe(true));

  it('a single view is never a look-up', () =>
    expect(isLookupVisit([v(40, 40, 60000, 300, 0)])).toBe(false));

  it('ending elsewhere is not a look-up', () =>
    expect(isLookupVisit([v(40, 40, 5000, 300, 0), v(41, 41, 900, 300, 6000)])).toBe(false));

  it('two pages read outside home still a look-up; three are reading', () => {
    const read = (p: number, t: number) => v(p, p, 20_000, 300, t); // 900 cpm: reading pace
    expect(
      isLookupVisit([v(40, 40, 5000, 300, 0), read(41, 1e4), read(42, 4e4), v(40, 40, 0, 300, 7e4)])
    ).toBe(true);
    expect(
      isLookupVisit([
        v(40, 40, 5000, 300, 0),
        read(41, 1e4),
        read(42, 4e4),
        read(43, 7e4),
        v(40, 40, 0, 300, 1e5)
      ])
    ).toBe(false);
  });

  it('the same page read twice outside home counts once', () => {
    const read = (p: number, t: number) => v(p, p, 20_000, 300, t);
    expect(
      isLookupVisit([
        v(40, 40, 5000, 300, 0),
        read(41, 1e4),
        read(42, 4e4),
        read(41, 7e4),
        v(40, 40, 0, 300, 1e5)
      ])
    ).toBe(true);
  });

  it('a whole read then back to the cover is reading', () => {
    const visit = [
      v(1, 1, 5000, 0, 0),
      ...Array.from({ length: 199 }, (_, i) => v(i + 2, i + 2, 20_000, 300, (i + 1) * 21_000)),
      v(1, 1, 0, 0, 5e6)
    ];
    expect(isLookupVisit(visit)).toBe(false);
  });
});

describe('sameView / readsPages', () => {
  it('spreads: [40,41] then [41,42] is the same view', () =>
    expect(sameView({ first_page: 40, last_page: 41 }, { first_page: 41, last_page: 42 })).toBe(
      true
    ));

  it('adjacent spreads do not overlap', () =>
    expect(sameView({ first_page: 40, last_page: 41 }, { first_page: 42, last_page: 43 })).toBe(
      false
    ));

  it('a picture page (0 chars) is read by dwell alone', () => {
    expect(readsPages(v(41, 41, 5000, 0, 0))).toBe(true);
    expect(readsPages(v(41, 41, 2000, 0, 0))).toBe(false);
  });

  it('a skip-fast view is not read however long it stayed', () =>
    // 300 chars in 4 s = 4500 cpm > SKIP_CPM
    expect(readsPages(v(41, 41, 4000, 300, 0))).toBe(false));
});

describe('splitVisits', () => {
  it('splitVisits: an 11-minute gap starts a new visit; devices never share one; legacy is left out', () => {
    const a1 = page(0, 40, 5000);
    const a2 = page(6000, 41, 1000);
    const a3 = page(7000 + 11 * 60_000, 40, 1000); // 11 min after a2 ended
    const b1 = page(6500, 40, 1000, { device: 'dev-b' });
    const legacy = page(6800, 40, 1000, { device: 'legacy:x' });
    const other = page(6600, 40, 1000, { volume: 'other' });
    const visits = splitVisits([a3, b1, legacy, a2, other, a1]);
    const keys = visits.map((visit) => visit.map((e) => eventKey(e)));
    expect(keys).toContainEqual([eventKey(a1), eventKey(a2)]);
    expect(keys).toContainEqual([eventKey(a3)]);
    expect(keys).toContainEqual([eventKey(b1)]);
    expect(keys).toContainEqual([eventKey(other)]);
    expect(visits.flat().some((e) => e.device.startsWith('legacy:'))).toBe(false);
    expect(visits).toHaveLength(4);
  });

  it('a gap of exactly VISIT_GAP_MS keeps the visit', () => {
    const a1 = page(0, 40, 1000);
    const a2 = page(1000 + VISIT_GAP_MS, 41, 1000);
    expect(splitVisits([a1, a2])).toHaveLength(1);
  });
});

describe('lookupVisits', () => {
  it('lookupVisits: keys every view of a look-up, and outsideHome only the away views', () => {
    const home = page(0, 40, 5000);
    const away = page(6000, 41, 800);
    const back = page(7000, 40, 0);
    // A separate reading visit (an hour later) on the same volume is untouched.
    const r1 = page(3_600_000, 40, 20_000);
    const r2 = page(3_621_000, 41, 20_000);
    const verdict = lookupVisits([home, away, back, r1, r2]);
    expect([...verdict.lookup].sort()).toEqual([home, away, back].map(eventKey).sort());
    expect([...verdict.outsideHome]).toEqual([eventKey(away)]);
  });

  it('eventKey joins device and seq', () =>
    expect(eventKey({ device: 'd', seq: 7 })).toBe('d\u00007'));
});
