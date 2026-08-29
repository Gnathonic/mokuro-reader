import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import { createEmptySeriesMetadata } from '$lib/metadata/types';

// vi.hoisted: `vi.mock` factories are hoisted above all other top-level code
// (including plain `const` declarations and — per this repo's established
// pattern in webdav-provider.test.ts / mega-core.test.ts — even above the
// module's own imports), so the store the factory closes over must be built
// here with a minimal hand-rolled Svelte store contract rather than via an
// imported `writable`.
const {
  seriesMetadataMap,
  preferredTitleLanguage,
  catalogSettings,
  anilistConnected,
  volumesData,
  seriesReadingState,
  computeLocalPassState
} = vi.hoisted(() => {
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
  return {
    seriesMetadataMap: createStore(new Map<string, unknown>()),
    // The global preferred title language: the bar reads it to know which title the
    // header is already showing, so the subtitle can list the other ones.
    preferredTitleLanguage: createStore('imported'),
    // Tracking is on when the account is connected and the global switch allows
    // it — there is no per-series flag to read any more.
    catalogSettings: createStore<{ pushProgressToAniList: boolean } | undefined>({
      pushProgressToAniList: true
    }),
    anilistConnected: createStore(true),
    volumesData: createStore<Record<string, { completed?: boolean }>>({}),
    // The read count and the push bookkeeping are per-user state: they come
    // from the reading-state store, never from the shared series record.
    seriesReadingState: createStore<Record<string, any>>({}),
    // The read-only bar delegates the "Read N times" figure to the progress tracker's
    // pure helper; the component test only needs to prove it renders what comes back.
    computeLocalPassState: vi.fn(() => ({
      passProgress: 0,
      allCompleted: false,
      passComplete: false,
      timesRead: 0,
      rereading: false
    }))
  };
});
vi.mock('$lib/metadata/store', () => ({ seriesMetadataMap }));
vi.mock('$lib/settings/settings', () => ({ preferredTitleLanguage, catalogSettings }));
vi.mock('$lib/metadata/anilist-auth', () => ({ anilistConnected }));
vi.mock('$lib/settings/volume-data', () => ({ volumes: volumesData }));
vi.mock('$lib/settings/series-data', () => ({
  seriesReadingState,
  readingStateFor: (states: Record<string, any>, key: string) =>
    states[key] ?? { read_count: 0, lastUpdated: new Date(0).toISOString() }
}));
vi.mock('$lib/metadata/progress-tracker', () => ({ computeLocalPassState }));

import SeriesMetadataBar from '../SeriesMetadataBar.svelte';
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

/** Seed the series' reading state (read count, push bookkeeping). */
function setReadingState(state: Record<string, unknown>) {
  seriesReadingState.set({
    'one piece': { read_count: 0, lastUpdated: new Date(0).toISOString(), ...state }
  });
}

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
    catalogSettings.set({ pushProgressToAniList: true });
    anilistConnected.set(true);
    seriesReadingState.set({});
    computeLocalPassState.mockReturnValue({
      passProgress: 0,
      allCompleted: false,
      passComplete: false,
      timesRead: 0,
      rereading: false
    });
  });

  it('renders no editing controls — the pencil in SeriesView opens the editor modal instead', () => {
    seriesMetadataMap.set(new Map([['one piece', linkedMeta('One Piece')]]));
    const { queryByText, container } = render(SeriesMetadataBar, {
      props: { seriesTitle: 'One Piece', volumes: [volume('Vol 1')] }
    });
    expect(queryByText('Tag')).toBeNull();
    expect(container.querySelector('input[placeholder="color"]')).toBeNull();
    expect(queryByText('Link…')).toBeNull();
    expect(queryByText('Change')).toBeNull();
    expect(queryByText('Unlink')).toBeNull();
    expect(queryByText('Title language')).toBeNull();
    expect(queryByText('Sync now')).toBeNull();
    expect(queryByText('Restart series…')).toBeNull();
    expect(queryByText('Update cloud sidecars')).toBeNull();
  });

  it('shows nothing but the read count when the series is not linked', () => {
    seriesMetadataMap.set(new Map());
    const { getByText, queryByText } = render(SeriesMetadataBar, {
      props: { seriesTitle: 'One Piece', volumes: [] }
    });
    expect(queryByText('AniList')).toBeNull();
    expect(queryByText(/Tracking/)).toBeNull();
    expect(getByText('Read 0 times')).toBeTruthy();
  });

  it('shows alt titles and provider link-out chips with hrefs when linked', () => {
    const meta = {
      ...createEmptySeriesMetadata('One Piece'),
      external_ids: { anilist: 30013, mal: 13 },
      titles: { native: 'ワンピース', romaji: 'ONE PIECE', english: 'One Piece' },
      tag: '[color]'
    };
    seriesMetadataMap.set(new Map([['one piece', meta]]));
    const { getByText } = render(SeriesMetadataBar, {
      props: { seriesTitle: 'One Piece', volumes: [] }
    });
    const anilist = getByText('AniList').closest('a');
    expect(anilist?.getAttribute('href')).toBe('https://anilist.co/manga/30013');
    expect(anilist?.getAttribute('target')).toBe('_blank');
    expect(anilist?.getAttribute('rel')).toContain('noopener');
    const mal = getByText('MyAnimeList').closest('a');
    expect(mal?.getAttribute('href')).toBe('https://myanimelist.net/manga/13');
    expect(getByText(/ワンピース/)).toBeTruthy();
  });

  it('shows "Read 1 time" for a fully-read single-volume series', () => {
    computeLocalPassState.mockReturnValue({
      passProgress: 1,
      allCompleted: true,
      passComplete: false,
      timesRead: 1,
      rereading: false
    });
    seriesMetadataMap.set(new Map());
    const { getByText } = render(SeriesMetadataBar, {
      props: { seriesTitle: 'One Piece', volumes: [volume('Vol 1')] }
    });
    expect(getByText('Read 1 time')).toBeTruthy();
  });

  it('shows "Tracking off" when the global push switch is off', () => {
    catalogSettings.set({ pushProgressToAniList: false });
    seriesMetadataMap.set(new Map([['one piece', linkedMeta('One Piece')]]));
    const { getByText } = render(SeriesMetadataBar, {
      props: { seriesTitle: 'One Piece', volumes: [] }
    });
    expect(getByText('Tracking off')).toBeTruthy();
  });

  it('shows "Tracking off" when the AniList account is not connected', () => {
    anilistConnected.set(false);
    seriesMetadataMap.set(new Map([['one piece', linkedMeta('One Piece')]]));
    const { getByText } = render(SeriesMetadataBar, {
      props: { seriesTitle: 'One Piece', volumes: [] }
    });
    expect(getByText('Tracking off')).toBeTruthy();
  });

  it('shows "Tracking on" for a linked series with no per-series flag at all', () => {
    seriesMetadataMap.set(new Map([['one piece', linkedMeta('One Piece')]]));
    const { getByText, queryByText } = render(SeriesMetadataBar, {
      props: { seriesTitle: 'One Piece', volumes: [] }
    });
    expect(getByText('Tracking on')).toBeTruthy();
    expect(queryByText(/last pushed/)).toBeNull();
  });

  it('shows the last-pushed volume and date once tracking has pushed', () => {
    const at = '2026-07-09T12:00:00.000Z';
    seriesMetadataMap.set(new Map([['one piece', linkedMeta('One Piece')]]));
    setReadingState({ tracking: { last_pushed: { n: 5, status: 'CURRENT', at } } });
    const { getByText } = render(SeriesMetadataBar, {
      props: { seriesTitle: 'One Piece', volumes: [volume('Vol 04'), volume('Vol 05')] }
    });
    const expectedDate = new Date(at).toLocaleDateString();
    expect(getByText(`Tracking on · last pushed vol. 5 · ${expectedDate}`)).toBeTruthy();
  });

  it('names no unit for the pushed figure when only the totals could decide one', () => {
    const at = '2026-07-09T12:00:00.000Z';
    // Bare-numbered archives: the push resolved the unit against AniList's
    // totals, which this bar never sees. `vol. 1050` would be a coin flip, so the
    // figure stands on its own with the reason in a tooltip.
    seriesMetadataMap.set(new Map([['one piece', linkedMeta('One Piece')]]));
    setReadingState({ tracking: { last_pushed: { n: 1050, status: 'CURRENT', at } } });
    const { getByText } = render(SeriesMetadataBar, {
      props: {
        seriesTitle: 'One Piece',
        volumes: [volume('One Piece 1049'), volume('One Piece 1050')]
      }
    });
    const line = getByText(/last pushed 1050/);
    expect(line.textContent).not.toMatch(/vol\.|ch\./);
    expect(line.title).toBe('Determined at push time from AniList totals');
  });

  it('uses the chapters label when the archives are chapters', () => {
    const at = '2026-07-09T12:00:00.000Z';
    seriesMetadataMap.set(new Map([['one piece', linkedMeta('One Piece')]]));
    setReadingState({ tracking: { last_pushed: { n: 42, status: 'CURRENT', at } } });
    const { getByText } = render(SeriesMetadataBar, {
      props: { seriesTitle: 'One Piece', volumes: [volume('Chapter 41'), volume('Chapter 42')] }
    });
    expect(getByText(/last pushed ch\. 42/)).toBeTruthy();
  });

  it('prefers a corrected unit over the archive names', () => {
    const at = '2026-07-09T12:00:00.000Z';
    // The unit is a fact on the record; the pushed figure is per-user state.
    seriesMetadataMap.set(new Map([['one piece', linkedMeta('One Piece', { unit: 'volumes' })]]));
    setReadingState({ tracking: { last_pushed: { n: 3, status: 'CURRENT', at } } });
    const { getByText } = render(SeriesMetadataBar, {
      props: { seriesTitle: 'One Piece', volumes: [volume('Chapter 41'), volume('Chapter 42')] }
    });
    expect(getByText(/last pushed vol\. 3/)).toBeTruthy();
  });

  it('shows no tracking status for a series linked only to MAL (no AniList id)', () => {
    const meta = linkedMeta('One Piece', { external_ids: { mal: 13 } });
    seriesMetadataMap.set(new Map([['one piece', meta]]));
    const { queryByText } = render(SeriesMetadataBar, {
      props: { seriesTitle: 'One Piece', volumes: [] }
    });
    expect(queryByText(/Tracking/)).toBeNull();
  });
});
