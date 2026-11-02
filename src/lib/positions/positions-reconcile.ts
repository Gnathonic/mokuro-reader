/**
 * What to do with the cloud's `positions.json`: which positions to adopt here,
 * which to leave to the open reader's offer, and whether to write the file.
 *
 * PURE — the IO lives in `positions-sync.ts`.
 */

import {
  composePositionsFile,
  mergePositions,
  positionsContent,
  prunePositions,
  type PositionEntry,
  type PositionsMap
} from './positions-file';

export interface LocalPosition {
  /** The local record's `lastProgressUpdate`, ms; 0 = never set. */
  stamp: number;
  /** A "forget stats" tombstone (`deletedOn`). */
  deleted: boolean;
  /** When the stats were last forgotten, ms; 0 = never. */
  forgotAt: number;
}

export interface ReconcileInput {
  /** Parsed, merged across every readable copy. */
  cloud: PositionsMap;
  /** `positionsContent()` of the surviving raw copy ('' = no file). */
  cloudContent: string;
  local: (volume: string) => LocalPosition | undefined;
  /** `ownChangedEntries(ownDevice)`. */
  own: PositionsMap;
  ownDevice: string;
  open: { volume: string; openedAt: number } | null;
  now: number;
}

export interface ReconcileResult {
  adopt: Array<{ volume: string; entry: PositionEntry; toast: boolean }>;
  /** Newer elsewhere, but the open reader has turned a page: the offer takes over. */
  deferred: string[];
  /** `prunePositions(mergePositions(cloud, own), now)`. */
  next: PositionsMap;
  upload: boolean;
}

const NO_LOCAL: LocalPosition = { stamp: 0, deleted: false, forgotAt: 0 };

export function reconcilePositions(input: ReconcileInput): ReconcileResult {
  const adopt: ReconcileResult['adopt'] = [];
  const deferred: string[] = [];

  for (const [volume, entry] of Object.entries(input.cloud)) {
    // Page 0 is a reset: it travels in the file so it beats the older entry,
    // but the reset itself reaches this device through volume-data.json and the
    // reading history. Jumping "to page 0" here is never right.
    if (entry.page < 1) continue;
    if (entry.device === input.ownDevice) continue;
    const local = input.local(volume) ?? NO_LOCAL;
    if (local.deleted) continue;
    if (!(entry.t > local.forgotAt)) continue;
    if (!(entry.t > local.stamp)) continue;

    if (input.open?.volume === volume) {
      // Opening stamps nothing, so a local stamp from before the open means
      // the user has not turned a page here yet: move, and say so.
      if (local.stamp < input.open.openedAt) adopt.push({ volume, entry, toast: true });
      else deferred.push(volume);
    } else {
      adopt.push({ volume, entry, toast: false });
    }
  }

  const next = prunePositions(mergePositions(input.cloud, input.own), input.now);
  const nextContent = positionsContent(composePositionsFile(next));
  // No file until there is a position: an empty map never mints one.
  const upload =
    input.cloudContent === '' && Object.keys(next).length === 0
      ? false
      : nextContent !== input.cloudContent;

  return { adopt, deferred, next, upload };
}
