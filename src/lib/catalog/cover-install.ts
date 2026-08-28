import { db } from '$lib/catalog/db';
import type { VolumeMetadata } from '$lib/types';
import { fetchCloudThumbnail } from '$lib/catalog/cloud-thumbnails';
import { activeAccountScope, normalizeCachePath } from '$lib/catalog/cloud-cache-key';
import { cachedCoverPaths } from '$lib/catalog/cloud-covers';
import { installCover, flushPendingCoverPersists } from '$lib/catalog/cover-persist';
import { indexCoverSidecarsByBasePath, type CoverSidecarInfo } from '$lib/catalog/placeholders';
import { needsDownload } from '$lib/catalog/volume-state';
import { normalizeSeriesKey, normalizeVolumeTitleKey } from '$lib/metadata/series-key';
import type { CloudFileMetadata } from '$lib/util/sync/provider-interface';
import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';

/**
 * Cover downloads started at once by one series-open pass. Matched to
 * `fetchCloudThumbnail`'s own `MAX_CONCURRENT_FETCHES` (the real network
 * cap) so a pass can actually fill that pool rather than starving it at
 * half width; the per-worker DB re-check between fetches is a keyed read
 * and costs nothing at this parallelism.
 */
/**
 * Matched to `MAX_CONCURRENT_FETCHES` in `cloud-thumbnails.ts` (both 8) so the
 * install pass can keep the widened fetch pool fed. Pinned by test — change
 * both together or the narrower one silently becomes the real limit.
 */
export const MAX_CONCURRENT_COVER_INSTALLS = 8;

/**
 * The running pass per normalized series key, plus whether a joiner arrived
 * after it took its snapshot — see `installCoversForSeries`.
 */
const inFlight = new Map<string, { promise: Promise<number>; dirty: boolean }>();

/**
 * The join key between a cover sidecar's path and a row: the volume's identity
 * as `<series>/<volume>`, with BOTH halves through `normalizeVolumeTitleKey` —
 * the catalog's fold (trim / collapse whitespace / lowercase) plus unicode
 * composition. Both sides of the join go through this one function, so a path a
 * provider hands back decomposed or double-spaced still pairs with the composed
 * title the index wrote onto the row.
 *
 * The series half is NFC-folded too, unlike `normalizeSeriesKey` elsewhere,
 * because a provider that decomposes decomposes the WHOLE path: a Japanese
 * series folder would otherwise miss every one of its covers while a series
 * named in ASCII matched fine. This key is private to this join and is never a
 * series identity, so it owes `materializeSeriesVolumes` no consistency.
 */
function coverKey(seriesTitle: string, volumeTitle: string): string {
  return `${normalizeVolumeTitleKey(seriesTitle)}/${normalizeVolumeTitleKey(volumeTitle)}`;
}

/** Re-key the listing's cover index (lowercased base paths) onto {@link coverKey}. */
function foldCoverIndex(index: Map<string, CoverSidecarInfo>): Map<string, CoverSidecarInfo> {
  const folded = new Map<string, CoverSidecarInfo>();
  for (const [basePath, info] of index) {
    const cut = basePath.lastIndexOf('/');
    if (cut < 0) continue; // Not `<Series>/<Volume>`: nothing a row can be paired with.
    const key = coverKey(basePath.slice(0, cut), basePath.slice(cut + 1));
    if (!folded.has(key)) folded.set(key, info);
  }
  return folded;
}

/**
 * The listing's `.cbz` archive paths, keyed by the SAME {@link coverKey} the
 * cover index is folded onto — a volume's CACHE IDENTITY, needed because
 * `cover-persist.ts` may route this cover to `cloud_covers` instead of onto
 * the row (see {@link runCoverInstall}).
 *
 * It has to come from the LISTING and cannot come from the row: `cloudPath` is
 * decorated onto the catalog's in-memory COPY of a metadata-only row
 * (`cloudFieldsForRemovedVolume`) and is never persisted —
 * `materializeSeriesVolumes`, the only writer that mints the rows this module
 * targets, writes no cloud fields at all. A stored row therefore has no cache
 * identity of its own, and handing `installCover` an undefined path would make
 * it fetch the cover and then silently drop it.
 *
 * The archive path is the right key rather than the cover sidecar's own path
 * because that is what `catalog/index.ts` reads a cached cover back under
 * (`cloudFieldsForRemovedVolume` → `normalizeCachePath(cloudPath)`), and what
 * every other `cloud_covers` writer already uses.
 */
function foldArchiveIndex(files: Iterable<CloudFileMetadata>): Map<string, string> {
  const folded = new Map<string, string>();
  for (const file of files) {
    if (!file.path.toLowerCase().endsWith('.cbz')) continue;
    const withoutExt = file.path.slice(0, -'.cbz'.length);
    const cut = withoutExt.lastIndexOf('/');
    if (cut < 0) continue; // Not `<Series>/<Volume>.cbz`: nothing a row can be paired with.
    const key = coverKey(withoutExt.slice(0, cut), withoutExt.slice(cut + 1));
    if (!folded.has(key)) folded.set(key, file.path);
  }
  return folded;
}

/**
 * Give this series' not-installed rows their covers, from the per-volume
 * sidecars that already exist next to each `.cbz`.
 *
 * A materialized row has everything except a picture, and a catalog full of
 * blank cards is worse than a slow one — but the covers are the only heavy part
 * of the series-open path, so they are fetched lazily, bounded, and only for
 * rows that actually lack one. `fetchCloudThumbnail` provides the session cache,
 * the request coalescing, the concurrency cap (`MAX_CONCURRENT_FETCHES`) and the
 * 15 s timeout; this function only decides WHICH rows need one and hands the
 * result to `cover-persist.ts`.
 *
 * It does NOT decide where the blob lands. `installCover` does, for every cover
 * path in the app: onto the `volumes` row only when this device has a
 * RELATIONSHIP with the volume (installed, or with reading activity), and
 * otherwise into the `cloud_covers` cache keyed by `[account_scope+path]`. The
 * rows this module targets are the metadata-only ones a mere series OPEN
 * materializes, which typically have neither — so in the common case nothing is
 * written to `volumes` at all, and the card paints from the cache instead
 * (`catalog/index.ts`'s join).
 *
 * A row that already has a thumbnail is never touched: it was either measured
 * from the volume's own pages or picked by hand, and the sidecar is a guess by
 * comparison.
 *
 * The cloud fields are put on a COPY for the fetch and never stored on the row:
 * a fileId belongs to the current listing, not to the volume (the same rule the
 * catalog join follows when it decorates metadata-only rows). The one cloud
 * value that must reach `installCover` is the ARCHIVE path — the cache identity
 * an unrowed cover needs — and it comes from the listing (see
 * {@link foldArchiveIndex}) precisely because it is not on the row.
 *
 * Deduped per series, and that dedupe lives HERE rather than in `openSeries`:
 * `openSeries` releases its own entry the moment materialization settles — so a
 * hung cover phase can never pin a series — which means re-opening a series
 * while its covers are still downloading calls this function again. This guard
 * is the only thing standing between that and N concurrent passes over the same
 * sidecars.
 *
 * A joiner also marks the pass DIRTY, and a dirty pass scans once more before
 * it resolves. The reason is what a joiner usually means: another open just
 * materialized rows this pass' snapshot could not see, and without the re-scan
 * their cards stay blank until the series is opened a third time. Once more,
 * never in a loop — a joiner during the re-scan is served the same promise and
 * the series settles rather than chasing a moving listing forever.
 *
 * Returns how many covers were fetched and routed (onto a row or into the
 * cache — `installCover` decides which). Never rejects.
 */
export function installCoversForSeries(seriesTitle: string): Promise<number> {
  const key = normalizeSeriesKey(seriesTitle);
  if (!key) return Promise.resolve(0);

  const running = inFlight.get(key);
  if (running) {
    running.dirty = true;
    return running.promise;
  }

  const state = { dirty: false } as { promise: Promise<number>; dirty: boolean };
  state.promise = (async () => {
    let installed = 0;
    try {
      installed = await runCoverInstall(seriesTitle);
      if (state.dirty) {
        state.dirty = false;
        installed += await runCoverInstall(seriesTitle);
      }
    } catch (error) {
      console.debug(`[cover-install] pass over '${seriesTitle}' failed:`, error);
    } finally {
      // Only ever evict OUR OWN entry, so a pass settling late cannot drop the
      // dedupe of the pass that replaced it.
      if (inFlight.get(key) === state) inFlight.delete(key);
    }
    return installed;
  })();

  inFlight.set(key, state);
  return state.promise;
}

/** One row this pass could fetch a cover for, with the two listing facts it needs. */
interface CoverCandidate {
  row: VolumeMetadata;
  info: CoverSidecarInfo | undefined;
  archivePath: string | undefined;
}

/**
 * Drop the candidates whose cover this account already has in `cloud_covers`.
 *
 * Load-bearing, not an optimization. `!row.thumbnail` used to be a complete
 * "already done" test because this module wrote the blob onto the row; now
 * that a relationship-less row deliberately never carries one, that row stays
 * blank forever and every later pass — every series open, every backfill
 * sweep — would re-download a cover it already holds. This is the same
 * already-have-it check `cover-service.ts` gets for free, because the catalog
 * hands IT rows already decorated with the cached cover
 * (`catalog/index.ts`'s join); this module reads STORED rows, so it has to ask
 * directly. An indexed point read per path, keys only — never the blobs.
 *
 * Defensive by design: any failure to resolve the scope or read the table
 * means "skip nothing", so a broken cache can only cost a redundant fetch, and
 * never a blank card.
 */
async function withoutCachedCovers(candidates: CoverCandidate[]): Promise<CoverCandidate[]> {
  try {
    const scope = activeAccountScope();
    if (!scope) return candidates;
    const paths = candidates
      .map((candidate) => candidate.archivePath)
      .filter((path): path is string => !!path);
    const cached = await cachedCoverPaths(scope, paths);
    if (cached.size === 0) return candidates;
    return candidates.filter(
      (candidate) =>
        !candidate.archivePath || !cached.has(normalizeCachePath(candidate.archivePath))
    );
  } catch (error) {
    console.debug('[cover-install] could not consult the cover cache:', error);
    return candidates;
  }
}

async function runCoverInstall(seriesTitle: string): Promise<number> {
  const provider = unifiedCloudManager.getActiveProvider();
  if (!provider) return 0;

  const listing = unifiedCloudManager.getAllCloudVolumes();
  const covers = foldCoverIndex(indexCoverSidecarsByBasePath(listing));
  if (covers.size === 0) return 0;
  const archivePaths = foldArchiveIndex(listing);

  const seriesKey = normalizeSeriesKey(seriesTitle);
  const rows = (await db.volumes
    .where('series_title')
    .equalsIgnoreCase(seriesTitle)
    .toArray()) as VolumeMetadata[];

  // `equalsIgnoreCase` is case- but not whitespace-insensitive; re-filter by the
  // catalog's own grouping key, exactly as `materializeSeriesVolumes` does.
  const candidates = rows
    .filter(
      (row) =>
        normalizeSeriesKey(row.series_title) === seriesKey && needsDownload(row) && !row.thumbnail
    )
    .map((row) => {
      const key = coverKey(row.series_title, row.volume_title);
      return { row, info: covers.get(key), archivePath: archivePaths.get(key) ?? row.cloudPath };
    })
    .filter((candidate) => !!candidate.info);
  if (candidates.length === 0) return 0;

  const targets = await withoutCachedCovers(candidates);
  if (targets.length === 0) return 0;

  let installed = 0;
  let next = 0;
  const workers = Array.from(
    { length: Math.min(MAX_CONCURRENT_COVER_INSTALLS, targets.length) },
    async () => {
      while (next < targets.length) {
        const { row, info, archivePath } = targets[next++];
        if (!info) continue;
        try {
          const result = await fetchCloudThumbnail({
            ...row,
            cloudProvider: provider.type,
            cloudThumbnailFileId: info.fileId,
            cloudThumbnailPath: info.path
          });
          if (!result) continue;
          // Re-check before queueing: a download can finish while this cover is
          // in flight, which INSTALLS the volume and gives it a thumbnail
          // measured from its own pages. The snapshot above is that old by the
          // time the network answers, so the row is re-read and the same two
          // conditions re-tested. This is only a "don't bother queueing"
          // filter, not the safety guard it used to be — the flush re-reads and
          // re-tests both conditions INSIDE its own write transaction, which is
          // where the write actually happens now.
          const fresh = (await db.volumes.get(row.volume_uuid)) as VolumeMetadata | undefined;
          if (!fresh || !needsDownload(fresh) || fresh.thumbnail) continue;
          // Routed, never written directly. A cover belongs on a `volumes` row
          // only when the device has a RELATIONSHIP with the volume (installed,
          // or read); the rows this module targets are metadata-only ones a
          // mere series OPEN materialized, which usually have neither — and a
          // blob on such a row is precisely what grew the table to 11,354 rows
          // / 417MB of thumbnails and made every catalog scan expensive.
          // `cover-persist.ts` owns that decision for every cover path in the
          // app; this one used to bypass it with a raw `db.volumes.update`.
          installCover({ volume_uuid: row.volume_uuid, cloudPath: archivePath }, result, {
            size: info.size,
            modifiedTime: info.modifiedTime
          });
          installed += 1;
        } catch (error) {
          console.debug(
            `[cover-install] could not install a cover for '${row.volume_title}':`,
            error
          );
        }
      }
    }
  );
  await Promise.all(workers);
  // Drain what this pass queued before returning, the same way
  // `series-backfill.ts`'s `refreshStaleCover` does: this runs inside an
  // already-async series-open/backfill pass whose caller awaits it, not a UI
  // burst, so "installed" should mean the covers have actually landed. One
  // forced flush for the whole pass keeps the "one burst, one write per table"
  // property the queue's write-storm design depends on.
  if (installed > 0) await flushPendingCoverPersists();
  return installed;
}
