import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { writable, type Writable } from 'svelte/store';
import type { DeviceView, KnownDevice } from '$lib/reading-history/devices';
import type { DeviceLabel } from '$lib/settings/tracking-data';
import { deviceMap, deviceView } from './device-view';

const state = vi.hoisted(() => ({
  devices: null as unknown as Writable<Map<string, DeviceView>>,
  labels: null as unknown as Writable<Record<string, DeviceLabel>>,
  known: null as unknown as Writable<KnownDevice[] | null>
}));
const setters = vi.hoisted(() => ({
  renameDevice: vi.fn(),
  setDeviceClass: vi.fn(),
  mergeDevice: vi.fn((_source: string, _target: string) => true),
  unmergeDevice: vi.fn()
}));

vi.mock('$lib/reading-history/devices', () => ({
  CLASS_NAMES: {
    phone: 'Phone',
    tablet: 'Tablet',
    laptop: 'Laptop',
    desktop: 'Desktop',
    unknown: 'Device'
  }
}));
vi.mock('$lib/reading-history/device-stats', () => ({
  devices: {
    subscribe: (run: (value: Map<string, DeviceView>) => void) => state.devices.subscribe(run)
  },
  // The raw ids the stores know of: by default every key of `devices`;
  // `state.known` overrides it where `devices` holds a synthesized merge target.
  knownDevices: {
    subscribe: (run: (value: KnownDevice[]) => void) => {
      let map = new Map<string, DeviceView>();
      let known: KnownDevice[] | null = null;
      const emit = () => run(known ?? [...map.keys()].map((id) => ({ id, firstSeen: '' })));
      const stopDevices = state.devices.subscribe((m) => {
        map = m;
        emit();
      });
      const stopKnown = state.known.subscribe((k) => {
        known = k;
        emit();
      });
      return () => {
        stopDevices();
        stopKnown();
      };
    }
  }
}));
vi.mock('$lib/settings/tracking-data', () => ({
  ...setters,
  deviceLabels: {
    subscribe: (run: (value: Record<string, DeviceLabel>) => void) => state.labels.subscribe(run)
  },
  DEVICE_NAME_MAX: 40
}));

import DevicesSettings from '../DevicesSettings.svelte';

const T1 = '2026-10-01T00:00:00.000Z';
const PHONE = 'Phone · Android · Chrome';
const own = deviceView('dev-own', {
  isThisDevice: true,
  generated: PHONE,
  label: PHONE,
  class: 'phone',
  detectedClass: 'phone',
  firstSeen: '2026-06-01T00:00:00.000Z'
});
// Seen BEFORE this device: still listed after it.
const laptop = deviceView('dev-lap', { firstSeen: '2026-01-01T00:00:00.000Z' });
// Seen after the laptop but named "Aaa…": rows never sort by name.
const tablet = deviceView('dev-tab', {
  named: true,
  label: 'Aaa tablet',
  generated: 'Tablet · iOS · Safari',
  class: 'tablet',
  detectedClass: 'tablet',
  firstSeen: '2026-02-01T00:00:00.000Z'
});

beforeEach(() => {
  state.devices = writable(deviceMap(own, laptop));
  state.labels = writable({});
  state.known = writable(null);
  for (const fn of Object.values(setters)) fn.mockClear();
  setters.mergeDevice.mockImplementation(() => true);
});
afterEach(cleanup);

describe('DevicesSettings', () => {
  it('stays hidden while only one device is known', () => {
    state.devices.set(deviceMap(own));
    const { queryByTestId } = render(DevicesSettings);
    expect(queryByTestId('devices-settings')).toBeNull();
  });

  it('lists this device first, then the others by first seen; only the others can be merged', () => {
    state.devices.set(deviceMap(own, laptop, tablet));
    const { getAllByTestId } = render(DevicesSettings);
    const rows = getAllByTestId('device-row');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText('This device')).toBeTruthy();
    expect((within(rows[0]).getByLabelText('Device name') as HTMLInputElement).placeholder).toBe(
      PHONE
    );
    expect(within(rows[0]).queryByRole('button', { name: 'Merge into…' })).toBeNull();
    expect(within(rows[1]).queryByText('This device')).toBeNull();
    expect((within(rows[1]).getByLabelText('Device name') as HTMLInputElement).placeholder).toBe(
      'Desktop · Linux · Firefox'
    );
    expect((within(rows[2]).getByLabelText('Device name') as HTMLInputElement).value).toBe(
      'Aaa tablet'
    );
    expect(within(rows[1]).getByRole('button', { name: 'Merge into…' })).toBeTruthy();
    expect(within(rows[2]).getByRole('button', { name: 'Merge into…' })).toBeTruthy();
  });

  it('renaming a device goes through renameDevice', async () => {
    const { getAllByTestId } = render(DevicesSettings);
    const field = within(getAllByTestId('device-row')[1]).getByLabelText('Device name');
    await fireEvent.input(field, { target: { value: 'Work laptop' } });
    await fireEvent.keyDown(field, { key: 'Enter' });
    expect(setters.renameDevice).toHaveBeenCalledWith('dev-lap', 'Work laptop');
  });

  it('the type offers Automatic with the detected type, writes a correction, and clears it', async () => {
    const { getAllByTestId } = render(DevicesSettings);
    const select = within(getAllByTestId('device-row')[1]).getByLabelText(
      'Device type'
    ) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      'auto',
      'phone',
      'tablet',
      'laptop',
      'desktop'
    ]);
    expect(select.options[0].textContent).toBe('Automatic (detected: Desktop)');
    expect(select.value).toBe('auto');
    select.value = 'laptop';
    await fireEvent.change(select);
    expect(setters.setDeviceClass).toHaveBeenCalledWith('dev-lap', 'laptop');
    select.value = 'auto';
    await fireEvent.change(select);
    expect(setters.setDeviceClass).toHaveBeenLastCalledWith('dev-lap', null);
  });

  it('shows a stored type correction, and plain "Automatic" when nothing was detected', () => {
    state.devices.set(deviceMap(own, deviceView('dev-lap', { detectedClass: 'unknown' })));
    state.labels.set({ 'dev-lap': { class: 'laptop', lastUpdated: T1 } });
    const { getAllByTestId } = render(DevicesSettings);
    const select = within(getAllByTestId('device-row')[1]).getByLabelText(
      'Device type'
    ) as HTMLSelectElement;
    expect(select.value).toBe('laptop');
    expect(select.options[0].textContent).toBe('Automatic');
  });

  it('merging asks first, offers every other device, and merges into the one picked', async () => {
    state.devices.set(deviceMap(own, laptop, tablet));
    const { getAllByTestId, getByLabelText, getByRole, getByText, queryByRole } =
      render(DevicesSettings);
    await fireEvent.click(
      within(getAllByTestId('device-row')[1]).getByRole('button', { name: 'Merge into…' })
    );
    expect(getByText(/listed under the device you pick/)).toBeTruthy();
    const target = getByLabelText('Merge into') as HTMLSelectElement;
    expect(Array.from(target.options).map((o) => [o.value, o.textContent])).toEqual([
      ['dev-own', `${PHONE} (this device)`],
      ['dev-tab', 'Aaa tablet']
    ]);
    expect(target.value).toBe('dev-own');
    target.value = 'dev-tab';
    await fireEvent.change(target);
    await fireEvent.click(getByRole('button', { name: 'Merge' }));
    expect(setters.mergeDevice).toHaveBeenCalledWith('dev-lap', 'dev-tab');
    await waitFor(() => expect(queryByRole('button', { name: 'Merge' })).toBeNull());
  });

  it('a refused merge says so and keeps the dialog open', async () => {
    setters.mergeDevice.mockImplementation(() => false);
    const { getAllByTestId, getByRole, getByText } = render(DevicesSettings);
    await fireEvent.click(
      within(getAllByTestId('device-row')[1]).getByRole('button', { name: 'Merge into…' })
    );
    await fireEvent.click(getByRole('button', { name: 'Merge' }));
    expect(getByText("These two can't be merged.")).toBeTruthy();
    expect(getByRole('button', { name: 'Merge' })).toBeTruthy();
  });

  it('Cancel closes the dialog without merging', async () => {
    const { getAllByTestId, getByRole, queryByRole } = render(DevicesSettings);
    await fireEvent.click(
      within(getAllByTestId('device-row')[1]).getByRole('button', { name: 'Merge into…' })
    );
    await fireEvent.click(getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(queryByRole('button', { name: 'Merge' })).toBeNull());
    expect(setters.mergeDevice).not.toHaveBeenCalled();
  });

  it('merged devices sit under their target with Unmerge, even when one group is left', async () => {
    state.devices.set(
      deviceMap(
        { ...own, mergedFrom: ['dev-lap'] },
        deviceView('dev-lap', { canonical: 'dev-own', firstSeen: laptop.firstSeen })
      )
    );
    const { getAllByTestId } = render(DevicesSettings);
    const rows = getAllByTestId('device-row');
    expect(rows).toHaveLength(1);
    const members = within(rows[0]).getAllByTestId('device-member');
    expect(members).toHaveLength(1);
    expect(within(members[0]).getByText('Desktop · Linux · Firefox')).toBeTruthy();
    await fireEvent.click(within(members[0]).getByRole('button', { name: 'Unmerge' }));
    expect(setters.unmergeDevice).toHaveBeenCalledWith('dev-lap');
  });

  describe('with views built by the real labelDevices', () => {
    async function labelled(
      known: KnownDevice[],
      labels: Record<string, DeviceLabel>,
      ownId: string
    ): Promise<Map<string, DeviceView>> {
      const actual = await vi.importActual<typeof import('$lib/reading-history/devices')>(
        '$lib/reading-history/devices'
      );
      return actual.labelDevices(known, labels, ownId);
    }
    const ownKnown: KnownDevice = {
      id: 'dev-own',
      facts: { class: 'phone', os: 'Android', browser: 'Chrome' },
      firstSeen: '2026-06-01T00:00:00.000Z'
    };
    const remoteKnown: KnownDevice = {
      id: 'dev-rem',
      facts: { class: 'desktop', os: 'Linux', browser: 'Firefox' },
      firstSeen: '2026-01-01T00:00:00.000Z'
    };
    const merged = (into: string): DeviceLabel => ({ merged_into: into, lastUpdated: T1 });

    it('this device merged into another from a remote device: the group is "This device", own id is an Unmerge member, the field edits the target', async () => {
      const labels = { 'dev-own': merged('dev-rem') };
      state.devices.set(await labelled([ownKnown, remoteKnown], labels, 'dev-own'));
      state.labels.set(labels);
      const { getAllByTestId } = render(DevicesSettings);
      const rows = getAllByTestId('device-row');
      expect(rows).toHaveLength(1);
      expect(within(rows[0]).getByText('This device')).toBeTruthy();
      expect(within(rows[0]).queryByRole('button', { name: 'Merge into…' })).toBeNull();
      const members = within(rows[0]).getAllByTestId('device-member');
      expect(members).toHaveLength(1);
      expect(within(members[0]).getByText(PHONE)).toBeTruthy();
      await fireEvent.click(within(members[0]).getByRole('button', { name: 'Unmerge' }));
      expect(setters.unmergeDevice).toHaveBeenCalledWith('dev-own');
      const field = within(rows[0]).getByLabelText('Device name') as HTMLInputElement;
      expect(field.placeholder).toBe('Desktop · Linux · Firefox');
      await fireEvent.input(field, { target: { value: 'Work PC' } });
      await fireEvent.keyDown(field, { key: 'Enter' });
      expect(setters.renameDevice).toHaveBeenCalledWith('dev-rem', 'Work PC');
    });

    it('a single device merged into an id nobody knows stays hidden (the synthesized target is not a second device)', async () => {
      const labels = { 'dev-own': merged('gone') };
      const views = await labelled([ownKnown], labels, 'dev-own');
      // labelDevices synthesizes a view for the missing target: two views, one real device.
      expect(views.size).toBe(2);
      state.devices.set(views);
      state.known.set([ownKnown]);
      state.labels.set(labels);
      const { queryByTestId } = render(DevicesSettings);
      expect(queryByTestId('devices-settings')).toBeNull();
    });
  });
});
