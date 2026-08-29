import { describe, it, expect } from 'vitest';
import type { SeriesMetadata } from './types';
import {
  hasAnyAltTitle,
  resolveDisplayBase,
  resolveDisplayTitle,
  seriesSearchTerms
} from './display-title';

function meta(overrides: Partial<SeriesMetadata> = {}): SeriesMetadata {
  return {
    series_key: 'one piece',
    series_title: 'One Piece',
    external_ids: { anilist: 30013, mal: 13 },
    titles: { native: 'ONE PIECE', romaji: 'ONE PIECE (romaji)', english: 'One Piece (en)' },
    synonyms: ['ワンピース', 'OP'],
    updated_at: '2026-08-16T00:00:00.000Z',
    ...overrides
  };
}

/**
 * A record as an older version of the app wrote it: no migration ran, so keys
 * the type no longer admits are still there in IndexedDB. Nothing may read them.
 */
function legacyMeta(extra: Record<string, unknown>): SeriesMetadata {
  return { ...meta(), ...extra } as unknown as SeriesMetadata;
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
    expect(resolveDisplayTitle('One Piece', meta(), 'english')).toBe('One Piece (en)');
  });

  it('ignores a legacy per-series title preference — title language is global-only', () => {
    // Nothing migrates the old records, so `title_preference` is still sitting in
    // IndexedDB on any series linked before it was dropped. Whatever it says —
    // a language, 'imported', or junk from a hand-edited sidecar — the global
    // setting is the only thing that decides.
    for (const stale of ['native', 'imported', 'klingon']) {
      const m = legacyMeta({ title_preference: stale });
      expect(resolveDisplayTitle('One Piece', m, 'english')).toBe('One Piece (en)');
      expect(resolveDisplayTitle('One Piece', m, 'imported')).toBe('One Piece');
    }
  });

  it('follows the Native progression: native → romaji → english → folder', () => {
    // native missing → romaji before english
    expect(
      resolveDisplayTitle('folder', meta({ titles: { romaji: 'R', english: 'E' } }), 'native')
    ).toBe('R');
    // native and romaji missing → english
    expect(resolveDisplayTitle('folder', meta({ titles: { english: 'E' } }), 'native')).toBe('E');
    // nothing at all → folder title
    expect(resolveDisplayTitle('folder', meta({ titles: {} }), 'native')).toBe('folder');
  });

  it('follows the English progression: english → romaji → native → folder', () => {
    // english missing → romaji before native
    expect(
      resolveDisplayTitle('folder', meta({ titles: { romaji: 'R', native: 'N' } }), 'english')
    ).toBe('R');
    // english and romaji missing → native
    expect(resolveDisplayTitle('folder', meta({ titles: { native: 'N' } }), 'english')).toBe('N');
    // nothing at all → folder title
    expect(resolveDisplayTitle('folder', meta({ titles: {} }), 'english')).toBe('folder');
  });

  it('treats blank language titles as missing', () => {
    expect(
      resolveDisplayTitle('folder', meta({ titles: { english: '   ', romaji: 'R' } }), 'english')
    ).toBe('R');
  });

  it('wraps the tag in parentheses, stripping a single pair of surrounding brackets — but only when the base came from an alt title', () => {
    // bracketed, parenthesized and bare tags all render identically
    expect(resolveDisplayTitle('One Piece', meta({ tag: '[color]' }), 'english')).toBe(
      'One Piece (en) (color)'
    );
    expect(resolveDisplayTitle('One Piece', meta({ tag: '(color)' }), 'english')).toBe(
      'One Piece (en) (color)'
    );
    expect(resolveDisplayTitle('One Piece', meta({ tag: 'color' }), 'english')).toBe(
      'One Piece (en) (color)'
    );
    // full-width bracket pairs are stripped too
    expect(resolveDisplayTitle('One Piece', meta({ tag: '（color）' }), 'english')).toBe(
      'One Piece (en) (color)'
    );
    expect(resolveDisplayTitle('One Piece', meta({ tag: '【color】' }), 'english')).toBe(
      'One Piece (en) (color)'
    );
  });

  it("withholds the tag for the 'imported' preference — the folder name already carries it", () => {
    expect(resolveDisplayTitle('One Piece', meta({ tag: '[color]' }), 'imported')).toBe(
      'One Piece'
    );
  });

  it('withholds the tag when the base falls back to the folder title (no alt titles at all)', () => {
    expect(resolveDisplayTitle('One Piece', meta({ titles: {}, tag: '[color]' }), 'english')).toBe(
      'One Piece'
    );
  });

  it('ignores an empty or whitespace-only tag', () => {
    expect(resolveDisplayTitle('One Piece', meta({ tag: '' }), 'english')).toBe('One Piece (en)');
    expect(resolveDisplayTitle('One Piece', meta({ tag: '   ' }), 'english')).toBe(
      'One Piece (en)'
    );
  });

  it('trims surrounding whitespace from the tag and keeps inner spacing', () => {
    expect(resolveDisplayTitle('One Piece', meta({ tag: '  bw scans ' }), 'english')).toBe(
      'One Piece (en) (bw scans)'
    );
  });

  it('keeps the raw tag verbatim for storage — only the DISPLAY string gets parens', () => {
    const m = meta({ tag: '[color]' });
    expect(m.tag).toBe('[color]');
    expect(resolveDisplayTitle('One Piece', m, 'english')).toBe('One Piece (en) (color)');
  });
});

describe('resolveDisplayBase', () => {
  it('is resolveDisplayTitle without the tag', () => {
    const m = meta({ tag: '[color]' });
    expect(resolveDisplayBase('One Piece', m, 'english')).toBe('One Piece (en)');
    expect(resolveDisplayTitle('One Piece', m, 'english')).toBe('One Piece (en) (color)');
  });

  it('follows the same global preference and progression rules', () => {
    expect(resolveDisplayBase('One Piece', meta(), 'imported')).toBe('One Piece');
    expect(resolveDisplayBase('folder', meta({ titles: { native: 'N' } }), 'english')).toBe('N');
    expect(resolveDisplayBase('folder', undefined, 'english')).toBe('folder');
  });

  it('ignores a legacy per-series title preference, whatever it holds', () => {
    expect(
      resolveDisplayBase('One Piece', legacyMeta({ title_preference: 'native' }), 'english')
    ).toBe('One Piece (en)');
    expect(resolveDisplayBase('One Piece', legacyMeta({ title_preference: '' }), 'native')).toBe(
      'ONE PIECE'
    );
  });
});

describe('seriesSearchTerms', () => {
  it('returns just the lowercased folder title without metadata', () => {
    expect(seriesSearchTerms('One Piece', undefined)).toEqual(['one piece']);
  });

  it('includes folder title, all language titles, synonyms and the raw tag, lowercased and de-duplicated', () => {
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

describe('hasAnyAltTitle', () => {
  it('is false for no record, blank titles and blank synonyms', () => {
    expect(hasAnyAltTitle(undefined)).toBe(false);
    expect(
      hasAnyAltTitle(
        meta({ titles: { native: ' ', romaji: '', english: undefined }, synonyms: ['', '  '] })
      )
    ).toBe(false);
    expect(hasAnyAltTitle(meta({ titles: {}, synonyms: [] }))).toBe(false);
  });

  it('is true with any one language title or a synonym', () => {
    expect(hasAnyAltTitle(meta({ titles: { romaji: 'X' }, synonyms: [] }))).toBe(true);
    expect(hasAnyAltTitle(meta({ titles: {}, synonyms: ['Y'] }))).toBe(true);
  });
});
