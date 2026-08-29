import { get } from 'svelte/store';
import { db } from '$lib/catalog/db';
import { volumesForFoldedSeriesTitle } from '$lib/catalog/volumes-by-series';
import { installCoversForSeries } from '$lib/catalog/cover-install';
import { fetchCloudThumbnail } from '$lib/catalog/cloud-thumbnails';
import { flushPendingCoverPersists, installCover } from '$lib/catalog/cover-persist';
import { materializeSeriesVolumes } from '$lib/catalog/materialize';
import { buildPageCharCounts, decodeMokuroSidecar } from '$lib/catalog/cloud-ocr-upgrade';
import { isVolumeInstalled, needsDownload } from '$lib/catalog/volume-state';
import { parseMokuroFile } from '$lib/import/processing';
import type { VolumeMetadata } from '$lib/types';
import { generateDeterministicUUID } from '$lib/util/series-extraction';
import type { CloudFileMetadata, SyncProvider } from '$lib/util/sync/provider-interface';
import { isCbzFile } from '$lib/util/sync/syncable-file';
import { providerManager } from '$lib/util/sync/provider-manager';
import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
import {
  groupSeriesSidecarFiles,
  isSidecarStale,
  stampFromSidecarFiles,
  type SeriesSidecarFiles
} from './cloud-sidecar-stamps';
import {
  isArchiveSize,
  orderVolumeEntryFields,
  seriesFileHealDifference,
  type SeriesFile,
  type SeriesFileVolume
} from './series-file';
import { getSeriesIndex } from './series-index';
// Deferred-use import into the module cycle series-file-sync ↔ series-backfill
// (series-file-sync statically imports the two backfill entry points). Safe for
// the same reason the existing unified-cloud-manager ↔ series-file-sync cycle
// is: nothing on either side calls across at module-init time, only from
// inside function bodies.
import { scheduleSeriesFileWrite } from './series-file-sync';
import { normalizeSeriesKey, normalizeVolumeTitleKey } from './series-key';
import { acquireWriteSlot, releaseWriteSlot } from './write-slot';

/**
 * Converges a `series.json` that has facts (or a partial index) but is
 * missing volume entries for archives the cloud actually holds, WITHOUT the
 * user downloading anything: it pulls just the missing/stale archives'
 * `.mokuro`/`.mokuro.gz` sidecars, builds proper entries from them (uuid +
 * counts measured from the mokuro, title from the archive filename), and
 * publishes through `unifiedCloudManager.writeSeriesFile` — the single writer,
 * same as every other producer of the file.
 *
 * Two entry points, one engine (`runBackfill`):
 *
 * - {@link backfillSeriesEntries} — the ordinary trigger (series open, and the
 *   reconcile pass for every folder that already has a sidecar). Requires a
 *   readable `series.json` to already exist; a bare cloud folder nobody
 *   linked or backed up is never swept.
 * - {@link backfillNewlyLinkedSeries} — the link-event trigger: a facts edit
 *   just made a series.json PUBLISHABLE for a series this device has nothing
 *   local for (`hasPublishableFacts` in `series-file-sync.ts`), and the file
 *   itself may not exist in the cloud yet (its facts-only write is still
 *   debouncing). Skips the existing-file requirement; everything else is
 *   identical, including the gates.
 *
 * Both are re-entrancy-safe per series (`normalizeSeriesKey`) and never throw
 * — failures are logged at debug and swallowed, same contract as every other
 * background metadata pass in this app.
 *
 * Two SEPARATE concurrency budgets keep a reconcile pass over a large
 * half-converged library from becoming the exact "200 concurrent scans + 200
 * concurrent PUTs" stampede `series-file-sync.ts`'s own `WRITE_CONCURRENCY`
 * was written to prevent (see `write-slot.ts`):
 *
 * - {@link acquireBackfillSlot} bounds how many series' worth of EXPENSIVE
 *   work (the indexed `volumesForFoldedSeriesTitle` read, the sidecar pulls,
 *   the write) run at once — module-local to this file, since it is
 *   specifically the backfill's own fan-out that needs bounding. A
 *   CONVERGED series never touches this budget at all: the cheap
 *   listing-only candidate check runs first and returns immediately when
 *   there is nothing to do, so a sweep over N already-converged folders
 *   costs N cache reads, not N queued slots.
 * - The final publish additionally acquires `write-slot.ts`'s shared
 *   `acquireWriteSlot`, the SAME pool the debounced fact-edit writer uses —
 *   so a burst of backfill-triggered writes and a burst of ordinary
 *   debounced writes share one PUT budget instead of two independent ones.
 */

/** Sidecar pulls in flight at once, per series. Small on purpose — see `cloud-ocr-upgrade.ts`. */
const PULL_CONCURRENCY = 2;

/**
 * How many series' worth of expensive backfill work (volumes scan, pulls,
 * write) may run at once, across every series. Mirrors `WRITE_CONCURRENCY` —
 * see the module doc above for why this is a SEPARATE pool from it.
 */
const BACKFILL_PASS_CONCURRENCY = 2;
let activeBackfillPasses = 0;
const waitingBackfillPasses: Array<() => void> = [];

/**
 * Exported so `cover-service.ts`'s render-demand single-archive pulls share
 * this SAME pool: "fast browsing can't stampede a provider" applies to a
 * .mokuro pull triggered by scrolling past a bare placeholder exactly as much
 * as one triggered by a reconcile sweep — one budget, not two.
 */
export function acquireBackfillSlot(): Promise<void> {
  if (activeBackfillPasses < BACKFILL_PASS_CONCURRENCY) {
    activeBackfillPasses += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    waitingBackfillPasses.push(() => {
      activeBackfillPasses += 1;
      resolve();
    });
  });
}

export function releaseBackfillSlot(): void {
  activeBackfillPasses -= 1;
  waitingBackfillPasses.shift()?.();
}

/** series_key → the pass currently running for it. */
const inFlight = new Map<string, Promise<void>>();

/**
 * A connected, writable provider that does not compile `series.json` itself.
 *
 * Exported for `sidecar-backfill.ts`, which gates its per-volume sidecar
 * uploads on the SAME test — one definition, so the two backfills can never
 * disagree about which providers accept client-produced metadata.
 */
export function hasWritableNonServerProvider(): boolean {
  const status = get(providerManager.status);
  if (!status.hasAnyAuthenticated) return false;
  const type = status.currentProviderType;
  if (!type) return false;
  const provider = status.providers[type];
  if (!provider) return false;
  if (provider.isReadOnly === true) return false;
  return provider.serverCompilesMetadata !== true;
}

function basename(path: string): string {
  return path.split('/').pop() ?? '';
}

function archiveStemOf(path: string): string {
  return basename(path).replace(/\.cbz$/i, '');
}

/**
 * Zero-count entry for an archive with no `.mokuro` sidecar at all.
 *
 * NOT an image-only claim, despite the empty `mokuro_version`. A sidecar-less
 * archive is most often a LEGACY backup whose mokuro is EMBEDDED in the
 * `.cbz` (the whole reason `sidecar-backfill.ts` exists) — nothing can know
 * which until the archive is downloaded. This entry exists only to carry the
 * archive's identity, size and cover stamps, and to stop the backfill pass
 * re-planning the archive on every listing; its zero-content shape is exactly
 * what `hasMeasuredContent` (series-file.ts) reads as "this entry proves
 * nothing", which keeps merges treating it as the weakest possible claim.
 * Consumers that copy a version onto a row or placeholder go through
 * `entryMokuroVersion`: with no cover stamps either (ALL sidecars missing)
 * this shape surfaces as `'unknown'` — never as the image-only `''` — while
 * cover stamps prove a modern backup wrote sidecars without a mokuro, which
 * IS a genuine image-only signal.
 *
 * Exported for `cover-service.ts`'s render-demand path (decision-tree case
 * 4), which builds an entry for exactly one archive the same way this module
 * does for a whole series — reused, not re-derived.
 */
export function buildNoMetadataEntry(
  folderTitle: string,
  archiveStem: string,
  archiveFile: CloudFileMetadata
): SeriesFileVolume {
  const entry: SeriesFileVolume = {
    volume_uuid: generateDeterministicUUID(`${folderTitle}/${archiveStem}`),
    volume_title: archiveStem,
    page_count: 0,
    character_count: 0,
    mokuro_version: ''
  };
  if (isArchiveSize(archiveFile.size)) entry.archive_size = archiveFile.size;
  return entry;
}

/**
 * Download and parse one `.mokuro`/`.mokuro.gz`, building the entry the ENTRY-
 * BUILDING rules describe: `volume_title` from the ARCHIVE's filename stem
 * (never the mokuro's own `title`/`volume` fields — real files get those
 * wrong), `volume_uuid` from the mokuro's own `volume_uuid`, counts measured
 * with the same char math `cloud-ocr-upgrade.ts` uses for its own upgrade
 * path. `undefined` for anything that fails to parse or lacks a usable uuid —
 * the caller treats that as "skip this one volume", never a hard failure.
 *
 * `sidecarFile` is the snapshot the caller already captured from ONE listing
 * read (`groupSeriesSidecarFiles`); it is used here for BOTH the download and
 * the stamp below, so there is no second listing lookup to race a concurrent
 * re-list — the stamp always describes exactly the bytes that were pulled.
 *
 * Exported for `cover-service.ts`'s render-demand path (decision-tree case
 * 3: a bare placeholder with a real sidecar) — the SAME pull, whether it is
 * triggered by a backfill pass or by a card being scrolled into view.
 */
export async function pullMokuroEntry(
  provider: SyncProvider,
  archiveStem: string,
  sidecarFile: CloudFileMetadata
): Promise<SeriesFileVolume | undefined> {
  const blob = await provider.downloadFile(sidecarFile);
  const decoded = await decodeMokuroSidecar(sidecarFile.path, blob);
  if (!decoded) return undefined;

  const parsed = await parseMokuroFile(decoded);
  if (typeof parsed.volumeUuid !== 'string' || !parsed.volumeUuid.trim()) return undefined;

  const pages = Array.isArray(parsed.pages) ? parsed.pages : [];
  const { totalChars } = buildPageCharCounts(pages);

  // Base fields only — the caller (`buildEntryForTask`) applies `archive_size`
  // and the stamp fields through `orderVolumeEntryFields` so every entry this
  // module produces re-serializes in the pinned wire order regardless of
  // which fields end up set.
  return {
    volume_uuid: parsed.volumeUuid,
    volume_title: archiveStem,
    page_count: pages.length,
    character_count: totalChars,
    mokuro_version: typeof parsed.version === 'string' ? parsed.version : ''
  };
}

/**
 * One row whose cover must be refetched, and the ARCHIVE it belongs to. The
 * archive path — not the cover sidecar's — is the cache identity a row-less
 * (or relationship-less) cover is stored under; see `refreshStaleCover`.
 */
interface CoverRefresh {
  volumeUuid: string;
  cover: CloudFileMetadata;
  archivePath: string | undefined;
}

/** One archive this pass decided needs (re)building, and why. */
interface BackfillTask {
  archiveStem: string;
  titleKey: string;
  archiveFile: CloudFileMetadata;
  sidecars: SeriesSidecarFiles | undefined;
  needsMokuroPull: boolean;
  /** Only meaningful when an existing entry (and likely an installed-elsewhere row) is being refreshed in place. */
  needsCoverRefetch: boolean;
  existingEntry: SeriesFileVolume | undefined;
}

/**
 * Build (or refresh) the entry for one task. `undefined` means "skip this
 * volume" — a malformed sidecar, never a thrown error (the caller still wraps
 * this in try/catch as a second line of defense for anything unanticipated).
 */
async function buildEntryForTask(
  folderTitle: string,
  task: BackfillTask,
  provider: SyncProvider
): Promise<SeriesFileVolume | undefined> {
  let entry: SeriesFileVolume;

  if (task.needsMokuroPull) {
    if (task.sidecars?.mokuro) {
      const pulled = await pullMokuroEntry(provider, task.archiveStem, task.sidecars.mokuro);
      if (!pulled) return undefined;
      entry = pulled;
      if (isArchiveSize(task.archiveFile.size)) entry.archive_size = task.archiveFile.size;
      // The mokuro stamp is the SAME captured `sidecarFile` object
      // `pullMokuroEntry` just downloaded from — never a fresh lookup — so the
      // stamp always describes exactly the bytes that were pulled.
      const mokuroStamp = stampFromSidecarFiles(task.sidecars);
      if (mokuroStamp.mokuro_size !== undefined) entry.mokuro_size = mokuroStamp.mokuro_size;
      if (mokuroStamp.mokuro_modified !== undefined) {
        entry.mokuro_modified = mokuroStamp.mokuro_modified;
      }
    } else {
      entry = buildNoMetadataEntry(folderTitle, task.archiveStem, task.archiveFile);
    }
  } else if (task.existingEntry) {
    // Cover-only refresh: the mokuro side is already fresh, so it is carried
    // through untouched and only the cover stamp below is allowed to move.
    entry = { ...task.existingEntry };
  } else {
    // Cover-stale with nothing published and no mokuro pull queued cannot
    // happen (see `planBackfillTasks`), but fail closed rather than publish a
    // synthesized entry if it ever does.
    return undefined;
  }

  if (task.sidecars?.cover) {
    const stamp = stampFromSidecarFiles(task.sidecars);
    if (stamp.cover_size !== undefined) entry.cover_size = stamp.cover_size;
    if (stamp.cover_modified !== undefined) entry.cover_modified = stamp.cover_modified;
  }

  // Rebuild in the pinned wire order — the fields above may have landed in
  // any order depending on which branch ran (a cover-only refresh, for one,
  // patches cover_* onto a copy that may already carry a trailing `offset`).
  return orderVolumeEntryFields(entry);
}

/**
 * Decide, per cloud archive, whether it needs a (re)built entry — the
 * gap-OR-stale rule. Pure over one listing snapshot plus the existing
 * published index; touches NEITHER the network NOR `db.volumes` (the local
 * installed-volume exclusion is a SEPARATE, later filter — see
 * `excludeInstalledCandidates` — specifically so a fully-converged series
 * never pays for a table scan just to learn it has nothing to do).
 */
function planCandidateArchives(
  archives: CloudFileMetadata[],
  existingByTitle: Map<string, SeriesFileVolume>,
  sidecarGroups: Map<string, SeriesSidecarFiles>
): BackfillTask[] {
  const candidates: BackfillTask[] = [];

  for (const archiveFile of archives) {
    const archiveStem = archiveStemOf(archiveFile.path);
    const titleKey = normalizeVolumeTitleKey(archiveStem);
    if (!titleKey) continue;

    const sidecars = sidecarGroups.get(titleKey);
    const existingEntry = existingByTitle.get(titleKey);
    const stamp = stampFromSidecarFiles(sidecars);

    const needsMokuroPull =
      !existingEntry ||
      isSidecarStale(
        { size: existingEntry.mokuro_size, modified: existingEntry.mokuro_modified },
        sidecars?.mokuro ? { size: stamp.mokuro_size, modified: stamp.mokuro_modified } : undefined
      );

    const needsCoverRefetch =
      !!existingEntry &&
      isSidecarStale(
        { size: existingEntry.cover_size, modified: existingEntry.cover_modified },
        sidecars?.cover ? { size: stamp.cover_size, modified: stamp.cover_modified } : undefined
      );

    if (!needsMokuroPull && !needsCoverRefetch) continue;
    candidates.push({
      archiveStem,
      titleKey,
      archiveFile,
      sidecars,
      needsMokuroPull,
      needsCoverRefetch,
      existingEntry
    });
  }

  return candidates;
}

/**
 * The local half of the exclusion: an archive whose folded title matches a
 * LOCALLY INSTALLED volume of this series is dropped, pull included — an
 * installed row always wins the final rank (see `buildSeriesFile`), so
 * pulling its sidecar here would only be wasted bandwidth. Requires a
 * `db.volumes` scan, so it is applied AFTER `planCandidateArchives` finds at
 * least one real candidate, never before — that ordering is what keeps a
 * converged sweep from touching the volumes table at all.
 */
function excludeInstalledCandidates(
  candidates: BackfillTask[],
  installedTitleKeys: Set<string>
): BackfillTask[] {
  return candidates.filter((task) => !installedTitleKeys.has(task.titleKey));
}

/**
 * Overwrite a materialized/metadata-only row's cover from a stale cover
 * sidecar. Never touches an installed row — its thumbnail was measured from
 * its own pages, not a cloud guess.
 *
 * `fetchCloudThumbnail` is a network fetch that can take up to 15s
 * (`FETCH_TIMEOUT_MS`), during which a download can finish and INSTALL the
 * volume with a thumbnail measured from its own pages. The snapshot read
 * above is that old by the time the network answers, so the actual write
 * routes through `cover-persist.ts`'s shared queue (`installCover`, `mode:
 * 'overwrite'` — this row already HAS a thumbnail, which is the entire
 * premise of "stale"), whose flush re-reads and re-tests the row inside its
 * own write transaction — the same guard every other cover path relies on.
 * Flushed immediately (not left to the debounce) since this runs inside
 * an already-async backfill pass, not a UI burst — see `flushPendingCoverPersists`.
 *
 * Also RESTAMPS the row from `cover` — the same listing record the fetch was
 * made against — with `cover_size`/`cover_modified`, mirroring
 * `cover-service.ts`'s catalog-card path. This is what lets a FUTURE pass
 * (here, or a row-level check elsewhere) decide staleness from the row alone
 * without guessing, whichever path most recently touched it.
 *
 * `archivePath` is the ARCHIVE's own cloud path from the listing this refresh
 * was planned against — the volume's CACHE IDENTITY, and a required argument
 * rather than an optional nicety. A row this device has no RELATIONSHIP with
 * (nothing installed, nothing read) cannot carry a blob at all under
 * `cover-persist.ts`'s routing rule, and such a row is the ordinary outcome of
 * merely OPENING a cloud series (`materializeSeriesVolumes` mints it, and
 * `cover-install.ts` routes its cover into `cloud_covers` rather than onto it).
 * Handing `installCover` a bare uuid gives that cover no `cloud_covers`
 * identity either, so the fetch is made and then silently DROPPED — the exact
 * "stale cover never refreshes" dead end this argument exists to close.
 */
async function refreshStaleCover(
  providerType: SyncProvider['type'],
  volumeUuid: string,
  cover: CloudFileMetadata,
  archivePath: string | undefined
): Promise<void> {
  const row = (await db.volumes.get(volumeUuid)) as VolumeMetadata | undefined;
  if (!row || !needsDownload(row)) return;

  const result = await fetchCloudThumbnail({
    ...row,
    cloudProvider: providerType,
    cloudThumbnailFileId: cover.fileId,
    cloudThumbnailPath: cover.path
  });
  if (!result) return;

  installCover(
    // The listing's archive path wins over anything decorated onto the stored
    // row: it is the same key `catalog/index.ts` reads a cached cover back
    // under (`cloudFieldsForRemovedVolume` → `normalizeCachePath(cloudPath)`).
    { volume_uuid: volumeUuid, cloudPath: archivePath ?? row.cloudPath },
    result,
    { size: cover.size, modifiedTime: cover.modifiedTime },
    'overwrite'
  );
  await flushPendingCoverPersists();
}

/**
 * Row-level cover staleness: an archive whose folded title has a LOCAL
 * metadata-only row WITH a thumbnail, whose own recorded `cover_size`/
 * `cover_modified` stamp is stale against the CURRENT listing. Independent of
 * whether the series.json ENTRY's own cover stamp is stale — the row is what
 * a catalog card actually reads from, and its stamp may have been set by a
 * completely different path (`cover-persist.ts`'s catalog-card commit,
 * `cover-install.ts`'s initial fill, or an earlier run of this very function)
 * than whatever wrote the published entry.
 *
 * Deliberately only checked here, piggybacking on an EXPENSIVE phase some
 * other archive in this series already earned (a genuine mokuro gap/staleness
 * elsewhere) — never a reason on its own to enter it. A row-only-stale cover
 * with nothing else to do in the series would go unnoticed until the next
 * pass that DOES have a reason to scan; the alternative (scanning `db.volumes`
 * for cover staleness alone) would reintroduce exactly the per-series
 * always-scan cost the write-slot fix (round 1) removed. Same stampless
 * exemption as everywhere else: a thumbnail with no recorded stamp (measured
 * from the volume's own pages, or installed by older code) is never forced
 * stale.
 */
function findStaleRowCovers(
  allVolumes: VolumeMetadata[],
  localKey: string,
  sidecarGroups: Map<string, SeriesSidecarFiles>,
  archives: CloudFileMetadata[]
): CoverRefresh[] {
  // The archive each row's cover would be cached under, folded by the same
  // volume-title key everything else in this pass joins on.
  const archiveByTitleKey = new Map<string, CloudFileMetadata>();
  for (const archiveFile of archives) {
    const key = normalizeVolumeTitleKey(archiveStemOf(archiveFile.path));
    if (key && !archiveByTitleKey.has(key)) archiveByTitleKey.set(key, archiveFile);
  }

  const stale: CoverRefresh[] = [];
  for (const row of allVolumes) {
    if (normalizeVolumeTitleKey(row.series_title) !== localKey) continue;
    if (!needsDownload(row) || !row.thumbnail) continue;

    const titleKey = normalizeVolumeTitleKey(row.volume_title);
    const sidecars = sidecarGroups.get(titleKey);
    if (!sidecars?.cover) continue;

    const stamp = stampFromSidecarFiles(sidecars);
    const isStale = isSidecarStale(
      { size: row.cover_size, modified: row.cover_modified },
      { size: stamp.cover_size, modified: stamp.cover_modified }
    );
    if (isStale) {
      stale.push({
        volumeUuid: row.volume_uuid,
        cover: sidecars.cover,
        archivePath: archiveByTitleKey.get(titleKey)?.path
      });
    }
  }
  return stale;
}

/**
 * Heal-by-overwrite: schedule a `series.json` write when the published copy
 * MATERIALLY differs from what this device would build — the write-side
 * counterpart of the read-side healing that has existed all along
 * (`parseSeriesFile` collapses doubles, `buildSeriesFile`'s winner rules
 * replace 0/0 entries), which produced healed content that nothing ever
 * published.
 *
 * THE RATCHET this closes (user-reported, confirmed against the code paths):
 * cover resolution for a BARE placeholder takes decision-tree case 3
 * (`cover-service.ts`), which measures the volume and schedules a series.json
 * write — but covers are only requested for what a catalog card actually
 * shows (the top volume, or the top few in stack mode). So the FIRST write
 * for a browsed series publishes volume 1 measured and volumes 2..N as 0/0
 * no-metadata entries — and that write is a ratchet: once `series.json`
 * exists, every later placeholder is INDEXED, cover resolution takes case 2
 * (direct sidecar fetch — no measurement, no write), and the 0/0 entries
 * lock themselves in permanently. Installing the volumes did not help either
 * (nothing scheduled a write on install — fixed alongside this, in
 * `download-queue.ts` / `import-service.ts`), and this seam is what repairs
 * the files that ratchet already damaged: the next read cycle that flows
 * through `runBackfill` (series open, or the reconcile sweep) notices the
 * material difference and publishes the healed content once.
 *
 * ONE seam on purpose: every read+build cycle outside the write path already
 * funnels through `runBackfill`, so the difference check exists exactly here
 * — no new whole-listing sweep, no second predicate to drift. The decision
 * costs no network: `existing` is the copy `refreshSeriesIndexForSeries`
 * (stamp-gated) returned moments ago, and `previewSeriesFileBuild` reads only
 * the local tables and the already-fetched listing cache.
 *
 * The LOCAL read cost is NOT a flat handful of reads per folder, though:
 * `previewSeriesFileBuild`, and (when `raw_entry_collapse` is the only
 * candidate term) {@link hasLocalVolumeStanding} below, both go through
 * `volumesForFoldedSeriesTitle`, whose `orderBy('series_title').uniqueKeys()`
 * walks every DISTINCT local series title on each call (see that function's
 * own doc) — index-only, never a row, but not O(1) either. Swept across a
 * whole reconcile pass (`runReconcile` calls this seam once per
 * sidecar-bearing cloud folder) the true shape is O(folders × distinct local
 * series titles) index-only reads, not O(folders). No cheap prefilter was
 * added to cut that down on purpose: every necessary-condition set analyzed
 * while building this seam either missed a material case (rename-shaped
 * collapses, additions) or duplicated the predicate outright — a missed case
 * is a heal lost silently, which is the bug the seam exists to fix. A future
 * optimizer narrowing this should know that ground was already covered, not
 * re-walk it from scratch.
 *
 * Two triggers, both run through the SAME preview this function fetches once
 * — no bypass, no second read path:
 *
 * - {@link seriesFileHealDifference} over (published, preview build): the
 *   material terms — collapse, 0/0 superseded by measured, inherited-field
 *   enrichment, listing-backed addition — and nothing else; see its doc for
 *   why uuid tie flips, value drift, prunes and local-only additions are
 *   deliberately NOT material (each would ping-pong two live devices).
 * - `raw_entry_collapse` on the cached record, checked only when the above
 *   found nothing: the published BYTES still hold doubled entries that
 *   read-time healing collapsed — invisible in any parsed copy, so
 *   `existing` here already looks clean and `seriesFileHealDifference` can
 *   never see it (the parse sites persist the fact separately, see
 *   `SeriesIndexRecord.raw_entry_collapse`). Gated on
 *   {@link hasLocalVolumeStanding}: earlier this fired unconditionally and
 *   was the one MEDIUM bug in the seam's first review — a folder this device
 *   has no local rows for still gets swept every reconcile pass (every
 *   sidecar-bearing cloud folder, not just this device's own, see
 *   `runReconcile`), so an unconditional flag would schedule a write EVERY
 *   pass, `performWrite`'s own publishability gate (`hasBackedUpVolume` /
 *   `hasPublishableFacts` in `series-file-sync.ts`) would drop it every time,
 *   and the flag — true about a file this device cannot fix — would never
 *   clear: scheduled, dropped, rescheduled, forever. Exactly the shape
 *   `locallyKnownSeriesKeys` exists to prevent on the OTHER trigger
 *   (missing-sidecar candidates). A foreign folder now fails the standing
 *   check and never schedules; the flag persists harmlessly on the cached
 *   record until a device WITH standing reads the file and heals it —
 *   converging the same way, because a successful write re-stamps the record
 *   WITHOUT the flag.
 *
 * The write itself goes through `scheduleSeriesFileWrite`: the same 2 s
 * per-series debounce (so this coalesces with install-triggered schedules for
 * the same folder), the same fire-time gates, the same shared write slots —
 * and NO options: no `fromCloudListing` (no listing was fetched to back this
 * schedule — the write pays the ordinary TTL-coalesced refresh, usually free
 * right after the reconcile pass's own fetch), and no `cloudMeasuredVolumes`
 * (the write rebuilds from local rows and the listing's own stamps, so a
 * heal-write can never publish provisional stamps).
 *
 * Callers gate on `hasWritableNonServerProvider()` (runBackfill's first
 * line); the belt here keeps the seam safe if it ever grows another caller —
 * a read-only browser of a shared library, or a server that compiles
 * series.json itself, must never fire heal-writes.
 *
 * Returns whether a write was scheduled (for tests). Never throws.
 */
export async function maybeScheduleSeriesHealWrite(
  folderTitle: string,
  existing: SeriesFile
): Promise<boolean> {
  try {
    if (!hasWritableNonServerProvider()) return false;

    const preview = await unifiedCloudManager.previewSeriesFileBuild(folderTitle, existing);
    if (!preview?.built) return false;

    let material = seriesFileHealDifference(existing, preview.built, preview.cloudTitleKeys);

    if (!material) {
      const record = await getSeriesIndex(normalizeSeriesKey(folderTitle));
      if (record?.raw_entry_collapse === true) {
        material = await hasLocalVolumeStanding(folderTitle, preview.cloudTitleKeys);
      }
    }
    if (!material) return false;

    scheduleSeriesFileWrite(folderTitle);
    return true;
  } catch (error) {
    console.debug(`[series-backfill] heal check for '${folderTitle}' failed:`, error);
    return false;
  }
}

/**
 * Does this device hold a local VOLUME row for `folderTitle` — a
 * non-placeholder row whose title the cloud listing still shows (the same
 * `cloudTitleKeys` the preview just computed, so this costs no extra listing
 * read). Function-body use only, mirroring (not importing — series-file-sync
 * keeps `hasBackedUpVolume` private, and the existing series-file-sync ↔
 * series-backfill cycle stays a `scheduleSeriesFileWrite`-only import) the
 * row half of `performWrite`'s own publishability gate.
 *
 * The ONE thing `raw_entry_collapse` needs that the seam's other three
 * material terms get for free: they can never fire without genuine local
 * content (SUPERSEDE/ENRICHMENT need an installed row, LISTING-BACKED
 * ADDITION needs a local-only entry), so a foreign folder's preview build
 * naturally reproduces `existing` and nothing trips. The raw-doubles flag has
 * no such built-in gate — it is a fact about the CLOUD FILE, not about this
 * device's build — so without this check it would fire for every folder the
 * reconcile sweep touches, foreign or not (see the seam doc above for the
 * eternal-reschedule shape that produces).
 *
 * Deliberately NOT `hasPublishableFacts`: a series linked purely by facts,
 * with zero local volume rows, WOULD pass `performWrite`'s own gate and
 * COULD heal a doubled file it holds no volumes for (the write republishes
 * `existing`'s already-healed volumes regardless of local content) — but
 * this narrower row-only check declines it too. A real residual, left for a
 * device that actually holds a row, matching the scope of the tests this
 * check shipped with.
 */
async function hasLocalVolumeStanding(
  folderTitle: string,
  cloudTitleKeys: Set<string>
): Promise<boolean> {
  const localKey = normalizeVolumeTitleKey(folderTitle);
  const rows = await volumesForFoldedSeriesTitle(folderTitle, normalizeVolumeTitleKey);
  return rows.some(
    (row) =>
      !row.isPlaceholder &&
      normalizeVolumeTitleKey(row.series_title) === localKey &&
      cloudTitleKeys.has(normalizeVolumeTitleKey(row.volume_title))
  );
}

async function runBackfill(seriesTitle: string, requireExisting: boolean): Promise<void> {
  if (!hasWritableNonServerProvider()) return;

  const provider = unifiedCloudManager.getActiveProvider();
  if (!provider) return;

  // ---- CHEAP phase: listing + cached index only, no `db.volumes` scan. ----
  const folderTitle = unifiedCloudManager.resolveCloudFolderTitle(seriesTitle);
  const folderFiles = unifiedCloudManager.getCloudVolumesBySeries(folderTitle);
  const archives = folderFiles.filter((file) => isCbzFile(basename(file.path)));
  if (archives.length === 0) return;

  const existing = await unifiedCloudManager.refreshSeriesIndexForSeries(folderTitle);
  if (!existing && requireExisting) return;

  const existingByTitle = new Map<string, SeriesFileVolume>();
  for (const entry of existing?.volumes ?? []) {
    existingByTitle.set(normalizeVolumeTitleKey(entry.volume_title), entry);
  }

  const sidecarGroups = groupSeriesSidecarFiles(folderFiles);
  const candidates = planCandidateArchives(archives, existingByTitle, sidecarGroups);
  // Zero gaps and nothing stale BY THE SIDECAR RULES — which is exactly where
  // the published file can still be materially wrong: a 0/0 no-metadata entry
  // is stampless, and stampless is never stale, so the volumes the user has
  // since INSTALLED never become pull candidates (the install measured them
  // right here; pulling would be waste). The heal seam is what publishes what
  // this device already knows. It reads local tables and the cached listing
  // only — still zero downloads for a genuinely converged series.
  if (candidates.length === 0) {
    if (existing) await maybeScheduleSeriesHealWrite(folderTitle, existing);
    return;
  }

  // ---- EXPENSIVE phase: indexed row read, pulls, write — capped at
  // BACKFILL_PASS_CONCURRENCY across every series in flight. ----
  await acquireBackfillSlot();
  try {
    const localKey = normalizeVolumeTitleKey(folderTitle);
    // Indexed, not a table scan: `volumesForFoldedSeriesTitle` answers off
    // `series_title`'s index, so a series with no local rows costs one
    // index-only read instead of the whole table.
    const allVolumes = await volumesForFoldedSeriesTitle(folderTitle, normalizeVolumeTitleKey);
    const installedTitleKeys = new Set(
      allVolumes
        .filter((v) => normalizeVolumeTitleKey(v.series_title) === localKey && isVolumeInstalled(v))
        .map((v) => normalizeVolumeTitleKey(v.volume_title))
    );

    const tasks = excludeInstalledCandidates(candidates, installedTitleKeys);
    // Row-level cover staleness piggybacks on this scan (see
    // `findStaleRowCovers`'s own doc for why it is not a trigger on its own).
    const coverRefreshes = findStaleRowCovers(allVolumes, localKey, sidecarGroups, archives);

    const builtEntries: SeriesFileVolume[] = [];
    if (tasks.length > 0) {
      let next = 0;
      const worker = async () => {
        while (next < tasks.length) {
          const task = tasks[next++];
          try {
            const entry = await buildEntryForTask(folderTitle, task, provider);
            if (!entry) continue;
            builtEntries.push(entry);
            if (task.needsCoverRefetch && task.sidecars?.cover) {
              coverRefreshes.push({
                volumeUuid: entry.volume_uuid,
                cover: task.sidecars.cover,
                archivePath: task.archiveFile.path
              });
            }
          } catch (error) {
            // A malformed/unreadable sidecar costs this ONE volume, never the
            // series or the rest of the queue.
            console.debug(
              `[series-backfill] skipping '${task.archiveStem}' in '${folderTitle}':`,
              error
            );
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(PULL_CONCURRENCY, tasks.length) }, () => worker())
      );
    }

    if (builtEntries.length > 0) {
      let result: 'written' | 'skipped' | 'read-only';
      // The SAME shared pool the debounced fact-edit writer uses (`write-slot.ts`),
      // so a burst of backfill publishes and a burst of ordinary debounced
      // writes share one PUT budget rather than two independent ones.
      await acquireWriteSlot();
      try {
        result = await unifiedCloudManager.writeSeriesFile(folderTitle, {
          cloudMeasuredVolumes: builtEntries
        });
      } finally {
        releaseWriteSlot();
      }

      if (result === 'written') {
        // Flesh the series out locally with the same pipeline `openSeries`
        // uses: materialize the completed entries into metadata-only rows
        // (real uuids, from the entries just built) and install their covers
        // from the cloud sidecars. Cheap when there is nothing to do — both
        // are no-ops for rows that already have what they need.
        const fresh = await unifiedCloudManager.refreshSeriesIndexForSeries(folderTitle);
        if (fresh) {
          const cloudVolumeTitles = unifiedCloudManager.cloudVolumeTitlesFor(folderTitle);
          await materializeSeriesVolumes({
            seriesTitle: folderTitle,
            entries: fresh.volumes,
            cloudVolumeTitles
          });
        }
        await installCoversForSeries(folderTitle);
      }
    } else if (existing) {
      // Every candidate was excluded (each matched a LOCALLY INSTALLED volume,
      // whose sidecar is never pulled) or failed to build — so no write is
      // coming from this pass, and the published gaps those installed volumes
      // could fill stay unpublished. Same heal seam as the no-candidates exit:
      // the preview build carries the installed rows, and the material check
      // decides whether their claims are worth one write.
      await maybeScheduleSeriesHealWrite(folderTitle, existing);
    }

    // `installCoversForSeries` only fills a BLANK cover; a row that already
    // had one (freshly materialized above, OR a pre-existing row with a
    // stale cover `findStaleRowCovers` found) needs an explicit refetch to
    // pick up a changed cover sidecar. Deduped by uuid: an entry-driven and a
    // row-driven refresh can legitimately name the same volume.
    const refreshedUuids = new Set<string>();
    for (const { volumeUuid, cover, archivePath } of coverRefreshes) {
      if (refreshedUuids.has(volumeUuid)) continue;
      refreshedUuids.add(volumeUuid);
      try {
        await refreshStaleCover(provider.type, volumeUuid, cover, archivePath);
      } catch (error) {
        console.debug(`[series-backfill] could not refresh cover for '${volumeUuid}':`, error);
      }
    }
  } finally {
    releaseBackfillSlot();
  }
}

function schedule(seriesTitle: string, requireExisting: boolean): Promise<void> {
  const key = normalizeSeriesKey(seriesTitle);
  if (!key) return Promise.resolve();

  const running = inFlight.get(key);
  if (running) return running;

  const run = runBackfill(seriesTitle, requireExisting).catch((error) => {
    console.debug(`[series-backfill] pass over '${seriesTitle}' failed:`, error);
  });

  inFlight.set(key, run);
  void run.finally(() => {
    if (inFlight.get(key) === run) inFlight.delete(key);
  });
  return run;
}

/**
 * The ordinary trigger: series open, and the reconcile pass for every folder
 * the listing shows a `series.json` in already. Requires that file to be
 * readable — a bare folder nobody linked or backed up is never swept. Never
 * throws.
 */
export function backfillSeriesEntries(seriesTitle: string): Promise<void> {
  return schedule(seriesTitle, true);
}

/**
 * The link-event trigger: a facts edit just made `series.json` publishable
 * for a series this device has nothing local for. The file may not exist in
 * the cloud yet — its facts-only write is still debouncing — so this variant
 * treats "facts just became publishable" as equivalent to "has a series.json"
 * and proceeds even when the listing shows none yet. Callers are responsible
 * for the `hasPublishableFacts` gate itself; every OTHER gate (writable
 * provider, not server-compiled) is still enforced here. Never throws.
 */
export function backfillNewlyLinkedSeries(seriesTitle: string): Promise<void> {
  return schedule(seriesTitle, false);
}

/** Test hook: forget in-flight backfill passes and the pass-concurrency bookkeeping. */
export function _resetSeriesBackfillForTests(): void {
  inFlight.clear();
  activeBackfillPasses = 0;
  waitingBackfillPasses.length = 0;
}
