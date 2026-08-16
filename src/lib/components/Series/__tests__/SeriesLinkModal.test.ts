import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/svelte';

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
vi.mock('$lib/metadata/store', () => ({
  updateSeriesMetadata: (...args: unknown[]) => updateSeriesMetadata(...args)
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
});
