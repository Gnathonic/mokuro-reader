import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { writable, type Writable } from 'svelte/store';
import type { DeviceStats } from '$lib/reading-history/device-stats';
import type { DeviceView } from '$lib/reading-history/devices';
import { MIN, mapOf, row, statsOf, view } from './device-fixtures';

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
// turns-store (reached through volume-data, via the duration formatters) registers a listener at import.
vi.mock('$lib/reading-history/record', () => ({ onEventsRecorded: () => () => {} }));

import DeviceStatsCard from '../DeviceStatsCard.svelte';

const labelsOf = (rows: HTMLElement[]) =>
  rows.map((r) => r.querySelector('[data-testid="device-name"]')?.textContent?.trim());

beforeEach(() => {
  state.rows = writable(statsOf([]));
  state.devices = writable(new Map());
});
afterEach(cleanup);

describe('DeviceStatsCard', () => {
  it('renders nothing for one device, even beside a "Before history" row', () => {
    state.devices.set(mapOf(view('me', { isThisDevice: true })));
    state.rows.set(statsOf([row('device', 'me'), row('before-history', 'before-history')]));
    const { queryByTestId } = render(DeviceStatsCard);
    expect(queryByTestId('device-stats')).toBeNull();
  });

  it('lists this device first, the others by first seen, then "Before history" and "Edits"', () => {
    state.devices.set(
      mapOf(
        view('late', { label: 'Phone · Android · Chrome', firstSeen: '2026-05-01T00:00:00.000Z' }),
        view('me', { label: 'Desktop · Linux · Firefox', isThisDevice: true }),
        view('early', { label: 'Tablet · iOS · Safari', firstSeen: '2026-01-01T00:00:00.000Z' })
      )
    );
    state.rows.set(
      statsOf([
        row('edits', 'edits', { timeMs: 5 * MIN, readChars: 0 }),
        row('device', 'late'),
        row('before-history', 'before-history'),
        row('device', 'me'),
        row('device', 'early')
      ])
    );
    const { getByTestId, getAllByTestId } = render(DeviceStatsCard);
    expect(getByTestId('device-stats')).toBeTruthy();
    const rows = getAllByTestId('device-row');
    expect(labelsOf(rows)).toEqual([
      'Desktop · Linux · Firefox',
      'Tablet · iOS · Safari',
      'Phone · Android · Chrome',
      'Before history',
      'Edits'
    ]);
    expect(within(rows[0]).getByText('This device')).toBeTruthy();
    for (const other of rows.slice(1)) expect(within(other).queryByText('This device')).toBeNull();
  });

  it('shows time, characters, share of time, speed and last read per row', () => {
    state.devices.set(mapOf(view('me', { isThisDevice: true }), view('b')));
    state.rows.set(
      statsOf([
        row('device', 'me', {
          timeMs: 90 * MIN,
          readChars: 9000,
          charsPerMinute: 100.4,
          share: 0.75,
          lastReadAt: Date.now() - 2 * MIN
        }),
        row('device', 'b', { timeMs: 30 * MIN, readChars: 1234, charsPerMinute: null, share: 0.25 })
      ])
    );
    const { getAllByTestId } = render(DeviceStatsCard);
    const [mine, other] = getAllByTestId('device-row');
    expect(within(mine).getByText('1h 30m')).toBeTruthy();
    expect(within(mine).getByText('9,000 chars')).toBeTruthy();
    expect(within(mine).getByText('75% of time')).toBeTruthy();
    expect(within(mine).getByText('100 chars/min')).toBeTruthy();
    expect(within(mine).getByText('Last read today')).toBeTruthy();
    expect(within(other).getByText('30 min')).toBeTruthy();
    expect(within(other).getByText('1,234 chars')).toBeTruthy();
    expect(within(other).getByText('25% of time')).toBeTruthy();
    // Under 30 min of samples the store gives no speed.
    expect(within(other).getByText('—')).toBeTruthy();
  });

  it('hides an empty "Before history" or "Edits" row', () => {
    state.devices.set(mapOf(view('me', { isThisDevice: true }), view('b')));
    state.rows.set(
      statsOf([
        row('device', 'me'),
        row('device', 'b'),
        row('before-history', 'before-history', { timeMs: 0, readChars: 0 }),
        row('edits', 'edits', { timeMs: 0, readChars: 0 })
      ])
    );
    const { getAllByTestId, queryByText } = render(DeviceStatsCard);
    expect(getAllByTestId('device-row')).toHaveLength(2);
    expect(queryByText('Before history')).toBeNull();
    expect(queryByText('Edits')).toBeNull();
  });

  it('a negative "Edits" row shows a signed duration and no share, and nothing jumps', async () => {
    state.devices.set(mapOf(view('me', { isThisDevice: true }), view('b')));
    const before = [
      row('device', 'me', { share: 0.5 }),
      row('device', 'b', { share: 0.5 }),
      row('edits', 'edits', { timeMs: -5 * MIN, readChars: 0, share: 0 })
    ];
    state.rows.set(statsOf(before));
    const { getAllByTestId, getByTestId } = render(DeviceStatsCard);
    const card = getByTestId('device-stats');
    const rows = getAllByTestId('device-row');
    expect(labelsOf(rows)).toEqual(['Label me', 'Label b', 'Edits']);
    const edits = rows[2];
    expect(within(edits).getByText('−5 min')).toBeTruthy();
    expect(
      within(edits).getByText('—', { selector: '[title="Share of reading time"]' })
    ).toBeTruthy();
    // A recount that makes the clamp give back more time: same card, same rows.
    state.rows.set(
      statsOf([
        row('device', 'me', { share: 0.5, timeMs: 61 * MIN }),
        row('device', 'b', { share: 0.5 }),
        row('edits', 'edits', { timeMs: -90 * MIN, readChars: 0, share: 0 })
      ])
    );
    await tick();
    expect(getByTestId('device-stats')).toBe(card);
    expect(getAllByTestId('device-row')).toEqual(rows);
    expect(within(rows[2]).getByText('−1h 30m')).toBeTruthy();
  });

  it('notes the devices merged into a row', () => {
    state.devices.set(
      mapOf(view('me', { isThisDevice: true }), view('b', { mergedFrom: ['c', 'd'] }))
    );
    state.rows.set(statsOf([row('device', 'me'), row('device', 'b')]));
    const { getAllByTestId } = render(DeviceStatsCard);
    expect(
      within(getAllByTestId('device-row')[1]).getByText(/includes 2 merged devices/)
    ).toBeTruthy();
  });

  it('clicking a device name opens the name field for that device; done closes it', async () => {
    state.devices.set(
      mapOf(view('me', { isThisDevice: true }), view('b', { label: 'Phone · Android · Chrome' }))
    );
    state.rows.set(statsOf([row('device', 'me'), row('device', 'b')]));
    const { getAllByTestId, queryByLabelText } = render(DeviceStatsCard);
    const other = getAllByTestId('device-row')[1];
    await fireEvent.click(within(other).getByRole('button', { name: 'Phone · Android · Chrome' }));
    const field = within(other).getByLabelText('Device name');
    expect(field.getAttribute('data-device')).toBe('b');
    expect(document.activeElement).toBe(field);
    // One field at a time, and only in the row clicked.
    expect(within(getAllByTestId('device-row')[0]).queryByLabelText('Device name')).toBeNull();
    await fireEvent.click(within(other).getByRole('button', { name: 'Done' }));
    expect(queryByLabelText('Device name')).toBeNull();
    expect(within(other).getByRole('button', { name: 'Phone · Android · Chrome' })).toBeTruthy();
  });

  it('a renamed device shows its new name in place', async () => {
    state.devices.set(mapOf(view('me', { isThisDevice: true }), view('b')));
    state.rows.set(statsOf([row('device', 'me'), row('device', 'b')]));
    const { getAllByTestId } = render(DeviceStatsCard);
    const before = getAllByTestId('device-row');
    state.devices.set(
      mapOf(view('me', { isThisDevice: true }), view('b', { label: 'Pixel 8', named: true }))
    );
    await tick();
    const after = getAllByTestId('device-row');
    expect(after).toEqual(before);
    expect(within(after[1]).getByRole('button', { name: 'Pixel 8' })).toBeTruthy();
  });

  it('"Before history", "Edits" and a device with no record are not renamable', () => {
    state.devices.set(mapOf(view('me', { isThisDevice: true })));
    state.rows.set(
      statsOf([
        row('device', 'me'),
        row('device', 'gone'),
        row('before-history', 'before-history'),
        row('edits', 'edits')
      ])
    );
    const { getAllByTestId } = render(DeviceStatsCard);
    const rows = getAllByTestId('device-row');
    expect(labelsOf(rows)).toEqual(['Label me', 'Unknown device', 'Before history', 'Edits']);
    for (const fixed of rows.slice(1)) expect(within(fixed).queryByRole('button')).toBeNull();
  });
});
