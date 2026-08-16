import { describe, expect, it, vi } from 'vitest';
import { mergeSeriesMetadata, sanitizeCloudSeriesMetadata } from './merge';
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

  it('coerces a non-finite/negative read_count to 0 and keeps a valid one', () => {
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
    // Raw, the poison pill wins against anything the user does…
    expect(
      mergeSeriesMetadata({ a: rec('A', '2026-08-16T12:00:01.000Z', 'local') }, poisoned).a.tag
    ).toBe('cloud');
    // …sanitized at the boundary, it is back in the present and loses.
    const cleaned = sanitizeCloudSeriesMetadata(poisoned);
    expect(cleaned.a.updated_at).toBe('2026-08-16T12:00:00.000Z');
    expect(
      mergeSeriesMetadata({ a: rec('A', '2026-08-16T12:00:01.000Z', 'local') }, cleaned).a.tag
    ).toBe('local');
    vi.useRealTimers();
  });
});
