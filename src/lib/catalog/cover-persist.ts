import { db } from '$lib/catalog/db';
import type { VolumeMetadata } from '$lib/types';
import { needsDownload } from '$lib/catalog/volume-state';
import { isArchiveSize } from '$lib/metadata/series-file';
import { isoToEpochSeconds } from '$lib/metadata/cloud-sidecar-stamps';
import type { CloudThumbnailResult } from './cloud-thumbnails';

/**
 * The coalesced write queue behind `cover-service.ts` — the ONE place that
 * actually touches `db.volumes` for a cloud cover, whoever asked for it.
 * Deliberately its own leaf module rather than folded into `cover-service.ts`
 * itself: `cover-service.ts` imports pull/build helpers from
 * `$lib/metadata/series-backfill.ts` (decision-tree cases 3/4), and THAT
 * module's own `refreshStaleCover` needs this same queue — importing it from
 * `cover-service.ts` instead would create a direct two-file import cycle.
 * This module has no dependency on either, so both can depend on it.
 *
 * User ruling: "install them and their metadata if they are requested for
 * rendering for a series card." Two things happen once a cover fetch lands
 * on a real row (`installCover`):
 *
 * 1. The thumbnail is written through the SAME transactional guard
 *    `cover-install.ts`'s `runCoverInstall` uses: re-read the row inside the
 *    write transaction and re-test `needsDownload(...)` against THAT read,
 *    not the snapshot the caller started from — a download finishing
 *    mid-fetch installs the volume with a thumbnail measured from its own
 *    pages, and this must never clobber that. `mode: 'fill'` (the default)
 *    additionally never touches a row that already has ANY thumbnail — the
 *    ordinary "nothing here yet" case. `mode: 'overwrite'` is for a
 *    DELIBERATE stale-cover refresh (the caller already decided the existing
 *    thumbnail is out of date) and skips only the installed-volume guard,
 *    never the thumbnail-presence one.
 * 2. The SOURCE cover sidecar's listing stamp — bytes + epoch-seconds mtime —
 *    is recorded as `cover_size`/`cover_modified` on the row, mirroring
 *    `SeriesFileVolume`'s entry stamps exactly. This is what lets a LATER
 *    pass decide staleness without guessing: absent stamps are never treated
 *    as stale on their own (same migration-safety inversion as the
 *    series-index entry stamps — see `cloud-sidecar-stamps.ts`), so a
 *    thumbnail installed by older code, or measured from the volume's own
 *    pages, is left alone forever rather than being "healed" by a pull.
 *
 * By the time `installCover` is called the ROW ALREADY EXISTS — resolving or
 * materializing it (decision-tree cases 1-4) is `cover-service.ts`'s job,
 * done BEFORE it ever reaches this queue. This module only fills or
 * overwrites an existing row's cover; it never creates one.
 *
 * WRITE-STORM AVOIDANCE: every `db.volumes.update` fires the `volumes`
 * liveQuery → `volumesWithPlaceholders` → the whole catalog re-derives. A
 * first-boot burst that resolves 100+ covers at once must not cost 100+
 * table-write transactions (each one its own catalog rebuild) — so this
 * module NEVER writes synchronously. `installCover` only queues; a single
 * short debounce timer collects everything queued within its window and
 * flushes it as ONE `db.transaction`, which is ONE liveQuery emission no
 * matter how many rows it touches — and no matter which of `cover-service.ts`
 * or `series-backfill.ts`'s `refreshStaleCover` queued them: ONE shared
 * queue, ONE shared timer.
 */

/** Long enough to catch a burst (a first-boot catalog resolving many covers at once), short enough that "persistent" does not read as "eventually". */
export const COVER_PERSIST_DEBOUNCE_MS = 750;

interface PendingCoverPersist {
  result: CloudThumbnailResult;
  coverSize?: number;
  coverModified?: number;
  mode: 'fill' | 'overwrite';
}

/** volume_uuid → the most recent fetch result queued for it. */
const pending = new Map<string, PendingCoverPersist>();
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Queue a fetched cover for background persistence onto an EXISTING row.
 *
 * `stamp` is the decision-time listing snapshot the fetch was made against
 * (bytes + ISO mtime of the cover sidecar) — never re-derived from a fresher
 * listing here, so the recorded stamp always describes exactly the bytes
 * that were fetched (see `cloud-sidecar-stamps.ts`'s snapshot-discipline).
 */
export function installCover(
  volumeUuid: string,
  result: CloudThumbnailResult,
  stamp: { size?: number; modifiedTime?: string } = {},
  mode: 'fill' | 'overwrite' = 'fill'
): void {
  const coverSize = isArchiveSize(stamp.size) ? stamp.size : undefined;
  const coverModified = isoToEpochSeconds(stamp.modifiedTime);
  pending.set(volumeUuid, { result, coverSize, coverModified, mode });

  if (timer) return; // Already coalescing a batch; this entry rides along with it.
  timer = setTimeout(() => void flushPendingCoverPersists(), COVER_PERSIST_DEBOUNCE_MS);
}

/**
 * Flush every queued cover as ONE transaction. Exported (not just internal
 * to the debounce) so a test — or a caller that wants the writes to have
 * landed before proceeding (`series-backfill.ts`'s `refreshStaleCover`) —
 * can flush deterministically instead of advancing fake timers.
 */
export async function flushPendingCoverPersists(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const entries = [...pending.entries()];
  pending.clear();
  if (entries.length === 0) return;

  try {
    await db.transaction('rw', db.volumes, async () => {
      for (const [volumeUuid, { result, coverSize, coverModified, mode }] of entries) {
        const fresh = (await db.volumes.get(volumeUuid)) as VolumeMetadata | undefined;
        if (!fresh || !needsDownload(fresh)) continue;
        if (mode === 'fill' && fresh.thumbnail) continue;

        const patch: Partial<VolumeMetadata> = {
          thumbnail: result.file,
          thumbnail_width: result.width,
          thumbnail_height: result.height
        };
        if (coverSize !== undefined) patch.cover_size = coverSize;
        if (coverModified !== undefined) patch.cover_modified = coverModified;
        await db.volumes.update(volumeUuid, patch);
      }
    });
  } catch (error) {
    console.debug('[cover-persist] could not persist a batch of catalog covers:', error);
  }
}

/** Test hook: drop anything queued and forget the pending timer, without flushing. */
export function _resetCoverPersistForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  pending.clear();
}
