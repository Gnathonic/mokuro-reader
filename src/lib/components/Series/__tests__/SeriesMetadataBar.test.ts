import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { createEmptySeriesMetadata } from '$lib/metadata/types';

// vi.hoisted: `vi.mock` factories are hoisted above all other top-level code
// (including plain `const` declarations and — per this repo's established
// pattern in webdav-provider.test.ts / mega-core.test.ts — even above the
// module's own imports), so the store the factory closes over must be built
// here with a minimal hand-rolled Svelte store contract rather than via an
// imported `writable`.
const { seriesMetadataMap, providerStatus, noopStore } = vi.hoisted(() => {
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
  // cloudFiles is not read by the component; a stub `subscribe` satisfies the
  // Svelte store contract without importing `writable`.
  return {
    seriesMetadataMap: createStore(new Map<string, unknown>()),
    providerStatus: createStore({
      providers: {},
      hasAnyAuthenticated: false,
      needsAttention: false,
      currentProviderType: null as string | null
    }),
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
// providerManager.status is the reactive store the component subscribes to for
// "is a cloud provider connected" — mirrors SeriesView.svelte's own usage.
vi.mock('$lib/util/sync', () => ({
  providerManager: { status: providerStatus }
}));
vi.mock('$lib/util', () => ({ showSnackbar: vi.fn() }));

import SeriesMetadataBar from '../SeriesMetadataBar.svelte';
import { showSnackbar } from '$lib/util';
import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';

describe('SeriesMetadataBar', () => {
  it('offers Link… when the series is not linked', () => {
    seriesMetadataMap.set(new Map());
    providerStatus.set({
      providers: {},
      hasAnyAuthenticated: false,
      needsAttention: false,
      currentProviderType: null
    });
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

  it('reports skipped volumes when a sidecar refresh has nothing backed up for some of them', async () => {
    providerStatus.set({
      providers: {},
      hasAnyAuthenticated: true,
      needsAttention: false,
      currentProviderType: 'google-drive'
    });
    seriesMetadataMap.set(new Map());
    vi.mocked(unifiedCloudManager.refreshSeriesSidecars).mockResolvedValue({
      succeeded: 1,
      failed: 0,
      skipped: 2
    });

    const { getByText } = render(SeriesMetadataBar, {
      props: { seriesTitle: 'One Piece', volumes: [] }
    });

    await fireEvent.click(getByText('Update cloud sidecars'));

    await waitFor(() => {
      expect(showSnackbar).toHaveBeenCalledWith(
        expect.stringContaining('Updated 1 cloud sidecar (2 skipped')
      );
    });
  });
});
