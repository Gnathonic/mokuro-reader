import { db } from '$lib/catalog/db';
import { activeAccountScope } from '$lib/catalog/cloud-cache-key';
import { isVolumeInstalled } from '$lib/catalog/volume-state';
import type { VolumeMetadata } from '$lib/types';
import {
  groupSeriesSidecarFiles,
  hasCoverSidecarExtension,
  type SeriesSidecarFiles
} from '$lib/metadata/cloud-sidecar-stamps';
import { hasWritableNonServerProvider } from '$lib/metadata/series-backfill';
import { normalizeVolumeTitleKey } from '$lib/metadata/series-key';
import {
  buildVolumeSidecarsFromData,
  loadVolumeSidecars,
  type VolumeSidecarFiles
} from '$lib/util/volume-sidecars';
import { downloadQueue } from '$lib/util/download-queue';
import { cacheManager } from './cache-manager';
import { uploadCacheEntry } from './cloud-cache-interface';
import { isCbzFile } from './syncable-file';
import type { CloudFileMetadata, ProviderType, SyncProvider } from './provider-interface';
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
 * Three feeds, one check, one upload core:
 *
 * - IMPORT (`queueSidecarBackfillFromImport`, called the moment a cloud
 *   download finishes importing): the parsed pages `saveVolume` just wrote
 *   and the cover the import generated are IN MEMORY, so the missing
 *   sidecars upload right then — no Dexie re-read, no waiting for the
 *   download queue to drain, and no session cap (each upload is bounded by a
 *   download the user personally started). Skipped when the download's own
 *   provider is no longer the active one; the deferred feeds heal that later.
 * - install nomination (`queueSidecarBackfillForVolume`, the safety net right
 *   after the import feed at the same call site) enqueues that one volume for
 *   the deferred drain;
 * - listing load (`sweepInstalledVolumesForSidecarBackfill`, riding the same
 *   post-listing hook as `reconcileMissingMetadataFiles`) enqueues every
 *   installed volume the fresh listing shows a sidecar gap for.
 *
 * The deferred feeds only nominate CANDIDATES; the drain re-derives
 * "installed + archive listed + sidecar missing" per volume from the provider
 * cache at dispatch time ({@link deriveSidecarGap} — the ONE eligibility
 * check every path runs). The import feed carries its data with it but runs
 * the same check inside the same drain loop, and a volume is marked attempted
 * before its upload is dispatched — so the three feeds cannot disagree with
 * each other or with what actually gets uploaded, and no volume ever has two
 * uploads in flight whatever mix of feeds produced it. Deferred volumes
 * upload in parallel (bounded, through the worker pool — see below); the
 * import feed stays serial on the main thread.
 *
 * NON-AGGRESSIVE by construction, in this order of defenses:
 *
 * - Nothing here ever fetches a listing, and nothing here ever writes
 *   `series.json` either. The decision is made FROM a listing that just
 *   arrived (or from the provider cache it filled), and every upload ends in
 *   the same targeted cache add (`unifiedCloudManager.blindUploadFile` does
 *   it internally for the main-thread feeds; the worker feed's completion
 *   handler performs the identical `uploadCacheEntry` add) — so the next
 *   check sees the sidecar without any fetch. When
 *   the provider's upload response carried no server mtime, that cache entry
 *   is stamped with the CLIENT clock and marked `modifiedTimeProvisional`,
 *   and `cloud-sidecar-stamps.ts` refuses to derive a `series.json` stamp
 *   from a provisional entry — a server mtime that lands even a second off
 *   would make the very next listing see its own upload as stale and re-pull
 *   the sidecar it just wrote. So a reconcile pass that runs off this cache
 *   BEFORE the next real listing (the backup buttons call
 *   `reconcileMissingMetadataFiles()` with no listing argument) publishes the
 *   entry stampless — safe: a stampless entry adopts the next listing as its
 *   baseline. The stamp publishes once a REAL listing has replaced the
 *   provisional entry with the server's own `modifiedTime` — the same
 *   write-after-real-listing discipline `backup-queue.ts`'s
 *   `finishBackupRun` uses (it refetches before it writes, rather than
 *   trusting its own upload-time cache entries). That "safe" claim is about
 *   STAMPS only — the same no-listing button-triggered reconcile pass also
 *   drives `series-file-sync.ts`'s prune step (`writeSeriesFile` pruning
 *   against `cloudVolumeTitles`), which had its own hazard against a stale
 *   cache: see `ScheduleOptions.fromCloudListing` there for the fix
 *   (`fromCloudListing` now reflects whether THIS call actually got a fresh
 *   listing, not whether `runReconcile` can in general).
 * - Bounded, not greedy: the IMPORT feed stays strictly serial on the main
 *   thread (its payload is in memory and its upload rides the user's own
 *   download), while DEFERRED volumes upload through the shared worker pool —
 *   at most {@link SIDECAR_WORKER_CONCURRENCY} in flight at once, each one
 *   re-derived, dispatched, and cache-added individually. The bound is
 *   enforced HERE (the drain never has more than that many dispatches
 *   outstanding) and repeated to the pool as a `providerConcurrencyLimit`
 *   under the same `<provider>:upload` key the backup queue uses, so backfill
 *   plus backup together still respect the provider's own upload limit. A
 *   provider that cannot upload from a worker (`supportsWorkerUpload` false —
 *   the Local Folder provider's directory handle is window-bound) falls back
 *   to the old serial main-thread upload per volume.
 * - Deferred behind user-driven work: the drain waits for the download queue
 *   to be EMPTY before every DEFERRED dispatch, so a batch download the user
 *   is watching never shares its connection with a background upload — and
 *   when downloads START mid-batch, uploads already in flight finish but no
 *   new dispatch happens until the queue is idle again. Import-fed entries
 *   are exempt from the wait — their upload(s) ARE part of the download the
 *   user is watching (up to two PUTs per finished volume, and a `.mokuro`
 *   can run to a few MB), and serving them immediately is what lets their
 *   in-memory payload be released instead of pinned for the whole batch.
 * - NOT capped per session. "Non-aggressive" is the bounded dispatch plus the
 *   download-queue idle wait — pacing, not abandonment. An earlier 25/session
 *   cap was removed by the user's ruling: it halted convergence (measured:
 *   214 qualifying volumes waiting on ~9 artificial page reloads) while
 *   buying nothing the idle-deferral did not already buy. The drain runs
 *   until the queue is empty, yielding to any user-driven download before
 *   every dispatch.
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
 * How many DEFERRED-feed sidecar uploads may be in flight at once through the
 * worker pool. Three, deliberately:
 *
 * - one below the LOWEST provider backup-upload limit (Google Drive and
 *   OneDrive allow 4), and the pool key below is shared with the backup
 *   queue's — so even a maxed backfill leaves the provider at least one
 *   upload slot for a backup the user starts, while a running backup makes
 *   the backfill (whose own limit trips first) yield;
 * - three parallel multi-MB PUTs saturate a typical uplink; past that the
 *   wire is the bottleneck, not the count — more slots would only pin more
 *   serialized payloads;
 * - the pool's shared memory discipline still applies on top (non-turbo
 *   mode's 1 MB limit intentionally serializes ALL worker work, this
 *   included).
 */
const SIDECAR_WORKER_CONCURRENCY = 3;

/**
 * Memory reserved per worker sidecar task: a dense volume's `.mokuro` JSON
 * runs to ~8 MB, held roughly twice (string + Blob) plus provider upload
 * buffers; the cover is small.
 */
const SIDECAR_TASK_MEMORY_BYTES = 24 * 1024 * 1024;

/** Candidate volume uuids awaiting the authoritative check. */
const pending = new Set<string>();

/**
 * Import-fed work: the exact data `saveVolume` committed, waiting only for
 * the drain's next main-thread turn (never for the download queue, never for the
 * session cap). Entries are short-lived by design — the drain serves them
 * before any deferred volume — because each one pins its volume's parsed
 * pages and cover in memory until uploaded.
 */
const immediate: SidecarUploadFeed[] = [];

/**
 * Wake-ups for a drain that is parked on the download-queue-idle wait: an
 * import finishing mid-batch must be served NOW, not when the batch ends.
 */
const importArrivalSignals = new Set<() => void>();

/**
 * `<key(volumeUuid)>` — see {@link attemptKey} — for every volume this
 * session already attempted (or proved to have nothing uploadable). Keyed
 * with the ACCOUNT (falling back to the provider type when a provider cannot
 * report one), so switching providers OR accounts mid-session re-qualifies
 * the volume against the new listing rather than inheriting the old
 * verdict. Cleared only by a page load.
 */
const attemptedThisSession = new Set<string>();

let drainRunning: Promise<void> | null = null;

/** Test-only: forget all session state so cases don't leak into each other. */
export function _resetSidecarBackfillForTests(): void {
  pending.clear();
  immediate.length = 0;
  importArrivalSignals.clear();
  attemptedThisSession.clear();
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
  // The account, not just the provider TYPE — two accounts of one provider
  // type (two WebDAV servers, two MEGA logins) must not share failure memory
  // within a session, the same reason `cloud_covers` keys on `account_scope`
  // rather than provider type alone. `activeAccountScope()` already carries
  // the provider type as its own prefix (`<provider>:<discriminator>`, see
  // `ProviderStatus.accountScope`), so this is strictly a refinement of the
  // old key, never a divergent one. A null scope (a provider that cannot
  // report one) falls back to exactly today's key.
  const scope = activeAccountScope() ?? provider.type;
  return `${scope}:${volumeUuid}`;
}

function hasMokuroVersion(volume: VolumeMetadata): boolean {
  return typeof volume.mokuro_version === 'string' && volume.mokuro_version.trim() !== '';
}

function basename(path: string): string {
  return path.split('/').pop() ?? '';
}

/**
 * Resolve when the download queue has drained (immediately when it is idle) —
 * OR as soon as import-fed work arrives, whichever comes first. The second
 * arm exists for a drain parked here during a batch download: an import that
 * completes mid-batch must be served now (its payload is pinned memory and
 * its upload rides the user's own action), not when the whole batch ends.
 */
function whenDownloadQueueIdleOrImportWork(): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false;
    let unsubscribe: (() => void) | null = null;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      importArrivalSignals.delete(finish);
      resolve();
      // Fired LATER (not the subscribe-time replay): the assignment below
      // has long since happened, so tear the subscription down right here.
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    };
    importArrivalSignals.add(finish);
    // Work that arrived before this wait even started.
    if (immediate.length > 0) {
      finish();
      return;
    }
    unsubscribe = downloadQueue.subscribe((queue) => {
      if (queue.length > 0) return;
      finish();
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
 * What a cloud download's import hands over: the exact objects `saveVolume`
 * committed (structurally `SavedVolumeData` from `$lib/import/database`, but
 * declared here so the sync layer owns its own input contract). `metadata` is
 * the row `db.volumes` now holds; `ocrPages` is the array `volume_ocr` now
 * holds, `cumulativeChars` already stripped — the DB shape, which is the only
 * shape a `.mokuro` may be serialized from (byte-identity with what a later
 * backup re-serializes from Dexie).
 */
export interface ImportedVolumeData {
  metadata: VolumeMetadata;
  ocrPages: unknown[];
}

/**
 * TRIGGER 0 — the IMPORT feed: a cloud download just committed its volume to
 * the database, and everything the missing sidecars would say is still in
 * memory. Queue it for the drain's next main-thread turn: no download-queue wait,
 * no session cap, no Dexie re-read — the drain's other work defers to it.
 *
 * `sourceProviderType` is the provider the archive was downloaded FROM; when
 * the ACTIVE provider is a different one by the time the import completes (a
 * provider switch mid-batch), this feed declines — uploading is still safe in
 * principle (the drain would re-derive the gap against the new provider's own
 * listing), but the moment's advantage is gone and the deferred feeds handle
 * it with the usual caution instead.
 *
 * Fire-and-forget by contract: never throws, never delays the import that
 * calls it. A failure inside the eventual upload lands in the attempted-set
 * exactly like a drain failure — no same-session retry, healed by the next
 * session's sweep.
 */
export function queueSidecarBackfillFromImport(
  saved: ImportedVolumeData,
  sourceProviderType: ProviderType
): void {
  try {
    const volume = saved?.metadata;
    if (!volume?.volume_uuid || !backfillReady()) return;
    const provider = unifiedCloudManager.getActiveProvider();
    if (!provider || provider.type !== sourceProviderType) return;
    const key = attemptKey(volume.volume_uuid);
    if (!key || attemptedThisSession.has(key)) return;
    immediate.push({
      volume,
      // Deferred serialization: a volume whose sidecars turn out to be
      // present (or wanted by nothing) never pays the JSON stringify — the
      // shared core only calls this once the listing shows a real gap.
      loadSidecars: () => buildVolumeSidecarsFromData(volume, saved.ocrPages),
      isImportFeed: true
    });
    // Wake a drain parked on the download-queue-idle wait, then make sure one
    // is running at all.
    for (const signal of [...importArrivalSignals]) signal();
    kickDrain();
  } catch (error) {
    console.debug('[sidecar-backfill] could not queue imported volume:', error);
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
 * This pre-filter is deliberately cheap and folded (one pass over the
 * listing): folders are keyed by folded name, so a folder pair that folds
 * alike is examined as one. The drain resolves the REAL folder per volume
 * (`resolveCloudFolderTitle`) before uploading anything, so the fold here can
 * only over- or under-nominate, never mis-upload.
 *
 * THE GAP SET IS LISTING-ONLY, AND `db.volumes` IS READ ONLY WHEN IT IS
 * NON-EMPTY. `volumes` rows carry thumbnail File blobs inline — the exact
 * shape `hole-patch.ts` and `history-rows.ts` both refuse to scan — and this
 * runs on every listing load, across every `fetchAllCloudVolumes` call site.
 * The steady state (a library with no sidecar gaps left to backfill) is
 * therefore the common case this must cost nothing beyond the listing walk
 * for, and it does: `gapFolderKeys` below is derived entirely from `files`,
 * and an empty one returns before `db` is touched at all. Only once there is
 * at least one folder with an archive missing a sidecar does this read
 * anything — and even then keys-only first (`orderBy('series_title')
 * .uniqueKeys()`, the same index-only shape `hole-patch.ts` and
 * `volumesForFoldedSeriesTitle` use), then `primaryKeys()` scoped to just the
 * matching folders (verified genuinely keys-only against Dexie 4 —
 * `cloud-covers-store.ts` documents the same `anyOf` + `primaryKeys()`
 * guarantee), and only THEN `bulkGet` of just those uuids — so a blob is
 * deserialized only for a volume that lives in a gap folder, never for the
 * rest of the table.
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

    // LISTING-only gap set: every folder holding at least one archive whose
    // sidecar group is missing a `.mokuro` or a cover. Whether a LOCAL row
    // actually wants that sidecar (installed, has a mokuro version, has a
    // thumbnail) is a `db.volumes` question and is deliberately NOT asked
    // yet — this can only over-nominate a folder, never under-nominate one,
    // so the per-volume checks below (unchanged) still make the real call.
    const gapFolderKeys = new Set<string>();
    for (const [folderKey, stems] of folderArchiveStems) {
      const groups = groupsFor(folderKey);
      for (const stem of stems) {
        const entry = groups.get(stem);
        if (!entry?.mokuro || !entry?.cover) {
          gapFolderKeys.add(folderKey);
          break;
        }
      }
    }
    // The steady state: every listed archive already has both sidecars.
    // `db.volumes` is never opened.
    if (gapFolderKeys.size === 0) return;

    // Keys-only: which LITERAL local `series_title` spellings fold into a gap
    // folder. An index-only read — a folder with no local rows at all (the
    // common shape for a cloud-only library) costs this one walk and nothing
    // more.
    const literalTitles = (await db.volumes.orderBy('series_title').uniqueKeys()) as string[];
    const matchingLiterals = literalTitles.filter((title) =>
      gapFolderKeys.has(normalizeVolumeTitleKey(title))
    );
    if (matchingLiterals.length === 0) return;

    // Still keys-only: just the uuids filed under a gap folder, via the same
    // index (`anyOf` + `primaryKeys()` never deserializes a row).
    const gapUuids = (await db.volumes
      .where('series_title')
      .anyOf(matchingLiterals)
      .primaryKeys()) as string[];
    if (gapUuids.length === 0) return;

    // NOW read rows — bounded to volumes that live in a gap folder, never the
    // rest of the table.
    const candidates = (await db.volumes.bulkGet(gapUuids)) as Array<VolumeMetadata | undefined>;
    let queued = false;
    for (const volume of candidates) {
      if (!volume || !isVolumeInstalled(volume)) continue;
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
  if (drainRunning || (pending.size === 0 && immediate.length === 0)) return;
  const run = drain()
    .catch((error) => console.debug('[sidecar-backfill] drain failed:', error))
    .finally(() => {
      if (drainRunning === run) drainRunning = null;
      // A trigger that fired while the loop was exiting saw `drainRunning`
      // still set; pick its work up rather than stranding it.
      if (pending.size > 0 || immediate.length > 0) kickDrain();
    });
  drainRunning = run;
}

async function drain(): Promise<void> {
  // DEFERRED-feed uploads currently in flight through the worker pool. The
  // drain never lets this exceed {@link SIDECAR_WORKER_CONCURRENCY}; each
  // promise settles (never rejects) when its volume's uploads finish, fail,
  // or turn out unnecessary.
  const inFlight = new Set<Promise<void>>();
  let countedAsPoolUser = false;
  const abandonQueue = () => {
    pending.clear();
    immediate.length = 0;
  };
  try {
    while (pending.size > 0 || immediate.length > 0) {
      // Re-checked every iteration: a logout, provider switch, or a WebDAV
      // write-tolerance flip to read-only can land between volumes. Dropping
      // the whole queue (not just this volume) is what "a read-only provider
      // must not accumulate a retry queue" means — and import-fed entries go
      // with it: their payload cannot upload anywhere either, and dropping
      // them releases the memory they pin. Uploads already in flight are
      // simply awaited out (the `finally` below); they were dispatched under
      // the old provider's own credentials.
      if (!backfillReady()) {
        abandonQueue();
        return;
      }
      // Import-fed work first, always: no download-queue wait (its upload
      // rides the user's own download action) and no session cap (bounded by
      // that same action). Serving it before any deferred volume is also what
      // keeps its pinned payload short-lived — and it runs on the MAIN thread
      // regardless of any worker uploads in flight: it never waits for a
      // worker slot.
      const importEntry = immediate.shift();
      if (importEntry) {
        await uploadMissingSidecars(importEntry);
        continue;
      }
      // Low priority: user-driven downloads own the connection. Waits BEFORE
      // every dispatch, so work enqueued mid-download starts only once the
      // queue is empty — and when downloads start mid-batch, dispatches
      // already in flight finish while this parks the NEXT one. Import-fed
      // work arriving mid-wait wakes it.
      await whenDownloadQueueIdleOrImportWork();
      if (!backfillReady()) {
        abandonQueue();
        return;
      }
      // Woken by an import (or one landed while re-gating): serve it first.
      if (immediate.length > 0) continue;
      const provider = unifiedCloudManager.getActiveProvider();
      const workerCapable = provider?.supportsWorkerUpload === true;
      // THE concurrency bound: at capacity, dispatch nothing more until an
      // in-flight upload settles — or an import arrives, which needs no
      // worker slot and must not wait for one.
      if (workerCapable && inFlight.size >= SIDECAR_WORKER_CONCURRENCY) {
        await raceCompletionOrImportWork(inFlight);
        continue;
      }
      const volumeUuid: string | undefined = pending.values().next().value;
      if (volumeUuid === undefined) break;
      pending.delete(volumeUuid);
      if (workerCapable && provider) {
        if (!countedAsPoolUser) {
          countedAsPoolUser = true;
          await notePoolUse(true);
        }
        let run: Promise<void>;
        run = backfillOneViaWorker(volumeUuid, provider).finally(() => inFlight.delete(run));
        inFlight.add(run);
      } else {
        // No worker upload for this provider (Local Folder's directory handle
        // is bound to the window that received it): the old serial path.
        await backfillOne(volumeUuid);
      }
    }
  } finally {
    // The drain is not over until its dispatches are: `_drainForTests` and
    // the re-kick in `kickDrain` both rely on this promise covering every
    // in-flight upload — and a worker crash mid-batch settles its task's
    // promise through the pool's error handler, so this never wedges.
    if (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    if (countedAsPoolUser) await notePoolUse(false);
  }
}

/**
 * Park until any in-flight worker upload settles — or import-fed work
 * arrives, whichever is first. The import arm mirrors
 * {@link whenDownloadQueueIdleOrImportWork}'s: an import must never wait for
 * a worker slot it does not use.
 */
async function raceCompletionOrImportWork(inFlight: Set<Promise<void>>): Promise<void> {
  let cancel: (() => void) | undefined;
  const importArrived = new Promise<void>((resolve) => {
    const finish = () => {
      importArrivalSignals.delete(finish);
      resolve();
    };
    importArrivalSignals.add(finish);
    cancel = () => importArrivalSignals.delete(finish);
    if (immediate.length > 0) finish();
  });
  try {
    await Promise.race([importArrived, ...inFlight]);
  } finally {
    // Won by a completion: unhook the import waiter instead of leaking it.
    cancel?.();
  }
}

/**
 * Count the drain in and out of the shared pool's user tally, so another
 * queue finishing cannot terminate the pool under a backfill task. Dynamic
 * import for the same reason {@link backfillOneViaWorker} uses one; a failure
 * to load the module means no pool exists to count against.
 */
async function notePoolUse(active: boolean): Promise<void> {
  try {
    const { incrementPoolUsers, decrementPoolUsers } = await import('../file-processing-pool');
    (active ? incrementPoolUsers : decrementPoolUsers)();
  } catch (error) {
    console.debug('[sidecar-backfill] pool bookkeeping unavailable:', error);
  }
}

/**
 * One per-volume unit of backfill work: the volume's row shape plus a way to
 * produce its sidecar Files. The DEFERRED feeds read both from Dexie
 * (`backfillOne`); the IMPORT feed carries both in memory
 * (`queueSidecarBackfillFromImport`). One upload core, two data feeds — the
 * eligibility rules, naming rules, attempted-set bookkeeping, and the
 * deliberate absence of a `series.json` write live in exactly one place
 * ({@link uploadMissingSidecars}).
 */
interface SidecarUploadFeed {
  /** The volume's row shape — the Dexie row, or the exact row just committed. */
  volume: VolumeMetadata;
  /**
   * Produce the sidecar Files, called only once the listing shows a real gap.
   * Both feeds serialize through the SAME builder
   * (`buildVolumeSidecarsFromData`, which `loadVolumeSidecars` also runs on
   * the rows it reads) — that shared serializer is the byte-identity
   * guarantee between an import-time upload and a later backup.
   */
  loadSidecars: () => Promise<VolumeSidecarFiles> | VolumeSidecarFiles;
  /**
   * True only for the IMPORT feed's entry for this volume. Distinguishes the
   * one place {@link uploadMissingSidecars} must withhold the attempted-mark
   * on a missing thumbnail — see that function's comment for why.
   */
  isImportFeed: boolean;
}

/**
 * The DEFERRED feeds' per-volume step: load the row from Dexie, then run the
 * shared check-and-upload core with `loadVolumeSidecars` as the data source.
 */
async function backfillOne(volumeUuid: string): Promise<void> {
  const key = attemptKey(volumeUuid);
  if (!key || attemptedThisSession.has(key)) return;

  const volume = (await db.volumes.get(volumeUuid)) as VolumeMetadata | undefined;
  if (!volume || !isVolumeInstalled(volume)) return;

  await uploadMissingSidecars({
    volume,
    loadSidecars: () => loadVolumeSidecars(volumeUuid),
    isImportFeed: false
  });
}

/**
 * What the worker's `upload-sidecars` completion carries (declared here the
 * way `backup-queue.ts` declares `WorkerUploadCompleteData` — the sync layer
 * owns its own input contract; the authoritative shape lives in
 * `unified-file-worker.ts`).
 */
interface WorkerSidecarUploadResult {
  kind: 'mokuro' | 'cover';
  extension: string;
  fileId: string;
  modifiedTime?: string;
  size: number;
}

interface WorkerSidecarsCompleteData {
  type: 'complete';
  sidecarResults?: WorkerSidecarUploadResult[];
  error?: string;
}

/**
 * The DEFERRED feeds' per-volume step when the provider can upload from a
 * worker: same eligibility re-derivation as {@link backfillOne} (attempted
 * check, Dexie row, installed check, then {@link deriveSidecarGap} against
 * the SYNCHRONOUS cache state — all BEFORE dispatch), but the serialization
 * and upload run in the shared worker pool. The worker serializes from the
 * same Dexie rows through the same `buildMokuroMetadata`
 * (`generateVolumeSidecarsFromDb`) — byte-identical to the main-thread path —
 * and its provider core performs a TARGETED upload with no listing fetch, so
 * the blind-upload ruling (`unified-cloud-manager.blindUploadFile`'s three
 * conditions) holds unchanged: this is the same qualifying caller, with the
 * PUT moved off the main thread.
 *
 * Never rejects. A failure — dispatch, worker crash, or upload — lands the
 * volume in the account-scoped attempted-set (marked before dispatch, the
 * same "attempted either way" rule as the main-thread core) and touches
 * nothing else: the drain and the other in-flight volumes proceed.
 */
async function backfillOneViaWorker(volumeUuid: string, provider: SyncProvider): Promise<void> {
  let key: string | null = null;
  try {
    key = attemptKey(volumeUuid);
    if (!key || attemptedThisSession.has(key)) return;

    const volume = (await db.volumes.get(volumeUuid)) as VolumeMetadata | undefined;
    if (!volume || !isVolumeInstalled(volume)) return;

    // Eligibility from the cache AT DISPATCH TIME — a volume that converged
    // while earlier dispatches were in flight is skipped for free.
    const gap = deriveSidecarGap(volume);
    if (!gap) return;

    // Attempted BEFORE the async credential work and the dispatch: from this
    // point the volume is spoken for, so a same-volume import entry arriving
    // while the worker flies cannot double-upload.
    attemptedThisSession.add(key);

    // Dynamic imports keep the worker plumbing out of this module's static
    // graph (`file-processing-pool` pulls the `?worker` bundle;
    // `upload-worker-credentials` is shared with the backup queue so the two
    // callers also share its per-`provider:series` folder lock).
    const [{ getFileProcessingPool }, { getUploadWorkerCredentials }] = await Promise.all([
      import('../file-processing-pool'),
      import('../upload-worker-credentials')
    ]);
    const pool = await getFileProcessingPool();
    const credentials = await getUploadWorkerCredentials(provider, gap.folderTitle);

    await new Promise<void>((resolve) => {
      pool.addTask({
        id: `sidecar-backfill:${volumeUuid}`,
        memoryRequirement: SIDECAR_TASK_MEMORY_BYTES,
        // The same key the backup queue uses, so the pool counts backfill and
        // backup uploads against ONE per-provider total; the tighter limit
        // here makes the backfill yield first.
        provider: `${provider.type}:upload`,
        providerConcurrencyLimit: Math.min(
          SIDECAR_WORKER_CONCURRENCY,
          provider.uploadConcurrencyLimit
        ),
        data: {
          mode: 'upload-sidecars',
          provider: provider.type,
          volumeUuid,
          seriesTitle: gap.folderTitle,
          sidecarStem: basename(gap.archiveStem),
          wantMokuro: gap.wantsMokuro,
          wantCover: gap.wantsCover,
          credentials
        },
        onComplete: (raw, completeTask) => {
          try {
            recordWorkerSidecarUploads(provider.type, gap, volume, raw);
          } finally {
            completeTask();
            resolve();
          }
        },
        onError: (data) => {
          // Same contract as a main-thread upload failure: logged, no
          // in-session retry (the attempted-mark above), healed by the next
          // session's sweep. The pool has already released the worker.
          console.debug(
            `[sidecar-backfill] worker upload failed for '${volume.series_title}/${volume.volume_title}':`,
            data?.error ?? data
          );
          resolve();
        }
      });
    });
  } catch (error) {
    // Worker infrastructure unavailable (pool creation, credentials): fall
    // back to the serial main-thread path rather than stranding the volume —
    // clearing the attempted-mark first so the core's own check lets it in.
    if (key) attemptedThisSession.delete(key);
    console.debug(
      '[sidecar-backfill] worker dispatch failed, falling back to main-thread upload:',
      error
    );
    await backfillOne(volumeUuid);
  }
}

/**
 * The completion half of the worker path: the SAME provenance-correct cache
 * add `unifiedCloudManager.blindUploadFile` performs internally, fed from the
 * worker's upload response — the server's mtime when the provider reported
 * one, a client-clock entry explicitly marked provisional otherwise
 * (`uploadCacheEntry`, the single shared rule). This add is what makes the
 * next eligibility check see the sidecar without any listing fetch.
 */
function recordWorkerSidecarUploads(
  providerType: ProviderType,
  gap: SidecarGap,
  volume: VolumeMetadata,
  raw: unknown
): void {
  const data = raw as WorkerSidecarsCompleteData;
  const cache = cacheManager.getCache(providerType);
  for (const result of data?.sidecarResults ?? []) {
    const path = `${gap.archiveStem}.${result.extension}`;
    cache?.add?.(
      path,
      uploadCacheEntry(providerType, path, result.size, {
        fileId: result.fileId,
        modifiedTime: result.modifiedTime,
        size: result.size
      })
    );
  }
  if (data?.error) {
    // Partial or total failure inside the worker: whatever DID upload was
    // cache-added above; the rest waits for the next session's sweep.
    console.debug(
      `[sidecar-backfill] could not upload sidecars for '${volume.series_title}/${volume.volume_title}':`,
      data.error
    );
  }
}

/**
 * The authoritative per-volume check and, when it holds, the upload(s) — the
 * ONE upload core every feed goes through.
 *
 * Eligibility is re-derived here from the provider cache — the same cache
 * `uploadFile` adds every upload to — so a volume that converged since it was
 * nominated (another device uploaded, an earlier drain pass in this very
 * session, a stale sweep, the import feed itself) is skipped for free, and a
 * successful upload takes the volume out of contention for every LATER check
 * without any listing round trip. That is the convergence-by-construction
 * this feature requires — and it is why the import feed's safety-net
 * nomination is USUALLY harmless: by the time the drain reaches it, either
 * the attempted-set or the cache says there is nothing left to do. The one
 * exception is deliberate, not a gap: when the import feed's own thumbnail
 * was missing (a failed generation, recovered in the background moments
 * later), the attempted-mark below is withheld specifically so this
 * "harmless" nomination — and every sweep for the rest of the session — stay
 * able to pick the cover back up once the recovery lands.
 */
/**
 * The authoritative eligibility question, shared by BOTH deferred dispatch
 * paths and the main-thread upload core: does the provider cache show this
 * volume's archive listed with a sidecar gap the local row can fill? Purely
 * synchronous reads of the cache — nothing here fetches. `null` means "leave
 * the volume alone" (no archive listed, or nothing missing that the row has).
 */
interface SidecarGap {
  /** The folder the CLOUD spells this series with (`resolveCloudFolderTitle`). */
  folderTitle: string;
  /** The listed archive's path minus `.cbz` — upload paths are `${archiveStem}.<ext>`. */
  archiveStem: string;
  wantsMokuro: boolean;
  wantsCover: boolean;
}

function deriveSidecarGap(volume: VolumeMetadata): SidecarGap | null {
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
  if (!archive) return null;

  const entry = groupSeriesSidecarFiles(folderListing).get(volumeKey);
  const wantsMokuro = !entry?.mokuro && hasMokuroVersion(volume);
  const wantsCover = !entry?.cover && !!volume.thumbnail;
  if (!wantsMokuro && !wantsCover) return null;

  // The sidecar takes the ARCHIVE's exact stem, not the local title's
  // spelling: the two fold alike (that is how they matched) but can differ in
  // case or unicode form, and the cover/mokuro pairing on every reader is by
  // the listed path.
  return { folderTitle, archiveStem: archive.path.replace(/\.cbz$/i, ''), wantsMokuro, wantsCover };
}

async function uploadMissingSidecars(feed: SidecarUploadFeed): Promise<void> {
  const { volume } = feed;
  const key = attemptKey(volume.volume_uuid);
  if (!key || attemptedThisSession.has(key)) return;

  const gap = deriveSidecarGap(volume);
  if (!gap) return;
  const { archiveStem, wantsMokuro, wantsCover } = gap;

  // Serialize through the SAME builder the backup and export paths use
  // (`buildVolumeSidecarsFromData` → `buildMokuroMetadata`): an image-only
  // volume or one whose OCR rows are missing yields `mokuroFile: null` there,
  // so an empty `.mokuro` can never be invented here.
  const sidecars = await feed.loadSidecars();
  const uploads: Array<{ path: string; file: File }> = [];
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
  // forever without ever converging — EXCEPT for one case: the IMPORT feed
  // running before thumbnail generation finished. `saveVolume` returns
  // `thumbnail: undefined` on a failed generation and fires background
  // `db.processThumbnails(1)` recovery; marking the volume attempted now would
  // leave nothing to re-check it once that recovery fills the thumbnail
  // moments later — the safety-net nomination right after this feed at the
  // call site, and every sweep for the rest of the session, would all see an
  // already-attempted volume and no-op, stranding the cover until the next
  // page load. Withholding the mark here — the mokuro upload below still
  // happens immediately — leaves the volume open for that later re-check,
  // which re-reads the row from Dexie (by then holding the recovered
  // thumbnail) and re-derives eligibility against the provider cache this
  // upload is about to update, so it uploads ONLY the cover, never a second
  // copy of the `.mokuro` this pass already sent.
  const awaitingThumbnailRecovery = feed.isImportFeed && !volume.thumbnail;
  if (!awaitingThumbnailRecovery) {
    attemptedThisSession.add(key);
  }
  if (uploads.length === 0) return;

  // Only DEFERRED-feed volumes that actually reach an upload consume the
  // session budget; import-fed uploads are budgeted by the user's downloads.
  try {
    for (const upload of uploads) {
      // BLIND upload — the backfill is the caller the write-and-forget path
      // exists for: a sidecar upload changes nothing any view renders, a
      // failure loses nothing (the attempted-set defers it and the next
      // session's sweep re-derives the gap and tries again), so there is no
      // reason to pay Google Drive's ordinary post-upload refetch of the
      // WHOLE listing (13+ `files.list` calls on a 12,500-file library,
      // twice per backfilled volume). Convergence still holds: the unified
      // layer adds the file to the provider's listing cache with the upload
      // response's own metadata, so the next check sees the sidecar without
      // any fetch.
      await unifiedCloudManager.blindUploadFile(upload.path, upload.file);
    }
    // Deliberately no `series.json` write here — see the module doc's first
    // defense. The next real listing's reconcile pass stamps this folder's
    // entry from the server's own `modifiedTime`s; scheduling one from THIS
    // upload's client-stamped cache entry would violate
    // `cloud-sidecar-stamps.ts`'s "never a local clock" rule and cost every
    // backfilled volume one spurious re-pull on the next listing.
  } catch (error) {
    // No in-session retry (`attemptedThisSession` above); the next page load
    // re-derives the gap from a fresh listing and tries once more.
    console.debug(
      `[sidecar-backfill] could not upload sidecars for '${volume.series_title}/${volume.volume_title}':`,
      error
    );
  }
}
