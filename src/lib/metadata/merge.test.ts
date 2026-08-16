import { describe, expect, it, vi } from 'vitest';
import { mergeSeriesMetadata, sanitizeCloudSeriesMetadata } from './merge';
import { sanitizeTracking } from './sanitize';
import { createEmptySeriesMetadata, type SeriesMetadata } from './types';

function rec(title: string, updated_at: string, tag?: string): SeriesMetadata {
  return { ...createEmptySeriesMetadata(title, updated_at), tag };
}

describe('mergeSeriesMetadata', () => {
  it('unions keys from both sides', () => {
    const merged = mergeSeriesMetadata(
      { a: rec('A', '2026-01-01T00:00:00.000Z') },
      { b: rec('B', '2026-01-01T00:00:00.000Z') }
    );
    expect(Object.keys(merged).sort()).toEqual(['a', 'b']);
  });

  it('newest updated_at wins per key', () => {
    const merged = mergeSeriesMetadata(
      { a: rec('A', '2026-01-01T00:00:00.000Z', 'local') },
      { a: rec('A', '2026-02-01T00:00:00.000Z', 'cloud') }
    );
    expect(merged.a.tag).toBe('cloud');
    const merged2 = mergeSeriesMetadata(
      { a: rec('A', '2026-03-01T00:00:00.000Z', 'local') },
      { a: rec('A', '2026-02-01T00:00:00.000Z', 'cloud') }
    );
    expect(merged2.a.tag).toBe('local');
  });

  it('tie keeps local', () => {
    const merged = mergeSeriesMetadata(
      { a: rec('A', '2026-01-01T00:00:00.000Z', 'local') },
      { a: rec('A', '2026-01-01T00:00:00.000Z', 'cloud') }
    );
    expect(merged.a.tag).toBe('local');
  });

  it('skips malformed cloud entries', () => {
    const merged = mergeSeriesMetadata(
      {},
      { a: { nope: true } as unknown as SeriesMetadata, b: rec('B', '2026-01-01T00:00:00.000Z') }
    );
    expect(Object.keys(merged)).toEqual(['b']);
  });

  it('does not mutate inputs', () => {
    const local = { a: rec('A', '2026-01-01T00:00:00.000Z', 'local') };
    const cloud = { a: rec('A', '2026-02-01T00:00:00.000Z', 'cloud') };
    mergeSeriesMetadata(local, cloud);
    expect(local.a.tag).toBe('local');
  });
});

describe('sanitizeTracking', () => {
  it('returns undefined for anything that is not a plain object', () => {
    for (const value of [undefined, null, 'nope', 7, [], true]) {
      expect(sanitizeTracking(value)).toBeUndefined();
    }
  });

  it('keeps a well-formed block verbatim', () => {
    const tracking = {
      enabled: true,
      unit: 'chapters' as const,
      number_overrides: { 'uuid-a': 12 },
      last_pushed: { n: 12, status: 'CURRENT', at: '2026-08-15T10:00:00.000Z' }
    };
    expect(sanitizeTracking(tracking)).toEqual(tracking);
  });

  it('defaults enabled/unit and drops bad overrides and last_pushed', () => {
    expect(
      sanitizeTracking({
        enabled: 1,
        unit: 'pages',
        number_overrides: { keep: 3, zero: 0, negative: -1, infinite: Infinity, text: '5' },
        last_pushed: { n: 4, status: 42, at: '2026-08-15T10:00:00.000Z' }
      })
    ).toEqual({ enabled: false, unit: 'volumes', number_overrides: { keep: 3 } });
  });

  it('omits number_overrides entirely when nothing survives', () => {
    expect(
      sanitizeTracking({ enabled: true, unit: 'volumes', number_overrides: { bad: -1 } })
    ).toEqual({ enabled: true, unit: 'volumes' });
    expect(sanitizeTracking({ enabled: true, unit: 'volumes', number_overrides: 'nope' })).toEqual({
      enabled: true,
      unit: 'volumes'
    });
  });

  it('drops fractional overrides — AniList progress is a GraphQL Int', () => {
    expect(
      sanitizeTracking({
        enabled: true,
        unit: 'volumes',
        number_overrides: { keep: 3, half: 2.5, tiny: 0.5 }
      })
    ).toEqual({ enabled: true, unit: 'volumes', number_overrides: { keep: 3 } });
  });

  it('drops a last_pushed that is missing a field or is not an object', () => {
    expect(sanitizeTracking({ enabled: true, last_pushed: { n: 4, status: 'CURRENT' } })).toEqual({
      enabled: true,
      unit: 'volumes'
    });
    expect(sanitizeTracking({ enabled: true, last_pushed: 'yesterday' })).toEqual({
      enabled: true,
      unit: 'volumes'
    });
  });
});

describe('sanitizeCloudSeriesMetadata', () => {
  it('passes through a valid record unchanged', () => {
    const valid = rec('A', '2026-01-01T00:00:00.000Z', 'tag');
    const result = sanitizeCloudSeriesMetadata({ a: valid });
    expect(result.a).toEqual(valid);
  });

  it('drops an entry missing series_key/updated_at and logs once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = sanitizeCloudSeriesMetadata({
      a: { nope: true },
      b: rec('B', '2026-01-01T00:00:00.000Z')
    });
    expect(Object.keys(result)).toEqual(['b']);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('coerces missing/malformed arrays and objects to safe defaults', () => {
    const raw = {
      a: {
        series_key: 'a',
        series_title: 'A',
        updated_at: '2026-01-01T00:00:00.000Z',
        external_ids: 'nope',
        titles: null,
        synonyms: 'not-an-array',
        read_count: -5
      }
    };
    const result = sanitizeCloudSeriesMetadata(raw);
    expect(result.a.external_ids).toEqual({});
    expect(result.a.titles).toEqual({});
    expect(result.a.synonyms).toEqual([]);
    expect(result.a.read_count).toBe(0);
  });

  it('coerces a non-integer/non-finite/negative read_count to 0 and keeps a valid one', () => {
    const raw = {
      a: {
        series_key: 'a',
        series_title: 'A',
        updated_at: '2026-01-01T00:00:00.000Z',
        external_ids: {},
        titles: {},
        synonyms: [],
        read_count: Infinity
      },
      b: {
        series_key: 'b',
        series_title: 'B',
        updated_at: '2026-01-01T00:00:00.000Z',
        external_ids: {},
        titles: {},
        synonyms: [],
        read_count: 3
      }
    };
    const result = sanitizeCloudSeriesMetadata(raw);
    expect(result.a.read_count).toBe(0);
    expect(result.b.read_count).toBe(3);
    // A fraction is not a count of finished passes either.
    expect(sanitizeCloudSeriesMetadata({ a: { ...raw.a, read_count: 2.5 } }).a.read_count).toBe(0);
  });

  it('validates the tracking block field by field', () => {
    const result = sanitizeCloudSeriesMetadata({
      a: {
        series_key: 'a',
        series_title: 'A',
        updated_at: '2026-01-01T00:00:00.000Z',
        tracking: {
          enabled: 'yes',
          unit: 'pages',
          number_overrides: { good: 4, zero: 0, negative: -2, nan: 'x' },
          last_pushed: { n: 'two', status: 'CURRENT', at: '2026-01-01T00:00:00.000Z' }
        }
      },
      b: {
        series_key: 'b',
        series_title: 'B',
        updated_at: '2026-01-01T00:00:00.000Z',
        tracking: 'nope'
      }
    });
    expect(result.a.tracking).toEqual({
      enabled: false,
      unit: 'volumes',
      number_overrides: { good: 4 }
    });
    expect(Object.keys(result.b)).not.toContain('tracking');
  });

  it('keeps reread_prompt_suppressed only when it is a boolean', () => {
    const entry = (reread_prompt_suppressed: unknown) => ({
      series_key: 'a',
      series_title: 'A',
      updated_at: '2026-01-01T00:00:00.000Z',
      reread_prompt_suppressed
    });
    expect(sanitizeCloudSeriesMetadata({ a: entry(true) }).a.reread_prompt_suppressed).toBe(true);
    expect(sanitizeCloudSeriesMetadata({ a: entry(false) }).a.reread_prompt_suppressed).toBe(false);
    // Truthy junk would read as "never offer this series a restart again".
    expect(Object.keys(sanitizeCloudSeriesMetadata({ a: entry('yes') }).a)).not.toContain(
      'reread_prompt_suppressed'
    );
    expect(Object.keys(sanitizeCloudSeriesMetadata({ a: entry(1) }).a)).not.toContain(
      'reread_prompt_suppressed'
    );
  });

  it('returns {} for a non-object root', () => {
    expect(sanitizeCloudSeriesMetadata(null)).toEqual({});
    expect(sanitizeCloudSeriesMetadata(undefined)).toEqual({});
    expect(sanitizeCloudSeriesMetadata('nope')).toEqual({});
    expect(sanitizeCloudSeriesMetadata([1, 2, 3])).toEqual({});
  });

  it('drops bad values inside external_ids/titles/synonyms without dropping the entry', () => {
    // A non-string title used to survive and blow up normalizeSeriesKey(42) inside
    // SeriesMetadataBar's $derived, breaking the whole series page.
    const result = sanitizeCloudSeriesMetadata({
      a: {
        series_key: 'a',
        series_title: 'A',
        updated_at: '2026-01-01T00:00:00.000Z',
        external_ids: { anilist: 30013, mal: '13', bogus: 5 },
        titles: { native: 42, romaji: '  ', english: 'A' },
        synonyms: ['ok', 7, null, ''],
        tag: 99,
        read_count: 2
      }
    });
    expect(Object.keys(result)).toEqual(['a']);
    expect(result.a.external_ids).toEqual({ anilist: 30013 });
    expect(result.a.titles).toEqual({ english: 'A' });
    expect(result.a.synonyms).toEqual(['ok']);
    expect(Object.keys(result.a)).not.toContain('tag');
    expect(result.a.read_count).toBe(2);
  });

  it('keeps a known title_preference and drops an unknown one', () => {
    const result = sanitizeCloudSeriesMetadata({
      good: {
        series_key: 'good',
        series_title: 'Good',
        updated_at: '2026-01-01T00:00:00.000Z',
        title_preference: 'romaji'
      },
      bad: {
        series_key: 'bad',
        series_title: 'Bad',
        updated_at: '2026-01-01T00:00:00.000Z',
        // An unknown language is not 'imported', so it would silently send the series
        // down the english → romaji → native fallback chain forever.
        title_preference: 'klingon'
      },
      wrongType: {
        series_key: 'wrongType',
        series_title: 'Wrong',
        updated_at: '2026-01-01T00:00:00.000Z',
        title_preference: 42
      }
    });
    expect(result.good.title_preference).toBe('romaji');
    expect(Object.keys(result.bad)).not.toContain('title_preference');
    expect(Object.keys(result.wrongType)).not.toContain('title_preference');
  });

  it('drops an entry whose map key disagrees with its series_key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = sanitizeCloudSeriesMetadata({
      'wrong key': rec('A', '2026-01-01T00:00:00.000Z'),
      b: rec('B', '2026-01-01T00:00:00.000Z')
    });
    expect(Object.keys(result)).toEqual(['b']);
    warn.mockRestore();
  });

  it('normalizes updated_at, clamps far-future values and drops unparsable ones', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T12:00:00.000Z'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const entry = (updated_at: unknown) => ({
      series_key: 'a',
      series_title: 'A',
      external_ids: {},
      titles: {},
      synonyms: [],
      read_count: 0,
      updated_at
    });

    // A non-ISO string would sort above every honest ISO timestamp.
    expect(
      sanitizeCloudSeriesMetadata({ a: entry('Aug 16 2020 00:00:00 GMT+0000') }).a.updated_at
    ).toBe('2020-08-16T00:00:00.000Z');
    expect(sanitizeCloudSeriesMetadata({ a: entry('2999-01-01T00:00:00.000Z') }).a.updated_at).toBe(
      '2026-08-16T12:00:00.000Z'
    );
    expect(sanitizeCloudSeriesMetadata({ a: entry('whenever') })).toEqual({});
    expect(sanitizeCloudSeriesMetadata({ a: entry(12345) })).toEqual({});

    warn.mockRestore();
    vi.useRealTimers();
  });

  it('a clamped cloud record no longer outranks a fresh local one', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T12:00:00.000Z'));
    const poisoned = { a: rec('A', '2999-01-01T00:00:00.000Z', 'cloud') };
    // A "fresh local" edit is stamped realistically: `nextTimestamp` in
    // store.ts stamps `max(now, existing + 1ms)`, so against the raw poison
    // pill (year 2999) even that realistic local edit still loses…
    const freshLocal = { a: rec('A', '2026-08-16T12:00:00.001Z', 'local') };
    expect(mergeSeriesMetadata(freshLocal, poisoned).a.tag).toBe('cloud');
    // …sanitized at the boundary, the poisoned record is clamped back to `now`…
    const cleaned = sanitizeCloudSeriesMetadata(poisoned);
    expect(cleaned.a.updated_at).toBe('2026-08-16T12:00:00.000Z');
    // …so the same realistic local stamp (1ms ahead of `now`, exactly what
    // `nextTimestamp` would produce for an edit made right after the clamp)
    // now wins on the next merge.
    expect(mergeSeriesMetadata(freshLocal, cleaned).a.tag).toBe('local');
    vi.useRealTimers();
  });
});
