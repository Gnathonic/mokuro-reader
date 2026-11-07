import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { AWAY_AFTER_MS, livePause } from '$lib/reading-history/pause-watch';
import LongPausePrompt, { REFRESH_MS } from '../LongPausePrompt.svelte';

const MIN = 60_000;
const CAP = 4 * MIN;
const onAnswer = vi.fn();

/** The open view's `since` when its 4 min cap passed `ago` ms before `now`. */
const sinceFor = (ago: number, now = Date.now()) => now - CAP - ago;
function show(since: number) {
  livePause.set({ volume: 'v1', since, chars: 400, cap: CAP });
}

beforeEach(() => {
  livePause.set(null);
  onAnswer.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('LongPausePrompt', () => {
  it('is hidden with no pause', () => {
    const { queryByTestId } = render(LongPausePrompt, { props: { onAnswer } });
    expect(queryByTestId('long-pause')).toBeNull();
  });

  it('at the cutoff: says the timer stopped and why, and offers Still reading', async () => {
    show(sinceFor(0));
    const { findByText, getByRole, queryByRole } = render(LongPausePrompt, {
      props: { onAnswer }
    });
    expect(await findByText('No page turn for 4 min, so the timer stopped.')).toBeTruthy();
    expect(getByRole('status')).toBeTruthy();
    expect(getByRole('button', { name: 'Still reading' })).toBeTruthy();
    expect(getByRole('button', { name: 'Don’t ask again' })).toBeTruthy();
    expect(getByRole('button', { name: 'Close' })).toBeTruthy();
    // Nothing about typical time, and no counting choices yet.
    expect(queryByRole('button', { name: /typical|count/i })).toBeNull();
  });

  it('away: how long the page was open and what counted, with keep / all / none', async () => {
    expect(AWAY_AFTER_MS).toBe(2 * MIN); // O7
    show(sinceFor(AWAY_AFTER_MS + 6 * MIN)); // open 4 + 2 + 6 = 12 min
    const { findByText, getByRole, queryByRole } = render(LongPausePrompt, {
      props: { onAnswer }
    });
    expect(await findByText('This page was open 12 min. 4 min counted.')).toBeTruthy();
    expect(getByRole('button', { name: 'Keep 4 min' })).toBeTruthy();
    expect(getByRole('button', { name: 'Count all 12 min' })).toBeTruthy();
    expect(getByRole('button', { name: 'Count none' })).toBeTruthy();
    expect(getByRole('button', { name: 'Don’t ask again' })).toBeTruthy();
    expect(queryByRole('button', { name: 'Still reading' })).toBeNull();
  });

  it('turns into the away copy once the cap is AWAY_AFTER_MS behind', async () => {
    const NOW = Date.UTC(2026, 9, 10, 12);
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] });
    show(sinceFor(0, NOW));
    const { getByText, queryByText } = render(LongPausePrompt, { props: { onAnswer } });
    await tick();
    expect(getByText(/so the timer stopped/)).toBeTruthy();
    vi.advanceTimersByTime(AWAY_AFTER_MS + REFRESH_MS); // open 4 min + 2 min + 10 s
    await tick();
    expect(queryByText(/so the timer stopped/)).toBeNull();
    expect(getByText('This page was open 6 min. 4 min counted.')).toBeTruthy();
  });

  it.each([
    ['Still reading', 'still-reading'],
    ['Close', 'keep'],
    ['Don’t ask again', 'stop-asking']
  ] as const)('at the cutoff, "%s" answers %s and hides the prompt', async (name, answer) => {
    show(sinceFor(0));
    const { findByRole, queryByTestId } = render(LongPausePrompt, { props: { onAnswer } });
    await fireEvent.click(await findByRole('button', { name }));
    expect(onAnswer).toHaveBeenCalledWith(answer);
    expect(queryByTestId('long-pause')).toBeNull();
  });

  it.each([
    ['Keep 4 min', 'keep'],
    ['Count all 12 min', 'all'],
    ['Count none', 'none'],
    ['Don’t ask again', 'stop-asking']
  ] as const)('away, "%s" answers %s', async (name, answer) => {
    show(sinceFor(AWAY_AFTER_MS + 6 * MIN));
    const { findByRole } = render(LongPausePrompt, { props: { onAnswer } });
    await fireEvent.click(await findByRole('button', { name }));
    expect(onAnswer).toHaveBeenCalledWith(answer);
  });

  it('goes with its view, stays gone once answered, and asks again for the next view', async () => {
    const first = sinceFor(0);
    show(first);
    const { findByTestId, queryByTestId, getByRole } = render(LongPausePrompt, {
      props: { onAnswer }
    });
    await findByTestId('long-pause');
    livePause.set(null);
    await tick();
    expect(queryByTestId('long-pause')).toBeNull();

    show(first);
    await findByTestId('long-pause');
    await fireEvent.click(getByRole('button', { name: 'Close' }));
    show(first); // the same view again (a re-fire before the reader cleared it)
    await tick();
    expect(queryByTestId('long-pause')).toBeNull();

    show(first + 1); // the continuation view
    expect(await findByTestId('long-pause')).toBeTruthy();
  });
});
