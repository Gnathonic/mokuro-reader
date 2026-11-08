import { describe, it, expect } from 'vitest';
import {
  hasFreshPassSince,
  isVolumeComplete,
  isVolumeFinished,
  isSeriesFinished,
  getCurrentPage,
  getProgressDisplay
} from './volume-helpers';

describe('isVolumeComplete', () => {
  it('should return true when on last page (pageCount)', () => {
    expect(isVolumeComplete(200, 200)).toBe(true);
  });

  it('should return true when on second to last page (pageCount - 1)', () => {
    // This handles the case where the reader shows page_count-1 as the last readable page
    expect(isVolumeComplete(199, 200)).toBe(true);
  });

  it('should return false when not near end', () => {
    expect(isVolumeComplete(1, 200)).toBe(false);
    expect(isVolumeComplete(100, 200)).toBe(false);
    expect(isVolumeComplete(198, 200)).toBe(false);
  });

  it('should handle single page volume', () => {
    expect(isVolumeComplete(1, 1)).toBe(true);
  });

  it('should not call a volume nobody has opened complete', () => {
    // Page 0 is "never opened", not "one page from the end" — a one-page volume used to
    // read as finished the moment it appeared (0 === 1-1), and so did a two-page one.
    expect(isVolumeComplete(0, 1)).toBe(false);
    expect(isVolumeComplete(0, 2)).toBe(false);
  });

  it('should not call a volume of unknown length complete', () => {
    // A cloud share reports no page count until it is downloaded.
    expect(isVolumeComplete(0, 0)).toBe(false);
    expect(isVolumeComplete(1, 0)).toBe(false);
  });

  it('should handle two page volume', () => {
    expect(isVolumeComplete(2, 2)).toBe(true);
    expect(isVolumeComplete(1, 2)).toBe(true); // 1 === 2-1
  });

  it('should return false for page 0 in multi-page volume', () => {
    expect(isVolumeComplete(0, 100)).toBe(false);
  });
});

describe('getCurrentPage', () => {
  it('should return page from progress when available', () => {
    const progress = {
      'vol-1': 50,
      'vol-2': 100
    };
    expect(getCurrentPage('vol-1', progress)).toBe(50);
    expect(getCurrentPage('vol-2', progress)).toBe(100);
  });

  it('should return 1 when volume not in progress', () => {
    const progress = {
      'vol-1': 50
    };
    expect(getCurrentPage('vol-2', progress)).toBe(1);
  });

  it('should return 1 when progress is undefined', () => {
    expect(getCurrentPage('vol-1', undefined)).toBe(1);
  });

  it('should return 1 when progress is empty object', () => {
    expect(getCurrentPage('vol-1', {})).toBe(1);
  });

  it('should handle zero page in progress', () => {
    const progress = {
      'vol-1': 0
    };
    // 0 is falsy, so ?? operator returns it (0 is a valid value)
    expect(getCurrentPage('vol-1', progress)).toBe(0);
  });
});

describe('getProgressDisplay', () => {
  it('should format basic progress', () => {
    expect(getProgressDisplay(5, 200)).toBe('5 / 200');
    expect(getProgressDisplay(1, 100)).toBe('1 / 100');
    expect(getProgressDisplay(50, 50)).toBe('50 / 50');
  });

  it('should display pageCount when on second to last page', () => {
    // Edge case: page_count-1 shows as page_count for better UX
    expect(getProgressDisplay(199, 200)).toBe('200 / 200');
    expect(getProgressDisplay(99, 100)).toBe('100 / 100');
  });

  it('should use default page when currentPage is 0', () => {
    expect(getProgressDisplay(0, 200)).toBe('1 / 200');
    expect(getProgressDisplay(0, 100, 5)).toBe('5 / 100');
  });

  it('should use custom default page', () => {
    expect(getProgressDisplay(0, 200, 10)).toBe('10 / 200');
  });

  it('should handle single page volume', () => {
    expect(getProgressDisplay(1, 1)).toBe('1 / 1');
    expect(getProgressDisplay(0, 1)).toBe('1 / 1'); // 0 === 1-1, shows as pageCount
  });

  it('should handle two page volume edge case', () => {
    expect(getProgressDisplay(1, 2)).toBe('2 / 2'); // 1 === 2-1
    expect(getProgressDisplay(2, 2)).toBe('2 / 2');
  });

  it('should not modify normal pages', () => {
    expect(getProgressDisplay(198, 200)).toBe('198 / 200');
    expect(getProgressDisplay(1, 200)).toBe('1 / 200');
  });
});

describe('isVolumeFinished', () => {
  const vol = (page_count: number, volume_uuid = 'v-1') => ({ volume_uuid, page_count });

  it('derives completion from the raw page, like isVolumeComplete', () => {
    expect(isVolumeFinished(vol(200), { progress: 200 })).toBe(true);
    expect(isVolumeFinished(vol(200), { progress: 199 })).toBe(true);
    expect(isVolumeFinished(vol(200), { progress: 198 })).toBe(false);
  });

  it('counts a volume the user marked finished, with no progress of any kind', () => {
    // The user's rule: "reading history" is broader than page turns. No pages, no time,
    // no turns — marked finished still counts.
    expect(isVolumeFinished(vol(200), { completed: true })).toBe(true);
    expect(isVolumeFinished(vol(200), { progress: 0, completed: true })).toBe(true);
  });

  it('counts a bare placeholder whose length is unknown but whose flag says finished', () => {
    // A cloud-only volume: page_count 0 here, progress synced from the device that read
    // it. The derivation can only ever answer "no" — the flag is the only evidence there
    // is, and this is exactly the case that left a finished cloud series uncoloured.
    expect(isVolumeFinished(vol(0), { progress: 180, completed: true })).toBe(true);
    expect(isVolumeFinished(vol(0), { completed: true })).toBe(true);
  });

  it('does not call an unknown-length volume finished on progress alone', () => {
    expect(isVolumeFinished(vol(0), { progress: 180 })).toBe(false);
    expect(isVolumeFinished(vol(0), undefined)).toBe(false);
  });

  it('lets the derivation override a stale false flag', () => {
    // `updateProgress(volume, page)` defaults its 4th argument, so a caller that only
    // means to move the page (Reader.toggleHasCover, the reader-settings page input)
    // stores `completed: false` over a volume that IS read through.
    expect(isVolumeFinished(vol(200), { progress: 200, completed: false })).toBe(true);
  });

  it('calls an untouched volume unfinished', () => {
    expect(isVolumeFinished(vol(200), undefined)).toBe(false);
    expect(isVolumeFinished(vol(200), { progress: 0, completed: false })).toBe(false);
    // Page 0 is "never opened", not "one from the end", even on a one-page volume.
    expect(isVolumeFinished(vol(1), undefined)).toBe(false);
  });
});

describe('isSeriesFinished', () => {
  const vol = (volume_uuid: string, page_count = 10) => ({ volume_uuid, page_count });

  it('counts EVERY volume of the series, placeholders included', () => {
    const volumes = [vol('a'), vol('b', 0)];
    // 'b' is a bare cloud placeholder: unread, so the series is not finished — however
    // finished the one volume that is here happens to be.
    expect(isSeriesFinished(volumes, { a: { progress: 10 } })).toBe(false);
    expect(isSeriesFinished(volumes, { a: { progress: 10 }, b: { completed: true } })).toBe(true);
  });

  it('needs no catalog row: an all-placeholder series can be finished', () => {
    const volumes = [vol('p-1', 0), vol('p-2', 0)];
    expect(
      isSeriesFinished(volumes, { 'p-1': { completed: true }, 'p-2': { completed: true } })
    ).toBe(true);
  });

  it('is false for a series with nothing in it', () => {
    expect(isSeriesFinished([], { a: { completed: true } })).toBe(false);
  });

  it('treats a missing reading record as unread', () => {
    expect(isSeriesFinished([vol('a')], {})).toBe(false);
    expect(isSeriesFinished([vol('a')], undefined)).toBe(false);
  });
});

describe('hasFreshPassSince (#304)', () => {
  const SINCE = 1_000;
  /** One turn per page, `stepMs` apart (20 s: read; 1 s: flipped through). */
  const turns = (pages: number[], stepMs = 20_000) =>
    pages.map((page, i) => [SINCE + 1 + i * stepMs, page, page * 10] as [number, number, number]);
  const range = (from: number, to: number) =>
    Array.from({ length: Math.abs(to - from) + 1 }, (_, i) => (to >= from ? from + i : from - i));

  it('a look back at an early page is no pass, however far back it went', () => {
    expect(hasFreshPassSince(turns([30]), SINCE, 200)).toBe(false);
    expect(hasFreshPassSince(turns([1, 2, 3, 30, 31, 200]), SINCE, 200)).toBe(false);
  });

  it('a pass reaches the first half, then reads on through a quarter of the pages', () => {
    // A page is read when the reader stayed on it until the next turn; the last
    // turn has no next one yet.
    expect(hasFreshPassSince(turns(range(1, 50)), SINCE, 200)).toBe(false);
    expect(hasFreshPassSince(turns(range(1, 51)), SINCE, 200)).toBe(true);
    // Started in the first half, read on past it.
    expect(hasFreshPassSince(turns(range(90, 141)), SINCE, 200)).toBe(true);
  });

  it('paging backwards to find a scene is no reading', () => {
    expect(hasFreshPassSince(turns(range(200, 20)), SINCE, 200)).toBe(false);
  });

  it('flipping forward through pages is no reading', () => {
    expect(hasFreshPassSince(turns(range(20, 200), 1_000), SINCE, 200)).toBe(false);
  });

  it('reading near the end, then a jump back, is no pass', () => {
    expect(hasFreshPassSince(turns([...range(120, 190), 10]), SINCE, 200)).toBe(false);
  });

  it('reading near the end is a revisit, however much of it', () => {
    expect(hasFreshPassSince(turns(range(101, 200)), SINCE, 200)).toBe(false);
  });

  it('only turns after the completion count', () => {
    const before = range(1, 100).map(
      (page) => [SINCE - 100_000 + page * 20_000 - 2_000_000, page, 0] as [number, number, number]
    );
    expect(hasFreshPassSince(before, SINCE, 200)).toBe(false);
  });

  it('a page counts once', () => {
    expect(hasFreshPassSince(turns([...range(1, 26), ...range(1, 26)]), SINCE, 200)).toBe(false);
  });
});
