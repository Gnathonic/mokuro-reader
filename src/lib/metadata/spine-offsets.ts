import type { VolumeMetadata } from '$lib/types';
import { SPINE_OFFSET_LIMIT, VOLUME_OFFSET_LIMIT } from './sanitize';
import { normalizeSeriesKey } from './series-key';
import type { SeriesFile } from './series-file';
import { updateSeriesMetadata, type SeriesMetadataPatch } from './store';
import type { SeriesMetadata } from './types';

/**
 * Persistence for the catalog card's spine-stack tweaks: a per-series percentage
 * adjustment on the horizontal step (`spine_offset`) and per-volume px nudges
 * (`volume_offsets`, keyed by `volume_uuid` so they follow the volume when the stack
 * is filtered or reordered — "hide read volumes" changes indices, uuids don't).
 *
 * These are user-visible catalog layout AND a property of the archives themselves —
 * the same covers have the same geometry — so they live on the local `SeriesMetadata`
 * record and are published as INDEX data in the shared `series.json` sidecar
 * (`spine_offset` top-level, per-volume `offset` on the entries). Writing them must
 * never touch `facts_updated_at` — see `updateSeriesMetadata`.
 *
 * The record holds ONLY what this user edited. What another device published reaches
 * the shelf as a join at read time (`getSpineOffsets` against the cached `series.json`)
 * and rides back out through `buildSeriesFile`, so it stays that device's value — see
 * the note on `upsertFromSeriesFile` for why adopting it instead is a write loop.
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
  /** Absolute value (not a delta); `0` is stored as a reset, not deleted. */
  spineOffset?: number;
  /**
   * Absolute px per volume_uuid; `0` is stored as that volume's reset. An EMPTY object
   * means "reset every volume offset for this series" (every key goes to `0`).
   */
  volumeOffsets?: Record<string, number>;
  /**
   * Volumes whose offset is currently INHERITED from the published `series.json` — on
   * screen, but with no key on this record. A "reset all" has to zero these too: the
   * record holds nothing to zero for them, and only a stored `0` suppresses a
   * published value (see `getSpineOffsets`). Ignored unless the patch is a reset all.
   */
  inheritedUuids?: string[];
}

function isUsableNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clampTo(value: number, limit: number): number {
  return Math.min(limit, Math.max(-limit, value));
}

/** Same range the cloud boundary enforces, applied to our own writes. */
export function clampSpineOffset(value: number): number {
  return isUsableNumber(value) ? clampTo(value, SPINE_OFFSET_LIMIT) : 0;
}

/** Same range the cloud boundary enforces, applied to our own writes. */
export function clampVolumeOffset(value: number): number {
  return isUsableNumber(value) ? clampTo(value, VOLUME_OFFSET_LIMIT) : 0;
}

/** Shallow value equality for a uuid → px map. */
export function sameVolumeOffsets(a: Record<string, number>, b: Record<string, number>): boolean {
  if (a === b) return true;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

/** Value equality for a whole offsets pair — "is the record already what we want?". */
export function sameSpineOffsets(a: SpineOffsets, b: SpineOffsets): boolean {
  return a.spineOffset === b.spineOffset && sameVolumeOffsets(a.volumeOffsets, b.volumeOffsets);
}

/**
 * Read the offsets the shelf should draw with: this library's own values joined over
 * whatever the series' `series.json` publishes.
 *
 * `published` is the cached copy of that file (`series_index`), and the join is
 * `record value ?? published value`, per key. That is what makes an alignment
 * INHERITED rather than adopted: the record keeps only the values this user actually
 * edited, so the device that measured the shelf can still correct or retract it, and
 * `buildSeriesFile` rides the published value straight back out for a key we hold
 * none for. Filling the published values into the record instead would make them
 * ours — republished forever, and unbeatable by their own author.
 *
 * A stored `0` is a deliberate reset, so it SUPPRESSES the published value rather
 * than reading as "no opinion" (and then drops out of the result, which is what the
 * layout wants). Junk on either side — non-finite values that predate the sanitizer,
 * or a hand-edited cloud file — is no opinion at all, so it can never reach the
 * layout arithmetic.
 */
export function getSpineOffsets(
  meta: SeriesMetadata | undefined | null,
  published?: SeriesFile | undefined | null
): SpineOffsets {
  const publishedSpine = isUsableNumber(published?.spine_offset) ? published.spine_offset : 0;
  const spineOffset = isUsableNumber(meta?.spine_offset) ? meta.spine_offset : publishedSpine;

  const volumeOffsets: Record<string, number> = {};
  for (const entry of published?.volumes ?? []) {
    if (isUsableNumber(entry.offset) && entry.offset !== 0)
      volumeOffsets[entry.volume_uuid] = entry.offset;
  }
  for (const [uuid, px] of Object.entries(meta?.volume_offsets ?? {})) {
    if (!isUsableNumber(px)) continue;
    if (px === 0) delete volumeOffsets[uuid];
    else volumeOffsets[uuid] = px;
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
  /** Accumulated per-volume values from this burst (`0` = reset that key, stored). */
  volumeOffsets: Record<string, number>;
  hasVolumeOffsets: boolean;
  /** A "reset all" arrived in this burst: zero every key the record holds, don't drop them. */
  resetVolumes: boolean;
  /** Inherited uuids a "reset all" must zero as well (see `SpineOffsetPatch`). */
  inheritedUuids: Set<string>;
  done: Promise<SeriesMetadata | undefined>;
  resolve: (written: SeriesMetadata | undefined) => void;
}

const pending = new Map<string, PendingWrite>();

function buildPatch(entry: PendingWrite): (existing: SeriesMetadata) => SeriesMetadataPatch {
  const {
    hasSpineOffset,
    spineOffset,
    hasVolumeOffsets,
    resetVolumes,
    volumeOffsets,
    inheritedUuids
  } = entry;
  // Resolved inside the store's write transaction: `volume_offsets` is one object, and
  // another writer (another card, a sync merge) may have changed a different volume's
  // entry since this burst started — merge against the record as it is at write time.
  return (existing) => {
    const patch: SeriesMetadataPatch = {};
    if (hasSpineOffset) {
      // Stored even at 0: a 0 is a deliberate reset, and `buildSeriesFile` needs
      // to see it to suppress an alignment another device published (an absent
      // value means "no opinion", which INHERITS the published one).
      patch.spine_offset = spineOffset;
    }
    if (hasVolumeOffsets || resetVolumes) {
      // "Reset all" keeps every key at 0 for the same reason: the zeros are what
      // outrank the published nudges. They never reach the file — the writer
      // omits zero offsets — and never reach the layout, which filters them.
      // The inherited uuids are zeroed alongside the record's own keys: those
      // volumes are nudged on screen by the published file, and only a stored 0
      // suppresses that, so a reset without them would spring straight back.
      const next: Record<string, number> = resetVolumes
        ? Object.fromEntries(
            [...new Set([...Object.keys(existing.volume_offsets ?? {}), ...inheritedUuids])].map(
              (uuid) => [uuid, 0]
            )
          )
        : { ...(existing.volume_offsets ?? {}) };
      for (const [uuid, px] of Object.entries(volumeOffsets)) next[uuid] = px;
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
  let written: SeriesMetadata | undefined;
  try {
    written = await updateSeriesMetadata(entry.seriesTitle, buildPatch(entry));
  } catch (err) {
    // Callers are fire-and-forget UI handlers; a rejected promise there would surface as
    // an unhandled rejection and the card would sit with `pending` never clearing.
    console.warn('scheduleSpineOffsetWrite: failed to persist spine offsets', err);
  } finally {
    entry.resolve(written);
  }
}

/**
 * Queue a spine-offset write for `seriesTitle`, coalescing everything that arrives
 * within `SPINE_OFFSET_WRITE_DELAY_MS` into a single `updateSeriesMetadata` call.
 *
 * Values are clamped to the same range the cloud boundary enforces, so a local write and
 * a synced one can never disagree about what is storable.
 *
 * Resolves with the record the write produced (`undefined` if it failed) once that write
 * has landed — callers use it to know which store emission is the echo of their own write,
 * and can adopt its values as the settled truth.
 */
export function scheduleSpineOffsetWrite(
  seriesTitle: string,
  patch: SpineOffsetPatch
): Promise<SeriesMetadata | undefined> {
  const key = normalizeSeriesKey(seriesTitle);
  const existing = pending.get(key);

  let entry: PendingWrite;
  if (existing) {
    clearTimeout(existing.timer);
    entry = existing;
    entry.seriesTitle = seriesTitle;
  } else {
    let resolve!: (written: SeriesMetadata | undefined) => void;
    const done = new Promise<SeriesMetadata | undefined>((r) => (resolve = r));
    entry = {
      seriesTitle,
      timer: 0 as unknown as ReturnType<typeof setTimeout>,
      hasSpineOffset: false,
      volumeOffsets: {},
      hasVolumeOffsets: false,
      resetVolumes: false,
      inheritedUuids: new Set<string>(),
      done,
      resolve
    };
  }

  if (patch.spineOffset !== undefined) {
    entry.spineOffset = clampSpineOffset(patch.spineOffset);
    entry.hasSpineOffset = true;
  }
  if (patch.volumeOffsets !== undefined) {
    const entries = Object.entries(patch.volumeOffsets);
    if (entries.length === 0) {
      // "Reset all": discard the nudges accumulated so far in THIS BURST. The
      // record's own keys are not dropped — `buildPatch` zeroes them.
      entry.resetVolumes = true;
      entry.volumeOffsets = {};
    } else {
      for (const [uuid, px] of entries) entry.volumeOffsets[uuid] = clampVolumeOffset(px);
    }
    entry.hasVolumeOffsets = true;
  }
  for (const uuid of patch.inheritedUuids ?? []) entry.inheritedUuids.add(uuid);

  entry.timer = setTimeout(() => void runWrite(key), SPINE_OFFSET_WRITE_DELAY_MS);
  pending.set(key, entry);
  return entry.done;
}

/** Write every queued offset now (tests, and any caller that cannot wait for the timer). */
export async function flushSpineOffsetWrites(): Promise<void> {
  await Promise.all([...pending.keys()].map((key) => runWrite(key)));
}
