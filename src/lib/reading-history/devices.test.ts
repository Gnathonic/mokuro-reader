import { describe, expect, it } from 'vitest';
import {
  generatedLabel,
  isDeviceClass,
  labelDevices,
  resolveDevice,
  type KnownDevice
} from './devices';
import { legacyDeviceFor } from './paths';
import type { DeviceLabel } from './types';

const STAMP = '2026-10-01T00:00:00.000Z';
const merged = (target: string): DeviceLabel => ({ merged_into: target, lastUpdated: STAMP });

const PHONE = { class: 'phone', os: 'Android', browser: 'Chrome' } as const;
const DESKTOP = { class: 'desktop', os: 'Windows', browser: 'Firefox' } as const;

function known(id: string, facts: KnownDevice['facts'], firstSeen: string): KnownDevice {
  return { id, facts, firstSeen };
}

describe('resolveDevice', () => {
  it('an unmerged device is its own group', () => {
    expect(resolveDevice('a', {})).toBe('a');
    expect(resolveDevice('a', { a: { name: 'Pixel 8', lastUpdated: STAMP } })).toBe('a');
  });

  it('follows merged_into to the end of a chain', () => {
    const labels = { a: merged('b'), b: merged('c') };
    expect(resolveDevice('a', labels)).toBe('c');
    expect(resolveDevice('b', labels)).toBe('c');
    expect(resolveDevice('c', labels)).toBe('c');
  });

  it('a target this device has never seen still resolves', () => {
    expect(resolveDevice('a', { a: merged('x') })).toBe('x');
  });

  it('every device on or into a cycle shows unmerged (concurrent merges A→B, B→A)', () => {
    const labels = { a: merged('b'), b: merged('a'), d: merged('a') };
    expect(resolveDevice('a', labels)).toBe('a');
    expect(resolveDevice('b', labels)).toBe('b');
    expect(resolveDevice('d', labels)).toBe('d');
    expect(resolveDevice('s', { s: merged('s') })).toBe('s');
  });

  it('never follows into a legacy pseudo-device, nor reads inherited object keys', () => {
    expect(resolveDevice('a', { a: merged(legacyDeviceFor('vol-1')) })).toBe('a');
    expect(resolveDevice('constructor', {})).toBe('constructor');
  });
});

describe('generatedLabel', () => {
  it('is class · OS · browser, skipping what is unknown', () => {
    expect(generatedLabel(PHONE)).toBe('Phone · Android · Chrome');
    expect(generatedLabel({ class: 'desktop', os: 'Linux' })).toBe('Desktop · Linux');
    expect(generatedLabel({ class: 'tablet', browser: 'Safari' })).toBe('Tablet · Safari');
  });

  it('the user’s class correction replaces the detected one', () => {
    expect(generatedLabel(DESKTOP, 'laptop')).toBe('Laptop · Windows · Firefox');
  });

  it('a device nothing is known about is "Unknown device"', () => {
    expect(generatedLabel(undefined)).toBe('Unknown device');
    expect(generatedLabel({ class: 'unknown' })).toBe('Unknown device');
    expect(generatedLabel({ class: 'unknown', os: 'Linux', browser: 'Firefox' })).toBe(
      'Device · Linux · Firefox'
    );
  });

  it('knows the closed set of classes', () => {
    expect(isDeviceClass('laptop')).toBe(true);
    expect(isDeviceClass('watch')).toBe(false);
    expect(isDeviceClass('toString')).toBe(false);
    expect(isDeviceClass(undefined)).toBe(false);
  });
});

describe('labelDevices', () => {
  it('labels each device, marks this one, and never shows a legacy pseudo-device', () => {
    const views = labelDevices(
      [
        known('own', DESKTOP, '2026-01-10T00:00:00.000Z'),
        known('phone', PHONE, '2026-02-10T00:00:00.000Z'),
        known(legacyDeviceFor('vol-1'), undefined, '2025-01-01T00:00:00.000Z')
      ],
      {},
      'own'
    );
    expect([...views.keys()]).toEqual(['own', 'phone']);
    expect(views.get('own')).toEqual({
      id: 'own',
      label: 'Desktop · Windows · Firefox',
      generated: 'Desktop · Windows · Firefox',
      named: false,
      class: 'desktop',
      detectedClass: 'desktop',
      isThisDevice: true,
      canonical: 'own',
      mergedFrom: [],
      firstSeen: '2026-01-10T00:00:00.000Z'
    });
    expect(views.get('phone')).toMatchObject({
      label: 'Phone · Android · Chrome',
      isThisDevice: false
    });
  });

  it('a user name is shown verbatim; a class correction changes the class, not the detected one', () => {
    const views = labelDevices(
      [
        known('a', DESKTOP, '2026-01-10T00:00:00.000Z'),
        known('b', PHONE, '2026-02-10T00:00:00.000Z'),
        known('c', PHONE, '2026-02-11T00:00:00.000Z')
      ],
      {
        a: { class: 'laptop', lastUpdated: STAMP },
        b: { name: 'Pixel 8', lastUpdated: STAMP },
        c: { name: '   ', lastUpdated: STAMP }
      },
      'a'
    );
    expect(views.get('a')).toMatchObject({
      label: 'Laptop · Windows · Firefox',
      named: false,
      class: 'laptop',
      detectedClass: 'desktop'
    });
    expect(views.get('b')).toMatchObject({ label: 'Pixel 8', named: true, class: 'phone' });
    expect(views.get('c')).toMatchObject({ named: false });
  });

  it('devices that generate the same label both get their first-seen month (UTC)', () => {
    const views = labelDevices(
      [
        // 23:30 on 28 Feb in New York is already March in UTC.
        known('a', PHONE, '2026-02-28T23:30:00-05:00'),
        known('b', PHONE, '2026-06-02T00:00:00.000Z'),
        known('c', DESKTOP, '2026-04-01T00:00:00.000Z')
      ],
      {},
      'c'
    );
    expect(views.get('a')!.label).toBe('Phone · Android · Chrome (since Mar 2026)');
    expect(views.get('b')!.label).toBe('Phone · Android · Chrome (since Jun 2026)');
    expect(views.get('c')!.label).toBe('Desktop · Windows · Firefox');
  });

  it('same label and same month: numbered by first seen, then id', () => {
    const views = labelDevices(
      [
        known('z', PHONE, '2026-03-20T00:00:00.000Z'),
        known('y', PHONE, '2026-03-05T00:00:00.000Z'),
        known('x', PHONE, '2026-03-05T00:00:00.000Z')
      ],
      {},
      'x'
    );
    expect(views.get('x')!.label).toBe('Phone · Android · Chrome (since Mar 2026)');
    expect(views.get('y')!.label).toBe('Phone · Android · Chrome (since Mar 2026) 2');
    expect(views.get('z')!.label).toBe('Phone · Android · Chrome (since Mar 2026) 3');
  });

  it('a device keeps its label when another is renamed or merged', () => {
    const devices = [
      known('a', PHONE, '2026-03-01T00:00:00.000Z'),
      known('b', PHONE, '2026-05-01T00:00:00.000Z')
    ];
    const before = labelDevices(devices, {}, 'a').get('a')!.label;
    const renamed = labelDevices(devices, { b: { name: 'Pixel 8', lastUpdated: STAMP } }, 'a');
    const mergedAway = labelDevices(devices, { b: merged('a') }, 'a');
    expect(before).toBe('Phone · Android · Chrome (since Mar 2026)');
    expect(renamed.get('a')!.label).toBe(before);
    expect(mergedAway.get('a')!.label).toBe(before);
    // The renamed device still offers its generated label as the placeholder.
    expect(renamed.get('b')!.generated).toBe('Phone · Android · Chrome (since May 2026)');
  });

  it('a merged device points at its group; the group lists it and carries "This device"', () => {
    const views = labelDevices(
      [
        known('own', PHONE, '2026-01-01T00:00:00.000Z'),
        known('old', PHONE, '2025-11-01T00:00:00.000Z'),
        known('pc', DESKTOP, '2026-02-01T00:00:00.000Z')
      ],
      { own: merged('pc'), old: merged('own') },
      'own'
    );
    expect(views.get('pc')).toMatchObject({
      canonical: 'pc',
      mergedFrom: ['old', 'own'],
      isThisDevice: true
    });
    expect(views.get('own')).toMatchObject({
      canonical: 'pc',
      mergedFrom: [],
      isThisDevice: false
    });
    expect(views.get('old')).toMatchObject({
      canonical: 'pc',
      mergedFrom: [],
      isThisDevice: false
    });
  });

  it('a merge target this device has never seen gets a group of its own', () => {
    const views = labelDevices(
      [
        known('own', DESKTOP, '2026-01-01T00:00:00.000Z'),
        known('a', PHONE, '2026-03-01T00:00:00.000Z')
      ],
      { a: merged('gone') },
      'own'
    );
    expect(views.get('gone')).toMatchObject({
      label: 'Unknown device',
      canonical: 'gone',
      mergedFrom: ['a'],
      detectedClass: 'unknown',
      firstSeen: '2026-03-01T00:00:00.000Z'
    });
    expect(views.get('a')!.canonical).toBe('gone');
  });

  it('a cycle from concurrent merges leaves both devices as their own groups', () => {
    const views = labelDevices(
      [
        known('a', PHONE, '2026-01-01T00:00:00.000Z'),
        known('b', DESKTOP, '2026-02-01T00:00:00.000Z')
      ],
      { a: merged('b'), b: merged('a') },
      'a'
    );
    expect(views.get('a')).toMatchObject({ canonical: 'a', mergedFrom: [], isThisDevice: true });
    expect(views.get('b')).toMatchObject({ canonical: 'b', mergedFrom: [], isThisDevice: false });
  });

  it('a device known twice keeps its facts and its earliest first-seen', () => {
    const views = labelDevices(
      [
        known('a', undefined, '2026-01-05T00:00:00.000Z'),
        known('a', PHONE, '2026-02-01T00:00:00.000Z')
      ],
      {},
      'a'
    );
    expect(views.size).toBe(1);
    expect(views.get('a')).toMatchObject({
      label: 'Phone · Android · Chrome',
      firstSeen: '2026-01-05T00:00:00.000Z'
    });
  });

  it('a device with events but no device.json is an "Unknown device"', () => {
    const views = labelDevices(
      [
        known('own', DESKTOP, '2026-01-01T00:00:00.000Z'),
        known('ev', undefined, '2026-03-01T00:00:00.000Z')
      ],
      {},
      'own'
    );
    expect(views.get('ev')).toMatchObject({
      label: 'Unknown device',
      class: 'unknown',
      detectedClass: 'unknown'
    });
  });
});
