import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { writable, type Writable } from 'svelte/store';
import type { DeviceStats } from '$lib/reading-history/device-stats';
import type { DeviceView } from '$lib/reading-history/devices';
import { mapOf, row, statsOf, view } from './device-fixtures';

const state = vi.hoisted(() => ({
  rows: null as unknown as Writable<DeviceStats>,
  devices: null as unknown as Writable<Map<string, DeviceView>>
}));

vi.mock('$lib/reading-history/device-stats', () => ({
  deviceStats: { subscribe: (run: (v: DeviceStats) => void) => state.rows.subscribe(run) },
  devices: {
    subscribe: (run: (v: Map<string, DeviceView>) => void) => state.devices.subscribe(run)
  }
}));
vi.mock('$lib/components/Devices/DeviceNameField.svelte', async () => ({
  default: (await import('./DeviceNameFieldStub.svelte')).default
}));

import SecondDeviceBanner, { DEVICE_BANNER_DISMISSED_KEY } from '../SecondDeviceBanner.svelte';

const me = (over: Partial<DeviceView> = {}) => view('me', { isThisDevice: true, ...over });

/** Two device groups with reading, this one unnamed: the banner's case. */
function twoDevices(): void {
  state.devices.set(mapOf(me(), view('b')));
  state.rows.set(statsOf([row('device', 'me'), row('device', 'b')]));
}

beforeEach(() => {
  window.localStorage.clear();
  state.rows = writable(statsOf([]));
  state.devices = writable(new Map());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SecondDeviceBanner', () => {
  it('stays away for a single device', () => {
    state.devices.set(mapOf(me()));
    state.rows.set(statsOf([row('device', 'me'), row('before-history', 'before-history')]));
    const { queryByTestId } = render(SecondDeviceBanner);
    expect(queryByTestId('device-banner')).toBeNull();
  });

  it('asks to name this device once a second device has reading', () => {
    twoDevices();
    const { getByTestId } = render(SecondDeviceBanner);
    const banner = getByTestId('device-banner');
    expect(banner.getAttribute('role')).toBe('status');
    expect(within(banner).getByText('You read on 2 devices — name this one?')).toBeTruthy();
    // The field edits THIS device, not the other one.
    expect(within(banner).getByLabelText('Device name').getAttribute('data-device')).toBe('me');
    expect(within(banner).getByRole('button', { name: 'Not now' })).toBeTruthy();
  });

  it('counts every device group', () => {
    state.devices.set(mapOf(me(), view('b'), view('c')));
    state.rows.set(statsOf([row('device', 'me'), row('device', 'b'), row('device', 'c')]));
    const { getByText } = render(SecondDeviceBanner);
    expect(getByText('You read on 3 devices — name this one?')).toBeTruthy();
  });

  it('asks about the group this device belongs to when it was merged into another', () => {
    state.devices.set(
      mapOf(
        view('me', { canonical: 'main' }),
        view('main', { isThisDevice: true, mergedFrom: ['me'] }),
        view('b')
      )
    );
    state.rows.set(statsOf([row('device', 'main'), row('device', 'b')]));
    const { getByLabelText } = render(SecondDeviceBanner);
    expect(getByLabelText('Device name').getAttribute('data-device')).toBe('main');
  });

  it('stays away once this device has a name', () => {
    state.devices.set(mapOf(me({ label: 'Work laptop', named: true }), view('b')));
    state.rows.set(statsOf([row('device', 'me'), row('device', 'b')]));
    const { queryByTestId } = render(SecondDeviceBanner);
    expect(queryByTestId('device-banner')).toBeNull();
  });

  it('"Not now" hides it in this browser for good', async () => {
    twoDevices();
    const first = render(SecondDeviceBanner);
    await fireEvent.click(first.getByRole('button', { name: 'Not now' }));
    expect(first.queryByTestId('device-banner')).toBeNull();
    expect(window.localStorage.getItem(DEVICE_BANNER_DISMISSED_KEY)).toBe('1');
    cleanup();
    const again = render(SecondDeviceBanner);
    expect(again.queryByTestId('device-banner')).toBeNull();
  });

  it('naming the device here keeps the banner in place, confirmed, until closed', async () => {
    twoDevices();
    const { getByTestId, getByRole, queryByTestId } = render(SecondDeviceBanner);
    const banner = getByTestId('device-banner');
    state.devices.set(mapOf(me({ label: 'Work laptop', named: true }), view('b')));
    await tick();
    // Same element, same field: nothing jumps under the pointer.
    expect(getByTestId('device-banner')).toBe(banner);
    expect(within(banner).getByLabelText('Device name')).toBeTruthy();
    expect(within(banner).getByText(/^Saved\./)).toBeTruthy();
    await fireEvent.click(getByRole('button', { name: 'Close' }));
    expect(queryByTestId('device-banner')).toBeNull();
  });

  it('still asks, and "Not now" still hides it, when storage is blocked', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    twoDevices();
    const { getByRole, queryByTestId } = render(SecondDeviceBanner);
    expect(queryByTestId('device-banner')).toBeTruthy();
    await fireEvent.click(getByRole('button', { name: 'Not now' }));
    expect(queryByTestId('device-banner')).toBeNull();
  });
});
