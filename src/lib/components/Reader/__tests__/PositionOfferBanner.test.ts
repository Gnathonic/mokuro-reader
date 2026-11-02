import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { writable } from 'svelte/store';
import type { DeviceView } from '$lib/reading-history/devices';

const state = vi.hoisted(() => ({
  plan: null as unknown as import('svelte/store').Writable<Record<string, unknown>>,
  devices: null as unknown as import('svelte/store').Writable<
    Map<string, import('$lib/reading-history/devices').DeviceView>
  >,
  prompt: true
}));
const answerPosition = vi.hoisted(() => vi.fn(async () => {}));
const markPrompted = vi.hoisted(() => vi.fn());

vi.mock('$lib/reading-history/position-store', () => ({
  positionPlan: () => state.plan,
  shouldPrompt: () => state.prompt,
  markPrompted,
  answerPosition
}));
vi.mock('$lib/reading-history/device-stats', () => ({
  devices: {
    subscribe: (run: (value: Map<string, DeviceView>) => void) => state.devices.subscribe(run)
  }
}));

import PositionOfferBanner, { NAME_WAIT_MS } from '../PositionOfferBanner.svelte';

const offer = {
  page: 120,
  chars: 1210,
  at: Date.UTC(2026, 9, 3, 18, 36),
  device: 'phone',
  ownDevice: false
};

const pixel: DeviceView = {
  id: 'phone',
  label: 'Pixel 8',
  generated: 'Phone · Android · Chrome',
  named: true,
  class: 'phone',
  detectedClass: 'phone',
  isThisDevice: false,
  canonical: 'phone',
  mergedFrom: [],
  firstSeen: '2026-03-01T00:00:00.000Z'
};

const props = { volumeId: 'v', pageCount: 200, currentPage: 41 };

beforeEach(() => {
  state.plan = writable({});
  state.devices = writable(new Map([['phone', pixel]]));
  state.prompt = true;
  answerPosition.mockClear();
  markPrompted.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('PositionOfferBanner', () => {
  it('names the other device, and marks it shown', async () => {
    const { findByText } = render(PositionOfferBanner, { props });
    state.plan.set({ offer });
    expect(await findByText(/also read to page 120 on Pixel 8/i)).toBeTruthy();
    expect(markPrompted).toHaveBeenCalledWith('v', offer);
  });

  it('says "this device" for this device’s own reading', async () => {
    const { findByText } = render(PositionOfferBanner, { props });
    state.plan.set({ offer: { ...offer, ownDevice: true } });
    expect(await findByText(/on this device/i)).toBeTruthy();
  });

  it('says "another device" once the device list has had time and cannot name it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    state.devices.set(new Map());
    const { queryByTestId, queryByText } = render(PositionOfferBanner, { props });
    state.plan.set({ offer });
    await tick();
    expect(queryByTestId('position-offer')).toBeNull();
    expect(markPrompted).not.toHaveBeenCalled();
    vi.advanceTimersByTime(NAME_WAIT_MS);
    await tick();
    expect(queryByText(/also read to page 120 on another device/i)).toBeTruthy();
    expect(markPrompted).toHaveBeenCalledWith('v', offer);
  });

  it('names the device as soon as the list arrives within the wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    state.devices.set(new Map());
    const { queryByTestId, queryByText } = render(PositionOfferBanner, { props });
    state.plan.set({ offer });
    await tick();
    expect(queryByTestId('position-offer')).toBeNull();
    state.devices.set(new Map([['phone', pixel]]));
    await tick();
    expect(queryByText(/also read to page 120 on Pixel 8/i)).toBeTruthy();
    vi.advanceTimersByTime(NAME_WAIT_MS);
    await tick();
    expect(queryByText(/on Pixel 8/i)).toBeTruthy();
    expect(markPrompted).toHaveBeenCalledTimes(1);
  });

  it('keeps its words while it is up (no text swap under the reader)', async () => {
    const { findByText, queryByText } = render(PositionOfferBanner, { props });
    state.plan.set({ offer });
    await findByText(/on Pixel 8/i);
    state.devices.set(new Map([['phone', { ...pixel, label: 'Old phone' }]]));
    await tick();
    expect(queryByText(/on Pixel 8/i)).toBeTruthy();
    expect(queryByText(/Old phone/i)).toBeNull();
  });

  it('Jump and Stay answer it', async () => {
    const { findByRole } = render(PositionOfferBanner, { props });
    state.plan.set({ offer });
    await fireEvent.click(await findByRole('button', { name: /go to page 120/i }));
    expect(answerPosition).toHaveBeenCalledWith('v', offer, 'jump', 200);
    state.plan.set({ offer: { ...offer, at: offer.at + 1 } });
    await fireEvent.click(await findByRole('button', { name: /stay on page 41/i }));
    expect(answerPosition).toHaveBeenLastCalledWith(
      'v',
      { ...offer, at: offer.at + 1 },
      'stay',
      200
    );
  });

  it('stays hidden when its prompts are used up (the volume card carries a chip instead)', async () => {
    state.prompt = false;
    const { queryByText } = render(PositionOfferBanner, { props });
    state.plan.set({ offer });
    await Promise.resolve();
    expect(queryByText(/also read to page/i)).toBeNull();
  });

  it('"Later" hides it without answering', async () => {
    const { findByRole, queryByText } = render(PositionOfferBanner, { props });
    state.plan.set({ offer });
    await fireEvent.click(await findByRole('button', { name: /later/i }));
    expect(queryByText(/also read to page/i)).toBeNull();
    expect(answerPosition).not.toHaveBeenCalled();
  });
});
