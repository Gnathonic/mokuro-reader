import { browser } from '$app/environment';
import { derived, get, writable, type Readable } from 'svelte/store';
import { FUTURE_TOLERANCE_MS, isRecord, normalizeUpdatedAt } from '$lib/metadata/sanitize';
import { DEFAULT_K, K_MAX, type IdleSettings } from '$lib/reading-history/stats-engine';
import type { PauseCount } from '$lib/reading-history/types';

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

/** Validate an untrusted `tracking` section, key by key. Unknown keys are dropped. */
export function parseTrackingSection(raw: unknown): TrackingState {
  const state: TrackingState = {};
  if (!isRecord(raw)) return state;
  if (isRecord(raw.idle)) state.idle = parseIdle(raw.idle);
  if (isRecord(raw.pauses)) state.pauses = parsePauses(raw.pauses);
  return state;
}

/** Keys whose RAW stamp is too far in the future (before the parse clamps it). */
export function detectBogusTrackingKeys(raw: unknown, now: number = Date.now()): Set<string> {
  const bogus = new Set<string>();
  if (!isRecord(raw)) return bogus;
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value) || typeof value.lastUpdated !== 'string') continue;
    const stamp = Date.parse(value.lastUpdated);
    if (!Number.isNaN(stamp) && stamp > now + FUTURE_TOLERANCE_MS) bogus.add(key);
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

/** Newest `lastUpdated` per key; a tie keeps local; a bogus cloud key never beats a local one. */
export function mergeTrackingSections(
  local: TrackingState,
  cloud: TrackingState,
  bogusKeys: ReadonlySet<string> = new Set()
): TrackingState {
  const merged: TrackingState = { ...local };
  for (const key of Object.keys(cloud) as Array<keyof TrackingState>) {
    const cloudEntry = cloud[key];
    const localEntry = merged[key];
    if (!cloudEntry) continue;
    if (!localEntry || (!bogusKeys.has(key) && cloudEntry.lastUpdated > localEntry.lastUpdated)) {
      copyTrackingEntry(merged, cloud, key);
    }
  }
  return merged;
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
