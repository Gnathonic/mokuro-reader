import { db } from '$lib/catalog/db';
import type { VolumeMetadata } from '$lib/types';
import { fetchCloudThumbnail } from '$lib/catalog/cloud-thumbnails';
import { indexCoverSidecarsByBasePath } from '$lib/catalog/placeholders';
import { needsDownload } from '$lib/catalog/volume-state';
import { normalizeSeriesKey, normalizeVolumeTitleKey } from '$lib/metadata/series-key';
import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';

/** Cover downloads started at once. `fetchCloudThumbnail` caps the network at 4 anyway. */
const MAX_CONCURRENT_COVER_INSTALLS = 4;

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
function foldCoverIndex(
  index: Map<string, { fileId: string; path: string }>
): Map<string, { fileId: string; path: string }> {
  const folded = new Map<string, { fileId: string; path: string }>();
  for (const [basePath, info] of index) {
    const cut = basePath.lastIndexOf('/');
    if (cut < 0) continue; // Not `<Series>/<Volume>`: nothing a row can be paired with.
    const key = coverKey(basePath.slice(0, cut), basePath.slice(cut + 1));
    if (!folded.has(key)) folded.set(key, info);
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
 * the request coalescing, the 4-way concurrency cap and the 15 s timeout; this
 * function only decides WHICH rows need one and writes the result.
 *
 * A row that already has a thumbnail is never touched: it was either measured
 * from the volume's own pages or picked by hand, and the sidecar is a guess by
 * comparison.
 *
 * The cloud fields are put on a COPY for the fetch and never stored on the row:
 * a fileId belongs to the current listing, not to the volume (the same rule the
 * catalog join follows when it decorates metadata-only rows).
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
 * Returns how many covers were installed. Never rejects.
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

  const covers = foldCoverIndex(
    indexCoverSidecarsByBasePath(unifiedCloudManager.getAllCloudVolumes())
  );
  if (covers.size === 0) return 0;

  const seriesKey = normalizeSeriesKey(seriesTitle);
  const rows = (await db.volumes
    .where('series_title')
    .equalsIgnoreCase(seriesTitle)
    .toArray()) as VolumeMetadata[];

  // `equalsIgnoreCase` is case- but not whitespace-insensitive; re-filter by the
  // catalog's own grouping key, exactly as `materializeSeriesVolumes` does.
  const targets = rows.filter(
    (row) =>
      normalizeSeriesKey(row.series_title) === seriesKey && needsDownload(row) && !row.thumbnail
  );
  if (targets.length === 0) return 0;

  let installed = 0;
  let next = 0;
  const workers = Array.from(
    { length: Math.min(MAX_CONCURRENT_COVER_INSTALLS, targets.length) },
    async () => {
      while (next < targets.length) {
        const row = targets[next++];
        const info = covers.get(coverKey(row.series_title, row.volume_title));
        if (!info) continue;
        try {
          const result = await fetchCloudThumbnail({
            ...row,
            cloudProvider: provider.type,
            cloudThumbnailFileId: info.fileId,
            cloudThumbnailPath: info.path
          });
          if (!result) continue;
          // Re-check under a transaction: a download can finish while this
          // cover is in flight, which INSTALLS the volume and gives it a
          // thumbnail measured from its own pages. The snapshot above is that
          // old by the time the network answers, so the row is re-read and the
          // same two conditions re-tested against the write itself.
          const wrote = await db.transaction('rw', db.volumes, async () => {
            const fresh = (await db.volumes.get(row.volume_uuid)) as VolumeMetadata | undefined;
            if (!fresh || !needsDownload(fresh) || fresh.thumbnail) return false;
            await db.volumes.update(row.volume_uuid, {
              thumbnail: result.file,
              thumbnail_width: result.width,
              thumbnail_height: result.height
            });
            return true;
          });
          if (wrote) installed += 1;
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
  return installed;
}
