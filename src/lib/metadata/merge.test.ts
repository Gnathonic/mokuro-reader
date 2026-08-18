import { describe, expect, it, vi } from 'vitest';
import { mergeSeriesMetadata, sanitizeCloudSeriesMetadata } from './merge';
import { sanitizeSpineOffset, sanitizeTracking, sanitizeVolumeOffsets } from './sanitize';
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
      number_overrides: { 'uuid-a': 12 },
      last_pushed: { n: 12, status: 'CURRENT', at: '2026-08-15T10:00:00.000Z' }
    };
    expect(sanitizeTracking(tracking)).toEqual(tracking);
  });

  it('drops the legacy enable flag and unit, and bad overrides/last_pushed', () => {
    // `enabled`/`unit` moved out of the block: pushing is one global setting and
    // the unit is a top-level fact.
    expect(
      sanitizeTracking({
        enabled: 1,
        unit: 'pages',
        number_overrides: { keep: 3, zero: 0, negative: -1, infinite: Infinity, text: '5' },
        last_pushed: { n: 4, status: 42, at: '2026-08-15T10:00:00.000Z' }
      })
    ).toEqual({ number_overrides: { keep: 3 } });
    expect(sanitizeTracking({ enabled: true, unit: 'chapters' })).toBeUndefined();
  });

  it('is undefined when nothing usable survives', () => {
    expect(sanitizeTracking({ number_overrides: { bad: -1 } })).toBeUndefined();
    expect(sanitizeTracking({ number_overrides: 'nope' })).toBeUndefined();
    expect(sanitizeTracking('nope')).toBeUndefined();
  });

  it('drops fractional overrides — AniList progress is a GraphQL Int', () => {
    expect(sanitizeTracking({ number_overrides: { keep: 3, half: 2.5, tiny: 0.5 } })).toEqual({
      number_overrides: { keep: 3 }
    });
  });

  it('drops a last_pushed that is missing a field or is not an object', () => {
    expect(
      sanitizeTracking({ number_overrides: { keep: 3 }, last_pushed: { n: 4, status: 'CURRENT' } })
    ).toEqual({ number_overrides: { keep: 3 } });
    expect(sanitizeTracking({ number_overrides: { keep: 3 }, last_pushed: 'yesterday' })).toEqual({
      number_overrides: { keep: 3 }
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
    expect(result.a.tracking).toEqual({ number_overrides: { good: 4 } });
    expect(Object.keys(result.b)).not.toContain('tracking');
  });

  it('lifts a legacy per-series tracking unit to the top level', () => {
    // Records written before the unit became a shared fact carry it inside
    // `tracking`; the correction must survive the move, but never override a
    // unit already stated at the top level.
    const entry = (over: Record<string, unknown>) => ({
      series_key: 'a',
      series_title: 'A',
      updated_at: '2026-01-01T00:00:00.000Z',
      ...over
    });
    expect(
      sanitizeCloudSeriesMetadata({ a: entry({ tracking: { enabled: true, unit: 'chapters' } }) }).a
        .unit
    ).toBe('chapters');
    expect(
      sanitizeCloudSeriesMetadata({
        a: entry({ unit: 'volumes', tracking: { unit: 'chapters' } })
      }).a.unit
    ).toBe('volumes');
    expect(
      Object.keys(sanitizeCloudSeriesMetadata({ a: entry({ tracking: { unit: 'pages' } }) }).a)
    ).not.toContain('unit');
  });

  it('keeps a known tracking unit and drops anything else', () => {
    const entry = (unit: unknown) => ({
      series_key: 'a',
      series_title: 'A',
      updated_at: '2026-01-01T00:00:00.000Z',
      unit
    });
    expect(sanitizeCloudSeriesMetadata({ a: entry('chapters') }).a.unit).toBe('chapters');
    expect(sanitizeCloudSeriesMetadata({ a: entry('volumes') }).a.unit).toBe('volumes');
    // A junk unit must fall back to auto-detection, not push chapter numbers
    // into the volume field (or the reverse).
    for (const junk of ['pages', 1, null, {}, '']) {
      expect(Object.keys(sanitizeCloudSeriesMetadata({ a: entry(junk) }).a)).not.toContain('unit');
    }
  });

  it('clamps the spine offset and drops junk values', () => {
    const entry = (spine_offset: unknown) => ({
      series_key: 'a',
      series_title: 'A',
      updated_at: '2026-01-01T00:00:00.000Z',
      spine_offset
    });
    expect(sanitizeCloudSeriesMetadata({ a: entry(3.5) }).a.spine_offset).toBe(3.5);
    // A wild value would blow the catalog stack far past the card.
    expect(sanitizeCloudSeriesMetadata({ a: entry(9000) }).a.spine_offset).toBe(50);
    expect(sanitizeCloudSeriesMetadata({ a: entry(-9000) }).a.spine_offset).toBe(-50);
    for (const junk of [Number.NaN, Infinity, '4', null, {}]) {
      expect(Object.keys(sanitizeCloudSeriesMetadata({ a: entry(junk) }).a)).not.toContain(
        'spine_offset'
      );
    }
  });

  it('clamps per-volume offsets and drops junk keys/values', () => {
    const result = sanitizeCloudSeriesMetadata({
      a: {
        series_key: 'a',
        series_title: 'A',
        updated_at: '2026-01-01T00:00:00.000Z',
        volume_offsets: {
          good: -12,
          huge: 99999,
          tiny: -99999,
          zero: 0,
          nan: Number.NaN,
          text: '4',
          '': 5
        }
      },
      b: {
        series_key: 'b',
        series_title: 'B',
        updated_at: '2026-01-01T00:00:00.000Z',
        volume_offsets: 'nope'
      },
      c: {
        series_key: 'c',
        series_title: 'C',
        updated_at: '2026-01-01T00:00:00.000Z',
        volume_offsets: { nan: Number.NaN }
      }
    });
    // A `0` is inert (the reader filters it) so it is left alone; junk keys/values go.
    expect(result.a.volume_offsets).toEqual({ good: -12, huge: 500, tiny: -500, zero: 0 });
    // A non-object, or an object with nothing valid left, means "no offsets".
    expect(Object.keys(result.b)).not.toContain('volume_offsets');
    expect(Object.keys(result.c)).not.toContain('volume_offsets');
  });

  it('sanitizeSpineOffset / sanitizeVolumeOffsets are usable on their own', () => {
    expect(sanitizeSpineOffset(0)).toBe(0);
    expect(sanitizeSpineOffset(51)).toBe(50);
    expect(sanitizeSpineOffset('51')).toBeUndefined();
    expect(sanitizeVolumeOffsets({ a: 1 })).toEqual({ a: 1 });
    expect(sanitizeVolumeOffsets({})).toBeUndefined();
    expect(sanitizeVolumeOffsets([1, 2])).toBeUndefined();
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

  it('normalizes facts_updated_at the same way, and drops it when unparsable', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T12:00:00.000Z'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const entry = (facts_updated_at: unknown) => ({
      series_key: 'a',
      series_title: 'A',
      external_ids: {},
      titles: {},
      synonyms: [],
      read_count: 0,
      updated_at: '2026-08-16T00:00:00.000Z',
      facts_updated_at
    });

    // It decides whose external link wins in series.json — same poison pills.
    expect(
      sanitizeCloudSeriesMetadata({ a: entry('Aug 16 2020 00:00:00 GMT+0000') }).a.facts_updated_at
    ).toBe('2020-08-16T00:00:00.000Z');
    expect(
      sanitizeCloudSeriesMetadata({ a: entry('2999-01-01T00:00:00.000Z') }).a.facts_updated_at
    ).toBe('2026-08-16T12:00:00.000Z');
    // Unparsable → the field disappears (readers fall back to `updated_at`),
    // the record itself is kept.
    const dropped = sanitizeCloudSeriesMetadata({ a: entry('whenever') }).a;
    expect('facts_updated_at' in dropped).toBe(false);
    expect(dropped.updated_at).toBe('2026-08-16T00:00:00.000Z');

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
