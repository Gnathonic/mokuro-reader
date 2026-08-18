import type { VolumeMetadata } from '$lib/types';
import { normalizeSeriesKey } from './series-key';
import { updateSeriesMetadata, type SeriesMetadataPatch } from './store';
import type { SeriesMetadata } from './types';

/**
 * Persistence for the catalog card's spine-stack tweaks: a per-series percentage
 * adjustment on the horizontal step (`spine_offset`) and per-volume px nudges
 * (`volume_offsets`, keyed by `volume_uuid` so they follow the volume when the stack
 * is filtered or reordered — "hide read volumes" changes indices, uuids don't).
 *
 * These are user-visible catalog layout, not facts about the series, so they live on
 * the synced `SeriesMetadata` record (root `series-metadata.json`) and are deliberately
 * NOT part of the `.mokuro` embed.
 *
 * Writes are debounced per series: a wheel burst fires a tick every few milliseconds,
 * and each `updateSeriesMetadata` is an IndexedDB transaction plus a liveQuery emission
 * to every catalog card. The debounce collapses a burst into ONE write carrying the
 * final value.
 */

/** Trailing debounce for coalescing wheel ticks into one write. */
export const SPINE_OFFSET_WRITE_DELAY_MS = 300;

export interface SpineOffsets {
  /** Percent added to the global horizontal step for this series. */
  spineOffset: number;
  /** volume_uuid -> horizontal nudge in px. */
  volumeOffsets: Record<string, number>;
}

export interface SpineOffsetPatch {
  /** Absolute value (not a delta); `0` clears the stored field. */
  spineOffset?: number;
  /**
   * Absolute px per volume_uuid; `0` deletes that volume's key. An EMPTY object means
   * "reset every volume offset for this series".
   */
  volumeOffsets?: Record<string, number>;
}

function isUsableNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Read the offsets off a metadata record (or nothing) into the shape the card uses.
 * Junk that predates the sanitizer — or a record hand-edited in the cloud file — is
 * ignored here too, so a bad value can never reach the layout arithmetic.
 */
export function getSpineOffsets(meta: SeriesMetadata | undefined | null): SpineOffsets {
  const spineOffset = isUsableNumber(meta?.spine_offset) ? meta.spine_offset : 0;
  const volumeOffsets: Record<string, number> = {};
  for (const [uuid, px] of Object.entries(meta?.volume_offsets ?? {})) {
    if (isUsableNumber(px) && px !== 0) volumeOffsets[uuid] = px;
  }
  return { spineOffset, volumeOffsets };
}

/**
 * Project uuid-keyed offsets onto the positions of `volumes` — the index-keyed map the
 * stack layout wants. Pure; the caller passes whichever slice of the series it renders.
 */
export function volumeOffsetsByIndex(
  volumes: VolumeMetadata[],
  byUuid: Record<string, number>
): Map<number, number> {
  const out = new Map<number, number>();
  volumes.forEach((vol, index) => {
    const px = byUuid[vol.volume_uuid];
    if (isUsableNumber(px) && px !== 0) out.set(index, px);
  });
  return out;
}

interface PendingWrite {
  /** The title as last passed in — the store writes it back as `series_title`. */
  seriesTitle: string;
  timer: ReturnType<typeof setTimeout>;
  spineOffset?: number;
  hasSpineOffset: boolean;
  /** Accumulated per-volume values from this burst (`0` = delete that key). */
  volumeOffsets: Record<string, number>;
  hasVolumeOffsets: boolean;
  /** A "reset all" arrived in this burst: start from an empty map, not the record's. */
  resetVolumes: boolean;
  done: Promise<void>;
  resolve: () => void;
}

const pending = new Map<string, PendingWrite>();

function buildPatch(entry: PendingWrite): (existing: SeriesMetadata) => SeriesMetadataPatch {
  const { hasSpineOffset, spineOffset, hasVolumeOffsets, resetVolumes, volumeOffsets } = entry;
  // Resolved inside the store's write transaction: `volume_offsets` is one object, and
  // another writer (another card, a sync merge) may have changed a different volume's
  // entry since this burst started — merge against the record as it is at write time.
  return (existing) => {
    const patch: SeriesMetadataPatch = {};
    if (hasSpineOffset) {
      // 0 is the default; store nothing rather than a no-op field in the synced JSON.
      patch.spine_offset = spineOffset === 0 ? undefined : spineOffset;
    }
    if (hasVolumeOffsets || resetVolumes) {
      const next: Record<string, number> = resetVolumes
        ? {}
        : { ...(existing.volume_offsets ?? {}) };
      for (const [uuid, px] of Object.entries(volumeOffsets)) {
        if (px === 0) delete next[uuid];
        else next[uuid] = px;
      }
      patch.volume_offsets = Object.keys(next).length > 0 ? next : undefined;
    }
    return patch;
  };
}

async function runWrite(key: string): Promise<void> {
  const entry = pending.get(key);
  if (!entry) return;
  pending.delete(key);
  clearTimeout(entry.timer);
  try {
    await updateSeriesMetadata(entry.seriesTitle, buildPatch(entry));
  } catch (err) {
    // Callers are fire-and-forget UI handlers; a rejected promise there would surface as
    // an unhandled rejection and the card would sit with `pending` never clearing.
    console.warn('scheduleSpineOffsetWrite: failed to persist spine offsets', err);
  } finally {
    entry.resolve();
  }
}

/**
 * Queue a spine-offset write for `seriesTitle`, coalescing everything that arrives
 * within `SPINE_OFFSET_WRITE_DELAY_MS` into a single `updateSeriesMetadata` call.
 *
 * Returns a promise that resolves once that write has landed — callers use it to know
 * when it is safe to resync their optimistic local state from the store again.
 */
export function scheduleSpineOffsetWrite(
  seriesTitle: string,
  patch: SpineOffsetPatch
): Promise<void> {
  const key = normalizeSeriesKey(seriesTitle);
  const existing = pending.get(key);

  let entry: PendingWrite;
  if (existing) {
    clearTimeout(existing.timer);
    entry = existing;
    entry.seriesTitle = seriesTitle;
  } else {
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    entry = {
      seriesTitle,
      timer: 0 as unknown as ReturnType<typeof setTimeout>,
      hasSpineOffset: false,
      volumeOffsets: {},
      hasVolumeOffsets: false,
      resetVolumes: false,
      done,
      resolve
    };
  }

  if (patch.spineOffset !== undefined) {
    entry.spineOffset = patch.spineOffset;
    entry.hasSpineOffset = true;
  }
  if (patch.volumeOffsets !== undefined) {
    const entries = Object.entries(patch.volumeOffsets);
    if (entries.length === 0) {
      // "Reset all": drop the nudges accumulated so far in this burst too.
      entry.resetVolumes = true;
      entry.volumeOffsets = {};
    } else {
      for (const [uuid, px] of entries) entry.volumeOffsets[uuid] = px;
    }
    entry.hasVolumeOffsets = true;
  }

  entry.timer = setTimeout(() => void runWrite(key), SPINE_OFFSET_WRITE_DELAY_MS);
  pending.set(key, entry);
  return entry.done;
}

/** Write every queued offset now (tests, and any caller that cannot wait for the timer). */
export async function flushSpineOffsetWrites(): Promise<void> {
  await Promise.all([...pending.keys()].map((key) => runWrite(key)));
}
