import type {
  CloudFileMetadata,
  ProviderType,
  SyncProvider
} from '$lib/util/sync/provider-interface';
import { providerManager } from '$lib/util/sync/provider-manager';
import {
  deleteSeriesIndex,
  indexNeedsRefresh,
  listSeriesIndexes,
  putSeriesIndexes,
  type SeriesIndexRecord
} from './series-index';
import { isSeriesFilePath, parseSeriesFileWithReport, type SeriesFile } from './series-file';
import { normalizeSeriesKey } from './series-key';
import { upsertFromSeriesFile } from './store';

/**
 * The read half of the `series.json` index: after every cloud listing, re-read
 * the sidecars that actually changed and drop the ones whose folder is gone.
 *
 * It is a cache refresh, so it is deliberately timid:
 *
 * - Only folders that hold at least one `.cbz` count. An orphan `series.json`
 *   (a folder whose volumes were deleted, or a hand-made one) must never create
 *   a `series_metadata` record or an index for a series with no volumes — that
 *   would resurrect a deleted series in the catalog on every device.
 * - Only files whose (`size`, `modifiedTime`) differ from the cached record are
 *   downloaded, capped at 4 at a time, so a 300-series library costs one listing
 *   and zero downloads on a normal launch.
 * - Everything is best-effort: a bad file is dropped with one warning, a failed
 *   download is skipped, and the whole run never rejects. It runs behind a
 *   reading flow and must never surface there.
 * - Facts go through `upsertFromSeriesFile`, which applies only strictly newer
 *   facts and never schedules a `series.json` write — so a refresh can never
 *   ping-pong into an upload (see `series-file-sync.ts`). The shelf alignment in
 *   the file is not applied to the record at all: the cached record IS how it
 *   reaches the catalog (`getSpineOffsets` joins it at display time).
 * - A run is BOUND to the provider whose listing produced it. Between the fetch
 *   and the (background, possibly queued) run the user can switch accounts, and
 *   the listing's file ids, paths and folder set all belong to the old one:
 *   downloading or cleaning up against the new provider would be nonsense.
 * - All refreshed records are written in ONE `putSeriesIndexes`: the table feeds
 *   a liveQuery the catalog joins, so a write per folder would rebuild the
 *   placeholder set N times for a single listing.
 */

/** Downloads in flight at once. Bounded so a big library cannot flood a provider. */
export const MAX_CONCURRENT_INDEX_DOWNLOADS = 4;

function normalizeCloudPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

interface FolderListing {
  /** The folder name — the stored `series_title`, never derived from content. */
  title: string;
  hasArchive: boolean;
  sidecar?: CloudFileMetadata;
}

/**
 * Group a listing into `<Series>/…` folders, noting whether each holds a `.cbz`
 * and which `series.json` (the newest, when a provider's overwrite leaves more
 * than one cached) belongs to it. Only files exactly one level deep count: a
 * `series.json` nested deeper is not this folder's sidecar.
 */
function collectFolders(
  cloudFilesMap: Map<string, CloudFileMetadata[]>
): Map<string, FolderListing> {
  const folders = new Map<string, FolderListing>();

  for (const files of cloudFilesMap.values()) {
    for (const file of files) {
      const parts = normalizeCloudPath(file.path).split('/');
      if (parts.length !== 2) continue;

      const title = parts[0];
      const key = normalizeSeriesKey(title);
      if (!key) continue;

      let folder = folders.get(key);
      if (!folder) {
        folder = { title, hasArchive: false };
        folders.set(key, folder);
      }

      if (isSeriesFilePath(file.path)) {
        if (
          !folder.sidecar ||
          (file.modifiedTime ?? '') > (folder.sidecar.modifiedTime ?? '') // newest wins
        ) {
          folder.sidecar = file;
        }
      } else if (parts[1].toLowerCase().endsWith('.cbz')) {
        folder.hasArchive = true;
      }
    }
  }

  return folders;
}

/** A folder whose index is worth having: real volumes AND a sidecar to read. */
function isIndexable(folder: FolderListing | undefined): boolean {
  return !!folder?.sidecar && folder.hasArchive;
}

interface RefreshTask {
  key: string;
  title: string;
  sidecar: CloudFileMetadata;
  stamp: { size: number; modifiedTime: string };
}

/**
 * Download + validate one sidecar and apply its facts. Returns the record to
 * cache (the caller writes them all at once) or `undefined` when the file is
 * unusable.
 */
async function refreshOne(
  provider: SyncProvider,
  task: RefreshTask
): Promise<SeriesIndexRecord | undefined> {
  let parsed: SeriesFile | undefined;
  let entryCollapse = false;
  try {
    const blob = await provider.downloadFile(task.sidecar);
    const report = parseSeriesFileWithReport(JSON.parse(await blob.text()));
    parsed = report.file;
    entryCollapse = report.entryCollapse;
  } catch (error) {
    console.warn(`[series-index-sync] could not read '${task.sidecar.path}':`, error);
    return undefined;
  }

  if (!parsed) {
    // Not a series.json we understand (hand-edited, truncated, future version).
    // Dropping it leaves the previous cached copy in place, which is still the
    // best thing this device knows.
    console.warn(`[series-index-sync] ignoring an invalid series.json at '${task.sidecar.path}'`);
    return undefined;
  }

  const record: SeriesIndexRecord = {
    series_key: task.key,
    series_title: task.title,
    file: parsed,
    source: {
      provider: provider.type,
      path: normalizeCloudPath(task.sidecar.path),
      size: task.stamp.size,
      modifiedTime: task.stamp.modifiedTime
    },
    fetched_at: new Date().toISOString(),
    // The raw published bytes still hold the doubles this parse collapsed —
    // recorded so the heal seam can schedule the overwrite that repairs the
    // file (see `SeriesIndexRecord.raw_entry_collapse`). This listing-wide
    // warm-up is often the FIRST reader of a foreign file, so dropping the
    // signal here would lose it for the whole session: every later read is a
    // stamp-gated cache hit.
    ...(entryCollapse ? { raw_entry_collapse: true } : {})
  };

  try {
    // Facts only, strictly-newer only, and never a write trigger. The shelf
    // alignment is deliberately not applied: `record` above is what carries it
    // to the catalog, joined at display time (`getSpineOffsets`), so it stays
    // the publishing device's value rather than becoming ours.
    await upsertFromSeriesFile(task.title, parsed);
  } catch (error) {
    console.warn(`[series-index-sync] could not apply the sidecar for '${task.title}':`, error);
  }

  return record;
}

async function runPool<T>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      await run(items[next++]);
    }
  });
  await Promise.all(workers);
}

async function runRefresh(
  cloudFilesMap: Map<string, CloudFileMetadata[]>,
  providerType: ProviderType
): Promise<void> {
  // An empty listing means "not fetched" as often as it means "empty cloud"
  // (a provider fetch failure logs and leaves the cache untouched). Cleaning up
  // against it would wipe every cached index on a flaky launch.
  if (cloudFilesMap.size === 0) return;

  const provider = providerManager.getActiveProvider();
  // Bound to the provider the listing came from: a switch (or a disconnect)
  // between the fetch and this run invalidates every id and path in it.
  if (!provider || provider.type !== providerType) return;

  const folders = collectFolders(cloudFilesMap);
  const cached = await listSeriesIndexes();
  const cachedByKey = new Map(cached.map((rec) => [rec.series_key, rec]));

  // Cleanup first: a folder that lost its sidecar or its last volume has no
  // index any more. Records fetched from a DIFFERENT provider are left alone —
  // this listing says nothing about that account's folders.
  for (const rec of cached) {
    if (rec.source.provider !== provider.type) continue;
    if (isIndexable(folders.get(rec.series_key))) continue;
    try {
      await deleteSeriesIndex(rec.series_key);
    } catch (error) {
      console.warn(
        `[series-index-sync] could not drop the index for '${rec.series_title}':`,
        error
      );
    }
  }

  const tasks: RefreshTask[] = [];
  for (const [key, folder] of folders) {
    if (!isIndexable(folder)) continue;
    const sidecar = folder.sidecar!;
    const stamp = { size: sidecar.size ?? 0, modifiedTime: sidecar.modifiedTime ?? '' };
    if (!indexNeedsRefresh(cachedByKey.get(key), stamp, provider.type)) continue;
    tasks.push({ key, title: folder.title, sidecar, stamp });
  }

  const refreshed: SeriesIndexRecord[] = [];
  await runPool(tasks, MAX_CONCURRENT_INDEX_DOWNLOADS, async (task) => {
    const record = await refreshOne(provider, task);
    if (record) refreshed.push(record);
  });

  if (refreshed.length === 0) return;
  try {
    await putSeriesIndexes(refreshed);
  } catch (error) {
    console.warn('[series-index-sync] could not store the refreshed indexes:', error);
  }
}

interface RefreshRequest {
  cloudFilesMap: Map<string, CloudFileMetadata[]>;
  /** The provider the listing was captured from. */
  providerType: ProviderType;
}

/** The run currently in flight, or `null`. */
let inFlight: Promise<void> | null = null;
/** The newest request that arrived while a run was in flight. */
let queued: RefreshRequest | null = null;

/**
 * Refresh the cached `series.json` indexes for a cloud listing.
 *
 * `providerType` is the provider the listing was captured from; the run (and a
 * queued replay of it) is dropped if that is no longer the active provider.
 *
 * Never rejects. Calls that arrive while a run is in flight do not start a
 * second one: the newest request is queued and replayed once when the current
 * run finishes, so a burst of listings costs at most one extra pass. The
 * returned promise resolves when the whole chain (including a queued replay)
 * is done, which is what tests await; callers in the app fire and forget.
 */
export function refreshSeriesIndexes(
  cloudFilesMap: Map<string, CloudFileMetadata[]>,
  providerType: ProviderType
): Promise<void> {
  if (inFlight) {
    queued = { cloudFilesMap, providerType };
    return inFlight;
  }

  inFlight = (async () => {
    try {
      let current: RefreshRequest | null = { cloudFilesMap, providerType };
      while (current) {
        try {
          await runRefresh(current.cloudFilesMap, current.providerType);
        } catch (error) {
          console.warn('[series-index-sync] refresh failed:', error);
        }
        current = queued;
        queued = null;
      }
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
