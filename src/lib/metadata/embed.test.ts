import { describe, expect, it } from 'vitest';
import { fromEmbedded, toEmbedded } from './embed';
import { createEmptySeriesMetadata } from './types';

describe('toEmbedded', () => {
  it('returns undefined for missing/empty metadata (nothing worth embedding)', () => {
    expect(toEmbedded(undefined)).toBeUndefined();
    expect(toEmbedded(null)).toBeUndefined();
    expect(toEmbedded(createEmptySeriesMetadata('X'))).toBeUndefined();
  });

  it('emits only facts + tag, never preferences/tracking', () => {
    const meta = {
      ...createEmptySeriesMetadata('One Piece', '2026-08-16T00:00:00.000Z'),
      external_ids: { anilist: 30013, mal: 13 },
      titles: { native: 'ONE PIECE', english: 'One Piece' },
      synonyms: ['ワンピース'],
      tag: '  [color] ',
      title_preference: 'native' as const,
      read_count: 3,
      tracking: { enabled: true, unit: 'volumes' as const }
    };
    expect(toEmbedded(meta)).toEqual({
      external_ids: { anilist: 30013, mal: 13 },
      titles: { native: 'ONE PIECE', english: 'One Piece' },
      synonyms: ['ワンピース'],
      tag: '[color]',
      updated_at: '2026-08-16T00:00:00.000Z'
    });
  });

  it('embeds a tag-only record (unlinked but tagged)', () => {
    const meta = { ...createEmptySeriesMetadata('X', '2026-08-16T00:00:00.000Z'), tag: '[bw]' };
    expect(toEmbedded(meta)).toEqual({
      external_ids: {},
      titles: {},
      synonyms: [],
      tag: '[bw]',
      updated_at: '2026-08-16T00:00:00.000Z'
    });
  });
});

describe('fromEmbedded', () => {
  it('rejects non-objects and missing/invalid updated_at', () => {
    expect(fromEmbedded(undefined)).toBeUndefined();
    expect(fromEmbedded('nope')).toBeUndefined();
    expect(fromEmbedded({})).toBeUndefined();
    expect(fromEmbedded({ updated_at: 'not a date' })).toBeUndefined();
  });

  it('accepts a full block and drops junk fields/values', () => {
    expect(
      fromEmbedded({
        external_ids: { anilist: 30013, mal: '13', bogus: 1 },
        titles: { native: 'ONE PIECE', english: '', romaji: 42 },
        synonyms: ['ワンピース', 7, null],
        tag: ' [color] ',
        tracking: { enabled: true },
        updated_at: '2026-08-16T00:00:00.000Z'
      })
    ).toEqual({
      external_ids: { anilist: 30013 },
      titles: { native: 'ONE PIECE' },
      synonyms: ['ワンピース'],
      tag: '[color]',
      updated_at: '2026-08-16T00:00:00.000Z'
    });
  });

  it('round-trips toEmbedded output', () => {
    const meta = {
      ...createEmptySeriesMetadata('One Piece', '2026-08-16T00:00:00.000Z'),
      external_ids: { anilist: 30013 },
      titles: { romaji: 'ONE PIECE' },
      synonyms: [],
      tag: '[color]'
    };
    const embedded = toEmbedded(meta)!;
    expect(fromEmbedded(JSON.parse(JSON.stringify(embedded)))).toEqual(embedded);
  });
});
