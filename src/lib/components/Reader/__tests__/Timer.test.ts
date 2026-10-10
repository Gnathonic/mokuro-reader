import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';

vi.mock('$lib/settings', async () => {
  const { writable } = await import('svelte/store');
  return { volumes: writable({}) };
});
vi.mock('$lib/settings/reading-speed', async () => {
  const { writable } = await import('svelte/store');
  return { personalizedReadingSpeed: writable({ charsPerMinute: 100 }) };
});
vi.mock('$lib/catalog', async () => {
  const { writable } = await import('svelte/store');
  return { currentVolume: writable(null), currentVolumeCharacterCount: writable(0) };
});
vi.mock('$lib/util/reading-speed', () => ({ calculateVolumeTimeToFinish: () => null }));
vi.mock('$lib/reading-history/series-speeds', async () => {
  const { writable } = await import('svelte/store');
  return { seriesSpeeds: writable(new Map()) };
});
// What the stats have counted for v1 so far (the store re-emits to apply it).
const countedMs = vi.hoisted(() => ({ value: 0 }));
vi.mock('$lib/reading-history/stats-store', async () => {
  const { writable } = await import('svelte/store');
  return {
    // 300 ms/char: a 400-char page expects 2 min, so its cap at k = 3 is 6 min.
    readingStats: writable({ pace: 300, idle: { k: 3, overrideMs: null }, byVolume: new Map() }),
    figuresFor: () => ({ timeMs: countedMs.value })
  };
});

import { endedView, liveView, readingPaused } from '$lib/reading-history/live-view';
import { readingStats } from '$lib/reading-history/stats-store';
import type { Writable } from 'svelte/store';
import type { PauseCount } from '$lib/reading-history/types';
import Timer from '../Timer.svelte';

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 10, 12);

function open(answer: PauseCount | null, since = NOW) {
  liveView.set({
    since,
    answer,
    view: {
      volume: 'v1',
      first_page: 3,
      last_page: 3,
      page_chars: [400],
      chars_before: 800,
      layout: 'single',
      orientation: 'portrait',
      viewport: { w: 400, h: 800 }
    }
  });
}

async function at(ms: number) {
  vi.advanceTimersByTime(ms);
  await tick();
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] });
  readingPaused.set(false);
  countedMs.value = 0;
  endedView.set(null);
});

/** The view ended with `ms` counted: the reader announces it, the stats follow later. */
async function ended(ms: number, thenCounted: boolean) {
  endedView.set({ volume: 'v1', ms });
  await tick();
  if (thenCounted) {
    countedMs.value += ms;
    (readingStats as unknown as Writable<object>).update((s) => ({ ...s }));
    await tick();
  }
}
afterEach(() => {
  cleanup();
  liveView.set(null);
  vi.useRealTimers();
});

describe('Timer past the cap (phase 3b)', () => {
  it('under a standing "Count all" default keeps counting and stays Active', async () => {
    open(null);
    const { getByRole } = render(Timer, { props: { volumeId: 'v1' } });
    await at(6 * MIN);
    open('full'); // the default answers the view at its cap
    await at(4 * MIN);
    expect(getByRole('button').textContent).toMatch(/Active \| Minutes read: 10/);
  });

  it('unanswered shows Idle past the cap and never steps back', async () => {
    open(null);
    const { getByRole } = render(Timer, { props: { volumeId: 'v1' } });
    await at(6 * MIN); // exactly at the cap: still the whole dwell
    expect(getByRole('button').textContent).toMatch(/Active \| Minutes read: 6/);
    await at(4 * MIN); // past it the live part is typical (2 min); the figure holds
    expect(getByRole('button').textContent).toMatch(/Idle \| Minutes read: 6/);
  });

  it('after "Don\u2019t count" drops the paused minutes and counts on from the answer', async () => {
    open(null);
    const { getByRole } = render(Timer, { props: { volumeId: 'v1' } });
    await at(10 * MIN); // prompt up, timer held at the 6 min cap
    expect(getByRole('button').textContent).toMatch(/Minutes read: 6/);
    open(null, NOW + 10 * MIN); // split: the paused view ends with 'none'
    await ended(0, true);
    expect(getByRole('button').textContent).toMatch(/Active \| Minutes read: 0/);
    await at(2 * MIN);
    expect(getByRole('button').textContent).toMatch(/Active \| Minutes read: 2/);
  });

  it('after "Count typical" shows the typical time before the stats catch up, once', async () => {
    open(null);
    const { getByRole } = render(Timer, { props: { volumeId: 'v1' } });
    await at(10 * MIN);
    open(null, NOW + 10 * MIN);
    await ended(2 * MIN, false); // recorded, not yet counted
    expect(getByRole('button').textContent).toMatch(/Minutes read: 2/);
    countedMs.value = 2 * MIN; // the stats now include it: not counted twice
    (readingStats as unknown as Writable<object>).update((s) => ({ ...s }));
    await tick();
    expect(getByRole('button').textContent).toMatch(/Minutes read: 2/);
  });

  it('a page turn never dips while the ended view is on its way into the stats', async () => {
    open(null);
    const { getByRole } = render(Timer, { props: { volumeId: 'v1' } });
    await at(3 * MIN);
    open(null, NOW + 3 * MIN);
    await ended(3 * MIN, false);
    expect(getByRole('button').textContent).toMatch(/Minutes read: 3/);
  });
});
