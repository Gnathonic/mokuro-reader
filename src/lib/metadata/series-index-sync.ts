import type { CloudFileMetadata, SyncProvider } from '$lib/util/sync/provider-interface';
import { providerManager } from '$lib/util/sync/provider-manager';
import {
  deleteSeriesIndex,
  indexNeedsRefresh,
  listSeriesIndexes,
  putSeriesIndex,
  type SeriesIndexRecord
} from './series-index';
import { isSeriesFilePath, parseSeriesFile, type SeriesFile } from './series-file';
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
 *   ping-pong into an upload (see `series-file-sync.ts`).
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

/** Download + validate one sidecar, then cache it and apply its facts. */
async function refreshOne(provider: SyncProvider, task: RefreshTask): Promise<void> {
  let parsed: SeriesFile | undefined;
  try {
    const blob = await provider.downloadFile(task.sidecar);
    parsed = parseSeriesFile(JSON.parse(await blob.text()));
  } catch (error) {
    console.warn(`[series-index-sync] could not read '${task.sidecar.path}':`, error);
    return;
  }

  if (!parsed) {
    // Not a series.json we understand (hand-edited, truncated, future version).
    // Dropping it leaves the previous cached copy in place, which is still the
    // best thing this device knows.
    console.warn(`[series-index-sync] ignoring an invalid series.json at '${task.sidecar.path}'`);
    return;
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
    fetched_at: new Date().toISOString()
  };

  try {
    await putSeriesIndex(record);
    // Facts only, strictly-newer, and never a write trigger.
    await upsertFromSeriesFile(task.title, parsed);
  } catch (error) {
    console.warn(`[series-index-sync] could not store the index for '${task.title}':`, error);
  }
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

async function runRefresh(cloudFilesMap: Map<string, CloudFileMetadata[]>): Promise<void> {
  // An empty listing means "not fetched" as often as it means "empty cloud"
  // (a provider fetch failure logs and leaves the cache untouched). Cleaning up
  // against it would wipe every cached index on a flaky launch.
  if (cloudFilesMap.size === 0) return;

  const provider = providerManager.getActiveProvider();
  if (!provider) return;

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
    if (!indexNeedsRefresh(cachedByKey.get(key), stamp)) continue;
    tasks.push({ key, title: folder.title, sidecar, stamp });
  }

  await runPool(tasks, MAX_CONCURRENT_INDEX_DOWNLOADS, (task) => refreshOne(provider, task));
}

/** The run currently in flight, or `null`. */
let inFlight: Promise<void> | null = null;
/** The newest listing that arrived while a run was in flight. */
let queued: Map<string, CloudFileMetadata[]> | null = null;

/**
 * Refresh the cached `series.json` indexes for a cloud listing.
 *
 * Never rejects. Calls that arrive while a run is in flight do not start a
 * second one: the newest listing is queued and replayed once when the current
 * run finishes, so a burst of listings costs at most one extra pass. The
 * returned promise resolves when the whole chain (including a queued replay)
 * is done, which is what tests await; callers in the app fire and forget.
 */
export function refreshSeriesIndexes(
  cloudFilesMap: Map<string, CloudFileMetadata[]>
): Promise<void> {
  if (inFlight) {
    queued = cloudFilesMap;
    return inFlight;
  }

  inFlight = (async () => {
    try {
      let current: Map<string, CloudFileMetadata[]> | null = cloudFilesMap;
      while (current) {
        try {
          await runRefresh(current);
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
