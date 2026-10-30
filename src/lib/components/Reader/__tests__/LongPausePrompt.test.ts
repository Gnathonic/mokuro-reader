import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { Writable } from 'svelte/store';

vi.mock('$lib/reading-history/stats-store', async () => {
  const { writable } = await import('svelte/store');
  return { readingStats: writable({ byVolume: new Map() }) };
});

import { readingStats } from '$lib/reading-history/stats-store';
import { AWAY_AFTER_MS, livePause } from '$lib/reading-history/pause-watch';
import LongPausePrompt, { DONT_ASK_AFTER, REFRESH_MS } from '../LongPausePrompt.svelte';

type Answer = 'full' | 'typical' | 'none' | null;
const stats = readingStats as unknown as Writable<{
  byVolume: Map<string, { pauses: Array<{ answer: Answer }> }>;
}>;

const MIN = 60_000;
const CAP = 4 * MIN;
const onAnswer = vi.fn();

/** `n` answered pauses (plus one provisional, which must not count). */
function answeredPauses(n: number) {
  const pauses: Array<{ answer: Answer }> = Array.from({ length: n }, () => ({
    answer: 'typical'
  }));
  stats.set({ byVolume: new Map([['v1', { pauses: [...pauses, { answer: null }] }]]) });
}
/** The open view's `since` when its 4 min cap passed `ago` ms before `now`. */
const sinceFor = (ago: number, now = Date.now()) => now - CAP - ago;
function show(since: number) {
  livePause.set({ volume: 'v1', since, chars: 400, cap: CAP, typical: 90_000 });
}

beforeEach(() => {
  livePause.set(null);
  answeredPauses(0);
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

  it('fresh: "Still reading?" with the cap and the typical time', async () => {
    show(sinceFor(0));
    const { findByText, getByRole } = render(LongPausePrompt, { props: { onAnswer } });
    expect(
      await findByText(/still reading\? the timer stopped at 4 min on this page\./i)
    ).toBeTruthy();
    expect(getByRole('status')).toBeTruthy();
    expect(getByRole('button', { name: 'Still reading' })).toBeTruthy();
    expect(getByRole('button', { name: 'Count ~2 min' })).toBeTruthy();
    expect(getByRole('button', { name: "Don't count" })).toBeTruthy();
  });

  it('away: how long the page has been open, with all / typical / none', async () => {
    expect(AWAY_AFTER_MS).toBe(2 * MIN); // O7
    show(sinceFor(AWAY_AFTER_MS + 6 * MIN)); // open 4 + 2 + 6 = 12 min
    const { findByText, getByRole, queryByRole } = render(LongPausePrompt, {
      props: { onAnswer }
    });
    expect(await findByText(/this page has been open 12 min\. count it\?/i)).toBeTruthy();
    expect(getByRole('button', { name: 'Count all (12 min)' })).toBeTruthy();
    expect(getByRole('button', { name: 'Count typical (~2 min)' })).toBeTruthy();
    expect(getByRole('button', { name: "Don't count" })).toBeTruthy();
    expect(queryByRole('button', { name: 'Still reading' })).toBeNull();
  });

  it('turns into the away copy once the cap is AWAY_AFTER_MS behind', async () => {
    const NOW = Date.UTC(2026, 9, 10, 12);
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] });
    show(sinceFor(0, NOW));
    const { getByText, queryByText } = render(LongPausePrompt, { props: { onAnswer } });
    await tick();
    expect(getByText(/still reading\?/i)).toBeTruthy();
    vi.advanceTimersByTime(AWAY_AFTER_MS + REFRESH_MS); // open 4 min + 2 min + 10 s
    await tick();
    expect(queryByText(/still reading\?/i)).toBeNull();
    expect(getByText(/this page has been open 6 min/i)).toBeTruthy();
  });

  it(`offers "Always do this" only after ${DONT_ASK_AFTER} answered pauses`, async () => {
    expect(DONT_ASK_AFTER).toBe(3); // O7
    answeredPauses(2);
    show(sinceFor(0));
    const { findByTestId, queryByLabelText, findByLabelText } = render(LongPausePrompt, {
      props: { onAnswer }
    });
    await findByTestId('long-pause');
    expect(queryByLabelText('Always do this')).toBeNull();
    answeredPauses(3);
    expect(await findByLabelText('Always do this')).toBeTruthy();
  });

  it.each([
    ['Still reading', 'full', true],
    ['Count ~2 min', 'typical', false],
    ["Don't count", 'none', false]
  ] as const)('fresh "%s" answers %s', async (name, count, stillReading) => {
    show(sinceFor(0));
    const { findByRole, queryByTestId } = render(LongPausePrompt, { props: { onAnswer } });
    await fireEvent.click(await findByRole('button', { name }));
    expect(onAnswer).toHaveBeenCalledWith(count, { stillReading, always: false });
    expect(queryByTestId('long-pause')).toBeNull();
  });

  it.each([
    ['Count all (12 min)', 'full'],
    ['Count typical (~2 min)', 'typical'],
    ["Don't count", 'none']
  ] as const)('away "%s" answers %s, never as Still reading', async (name, count) => {
    show(sinceFor(AWAY_AFTER_MS + 6 * MIN));
    const { findByRole } = render(LongPausePrompt, { props: { onAnswer } });
    await fireEvent.click(await findByRole('button', { name }));
    expect(onAnswer).toHaveBeenCalledWith(count, { stillReading: false, always: false });
  });

  it('"Always do this" rides along with the answer; Still reading stays full', async () => {
    answeredPauses(3);
    show(sinceFor(0));
    const { findByLabelText, getByRole } = render(LongPausePrompt, { props: { onAnswer } });
    await fireEvent.click(await findByLabelText('Always do this'));
    await fireEvent.click(getByRole('button', { name: 'Still reading' }));
    expect(onAnswer).toHaveBeenCalledWith('full', { stillReading: true, always: true });
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
    await fireEvent.click(getByRole('button', { name: "Don't count" }));
    show(first); // the same view again (a re-fire before the reader cleared it)
    await tick();
    expect(queryByTestId('long-pause')).toBeNull();

    show(first + 1); // the continuation view
    expect(await findByTestId('long-pause')).toBeTruthy();
  });
});
