import { get } from 'svelte/store';
import { db } from '$lib/catalog/db';
import type { VolumeMetadata } from '$lib/types';
import { isVolumeInstalled, needsDownload } from '$lib/catalog/volume-state';
import { isArchiveSize } from '$lib/metadata/series-file';
import { isoToEpochSeconds } from '$lib/metadata/cloud-sidecar-stamps';
import { thumbnailCache } from '$lib/catalog/thumbnail-cache';
import { activeAccountScope } from '$lib/catalog/cloud-cache-key';
import { putCloudCovers, type CloudCover } from '$lib/catalog/cloud-covers';
import { volumes as readingHistoryStore } from '$lib/settings/volume-data';
import { hasReadingActivity, type ReadingHistoryEntry } from '$lib/settings/reading-activity';
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
 * 1. The thumbnail is written behind a transactional guard — re-read the row
 *    inside the write transaction and re-test `needsDownload(...)` against
 *    THAT read, not the snapshot the caller started from — a download finishing
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
 * WRITE-STORM AVOIDANCE, AND WHY BATCHES ARE CAPPED RATHER THAN WIDENED:
 * every `db.volumes.update` fires the `volumes` liveQuery and every
 * `cloud_covers` commit fires that table's, so a burst of arrivals has to be
 * coalesced — `COVER_PERSIST_BASE_DELAY_MS` (750ms) is the debounce that does
 * it, and a single interactive wave (a screenful of cards resolving covers,
 * nothing following it) still costs exactly ONE flush.
 *
 * What this deliberately does NOT do any more is widen that window under
 * pressure. An earlier round made the delay DOUBLE (750ms → 8,000ms) whenever
 * a batch started collecting within 750ms of the last flush, on the theory
 * that fewer flushes meant fewer catalog re-derives. Measured on a
 * 12,520-file / 1,027-series library that made batches GROW as the burst
 * intensified — roughly 270 / 535 / 1,070 / 2,140 covers, the last of them
 * ~66MB of `File` objects in a SINGLE IndexedDB transaction — which is the
 * opposite of what a loaded main thread needs. (The re-derive that motivated
 * the widening is gone by a different route: `volumesWithPlaceholders` no
 * longer takes cover data as an input at all, so a cover landing cannot
 * regenerate placeholders — see the catalog-cover-ingest design.)
 *
 * So the cadence is now FIXED and the BATCH is bounded:
 *
 * - a batch never carries more than `COVER_PERSIST_MAX_BATCH` covers, and the
 *   moment the queue reaches that many it flushes immediately instead of
 *   waiting out the debounce. Batches therefore get SMALLER under pressure
 *   (more, bounded transactions) rather than larger;
 * - at most ONE flush transaction is in flight at a time. A cap reached while
 *   a flush is running does not open a second concurrent write transaction —
 *   the running drain picks the next batch up as soon as it commits, so a
 *   sustained burst drains back-to-back at bounded size;
 * - the queue itself is bounded by `COVER_PERSIST_MAX_PENDING`. See that
 *   constant for what happens when it is exceeded.
 *
 * The debounce only ever changes WHEN a batch flushes, never WHETHER it does:
 * every queued cover still lands, with two documented exceptions — an app
 * close before a pending flush fires (same as any other debounced write in
 * this codebase) and a queue overflow (below).
 */

/** Interactive cadence: long enough to catch a burst (a first-boot catalog resolving many covers at once), short enough that "persistent" does not read as "eventually". Fixed — it never grows (see the module doc comment). */
export const COVER_PERSIST_BASE_DELAY_MS = 750;

/**
 * Hard ceiling on how many covers ONE flush transaction may carry; reaching
 * it flushes immediately rather than waiting out the debounce.
 *
 * THE TRADEOFF, at the measured mean cover size of ~31.6KB (134MB / 4,347
 * covers on the reference library): this bounds a single transaction at
 * ~3.2MB, against ~66MB for the worst batch the old growing-delay backoff
 * produced — a ~20x reduction in peak transaction size. It buys that with
 * transaction COUNT: the same 4,347-cover cold start commits ~44 times
 * instead of ~4, i.e. ~3.6 commits/second across the measured 12.2s burst.
 * That is the right side of the trade now that a `cloud_covers` commit no
 * longer re-derives the catalog (the design's decoupling), because what a
 * commit still costs — the structured clone of the batch, the transaction
 * itself, and one liveQuery re-run — is roughly linear in batch size, while
 * the main-thread stall a commit can cause is not: one 66MB clone is a
 * multi-frame freeze that no amount of "fewer commits" makes up for.
 *
 * Also chosen to stay comfortably above the size of an ordinary interactive
 * wave (a screenful of cards is tens of covers, not hundreds), so the cap
 * never splits a batch the debounce was already going to coalesce.
 */
export const COVER_PERSIST_MAX_BATCH = 100;

/**
 * Hard ceiling on the QUEUE — how many fetched covers may sit un-flushed at
 * once. Roughly 10 batches, i.e. ~32MB of `File` objects retained at the
 * measured mean cover size.
 *
 * OVERFLOW POLICY, stated explicitly because the queue used to be an
 * unbounded `Map`: when a new cover arrives at a full queue, the OLDEST
 * queued cover is DROPPED to make room. Rationale:
 *
 * - the queue can only exceed one batch while a flush is in flight (a cap
 *   reached with nothing in flight flushes on the spot), so overflow means
 *   arrivals are outrunning IndexedDB for ~10 consecutive transactions.
 *   Without a bound the queue would retain every fetched blob until the
 *   backlog cleared — 134MB on the reference library's cold start;
 * - the newest arrivals are kept because cover requests are viewport-gated
 *   (`CatalogItem`'s `IntersectionObserver`), so the newest request is the
 *   one most likely to be for a card the user is looking at NOW;
 * - a dropped cover is not lost user data. It is a cache fill: the card shows
 *   its placeholder, and the cover is re-fetched the next time that series is
 *   in view in a fresh session (`cover-service.ts`'s `settled` bookkeeping is
 *   in-memory only, so it does not outlive a reload).
 *
 * Deliberately set high enough that no measured workload reaches it — this is
 * a safety valve against a pathological runaway, not part of the normal path.
 */
export const COVER_PERSIST_MAX_PENDING = COVER_PERSIST_MAX_BATCH * 10;

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

/**
 * volume_uuid → the most recent fetch result queued for it. Insertion-ordered
 * (a `Map` is), which is what makes both "take the oldest `MAX_BATCH`" and
 * "evict the oldest on overflow" a plain iteration from the front. Re-queuing
 * an already-pending uuid replaces its value WITHOUT moving it, so a cover
 * that has been waiting keeps its place in line.
 */
const pending = new Map<string, PendingCoverPersist>();
let timer: ReturnType<typeof setTimeout> | null = null;
/**
 * The drain currently running, or `null`. Non-null means a write transaction
 * is (or is about to be) open, and no second one may be started.
 */
let inFlight: Promise<void> | null = null;
/**
 * Bumped by `_resetCoverPersistForTests` so a drain that is still awaiting
 * IndexedDB when a test tears down stops instead of picking up the NEXT
 * test's queue and flushing it against a cleared table.
 */
let generation = 0;
/** How many covers this overflow episode has dropped; reset once the queue drains. */
let overflowDropped = 0;

/** Arm the fixed-delay debounce if nothing is already pending. */
function armTimer(): void {
  if (timer) return; // Already coalescing a batch; this entry rides along with it.
  timer = setTimeout(() => {
    timer = null;
    drainSoon();
  }, COVER_PERSIST_BASE_DELAY_MS);
}

/**
 * Start (or join) a drain, then put whatever is still queued back on the
 * debounce. Fire-and-forget: nothing in the arming path ever awaits a write.
 */
function drainSoon(): void {
  const rearm = () => {
    if (pending.size > 0) armTimer();
  };
  void runDrain(false).then(rearm, rearm);
}

/**
 * The ONE place a flush transaction is started, so at most one is ever open.
 *
 * `untilEmpty` distinguishes the two callers. The scheduled/cap-triggered
 * path (`false`) keeps flushing only while the queue is still at or above the
 * cap — a trickle left behind it goes back on the debounce rather than paying
 * a transaction per cover. A forced drain (`true`, `flushPendingCoverPersists`)
 * keeps going until the queue is empty, because its caller is waiting to know
 * the writes have landed.
 */
function runDrain(untilEmpty: boolean): Promise<void> {
  if (inFlight) return inFlight;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const gen = generation;
  const run = (async () => {
    try {
      do {
        if (gen !== generation) return;
        await flushOneBatch();
      } while (untilEmpty ? pending.size > 0 : pending.size >= COVER_PERSIST_MAX_BATCH);
    } finally {
      if (gen === generation) inFlight = null;
    }
  })();
  inFlight = run;
  return run;
}

/**
 * Queue a fetched cover for background persistence. `volume` is either a
 * bare uuid (an existing caller that knows a row exists, and never has a
 * cloud path to attribute an unrowed cover to) or a volume-shaped object
 * carrying `volume_uuid` and — when known — `cloudPath`, the identity a
 * `cloud_covers` entry needs if this cover turns out to have no row to land
 * on at flush time. Whichever shape it is, the fields it carries are
 * captured HERE, synchronously, while the caller's own snapshot is still in
 * hand — never re-read at flush time (see `flushOneBatch`).
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

  while (pending.size > COVER_PERSIST_MAX_PENDING) evictOldest();

  // At the cap, flush NOW rather than waiting out the debounce — this is what
  // makes batches shrink under pressure instead of growing. When a flush is
  // already running this is a no-op: its own loop takes the next batch.
  if (pending.size >= COVER_PERSIST_MAX_BATCH) drainSoon();
  else armTimer();
}

/** Drop the oldest queued cover to keep the queue under `COVER_PERSIST_MAX_PENDING` (see that constant for why the oldest). */
function evictOldest(): void {
  const oldest = pending.keys().next().value;
  if (oldest === undefined) return;
  pending.delete(oldest);
  overflowDropped += 1;
  if (overflowDropped === 1) {
    console.debug(
      `[cover-persist] cover queue is full (${COVER_PERSIST_MAX_PENDING} waiting); dropping the oldest queued covers — they will be re-fetched on a later visit`
    );
  }
}

/**
 * Flush every queued cover, in `COVER_PERSIST_MAX_BATCH`-sized transactions,
 * until nothing is left. Exported (not just internal to the scheduled flush)
 * so a test — or a caller that wants the writes to have landed before
 * proceeding (`series-backfill.ts`'s `refreshStaleCover`) — can flush
 * deterministically instead of advancing timers. A direct call like this is a
 * forced, immediate drain: it cancels the debounce and ignores the cap's
 * "wait for the next tick" behaviour, but it still respects the ONE
 * transaction at a time rule, joining a flush that is already running rather
 * than racing it.
 */
export async function flushPendingCoverPersists(): Promise<void> {
  // Loop rather than a single call because joining an in-flight drain only
  // guarantees THAT drain's entries landed; anything queued behind it still
  // needs draining before this can promise the queue is empty.
  for (;;) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!inFlight && pending.size === 0) return;
    await runDrain(true);
  }
}

/**
 * Write ONE bounded batch — the oldest `COVER_PERSIST_MAX_BATCH` queued
 * covers — as a single `volumes` transaction plus (at most) one
 * `cloud_covers` write.
 */
async function flushOneBatch(): Promise<void> {
  const entries: Array<[string, PendingCoverPersist]> = [];
  for (const entry of pending) {
    entries.push(entry);
    if (entries.length >= COVER_PERSIST_MAX_BATCH) break;
  }
  for (const [volumeUuid] of entries) pending.delete(volumeUuid);
  if (pending.size === 0) overflowDropped = 0;
  if (entries.length === 0) return;

  // Read once per batch, not per entry: this is a single decision about
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

  // Which volumes the user actually has a relationship with, read ONCE for
  // the whole batch — a synchronous, localStorage-backed store read, not a
  // per-entry cost. A cover belongs on the row only for those: installed
  // volumes, and metadata-only rows kept for their reading history (the
  // stats and history pages read thumbnails from rows). A row minted purely
  // by browsing — case-3 placeholder resolution — is catalog knowledge, and
  // its blob belongs in `cloud_covers`, because blobs on rows are what make
  // a full `volumes` scan expensive.
  const readingHistory = get(readingHistoryStore) as Record<string, ReadingHistoryEntry>;

  try {
    await db.transaction('rw', db.volumes, async () => {
      // ONE keyed bulk read for the whole batch, not a sequential
      // `db.volumes.get()` per entry. It is still INSIDE the transaction, and
      // still by primary key — both are load-bearing. Inside, because the
      // re-check below has to see the table as of this write transaction: a
      // download that finished mid-fetch must be visible here so its
      // page-measured thumbnail is never clobbered by a stale cloud guess.
      // By key, because a `volumes` scan deserializes every row's thumbnail
      // blob (see `perf-contracts.test.ts` CONTRACT 2).
      //
      // Hoisting the reads out of the per-entry loop cannot change any
      // decision: `pending` is keyed by uuid, so no two entries in a batch
      // read the same row, and nothing this loop writes is read by a later
      // entry in the same batch.
      const rows = (await db.volumes.bulkGet(entries.map(([volumeUuid]) => volumeUuid))) as Array<
        VolumeMetadata | undefined
      >;

      for (let i = 0; i < entries.length; i++) {
        const [volumeUuid, { result, coverSize, coverModified, mode, cachePath }] = entries[i];
        const fresh = rows[i];

        const hasRelationship =
          !!fresh && (isVolumeInstalled(fresh) || hasReadingActivity(readingHistory[volumeUuid]));

        // A row exists AND the device has a relationship with it — that is
        // the one case a cover belongs on the row itself. Re-reading and
        // re-testing `needsDownload` INSIDE the transaction (rather than
        // trusting the caller's snapshot) is what keeps a download that
        // finished mid-flight from having its own page-measured thumbnail
        // clobbered by a stale cloud guess.
        if (hasRelationship && fresh) {
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

        // No relationship: either no row at all (pure catalog knowledge), or
        // a row minted purely by browsing (case-3 placeholder resolution)
        // with nothing installed and nothing read. Either way it belongs in
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
            cached_at: Date.now()
          });
        }
      }
    });

    // Outside the `volumes` transaction, and coalesced to ONE call for the
    // whole batch: preserves the "one batch, one write per table" property
    // this module's write-storm-avoidance design depends on.
    await putCloudCovers(forCoverTable);
  } catch (error) {
    console.debug('[cover-persist] could not persist a batch of catalog covers:', error);
  }
}

/** Test hook: drop anything queued and forget the pending timer/drain state, without flushing. */
export function _resetCoverPersistForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  pending.clear();
  // A drain may still be awaiting IndexedDB. Bumping the generation makes it
  // stop at its next loop check instead of flushing the next test's queue.
  generation += 1;
  inFlight = null;
  overflowDropped = 0;
}
