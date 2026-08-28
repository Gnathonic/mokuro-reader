import { db } from '$lib/catalog/db';
import type { VolumeMetadata } from '$lib/types';
import { isIndexedPlaceholder } from '$lib/catalog/placeholders';
import { materializeSeriesVolumes } from '$lib/catalog/materialize';
import {
  groupSeriesSidecarFiles,
  isSidecarStale,
  isoToEpochSeconds,
  stampFromSidecarFiles
} from '$lib/metadata/cloud-sidecar-stamps';
import {
  isArchiveSize,
  orderVolumeEntryFields,
  type SeriesFileVolume
} from '$lib/metadata/series-file';
import { normalizeSeriesKey, normalizeVolumeTitleKey } from '$lib/metadata/series-key';
import { activeAccountScope, normalizeCachePath } from '$lib/catalog/cloud-cache-key';
import { cachedCoverPaths } from '$lib/catalog/cloud-covers';
import {
  acquireBackfillSlot,
  buildNoMetadataEntry,
  pullMokuroEntry,
  releaseBackfillSlot
} from '$lib/metadata/series-backfill';
import { scheduleSeriesFileWrite } from '$lib/metadata/series-file-sync';
import type { CloudFileMetadata } from '$lib/util/sync/provider-interface';
import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
import { fetchCloudThumbnail, type CloudThumbnailResult } from './cloud-thumbnails';
import { installCover } from './cover-persist';

/**
 * THE cover service: every surface that draws a cloud cover — the catalog
 * card, the series spine shelf, the single-volume placeholder box — calls
 * `requestCover(vol)` and nothing else. Delivery happens through the DB:
 * once a cover lands, it is written (via `cover-persist.ts`'s `installCover`)
 * onto whatever row it belongs to, OR — for a volume with no local
 * relationship at all — into the account-scoped `cloud_covers` cache instead
 * (see case 2 below and `cover-persist.ts`'s ROUTING doc). The `volumes`
 * liveQuery → `volumesWithPlaceholders` → catalog re-derive is what every
 * view re-renders from for a rowed volume; `cloud_covers` is read directly by
 * the catalog decoration pass for everything else. There is no per-component
 * result plumbing, and no in-memory cover cache outside this module's own
 * in-flight bookkeeping.
 *
 * User ruling, twice now: "install them and their metadata if they are
 * requested for rendering for a series card" — and, when a rendered volume
 * has no metadata at all yet, "the service fetches what it needs to build
 * it." That ruling covers a volume the user has actually installed or read;
 * it does not license minting a `volumes` row for every volume merely
 * scrolled past in a large cloud catalog (a regression measured at 434 → over
 * 11,000 rows browsing a ~1,000-series library, see `installCover`'s ROUTING
 * doc). `requestCover` resolves exactly one of four cases per volume:
 *
 * 1. A DB row already exists (installed, or metadata-only) → hand the cover
 *    to `installCover` for that row, WITH the listing's cloud path: a
 *    metadata-only row minted by browsing or by a series open has no
 *    relationship yet, so its blob belongs in `cloud_covers` and needs that
 *    path as its key (`installCover`'s ROUTING doc decides which).
 * 2. An INDEX-ADOPTED placeholder (`isIndexedPlaceholder` — a real uuid and
 *    counts already adopted from the cached `series_index`) → fetch the
 *    cover, if the listing has one, and hand it to `installCover` WITHOUT
 *    materializing a row first. Browsing this placeholder never mints a
 *    `volumes` row on its own; `installCover`'s own routing (Task 4) decides
 *    where the cover lands — the `cloud_covers` cache when no row exists, the
 *    row itself if one already does (e.g. a concurrent case-1/3/4 request for
 *    the same uuid materialized it first). A row for this volume is still
 *    created elsewhere, on demand, the moment it graduates to something with
 *    a real local relationship — installed, read, or its series opened
 *    (`materializeSeriesVolumes`, called directly by the series-open flow).
 * 3. A BARE placeholder whose archive HAS a `.mokuro`/`.mokuro.gz` sidecar in
 *    the listing → pull it (the SAME `pullMokuroEntry` a backfill pass uses,
 *    throttled through the SAME cross-series `acquireBackfillSlot` pool —
 *    render-demand browsing must not stampede a provider any more than a
 *    reconcile sweep may), materialize the row under the mokuro's REAL uuid
 *    (batched: see `queueMaterialization` — resolution is per volume, the
 *    WRITE is per burst), install the cover, and hand the FULLY-STAMPED entry
 *    to the per-series
 *    debounced `series.json` writer via `ScheduleOptions.cloudMeasuredVolumes`
 *    — the SAME mechanism `series-backfill.ts`'s own direct publish uses, so
 *    the entry's `mokuro_size`/`mokuro_modified`/cover stamps survive into
 *    the published file rather than falling back to the installed-row fill
 *    path and landing stampless — so the index converges too (best-effort —
 *    its own gates apply at fire time, same as every other producer of that
 *    file).
 * 4. A BARE placeholder whose archive has NO sidecar at all (image-only) →
 *    the same zero-count entry convention `series-backfill.ts` uses for this
 *    case, no pull.
 *
 * This makes the catalog grid a SECOND materialization trigger, alongside a
 * series open: a BARE placeholder (cases 3/4) still materializes the moment
 * its cover is actually rendered, never before. An index-adopted placeholder
 * (case 2) is deliberately NOT a materialization trigger any more — it is the
 * common case for a browsed catalog (a `serverCompilesMetadata` provider or a
 * synced `series.json` supplies it for nearly every volume), so letting it
 * mint a row per rendered card is exactly what produced the regression above.
 * Cases 3/4 stay a per-render ROW because they are inherently rate-limited by
 * the network pull itself (`acquireBackfillSlot`'s pool), not by request
 * volume — but they are no longer a per-render WRITE: their rows are batched
 * (`queueMaterialization`), so a burst of them costs one mutation.
 *
 * READ-ONLY PROVIDERS: pulling a sidecar/cover and materializing a row (cases
 * 3/4) are READS plus a LOCAL write — allowed on a read-only share. Only the
 * `series.json` PUBLISH (case 3) is gated on writability, and that gate
 * already lives inside `scheduleSeriesFileWrite` itself; this module never
 * duplicates it. A `serverCompilesMetadata` provider normally supplies case 2
 * (its own compiled index); a volume it has not compiled yet simply falls
 * through to case 3, whose publish attempt is intercepted/skipped server-side
 * the same way every other client write to that file is.
 *
 * DEDUPE: `requestCover` is idempotent and fire-and-forget. A uuid that has
 * already SETTLED (produced a result, however it was delivered) is never
 * asked again this session; a uuid currently IN FLIGHT shares that same
 * request rather than starting a second one. This is now the ONE ledger for
 * every surface — previously each component kept its own, which is exactly
 * how the same volume could be asked for three times by three different
 * views of it. Both halves are keyed by ACCOUNT SCOPE as well as uuid — see
 * {@link ledgerKey}.
 */

/**
 * How long to wait before asking again for a cover that produced nothing,
 * per attempt. Two retries, deliberately: enough to ride out a connect
 * burst, few enough that a provider which is down is not asked four times
 * for every cover on screen.
 */
const RETRY_DELAYS_MS = [2000, 8000];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * How long a case-3/4 batch collects before it materializes.
 *
 * This used to borrow `cover-persist.ts`'s 750ms debounce. That debounce is
 * gone (user ruling: batching was making the UI feel less reactive, and the
 * remedy for jank is backgrounding, never pacing), and this window shrank
 * with it — but it is KEPT, small, because the two queues no longer share a
 * disease: a `cloud_covers` commit is decoupled from catalog derivation, but
 * a `volumes` materialize commit is still a genuine catalog change (new rows
 * ARE catalog content — a change signal, a `count()`, and eventually one
 * coalesced full re-derive). Grouping resolutions that GENUINELY co-arrive —
 * a screenful of image-only case-4s resolves within a few milliseconds of
 * each other — still turns N transactions into one, and 100ms is enough to
 * catch exactly that co-arrival while being imperceptible next to the
 * network fetch that follows. Note this window is DB write grouping only:
 * the `series.json` CLOUD write is batched separately, by
 * `scheduleSeriesFileWrite`'s own 2s per-series debounce and write-slot
 * pool, and does not depend on this number.
 *
 * The window is armed by the FIRST entry and never re-armed while it is
 * open, so latency is bounded by the window itself rather than by when
 * arrivals happen to stop — a browsing user's row still appears within one
 * window of its cover resolving.
 */
const MATERIALIZE_BATCH_WINDOW_MS = 100;

/**
 * Hard ceiling on how many resolutions one batch may hold before it flushes
 * early, whatever the window says. The queue holds a whole `SeriesFileVolume`
 * per entry and a promise per waiter; on a very large library (10,000+ cloud
 * files) a window that only ever closes on a timer is an unbounded buffer by
 * construction. Reaching this cap simply means the batch flushes now and the
 * next one starts collecting — nothing is dropped.
 */
export const MATERIALIZE_BATCH_MAX_ENTRIES = 25;

/** Settled ledger keys (see {@link ledgerKey}): produced a result, whichever path delivered it. */
const settled = new Set<string>();
/** Ledger key → the request currently running for it. */
const inFlight = new Map<string, Promise<void>>();

/**
 * How both dedupe ledgers are keyed: ACCOUNT SCOPE, then uuid.
 *
 * A uuid alone is not enough. A placeholder's uuid is a deterministic
 * function of its path (see `placeholders.ts`), so the same volume browsed
 * under two accounts is the same uuid — and "settled" now includes the
 * `isCachedCoverPath` fast path, which is a fact about ONE account's
 * `cloud_covers` bucket. Keyed by uuid alone, a cache hit under account A
 * would permanently refuse to fetch that volume's cover under account B, for
 * the rest of the session. Scoping the ledger is also what lets a mid-session
 * cache prune be repaired by a re-request rather than only by a reload:
 * whatever settled belongs to the scope it settled under, and nothing else.
 *
 * `null` (nothing connected) gets its own bucket rather than borrowing
 * another account's, for the same reason `activeAccountScope` refuses to
 * invent a fallback.
 */
function ledgerKey(uuid: string): string {
  return `${activeAccountScope() ?? ''}\u0000${uuid}`;
}

/**
 * Should `vol` be asked for a cover right now? Shared by every surface's own
 * target-selection so the rule — including the stale-row self-heal — lives
 * in exactly one place.
 *
 * - No thumbnail yet: a placeholder (bare or indexed) is ALWAYS a target —
 *   resolution (cases 2-4 above) discovers whatever it needs on its own,
 *   with or without a pre-decorated `cloudThumbnailFileId`. A real row with
 *   no thumbnail is a target only when the catalog decoration pipeline
 *   (`placeholders.ts`'s `cloudFieldsForRemovedVolume`) already found it a
 *   cover sidecar — there is no discovery path for an already-materialized
 *   row here, only for a placeholder. Deliberately NOT gated on the cover
 *   cache: this is a synchronous predicate every surface calls per render,
 *   and the cache is only knowable by a read. `resolveAndDeliver` makes that
 *   read instead (`isCachedCoverPath`), so a cover already on disk costs one
 *   keyed presence check and no network.
 * - HAS a thumbnail: never a target for a placeholder (nothing to compare —
 *   a placeholder carries no persisted `cover_size`/`cover_modified`). For a
 *   real row, a target ONLY when its own recorded cover stamp mismatches the
 *   listing's CURRENT cover stamp (`cloudThumbnailSize`/
 *   `cloudThumbnailModifiedTime`, decorated onto this very copy at zero
 *   extra scan cost — see `catalog/index.ts`). A stampless thumbnail is
 *   NEVER treated as stale on its own — same migration-safety inversion as
 *   everywhere else this rule appears.
 */
export function isCoverFetchTarget(vol: VolumeMetadata): boolean {
  if (!vol.thumbnail) {
    if (vol.isPlaceholder) return true;
    return !!vol.cloudThumbnailFileId;
  }
  if (vol.isPlaceholder) return false;
  if (!vol.cloudThumbnailFileId) return false;
  return isSidecarStale(
    { size: vol.cover_size, modified: vol.cover_modified },
    vol.cloudThumbnailSize !== undefined || vol.cloudThumbnailModifiedTime !== undefined
      ? {
          size: vol.cloudThumbnailSize,
          modified: isoToEpochSeconds(vol.cloudThumbnailModifiedTime)
        }
      : undefined
  );
}

/** A synthesized "target" `fetchCloudThumbnail` can download from — never stored anywhere. */
function coverFetchTarget(
  uuid: string,
  seriesTitle: string,
  volumeTitle: string,
  cloudProvider: VolumeMetadata['cloudProvider'],
  cover: { fileId: string; path: string }
): VolumeMetadata {
  return {
    volume_uuid: uuid,
    series_uuid: '',
    series_title: seriesTitle,
    volume_title: volumeTitle,
    mokuro_version: '',
    page_count: 0,
    character_count: 0,
    page_char_counts: [],
    cloudProvider,
    cloudThumbnailFileId: cover.fileId,
    cloudThumbnailPath: cover.path
  };
}

/**
 * Decision-tree cases 3/4: a BARE placeholder. Resolves (pulling a sidecar
 * only when the listing actually has one) and materializes the row, then
 * hands the entry back so the caller can install the cover and schedule the
 * `series.json` write. `undefined` means "nothing to materialize" — a
 * malformed sidecar, a disconnected provider, or rule 0/2 in
 * `materializeSeriesVolumes` blocking it — logged at debug, never thrown.
 */
async function resolveBarePlaceholder(vol: VolumeMetadata): Promise<
  | {
      entry: SeriesFileVolume;
      folderTitle: string;
      /**
       * The archive's own cloud path, straight from the listing — the identity
       * a row-less (or relationship-less) cover is cached under. `undefined`
       * when the placeholder carries none, which is NOT a licence to
       * synthesize one: `catalog/index.ts` only ever reads a cached cover back
       * under the LISTING's path, so a `<series>/<volume>.cbz` guess would
       * write the blob where nothing reads it while `requestCover` marks the
       * uuid `settled` — a permanently coverless card. No path, no cache entry.
       */
      archivePath: string | undefined;
      cover?: CloudFileMetadata;
    }
  | undefined
> {
  const provider = unifiedCloudManager.getActiveProvider();
  if (!provider) return undefined;

  const folderTitle = unifiedCloudManager.resolveCloudFolderTitle(vol.series_title);
  const folderFiles = unifiedCloudManager.getCloudVolumesBySeries(folderTitle);
  const sidecars = groupSeriesSidecarFiles(folderFiles).get(
    normalizeVolumeTitleKey(vol.volume_title)
  );

  const archiveFile: CloudFileMetadata = {
    provider: vol.cloudProvider ?? provider.type,
    fileId: vol.cloudFileId ?? '',
    // Deliberately NOT synthesized when absent — see `archivePath` above.
    // `buildNoMetadataEntry` reads only `size` from this record, so an empty
    // path costs nothing here and cannot leak into a cache key.
    path: vol.cloudPath ?? '',
    size: vol.cloudSize ?? 0,
    modifiedTime: vol.cloudModifiedTime ?? ''
  };

  let entry: SeriesFileVolume | undefined;
  if (sidecars?.mokuro) {
    await acquireBackfillSlot();
    try {
      entry = await pullMokuroEntry(provider, vol.volume_title, sidecars.mokuro);
    } catch (error) {
      console.debug(`[cover-service] could not pull sidecar for '${vol.volume_title}':`, error);
    } finally {
      releaseBackfillSlot();
    }
    if (!entry) return undefined; // malformed sidecar: skip this ONE volume, no crash
    if (isArchiveSize(archiveFile.size)) entry.archive_size = archiveFile.size;
    // The SAME captured `sidecars.mokuro` object `pullMokuroEntry` just
    // downloaded from — never a fresh lookup — so the stamp always
    // describes exactly the bytes that were pulled.
    const mokuroStamp = stampFromSidecarFiles(sidecars);
    if (mokuroStamp.mokuro_size !== undefined) entry.mokuro_size = mokuroStamp.mokuro_size;
    if (mokuroStamp.mokuro_modified !== undefined)
      entry.mokuro_modified = mokuroStamp.mokuro_modified;
  } else {
    entry = buildNoMetadataEntry(folderTitle, vol.volume_title, archiveFile);
  }

  if (sidecars?.cover) {
    const coverStamp = stampFromSidecarFiles(sidecars);
    if (coverStamp.cover_size !== undefined) entry.cover_size = coverStamp.cover_size;
    if (coverStamp.cover_modified !== undefined) entry.cover_modified = coverStamp.cover_modified;
  }

  return {
    entry: orderVolumeEntryFields(entry),
    folderTitle,
    archivePath: vol.cloudPath,
    cover: sidecars?.cover
  };
}

/**
 * What a batch decided about ONE of its entries.
 *
 * - `'materialized'` — a row for this uuid exists AND belongs to this series:
 *   the cover can be delivered to it.
 * - `'foreign'` — a row exists at this uuid but belongs to a DIFFERENT series
 *   (`materializeSeriesVolumes`'s rule 0: `volume_uuid` is the whole table's
 *   primary key and is title-independent, so a mokuro re-OCR'd elsewhere can
 *   legitimately hand two series the same uuid). Nothing was written and
 *   nothing ever will be — delivering the cover here would paint THIS series'
 *   art onto that other series' row, which for a history-bearing row is a
 *   visibly wrong cover on something the user cares about.
 * - `'blocked'` — no row at this uuid: rule 2 refused it, a concurrent write
 *   raced, or the batch threw. Might well succeed on a later attempt.
 */
type MaterializeOutcome = 'materialized' | 'foreign' | 'blocked';

/** One resolved case-3/4 volume waiting for the next batched materialize. */
interface QueuedMaterialization {
  entry: SeriesFileVolume;
  /** The listing title this entry was resolved from — the gate `materializeSeriesVolumes` checks. */
  volumeTitle: string;
  /** The cloud FOLDER this series lives in, for the `series.json` write. */
  folderTitle: string;
  /** Settled with what the batch decided about this entry's uuid once it has landed. */
  resolve: (outcome: MaterializeOutcome) => void;
}

/** series_title → the resolutions waiting to be materialized under it. */
const pendingMaterializations = new Map<string, QueuedMaterialization[]>();
let pendingMaterializationCount = 0;
let materializeTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Hand a resolved case-3/4 entry to the next batch instead of materializing
 * it on its own, and wait for that batch to land.
 *
 * Resolution is inherently one-volume-at-a-time (each one pulls its own
 * sidecar through the backfill semaphore), but materialization is not:
 * calling `materializeSeriesVolumes` per resolved volume costs one `volumes`
 * mutation — and therefore one full catalog re-derive — per rendered card,
 * which is exactly the write storm this queue exists to remove. Batching
 * changes nothing about WHAT is stored: every entry still carries its own
 * listing title into the same per-row guards, in arrival order.
 *
 * Resolves with what the batch decided about THIS entry (a batch's total says
 * nothing about whether any one entry made it) — see {@link MaterializeOutcome}.
 * Row-EXISTS alone is deliberately not the answer: rule 0 leaves a foreign
 * series' row standing at this uuid, which looks identical to a successful
 * materialization from a `bulkGet` and is the one case a cover must never be
 * delivered for.
 */
function queueMaterialization(
  seriesTitle: string,
  queued: Omit<QueuedMaterialization, 'resolve'>
): Promise<MaterializeOutcome> {
  return new Promise<MaterializeOutcome>((resolve) => {
    const bucket = pendingMaterializations.get(seriesTitle);
    if (bucket) bucket.push({ ...queued, resolve });
    else pendingMaterializations.set(seriesTitle, [{ ...queued, resolve }]);
    pendingMaterializationCount += 1;

    if (pendingMaterializationCount >= MATERIALIZE_BATCH_MAX_ENTRIES) {
      void flushPendingMaterializations();
      return;
    }
    if (!materializeTimer) {
      materializeTimer = setTimeout(
        () => void flushPendingMaterializations(),
        MATERIALIZE_BATCH_WINDOW_MS
      );
    }
  });
}

/**
 * Materialize every queued batch — one `materializeSeriesVolumes` call per
 * series, one `scheduleSeriesFileWrite` per cloud folder carrying all of that
 * folder's entries as `cloudMeasuredVolumes` (that option accumulates across
 * coalesced calls by design, so one call with N entries and N calls with one
 * entry each publish the same file; the difference is only how many times the
 * writer is asked).
 *
 * Exported for the same reason `flushPendingCoverPersists` is: a test — or a
 * caller that needs the rows to exist before proceeding — can drain
 * deterministically instead of waiting out the window.
 */
export async function flushPendingMaterializations(): Promise<void> {
  if (materializeTimer) {
    clearTimeout(materializeTimer);
    materializeTimer = null;
  }
  const batches = [...pendingMaterializations.entries()];
  pendingMaterializations.clear();
  pendingMaterializationCount = 0;
  if (batches.length === 0) return;

  await Promise.all(batches.map(([seriesTitle, queued]) => materializeBatch(seriesTitle, queued)));
}

/** One series' batch: materialize it, settle its waiters, publish its entries. */
async function materializeBatch(
  seriesTitle: string,
  queued: QueuedMaterialization[]
): Promise<void> {
  const entries = queued.map((q) => q.entry);
  try {
    await materializeSeriesVolumes({
      seriesTitle,
      entries,
      // The union of the titles each entry was resolved from — every entry's
      // own listing title is in it, so the per-entry gate answers exactly
      // what it answered when each was materialized alone.
      cloudVolumeTitles: new Set(queued.map((q) => q.volumeTitle))
    });

    // Which entries actually ended up with a row OF THIS SERIES, in one
    // indexed read for the whole batch. Rule 0/2 can legitimately block an
    // entry, and a concurrent resolution can have materialized it already —
    // both are per-entry facts the batch's own return count cannot express.
    // The series check is not decoration: rule 0 SKIPS an entry whose uuid is
    // already owned by another series' row and leaves that row in place, so a
    // bare "a row exists" test reads that refusal as a success and would hand
    // the foreign row this series' cover.
    const seriesKey = normalizeSeriesKey(seriesTitle);
    const rows = (await db.volumes.bulkGet(entries.map((e) => e.volume_uuid))) as (
      | VolumeMetadata
      | undefined
    )[];
    queued.forEach((q, i) => {
      const existing = rows[i];
      if (!existing) return q.resolve('blocked');
      // An unusable series key means `materializeSeriesVolumes` bailed before
      // writing anything, so whatever stands at this uuid is not ours either —
      // but it is a degenerate input, not a permanent verdict about the uuid.
      if (!seriesKey) return q.resolve('blocked');
      q.resolve(
        normalizeSeriesKey(existing.series_title) === seriesKey ? 'materialized' : 'foreign'
      );
    });
  } catch (error) {
    console.debug(`[cover-service] could not materialize a batch for '${seriesTitle}':`, error);
    // Nothing landed and nothing was published: leave every waiter to the
    // retry schedule, exactly as a throw from the un-batched call did.
    queued.forEach((q) => q.resolve('blocked'));
    return;
  }

  // Best-effort convergence: the debounced writer's own gates (writable
  // provider, not server-compiled, listing) apply at fire time, not here.
  // The entries themselves are threaded through as `cloudMeasuredVolumes` —
  // without them the eventual publish would fall back to `buildSeriesFile`'s
  // installed-row fill path and land PERMANENTLY STAMPLESS (mokuro/cover
  // stamps all dropped), which under the stampless-never-stale inversion can
  // then never be re-verified by staleness detection again (see
  // `ScheduleOptions.cloudMeasuredVolumes`'s own doc in `series-file-sync.ts`).
  const byFolder = new Map<string, SeriesFileVolume[]>();
  for (const q of queued) {
    const forFolder = byFolder.get(q.folderTitle);
    if (forFolder) forFolder.push(q.entry);
    else byFolder.set(q.folderTitle, [q.entry]);
  }
  try {
    for (const [folderTitle, folderEntries] of byFolder) {
      // `fromCloudListing`: these entries were resolved from the cloud listing
      // the placeholder itself was minted from, so the write must not open
      // with a whole-account re-fetch. That re-fetch is what closed the loop
      // — fetch installs a fresh file map, the map re-mints every placeholder,
      // re-minted bare placeholders land back here, and the writes they
      // schedule fetch again the moment the queue drains past the listing TTL.
      // See `ScheduleOptions.fromCloudListing` in `series-file-sync.ts`.
      scheduleSeriesFileWrite(folderTitle, {
        cloudMeasuredVolumes: folderEntries,
        fromCloudListing: true
      });
    }
  } catch (error) {
    // Best-effort, and never the caller's problem: the waiters are already
    // settled, and this runs detached from `requestCover`'s own try/catch.
    console.debug(`[cover-service] could not schedule a series.json write:`, error);
  }
}

/**
 * Deliver a fetched cover for a volume that has (or now has) a row. Called
 * once resolution (cases 1/3/4) has decided a row exists; case 2 (an
 * index-adopted placeholder) never materializes a row and calls
 * `installCover` directly instead.
 *
 * A row EXISTING is not the same as the cover belonging ON it:
 * `cover-persist.ts` puts a blob on a row only for a volume this device has a
 * RELATIONSHIP with (installed, or read), and routes everything else —
 * including the metadata-only rows browsing itself mints, cases 3/4 here and
 * `series-open.ts` — to the `cloud_covers` cache, keyed by cloud path. So
 * `cachePath` is threaded through at EVERY call site, not just the row-less
 * ones: without it a browsed volume's cover has no cache identity and is
 * dropped at flush time, leaving the card permanently blank. `undefined` is
 * only for a caller that genuinely has no cloud path in hand.
 *
 * `mode` is `'overwrite'` exactly when `vol` ALREADY carried a thumbnail at
 * the moment `requestCover` was called (the stale-row self-heal case;
 * `isCoverFetchTarget` is what let such a volume through in the first place),
 * `'fill'` otherwise.
 */
function deliverToRow(
  volumeUuid: string,
  cachePath: string | undefined,
  result: CloudThumbnailResult,
  stamp: { size?: number; modifiedTime?: string },
  hadThumbnailAlready: boolean
): void {
  installCover(
    { volume_uuid: volumeUuid, cloudPath: cachePath },
    result,
    stamp,
    hadThumbnailAlready ? 'overwrite' : 'fill'
  );
}

/**
 * Is this path's cover ALREADY in the account's `cloud_covers` cache?
 *
 * THE RE-DOWNLOAD GUARD. Until covers were cut out of catalog derivation, a
 * cached cover suppressed its own re-fetch by accident: `generatePlaceholders`
 * stamped the cached blob onto the placeholder, so `isCoverFetchTarget` saw a
 * `thumbnail` and said no. With that decoration gone, every cloud volume reads
 * as a fetch target on a cold page load — the `settled` ledger is
 * session-scoped — and a library of ~4,347 covers would re-download the lot
 * from the network on every reload, trading the freeze for a network storm.
 *
 * KEYS ONLY, and asked at REQUEST time rather than read off the keys-only
 * store. Same primitive `cover-install.ts` filters its own candidates with
 * (`withoutCachedCovers`), so the two paths cannot disagree about what counts
 * as already-cached. The store was the obvious alternative and is the wrong
 * tool here: it fills asynchronously behind the cloud listing, while cards
 * call `requestCover` the moment that same listing renders them — a gate read
 * off it would be empty for the first screenful and let exactly the storm it
 * exists to stop through. This costs one keyed presence read per requested
 * volume, no blobs, independent of table size.
 *
 * NOT A STALENESS CHECK, and it must never become one: it is consulted only
 * where the alternative is a FILL (`!vol.thumbnail`). The self-heal branch —
 * a persisted row whose own `cover_size`/`cover_modified` mismatch the
 * listing's current sidecar stamp — carries a `thumbnail` and never reaches
 * here, so an overwrite still fetches. (Nor can the two collide: a row with a
 * thumbnail has its covers routed onto the row itself, never into
 * `cloud_covers` — see `cover-persist.ts`'s ROUTING doc.)
 */
async function isCachedCoverPath(cloudPath: string | undefined): Promise<boolean> {
  if (!cloudPath) return false;
  try {
    const scope = activeAccountScope();
    if (!scope) return false;
    const normalized = normalizeCachePath(cloudPath);
    const cached = await cachedCoverPaths(scope, [normalized]);
    return cached.has(normalized);
  } catch (error) {
    // A cache we cannot read is not a reason to refuse a cover; fetching is
    // the safe answer, exactly as `withoutCachedCovers` decides it.
    console.debug('[cover-service] could not consult the cover cache:', error);
    return false;
  }
}

/**
 * Resolve and deliver `vol`'s cover, whichever decision-tree case applies.
 * Returns whether a cover was actually DELIVERED (or positively confirmed to
 * not exist, from data already in hand) — `true` — versus an attempt that
 * came back empty-handed for a reason that might well be transient (a
 * saturated provider, a timed-out download, a materialize race) — `false`.
 * `fetchCloudThumbnail` never throws; it swallows every network failure into
 * a `null` return (see `cloud-thumbnails.ts`), so `false` here is the ONLY
 * signal the caller has that this attempt produced nothing. The caller
 * (`requestCover`) treats the two identically to a thrown error for retry
 * purposes, but must NOT mark the uuid `settled` on `false` — a "nothing
 * yet" answer settled forever is exactly the "no covers until I navigate
 * away and back" regression this return value exists to prevent.
 */
async function resolveAndDeliver(vol: VolumeMetadata, stillNear?: () => boolean): Promise<boolean> {
  // Already on disk for this account: the surface drawing this volume resolves
  // it by path (`cover-resolver.ts`) and there is nothing to fetch. Settled, so
  // the uuid is never asked again this session. Checked BEFORE the case split
  // on purpose — it is also what keeps a cached cover from materializing a row
  // for a bare placeholder (cases 3/4), which is exactly what the removed
  // placeholder decoration used to prevent.
  if (!vol.thumbnail && (await isCachedCoverPath(vol.cloudPath))) return true;

  const existingRow = (await db.volumes.get(vol.volume_uuid)) as VolumeMetadata | undefined;

  if (existingRow) {
    if (!vol.cloudThumbnailFileId) return true; // the row itself claims no cover exists
    const result = await fetchCloudThumbnail(
      {
        ...existingRow,
        cloudProvider: vol.cloudProvider,
        cloudThumbnailFileId: vol.cloudThumbnailFileId,
        cloudThumbnailPath: vol.cloudThumbnailPath
      },
      stillNear
    );
    if (!result) return false; // transient: worth another attempt
    deliverToRow(
      vol.volume_uuid,
      // The catalog decorates a metadata-only row's copy with the listing's
      // `cloudPath` (see `cloudFieldsForRemovedVolume`), which is the cache
      // identity such a row's cover needs when it has no relationship yet;
      // an installed row carries none and needs none.
      vol.cloudPath ?? existingRow.cloudPath,
      result,
      { size: vol.cloudThumbnailSize, modifiedTime: vol.cloudThumbnailModifiedTime },
      !!vol.thumbnail
    );
    return true;
  }

  if (!vol.isPlaceholder) return true; // no row, not a placeholder: nothing this service can ever do

  if (isIndexedPlaceholder(vol)) {
    // Deliberately NO materialize here — see the module doc's case 2. Fetch
    // the cover, if the listing has one, and hand it to `installCover`
    // exactly as it stands (no row to land on): its own routing (Task 4)
    // caches it in `cloud_covers` when an account scope is active, or drops
    // it, never minting a `volumes` row just because this placeholder was
    // rendered.
    if (!vol.cloudThumbnailFileId) return true; // no row, and genuinely no cover to fetch
    const result = await fetchCloudThumbnail(vol, stillNear);
    if (!result) return false; // transient: worth another attempt
    installCover({ volume_uuid: vol.volume_uuid, cloudPath: vol.cloudPath }, result, {
      size: vol.cloudThumbnailSize,
      modifiedTime: vol.cloudThumbnailModifiedTime
    });
    return true;
  }

  // Bare placeholder: cases 3/4.
  const resolved = await resolveBarePlaceholder(vol);
  if (!resolved) return false; // the pull (if any) may have failed transiently — worth retrying

  const { entry, folderTitle, archivePath, cover } = resolved;
  // Queued, not written on its own: the batch this joins issues ONE
  // materialize (and one `series.json` schedule) for every case-3/4 volume
  // that resolves alongside it, instead of one mutation per rendered card.
  const outcome = await queueMaterialization(vol.series_title, {
    entry,
    volumeTitle: vol.volume_title,
    folderTitle
  });
  // Rule 0 refused: this uuid belongs to ANOTHER series' row. Fetching and
  // delivering would paint this series' cover onto that row (worst case, a
  // history-bearing one the user actually reads from). Settled rather than
  // retried — the uuid collision is a fact about the data, not a transient
  // failure, and re-pulling the same sidecar twice more to reach the same
  // verdict is pure waste.
  if (outcome === 'foreign') return true;
  if (outcome !== 'materialized') return false;
  if (!cover) return true; // no cover sidecar anywhere in the listing: genuinely nothing to fetch

  const result = await fetchCloudThumbnail(
    coverFetchTarget(
      entry.volume_uuid,
      vol.series_title,
      vol.volume_title,
      vol.cloudProvider,
      cover
    ),
    stillNear
  );
  if (!result) return false;
  deliverToRow(
    entry.volume_uuid,
    // The row this just minted exists purely because the volume was browsed:
    // no relationship, so its cover belongs in `cloud_covers` under the
    // ARCHIVE's path — the same key the catalog looks a metadata-only row's
    // cached cover up by.
    archivePath,
    result,
    { size: cover.size, modifiedTime: cover.modifiedTime },
    false
  );
  return true;
}

/**
 * Ask for `vol`'s cover, once — idempotent and fire-and-forget. Safe to call
 * from every surface's own effect on every re-render; the dedupe below makes
 * a redundant call free.
 */
/**
 * `stillNear` — optional liveness probe from the requesting surface ("is my
 * element still near the viewport?", see `isNearViewport`). It changes fetch
 * ORDER only, never outcome: `cloud-thumbnails.ts` grants its download slots
 * newest-first among probes that answer yes, and drains the rest as backlog.
 * A deduped request keeps the FIRST caller's probe — two surfaces rarely
 * fetch-target one uuid at once, and the cost of a stale probe is one
 * mis-ranked grant, not a lost cover.
 */
export function requestCover(vol: VolumeMetadata, stillNear?: () => boolean): void {
  const uuid = vol.volume_uuid;
  if (!uuid) return;
  // Bound to the account the request is being made FOR, once: the same
  // request must not settle under one scope and be looked up under another
  // if the user switches accounts while it is in flight.
  const key = ledgerKey(uuid);
  if (settled.has(key) || inFlight.has(key)) return;
  if (!isCoverFetchTarget(vol)) return;

  const run = (async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const delivered = await resolveAndDeliver(vol, stillNear);
        if (delivered) {
          settled.add(key);
          return;
        }
        // Produced nothing, but nothing THREW either — a saturated provider
        // or a materialize race, not a confirmed "no cover exists". Retried
        // on the SAME backoff schedule as a thrown error, but deliberately
        // never marked `settled`: if the whole schedule is spent with no
        // luck, the uuid is simply left alone (not blacklisted) so the very
        // next render's `requestCover` call starts a fresh attempt cycle
        // rather than being permanently silenced for the rest of the session.
        if (attempt >= RETRY_DELAYS_MS.length) return;
        await sleep(RETRY_DELAYS_MS[attempt]);
      } catch (error) {
        if (attempt >= RETRY_DELAYS_MS.length) {
          console.warn(`Cover request failed for ${vol.volume_title}:`, error);
          return;
        }
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  })();

  inFlight.set(key, run);
  void run.finally(() => {
    if (inFlight.get(key) === run) inFlight.delete(key);
  });
}

export { flushPendingCoverPersists } from './cover-persist';

/** Test hook: forget every dedupe ledger and drop the materialize queue. */
export function _resetCoverServiceForTests(): void {
  settled.clear();
  inFlight.clear();
  if (materializeTimer) clearTimeout(materializeTimer);
  materializeTimer = null;
  for (const queued of pendingMaterializations.values()) {
    for (const q of queued) q.resolve('blocked');
  }
  pendingMaterializations.clear();
  pendingMaterializationCount = 0;
}
