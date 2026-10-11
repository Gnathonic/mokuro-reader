import type { DeviceStats, DeviceStatsRow } from '$lib/reading-history/device-stats';
import type { DeviceView } from '$lib/reading-history/devices';

export const MIN = 60_000;

export const view = (id: string, over: Partial<DeviceView> = {}): DeviceView => {
  const label = over.label ?? `Label ${id}`;
  return {
    id,
    label,
    generated: over.generated ?? label,
    named: false,
    class: 'phone',
    detectedClass: 'phone',
    isThisDevice: false,
    canonical: id,
    mergedFrom: [],
    firstSeen: '2026-03-01T00:00:00.000Z',
    ...over
  };
};

export const row = (
  kind: DeviceStatsRow['kind'],
  key: string,
  over: Partial<DeviceStatsRow> = {}
): DeviceStatsRow => ({
  key,
  kind,
  members: kind === 'device' ? [key] : [],
  timeMs: 60 * MIN,
  readChars: 6000,
  skippedChars: 0,
  sampleMs: 0,
  sampleChars: 0,
  charsPerMinute: null,
  share: 0,
  firstReadAt: null,
  lastReadAt: null,
  ...over
});

export const statsOf = (rows: DeviceStatsRow[]): DeviceStats => ({
  rows,
  totalTimeMs: rows.reduce((s, r) => s + r.timeMs, 0),
  totalChars: rows.reduce((s, r) => s + r.readChars, 0),
  nativeGroups: rows.filter((r) => r.kind === 'device').length
});

export const mapOf = (...views: DeviceView[]) => new Map(views.map((v) => [v.id, v]));
