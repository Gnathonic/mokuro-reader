import { get } from 'svelte/store';
import { db } from '$lib/catalog/db';
import { installCoversForSeries } from '$lib/catalog/cover-install';
import { fetchCloudThumbnail } from '$lib/catalog/cloud-thumbnails';
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
import { isArchiveSize, orderVolumeEntryFields, type SeriesFileVolume } from './series-file';
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
 *   work (the `db.volumes.toArray()` scan, the sidecar pulls, the write) run
 *   at once — module-local to this file, since it is specifically the
 *   backfill's own fan-out that needs bounding. A CONVERGED series never
 *   touches this budget at all: the cheap listing-only candidate check runs
 *   first and returns immediately when there is nothing to do, so a sweep
 *   over N already-converged folders costs N cache reads, not N queued slots.
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

function acquireBackfillSlot(): Promise<void> {
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

function releaseBackfillSlot(): void {
  activeBackfillPasses -= 1;
  waitingBackfillPasses.shift()?.();
}

/** series_key → the pass currently running for it. */
const inFlight = new Map<string, Promise<void>>();

/** A connected, writable provider that does not compile `series.json` itself. */
function hasWritableNonServerProvider(): boolean {
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

/** Zero-count entry for an archive with no sidecar at all — the image-only convention `volumeToIndexEntry` gives an installed image-only volume. */
function buildImageOnlyEntry(
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
 */
async function pullMokuroEntry(
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
      entry = buildImageOnlyEntry(folderTitle, task.archiveStem, task.archiveFile);
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
 * above is that old by the time the network answers, so — same pattern
 * `runCoverInstall` documents in `cover-install.ts` — the row is re-read and
 * re-tested INSIDE the transaction that performs the write, and the write is
 * skipped if it no longer needs one.
 */
async function refreshStaleCover(
  providerType: SyncProvider['type'],
  volumeUuid: string,
  cover: CloudFileMetadata
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

  await db.transaction('rw', db.volumes, async () => {
    const fresh = (await db.volumes.get(volumeUuid)) as VolumeMetadata | undefined;
    if (!fresh || !needsDownload(fresh)) return;
    await db.volumes.update(volumeUuid, {
      thumbnail: result.file,
      thumbnail_width: result.width,
      thumbnail_height: result.height
    });
  });
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
  // Zero gaps and nothing stale: not even a `db.volumes` scan was needed,
  // let alone the backfill-pass slot, a download, or a write. This is what
  // keeps a reconcile sweep over a library that is mostly already converged
  // from costing anything beyond the listing it already had in hand.
  if (candidates.length === 0) return;

  // ---- EXPENSIVE phase: table scan, pulls, write — capped at
  // BACKFILL_PASS_CONCURRENCY across every series in flight. ----
  await acquireBackfillSlot();
  try {
    const localKey = normalizeVolumeTitleKey(folderTitle);
    const allVolumes = (await db.volumes.toArray()) as VolumeMetadata[];
    const installedTitleKeys = new Set(
      allVolumes
        .filter((v) => normalizeVolumeTitleKey(v.series_title) === localKey && isVolumeInstalled(v))
        .map((v) => normalizeVolumeTitleKey(v.volume_title))
    );

    const tasks = excludeInstalledCandidates(candidates, installedTitleKeys);
    if (tasks.length === 0) return;

    const builtEntries: SeriesFileVolume[] = [];
    const coverRefreshes: Array<{ volumeUuid: string; cover: CloudFileMetadata }> = [];

    let next = 0;
    const worker = async () => {
      while (next < tasks.length) {
        const task = tasks[next++];
        try {
          const entry = await buildEntryForTask(folderTitle, task, provider);
          if (!entry) continue;
          builtEntries.push(entry);
          if (task.needsCoverRefetch && task.sidecars?.cover) {
            coverRefreshes.push({ volumeUuid: entry.volume_uuid, cover: task.sidecars.cover });
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

    if (builtEntries.length === 0) return;

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
    if (result !== 'written') return;

    // Flesh the series out locally with the same pipeline `openSeries` uses:
    // materialize the completed entries into metadata-only rows (real uuids,
    // from the entries just built) and install their covers from the cloud
    // sidecars. Cheap when there is nothing to do — both are no-ops for rows
    // that already have what they need.
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

    // `installCoversForSeries` only fills a BLANK cover; a row that already
    // had one (materialized by an earlier pass) needs an explicit refetch to
    // pick up a changed cover sidecar.
    for (const { volumeUuid, cover } of coverRefreshes) {
      try {
        await refreshStaleCover(provider.type, volumeUuid, cover);
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
