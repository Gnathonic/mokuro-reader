import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { writable, type Writable } from 'svelte/store';
import type { PauseReview, ReviewPause } from '$lib/reading-history/pause-review';

const state = vi.hoisted(() => ({
  review: null as unknown as Writable<PauseReview>
}));
const recordResolve = vi.hoisted(() => vi.fn(async () => null));

vi.mock('$lib/reading-history/pause-review', () => ({
  pauseReview: {
    subscribe: (run: (value: PauseReview) => void) => state.review.subscribe(run)
  },
  pauseKey: (p: { device: string; seq: number }) => `${p.device}\u0000${p.seq}`
}));
// turns-store (reached through volume-data) registers a listener at import.
vi.mock('$lib/reading-history/record', () => ({
  recordResolve,
  onEventsRecorded: () => () => {}
}));

import LongPausesCard from '../LongPausesCard.svelte';

const MIN = 60_000;
const titleOf = (volume: string) => `Title ${volume}`;

const pause = (seq: number, over: Partial<ReviewPause> = {}): ReviewPause => ({
  volume: 'v1',
  device: 'dev-a',
  seq,
  t: Date.now() - 2 * MIN,
  page: 3,
  dwell: 12 * MIN,
  cap: 5 * MIN,
  typical: 4 * MIN,
  counted: 4 * MIN,
  answer: null,
  ...over
});

function listOf(pauses: ReviewPause[]): PauseReview {
  const answered = pauses.filter((p) => p.answer !== null).length;
  return { pauses, unanswered: pauses.length - answered, answered };
}

beforeEach(() => {
  state.review = writable(listOf([]));
  recordResolve.mockClear();
});
afterEach(cleanup);

describe('LongPausesCard', () => {
  it('renders nothing without pauses', () => {
    const { queryByText } = render(LongPausesCard, { props: { titleOf } });
    expect(queryByText(/Long pauses to review/)).toBeNull();
  });

  it('lists an unanswered pause as provisional, with its title, page and times', () => {
    state.review.set(listOf([pause(1)]));
    const { getByText, getAllByTestId } = render(LongPausesCard, { props: { titleOf } });
    expect(getByText('Long pauses to review (1)')).toBeTruthy();
    const row = getAllByTestId('long-pause-row')[0];
    expect(within(row).getByText('Title v1')).toBeTruthy();
    expect(within(row).getByText(/page 3 · open 12 min · counted 4 min/)).toBeTruthy();
    expect(within(row).getByText('provisional')).toBeTruthy();
    for (const name of ['All', 'Typical', 'None']) {
      expect(within(row).getByRole('button', { name }).getAttribute('aria-pressed')).toBe('false');
    }
  });

  it('answering records a resolve for that page event and keeps the row in place', async () => {
    state.review.set(listOf([pause(7)]));
    const { getByText, getAllByTestId } = render(LongPausesCard, { props: { titleOf } });
    const row = getAllByTestId('long-pause-row')[0];
    await fireEvent.click(within(row).getByRole('button', { name: 'Typical' }));
    expect(recordResolve).toHaveBeenCalledWith('v1', ['dev-a', 7], 'typical');
    // Shown at once, before the stats recount lands.
    expect(within(row).getByRole('button', { name: 'Typical' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
    expect(within(row).queryByText('provisional')).toBeNull();
    // The recount lands: the row stays put (no vanishing rows on this visit).
    state.review.set(listOf([pause(7, { answer: 'typical' })]));
    await tick();
    expect(getAllByTestId('long-pause-row')).toEqual([row]);
    expect(getByText('Long pauses to review (0)')).toBeTruthy();
  });

  it('keeps answered pauses behind "Show answered", and an answer there can be changed', async () => {
    state.review.set(listOf([pause(1), pause(2, { answer: 'full', counted: 12 * MIN })]));
    const { getByRole, getAllByTestId } = render(LongPausesCard, { props: { titleOf } });
    expect(getAllByTestId('long-pause-row')).toHaveLength(1);
    await fireEvent.click(getByRole('button', { name: 'Show answered (1)' }));
    const rows = getAllByTestId('long-pause-row');
    expect(rows).toHaveLength(2);
    const answered = rows[1];
    expect(within(answered).queryByText('provisional')).toBeNull();
    expect(within(answered).getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
    await fireEvent.click(within(answered).getByRole('button', { name: 'None' }));
    expect(recordResolve).toHaveBeenCalledWith('v1', ['dev-a', 2], 'none');
    expect(
      within(answered).getByRole('button', { name: 'None' }).getAttribute('aria-pressed')
    ).toBe('true');
    expect(getAllByTestId('long-pause-row')).toHaveLength(2);
  });

  it('shows 50 rows at a time', async () => {
    state.review.set(listOf(Array.from({ length: 60 }, (_, i) => pause(i + 1))));
    const { getByRole, queryByRole, getAllByTestId } = render(LongPausesCard, {
      props: { titleOf }
    });
    expect(getAllByTestId('long-pause-row')).toHaveLength(50);
    await fireEvent.click(getByRole('button', { name: 'Show more' }));
    expect(getAllByTestId('long-pause-row')).toHaveLength(60);
    expect(queryByRole('button', { name: 'Show more' })).toBeNull();
  });
});
