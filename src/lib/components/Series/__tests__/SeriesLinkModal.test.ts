import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/svelte';

// vi.hoisted: the vi.mock factory below is hoisted above this file's own imports, so the
// store it closes over has to be built here — same pattern as SeriesTitlesEditor.test.ts.
const h = vi.hoisted(() => {
  function createStore<T>(initial: T) {
    let value = initial;
    return {
      subscribe(fn: (v: T) => void) {
        fn(value);
        return () => {};
      },
      set(v: T) {
        value = v;
      }
    };
  }
  return {
    // No active provider by default — every existing test in this file relies on the
    // form staying enabled, which is `canEditSeriesMetadata`'s default in that state.
    providerStatus: createStore({
      providers: {} as Record<string, { metadataPermissions?: unknown } | null>,
      currentProviderType: null as string | null
    })
  };
});
vi.mock('$lib/util/sync', () => ({ providerManager: { status: h.providerStatus } }));

const getById = vi.fn();
const search = vi.fn();
vi.mock('$lib/metadata/providers/anilist', async () => {
  const actual = await vi.importActual<typeof import('$lib/metadata/providers/anilist')>(
    '$lib/metadata/providers/anilist'
  );
  return {
    ...actual,
    anilistProvider: {
      id: 'anilist',
      search: (...args: unknown[]) => search(...args),
      getById: (...args: unknown[]) => getById(...args),
      siteUrl: (id: number) => `https://anilist.co/manga/${id}`
    }
  };
});

const updateSeriesMetadata = vi.fn();
const getSeriesMetadataForTitle = vi.fn(
  (..._args: unknown[]): Promise<unknown> => Promise.resolve(undefined)
);
vi.mock('$lib/metadata/store', () => ({
  updateSeriesMetadata: (...args: unknown[]) => updateSeriesMetadata(...args),
  getSeriesMetadataForTitle: (...args: unknown[]) => getSeriesMetadataForTitle(...args)
}));
vi.mock('$lib/util', () => ({ showSnackbar: vi.fn() }));

import SeriesLinkModal from '../SeriesLinkModal.svelte';

const result = {
  provider: 'anilist' as const,
  id: 30013,
  idMal: 13,
  titles: { romaji: 'ONE PIECE' },
  synonyms: [],
  siteUrl: 'https://anilist.co/manga/30013'
};

describe('SeriesLinkModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    search.mockResolvedValue([]);
    getById.mockResolvedValue(result);
    getSeriesMetadataForTitle.mockResolvedValue(undefined);
    h.providerStatus.set({ providers: {}, currentProviderType: null });
  });

  it('searches with the folder name minus its bracket tag, and adopts the tag on link', async () => {
    const { getByPlaceholderText, getByText } = render(SeriesLinkModal, {
      props: { open: true, seriesTitle: 'One Piece [color]' }
    });

    expect((getByPlaceholderText('Search AniList…') as HTMLInputElement).value).toBe('One Piece');
    await waitFor(() => expect(search).toHaveBeenCalledWith('One Piece', expect.anything()));
    expect(getByText('(color)')).toBeTruthy();

    const input = getByPlaceholderText('…or paste an AniList URL / ID');
    await fireEvent.input(input, { target: { value: '30013' } });
    await fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(updateSeriesMetadata).toHaveBeenCalledWith(
        'One Piece [color]',
        expect.objectContaining({ external_ids: { anilist: 30013, mal: 13 }, tag: 'color' })
      )
    );
  });

  it('keeps a tag the series already has instead of the folder one', async () => {
    getSeriesMetadataForTitle.mockResolvedValue({ tag: 'my tag' });
    const { getByPlaceholderText } = render(SeriesLinkModal, {
      props: { open: true, seriesTitle: 'One Piece [color]' }
    });

    const input = getByPlaceholderText('…or paste an AniList URL / ID');
    await fireEvent.input(input, { target: { value: '30013' } });
    await fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(updateSeriesMetadata).toHaveBeenCalled());
    expect(updateSeriesMetadata.mock.calls[0][1]).not.toHaveProperty('tag');
  });

  it('searches the whole name when it carries no bracket tag', async () => {
    render(SeriesLinkModal, { props: { open: true, seriesTitle: 'One Piece' } });
    await waitFor(() => expect(search).toHaveBeenCalledWith('One Piece', expect.anything()));
    expect(updateSeriesMetadata).not.toHaveBeenCalled();
  });

  it('links by ID when Enter is pressed in the paste field', async () => {
    const { getByPlaceholderText } = render(SeriesLinkModal, {
      props: { open: true, seriesTitle: 'One Piece' }
    });

    const input = getByPlaceholderText('…or paste an AniList URL / ID');
    await fireEvent.input(input, { target: { value: 'https://anilist.co/manga/30013' } });
    await fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(getById).toHaveBeenCalledWith(30013));
    await waitFor(() =>
      expect(updateSeriesMetadata).toHaveBeenCalledWith(
        'One Piece',
        expect.objectContaining({ external_ids: { anilist: 30013, mal: 13 } })
      )
    );
  });

  it('keeps the paste row above the scrollable results list (night-mode stacking context)', () => {
    const { getByPlaceholderText } = render(SeriesLinkModal, {
      props: { open: true, seriesTitle: 'One Piece' }
    });
    const row = getByPlaceholderText('…or paste an AniList URL / ID').closest('div.flex')!;
    expect(row.className).toContain('relative');
    expect(row.className).toContain('z-10');
  });

  describe('per-series metadata edit gating', () => {
    it('leaves the search and paste fields enabled when there is no active provider', () => {
      const { getByPlaceholderText, getByText } = render(SeriesLinkModal, {
        props: { open: true, seriesTitle: 'One Piece' }
      });
      expect((getByPlaceholderText('Search AniList…') as HTMLInputElement).disabled).toBe(false);
      expect((getByText('Link by ID') as HTMLElement).closest('button')?.disabled).toBe(false);
    });

    it('disables the search and paste fields, and shows the reason, under scope "none"', () => {
      h.providerStatus.set({
        providers: { webdav: { metadataPermissions: { scope: 'none' } } },
        currentProviderType: 'webdav'
      });
      const { getByPlaceholderText, getByText } = render(SeriesLinkModal, {
        props: { open: true, seriesTitle: 'One Piece' }
      });
      expect((getByPlaceholderText('Search AniList…') as HTMLInputElement).disabled).toBe(true);
      expect(
        (getByPlaceholderText('…or paste an AniList URL / ID') as HTMLInputElement).disabled
      ).toBe(true);
      expect((getByText('Link by ID') as HTMLElement).closest('button')?.disabled).toBe(true);
      expect(getByText("This account can't edit series details on this server")).toBeTruthy();
    });

    it('refuses to link even if a result click reaches the handler while blocked (defense in depth)', async () => {
      h.providerStatus.set({
        providers: { webdav: { metadataPermissions: { scope: 'none' } } },
        currentProviderType: 'webdav'
      });
      search.mockResolvedValue([result]);
      const { findByText } = render(SeriesLinkModal, {
        props: { open: true, seriesTitle: 'One Piece' }
      });
      const resultButton = (await findByText('ONE PIECE')).closest('button')!;
      expect(resultButton.disabled).toBe(true);
      // fireEvent bypasses the disabled attribute the way a real user can't — this proves
      // link()'s own gate check is what refuses the write.
      await fireEvent.click(resultButton);
      expect(updateSeriesMetadata).not.toHaveBeenCalled();
    });
  });
});
