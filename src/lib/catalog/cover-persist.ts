import { db } from '$lib/catalog/db';
import type { VolumeMetadata } from '$lib/types';
import { needsDownload } from '$lib/catalog/volume-state';
import { isArchiveSize } from '$lib/metadata/series-file';
import { isoToEpochSeconds } from '$lib/metadata/cloud-sidecar-stamps';
import type { CloudThumbnailResult } from './cloud-thumbnails';

/**
 * Makes a catalog card's cloud cover fetch (`CatalogItem.svelte`'s
 * `requestCoverOnce` → `commitCover`) PERSISTENT instead of session-only, for
 * any volume that has a DB row (a metadata-only row — materialized from a
 * series index, or retained after its files were removed). A pure
 * placeholder (no row) is unaffected — its cover is session-cache only, same
 * as before, and converges once the series is linked/opened and a row exists
 * (`cover-install.ts`).
 *
 * User ruling: "install them and their metadata if they are requested for
 * rendering for a series card."
 *
 * Two things happen once a fetch lands:
 *
 * 1. The thumbnail is written onto the row, through the SAME transactional
 *    guard `cover-install.ts`'s `runCoverInstall` uses: re-read the row
 *    inside the write transaction and re-test `needsDownload(...) &&
 *    !thumbnail` against THAT read, not the snapshot the fetch started from.
 *    A download finishing mid-fetch installs the volume with a thumbnail
 *    measured from its own pages; this must never clobber that, and a row
 *    that already has a thumbnail (persisted by an earlier commit, or by
 *    `cover-install.ts`) must never be touched either — `CatalogItem.svelte`
 *    only ever fetches for `!vol.thumbnail` rows in the first place (see
 *    `cloudCoverTargets`), so this guard is normally a no-op confirmation,
 *    not a live race resolver.
 * 2. The SOURCE cover sidecar's listing stamp — bytes + epoch-seconds mtime,
 *    read off `volume.cloudThumbnailSize`/`cloudThumbnailModifiedTime` (the
 *    decision-time snapshot the fetch itself was made against — see
 *    `placeholders.ts`) — is recorded as `cover_size`/`cover_modified` on the
 *    row, mirroring `SeriesFileVolume`'s entry stamps exactly. This is what
 *    lets a LATER pass decide staleness without guessing: absent stamps are
 *    never treated as stale on their own (same migration-safety inversion as
 *    the series-index entry stamps — see `cloud-sidecar-stamps.ts`), so a
 *    thumbnail installed by older code, or measured from the volume's own
 *    pages, is left alone forever rather than being "healed" by a pull.
 *
 * WRITE-STORM AVOIDANCE: every `db.volumes.update` fires the `volumes`
 * liveQuery → `volumesWithPlaceholders` → the whole catalog re-derives. A
 * first-boot burst that resolves 100+ covers at once must not cost 100+
 * table-write transactions (each one its own catalog rebuild) — so this
 * module NEVER writes synchronously. `scheduleCatalogCoverPersist` only
 * queues; a single short debounce timer collects everything queued within
 * its window and flushes it as ONE `db.transaction`, which is ONE liveQuery
 * emission no matter how many rows it touches. `commitCover` itself stays
 * synchronous and immediate — the card paints from `cloudThumbnailData` the
 * instant the fetch resolves; this module's write is purely a background
 * side effect of that.
 */

/** Long enough to catch a burst (a first-boot catalog resolving many covers at once), short enough that "persistent" does not read as "eventually". */
export const COVER_PERSIST_DEBOUNCE_MS = 750;

interface PendingCoverPersist {
  result: CloudThumbnailResult;
  coverSize?: number;
  coverModified?: number;
}

/** volume_uuid → the most recent fetch result queued for it. */
const pending = new Map<string, PendingCoverPersist>();
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Queue a fetched cover for background persistence. No-op for a volume with
 * no DB row (`isPlaceholder`) — there is nothing to persist onto.
 *
 * `volume` must be the SAME object the fetch was made against: its
 * `cloudThumbnailSize`/`cloudThumbnailModifiedTime` are the decision-time
 * listing snapshot this queues as the row's new stamp, and re-deriving them
 * from a fresher listing here would defeat the point of a decision-time
 * snapshot (see `cloud-sidecar-stamps.ts`'s own snapshot-discipline notes).
 */
export function scheduleCatalogCoverPersist(
  volume: VolumeMetadata,
  result: CloudThumbnailResult
): void {
  if (volume.isPlaceholder) return;

  const coverSize = isArchiveSize(volume.cloudThumbnailSize)
    ? volume.cloudThumbnailSize
    : undefined;
  const coverModified = isoToEpochSeconds(volume.cloudThumbnailModifiedTime);
  pending.set(volume.volume_uuid, { result, coverSize, coverModified });

  if (timer) return; // Already coalescing a batch; this entry rides along with it.
  timer = setTimeout(() => void flushPendingCoverPersists(), COVER_PERSIST_DEBOUNCE_MS);
}

/**
 * Flush every queued cover as ONE transaction. Exported (not just internal
 * to the debounce) so a test — or a caller that wants the writes to have
 * landed before proceeding — can flush deterministically instead of
 * advancing fake timers.
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
      for (const [volumeUuid, { result, coverSize, coverModified }] of entries) {
        const fresh = (await db.volumes.get(volumeUuid)) as VolumeMetadata | undefined;
        if (!fresh || !needsDownload(fresh) || fresh.thumbnail) continue;

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
