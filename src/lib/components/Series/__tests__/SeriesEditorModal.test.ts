import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntersectionObserverStub } from '$lib/catalog/__tests__/intersection-observer-stub';
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
    currentView: createStore<{ type: string; seriesId?: string; volumeId?: string }>({
      type: 'catalog'
    }),
    providerStatus: createStore({
      providers: {} as Record<
        string,
        { isReadOnly?: boolean; metadataPermissions?: unknown } | null
      >,
      hasAnyAuthenticated: false,
      needsAttention: false,
      currentProviderType: null as string | null
    }),
    preferredTitleLanguage: createStore('imported'),
    catalogSettings: createStore<{ pushProgressToAniList: boolean } | undefined>({
      pushProgressToAniList: true
    }),
    volumesData: createStore<Record<string, { completed?: boolean }>>({}),
    // SeriesSpineShowcase mirrors the catalog card's "hide read volumes" subset.
    progressData: createStore<Record<string, number>>({}),
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
  unifiedCloudManager: { cloudFiles: h.noopStore }
}));
vi.mock('$lib/util/sync', () => ({ providerManager: { status: h.providerStatus } }));
vi.mock('$lib/util', async () => {
  // `$lib/util` re-exports `./modals`; the confirmation popup reads its store through the
  // barrel while the panel imports it directly, and both must see the SAME store instance.
  const modals = await vi.importActual<typeof import('$lib/util/modals')>('$lib/util/modals');
  return { ...modals, showSnackbar: vi.fn() };
});
vi.mock('$lib/util/hash-router', () => ({
  nav: { toSeries: h.toSeries },
  currentView: h.currentView
}));
vi.mock('$lib/settings/settings', () => ({
  preferredTitleLanguage: h.preferredTitleLanguage,
  catalogSettings: h.catalogSettings
}));
// The modal mounts SeriesTrackingPanel; these keep its module graph (IndexedDB,
// the AniList tracker) out of a test about the modal itself.
vi.mock('$lib/settings/volume-data', () => ({
  volumes: h.volumesData,
  progress: h.progressData
}));
vi.mock('$lib/metadata/progress-tracker', () => ({
  computeLocalPassState: () => ({
    passProgress: 0,
    allCompleted: false,
    passComplete: false,
    timesRead: 0,
    rereading: false
  }),
  onReadCountChanged: vi.fn(async () => 'nothing')
}));
vi.mock('$lib/metadata/reread', () => ({ restartSeries: vi.fn() }));
// The nested SeriesLinkModal kicks off a debounced AniList search as soon as it opens;
// stub the search driver so opening it in a test never reaches the network.
vi.mock('$lib/metadata/link-search', () => ({
  createLinkSearch: () => ({ setQuery: vi.fn(), cancel: vi.fn() }),
  describeSearchError: (e: unknown) => String(e)
}));
// SeriesSpineShowcase only REQUESTS a cover now (`$lib/catalog/cover-
// service`); its real module pulls in db/materialize/unified-cloud-manager —
// keep that graph out of a test about the modal (the shelf's own suite,
// `SeriesSpineShowcase.test.ts`, covers its cover-request behaviour, and
// `cover-service.test.ts` covers delivery).
vi.mock('$lib/catalog/cover-service', () => ({
  requestCover: vi.fn(),
  isCoverFetchTarget: vi.fn(() => false)
}));
vi.mock('$lib/metadata/anilist-auth', () => ({
  getAniListClientId: () => h.auth.clientId,
  getAniListToken: () => null,
  anilistUser: h.anilistUser,
  anilistConnected: h.anilistConnected
}));

import SeriesEditorModal from '../SeriesEditorModal.svelte';
import ConfirmationPopup from '$lib/components/ConfirmationPopup.svelte';
import {
  seriesEditorModalStore,
  promptSeriesEditor,
  closeSeriesEditor,
  promptConfirmation,
  confirmationPopupStore
} from '$lib/util/modals';
import { showSnackbar } from '$lib/util';
import { updateSeriesMetadata, unlinkSeries } from '$lib/metadata/store';

function volume(seriesTitle: string, title: string, isPlaceholder = false): VolumeMetadata {
  return {
    volume_uuid: `uuid-${seriesTitle}-${title}`,
    series_uuid: `series-${seriesTitle}`,
    series_title: seriesTitle,
    volume_title: title,
    isPlaceholder
  } as VolumeMetadata;
}

function series(title: string, volumes = [volume(title, 'Vol 1')]) {
  return {
    title,
    displayTitle: title,
    searchTerms: [title.toLowerCase()],
    series_uuid: `series-${title}`,
    volumes
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

/** CompositeCanvas (inside the spine showcase) observes visibility; jsdom has no IO. */
const originalIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;

describe('SeriesEditorModal', () => {
  afterEach(() => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = originalIO;
  });

  beforeEach(() => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
      IntersectionObserverStub;
    vi.clearAllMocks();
    closeSeriesEditor();
    confirmationPopupStore.set(undefined);
    threeSeriesCatalog();
    h.currentView.set({ type: 'catalog' });
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

  it('mounts the spine shelf with its offset controls', async () => {
    const { getByText, getByLabelText } = await openFor('Berserk');
    expect(getByText('Shelf')).toBeTruthy();
    expect(getByLabelText('Spine shelf')).toBeTruthy();
    expect(getByLabelText('Series spine offset')).toBeTruthy();
    expect(getByText('Reset all volume offsets')).toBeTruthy();
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

  it('moves to the next series that has no alt titles or synonyms at all', async () => {
    // Akira: linked with titles. Berserk: unlinked but manually titled. Chainsaw Man: bare.
    h.seriesMetadataMap.set(
      new Map<string, unknown>([
        ['akira', linkedMeta('Akira')],
        [
          'berserk',
          { ...linkedMeta('Berserk'), external_ids: {}, titles: {}, synonyms: ['ベルセルク'] }
        ]
      ])
    );
    const { getByText, queryByText } = await openFor('Akira');

    await fireEvent.click(getByText(/Next series without titles/));
    await tick();
    expect(get(seriesEditorModalStore)?.seriesTitle).toBe('Chainsaw Man');

    // From Chainsaw Man there is nothing else bare (Berserk has a synonym) → hidden.
    expect(queryByText(/Next series without titles/)).toBeNull();
    // ...but "Next unlinked" still offers Berserk.
    expect(getByText(/Next unlinked series/)).toBeTruthy();
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
    await fireEvent.keyDown(document.body, { key: 'Escape' });
    await tick();
    expect(get(seriesEditorModalStore)).toBeUndefined();
  });

  it('flushes a focused title field before Escape closes the editor, instead of dropping the edit', async () => {
    // Regression: the field's own blur used to fire (dialog teardown, unmount) AFTER the
    // store had already cleared `seriesTitle`, writing a junk record keyed `""`. Escape
    // now blurs the focused field itself first, while `seriesTitle` is still valid, so the
    // field's normal onblur save runs and the edit is kept.
    const { getByLabelText } = await openFor('Berserk');
    const native = getByLabelText('Native') as HTMLInputElement;
    native.focus();
    await fireEvent.input(native, { target: { value: 'Berserk Native' } });

    await fireEvent.keyDown(document.body, { key: 'Escape' });
    await tick();

    expect(get(seriesEditorModalStore)).toBeUndefined();
    expect(updateSeriesMetadata).toHaveBeenCalledWith('Berserk', {
      titles: { native: 'Berserk Native' }
    });
    // Never the blank-title junk-write shape.
    expect(updateSeriesMetadata).not.toHaveBeenCalledWith('', expect.anything());
  });

  it('leaves focus alone when it is already outside the dialog on close', async () => {
    // The close handler blurs the focused field so its draft saves — but it runs again on
    // the dialog's own `close` event, by which point focus has gone back to whatever opened
    // the editor. Blurring THAT would leave the page with nothing focused.
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    try {
      await openFor('Berserk');
      trigger.focus();

      await fireEvent.keyDown(document.body, { key: 'Escape' });
      await tick();

      expect(get(seriesEditorModalStore)).toBeUndefined();
      expect(document.activeElement).toBe(trigger);
    } finally {
      trigger.remove();
    }
  });

  it('opens the AniList link modal above the editor and lets Escape close only that one', async () => {
    const { getByText, queryByPlaceholderText } = await openFor('Berserk');

    await fireEvent.click(getByText('Link…'));
    await tick();
    expect(queryByPlaceholderText('Search AniList…')).toBeTruthy();
    // The editor is still open underneath
    expect(get(seriesEditorModalStore)?.seriesTitle).toBe('Berserk');

    await fireEvent.keyDown(document.body, { key: 'Escape' });
    await tick();
    await waitFor(() => expect(queryByPlaceholderText('Search AniList…')).toBeNull());
    expect(get(seriesEditorModalStore)?.seriesTitle).toBe('Berserk');
  });

  it('Escape still closes the editor after a confirmation was dismissed earlier', async () => {
    // Regression: the guard stands down while a confirmation is on top. The popup used to
    // flip only its LOCAL `open`, leaving the store at `open: true` forever, so from the
    // first confirmation onward Escape fell through to the page's back-navigation.
    const pageBackNav = vi.fn();
    window.addEventListener('keydown', pageBackNav);
    try {
      const popup = render(ConfirmationPopup);
      promptConfirmation('Restart series?', vi.fn());
      await tick();
      await tick();
      await fireEvent.click(popup.getByText('Yes'));
      await tick();
      expect(get(confirmationPopupStore)?.open).toBe(false);

      const utils = render(SeriesEditorModal);
      promptSeriesEditor('Berserk');
      await tick();
      await tick();
      expect(utils.queryByText('Folder name')).toBeTruthy();

      await fireEvent.keyDown(document.body, { key: 'Escape' });
      await tick();

      expect(get(seriesEditorModalStore)).toBeUndefined();
      expect(pageBackNav).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', pageBackNav);
    }
  });

  it('keeps Escape away from the page while a confirmation is on top', async () => {
    const pageBackNav = vi.fn();
    window.addEventListener('keydown', pageBackNav);
    try {
      await openFor('Berserk');
      promptConfirmation('Restart series?', vi.fn());
      await tick();

      await fireEvent.keyDown(document.body, { key: 'Escape' });
      await tick();

      // The editor stays open (the confirmation owns this Escape) and the page never sees it.
      expect(get(seriesEditorModalStore)?.seriesTitle).toBe('Berserk');
      expect(pageBackNav).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', pageBackNav);
    }
  });

  it('Escape in the folder-name field reverts the draft instead of closing the editor', async () => {
    const pageBackNav = vi.fn();
    window.addEventListener('keydown', pageBackNav);
    try {
      const { getByDisplayValue } = await openFor('Berserk');
      const input = getByDisplayValue('Berserk') as HTMLInputElement;
      await fireEvent.input(input, { target: { value: 'Berserk Deluxe' } });

      await fireEvent.keyDown(input, { key: 'Escape' });
      await tick();

      expect(input.value).toBe('Berserk');
      expect(get(seriesEditorModalStore)?.seriesTitle).toBe('Berserk');
      expect(pageBackNav).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', pageBackNav);
    }
  });

  it('Escape closes a freshly opened editor while the folder-name input is focused and unedited', async () => {
    // Regression: the field unconditionally swallowed Escape (revert + stopPropagation),
    // so on a fresh, unedited field the first Escape press never reached the modal's own
    // close handler at all.
    const { getByDisplayValue } = await openFor('Berserk');
    const input = getByDisplayValue('Berserk') as HTMLInputElement;
    input.focus();

    await fireEvent.keyDown(input, { key: 'Escape' });
    await tick();

    expect(get(seriesEditorModalStore)).toBeUndefined();
  });

  it('offers no manual cloud-publish action even with a cloud connected', async () => {
    h.providerStatus.set({
      providers: {},
      hasAnyAuthenticated: true,
      needsAttention: false,
      currentProviderType: 'google-drive'
    });
    const { getByText, queryByText } = await openFor('Berserk');
    expect(getByText('Link…')).toBeTruthy();
    // The old "Update cloud sidecars" button is gone: `<Series>/series.json` is
    // written automatically (debounced) after a fact edit — see series-file-sync.ts.
    expect(queryByText('Update cloud sidecars')).toBeNull();
  });

  it('keeps every action row above the night-mode stacking context', async () => {
    const { getAllByText, getByText } = await openFor('Berserk');

    // Footer (Next unlinked / Close), AniList row, tracking row, rename Save/Cancel — a
    // <dialog> under the night-mode filter is a new stacking context, so each row that can
    // be clicked needs its own z-index or a scrollable sibling swallows the clicks.
    for (const row of [
      closeButton(getAllByText).closest('div.flex'),
      getByText('Link…').closest('div.flex'),
      getByText('Restart series…').closest('div.flex'),
      getByText('Save').closest('div.flex')
    ]) {
      expect(row!.className).toContain('relative');
      expect(row!.className).toContain('z-10');
    }
  });

  it('renames through executeRenameSeries and re-points the modal at the new title', async () => {
    h.currentView.set({ type: 'series', seriesId: 'Berserk' });
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
    h.currentView.set({ type: 'series', seriesId: 'Akira' });
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

  it('does not navigate when the series editor was opened from the reader', async () => {
    // reader / volume-text / series-text all carry a `manga` route param for this series;
    // only the series page itself may be re-pointed.
    h.currentView.set({ type: 'reader', seriesId: 'Berserk', volumeId: 'v1' });
    h.executeRenameSeries.mockResolvedValue({
      finalTitle: 'Berserk Deluxe',
      renamedCount: 1,
      failures: []
    });

    const { getByDisplayValue, getByText } = await openFor('Berserk');
    await fireEvent.input(getByDisplayValue('Berserk'), { target: { value: 'Berserk Deluxe' } });
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

  it('disables the rename field for a placeholder-only (cloud-only) series', async () => {
    // No local row exists for a cloud-only series, so executeRenameSeries can't rename
    // anything even though it would report success-shaped zeros — gate the field instead.
    h.catalog.set([series('Cloud Only', [volume('Cloud Only', 'Vol 1', true)])]);
    h.seriesMetadataMap.set(new Map());

    const { getByDisplayValue, getByText } = await openFor('Cloud Only');

    const input = getByDisplayValue('Cloud Only') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(getByText('Download a volume to rename')).toBeTruthy();

    await fireEvent.click(getByText('Save'));
    expect(h.executeRenameSeries).not.toHaveBeenCalled();
  });

  it('shows an error snackbar when the tag save fails, without crashing', async () => {
    (updateSeriesMetadata as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('offline'));
    const { getByPlaceholderText } = await openFor('Berserk');

    const tagInput = getByPlaceholderText('color') as HTMLInputElement;
    await fireEvent.input(tagInput, { target: { value: 'reread' } });
    await fireEvent.blur(tagInput);

    await waitFor(() =>
      expect(showSnackbar).toHaveBeenCalledWith(
        "Couldn't save the tag. Check your connection and try again."
      )
    );
  });

  it('shows an error snackbar when unlink fails, without crashing', async () => {
    (unlinkSeries as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('offline'));
    const { getByText } = await openFor('Akira');

    await fireEvent.click(getByText('Unlink'));

    await waitFor(() =>
      expect(showSnackbar).toHaveBeenCalledWith(
        "Couldn't unlink from AniList. Check your connection and try again."
      )
    );
  });

  describe('per-series metadata edit gating (SeriesLinkControls)', () => {
    function setMetadataScope(scope: 'all' | 'owned' | 'none', ownedSeries?: string[]) {
      h.providerStatus.set({
        providers: { webdav: { metadataPermissions: { scope, ownedSeries } } },
        hasAnyAuthenticated: true,
        needsAttention: false,
        currentProviderType: 'webdav'
      });
    }

    it('leaves Link…/tag enabled when the active provider reports no metadata scope (default)', async () => {
      const { getByText, getByPlaceholderText } = await openFor('Berserk');
      expect((getByText('Link…') as HTMLElement).closest('button')?.disabled).toBe(false);
      expect((getByPlaceholderText('color') as HTMLInputElement).disabled).toBe(false);
    });

    it('disables Link… and the tag field, and shows the reason, under scope "none"', async () => {
      setMetadataScope('none');
      const { getByText, getAllByText, getByPlaceholderText } = await openFor('Berserk');

      expect((getByText('Link…') as HTMLElement).closest('button')?.disabled).toBe(true);
      expect((getByPlaceholderText('color') as HTMLInputElement).disabled).toBe(true);
      // Both SeriesLinkControls and SeriesTitlesEditor gate on the same reason, so it
      // appears more than once in the modal — any occurrence proves it was shown.
      expect(
        getAllByText("This account can't edit series details on this server").length
      ).toBeGreaterThan(0);
    });

    it('disables Change/Unlink on an already-linked series under scope "none"', async () => {
      setMetadataScope('none');
      const { getByText } = await openFor('Akira');

      expect((getByText('Change') as HTMLElement).closest('button')?.disabled).toBe(true);
      expect((getByText('Unlink') as HTMLElement).closest('button')?.disabled).toBe(true);
    });

    it('allows an owned series under scope "owned"', async () => {
      setMetadataScope('owned', ['Berserk']);
      const { getByText } = await openFor('Berserk');
      expect((getByText('Link…') as HTMLElement).closest('button')?.disabled).toBe(false);
    });

    it('blocks an unowned series under scope "owned", with a different reason', async () => {
      setMetadataScope('owned', ['Berserk']);
      const { getByText, getAllByText } = await openFor('Chainsaw Man');
      expect((getByText('Link…') as HTMLElement).closest('button')?.disabled).toBe(true);
      expect(
        getAllByText('Editing this series requires ownership on this server').length
      ).toBeGreaterThan(0);
    });

    it('refuses to unlink even if the click reaches the handler while blocked (defense in depth)', async () => {
      setMetadataScope('none');
      const { getByText } = await openFor('Akira');

      // fireEvent bypasses the disabled attribute the way a real user can't — this proves
      // onUnlink's own gate check is what refuses the write.
      await fireEvent.click(getByText('Unlink'));
      expect(unlinkSeries).not.toHaveBeenCalled();
    });
  });
});
