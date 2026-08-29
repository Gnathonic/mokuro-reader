import type { SeriesExternalIds } from './types';

export interface LinkTarget {
  provider: 'anilist' | 'mal';
  label: string;
  url: string;
}

/** Outbound links for the known external ids (MAL is link-out only: no browser-callable API). */
export function getLinkTargets(ids: SeriesExternalIds): LinkTarget[] {
  const out: LinkTarget[] = [];
  if (ids.anilist != null) {
    out.push({
      provider: 'anilist',
      label: 'AniList',
      url: `https://anilist.co/manga/${ids.anilist}`
    });
  }
  if (ids.mal != null) {
    out.push({
      provider: 'mal',
      label: 'MyAnimeList',
      url: `https://myanimelist.net/manga/${ids.mal}`
    });
  }
  return out;
}
