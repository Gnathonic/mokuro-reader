import type { MetadataProvider, MetadataSearchResult } from '../provider-interface';
import type { SeriesMetadataPatch } from '../store';

const ENDPOINT = 'https://graphql.anilist.co';

export type AniListErrorCode = 'RATE_LIMITED' | 'UNAUTHORIZED' | 'NETWORK' | 'GRAPHQL';

export class AniListError extends Error {
  constructor(
    public code: AniListErrorCode,
    message: string,
    public retryAfterMs?: number
  ) {
    super(message);
    this.name = 'AniListError';
  }
}

// ---- rate guard (30 req/min while AniList is degraded; honor server hints) ----
let blockedUntil = 0;
export function _resetRateGuardForTests(): void {
  blockedUntil = 0;
}

/**
 * POST a GraphQL document. Throws AniListError; never returns partial data.
 * `token` adds `Authorization: Bearer` (mutations / viewer queries — Plan C).
 */
export async function anilistRequest<T>(
  query: string,
  variables: Record<string, unknown> = {},
  token?: string | null,
  signal?: AbortSignal
): Promise<T> {
  const now = Date.now();
  if (now < blockedUntil) {
    throw new AniListError('RATE_LIMITED', 'AniList rate limit reached', blockedUntil - now);
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
      signal
    });
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    throw new AniListError('NETWORK', 'Could not reach AniList');
  }

  if (res.status === 429) {
    const retrySec = Number(res.headers.get('Retry-After') ?? '60');
    const retryAfterMs = (Number.isFinite(retrySec) ? retrySec : 60) * 1000;
    blockedUntil = Date.now() + retryAfterMs;
    throw new AniListError('RATE_LIMITED', 'AniList rate limit reached', retryAfterMs);
  }
  if (res.status === 401 || res.status === 403) {
    throw new AniListError('UNAUTHORIZED', 'AniList rejected the session');
  }

  const remaining = Number(res.headers.get('X-RateLimit-Remaining'));
  const resetEpoch = Number(res.headers.get('X-RateLimit-Reset'));
  if (remaining === 0 && Number.isFinite(resetEpoch) && resetEpoch > 0) {
    blockedUntil = resetEpoch * 1000;
  }

  let json: { data?: T; errors?: { message?: string; status?: number }[] } | null = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (json?.errors?.length) {
    // A revoked or malformed Bearer token does NOT come back as 401/403: AniList
    // answers `400 {"errors":[{"message":"Invalid token","status":400}]}`, which
    // would otherwise be classified as a permanent GRAPHQL failure — the tracker
    // would drop the queued intent and the user would never be told to reconnect.
    if (json.errors.some((e) => /invalid token/i.test(e?.message ?? ''))) {
      throw new AniListError('UNAUTHORIZED', 'AniList rejected the session');
    }
    throw new AniListError('GRAPHQL', json.errors[0]?.message ?? 'AniList error');
  }
  if (!res.ok || !json?.data) {
    throw new AniListError('NETWORK', `AniList HTTP ${res.status}`);
  }
  return json.data;
}

// ---- queries ----
const MEDIA_FIELDS = `
  id idMal
  title { romaji english native }
  synonyms format status chapters volumes
  startDate { year }
  coverImage { medium }
  siteUrl`;

const SEARCH_QUERY = `query ($search: String) {
  Page(perPage: 10) {
    media(search: $search, type: MANGA, sort: SEARCH_MATCH) { ${MEDIA_FIELDS} }
  }
}`;

const BY_ID_QUERY = `query ($id: Int) {
  Media(id: $id, type: MANGA) { ${MEDIA_FIELDS} }
}`;

interface RawMedia {
  id: number;
  idMal: number | null;
  title: { romaji: string | null; english: string | null; native: string | null };
  synonyms: (string | null)[] | null;
  format: string | null;
  status: string | null;
  chapters: number | null;
  volumes: number | null;
  startDate: { year: number | null } | null;
  coverImage: { medium: string | null } | null;
  siteUrl: string;
}

function toResult(m: RawMedia): MetadataSearchResult {
  const titles: MetadataSearchResult['titles'] = {};
  if (m.title?.native) titles.native = m.title.native;
  if (m.title?.romaji) titles.romaji = m.title.romaji;
  if (m.title?.english) titles.english = m.title.english;
  const out: MetadataSearchResult = {
    provider: 'anilist',
    id: m.id,
    titles,
    synonyms: (m.synonyms ?? []).filter(
      (s): s is string => typeof s === 'string' && s.trim() !== ''
    ),
    siteUrl: m.siteUrl || `https://anilist.co/manga/${m.id}`
  };
  if (m.idMal != null) out.idMal = m.idMal;
  if (m.format) out.format = m.format;
  if (m.status) out.status = m.status;
  if (m.startDate?.year != null) out.year = m.startDate.year;
  if (m.volumes != null) out.volumes = m.volumes;
  if (m.chapters != null) out.chapters = m.chapters;
  if (m.coverImage?.medium) out.coverUrl = m.coverImage.medium;
  return out;
}

export const anilistProvider: MetadataProvider = {
  id: 'anilist',
  async search(query, signal) {
    const search = query.trim();
    if (!search) return [];
    const data = await anilistRequest<{ Page: { media: RawMedia[] } }>(
      SEARCH_QUERY,
      { search },
      null,
      signal
    );
    return (data.Page?.media ?? []).map(toResult);
  },
  async getById(id) {
    try {
      const data = await anilistRequest<{ Media: RawMedia | null }>(BY_ID_QUERY, { id });
      return data.Media ? toResult(data.Media) : null;
    } catch (error) {
      if (error instanceof AniListError && error.code === 'GRAPHQL') return null;
      throw error;
    }
  },
  siteUrl(id) {
    return `https://anilist.co/manga/${id}`;
  }
};

/**
 * Fields to write into the SeriesMetadata record when the user picks a result:
 * the FACTS, and nothing else.
 *
 * Each one is written whole, so a "Change" over an existing record replaces the
 * previous link's ids/titles/synonyms instead of merging into them.
 *
 * The display data a result also carries (`format`, `status`, volume/chapter
 * totals, cover art) is deliberately not stored — it belongs to AniList, it goes
 * stale, and the two places that want it have it already: the link picker shows
 * it straight off the search result, and the tracker fetches the totals in the
 * request it makes anyway.
 */
export function toSeriesMetadataPatch(r: MetadataSearchResult): SeriesMetadataPatch {
  return {
    external_ids: r.idMal != null ? { anilist: r.id, mal: r.idMal } : { anilist: r.id },
    titles: { ...r.titles },
    synonyms: [...r.synonyms]
  };
}

/** "30013" or "https://anilist.co/manga/30013/One-Piece/" → 30013 */
export function parseAniListIdInput(input: string): number | undefined {
  const s = input.trim();
  if (/^\d+$/.test(s)) return Number(s);
  const m = s.match(/anilist\.co\/manga\/(\d+)/i);
  return m ? Number(m[1]) : undefined;
}
