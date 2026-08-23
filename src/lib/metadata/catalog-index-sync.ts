import type {
  CloudFileMetadata,
  ProviderType,
  SyncProvider
} from '$lib/util/sync/provider-interface';
import { providerManager } from '$lib/util/sync/provider-manager';
import {
  catalogNeedsRefresh,
  deleteCatalogIndexes,
  listCatalogIndexes,
  putCatalogIndexes,
  type CatalogIndexRecord
} from './catalog-index';
import {
  catalogEntryToSeriesFile,
  isCatalogFilePath,
  parseCatalogFile,
  type CatalogFile
} from './catalog-file';
import { normalizeSeriesKey } from './series-key';
import { upsertFromSeriesFile } from './store';

/**
 * The read half of the root `catalog.json`: after every cloud listing (catalog
 * open, provider connect, backup run), re-read the file if and only if its
 * size/mtime changed, cache every entry and apply its facts.
 *
 * Deliberately timid, exactly like `series-index-sync.ts`:
 *
 * - ONE download for the whole library, and none at all when the stamp matches,
 *   so a 1k-series library costs one listing and zero downloads on a normal
 *   launch.
 * - Facts go through `upsertFromSeriesFile`, which applies only strictly newer
 *   facts, never creates a record from a factless entry, and never schedules a
 *   write — so a refresh can never ping-pong into an upload.
 * - Everything is best-effort: junk content is dropped with one warning, a
 *   failed download is skipped, and the run never rejects.
 * - A run is BOUND to the provider whose listing produced it: between the fetch
 *   and the (background, possibly queued) run the user can switch accounts.
 * - Cleanup only against a non-empty listing, and only for rows fetched from
 *   THIS provider — an empty listing means "not fetched" as often as it means
 *   "empty cloud".
 * - All rows are written in ONE `putCatalogIndexes`: the table feeds a liveQuery
 *   the catalog joins, so a write per series would rebuild the card set N times.
 */

function normalizeCloudPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

/** The root `catalog.json` of a listing (newest, when a provider's overwrite left two). */
function findCatalogFile(
  cloudFilesMap: Map<string, CloudFileMetadata[]>
): CloudFileMetadata | undefined {
  let newest: CloudFileMetadata | undefined;
  for (const files of cloudFilesMap.values()) {
    for (const file of files) {
      if (!isCatalogFilePath(file.path)) continue;
      if (!newest || (file.modifiedTime ?? '') > (newest.modifiedTime ?? '')) newest = file;
    }
  }
  return newest;
}

async function downloadCatalog(
  provider: SyncProvider,
  file: CloudFileMetadata
): Promise<CatalogFile | undefined> {
  try {
    const blob = await provider.downloadFile(file);
    const parsed = parseCatalogFile(JSON.parse(await blob.text()));
    if (!parsed) {
      // Hand-edited, truncated, a future version, or a proxy error page.
      // Dropping it leaves the previous cached rows in place, which is still the
      // best thing this device knows.
      console.warn(`[catalog-index-sync] ignoring an invalid catalog.json at '${file.path}'`);
    }
    return parsed;
  } catch (error) {
    console.warn(`[catalog-index-sync] could not read '${file.path}':`, error);
    return undefined;
  }
}

async function runRefresh(
  cloudFilesMap: Map<string, CloudFileMetadata[]>,
  providerType: ProviderType
): Promise<void> {
  // An empty listing means "not fetched" as often as it means "empty cloud",
  // so it is never grounds for dropping anything.
  if (cloudFilesMap.size === 0) return;

  const provider = providerManager.getActiveProvider();
  if (!provider || provider.type !== providerType) return;

  const cloudFile = findCatalogFile(cloudFilesMap);
  // No catalog.json at all: a bare share, or a backend that does not publish one.
  // The cached rows (if any) are left alone — this listing says nothing about them.
  if (!cloudFile) return;

  const stamp = { size: cloudFile.size ?? 0, modifiedTime: cloudFile.modifiedTime ?? '' };
  const cached = await listCatalogIndexes();
  if (!catalogNeedsRefresh(cached, stamp, provider.type)) return;

  const parsed = await downloadCatalog(provider, cloudFile);
  if (!parsed) return;
  // A catalog that parses to NOTHING is never authoritative — the same refusal
  // `buildCatalogFile` makes when it declines to publish an empty file. A
  // truncated upload, a half-written file or a server that published an empty
  // catalog would otherwise delete every row for this provider, and because an
  // empty `put` stores no stamp the cache would then re-download on every
  // listing forever. Keep what this device knows and retry next listing.
  if (parsed.series.length === 0) {
    console.warn(`[catalog-index-sync] ignoring an empty catalog.json at '${cloudFile.path}'`);
    return;
  }

  const now = new Date().toISOString();
  const source = {
    provider: provider.type,
    path: normalizeCloudPath(cloudFile.path),
    size: stamp.size,
    modifiedTime: stamp.modifiedTime
  };

  const records: CatalogIndexRecord[] = [];
  for (const entry of parsed.series) {
    const key = normalizeSeriesKey(entry.series_title);
    if (!key) continue;
    records.push({
      series_key: key,
      series_title: entry.series_title,
      entry,
      source,
      fetched_at: now
    });
    try {
      // Facts only, strictly-newer, factless entries never create or unlink.
      await upsertFromSeriesFile(entry.series_title, catalogEntryToSeriesFile(entry));
    } catch (error) {
      console.warn(
        `[catalog-index-sync] could not apply the facts for '${entry.series_title}':`,
        error
      );
    }
  }

  const keep = new Set(records.map((r) => r.series_key));
  const stale = cached
    .filter((row) => row.source.provider === provider.type && !keep.has(row.series_key))
    .map((row) => row.series_key);

  try {
    await deleteCatalogIndexes(stale);
    await putCatalogIndexes(records);
  } catch (error) {
    console.warn('[catalog-index-sync] could not store the refreshed catalog:', error);
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
 * Refresh the cached root catalog for a cloud listing.
 *
 * Never rejects. Calls that arrive while a run is in flight do not start a
 * second one: the newest request is queued and replayed once when the current
 * run finishes, so a burst of listings costs at most one extra pass.
 */
export function refreshCatalogIndex(
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
          console.warn('[catalog-index-sync] refresh failed:', error);
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
