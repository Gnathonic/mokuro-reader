import { browser } from '$app/environment';
import { derived, get, writable, type Readable } from 'svelte/store';
import { FUTURE_TOLERANCE_MS, isRecord, normalizeUpdatedAt } from '$lib/metadata/sanitize';
import { DEFAULT_K, type IdleSettings } from '$lib/reading-history/stats-engine';

/**
 * Reading-tracking SETTINGS that belong to the user, not to a device or a
 * profile: they travel in `volume-data.json` under the reserved `tracking`
 * key, beside the `series` section, with the same rules — per key, newest
 * `lastUpdated` wins, a stamp too far in the future is clamped on read and
 * forfeits to a local entry (spec: "Speed and stats", manual override).
 *
 * - `idle`: the idle cutoff every stat uses. `override_minutes` replaces the
 *   adaptive cap everywhere when set; `k` widens it (phase 3b's "Still
 *   reading" answer sets it).
 */

export const TRACKING_SECTION_KEY = 'tracking';
export const TRACKING_STORAGE_KEY = 'tracking-data';

export interface IdleEntry {
  k?: number;
  /** `null` = automatic (explicitly chosen, so it beats an older override). */
  override_minutes?: number | null;
  lastUpdated: string;
}

export interface TrackingState {
  idle?: IdleEntry;
}

const K_RANGE = [1, 20] as const;
const OVERRIDE_RANGE = [1, 60] as const;
const EPOCH = new Date(0).toISOString();

/** Validate an untrusted `tracking` section. Unknown keys are dropped. */
export function parseTrackingSection(raw: unknown): TrackingState {
  if (!isRecord(raw) || !isRecord(raw.idle)) return {};
  const value = raw.idle;
  const idle: IdleEntry = { lastUpdated: normalizeUpdatedAt(value.lastUpdated) ?? EPOCH };
  if (typeof value.k === 'number' && Number.isFinite(value.k)) {
    idle.k = Math.min(K_RANGE[1], Math.max(K_RANGE[0], value.k));
  }
  if ('override_minutes' in value) {
    const minutes = value.override_minutes;
    idle.override_minutes =
      typeof minutes === 'number' && minutes >= OVERRIDE_RANGE[0] && minutes <= OVERRIDE_RANGE[1]
        ? minutes
        : null;
  }
  return { idle };
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
    if (!localEntry) merged[key] = cloudEntry;
    else if (!bogusKeys.has(key) && cloudEntry.lastUpdated > localEntry.lastUpdated) {
      merged[key] = cloudEntry;
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

/** Set the manual idle cutoff in minutes, or `null` for automatic. */
export function setIdleOverride(minutes: number | null): void {
  const state = get(trackingState);
  trackingState.set({
    ...state,
    idle: {
      ...state.idle,
      override_minutes: minutes,
      lastUpdated: nextStamp(state.idle?.lastUpdated)
    }
  });
}

/** The idle cutoff every stat uses. */
export const idleSettings: Readable<IdleSettings> = derived(trackingState, ($state) => ({
  k: $state.idle?.k ?? DEFAULT_K,
  overrideMs: $state.idle?.override_minutes ? $state.idle.override_minutes * 60_000 : null
}));
