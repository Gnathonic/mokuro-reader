import { browser } from '$app/environment';
import { get, writable } from 'svelte/store';
import {
  FUTURE_TOLERANCE_MS,
  isRecord,
  normalizeUpdatedAt,
  sanitizeTracking
} from '$lib/metadata/sanitize';
import { normalizeSeriesKey } from '$lib/metadata/series-key';
import type { SeriesTracking } from '$lib/metadata/types';

/**
 * Series-level READING STATE: how many times a series has been read, whether
 * its re-read prompt is muted, and the AniList tracking bookkeeping.
 *
 * This is per-user state, never a fact about the archives, so it travels with
 * the other per-user state — in `volume-data.json`, under the reserved
 * `series` key — and gains that file's per-key newest-wins merge. It is
 * deliberately NOT in `series.json` or `catalog.json`: those are shared with
 * everyone who can read the library folder.
 *
 * Keyed by `normalizeSeriesKey(series_title)`, the same key the local
 * `series_metadata` table uses.
 */

/**
 * The one key inside `volume-data.json` that is not a volume uuid. Volume uuids
 * are uuids, so nothing can collide with it — but `parseVolumesFromJson` still
 * skips it explicitly rather than relying on that.
 */
export const SERIES_SECTION_KEY = 'series';

/** localStorage key for the local copy (the volume map lives under `volumes`). */
export const SERIES_DATA_STORAGE_KEY = 'series-data';

export interface SeriesReadingState {
  /** Archived completed passes; `timesRead` = read_count + (all volumes completed now ? 1 : 0). */
  read_count: number;
  reread_prompt_suppressed?: boolean;
  tracking?: SeriesTracking;
  /** ISO merge key — newest wins per series, exactly like `lastProgressUpdate`. */
  lastUpdated: string;
}

export type SeriesReadingStates = Record<string, SeriesReadingState>;

export type SeriesReadingStatePatch = Partial<Omit<SeriesReadingState, 'lastUpdated'>>;

/**
 * Either a plain patch, or one built from the state as it is at write time.
 * Two writers touch the same series from different places — the progress
 * tracker (`tracking.last_pushed`) and the series panel (`read_count`) — and
 * both write whole objects, so a patch built from a state read earlier would
 * silently undo the other's edit.
 */
export type SeriesReadingStatePatchInput =
  | SeriesReadingStatePatch
  | ((existing: SeriesReadingState) => SeriesReadingStatePatch);

function emptyState(): SeriesReadingState {
  return { read_count: 0, lastUpdated: new Date(0).toISOString() };
}

/** The state for a series, or a zeroed one — callers never deal with `undefined`. */
export function readingStateFor(
  states: SeriesReadingStates,
  seriesKey: string
): SeriesReadingState {
  return states[seriesKey] ?? emptyState();
}

/** Drop `undefined` values so a cleared flag disappears from storage and JSON. */
function stripUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

/**
 * A local edit must always supersede what is stored, even when the stored stamp
 * is in the future (clock skew on another device, a hand-edited cloud file):
 * plain `now` would lose every merge until real time caught up.
 */
function nextTimestamp(existing: string | undefined, now: number = Date.now()): string {
  const previous = existing ? Date.parse(existing) : NaN;
  return new Date(Number.isNaN(previous) ? now : Math.max(now, previous + 1)).toISOString();
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Validate an untrusted `series` section (cloud JSON, or this device's own
 * localStorage after a hand edit).
 *
 * Entries that are not objects, or whose key is empty, are dropped. Every field
 * is validated with the same helpers the metadata files use: `read_count`
 * coerced to a non-negative integer, a boolean-or-absent
 * `reread_prompt_suppressed`, `tracking` validated field by field (it steers
 * writes to the user's AniList account), and `lastUpdated` normalized to ISO —
 * an unparsable stamp becomes the epoch, which loses every merge instead of
 * winning them all.
 */
export function parseSeriesSection(raw: unknown): SeriesReadingStates {
  if (!isRecord(raw)) return {};
  const out: SeriesReadingStates = {};

  for (const [key, value] of Object.entries(raw)) {
    if (!key.trim() || !isRecord(value)) continue;
    const entry: SeriesReadingState = {
      read_count: isNonNegativeInteger(value.read_count) ? value.read_count : 0,
      lastUpdated: normalizeUpdatedAt(value.lastUpdated) ?? new Date(0).toISOString()
    };
    if (value.reread_prompt_suppressed === true) entry.reread_prompt_suppressed = true;
    const tracking = sanitizeTracking(value.tracking);
    if (tracking) entry.tracking = tracking;
    out[key] = entry;
  }

  return out;
}

/**
 * `parseSeriesSection` over a raw localStorage string.
 *
 * The parse is guarded because this runs in the module body: a truncated or
 * hand-mangled `series-data` key would otherwise throw out of the import and
 * white-screen the app on every load, with no way back but clearing site data.
 * Corrupt JSON is treated as "no reading state" — the same fallback the volume
 * half uses (`parseVolumesFromJson` in `volume-data.ts`).
 */
export function parseSeriesStatesFromJson(storedData: string): SeriesReadingStates {
  try {
    return parseSeriesSection(JSON.parse(storedData));
  } catch {
    return {};
  }
}

/**
 * Detect series keys whose RAW `lastUpdated` needed clamping — more than
 * `FUTURE_TOLERANCE_MS` ahead of `now` — computed on the pre-parse raw
 * section. `parseSeriesSection` clamps by the time a caller sees the parsed
 * result, so the poison is invisible there; this has to run on `rawSeries`.
 *
 * Feeds FORFEIT-ON-BOGUS in `mergeSeriesSections`: a cloud entry whose stamp
 * needed clamping must not out-rank a pending local edit just because
 * clamping sets its "healed" stamp to this device's own `now` — which would
 * otherwise tie-or-beat any local edit (a local edit is, by definition,
 * timestamped at or before `now`).
 */
export function detectBogusSeriesKeys(raw: unknown, now: number = Date.now()): Set<string> {
  const bogus = new Set<string>();
  if (!isRecord(raw)) return bogus;
  for (const [key, value] of Object.entries(raw)) {
    if (!key.trim() || !isRecord(value)) continue;
    const stamp = value.lastUpdated;
    if (typeof stamp !== 'string') continue;
    const parsed = Date.parse(stamp);
    if (!Number.isNaN(parsed) && parsed > now + FUTURE_TOLERANCE_MS) bogus.add(key);
  }
  return bogus;
}

/**
 * Newest `lastUpdated` wins per series; a tie keeps local.
 *
 * FORFEIT-ON-BOGUS: a key in `bogusKeys` (see `detectBogusSeriesKeys`) never
 * out-ranks an existing local entry, regardless of its (already-clamped)
 * `lastUpdated` — only adopted (healed) when local has no entry for that key
 * at all, so there is no honest edit to protect.
 */
export function mergeSeriesSections(
  local: SeriesReadingStates,
  cloud: SeriesReadingStates,
  bogusKeys: ReadonlySet<string> = new Set()
): SeriesReadingStates {
  const merged: SeriesReadingStates = { ...local };
  for (const [key, cloudState] of Object.entries(cloud)) {
    const localState = merged[key];
    if (!localState) {
      merged[key] = cloudState;
      continue;
    }
    if (bogusKeys.has(key)) continue;
    if (cloudState.lastUpdated > localState.lastUpdated) merged[key] = cloudState;
  }
  return merged;
}

const initial: SeriesReadingStates = browser
  ? parseSeriesStatesFromJson(window.localStorage.getItem(SERIES_DATA_STORAGE_KEY) || '{}')
  : {};

export const seriesReadingState = writable<SeriesReadingStates>(initial);

seriesReadingState.subscribe((states) => {
  if (!browser) return;
  window.localStorage.setItem(SERIES_DATA_STORAGE_KEY, JSON.stringify(states));
});

/**
 * Merge `patch` into a series' state and stamp it. Synchronous: this is a plain
 * store over localStorage, so a UI read right after a write already sees it
 * (no liveQuery round-trip to race).
 */
export function updateSeriesReadingState(
  seriesKey: string,
  patch: SeriesReadingStatePatchInput
): SeriesReadingState {
  let written = emptyState();
  seriesReadingState.update((states) => {
    const existing = states[seriesKey] ?? emptyState();
    const resolved = typeof patch === 'function' ? patch(existing) : patch;
    written = stripUndefined<SeriesReadingState>({
      ...existing,
      ...resolved,
      lastUpdated: nextTimestamp(existing.lastUpdated)
    });
    return { ...states, [seriesKey]: written };
  });
  return written;
}

/** Read one series' state outside a component (`get` + default in one call). */
export function getSeriesReadingState(seriesKey: string): SeriesReadingState {
  return readingStateFor(get(seriesReadingState), seriesKey);
}

/**
 * After a series rename: carry the reading state to the new key. Mirrors
 * `moveSeriesMetadataKey` (`store.ts`) and `moveSeriesIndexKey` — on a
 * collision the newer `lastUpdated` wins outright rather than the two states
 * being merged, which is the same rule the cloud merge applies per series.
 *
 * Synchronous, unlike its Dexie-backed siblings: this is a plain store over
 * localStorage. Nothing is stamped here — a rename moves the state, it does not
 * edit it, and re-stamping would let the rename win a cloud merge against a
 * genuinely newer read count from another device.
 */
export function moveSeriesReadingStateKey(oldTitle: string, newTitle: string): void {
  const oldKey = normalizeSeriesKey(oldTitle);
  const newKey = normalizeSeriesKey(newTitle);
  if (oldKey === newKey) return;

  seriesReadingState.update((states) => {
    const oldState = states[oldKey];
    if (!oldState) return states;

    const newState = states[newKey];
    const winner =
      newState && newState.lastUpdated > oldState.lastUpdated ? newState : { ...oldState };
    const next = { ...states, [newKey]: winner };
    delete next[oldKey];
    return next;
  });
}

/** Replace the whole table — the sync merge's write-back, and tests. */
export function setSeriesReadingStates(states: SeriesReadingStates): void {
  seriesReadingState.set(states);
}

export function clearSeriesReadingState(): void {
  seriesReadingState.set({});
}
