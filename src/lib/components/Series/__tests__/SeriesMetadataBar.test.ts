import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import { createEmptySeriesMetadata } from '$lib/metadata/types';

// vi.hoisted: `vi.mock` factories are hoisted above all other top-level code
// (including plain `const` declarations and — per this repo's established
// pattern in webdav-provider.test.ts / mega-core.test.ts — even above the
// module's own imports), so the store the factory closes over must be built
// here with a minimal hand-rolled Svelte store contract rather than via an
// imported `writable`.
const { seriesMetadataMap, noopStore } = vi.hoisted(() => {
  function createStore<T>(initial: T) {
    let value = initial;
    const subs = new Set<(v: T) => void>();
    return {
      subscribe(fn: (v: T) => void) {
        subs.add(fn);
        fn(value);
        return () => subs.delete(fn);
      },
      set(v: T) {
        value = v;
        subs.forEach((fn) => fn(value));
      }
    };
  }
  // Neither cloudFiles nor activeProviderType is read by the component; a stub
  // `subscribe` satisfies the Svelte store contract without importing `writable`.
  return {
    seriesMetadataMap: createStore(new Map<string, unknown>()),
    noopStore: { subscribe: (fn: (v: unknown) => void) => (fn(undefined), () => {}) }
  };
});
vi.mock('$lib/metadata/store', () => ({
  seriesMetadataMap,
  updateSeriesMetadata: vi.fn(),
  unlinkSeries: vi.fn()
}));
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: { refreshSeriesSidecars: vi.fn(), cloudFiles: noopStore }
}));
vi.mock('$lib/util/sync', () => ({
  providerManager: { getActiveProvider: () => null, activeProviderType: noopStore }
}));
vi.mock('$lib/util', () => ({ showSnackbar: vi.fn() }));

import SeriesMetadataBar from '../SeriesMetadataBar.svelte';

describe('SeriesMetadataBar', () => {
  it('offers Link… when the series is not linked', () => {
    seriesMetadataMap.set(new Map());
    const { getByText, queryByText } = render(SeriesMetadataBar, {
      props: { seriesTitle: 'One Piece', volumes: [] }
    });
    expect(getByText('Link…')).toBeTruthy();
    expect(queryByText('AniList')).toBeNull();
  });

  it('shows alt titles and provider links when linked', () => {
    const meta = {
      ...createEmptySeriesMetadata('One Piece'),
      external_ids: { anilist: 30013, mal: 13 },
      titles: { native: 'ワンピース', romaji: 'ONE PIECE', english: 'One Piece' },
      tag: '[color]'
    };
    seriesMetadataMap.set(new Map([['one piece', meta]]));
    const { getByText, getByDisplayValue } = render(SeriesMetadataBar, {
      props: { seriesTitle: 'One Piece', volumes: [] }
    });
    const anilist = getByText('AniList') as HTMLAnchorElement;
    expect(anilist.closest('a')?.getAttribute('href')).toBe('https://anilist.co/manga/30013');
    expect(getByText('MyAnimeList').closest('a')?.getAttribute('href')).toBe(
      'https://myanimelist.net/manga/13'
    );
    expect(getByText(/ワンピース/)).toBeTruthy();
    expect(getByDisplayValue('[color]')).toBeTruthy();
    expect(getByText('Unlink')).toBeTruthy();
  });
});
