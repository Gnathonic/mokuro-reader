import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { writable } from 'svelte/store';

const state = vi.hoisted(() => ({
  plan: null as unknown as import('svelte/store').Writable<Record<string, unknown>>,
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

import PositionOfferBanner from '../PositionOfferBanner.svelte';

const offer = {
  page: 120,
  chars: 1210,
  at: Date.UTC(2026, 9, 3, 18, 36),
  device: 'phone',
  ownDevice: false
};

beforeEach(() => {
  state.plan = writable({});
  state.prompt = true;
  answerPosition.mockClear();
  markPrompted.mockClear();
});
afterEach(cleanup);

describe('PositionOfferBanner', () => {
  it('offers the other device’s page, and marks it shown', async () => {
    const { findByText } = render(PositionOfferBanner, {
      props: { volumeId: 'v', pageCount: 200, currentPage: 41 }
    });
    state.plan.set({ offer });
    expect(await findByText(/also read to page 120 on another device/i)).toBeTruthy();
    expect(markPrompted).toHaveBeenCalledWith('v', offer);
  });

  it('says "this device" for this device’s own reading', async () => {
    const { findByText } = render(PositionOfferBanner, {
      props: { volumeId: 'v', pageCount: 200, currentPage: 41 }
    });
    state.plan.set({ offer: { ...offer, ownDevice: true } });
    expect(await findByText(/on this device/i)).toBeTruthy();
  });

  it('Jump and Stay answer it', async () => {
    const { findByRole } = render(PositionOfferBanner, {
      props: { volumeId: 'v', pageCount: 200, currentPage: 41 }
    });
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
    const { queryByText } = render(PositionOfferBanner, {
      props: { volumeId: 'v', pageCount: 200, currentPage: 41 }
    });
    state.plan.set({ offer });
    await Promise.resolve();
    expect(queryByText(/also read to page/i)).toBeNull();
  });

  it('"Later" hides it without answering', async () => {
    const { findByRole, queryByText } = render(PositionOfferBanner, {
      props: { volumeId: 'v', pageCount: 200, currentPage: 41 }
    });
    state.plan.set({ offer });
    await fireEvent.click(await findByRole('button', { name: /later/i }));
    expect(queryByText(/also read to page/i)).toBeNull();
    expect(answerPosition).not.toHaveBeenCalled();
  });
});
