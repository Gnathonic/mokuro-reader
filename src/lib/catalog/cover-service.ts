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
import { normalizeVolumeTitleKey } from '$lib/metadata/series-key';
import {
  acquireBackfillSlot,
  buildImageOnlyEntry,
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
 * once a cover lands, this module writes it (and whatever row it belongs on)
 * straight into `db.volumes`, and the `volumes` liveQuery → `volumesWith-
 * Placeholders` → catalog re-derive is what every view re-renders from.
 * There is no per-component result plumbing, and no in-memory cover cache
 * outside this module's own in-flight bookkeeping — a delivered cover always
 * has a row to land on (see the decision tree below), so there is nothing
 * left to cache in memory once a request settles.
 *
 * User ruling, twice now: "install them and their metadata if they are
 * requested for rendering for a series card" — and, when a rendered volume
 * has no metadata at all yet, "the service fetches what it needs to build
 * it." `requestCover` resolves exactly one of four cases per volume:
 *
 * 1. A DB row already exists (installed, or metadata-only) → install the
 *    cover onto it directly.
 * 2. An INDEX-ADOPTED placeholder (`isIndexedPlaceholder` — a real uuid and
 *    counts already adopted from the cached `series_index`) → materialize
 *    the row from what the placeholder already knows, no network pull
 *    needed for the entry itself, then install the cover.
 * 3. A BARE placeholder whose archive HAS a `.mokuro`/`.mokuro.gz` sidecar in
 *    the listing → pull it (the SAME `pullMokuroEntry` a backfill pass uses,
 *    throttled through the SAME cross-series `acquireBackfillSlot` pool —
 *    render-demand browsing must not stampede a provider any more than a
 *    reconcile sweep may), materialize the row under the mokuro's REAL uuid,
 *    install the cover, and hand the entry to the per-series debounced
 *    `series.json` writer so the index converges too (best-effort — its own
 *    gates apply at fire time, same as every other producer of that file).
 * 4. A BARE placeholder whose archive has NO sidecar at all (image-only) →
 *    the same zero-count entry convention `series-backfill.ts` uses for this
 *    case, no pull.
 *
 * This makes the catalog grid a THIRD materialization trigger, alongside a
 * link event and a series open: a series-index-adopted or bare placeholder
 * materializes the moment its cover is actually rendered, never before —
 * on-demand, matching this app's existing on-demand philosophy rather than
 * eagerly installing an entire library's worth of metadata up front.
 *
 * READ-ONLY PROVIDERS: pulling a sidecar/cover and materializing a row are
 * READS plus a LOCAL write — allowed on a read-only share. Only the
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
 * views of it.
 */

/**
 * How long to wait before asking again for a cover that produced nothing,
 * per attempt. Two retries, deliberately: enough to ride out a connect
 * burst, few enough that a provider which is down is not asked four times
 * for every cover on screen.
 */
const RETRY_DELAYS_MS = [2000, 8000];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** uuid → settled (produced a result, whichever path delivered it). Never asked again this session. */
const settled = new Set<string>();
/** uuid → the request currently running for it. */
const inFlight = new Map<string, Promise<void>>();

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
 *   row here, only for a placeholder.
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

/** Build the `SeriesFileVolume` an index-adopted placeholder already knows, verbatim — no pull needed. */
function entryFromIndexedPlaceholder(vol: VolumeMetadata): SeriesFileVolume {
  const entry: SeriesFileVolume = {
    volume_uuid: vol.volume_uuid,
    volume_title: vol.volume_title,
    page_count: vol.page_count,
    character_count: vol.character_count,
    mokuro_version: vol.mokuro_version
  };
  if (vol.spine_width !== undefined) entry.spine_width = vol.spine_width;
  if (vol.archive_size !== undefined) entry.archive_size = vol.archive_size;
  return entry;
}

/**
 * Decision-tree cases 3/4: a BARE placeholder. Resolves (pulling a sidecar
 * only when the listing actually has one) and materializes the row, then
 * hands the entry back so the caller can install the cover and schedule the
 * `series.json` write. `undefined` means "nothing to materialize" — a
 * malformed sidecar, a disconnected provider, or rule 0/2 in
 * `materializeSeriesVolumes` blocking it — logged at debug, never thrown.
 */
async function resolveBarePlaceholder(
  vol: VolumeMetadata
): Promise<
  { entry: SeriesFileVolume; folderTitle: string; cover?: CloudFileMetadata } | undefined
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
    path: vol.cloudPath ?? `${vol.series_title}/${vol.volume_title}.cbz`,
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
    entry = buildImageOnlyEntry(folderTitle, vol.volume_title, archiveFile);
  }

  if (sidecars?.cover) {
    const coverStamp = stampFromSidecarFiles(sidecars);
    if (coverStamp.cover_size !== undefined) entry.cover_size = coverStamp.cover_size;
    if (coverStamp.cover_modified !== undefined) entry.cover_modified = coverStamp.cover_modified;
  }

  return { entry: orderVolumeEntryFields(entry), folderTitle, cover: sidecars?.cover };
}

/**
 * Deliver a fetched cover for a volume that has (or now has) a row. Called
 * ONLY once resolution (cases 1/2/3/4) has already decided the row exists —
 * `mode` is `'overwrite'` exactly when `vol` ALREADY carried a thumbnail at
 * the moment `requestCover` was called (the stale-row self-heal case;
 * `isCoverFetchTarget` is what let such a volume through in the first
 * place), `'fill'` otherwise.
 */
function deliverToRow(
  volumeUuid: string,
  result: CloudThumbnailResult,
  stamp: { size?: number; modifiedTime?: string },
  hadThumbnailAlready: boolean
): void {
  installCover(volumeUuid, result, stamp, hadThumbnailAlready ? 'overwrite' : 'fill');
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
async function resolveAndDeliver(vol: VolumeMetadata): Promise<boolean> {
  const existingRow = (await db.volumes.get(vol.volume_uuid)) as VolumeMetadata | undefined;

  if (existingRow) {
    if (!vol.cloudThumbnailFileId) return true; // the row itself claims no cover exists
    const result = await fetchCloudThumbnail({
      ...existingRow,
      cloudProvider: vol.cloudProvider,
      cloudThumbnailFileId: vol.cloudThumbnailFileId,
      cloudThumbnailPath: vol.cloudThumbnailPath
    });
    if (!result) return false; // transient: worth another attempt
    deliverToRow(
      vol.volume_uuid,
      result,
      { size: vol.cloudThumbnailSize, modifiedTime: vol.cloudThumbnailModifiedTime },
      !!vol.thumbnail
    );
    return true;
  }

  if (!vol.isPlaceholder) return true; // no row, not a placeholder: nothing this service can ever do

  if (isIndexedPlaceholder(vol)) {
    const entry = entryFromIndexedPlaceholder(vol);
    const changed = await materializeSeriesVolumes({
      seriesTitle: vol.series_title,
      entries: [entry],
      cloudVolumeTitles: new Set([vol.volume_title])
    });
    if (changed === 0) return false; // a materialize race — cheap to retry, no network involved
    if (!vol.cloudThumbnailFileId) return true; // row now exists; genuinely no cover to fetch
    const result = await fetchCloudThumbnail({
      ...vol,
      volume_uuid: entry.volume_uuid,
      cloudThumbnailFileId: vol.cloudThumbnailFileId,
      cloudThumbnailPath: vol.cloudThumbnailPath
    });
    if (!result) return false;
    deliverToRow(
      entry.volume_uuid,
      result,
      { size: vol.cloudThumbnailSize, modifiedTime: vol.cloudThumbnailModifiedTime },
      false
    );
    return true;
  }

  // Bare placeholder: cases 3/4.
  const resolved = await resolveBarePlaceholder(vol);
  if (!resolved) return false; // the pull (if any) may have failed transiently — worth retrying

  const { entry, folderTitle, cover } = resolved;
  const changed = await materializeSeriesVolumes({
    seriesTitle: vol.series_title,
    entries: [entry],
    cloudVolumeTitles: new Set([vol.volume_title])
  });
  // Best-effort convergence: the debounced writer's own gates (writable
  // provider, not server-compiled, listing) apply at fire time, not here.
  scheduleSeriesFileWrite(folderTitle);
  if (changed === 0) return false;
  if (!cover) return true; // no cover sidecar anywhere in the listing: genuinely nothing to fetch

  const result = await fetchCloudThumbnail(
    coverFetchTarget(
      entry.volume_uuid,
      vol.series_title,
      vol.volume_title,
      vol.cloudProvider,
      cover
    )
  );
  if (!result) return false;
  deliverToRow(
    entry.volume_uuid,
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
export function requestCover(vol: VolumeMetadata): void {
  const uuid = vol.volume_uuid;
  if (!uuid || settled.has(uuid) || inFlight.has(uuid)) return;
  if (!isCoverFetchTarget(vol)) return;

  const run = (async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const delivered = await resolveAndDeliver(vol);
        if (delivered) {
          settled.add(uuid);
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

  inFlight.set(uuid, run);
  void run.finally(() => {
    if (inFlight.get(uuid) === run) inFlight.delete(uuid);
  });
}

export { flushPendingCoverPersists } from './cover-persist';

/** Test hook: forget every dedupe ledger. */
export function _resetCoverServiceForTests(): void {
  settled.clear();
  inFlight.clear();
}
