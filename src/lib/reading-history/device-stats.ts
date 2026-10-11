import { liveQuery } from 'dexie';
import { derived, readable, type Readable } from 'svelte/store';
import { browser } from '$app/environment';
import { deviceLabels, type DeviceLabel } from '$lib/settings/tracking-data';
import { volumes } from '$lib/settings/volume-data';
import { labelDevices, resolveDevice, type DeviceView, type KnownDevice } from './devices';
import type { HistoryDexie } from './history-db';
import { isDeviceId } from './paths';
import { ownDeviceId } from './position-store';
import type { DeviceTotals } from './stats-engine';
import {
  figuresFor,
  readingStats,
  unexplainedBaseline,
  type BaselineSource,
  type ReadingStatsState
} from './stats-store';
import type { DeviceFacts } from './types';

/**
 * Device views' data (phase 4): which devices the history knows, their
 * labels, and the reading split by device.
 *
 * - **Known devices** = facts rows (`db.devices`, read live) ∪ every device
 *   id with events. Converted turns (`legacy:…`) are never a device.
 * - **Merges group, never rewrite.** The engine keeps raw ids
 *   (`VolumeTotals.byDevice`); `resolveDevice` folds them into groups here,
 *   so a merge or an unmerge regroups without recounting anything.
 * - **The rows add up to the page.** Device rows, "Before history" (converted
 *   turns + each record's unexplained pre-history snapshot) and "Edits"
 *   (volume-editor adjusts, plus whatever the zero clamp takes back) sum to
 *   Σ `figuresFor` over the same records — the reading-speed page's totals.
 */

/** A device's speed shows from this much of its counted reading. */
export const SPEED_MIN_SAMPLE_MS = 30 * 60_000;
export const BEFORE_HISTORY = 'before-history';
export const EDITS = 'edits';
const EPOCH = new Date(0).toISOString();

export interface DeviceStatsRow {
  /** The group's canonical device id, or `BEFORE_HISTORY` / `EDITS`. */
  key: string;
  kind: 'device' | 'before-history' | 'edits';
  /** Raw device ids in the group, sorted (device rows only). */
  members: string[];
  /** Edits may be negative: an editor edit can take time away. */
  timeMs: number;
  readChars: number;
  skippedChars: number;
  sampleMs: number;
  sampleChars: number;
  /** Device rows with `SPEED_MIN_SAMPLE_MS` of samples; else `null`. */
  charsPerMinute: number | null;
  /** Of `DeviceStats.totalTimeMs`, within 0–1. */
  share: number;
  firstReadAt: number | null;
  /** From the newest view — never a device file's `last_seen` (stale). */
  lastReadAt: number | null;
}

export interface DeviceStats {
  /** Device groups by first read, then "Before history", then "Edits" (each only when non-zero). */
  rows: DeviceStatsRow[];
  totalTimeMs: number;
  totalChars: number;
  /** Device groups with reading of their own (what the stats card and the banner wait for). */
  nativeGroups: number;
}

/** `db.devices`, kept current. Dexie re-runs it only when that table is written (start, imports). */
export function liveDeviceFacts(open: () => Promise<HistoryDexie>): Readable<DeviceFacts[]> {
  return readable<DeviceFacts[]>([], (set) => {
    if (!browser) return;
    let stopped = false;
    let subscription: { unsubscribe(): void } | null = null;
    open().then(
      (db) => {
        if (stopped) return;
        subscription = liveQuery(() => db.devices.toArray()).subscribe({
          next: (rows) => set(rows),
          error: (error) => console.debug('[reading-history] device facts query failed:', error)
        });
      },
      (error) => console.debug('[reading-history] device facts unavailable:', error)
    );
    return () => {
      stopped = true;
      subscription?.unsubscribe();
    };
  });
}

export const deviceFacts: Readable<DeviceFacts[]> = liveDeviceFacts(() =>
  import('./history-db').then((m) => m.historyDb())
);

/** Facts rows ∪ event devices, by id. An id with events but no facts is an unknown class, first seen at its first view. */
export function knownDevicesFrom(
  facts: readonly DeviceFacts[],
  stats: ReadingStatsState
): KnownDevice[] {
  const firstRead = new Map<string, number | null>();
  for (const totals of stats.byVolume.values()) {
    for (const [id, part] of totals.byDevice) {
      if (!isDeviceId(id)) continue;
      const seen = firstRead.get(id) ?? null;
      const at = part.firstReadAt;
      firstRead.set(id, at === null ? seen : Math.min(seen ?? at, at));
    }
  }
  const known = new Map<string, KnownDevice>();
  for (const [id, at] of firstRead) {
    known.set(id, {
      id,
      facts: { class: 'unknown' },
      firstSeen: at === null ? EPOCH : new Date(at).toISOString()
    });
  }
  for (const row of facts) {
    if (!isDeviceId(row.device)) continue;
    const own: NonNullable<KnownDevice['facts']> = { class: row.class };
    if (row.os) own.os = row.os;
    if (row.browser) own.browser = row.browser;
    known.set(row.device, { id: row.device, facts: own, firstSeen: row.first_seen });
  }
  return [...known.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** `source`, emitting only when `signature` changes (a page turn rarely changes who is known). */
function distinct<T>(source: Readable<T>, signature: (value: T) => string): Readable<T> {
  return readable<T>(undefined as T, (set) => {
    let last: string | null = null;
    return source.subscribe((value) => {
      const next = signature(value);
      if (next === last) return;
      last = next;
      set(value);
    });
  });
}

export const knownDevices: Readable<KnownDevice[]> = distinct(
  derived([deviceFacts, readingStats], ([$facts, $stats]) => knownDevicesFrom($facts, $stats)),
  (known) => JSON.stringify(known)
);

/** Every known device by raw id, labelled; "This device" is the group holding this device's id. */
export const devices: Readable<Map<string, DeviceView>> = derived(
  [knownDevices, deviceLabels, ownDeviceId],
  ([$known, $labels, $own]) => labelDevices($known, $labels, $own ?? '')
);

function emptyRow(key: string, kind: DeviceStatsRow['kind']): DeviceStatsRow {
  return {
    key,
    kind,
    members: [],
    timeMs: 0,
    readChars: 0,
    skippedChars: 0,
    sampleMs: 0,
    sampleChars: 0,
    charsPerMinute: null,
    share: 0,
    firstReadAt: null,
    lastReadAt: null
  };
}

function addViews(row: DeviceStatsRow, part: DeviceTotals): void {
  row.timeMs += part.timeMs;
  row.readChars += part.readChars;
  row.skippedChars += part.skippedChars;
  row.sampleMs += part.sampleMs;
  row.sampleChars += part.sampleChars;
  if (part.firstReadAt !== null) {
    row.firstReadAt = Math.min(row.firstReadAt ?? part.firstReadAt, part.firstReadAt);
  }
  if (part.lastReadAt !== null) {
    row.lastReadAt = Math.max(row.lastReadAt ?? part.lastReadAt, part.lastReadAt);
  }
}

/** The reading split by device group, over the same records the page totals. */
export function deviceStatsFrom(
  stats: ReadingStatsState,
  records: Record<string, BaselineSource>,
  labels: Record<string, DeviceLabel>
): DeviceStats {
  const groups = new Map<string, DeviceStatsRow>();
  const before = emptyRow(BEFORE_HISTORY, 'before-history');
  const edits = emptyRow(EDITS, 'edits');
  let totalTimeMs = 0;
  let totalChars = 0;
  for (const [volume, record] of Object.entries(records)) {
    // The page skips these too (`calculateReadingSpeedStats`).
    if (!volume) continue;
    const totals = stats.byVolume.get(volume);
    const figures = figuresFor(stats, volume, record);
    const baseline = unexplainedBaseline(stats, volume, record);
    totalTimeMs += figures.timeMs;
    totalChars += figures.chars;
    before.timeMs += baseline.timeMs;
    before.readChars += baseline.chars;
    // `figuresFor` clamps at zero after adding the baseline; only edits
    // (negative adjusts) can go below it, so what the clamp gives back is theirs.
    edits.timeMs += Math.max(0, -((totals?.timeMs ?? 0) + baseline.timeMs));
    edits.readChars += Math.max(0, -((totals?.readChars ?? 0) + baseline.chars));
    if (!totals) continue;
    for (const [id, part] of totals.byDevice) {
      edits.timeMs += part.adjustMs;
      edits.readChars += part.adjustChars;
      if (part.firstReadAt === null) continue;
      if (!isDeviceId(id)) {
        addViews(before, part);
        continue;
      }
      const key = resolveDevice(id, labels);
      let row = groups.get(key);
      if (!row) groups.set(key, (row = emptyRow(key, 'device')));
      if (!row.members.includes(id)) row.members.push(id);
      addViews(row, part);
    }
  }

  const deviceRows = [...groups.values()].sort(
    (a, b) =>
      (a.firstReadAt ?? 0) - (b.firstReadAt ?? 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
  for (const row of deviceRows) {
    row.members.sort();
    row.charsPerMinute =
      row.sampleMs >= SPEED_MIN_SAMPLE_MS ? (row.sampleChars / row.sampleMs) * 60_000 : null;
  }
  const rows = [...deviceRows];
  if (before.timeMs !== 0 || before.readChars !== 0 || before.skippedChars !== 0) rows.push(before);
  if (edits.timeMs !== 0 || edits.readChars !== 0) rows.push(edits);
  for (const row of rows) {
    row.share = totalTimeMs > 0 ? Math.min(1, Math.max(0, row.timeMs / totalTimeMs)) : 0;
  }
  return { rows, totalTimeMs, totalChars, nativeGroups: deviceRows.length };
}

export const deviceStats: Readable<DeviceStats> = derived(
  [readingStats, volumes, deviceLabels],
  ([$stats, $records, $labels]) => deviceStatsFrom($stats, $records, $labels)
);
