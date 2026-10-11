import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { writable } from 'svelte/store';
import type { DeviceView } from '$lib/reading-history/devices';

const state = vi.hoisted(() => ({
  plan: null as unknown as import('svelte/store').Writable<Record<string, unknown>>,
  devices: null as unknown as import('svelte/store').Writable<
    Map<string, import('$lib/reading-history/devices').DeviceView>
  >,
  chip: true
}));
const answerPosition = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('$lib/reading-history/position-store', () => ({
  positionPlan: () => state.plan,
  showsChip: () => state.chip,
  answerPosition
}));
vi.mock('$lib/reading-history/device-stats', () => ({
  devices: {
    subscribe: (run: (value: Map<string, DeviceView>) => void) => state.devices.subscribe(run)
  }
}));

import PositionOfferChip from '../PositionOfferChip.svelte';

const offer = { page: 120, chars: 1210, at: 1000, device: 'phone', ownDevice: false };

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

beforeEach(() => {
  state.plan = writable({ offer });
  state.devices = writable(new Map([['phone', pixel]]));
  state.chip = true;
  answerPosition.mockClear();
});
afterEach(cleanup);

describe('PositionOfferChip', () => {
  it('shows once the prompts are used up, and answers without opening the volume', async () => {
    const { getByTestId, getByRole } = render(PositionOfferChip, {
      props: { volumeId: 'v', pageCount: 200 }
    });
    expect(getByTestId('position-offer-chip').textContent).toMatch(/also read to p\.120/i);
    // Default prevented: a card link around it does not navigate. (Svelte 5
    // delegates handlers, so its stopPropagation stops the card's own onclick.)
    const notPrevented = await fireEvent.click(getByRole('button', { name: /go/i }));
    expect(notPrevented).toBe(false);
    expect(answerPosition).toHaveBeenCalledWith('v', offer, 'jump', 200);
  });

  it('Stay answers it too', async () => {
    const { getByRole } = render(PositionOfferChip, { props: { volumeId: 'v', pageCount: 200 } });
    await fireEvent.click(getByRole('button', { name: /stay/i }));
    expect(answerPosition).toHaveBeenCalledWith('v', offer, 'stay', 200);
  });

  it('names the other device in its tooltip, leaving its own text short', () => {
    const chip = render(PositionOfferChip, {
      props: { volumeId: 'v', pageCount: 200 }
    }).getByTestId('position-offer-chip');
    expect(chip.getAttribute('title')).toBe('Read on Pixel 8');
    expect(chip.textContent).not.toMatch(/Pixel 8/);
  });

  it('says "another device" when the list cannot name it, "this device" for its own reading', () => {
    state.devices.set(new Map());
    expect(
      render(PositionOfferChip, { props: { volumeId: 'v', pageCount: 200 } })
        .getByTestId('position-offer-chip')
        .getAttribute('title')
    ).toBe('Read on another device');
    cleanup();
    state.plan = writable({ offer: { ...offer, ownDevice: true } });
    expect(
      render(PositionOfferChip, { props: { volumeId: 'v', pageCount: 200 } })
        .getByTestId('position-offer-chip')
        .getAttribute('title')
    ).toBe('Read on this device');
  });

  it('is absent while the reader may still prompt, or with no offer', () => {
    state.chip = false;
    expect(
      render(PositionOfferChip, { props: { volumeId: 'v', pageCount: 200 } }).queryByTestId(
        'position-offer-chip'
      )
    ).toBeNull();
    cleanup();
    state.chip = true;
    state.plan = writable({});
    expect(
      render(PositionOfferChip, { props: { volumeId: 'v', pageCount: 200 } }).queryByTestId(
        'position-offer-chip'
      )
    ).toBeNull();
  });
});
