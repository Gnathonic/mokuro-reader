import { describe, expect, it } from 'vitest';
import { getLinkTargets } from './link-targets';

describe('getLinkTargets', () => {
  it('returns AniList and MAL links when ids are present, in that order', () => {
    expect(getLinkTargets({ anilist: 30013, mal: 13 })).toEqual([
      { provider: 'anilist', label: 'AniList', url: 'https://anilist.co/manga/30013' },
      { provider: 'mal', label: 'MyAnimeList', url: 'https://myanimelist.net/manga/13' }
    ]);
  });
  it('omits missing providers', () => {
    expect(getLinkTargets({ anilist: 1 })).toHaveLength(1);
    expect(getLinkTargets({})).toEqual([]);
  });
});
