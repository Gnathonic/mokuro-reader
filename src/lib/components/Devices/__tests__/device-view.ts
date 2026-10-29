import type { DeviceView } from '$lib/reading-history/devices';

/** A DeviceView as `labelDevices` builds it: unnamed, unmerged, not this device. */
export function deviceView(id: string, over: Partial<DeviceView> = {}): DeviceView {
  const generated = over.generated ?? 'Desktop · Linux · Firefox';
  return {
    id,
    label: generated,
    generated,
    named: false,
    class: 'desktop',
    detectedClass: 'desktop',
    isThisDevice: false,
    canonical: id,
    mergedFrom: [],
    firstSeen: '2026-03-01T00:00:00.000Z',
    ...over
  };
}

/** The `devices` store's shape: every view under its raw id. */
export function deviceMap(...views: DeviceView[]): Map<string, DeviceView> {
  return new Map(views.map((v) => [v.id, v]));
}
