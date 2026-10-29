import { isDeviceId } from './paths';
import type { DeviceClass, DeviceFacts, DeviceLabel } from './types';

/**
 * Device labels (phase 4, spec: "Device record → Labels"). Pure: no stores,
 * no IndexedDB.
 *
 * - A device's GROUP is where its `merged_into` chain ends (`resolveDevice`).
 *   Only device lists and per-device stats group; event ids are never
 *   rewritten.
 * - The UUID is never shown. An unnamed device shows its generated label,
 *   `<class> · <OS> · <browser>`. Devices whose generated labels collide get
 *   their first-seen month (UTC, so every device agrees), then a number.
 *   Collisions are decided over EVERY known device, named and merged ones
 *   included, so renaming or merging one never relabels another.
 * - "This device" is a flag on the group that holds it, never label text.
 */

export const CLASS_NAMES: Readonly<Record<DeviceClass, string>> = {
  phone: 'Phone',
  tablet: 'Tablet',
  laptop: 'Laptop',
  desktop: 'Desktop',
  unknown: 'Device'
};

export const UNKNOWN_DEVICE_LABEL = 'Unknown device';

const DEVICE_CLASSES = Object.keys(CLASS_NAMES) as DeviceClass[];

export function isDeviceClass(value: unknown): value is DeviceClass {
  return (DEVICE_CLASSES as unknown[]).includes(value);
}

/** A device this one knows of: a facts row, or only events (`facts` absent). */
export interface KnownDevice {
  id: string;
  facts?: Pick<DeviceFacts, 'class' | 'os' | 'browser'>;
  /** ISO: the facts' `first_seen`, else the earliest event's `t`. */
  firstSeen: string;
}

export interface DeviceView {
  /** Raw device id. */
  id: string;
  /** What to show: the user's name, else `generated`. */
  label: string;
  /** The generated label, disambiguated. The rename field's placeholder. */
  generated: string;
  /** The user named it. */
  named: boolean;
  /** The user's correction, else `detectedClass`. */
  class: DeviceClass;
  detectedClass: DeviceClass;
  /** On the group's own view (`id === canonical`) when the group holds this device. */
  isThisDevice: boolean;
  /** The group this device counts under; its own id when unmerged. */
  canonical: string;
  /** On a group's own view: the devices merged into it, by first seen. Else empty. */
  mergedFrom: string[];
  firstSeen: string;
}

/** Labels arrive from a synced file: never read an inherited key (`constructor`). */
function labelOf(
  labels: Readonly<Record<string, DeviceLabel>>,
  id: string
): DeviceLabel | undefined {
  return Object.prototype.hasOwnProperty.call(labels, id) ? labels[id] : undefined;
}

/**
 * The group `id` counts under: follow `merged_into` to the end. A device on,
 * or leading into, a cycle (two devices merged into each other between
 * syncs) resolves to itself, so every one of them shows unmerged — the same
 * answer on every device, since it depends only on the synced labels. A
 * target this device has never seen still resolves.
 */
export function resolveDevice(id: string, labels: Readonly<Record<string, DeviceLabel>>): string {
  const seen = new Set([id]);
  let at = id;
  for (;;) {
    const next = labelOf(labels, at)?.merged_into;
    if (next === undefined || !isDeviceId(next)) return at;
    if (seen.has(next)) return id;
    seen.add(next);
    at = next;
  }
}

/** `<class> · <OS> · <browser>`, skipping what is unknown. */
export function generatedLabel(
  facts?: Pick<DeviceFacts, 'class' | 'os' | 'browser'>,
  override?: DeviceClass
): string {
  const cls = override ?? facts?.class ?? 'unknown';
  if (cls === 'unknown' && !facts?.os && !facts?.browser) return UNKNOWN_DEVICE_LABEL;
  return [CLASS_NAMES[cls], facts?.os, facts?.browser].filter(Boolean).join(' · ');
}

/** "Mar 2026", in UTC. Null for a stamp that is not a date. */
function sinceMonth(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('en', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function byFirstSeen(a: KnownDevice, b: KnownDevice): number {
  if (a.firstSeen !== b.firstSeen) return a.firstSeen < b.firstSeen ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Group ids by `keyOf`, keeping only keys two or more devices share. */
function collisions(devices: KnownDevice[], keyOf: (d: KnownDevice) => string): KnownDevice[][] {
  const groups = new Map<string, KnownDevice[]>();
  for (const device of devices) {
    const key = keyOf(device);
    const group = groups.get(key);
    if (group) group.push(device);
    else groups.set(key, [device]);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

/**
 * One view per raw device id (legacy pseudo-devices dropped), in first-seen
 * order. A merge target missing from `known` gets a view of its own, first
 * seen with the earliest device merged into it.
 */
export function labelDevices(
  known: readonly KnownDevice[],
  labels: Readonly<Record<string, DeviceLabel>>,
  own: string
): Map<string, DeviceView> {
  const byId = new Map<string, KnownDevice>();
  for (const device of known) {
    if (!isDeviceId(device.id)) continue;
    const seen = byId.get(device.id);
    byId.set(
      device.id,
      seen
        ? {
            id: device.id,
            facts: seen.facts ?? device.facts,
            firstSeen: seen.firstSeen < device.firstSeen ? seen.firstSeen : device.firstSeen
          }
        : { ...device }
    );
  }

  // A merge target missing from `known` is first seen with its earliest member.
  const canonical = new Map<string, string>();
  const missing = new Set<string>();
  for (const [id, member] of [...byId]) {
    const group = resolveDevice(id, labels);
    canonical.set(id, group);
    if (group === id) continue;
    const target = byId.get(group);
    if (!target) {
      byId.set(group, { id: group, firstSeen: member.firstSeen });
      missing.add(group);
    } else if (missing.has(group) && member.firstSeen < target.firstSeen) {
      target.firstSeen = member.firstSeen;
    }
  }
  for (const id of missing) canonical.set(id, id);

  const devices = [...byId.values()].sort(byFirstSeen);

  const generated = new Map<string, string>();
  for (const device of devices) {
    generated.set(device.id, generatedLabel(device.facts, labelOf(labels, device.id)?.class));
  }
  for (const group of collisions(devices, (d) => generated.get(d.id)!)) {
    for (const device of group) {
      const month = sinceMonth(device.firstSeen);
      if (month) generated.set(device.id, `${generated.get(device.id)} (since ${month})`);
    }
  }
  for (const group of collisions(devices, (d) => generated.get(d.id)!)) {
    group.forEach((device, i) => {
      if (i > 0) generated.set(device.id, `${generated.get(device.id)} ${i + 1}`);
    });
  }

  const members = new Map<string, string[]>();
  for (const device of devices) {
    const group = canonical.get(device.id)!;
    if (group !== device.id) members.set(group, [...(members.get(group) ?? []), device.id]);
  }

  const ownGroup = resolveDevice(own, labels);
  const views = new Map<string, DeviceView>();
  for (const device of devices) {
    const label = labelOf(labels, device.id);
    const name = label?.name?.trim();
    const detectedClass = device.facts?.class ?? 'unknown';
    const group = canonical.get(device.id)!;
    views.set(device.id, {
      id: device.id,
      label: name || generated.get(device.id)!,
      generated: generated.get(device.id)!,
      named: Boolean(name),
      class: label?.class ?? detectedClass,
      detectedClass,
      isThisDevice: group === device.id && device.id === ownGroup,
      canonical: group,
      mergedFrom: members.get(device.id) ?? [],
      firstSeen: device.firstSeen
    });
  }
  return views;
}
