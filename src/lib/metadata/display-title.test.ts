import { describe, it, expect } from 'vitest';
import type { SeriesMetadata } from './types';
import { resolveDisplayTitle, seriesSearchTerms } from './display-title';

function meta(overrides: Partial<SeriesMetadata> = {}): SeriesMetadata {
  return {
    series_key: 'one piece',
    series_title: 'One Piece',
    external_ids: { anilist: 30013, mal: 13 },
    titles: { native: 'ONE PIECE', romaji: 'ONE PIECE (romaji)', english: 'One Piece (en)' },
    synonyms: ['ワンピース', 'OP'],
    read_count: 0,
    updated_at: '2026-08-16T00:00:00.000Z',
    ...overrides
  };
}

describe('resolveDisplayTitle', () => {
  it('returns the folder title when there is no metadata', () => {
    expect(resolveDisplayTitle('One Piece', undefined, 'english')).toBe('One Piece');
  });

  it("returns the folder title for the 'imported' preference even when titles exist", () => {
    expect(resolveDisplayTitle('One Piece', meta(), 'imported')).toBe('One Piece');
  });

  it('returns the requested language when present', () => {
    expect(resolveDisplayTitle('One Piece', meta(), 'native')).toBe('ONE PIECE');
    expect(resolveDisplayTitle('One Piece', meta(), 'romaji')).toBe('ONE PIECE (romaji)');
    expect(resolveDisplayTitle('One Piece', meta(), 'english')).toBe('One Piece (en)');
  });

  it('per-series title_preference overrides the global preference', () => {
    const m = meta({ title_preference: 'native' });
    expect(resolveDisplayTitle('One Piece', m, 'english')).toBe('ONE PIECE');
  });

  it("per-series 'imported' override beats a global language preference", () => {
    const m = meta({ title_preference: 'imported' });
    expect(resolveDisplayTitle('One Piece', m, 'english')).toBe('One Piece');
  });

  it('falls back english → romaji → native → folder title when the requested language is missing', () => {
    // english missing → romaji
    expect(
      resolveDisplayTitle('folder', meta({ titles: { romaji: 'R', native: 'N' } }), 'english')
    ).toBe('R');
    // native requested & missing → english first
    expect(
      resolveDisplayTitle('folder', meta({ titles: { romaji: 'R', english: 'E' } }), 'native')
    ).toBe('E');
    // romaji requested & missing, english missing → native
    expect(resolveDisplayTitle('folder', meta({ titles: { native: 'N' } }), 'romaji')).toBe('N');
    // nothing at all → folder title
    expect(resolveDisplayTitle('folder', meta({ titles: {} }), 'romaji')).toBe('folder');
  });

  it('treats blank language titles as missing', () => {
    expect(
      resolveDisplayTitle('folder', meta({ titles: { english: '   ', romaji: 'R' } }), 'english')
    ).toBe('R');
  });

  it('appends the tag with a single space, verbatim', () => {
    expect(resolveDisplayTitle('One Piece', meta({ tag: '[color]' }), 'imported')).toBe(
      'One Piece [color]'
    );
    expect(resolveDisplayTitle('One Piece', meta({ tag: '[color]' }), 'english')).toBe(
      'One Piece (en) [color]'
    );
  });

  it('ignores an empty or whitespace-only tag', () => {
    expect(resolveDisplayTitle('One Piece', meta({ tag: '' }), 'imported')).toBe('One Piece');
    expect(resolveDisplayTitle('One Piece', meta({ tag: '   ' }), 'imported')).toBe('One Piece');
  });

  it('trims surrounding whitespace from the tag but keeps inner spacing', () => {
    expect(resolveDisplayTitle('One Piece', meta({ tag: '  bw scans ' }), 'imported')).toBe(
      'One Piece bw scans'
    );
  });
});

describe('seriesSearchTerms', () => {
  it('returns just the lowercased folder title without metadata', () => {
    expect(seriesSearchTerms('One Piece', undefined)).toEqual(['one piece']);
  });

  it('includes folder title, all language titles, synonyms and tag, lowercased and de-duplicated', () => {
    const terms = seriesSearchTerms('One Piece', meta({ tag: '[Color]' }));
    expect(new Set(terms)).toEqual(
      new Set(['one piece', 'one piece (romaji)', 'one piece (en)', 'ワンピース', 'op', '[color]'])
    );
    // 'ONE PIECE' (native) lowercases to 'one piece' and must not appear twice
    expect(terms.filter((t) => t === 'one piece')).toHaveLength(1);
  });

  it('drops blank entries', () => {
    const terms = seriesSearchTerms(
      '  ',
      meta({ titles: { english: ' ' }, synonyms: ['', 'x'], tag: ' ' })
    );
    expect(terms).toEqual(['x']);
  });
});
