import type {
  CloudFileMetadata,
  ProviderType,
  SyncProvider
} from '$lib/util/sync/provider-interface';
import { providerManager } from '$lib/util/sync/provider-manager';
import { catalogNeedsRefresh, getCatalogIndex, putCatalogIndex } from './catalog-index';
import {
  catalogEntryToSeriesFile,
  isCatalogFilePath,
  parseCatalogFile,
  type CatalogFile
} from './catalog-file';
import { upsertManyFromSeriesFiles, type SeriesFileUpsert } from './store';

/**
 * The read half of the root `catalog.json`: after every cloud listing (catalog
 * open, provider connect, backup run), re-read the file if and only if its
 * size/mtime changed, cache the file and apply its facts.
 *
 * Deliberately timid, exactly like `series-index-sync.ts`:
 *
 * - ONE download for the whole library, and none at all when the stamp matches,
 *   so a 1k-series library costs one listing and zero downloads on a normal
 *   launch.
 * - Facts go through `upsertManyFromSeriesFiles`, which applies only strictly
 *   newer facts, never creates a record from a factless entry, and never
 *   schedules a write — so a refresh can never ping-pong into an upload. The
 *   whole file lands in ONE batched write, and a junk entry costs only itself:
 *   see the note in `runRefresh` for why that is a batch and not a transaction
 *   wrapped round per-entry upserts.
 * - Everything is best-effort: junk content is dropped with one warning, a
 *   failed download is skipped, and the run never rejects.
 * - A run is BOUND to the provider whose listing produced it: between the fetch
 *   and the (background, possibly queued) run the user can switch accounts.
 * - Nothing is cached against an empty listing — that means "not fetched" as
 *   often as it means "empty cloud".
 * - The parsed file is cached WHOLE, in one `putCatalogIndex`: it is one remote
 *   document, and the cache exists to answer "what does the cloud copy say".
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
  const cached = await getCatalogIndex();
  if (!catalogNeedsRefresh(cached, stamp, provider.type)) {
    // The catalog didn't change — which is exactly what a silently dropped
    // local push looks like from here (the cloud stamp never moves). Healing
    // therefore runs on EVERY listing, off the cached copy when the file is
    // current.
    if (cached) await healFactsBehindCatalog(cached.file, provider);
    return;
  }

  const parsed = await downloadCatalog(provider, cloudFile);
  if (!parsed) return;
  // A catalog that parses to NOTHING is never authoritative — the same refusal
  // `buildCatalogFile` makes when it declines to publish an empty file. A
  // truncated upload, a half-written file or a server that published an empty
  // catalog would otherwise replace the cached copy with an empty one carrying a
  // current stamp, hiding the real catalog until its size/mtime moved again.
  // Keep what this device knows and retry next listing.
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

  // ONE batched write, never a `db.transaction` around per-entry upserts.
  //
  // Those are two different things, and only one of them is safe. Wrapping calls
  // to `upsertFromSeriesFile` in an enclosing `db.transaction` is a data-loss
  // bug: it opens its OWN `rw` transaction on this table (store.ts), which Dexie
  // joins to any enclosing one as a SUB-transaction, and a sub-transaction that
  // rejects aborts its parent ("Transaction committed too early") — catching the
  // error here would not save it, because the parent zone is already dead. One
  // malformed entry would roll back every entry written before it and fail every
  // entry after it, discarding the whole refresh's facts.
  //
  // `upsertManyFromSeriesFiles` is not that. It does the merge for every entry
  // against ONE read and writes them with ONE `bulkPut`, opening a single
  // transaction of its own and nesting nothing — so a bad entry is dropped from
  // the batch (per-entry `try`, reported below) instead of taking the batch down
  // with it.
  //
  // WHY IT IS WORTH DOING. The old defence of the per-entry loop was that the
  // cost is small because `upsertFromSeriesFile` only applies strictly-newer
  // facts, so almost every call writes nothing and a transaction that writes
  // nothing emits nothing. True — in the STEADY STATE, and irrelevant in the case
  // that actually hurts. On a first sync (or the first sync after a new device
  // publishes the library) EVERY entry is new, so every entry writes, and
  // `series_metadata` backs a liveQuery the catalog joins: Dexie broadcasts
  // `storagemutated` once per readwrite COMMIT, so on a ~1k-series library that
  // was ~1k commits, each re-running the catalog's O(V) derive over every volume
  // in the library. Batched, one sync costs one commit and one derive.
  //
  // Covered by `catalog-index-sync.facts.test.ts`, which runs this against a
  // real Dexie rather than a stubbed one — both the commit count and the
  // one-bad-entry-costs-only-itself property.
  const reportEntryError = (seriesTitle: string, error: unknown) => {
    console.warn(`[catalog-index-sync] could not apply the facts for '${seriesTitle}':`, error);
  };

  const upserts: SeriesFileUpsert[] = [];
  for (const entry of parsed.series) {
    try {
      // Facts only, strictly-newer, factless entries never create or unlink.
      upserts.push({
        seriesTitle: entry.series_title,
        file: catalogEntryToSeriesFile(entry)
      });
    } catch (error) {
      // Per entry here too, not one `map`: lifting an entry into a `SeriesFile`
      // is the other place a junk entry can throw, and a `map` would lose the
      // whole batch to it.
      reportEntryError(entry.series_title, error);
    }
  }

  try {
    await upsertManyFromSeriesFiles(upserts, reportEntryError);
  } catch (error) {
    // The batch opens a transaction; if that itself fails there are no facts to
    // apply, but the NAMES below are still worth caching — the catalog can list
    // and search a series whose facts did not land.
    console.warn('[catalog-index-sync] could not apply the catalog facts:', error);
  }

  try {
    // Last writer wins against a concurrent `stampCatalogCache` (this device
    // publishing its own catalog.json), and that is fine: both write the same
    // shape, and whichever loses leaves a stamp that no longer matches the cloud
    // file, so the very next listing re-reads and settles it.
    await putCatalogIndex({ file: parsed, source, fetched_at: now });
  } catch (error) {
    console.warn('[catalog-index-sync] could not store the refreshed catalog:', error);
  }

  await healFactsBehindCatalog(parsed, provider);
}

/**
 * The local→cloud half of the refresh: HEAL what the catalog shows is behind.
 *
 * The cloud→local upsert above trusts strictly-newer catalog facts; this is
 * its mirror. For every locally stored series that carries facts, compare the
 * local facts stamp against the catalog entry's (the same clock `series.json`
 * merges by): a local stamp strictly ahead — or a series the catalog does not
 * list at all — means a push was dropped somewhere, so schedule the standard
 * per-series write (which re-reads the cloud file and merges, so a stale
 * local copy still cannot clobber a newer cloud one). Facts only land in an
 * existing cloud folder, same as every other publish path. Finishes by
 * scheduling a catalog write — a no-op on servers that compile their own.
 *
 * Best-effort by contract, like everything else on this path: a heal that
 * fails to schedule is retried by the next listing.
 */
async function healFactsBehindCatalog(file: CatalogFile, provider: SyncProvider): Promise<void> {
  try {
    if (file.series.length === 0) return;
    const [{ db }, { hasSeriesFacts }, { factsStamp }, { normalizeVolumeTitleKey }] =
      await Promise.all([
        import('$lib/catalog/db'),
        import('./series-file'),
        import('./store'),
        import('./series-key')
      ]);
    const locals = (await db.series_metadata.toArray()).filter((record) => hasSeriesFacts(record));
    if (locals.length === 0) return;

    const entryStampByKey = new Map(
      file.series.map((entry) => [normalizeVolumeTitleKey(entry.series_title), entry.updated_at])
    );
    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');

    const behind: string[] = [];
    for (const record of locals) {
      const localStamp = factsStamp(record);
      if (!localStamp) continue;
      const cloudStamp = entryStampByKey.get(normalizeVolumeTitleKey(record.series_title));
      if (cloudStamp !== undefined && cloudStamp >= localStamp) continue;
      if (unifiedCloudManager.cloudVolumeTitlesFor(record.series_title).size === 0) continue;
      behind.push(record.series_title);
    }
    if (behind.length === 0) return;

    console.log(
      `[catalog-index-sync] catalog is behind local facts for ${behind.length} series — healing`
    );
    const { scheduleSeriesFileWrite } = await import('./series-file-sync');
    for (const title of behind) {
      scheduleSeriesFileWrite(title, { fromCloudListing: true });
    }
    // Producer-side catch-all: on a client-compiled backend this republishes
    // catalog.json once the series writes land; `scheduleCatalogFileWrite`
    // itself refuses on a server that compiles its own.
    const { scheduleCatalogFileWrite } = await import('./catalog-file-sync');
    scheduleCatalogFileWrite();
  } catch (error) {
    console.debug('[catalog-index-sync] facts heal skipped:', error);
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
