import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { createEmptySeriesMetadata } from '$lib/metadata/types';

// vi.hoisted: `vi.mock` factories are hoisted above all other top-level code
// (including plain `const` declarations and — per this repo's established
// pattern in webdav-provider.test.ts / mega-core.test.ts — even above the
// module's own imports), so the store the factory closes over must be built
// here with a minimal hand-rolled Svelte store contract rather than via an
// imported `writable`.
const { seriesMetadataMap, providerStatus, noopStore, preferredTitleLanguage } = vi.hoisted(() => {
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
      providers: {} as Record<string, { isReadOnly?: boolean }>,
      hasAnyAuthenticated: false,
      needsAttention: false,
      currentProviderType: null as string | null
    }),
    // The global preferred title language: the bar reads it to know which title the
    // header is already showing, so the subtitle can list the other ones.
    preferredTitleLanguage: createStore('imported'),
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
vi.mock('$lib/settings/settings', () => ({ preferredTitleLanguage }));

import SeriesMetadataBar from '../SeriesMetadataBar.svelte';
import { showSnackbar } from '$lib/util';
import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
import { updateSeriesMetadata } from '$lib/metadata/store';
import type { VolumeMetadata } from '$lib/types';

function volume(title: string, isPlaceholder = false): VolumeMetadata {
  return {
    volume_uuid: `uuid-${title}`,
    series_uuid: 'series-uuid',
    series_title: 'One Piece',
    volume_title: title,
    isPlaceholder
  } as VolumeMetadata;
}

const LINKED_TITLES = {
  native: 'ONE PIECE',
  romaji: 'One Piece (romaji)',
  english: 'One Piece (en)'
};

function linkedMeta(seriesTitle: string, overrides: Record<string, unknown> = {}) {
  return {
    ...createEmptySeriesMetadata(seriesTitle),
    external_ids: { anilist: 30013 },
    titles: LINKED_TITLES,
    ...overrides
  };
}

describe('SeriesMetadataBar', () => {
  beforeEach(() => {
    preferredTitleLanguage.set('imported');
  });

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
      props: { seriesTitle: 'One Piece', volumes: [volume('Vol 1'), volume('Vol 2')] }
    });

    await fireEvent.click(getByText('Update cloud sidecars'));

    await waitFor(() => {
      expect(showSnackbar).toHaveBeenCalledWith(
        expect.stringContaining('Updated 1 cloud sidecar (2 skipped')
      );
    });
  });

  it('disables the sidecar refresh on a read-only provider', () => {
    providerStatus.set({
      providers: { webdav: { isReadOnly: true } },
      hasAnyAuthenticated: true,
      needsAttention: false,
      currentProviderType: 'webdav'
    });
    seriesMetadataMap.set(new Map());

    const { getByText } = render(SeriesMetadataBar, {
      props: { seriesTitle: 'One Piece', volumes: [volume('Vol 1')] }
    });

    const button = getByText('Update cloud sidecars').closest('button')!;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('title')).toContain('read-only');
  });

  it('shows the title-language select at Default when there is no override', () => {
    providerStatus.set({
      providers: {},
      hasAnyAuthenticated: false,
      needsAttention: false,
      currentProviderType: null
    });
    seriesMetadataMap.set(new Map([['one piece', linkedMeta('One Piece')]]));
    const { getByDisplayValue } = render(SeriesMetadataBar, {
      props: { seriesTitle: 'One Piece', volumes: [] }
    });
    expect(getByDisplayValue('Default (global setting)')).toBeTruthy();
  });

  it('hides the title-language select on an unlinked series', () => {
    // Nothing to choose between: every option resolves back to the folder name.
    seriesMetadataMap.set(new Map());
    const { queryByText } = render(SeriesMetadataBar, {
      props: { seriesTitle: 'One Piece', volumes: [] }
    });
    expect(queryByText('Title language')).toBeNull();
  });

  it('shows the title-language select at the stored override', () => {
    const meta = linkedMeta('One Piece', { title_preference: 'native' as const });
    seriesMetadataMap.set(new Map([['one piece', meta]]));
    const { getByDisplayValue } = render(SeriesMetadataBar, {
      props: { seriesTitle: 'One Piece', volumes: [] }
    });
    expect(getByDisplayValue('Native (日本語)')).toBeTruthy();
  });

  it('clears the override by writing title_preference: undefined when the select goes back to Default', async () => {
    const meta = linkedMeta('One Piece', { title_preference: 'native' as const });
    seriesMetadataMap.set(new Map([['one piece', meta]]));
    const { getByDisplayValue } = render(SeriesMetadataBar, {
      props: { seriesTitle: 'One Piece', volumes: [] }
    });
    const select = getByDisplayValue('Native (日本語)') as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: 'default' } });
    expect(updateSeriesMetadata).toHaveBeenCalledWith('One Piece', {
      title_preference: undefined
    });
  });

  it('leaves the displayed language out of the alt-title subtitle and keeps the folder name', () => {
    // pref=english → the header shows "One Piece (en)", so the subtitle must show the
    // OTHER names: the folder title (still the on-disk/cloud identity) plus native+romaji.
    preferredTitleLanguage.set('english');
    seriesMetadataMap.set(new Map([['one piece raw', linkedMeta('One Piece Raw')]]));

    const { getByText, queryByText } = render(SeriesMetadataBar, {
      props: { seriesTitle: 'One Piece Raw', volumes: [] }
    });

    expect(getByText('One Piece Raw · ONE PIECE · One Piece (romaji)')).toBeTruthy();
    expect(queryByText(/One Piece \(en\)/)).toBeNull();
  });

  it('lists every language and no folder-name repeat when the folder title is displayed', () => {
    preferredTitleLanguage.set('imported');
    seriesMetadataMap.set(new Map([['one piece raw', linkedMeta('One Piece Raw')]]));

    const { getByText } = render(SeriesMetadataBar, {
      props: { seriesTitle: 'One Piece Raw', volumes: [] }
    });

    expect(getByText('ONE PIECE · One Piece (romaji) · One Piece (en)')).toBeTruthy();
  });

  it('honours a per-series title_preference when deciding what the subtitle omits', () => {
    preferredTitleLanguage.set('english');
    const meta = linkedMeta('One Piece Raw', { title_preference: 'native' as const });
    seriesMetadataMap.set(new Map([['one piece raw', meta]]));

    const { getByText } = render(SeriesMetadataBar, {
      props: { seriesTitle: 'One Piece Raw', volumes: [] }
    });

    // Header shows the native title → subtitle keeps folder + romaji + english
    expect(getByText('One Piece Raw · One Piece (romaji) · One Piece (en)')).toBeTruthy();
  });

  it('hides the sidecar refresh when every volume is a cloud placeholder', () => {
    providerStatus.set({
      providers: {},
      hasAnyAuthenticated: true,
      needsAttention: false,
      currentProviderType: 'google-drive'
    });
    seriesMetadataMap.set(new Map());

    const { queryByText } = render(SeriesMetadataBar, {
      props: { seriesTitle: 'One Piece', volumes: [volume('Vol 1', true)] }
    });

    // Nothing local to regenerate from — the action could only ever report
    // "No backed-up volumes to update".
    expect(queryByText('Update cloud sidecars')).toBeNull();
  });
});
