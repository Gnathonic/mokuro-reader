import { describe, expect, it } from 'vitest';
import { normalizeSeriesKey } from './series-key';
import { createEmptySeriesMetadata } from './types';

describe('normalizeSeriesKey', () => {
  it('trims, collapses whitespace and lowercases', () => {
    expect(normalizeSeriesKey('  One   Piece  ')).toBe('one piece');
    expect(normalizeSeriesKey('ONE\tPIECE')).toBe('one piece');
  });

  it('is idempotent', () => {
    const once = normalizeSeriesKey('  Yotsuba&!  ');
    expect(normalizeSeriesKey(once)).toBe(once);
  });
});

describe('createEmptySeriesMetadata', () => {
  it('keys the record by the normalized title and starts unlinked', () => {
    const meta = createEmptySeriesMetadata('  One Piece ', '2026-08-16T00:00:00.000Z');
    expect(meta.series_key).toBe('one piece');
    expect(meta.series_title).toBe('  One Piece ');
    expect(meta.external_ids).toEqual({});
    expect(meta.titles).toEqual({});
    expect(meta.synonyms).toEqual([]);
    expect(meta.updated_at).toBe('2026-08-16T00:00:00.000Z');
  });
});
