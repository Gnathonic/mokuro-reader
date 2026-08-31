import { derived } from 'svelte/store';
import { FUTURE_TOLERANCE_MS } from '$lib/metadata/sanitize';
import { volumes, type VolumeData } from '../settings/volume-data';
import type { CompletedAtMap } from './types';

/**
 * WHEN each volume was finished.
 *
 * This used to be derived from live reading state and side-written into the
 * `volumes` localStorage key. That could not work: the key is owned by the
 * `volumes` store's own subscriber, which re-serializes through
 * `VolumeData.toJSON()` — a whitelist the field was not on — so every write was
 * erased before it could be read back, and the map was silently rebuilt from
 * `lastProgressUpdate` on every boot. Since `updateProgress` bumps that on every
 * page turn, flipping one page of a volume finished two years ago re-dated it to
 * today and inflated the current period's goal.
 *
 * `completedAt` is now a real `VolumeData` field, stamped once at the
 * false->true edge and synced in `volume-data.json`. This module only reads it.
 */

/**
 * A stamp far enough in the future to be a broken clock rather than a fact.
 *
 * `completedAt` is not a merge key, so nothing ever rewrites it — but it IS a
 * goal-period key. Left alone, a stamp minted by a device whose clock is a year
 * fast parks that volume in a future period permanently, on every device. The
 * guard is read-side on purpose: clamping at merge time would re-clamp to a
 * fresher `now` on each device on each sync and ping-pong the file forever.
 */
function isUsableStamp(stamp: string | undefined, now: number): stamp is string {
  if (!stamp) return false;
  const parsed = Date.parse(stamp);
  return !Number.isNaN(parsed) && parsed <= now + FUTURE_TOLERANCE_MS;
}

/**
 * Every DATED completion of a volume: the current pass, plus each archived pass
 * from "restart series" that finished and kept its date.
 *
 * Goal counting reads this, so a series read twice in a year counts twice —
 * once per pass, each in the period it was actually finished in. It never reads
 * `ArchivedRead.at`, which is when restart was pressed, not when the pass ended.
 */
export function completionEventsFor(volumeData: VolumeData, now: number): string[] {
  const events: string[] = [];

  for (const archived of volumeData.archivedReads) {
    if (archived.completed && isUsableStamp(archived.completedAt, now)) {
      events.push(archived.completedAt);
    }
  }

  if (isUsableStamp(volumeData.completedAt, now)) {
    events.push(volumeData.completedAt);
  }

  return events;
}

/**
 * volume uuid -> the CURRENT pass's completion date.
 *
 * For "is this volume, as it stands, finished and when" — the completed list,
 * the per-volume badge. Goal totals go through `completionEventsFor` instead,
 * which also sees finished passes that have since been restarted.
 */
export const completedAtMap = derived(volumes, ($volumes): CompletedAtMap => {
  const now = Date.now();
  const map: CompletedAtMap = {};

  for (const [volumeId, volumeData] of Object.entries($volumes ?? {})) {
    if (isUsableStamp(volumeData.completedAt, now)) {
      map[volumeId] = volumeData.completedAt;
    }
  }

  return map;
});

/** Kept for the snapshot builder, which reads the map imperatively via `get`. */
export const _completedAtMap = completedAtMap;
