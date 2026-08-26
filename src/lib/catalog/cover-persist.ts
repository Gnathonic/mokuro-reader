import { db } from '$lib/catalog/db';
import type { VolumeMetadata } from '$lib/types';
import { needsDownload } from '$lib/catalog/volume-state';
import { isArchiveSize } from '$lib/metadata/series-file';
import { isoToEpochSeconds } from '$lib/metadata/cloud-sidecar-stamps';
import { thumbnailCache } from '$lib/catalog/thumbnail-cache';
import { activeAccountScope } from '$lib/catalog/cloud-cache-key';
import { putCloudCovers, type CloudCover } from '$lib/catalog/cloud-covers';
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
 *    never the thumbnail-presence one. An overwrite also invalidates the
 *    canvas-side `thumbnailCache` for that uuid — the SAME "cover replaced"
 *    invalidation `volume-editor.ts`/`UploadView.svelte` already do for
 *    their own cover-replacing flows — so a card does not keep painting the
 *    stale bitmap it already decoded under this row's uuid.
 * 2. The SOURCE cover sidecar's listing stamp — bytes + epoch-seconds mtime —
 *    is recorded as `cover_size`/`cover_modified` on the row, mirroring
 *    `SeriesFileVolume`'s entry stamps exactly. This is what lets a LATER
 *    pass decide staleness without guessing: absent stamps are never treated
 *    as stale on their own (same migration-safety inversion as the
 *    series-index entry stamps — see `cloud-sidecar-stamps.ts`), so a
 *    thumbnail installed by older code, or measured from the volume's own
 *    pages, is left alone forever rather than being "healed" by a pull.
 *
 * ROUTING: a cover for a volume with a `volumes` row (installed, or
 * metadata-only because it carries reading history) lands on that row exactly
 * as described above. A cover for a volume with NO row — pure catalog
 * knowledge, nothing the user has installed or read — is catalog knowledge
 * only, and lands in `cloud_covers` instead (Task 2's blob-only cache table),
 * keyed by the ACTIVE account's scope so two accounts never blend covers.
 * When no account is active the flush has nowhere safe to attribute an
 * unrowed cover to, so it is simply dropped — never written unscoped. Either
 * way this module never creates a `volumes` row itself; that is still
 * `cover-service.ts`'s job (decision-tree cases 1-4), done BEFORE a cover
 * ever reaches this queue.
 *
 * WRITE-STORM AVOIDANCE, AND WHY THE CADENCE IS ADAPTIVE:
 * every `db.volumes.update` fires the `volumes` liveQuery →
 * `volumesWithPlaceholders` → the whole catalog re-derives (a placeholder
 * matcher scan, display-title resolution, a re-sort, on-screen canvas
 * redraws). At catalog scale (thousands of rows) that re-derive is not free —
 * field evidence on a 3,001-row / 1,788-cloud-file library showed a
 * sustained ~1,300-cover convergence backlog (draining at the backfill
 * semaphore's 2-wide cap) producing a coalesced write roughly every 750ms,
 * each one costing a multi-second re-derive, keeping the main thread busy
 * back-to-back for the whole convergence window.
 *
 * The FIX is not to write less often for a normal interactive trickle (a
 * screenful of cards resolving covers) — `COVER_PERSIST_BASE_DELAY_MS` (750ms)
 * still governs that, and a single wave that has nothing queued behind it by
 * the time it flushes costs exactly one flush, same as before. It is to
 * detect SUSTAINED back-to-back arrival and widen the window while it lasts:
 * every time a new batch starts collecting (`armTimer`) less than
 * `COVER_PERSIST_BASE_DELAY_MS` after the PREVIOUS flush finished, that is
 * evidence the queue is refilling faster than the interactive cadence can
 * drain it — double the delay (capped at `COVER_PERSIST_MAX_DELAY_MS`). The
 * moment a new batch starts collecting only after a genuine idle gap (>=
 * `COVER_PERSIST_BASE_DELAY_MS` since the last flush), the cadence resets to
 * base — nothing is ever "eventually" in the sense of "maybe never": the
 * backoff only ever changes WHEN a batch flushes, never WHETHER it does, so
 * every queued cover still lands (the one exception, unchanged from before
 * this round: an app close before any pending flush fires, same as any other
 * debounced write in this codebase).
 *
 * This deliberately does NOT delay what a card visibly paints — delivery to
 * the SCREEN is this same DB write (there is no separate immediate-paint
 * path; see `cover-service.ts`), so widening the flush window during a
 * genuine backlog does mean freshly-fetched covers can take up to
 * `COVER_PERSIST_MAX_DELAY_MS` to appear on screen during that backlog,
 * trading a bounded amount of "covers still popping in" for the sustained
 * main-thread jank the un-throttled 750ms cadence was causing at this scale.
 */

/** Interactive cadence: long enough to catch a burst (a first-boot catalog resolving many covers at once), short enough that "persistent" does not read as "eventually". */
export const COVER_PERSIST_BASE_DELAY_MS = 750;
/** Ceiling the adaptive cadence backs off to under sustained back-to-back arrival (a large convergence backlog). */
export const COVER_PERSIST_MAX_DELAY_MS = 8000;

interface PendingCoverPersist {
  result: CloudThumbnailResult;
  coverSize?: number;
  coverModified?: number;
  mode: 'fill' | 'overwrite';
  /**
   * The cloud path this cover was fetched for, captured at SCHEDULE time
   * (whatever `installCover`'s caller had in hand) — the only identity a
   * `cloud_covers` entry needs beyond the blob itself. `undefined` when the
   * caller had no cloud path (or passed a bare uuid), which means this
   * entry has no cover-table identity: if it turns out there is no row to
   * land on either, the flush simply drops it.
   */
  cachePath?: string;
}

/** volume_uuid → the most recent fetch result queued for it. */
const pending = new Map<string, PendingCoverPersist>();
let timer: ReturnType<typeof setTimeout> | null = null;
/** The cadence the NEXT armed timer will use — grows/resets in `armTimer`. */
let currentDelayMs = COVER_PERSIST_BASE_DELAY_MS;
/** When the most recent flush finished, or `null` before the first one ever runs. */
let lastFlushCompletedAt: number | null = null;

/**
 * Arm the next flush if none is already pending, choosing its delay from
 * whether this new batch started collecting "immediately" after the last
 * flush finished (see the module doc comment above for the full rationale).
 */
function armTimer(): void {
  if (timer) return; // Already coalescing a batch; this entry rides along with it.

  const now = Date.now();
  if (lastFlushCompletedAt !== null && now - lastFlushCompletedAt < COVER_PERSIST_BASE_DELAY_MS) {
    currentDelayMs = Math.min(currentDelayMs * 2, COVER_PERSIST_MAX_DELAY_MS);
  } else {
    currentDelayMs = COVER_PERSIST_BASE_DELAY_MS;
  }
  timer = setTimeout(() => void runScheduledFlush(), currentDelayMs);
}

/** The timer's own callback: flush, record when it finished, and re-arm if the queue refilled while it ran. */
async function runScheduledFlush(): Promise<void> {
  timer = null;
  await flushPendingCoverPersists();
  lastFlushCompletedAt = Date.now();
  if (pending.size > 0) armTimer();
}

/**
 * Queue a fetched cover for background persistence. `volume` is either a
 * bare uuid (an existing caller that knows a row exists, and never has a
 * cloud path to attribute an unrowed cover to) or a volume-shaped object
 * carrying `volume_uuid` and — when known — `cloudPath`, the identity a
 * `cloud_covers` entry needs if this cover turns out to have no row to land
 * on at flush time. Whichever shape it is, the fields it carries are
 * captured HERE, synchronously, while the caller's own snapshot is still in
 * hand — never re-read at flush time (see `flushPendingCoverPersists`).
 *
 * `stamp` is the decision-time listing snapshot the fetch was made against
 * (bytes + ISO mtime of the cover sidecar) — never re-derived from a fresher
 * listing here, so the recorded stamp always describes exactly the bytes
 * that were fetched (see `cloud-sidecar-stamps.ts`'s snapshot-discipline).
 */
export function installCover(
  volume: string | (Pick<VolumeMetadata, 'volume_uuid'> & { cloudPath?: string }),
  result: CloudThumbnailResult,
  stamp: { size?: number; modifiedTime?: string } = {},
  mode: 'fill' | 'overwrite' = 'fill'
): void {
  const volumeUuid = typeof volume === 'string' ? volume : volume.volume_uuid;
  const cachePath = typeof volume === 'string' ? undefined : volume.cloudPath;
  const coverSize = isArchiveSize(stamp.size) ? stamp.size : undefined;
  const coverModified = isoToEpochSeconds(stamp.modifiedTime);
  pending.set(volumeUuid, { result, coverSize, coverModified, mode, cachePath });
  armTimer();
}

/**
 * Flush every queued cover as ONE transaction. Exported (not just internal
 * to the scheduled flush) so a test — or a caller that wants the writes to
 * have landed before proceeding (`series-backfill.ts`'s `refreshStaleCover`)
 * — can flush deterministically instead of advancing timers. A direct call
 * like this is a forced, immediate drain: it does not participate in the
 * adaptive cadence bookkeeping (`lastFlushCompletedAt` is only updated by
 * the scheduled path), since it represents "flush right now regardless of
 * cadence", not a natural cycle of the debounce.
 */
export async function flushPendingCoverPersists(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const entries = [...pending.entries()];
  pending.clear();
  if (entries.length === 0) return;

  // Read once per flush, not per entry: this is a single decision about
  // which account's cache a whole burst attributes to, not a per-cover one.
  // Resolved defensively and OUTSIDE the main try below on purpose: a
  // provider that fails to report its scope must never block the ROW writes
  // this flush also carries — it can only cost the (optional) cache write.
  let scope: string | null = null;
  try {
    scope = activeAccountScope();
  } catch (error) {
    console.debug('[cover-persist] could not resolve the active account scope:', error);
  }
  const forCoverTable: CloudCover[] = [];

  try {
    await db.transaction('rw', db.volumes, async () => {
      for (const [volumeUuid, { result, coverSize, coverModified, mode, cachePath }] of entries) {
        const fresh = (await db.volumes.get(volumeUuid)) as VolumeMetadata | undefined;

        // A row exists only for volumes this device owns or has read; that
        // is the one case a cover belongs on the row itself. Re-reading and
        // re-testing `needsDownload` INSIDE the transaction (rather than
        // trusting the caller's snapshot) is what keeps a download that
        // finished mid-flight from having its own page-measured thumbnail
        // clobbered by a stale cloud guess.
        if (fresh) {
          if (!needsDownload(fresh)) continue;
          if (mode === 'fill' && fresh.thumbnail) continue;

          const patch: Partial<VolumeMetadata> = {
            thumbnail: result.file,
            thumbnail_width: result.width,
            thumbnail_height: result.height
          };
          if (coverSize !== undefined) patch.cover_size = coverSize;
          if (coverModified !== undefined) patch.cover_modified = coverModified;
          await db.volumes.update(volumeUuid, patch);
          if (mode === 'overwrite') thumbnailCache.invalidate(volumeUuid);
          continue;
        }

        // No row: catalog knowledge, not a relationship. It belongs in
        // `cloud_covers`, and only when we can attribute it to an account —
        // an unscoped write would blend accounts. No cachePath means the
        // caller never had a cloud path to attribute this to either
        // (a bare-uuid call): nothing to do, drop it.
        if (scope && cachePath) {
          forCoverTable.push({
            account_scope: scope,
            path: cachePath,
            thumbnail: result.file,
            width: result.width,
            height: result.height,
            last_accessed: Date.now()
          });
        }
      }
    });

    // Outside the `volumes` transaction, and coalesced to ONE call for the
    // whole burst: preserves the "one burst, one write per table" property
    // this module's write-storm-avoidance design depends on.
    await putCloudCovers(forCoverTable);
  } catch (error) {
    console.debug('[cover-persist] could not persist a batch of catalog covers:', error);
  }
}

/** Test hook: drop anything queued and forget the pending timer/cadence state, without flushing. */
export function _resetCoverPersistForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  pending.clear();
  currentDelayMs = COVER_PERSIST_BASE_DELAY_MS;
  lastFlushCompletedAt = null;
}
