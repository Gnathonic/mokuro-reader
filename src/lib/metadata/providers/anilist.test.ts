import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AniListError,
  anilistProvider,
  anilistRequest,
  parseAniListIdInput,
  toSeriesMetadataPatch,
  _resetRateGuardForTests
} from './anilist';

const media = {
  id: 30013,
  idMal: 13,
  title: { romaji: 'ONE PIECE', english: 'One Piece', native: 'ONE PIECE' },
  synonyms: ['ワンピース', null],
  format: 'MANGA',
  status: 'RELEASING',
  chapters: null,
  volumes: null,
  startDate: { year: 1997 },
  coverImage: { medium: 'https://img/one-piece.jpg' },
  siteUrl: 'https://anilist.co/manga/30013'
};

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) }
  });
}

describe('anilist provider', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    _resetRateGuardForTests();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('search posts a GraphQL query and maps results', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { Page: { media: [media] } } }));
    const results = await anilistProvider.search('one piece');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://graphql.anilist.co');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body).variables).toEqual({ search: 'one piece' });
    expect(results).toEqual([
      {
        provider: 'anilist',
        id: 30013,
        idMal: 13,
        titles: { romaji: 'ONE PIECE', english: 'One Piece', native: 'ONE PIECE' },
        synonyms: ['ワンピース'],
        format: 'MANGA',
        status: 'RELEASING',
        year: 1997,
        coverUrl: 'https://img/one-piece.jpg',
        siteUrl: 'https://anilist.co/manga/30013'
      }
    ]);
  });

  it('search with a blank query returns [] without a request', async () => {
    expect(await anilistProvider.search('   ')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getById returns null on GraphQL not-found', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { Media: null }, errors: [{ message: 'Not Found.' }] }, { status: 404 })
    );
    expect(await anilistProvider.getById(1)).toBeNull();
  });

  it('sends the bearer token when given', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { Viewer: { id: 1 } } }));
    await anilistRequest('{ Viewer { id } }', {}, 'tok');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
  });

  it('maps 429 to RATE_LIMITED with Retry-After and blocks subsequent calls locally', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 429, headers: { 'Retry-After': '7' } }));
    await expect(anilistRequest('{ x }')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterMs: 7000
    });
    fetchMock.mockClear();
    await expect(anilistRequest('{ x }')).rejects.toBeInstanceOf(AniListError);
    expect(fetchMock).not.toHaveBeenCalled(); // guarded, no network
  });

  it('maps 401 to UNAUTHORIZED and fetch failure to NETWORK', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 401 }));
    await expect(anilistRequest('{ x }')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    fetchMock.mockRejectedValue(new TypeError('offline'));
    await expect(anilistRequest('{ x }')).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('maps a 400 "Invalid token" GraphQL body to UNAUTHORIZED, not GRAPHQL', async () => {
    // Verified against the live API: a revoked/invalid Bearer token is answered
    // with HTTP 400 and a GraphQL error, never a 401. Classifying it as GRAPHQL
    // would make the tracker drop the queued push and stay silent about the
    // dead session.
    fetchMock.mockResolvedValue(
      jsonResponse(
        { data: null, errors: [{ message: 'Invalid token', status: 400 }] },
        { status: 400 }
      )
    );
    await expect(anilistRequest('{ Viewer { id } }', {}, 'stale')).rejects.toMatchObject({
      code: 'UNAUTHORIZED'
    });
  });

  it('keeps other GraphQL errors non-retryable', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { data: null, errors: [{ message: 'Not Found.', status: 404 }] },
        { status: 404 }
      )
    );
    await expect(anilistRequest('{ x }')).rejects.toMatchObject({ code: 'GRAPHQL' });
  });

  it('toSeriesMetadataPatch maps a result to record fields', () => {
    const r = {
      provider: 'anilist' as const,
      id: 30013,
      idMal: 13,
      titles: { english: 'One Piece' },
      synonyms: ['ワンピース'],
      format: 'MANGA',
      status: 'RELEASING',
      volumes: 110,
      chapters: 1100,
      coverUrl: 'https://img/x.jpg',
      siteUrl: 'https://anilist.co/manga/30013'
    };
    expect(toSeriesMetadataPatch(r)).toEqual({
      external_ids: { anilist: 30013, mal: 13 },
      titles: { english: 'One Piece' },
      synonyms: ['ワンピース'],
      format: 'MANGA',
      status: 'RELEASING',
      total_volumes: 110,
      total_chapters: 1100,
      cover_url: 'https://img/x.jpg'
    });
    const noMal = toSeriesMetadataPatch({ ...r, idMal: undefined });
    expect(noMal.external_ids).toEqual({ anilist: 30013 });
  });

  it('toSeriesMetadataPatch emits absent facts as explicit undefined so a re-link clears them', () => {
    const sparse = toSeriesMetadataPatch({
      provider: 'anilist' as const,
      id: 99999,
      titles: { romaji: 'Some Oneshot' },
      synonyms: [],
      siteUrl: 'https://anilist.co/manga/99999'
    });
    // Keys must be present (value undefined) — an omitted key would merge over the
    // previous link's record and leave its facts behind.
    for (const k of ['format', 'status', 'total_volumes', 'total_chapters', 'cover_url']) {
      expect(Object.keys(sparse)).toContain(k);
      expect(sparse[k as keyof typeof sparse]).toBeUndefined();
    }
  });

  it('parseAniListIdInput accepts a bare id or an anilist manga URL', () => {
    expect(parseAniListIdInput(' 30013 ')).toBe(30013);
    expect(parseAniListIdInput('https://anilist.co/manga/30013/ONE-PIECE/')).toBe(30013);
    expect(parseAniListIdInput('https://myanimelist.net/manga/13')).toBeUndefined();
    expect(parseAniListIdInput('one piece')).toBeUndefined();
  });
});
