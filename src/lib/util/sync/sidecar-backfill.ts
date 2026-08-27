import { db } from '$lib/catalog/db';
import { isVolumeInstalled } from '$lib/catalog/volume-state';
import type { VolumeMetadata } from '$lib/types';
import {
  groupSeriesSidecarFiles,
  hasCoverSidecarExtension,
  type SeriesSidecarFiles
} from '$lib/metadata/cloud-sidecar-stamps';
import { hasWritableNonServerProvider } from '$lib/metadata/series-backfill';
import { normalizeVolumeTitleKey } from '$lib/metadata/series-key';
import { scheduleSeriesFileWrite } from '$lib/metadata/series-file-sync';
import { loadVolumeSidecars } from '$lib/util/volume-sidecars';
import { downloadQueue } from '$lib/util/download-queue';
import { cacheManager } from './cache-manager';
import { isCbzFile } from './syncable-file';
import type { CloudFileMetadata } from './provider-interface';
import { unifiedCloudManager } from './unified-cloud-manager';

/**
 * Lazy per-volume sidecar backfill: a library uploaded before the sidecar
 * convention existed holds `.cbz` archives with their mokuro data EMBEDDED and
 * no cover files beside them, so every other device sees blank covers and the
 * cloud OCR pipeline finds nothing to read. Any volume that is INSTALLED here
 * already carries everything those sidecars would say — the OCR rows serialize
 * to exactly the `.mokuro` a backup writes, and the row's `thumbnail` is the
 * cover — so this module uploads the missing one(s), sourced from local data,
 * whenever the active provider's listing shows the volume's archive without
 * them.
 *
 * Two triggers, one check:
 *
 * - install (`queueSidecarBackfillForVolume`, called when a cloud download
 *   finishes importing) enqueues that one volume;
 * - listing load (`sweepInstalledVolumesForSidecarBackfill`, riding the same
 *   post-listing hook as `reconcileMissingMetadataFiles`) enqueues every
 *   installed volume the fresh listing shows a sidecar gap for.
 *
 * Both only nominate CANDIDATES; the drain re-derives "installed + archive
 * listed + sidecar missing" per volume from the provider cache at upload time,
 * so the two triggers cannot disagree with each other or with what actually
 * gets uploaded.
 *
 * NON-AGGRESSIVE by construction, in this order of defenses:
 *
 * - Nothing here ever fetches a listing. The decision is made FROM a listing
 *   that just arrived (or from the provider cache it filled), and the uploads
 *   go through `unifiedCloudManager.uploadFile`, which adds each file to that
 *   same cache — so the next check sees the sidecar without any fetch, and the
 *   `series.json` write scheduled after an upload carries `fromCloudListing`
 *   so it does not open with one either. This is the same "the listing that
 *   said 'missing' IS the fresh listing" rule `reconcileMissingMetadataFiles`
 *   follows, and it is what makes the loop this feature could so easily be
 *   (write → refetch → re-decide → write) impossible.
 * - Strictly serial: one volume at a time, one upload at a time. Mokuro files
 *   are megabytes; there is no hurry.
 * - Deferred behind user-driven work: the drain waits for the download queue
 *   to be EMPTY before every volume, so a batch download the user is watching
 *   never shares its connection with a background upload.
 * - Capped per session ({@link MAX_SIDECAR_BACKFILLS_PER_SESSION}); a legacy
 *   library converges over a handful of sessions instead of turning one page
 *   load into a bulk migration.
 * - A volume ATTEMPTED this session — uploaded, failed, or found to have
 *   nothing uploadable — is never retried until the next page load, same
 *   session-scoped contract as `hole-patch.ts`'s `attemptedThisSession`.
 * - Read-only and server-compiled providers are skipped at the door
 *   (`hasWritableNonServerProvider`, shared with `series-backfill.ts`):
 *   nothing is enqueued, nothing is logged per volume. A server that compiles
 *   metadata from the archives it holds does not want client sidecars racing
 *   its own pipeline.
 * - A volume whose archive (or whole folder) is absent from the listing is
 *   OUT OF SCOPE, silently: uploading it is backup territory, and this module
 *   never creates folders.
 *
 * Nothing is persisted: every set here is in-memory and session-scoped, and
 * the uploads themselves carry no account identity beyond the path.
 */

/**
 * Volumes actually backfilled (uploads attempted) per page load. 25 volumes is
 * at most 50 PUTs and — at a few MB per `.mokuro` — some tens of MB in the
 * worst case, which is comparable to downloading a single volume: enough to
 * make visible progress on a legacy library every session, small enough that
 * the user never notices it happening. The cap counts volumes that reached the
 * upload stage; skips (converged, out of scope) are free.
 */
export const MAX_SIDECAR_BACKFILLS_PER_SESSION = 25;

/** Candidate volume uuids awaiting the authoritative check. */
const pending = new Set<string>();

/**
 * `<providerType>:<volume_uuid>` for every volume this session already
 * attempted (or proved to have nothing uploadable). Keyed with the provider
 * type so switching providers mid-session re-qualifies the volume against the
 * NEW provider's listing rather than inheriting the old verdict. Cleared only
 * by a page load.
 */
const attemptedThisSession = new Set<string>();

let backfilledThisSession = 0;
let drainRunning: Promise<void> | null = null;

/** Test-only: forget all session state so cases don't leak into each other. */
export function _resetSidecarBackfillForTests(): void {
  pending.clear();
  attemptedThisSession.clear();
  backfilledThisSession = 0;
}

/** Test-only: the drain currently running, so a test can await convergence. */
export function _drainForTests(): Promise<void> {
  return drainRunning ?? Promise.resolve();
}

/**
 * The gate both triggers and the drain share: a writable, non-server-compiled
 * provider whose listing cache has actually been filled. The `isLoaded()` half
 * matters for the same reason it does in `hole-patch.ts`: the provider flips
 * non-null before `fetchAllCloudVolumes()` resolves, and in that window every
 * folder reads as empty — which this feature must read as "don't know yet",
 * never as "no sidecars, upload everything".
 */
function backfillReady(): boolean {
  if (!hasWritableNonServerProvider()) return false;
  const provider = unifiedCloudManager.getActiveProvider();
  if (!provider) return false;
  return !!cacheManager.getCache(provider.type)?.isLoaded();
}

function attemptKey(volumeUuid: string): string | null {
  const provider = unifiedCloudManager.getActiveProvider();
  if (!provider) return null;
  return `${provider.type}:${volumeUuid}`;
}

function hasMokuroVersion(volume: VolumeMetadata): boolean {
  return typeof volume.mokuro_version === 'string' && volume.mokuro_version.trim() !== '';
}

function basename(path: string): string {
  return path.split('/').pop() ?? '';
}

/** Resolve after the download queue has drained (immediately when it is idle). */
function whenDownloadQueueIdle(): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false;
    let unsubscribe: (() => void) | null = null;
    unsubscribe = downloadQueue.subscribe((queue) => {
      if (resolved || queue.length > 0) return;
      resolved = true;
      resolve();
      // Emitted LATER (not the subscribe-time replay): the assignment below
      // has long since happened, so tear the subscription down right here.
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    });
    // Resolved during the synchronous replay, before the assignment existed
    // for the callback to use: tear it down now instead.
    if (resolved && unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  });
}

/**
 * TRIGGER 1 — a volume just finished downloading/importing from the cloud.
 * Cheap and unconditional beyond the shared gate: the drain re-checks
 * everything, and a volume whose sidecars are all present costs one cache
 * read there. Never throws.
 */
export function queueSidecarBackfillForVolume(volumeUuid: string): void {
  try {
    if (!volumeUuid || !backfillReady()) return;
    const key = attemptKey(volumeUuid);
    if (!key || attemptedThisSession.has(key)) return;
    pending.add(volumeUuid);
    kickDrain();
  } catch (error) {
    console.debug('[sidecar-backfill] could not queue volume:', error);
  }
}

/**
 * TRIGGER 2 — a whole-account listing just landed. Sweep every installed
 * volume against it and enqueue the ones the listing shows an archive but no
 * `.mokuro` and/or no cover sidecar for.
 *
 * `files` is the listing the caller just fetched
 * (`refreshSeriesIndexesInBackground` hands over the same array it hands
 * `reconcileMissingMetadataFiles`); when absent the provider cache — which IS
 * that listing — is read instead. Never fetches, never throws.
 *
 * This pre-filter is deliberately cheap and folded (one pass over the listing,
 * one over the volumes table): folders are keyed by folded name, so a folder
 * pair that folds alike is examined as one. The drain resolves the REAL folder
 * per volume (`resolveCloudFolderTitle`) before uploading anything, so the
 * fold here can only over- or under-nominate, never mis-upload.
 */
export async function sweepInstalledVolumesForSidecarBackfill(
  files?: CloudFileMetadata[]
): Promise<void> {
  try {
    if (!backfillReady()) return;
    const listing = files ?? unifiedCloudManager.getAllCloudVolumes();
    if (!listing || listing.length === 0) return;

    // folded folder name → that folder's files / folded archive stems.
    const folderFiles = new Map<string, CloudFileMetadata[]>();
    const folderArchiveStems = new Map<string, Set<string>>();
    for (const file of listing) {
      const path = (file?.path ?? '').replace(/^\/+|\/+$/g, '');
      const parts = path.split('/');
      // Series folders are exactly one level deep — same rule as `walkListing`.
      if (parts.length !== 2 || !parts[0] || !parts[1]) continue;
      const folderKey = normalizeVolumeTitleKey(parts[0]);
      if (!folderKey) continue;
      const bucket = folderFiles.get(folderKey);
      if (bucket) bucket.push(file);
      else folderFiles.set(folderKey, [file]);
      if (isCbzFile(parts[1])) {
        const stem = normalizeVolumeTitleKey(parts[1].replace(/\.cbz$/i, ''));
        const stems = folderArchiveStems.get(folderKey) ?? new Set<string>();
        stems.add(stem);
        folderArchiveStems.set(folderKey, stems);
      }
    }
    if (folderFiles.size === 0) return;

    // Sidecar groups are derived lazily per folder — a library where every
    // folder is converged pays one archive-stem lookup per volume and nothing
    // else.
    const folderGroups = new Map<string, Map<string, SeriesSidecarFiles>>();
    const groupsFor = (folderKey: string): Map<string, SeriesSidecarFiles> => {
      let groups = folderGroups.get(folderKey);
      if (!groups) {
        groups = groupSeriesSidecarFiles(folderFiles.get(folderKey) ?? []);
        folderGroups.set(folderKey, groups);
      }
      return groups;
    };

    const volumes = (await db.volumes.toArray()) as VolumeMetadata[];
    let queued = false;
    for (const volume of volumes) {
      if (!isVolumeInstalled(volume)) continue;
      const key = attemptKey(volume.volume_uuid);
      if (!key || attemptedThisSession.has(key)) continue;

      const folderKey = normalizeVolumeTitleKey(volume.series_title);
      const stems = folderArchiveStems.get(folderKey);
      const volumeKey = normalizeVolumeTitleKey(volume.volume_title);
      // No archive in the cloud for this volume (or no folder at all): out of
      // scope — this module uploads sidecars NEXT TO archives, never archives
      // or folders.
      if (!stems?.has(volumeKey)) continue;

      const entry = groupsFor(folderKey).get(volumeKey);
      const wantsMokuro = !entry?.mokuro && hasMokuroVersion(volume);
      const wantsCover = !entry?.cover && !!volume.thumbnail;
      if (!wantsMokuro && !wantsCover) continue;

      pending.add(volume.volume_uuid);
      queued = true;
    }
    if (queued) kickDrain();
  } catch (error) {
    console.debug('[sidecar-backfill] sweep failed:', error);
  }
}

function kickDrain(): void {
  if (drainRunning || pending.size === 0) return;
  const run = drain()
    .catch((error) => console.debug('[sidecar-backfill] drain failed:', error))
    .finally(() => {
      if (drainRunning === run) drainRunning = null;
      // A trigger that fired while the loop was exiting saw `drainRunning`
      // still set; pick its work up rather than stranding it.
      if (pending.size > 0) kickDrain();
    });
  drainRunning = run;
}

async function drain(): Promise<void> {
  while (pending.size > 0) {
    // Re-checked every iteration: a logout, provider switch, or a WebDAV
    // write-tolerance flip to read-only can land between volumes. Dropping
    // the whole queue (not just this volume) is what "a read-only provider
    // must not accumulate a retry queue" means.
    if (!backfillReady()) {
      pending.clear();
      return;
    }
    if (backfilledThisSession >= MAX_SIDECAR_BACKFILLS_PER_SESSION) {
      pending.clear();
      return;
    }
    // Low priority: user-driven downloads own the connection. Waits BEFORE
    // taking a volume, so work enqueued mid-download starts only once the
    // queue is empty — and re-gates afterwards, since anything can have
    // changed while waiting.
    await whenDownloadQueueIdle();
    if (!backfillReady()) {
      pending.clear();
      return;
    }
    const volumeUuid: string | undefined = pending.values().next().value;
    if (volumeUuid === undefined) return;
    pending.delete(volumeUuid);
    await backfillOne(volumeUuid);
  }
}

/**
 * The authoritative per-volume check and, when it holds, the upload(s).
 *
 * Everything is re-derived here from the provider cache — the same cache
 * `uploadFile` adds every upload to — so a volume that converged since it was
 * nominated (another device uploaded, an earlier drain pass in this very
 * session, a stale sweep) is skipped for free, and a successful upload takes
 * the volume out of contention for every LATER check without any listing
 * round trip. That is the convergence-by-construction this feature requires.
 */
async function backfillOne(volumeUuid: string): Promise<void> {
  const key = attemptKey(volumeUuid);
  if (!key || attemptedThisSession.has(key)) return;

  const volume = (await db.volumes.get(volumeUuid)) as VolumeMetadata | undefined;
  if (!volume || !isVolumeInstalled(volume)) return;

  // The folder the CLOUD spells this series with, then its files — resolved
  // the same way every writer resolves it, so the sidecar lands beside the
  // archive whatever unicode form the folder came back in.
  const folderTitle = unifiedCloudManager.resolveCloudFolderTitle(volume.series_title);
  const folderListing = unifiedCloudManager.getCloudVolumesBySeries(folderTitle);
  const volumeKey = normalizeVolumeTitleKey(volume.volume_title);
  const archive = folderListing.find((file) => {
    const name = basename(file.path);
    return isCbzFile(name) && normalizeVolumeTitleKey(name.replace(/\.cbz$/i, '')) === volumeKey;
  });
  // No archive (or no folder): out of scope, silently — see the module doc.
  if (!archive) return;

  const entry = groupSeriesSidecarFiles(folderListing).get(volumeKey);
  const wantsMokuro = !entry?.mokuro && hasMokuroVersion(volume);
  const wantsCover = !entry?.cover && !!volume.thumbnail;
  if (!wantsMokuro && !wantsCover) return;

  // Serialize through the SAME builder the backup and export paths use
  // (`loadVolumeSidecars` → `buildMokuroMetadata`): an image-only volume or
  // one whose OCR rows are missing yields `mokuroFile: null` there, so an
  // empty `.mokuro` can never be invented here.
  const sidecars = await loadVolumeSidecars(volumeUuid);
  const uploads: Array<{ path: string; file: File }> = [];
  // The sidecar takes the ARCHIVE's exact stem, not the local title's
  // spelling: the two fold alike (that is how they matched) but can differ in
  // case or unicode form, and the cover/mokuro pairing on every reader is by
  // the listed path.
  const archiveStem = archive.path.replace(/\.cbz$/i, '');
  if (wantsMokuro && sidecars.mokuroFile) {
    uploads.push({ path: `${archiveStem}.mokuro`, file: sidecars.mokuroFile });
  }
  if (
    wantsCover &&
    sidecars.thumbnailFile &&
    hasCoverSidecarExtension(sidecars.thumbnailFile.name)
  ) {
    const ext = sidecars.thumbnailFile.name.split('.').pop();
    uploads.push({ path: `${archiveStem}.${ext}`, file: sidecars.thumbnailFile });
  }

  // Attempted either way — with nothing uploadable (a thumbnail whose type has
  // no recognized cover extension, or OCR rows that vanished) the volume would
  // otherwise be re-nominated by every listing this session and re-checked
  // forever without ever converging.
  attemptedThisSession.add(key);
  if (uploads.length === 0) return;

  // Only volumes that actually reach an upload consume the session budget.
  backfilledThisSession += 1;
  try {
    for (const upload of uploads) {
      // `unifiedCloudManager.uploadFile` adds the file to the provider's
      // listing cache — convergence without a refetch — and never triggers a
      // listing fetch of its own.
      await unifiedCloudManager.uploadFile(upload.path, upload.file);
    }
    // The stamps half of the convention: the entry for this volume in
    // `series.json` carries `mokuro_size`/`mokuro_modified` /
    // `cover_size`/`cover_modified` derived from the listing cache
    // (`buildCloudSidecarStamps` inside `writeSeriesFile`), which now holds
    // the files just uploaded. `fromCloudListing` for the same reason the
    // reconcile pass passes it: the listing that justified this write IS the
    // fresh listing, and re-fetching it is the loop this flag exists to
    // prevent.
    scheduleSeriesFileWrite(folderTitle, { fromCloudListing: true });
  } catch (error) {
    // No in-session retry (`attemptedThisSession` above); the next page load
    // re-derives the gap from a fresh listing and tries once more.
    console.debug(
      `[sidecar-backfill] could not upload sidecars for '${volume.series_title}/${volume.volume_title}':`,
      error
    );
  }
}
