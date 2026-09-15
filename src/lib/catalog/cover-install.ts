import { db } from '$lib/catalog/db';
import type { VolumeMetadata } from '$lib/types';
import { flushPendingCoverPersists } from '$lib/catalog/cover-persist';
// Deferred-use import into the module cycle cover-service → series-file-sync →
// series-backfill → cover-install → cover-service (the backfill imports this
// module for its post-write flesh-out). Safe for the same reason the existing
// series-file-sync ↔ series-backfill cycle is: nothing on any side calls
// across at module-init time, only from inside function bodies.
import { requestCover, type CoverOutcome } from '$lib/catalog/cover-service';
import { indexCoverSidecarsByBasePath, type CoverSidecarInfo } from '$lib/catalog/placeholders';
import { needsDownload } from '$lib/catalog/volume-state';
import { isArchiveSize } from '$lib/metadata/series-file';
import { normalizeSeriesKey, normalizeVolumeTitleKey } from '$lib/metadata/series-key';
import type { CloudFileMetadata } from '$lib/util/sync/provider-interface';
import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';

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
 * of the series-open path, so they are asked for lazily and only for rows that
 * actually lack one. This module decides WHICH rows to ask for and from WHICH
 * listing files; everything after that — the cache check, PROMOTING a cached
 * cover onto a row the user has read, the fetch (`cloud-thumbnails.ts`'s
 * 8-slot pool and 15 s timeout), the dedupe, the retry, and where the blob
 * lands — is `cover-service.ts`'s `requestCover`, the ONE entry point every
 * cover in the app goes through. There is no second fetch path here any more.
 *
 * Where the blob lands is `cover-persist.ts`'s call (`coverBelongsOnRow`):
 * onto the `volumes` row only for a metadata-only row the user has READ, and
 * otherwise into the `cloud_covers` cache keyed by `[account_scope+path]`. The
 * rows this module targets are the metadata-only ones a mere series OPEN
 * materializes, which usually have no history — so in the common case nothing
 * is written to `volumes` at all, and the card paints from the cache instead.
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
 * Returns how many requests delivered a cover (onto a row or into the cache —
 * the service decides which). Never rejects.
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

  // `equalsIgnoreCase` is case- but not whitespace-insensitive; re-filter by
  // the catalog's own grouping key, exactly as `materializeSeriesVolumes` does.
  // Each candidate is decorated on a COPY with the listing's cover sidecar
  // and archive path — the same shape the catalog hands a card
  // (`cloudFieldsForRemovedVolume`), so the service sees exactly what it
  // would see from a render. Nothing here is ever written back to the row.
  const requests: Promise<CoverOutcome>[] = [];
  for (const row of rows) {
    if (normalizeSeriesKey(row.series_title) !== seriesKey) continue;
    if (!needsDownload(row) || row.thumbnail) continue;
    const key = coverKey(row.series_title, row.volume_title);
    const info = covers.get(key);
    if (!info) continue;
    const decorated: VolumeMetadata = {
      ...row,
      cloudProvider: provider.type,
      cloudPath: archivePaths.get(key) ?? row.cloudPath,
      cloudThumbnailFileId: info.fileId,
      cloudThumbnailPath: info.path,
      ...(isArchiveSize(info.size) ? { cloudThumbnailSize: info.size } : {}),
      ...(info.modifiedTime ? { cloudThumbnailModifiedTime: info.modifiedTime } : {})
    };
    requests.push(requestCover(decorated));
  }
  if (requests.length === 0) return 0;

  const outcomes = await Promise.all(requests);
  const installed = outcomes.filter((o) => o === 'row' || o === 'cache').length;
  // Drain what this pass queued before returning: this runs inside an
  // already-async series-open/backfill pass whose caller awaits it, not a UI
  // burst, so "installed" should mean the covers have actually landed. One
  // forced flush for the whole pass keeps the "one burst, one write per
  // table" property the queue's write-storm design depends on.
  if (installed > 0) await flushPendingCoverPersists();
  return installed;
}
