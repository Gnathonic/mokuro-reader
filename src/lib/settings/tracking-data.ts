import { browser } from '$app/environment';
import { derived, get, writable, type Readable } from 'svelte/store';
import { FUTURE_TOLERANCE_MS, isRecord, normalizeUpdatedAt } from '$lib/metadata/sanitize';
import { DEFAULT_K, K_MAX, type IdleSettings } from '$lib/reading-history/stats-engine';
import { isDeviceClass, resolveDevice } from '$lib/reading-history/devices';
import { isDeviceId } from '$lib/reading-history/paths';
import type { DeviceClass, DeviceLabel, PauseCount } from '$lib/reading-history/types';

export type { DeviceLabel };

/**
 * Reading-tracking SETTINGS that belong to the user, not to a device or a
 * profile: they travel in `volume-data.json` under the reserved `tracking`
 * key, beside the `series` section, with the same rules — per key, newest
 * `lastUpdated` wins, a stamp too far in the future is clamped on read and
 * forfeits to a local entry (spec: "Speed and stats", manual override).
 *
 * - `idle`: the idle cutoff every stat uses. `override_minutes` replaces the
 *   adaptive cap everywhere when set; `k` widens it ("Still reading" on a
 *   long-pause prompt raises it, `widenIdleK`). The two share one stamp, so
 *   a widen and an override edit made on two devices between syncs keep only
 *   the newer of the two.
 * - `pauses`: the standing answer to long-pause prompts. `default: null` =
 *   ask. When set, prompts stop and each view that reaches its cap while open
 *   is written with that answer — from then on, never backwards. Its own key,
 *   so it merges apart from `idle`.
 * - `devices`: the user's labels for reading devices, keyed by device id —
 *   a name, a corrected class, `merged_into` another device. A MAP, so it
 *   merges per device id (`mergeDeviceLabels`), and its bogus keys are
 *   namespaced `devices/<id>` in the one bogus set. One stamp per device: a
 *   rename and a merge of the same device on two devices between syncs keep
 *   only the newer edit. The stamp is `lastUpdated` like every sibling here
 *   (the spec's `updated_at` was renamed to match).
 */

export const TRACKING_SECTION_KEY = 'tracking';
export const TRACKING_STORAGE_KEY = 'tracking-data';

export interface IdleEntry {
  k?: number;
  /** `null` = automatic (explicitly chosen, so it beats an older override). */
  override_minutes?: number | null;
  lastUpdated: string;
}

export interface PausesEntry {
  /** `null` = ask (explicitly chosen, so it beats an older default). */
  default: PauseCount | null;
  lastUpdated: string;
}

export interface TrackingState {
  idle?: IdleEntry;
  pauses?: PausesEntry;
  devices?: Record<string, DeviceLabel>;
}

/** The single-entry keys; `devices` is a map and merges per id. */
type EntryKey = Exclude<keyof TrackingState, 'devices'>;
const ENTRY_KEYS: readonly EntryKey[] = ['idle', 'pauses'];

/** Bogus-set id of a device label: `devices/<id>` (`/` is never in a device id). */
export const DEVICE_BOGUS_PREFIX = 'devices/';
export const DEVICE_NAME_MAX = 40;
const NO_LABELS: Record<string, DeviceLabel> = Object.freeze({}) as Record<string, DeviceLabel>;

/** Labels arrive from a synced file: never read an inherited key (`constructor`). */
function ownLabel(
  labels: Readonly<Record<string, DeviceLabel>> | undefined,
  id: string
): DeviceLabel | undefined {
  return labels && Object.hasOwn(labels, id) ? labels[id] : undefined;
}

const K_RANGE = [1, K_MAX] as const;
const OVERRIDE_RANGE = [1, 60] as const;
const PAUSE_COUNTS: readonly PauseCount[] = ['full', 'typical', 'none'];
const EPOCH = new Date(0).toISOString();

const clampK = (k: number): number => Math.min(K_RANGE[1], Math.max(K_RANGE[0], k));

export function isPauseCount(value: unknown): value is PauseCount {
  return (PAUSE_COUNTS as readonly unknown[]).includes(value);
}

function parseIdle(value: Record<string, unknown>): IdleEntry {
  const idle: IdleEntry = { lastUpdated: normalizeUpdatedAt(value.lastUpdated) ?? EPOCH };
  if (typeof value.k === 'number' && Number.isFinite(value.k)) idle.k = clampK(value.k);
  if ('override_minutes' in value) {
    const minutes = value.override_minutes;
    idle.override_minutes =
      typeof minutes === 'number' && minutes >= OVERRIDE_RANGE[0] && minutes <= OVERRIDE_RANGE[1]
        ? minutes
        : null;
  }
  return idle;
}

function parsePauses(value: Record<string, unknown>): PausesEntry {
  return {
    default: isPauseCount(value.default) ? value.default : null,
    lastUpdated: normalizeUpdatedAt(value.lastUpdated) ?? EPOCH
  };
}

/** Trimmed and cut to `DEVICE_NAME_MAX` characters (not UTF-16 units); `undefined` when empty. */
function clampDeviceName(value: string): string | undefined {
  const name = Array.from(value.trim()).slice(0, DEVICE_NAME_MAX).join('').trimEnd();
  return name || undefined;
}

function parseDeviceLabel(id: string, value: Record<string, unknown>): DeviceLabel {
  const label: DeviceLabel = { lastUpdated: normalizeUpdatedAt(value.lastUpdated) ?? EPOCH };
  const name = typeof value.name === 'string' ? clampDeviceName(value.name) : undefined;
  if (name) label.name = name;
  if (isDeviceClass(value.class)) label.class = value.class;
  const target = value.merged_into;
  if (typeof target === 'string' && target !== id && isDeviceId(target)) label.merged_into = target;
  return label;
}

/**
 * Per device id, like `parseSeriesSection`. An id that is not a device id
 * (`legacy:` pseudo-devices included) and a non-record value are dropped; an
 * entry carrying only its stamp is KEPT — it is how a cleared name or an
 * unmerge wins the merge.
 */
function parseDeviceLabels(raw: Record<string, unknown>): Record<string, DeviceLabel> {
  const labels: Record<string, DeviceLabel> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isDeviceId(id) || !isRecord(value)) continue;
    labels[id] = parseDeviceLabel(id, value);
  }
  return labels;
}

/** Validate an untrusted `tracking` section, key by key. Unknown keys are dropped. */
export function parseTrackingSection(raw: unknown): TrackingState {
  const state: TrackingState = {};
  if (!isRecord(raw)) return state;
  if (isRecord(raw.idle)) state.idle = parseIdle(raw.idle);
  if (isRecord(raw.pauses)) state.pauses = parsePauses(raw.pauses);
  if (isRecord(raw.devices)) {
    const devices = parseDeviceLabels(raw.devices);
    if (Object.keys(devices).length > 0) state.devices = devices;
  }
  return state;
}

function isFutureStamp(value: Record<string, unknown>, now: number): boolean {
  if (typeof value.lastUpdated !== 'string') return false;
  const stamp = Date.parse(value.lastUpdated);
  return !Number.isNaN(stamp) && stamp > now + FUTURE_TOLERANCE_MS;
}

/**
 * Keys whose RAW stamp is too far in the future (before the parse clamps it):
 * `idle` / `pauses` by name, a device label as `devices/<id>`.
 */
export function detectBogusTrackingKeys(raw: unknown, now: number = Date.now()): Set<string> {
  const bogus = new Set<string>();
  if (!isRecord(raw)) return bogus;
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'devices' || !isRecord(value)) continue;
    if (isFutureStamp(value, now)) bogus.add(key);
  }
  if (isRecord(raw.devices)) {
    for (const [id, value] of Object.entries(raw.devices)) {
      if (!isDeviceId(id) || !isRecord(value)) continue;
      if (isFutureStamp(value, now)) bogus.add(DEVICE_BOGUS_PREFIX + id);
    }
  }
  return bogus;
}

/**
 * `to[key] = from[key]`. Generic over the key because a write through a
 * UNION of keys must satisfy every entry type at once (`IdleEntry &
 * PausesEntry`) and does not type-check.
 */
export function copyTrackingEntry<K extends keyof TrackingState>(
  to: TrackingState,
  from: TrackingState,
  key: K
): void {
  to[key] = from[key];
}

/**
 * Per device id, like `mergeSeriesSections`: local absent adopts the cloud
 * label; a bogus (`devices/<id>`) cloud label never beats a local one;
 * otherwise a strictly newer stamp wins and a tie keeps local.
 */
export function mergeDeviceLabels(
  local: Record<string, DeviceLabel>,
  cloud: Record<string, DeviceLabel>,
  bogusKeys: ReadonlySet<string> = new Set()
): Record<string, DeviceLabel> {
  const merged: Record<string, DeviceLabel> = { ...local };
  for (const [id, cloudLabel] of Object.entries(cloud)) {
    const localLabel = ownLabel(merged, id);
    if (!localLabel) {
      merged[id] = cloudLabel;
      continue;
    }
    if (bogusKeys.has(DEVICE_BOGUS_PREFIX + id)) continue;
    if (cloudLabel.lastUpdated > localLabel.lastUpdated) merged[id] = cloudLabel;
  }
  return merged;
}

/**
 * Newest `lastUpdated` per key (`devices`: per device id); a tie keeps local;
 * a bogus cloud key never beats a local one. An empty `devices` map is omitted.
 */
export function mergeTrackingSections(
  local: TrackingState,
  cloud: TrackingState,
  bogusKeys: ReadonlySet<string> = new Set()
): TrackingState {
  const merged: TrackingState = { ...local };
  for (const key of ENTRY_KEYS) {
    const cloudEntry = cloud[key];
    const localEntry = merged[key];
    if (!cloudEntry) continue;
    if (!localEntry || (!bogusKeys.has(key) && cloudEntry.lastUpdated > localEntry.lastUpdated)) {
      copyTrackingEntry(merged, cloud, key);
    }
  }
  const devices = mergeDeviceLabels(local.devices ?? {}, cloud.devices ?? {}, bogusKeys);
  if (Object.keys(devices).length > 0) merged.devices = devices;
  else delete merged.devices;
  return merged;
}

/** One readable copy of `volume-data.json`'s tracking section, for the duplicate fold. */
export interface TrackingCopy {
  tracking: TrackingState;
  /** That copy's own `detectBogusTrackingKeys(raw)`. */
  bogus: ReadonlySet<string>;
}

/**
 * What copy `i` may contribute to the duplicate-file fold: everything it
 * holds, except an entry whose stamp was bogus IN THIS COPY while another
 * copy holds the same entry honestly — that copy's own turn supplies it, so a
 * poisoned duplicate never clobbers an honest one, whatever the fold order.
 * `idle` / `pauses` are checked per key, `devices` per device id.
 */
export function foldableTracking(copies: readonly TrackingCopy[], i: number): TrackingState {
  const { tracking: own, bogus } = copies[i];
  const honestElsewhere = (bogusKey: string, holds: (other: TrackingState) => boolean): boolean =>
    bogus.has(bogusKey) &&
    copies.some((other, j) => j !== i && holds(other.tracking) && !other.bogus.has(bogusKey));
  const foldable: TrackingState = {};
  for (const key of ENTRY_KEYS) {
    if (own[key] && !honestElsewhere(key, (other) => !!other[key])) {
      copyTrackingEntry(foldable, own, key);
    }
  }
  const devices: Record<string, DeviceLabel> = {};
  for (const [id, label] of Object.entries(own.devices ?? {})) {
    if (!honestElsewhere(DEVICE_BOGUS_PREFIX + id, (other) => !!ownLabel(other.devices, id))) {
      devices[id] = label;
    }
  }
  if (Object.keys(devices).length > 0) foldable.devices = devices;
  return foldable;
}

function load(): TrackingState {
  if (!browser) return {};
  try {
    return parseTrackingSection(
      JSON.parse(window.localStorage.getItem(TRACKING_STORAGE_KEY) || '{}')
    );
  } catch {
    return {};
  }
}

export const trackingState = writable<TrackingState>(load());

trackingState.subscribe((state) => {
  if (!browser) return;
  try {
    window.localStorage.setItem(TRACKING_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage full or blocked: the setting still syncs through the cloud file.
  }
});

export function setTrackingStates(state: TrackingState): void {
  trackingState.set(state);
}

/** A local edit always supersedes what is stored, even a future stamp. */
function nextStamp(existing: string | undefined, now: number = Date.now()): string {
  const previous = existing ? Date.parse(existing) : NaN;
  return new Date(Number.isNaN(previous) ? now : Math.max(now, previous + 1)).toISOString();
}

/** Change fields of `idle`, keeping the others, under one new stamp. */
function editIdle(fields: Omit<IdleEntry, 'lastUpdated'>): void {
  const state = get(trackingState);
  trackingState.set({
    ...state,
    idle: { ...state.idle, ...fields, lastUpdated: nextStamp(state.idle?.lastUpdated) }
  });
}

/** Set the manual idle cutoff in minutes, or `null` for automatic. */
export function setIdleOverride(minutes: number | null): void {
  editIdle({ override_minutes: minutes });
}

/**
 * Set the cap multiplier `k` (clamped into 1–`K_MAX`), keeping the manual
 * override. "Still reading" calls it with `widenedK(…)`, which never shrinks
 * `k`; this setter writes whatever it is given.
 */
export function widenIdleK(k: number): void {
  if (!Number.isFinite(k)) return;
  editIdle({ k: clampK(k) });
}

/** Back to `DEFAULT_K`, written explicitly so it beats an older widen under newest-wins. */
export function resetIdleK(): void {
  editIdle({ k: DEFAULT_K });
}

/** The standing answer to long-pause prompts, or `null` to be asked. */
export function setPauseDefault(count: PauseCount | null): void {
  const state = get(trackingState);
  trackingState.set({
    ...state,
    pauses: { default: count, lastUpdated: nextStamp(state.pauses?.lastUpdated) }
  });
}

/**
 * Change one device's label under a new stamp, keeping its other fields. A
 * field patched to `undefined` is removed, so the cleared entry still carries
 * a newer stamp and beats the older value on every other device.
 */
function patchDeviceLabel(id: string, patch: Partial<Omit<DeviceLabel, 'lastUpdated'>>): void {
  const state = get(trackingState);
  const existing = ownLabel(state.devices, id);
  const next: DeviceLabel = {
    ...existing,
    ...patch,
    lastUpdated: nextStamp(existing?.lastUpdated)
  };
  if (next.name === undefined) delete next.name;
  if (next.class === undefined) delete next.class;
  if (next.merged_into === undefined) delete next.merged_into;
  trackingState.set({ ...state, devices: { ...state.devices, [id]: next } });
}

/** Name a device; an empty (or all-blank) name goes back to the generated label. */
export function renameDevice(id: string, name: string): void {
  if (!isDeviceId(id)) return;
  patchDeviceLabel(id, { name: clampDeviceName(name) });
}

/** Correct a device's class; `null` = Automatic (the detected class). */
export function setDeviceClass(id: string, cls: DeviceClass | null): void {
  if (!isDeviceId(id) || (cls !== null && !isDeviceClass(cls))) return;
  patchDeviceLabel(id, { class: cls ?? undefined });
}

/** Does following `merged_into` from `from` ever land on `to` (or start there)? */
function mergeReaches(from: string, to: string, labels: Record<string, DeviceLabel>): boolean {
  const seen = new Set<string>();
  for (
    let id: string | undefined = from;
    id && !seen.has(id);
    id = ownLabel(labels, id)?.merged_into
  ) {
    if (id === to) return true;
    seen.add(id);
  }
  return false;
}

/** Is `id` on a `merged_into` cycle (two devices merged into each other between syncs)? */
function onMergeCycle(id: string, labels: Record<string, DeviceLabel>): boolean {
  const next = ownLabel(labels, id)?.merged_into;
  return !!next && mergeReaches(next, id, labels);
}

/**
 * Show `source` as part of `target`. The target is resolved to its canonical
 * id first, so chains are flattened at write time. Refused (`false`, nothing
 * written) for a non-device id, a merge into itself, or one that would close
 * a cycle — `target` already resolves through `source`. It resolves against
 * the state it writes to, never a caller's (possibly stale) map.
 *
 * A target on a cycle (two devices merged into each other before either
 * synced, so each shows on its own with no Unmerge) first leaves it: the
 * user's newest merge decides, and the rest of the cycle stays behind it.
 */
export function mergeDevice(source: string, target: string): boolean {
  if (!isDeviceId(source) || !isDeviceId(target) || source === target) return false;
  let labels = get(trackingState).devices ?? {};
  if (onMergeCycle(target, labels)) {
    patchDeviceLabel(target, { merged_into: undefined });
    labels = get(trackingState).devices ?? {};
  }
  const canonical = resolveDevice(target, labels);
  if (mergeReaches(canonical, source, labels)) return false;
  patchDeviceLabel(source, { merged_into: canonical });
  return true;
}

/** Show a merged device on its own again. Nothing is written when it is not merged. */
export function unmergeDevice(id: string): void {
  if (!ownLabel(get(trackingState).devices, id)?.merged_into) return;
  patchDeviceLabel(id, { merged_into: undefined });
}

/** The idle cutoff every stat uses. */
export const idleSettings: Readable<IdleSettings> = derived(trackingState, ($state) => ({
  k: $state.idle?.k ?? DEFAULT_K,
  overrideMs: $state.idle?.override_minutes ? $state.idle.override_minutes * 60_000 : null
}));

/** The standing long-pause answer; `null` = ask. */
export const pauseDefault: Readable<PauseCount | null> = derived(
  trackingState,
  ($state) => $state.pauses?.default ?? null
);

/** The user's device labels by raw device id (merges unresolved: see `resolveDevice`). */
export const deviceLabels: Readable<Record<string, DeviceLabel>> = derived(
  trackingState,
  ($state) => $state.devices ?? NO_LABELS
);
