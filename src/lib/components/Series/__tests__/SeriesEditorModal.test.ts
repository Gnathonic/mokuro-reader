import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { get } from 'svelte/store';
import { createEmptySeriesMetadata } from '$lib/metadata/types';
import type { VolumeMetadata } from '$lib/types';

// vi.hoisted: `vi.mock` factories are hoisted above every other top-level
// statement (including this file's own imports), so the stores the factories
// close over must be built here with a minimal hand-rolled Svelte store
// contract — same pattern as SeriesMetadataBar.test.ts / SeriesTrackingPanel.test.ts.
const h = vi.hoisted(() => {
  function createStore<T>(initial: T) {
    let value = initial;
    const subs = new Set<(v: T) => void>();
    return {
      subscribe(fn: (v: T) => void) {
        subs.add(fn);
        fn(value);
        return () => {
          subs.delete(fn);
        };
      },
      set(v: T) {
        value = v;
        subs.forEach((fn) => fn(value));
      },
      get: () => value,
      /** Live subscriber count — used to prove the globally-mounted modal stays inert. */
      count: () => subs.size
    };
  }

  return {
    createStore,
    catalog: createStore<unknown[] | null>([]),
    seriesMetadataMap: createStore(new Map<string, unknown>()),
    routeParams: createStore<{ manga?: string; volume?: string }>({}),
    providerStatus: createStore({
      providers: {} as Record<string, { isReadOnly?: boolean }>,
      hasAnyAuthenticated: false,
      needsAttention: false,
      currentProviderType: null as string | null
    }),
    preferredTitleLanguage: createStore('imported'),
    catalogSettings: createStore<{ pushProgressToAniList: boolean } | undefined>({
      pushProgressToAniList: true
    }),
    volumesData: createStore<Record<string, { completed?: boolean }>>({}),
    anilistUser: createStore<{ id: number; name: string } | null>(null),
    anilistConnected: createStore<boolean>(false),
    auth: { clientId: undefined as string | undefined },
    noopStore: { subscribe: (fn: (v: unknown) => void) => (fn(undefined), () => {}) },
    executeRenameSeries: vi.fn(),
    toSeries: vi.fn()
  };
});

vi.mock('$lib/catalog', () => ({ catalog: h.catalog }));
vi.mock('$lib/util/series-rename', () => ({ executeRenameSeries: h.executeRenameSeries }));
vi.mock('$lib/metadata/store', () => ({
  seriesMetadataMap: h.seriesMetadataMap,
  updateSeriesMetadata: vi.fn(),
  unlinkSeries: vi.fn()
}));
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: { refreshSeriesSidecars: vi.fn(), cloudFiles: h.noopStore }
}));
vi.mock('$lib/util/sync', () => ({ providerManager: { status: h.providerStatus } }));
vi.mock('$lib/util', () => ({ showSnackbar: vi.fn() }));
vi.mock('$lib/util/hash-router', () => ({
  nav: { toSeries: h.toSeries },
  routeParams: h.routeParams
}));
vi.mock('$lib/settings/settings', () => ({
  preferredTitleLanguage: h.preferredTitleLanguage,
  catalogSettings: h.catalogSettings
}));
// The modal mounts SeriesTrackingPanel; these keep its module graph (IndexedDB,
// the AniList tracker) out of a test about the modal itself.
vi.mock('$lib/settings/volume-data', () => ({ volumes: h.volumesData }));
vi.mock('$lib/metadata/progress-tracker', () => ({
  computeLocalPassState: () => ({
    passProgress: 0,
    allCompleted: false,
    passComplete: false,
    timesRead: 0,
    rereading: false
  }),
  syncSeriesNow: vi.fn()
}));
vi.mock('$lib/metadata/reread', () => ({ restartSeries: vi.fn() }));
// The nested SeriesLinkModal kicks off a debounced AniList search as soon as it opens;
// stub the search driver so opening it in a test never reaches the network.
vi.mock('$lib/metadata/link-search', () => ({
  createLinkSearch: () => ({ setQuery: vi.fn(), cancel: vi.fn() }),
  describeSearchError: (e: unknown) => String(e)
}));
vi.mock('$lib/metadata/anilist-auth', () => ({
  getAniListClientId: () => h.auth.clientId,
  getAniListToken: () => null,
  anilistUser: h.anilistUser,
  anilistConnected: h.anilistConnected
}));

import SeriesEditorModal from '../SeriesEditorModal.svelte';
import { seriesEditorModalStore, promptSeriesEditor, closeSeriesEditor } from '$lib/util/modals';
import { showSnackbar } from '$lib/util';

function volume(seriesTitle: string, title: string): VolumeMetadata {
  return {
    volume_uuid: `uuid-${seriesTitle}-${title}`,
    series_uuid: `series-${seriesTitle}`,
    series_title: seriesTitle,
    volume_title: title
  } as VolumeMetadata;
}

function series(title: string) {
  return {
    title,
    displayTitle: title,
    searchTerms: [title.toLowerCase()],
    series_uuid: `series-${title}`,
    volumes: [volume(title, 'Vol 1')]
  };
}

function linkedMeta(title: string) {
  return {
    ...createEmptySeriesMetadata(title),
    external_ids: { anilist: 30013 },
    titles: { native: `${title} native`, romaji: `${title} romaji`, english: `${title} en` }
  };
}

/** A: linked. B, C: unlinked. */
function threeSeriesCatalog() {
  h.catalog.set([series('Akira'), series('Berserk'), series('Chainsaw Man')]);
  h.seriesMetadataMap.set(new Map<string, unknown>([['akira', linkedMeta('Akira')]]));
}

/**
 * The footer Close button. Flowbite's dialog header also carries an X whose sr-only label
 * is literally "Close", so an exact-text query matches two nodes; only one is the button.
 */
function closeButton(getAllByText: (text: string) => HTMLElement[]): HTMLElement {
  const match = getAllByText('Close').find((el) => el.tagName === 'BUTTON');
  if (!match) throw new Error('Close button not found');
  return match;
}

async function openFor(title: string) {
  const utils = render(SeriesEditorModal);
  promptSeriesEditor(title);
  await tick();
  await tick();
  return utils;
}

describe('SeriesEditorModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    closeSeriesEditor();
    threeSeriesCatalog();
    h.routeParams.set({});
    h.preferredTitleLanguage.set('imported');
    h.auth.clientId = undefined;
    h.providerStatus.set({
      providers: {},
      hasAnyAuthenticated: false,
      needsAttention: false,
      currentProviderType: null
    });
    h.executeRenameSeries.mockReset();
  });

  it('opens for the requested series and prefills the folder-name field', async () => {
    const { getByDisplayValue, getByText } = await openFor('Berserk');
    expect(getByText('Folder name')).toBeTruthy();
    expect(getByDisplayValue('Berserk')).toBeTruthy();
  });

  it('renders nothing until a series is prompted', () => {
    const { queryByText } = render(SeriesEditorModal);
    expect(queryByText('Folder name')).toBeNull();
  });

  it('leaves the catalog unsubscribed while closed', async () => {
    // It is mounted in +layout for the whole session; `catalog` re-groups and re-sorts
    // the entire library on every emission, so the reader must not be paying for it.
    render(SeriesEditorModal);
    await tick();
    const idle = h.catalog.count();
    expect(idle).toBe(0);

    promptSeriesEditor('Berserk');
    await tick();
    await tick();
    expect(h.catalog.count()).toBeGreaterThan(idle);
  });

  it('composes the AniList controls and the tracking panel', async () => {
    h.auth.clientId = 'client';
    const { getByText } = await openFor('Berserk');
    // SeriesLinkControls
    expect(getByText('Link…')).toBeTruthy();
    expect(getByText('Tag')).toBeTruthy();
    // SeriesTrackingPanel
    expect(getByText(/Read \d+ time/)).toBeTruthy();
    expect(getByText('Restart series…')).toBeTruthy();
  });

  it('moves to the next unlinked series in catalog order, wrapping past the linked one', async () => {
    const { getByText, getByDisplayValue } = await openFor('Berserk');

    await fireEvent.click(getByText(/Next unlinked series/));
    await tick();
    expect(get(seriesEditorModalStore)?.seriesTitle).toBe('Chainsaw Man');
    // The body is keyed on the folder title, so the rename draft follows the new series
    expect(getByDisplayValue('Chainsaw Man')).toBeTruthy();

    // Wraps past the linked "Akira" back to "Berserk"
    await fireEvent.click(getByText(/Next unlinked series/));
    await tick();
    expect(get(seriesEditorModalStore)?.seriesTitle).toBe('Berserk');
    expect(getByDisplayValue('Berserk')).toBeTruthy();
  });

  it('hides "Next unlinked series" when every other series is linked', async () => {
    h.catalog.set([series('Akira'), series('Berserk')]);
    h.seriesMetadataMap.set(new Map<string, unknown>([['akira', linkedMeta('Akira')]]));

    const { queryByText } = await openFor('Berserk');
    expect(queryByText(/Next unlinked series/)).toBeNull();
  });

  it('Close clears the store and fires onClose', async () => {
    const onClose = vi.fn();
    const utils = render(SeriesEditorModal);
    promptSeriesEditor('Berserk', { onClose });
    await tick();
    await tick();

    await fireEvent.click(closeButton(utils.getAllByText));
    await tick();

    expect(get(seriesEditorModalStore)).toBeUndefined();
    // Flowbite's own dialog `onclose` fires on top of the click — the handler must be
    // idempotent so the caller's onClose runs exactly once.
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape closes the editor', async () => {
    await openFor('Berserk');
    await fireEvent.keyDown(window, { key: 'Escape' });
    await tick();
    expect(get(seriesEditorModalStore)).toBeUndefined();
  });

  it('opens the AniList link modal above the editor and lets Escape close only that one', async () => {
    const { getByText, queryByPlaceholderText } = await openFor('Berserk');

    await fireEvent.click(getByText('Link…'));
    await tick();
    expect(queryByPlaceholderText('Search AniList…')).toBeTruthy();
    // The editor is still open underneath
    expect(get(seriesEditorModalStore)?.seriesTitle).toBe('Berserk');

    await fireEvent.keyDown(window, { key: 'Escape' });
    await tick();
    await waitFor(() => expect(queryByPlaceholderText('Search AniList…')).toBeNull());
    expect(get(seriesEditorModalStore)?.seriesTitle).toBe('Berserk');
  });

  it('feeds the series volumes from the catalog to the AniList controls', async () => {
    h.providerStatus.set({
      providers: {},
      hasAnyAuthenticated: true,
      needsAttention: false,
      currentProviderType: 'google-drive'
    });
    const { getByText } = await openFor('Berserk');
    // Only reachable when a non-placeholder volume was resolved for this series.
    expect(getByText('Update cloud sidecars')).toBeTruthy();
  });

  it('keeps the footer action row above the night-mode stacking context', async () => {
    const { getAllByText } = await openFor('Berserk');
    const row = closeButton(getAllByText).closest('div.flex')!;
    expect(row.className).toContain('relative');
    expect(row.className).toContain('z-10');
  });

  it('renames through executeRenameSeries and re-points the modal at the new title', async () => {
    h.routeParams.set({ manga: 'Berserk' });
    h.executeRenameSeries.mockResolvedValue({
      finalTitle: 'Berserk Deluxe',
      renamedCount: 1,
      failures: []
    });

    const { getByDisplayValue, getByText } = await openFor('Berserk');
    const input = getByDisplayValue('Berserk') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'Berserk Deluxe' } });
    await fireEvent.click(getByText('Save'));

    await waitFor(() =>
      expect(h.executeRenameSeries).toHaveBeenCalledWith(
        'Berserk',
        'Berserk Deluxe',
        'series-Berserk'
      )
    );
    await waitFor(() => expect(get(seriesEditorModalStore)?.seriesTitle).toBe('Berserk Deluxe'));
    expect(h.toSeries).toHaveBeenCalledWith('Berserk Deluxe', { replaceState: true });
    expect(showSnackbar).toHaveBeenCalledWith('Renamed to "Berserk Deluxe"');
  });

  it('does not navigate when the current route is a different series', async () => {
    h.routeParams.set({ manga: 'Akira' });
    h.executeRenameSeries.mockResolvedValue({
      finalTitle: 'Berserk Deluxe',
      renamedCount: 1,
      failures: []
    });

    const { getByDisplayValue, getByText } = await openFor('Berserk');
    await fireEvent.input(getByDisplayValue('Berserk'), {
      target: { value: 'Berserk Deluxe' }
    });
    await fireEvent.click(getByText('Save'));

    await waitFor(() => expect(get(seriesEditorModalStore)?.seriesTitle).toBe('Berserk Deluxe'));
    expect(h.toSeries).not.toHaveBeenCalled();
  });

  it('reports a partial rename failure inline and keeps the modal on the old title', async () => {
    h.executeRenameSeries.mockResolvedValue({
      finalTitle: 'Berserk Deluxe',
      renamedCount: 1,
      failures: [{ volumeUuid: 'u2', volumeTitle: 'Vol 2' }]
    });

    const { getByDisplayValue, getByText } = await openFor('Berserk');
    await fireEvent.input(getByDisplayValue('Berserk'), {
      target: { value: 'Berserk Deluxe' }
    });
    await fireEvent.click(getByText('Save'));

    await waitFor(() => expect(getByText(/but 1 failed \(Vol 2\)/)).toBeTruthy());
    expect(get(seriesEditorModalStore)?.seriesTitle).toBe('Berserk');
    expect(h.toSeries).not.toHaveBeenCalled();
  });

  it('rejects an empty folder name without touching the rename pipeline', async () => {
    const { getByDisplayValue, getByText } = await openFor('Berserk');
    await fireEvent.input(getByDisplayValue('Berserk'), { target: { value: '   ' } });
    await fireEvent.click(getByText('Save'));
    await tick();

    expect(getByText('Name cannot be empty')).toBeTruthy();
    expect(h.executeRenameSeries).not.toHaveBeenCalled();
  });
});
