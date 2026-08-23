import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';

// The card's only behaviour is "show the pre-resolved title, navigate on click" —
// the router is the one thing worth spying on.
const { toSeries } = vi.hoisted(() => ({ toSeries: vi.fn() }));
vi.mock('$lib/util/hash-router', () => ({ nav: { toSeries } }));

import CatalogNameCard from '../CatalogNameCard.svelte';

describe('CatalogNameCard', () => {
  beforeEach(() => toSeries.mockClear());
  afterEach(() => cleanup());

  it('renders the display title and navigates by the RAW folder title', async () => {
    // displayTitle is an AniList title; the route key must still be the folder name.
    const { getByRole } = render(CatalogNameCard, {
      props: { title: 'Dr Stone', displayTitle: 'Dr. STONE (HD Scan)' }
    });

    const card = getByRole('button');
    expect(card.textContent).toContain('Dr. STONE (HD Scan)');

    await fireEvent.click(card);
    expect(toSeries).toHaveBeenCalledWith('Dr Stone');
  });

  it('navigates from the list variant too', async () => {
    const { getByRole } = render(CatalogNameCard, {
      props: { title: 'Naruto', displayTitle: 'Naruto', variant: 'list' as const }
    });

    const row = getByRole('button');
    expect(row.textContent).toContain('Naruto');

    await fireEvent.click(row);
    expect(toSeries).toHaveBeenCalledWith('Naruto');
  });
});
