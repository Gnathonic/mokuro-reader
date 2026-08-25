import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
import { materializeSeriesVolumes } from '$lib/catalog/materialize';
import { installCoversForSeries } from '$lib/catalog/cover-install';
import { backfillSeriesEntries } from './series-backfill';
import { normalizeSeriesKey } from './series-key';

/**
 * The series-open load step: refresh THIS series' `series.json` (size/mtime
 * gated, not waiting for the listing-wide pass), materialize its index entries
 * as metadata-only rows, then install their covers from the per-volume sidecars.
 *
 * Deduped per normalized series key, so the view mounting, a route change and a
 * hole patch arriving together cost one pass. Best-effort throughout: never
 * rejects, never surfaces UI — a series that fails to load simply shows what the
 * device already had.
 *
 * The returned promise settles at MATERIALIZATION, not at the end of the pass,
 * and the dedupe entry is released at that same moment. That is the point the
 * catalog has its rows and the view can render, whereas cover install is one
 * network round trip per volume behind it: a caller showing a spinner would
 * hold it over I/O it is not waiting for, and — worse — a cover phase that
 * hangs would pin the series' dedupe entry, silently turning every later open
 * into a no-op. Covers are still awaited INSIDE the pass so their failures stay
 * contained here, but they are NOT part of what is deduped; owning a per-series
 * in-flight guard is `installCoversForSeries`' own job.
 */
const inFlight = new Map<string, Promise<void>>();

export function openSeries(seriesTitle: string): Promise<void> {
  const key = normalizeSeriesKey(seriesTitle);
  if (!key) return Promise.resolve();

  const running = inFlight.get(key);
  if (running) return running;

  let resolveMaterialized!: () => void;
  const materialized = new Promise<void>((resolve) => {
    resolveMaterialized = resolve;
  });
  // Releases the caller AND the dedupe entry together — the two share one
  // moment, so nothing downstream of it can pin the series. Idempotent, because
  // every path that ends the pass without materializing (no index, a throw)
  // must still release both.
  const finishMaterialization = () => {
    // Only ever evict OUR OWN entry: once this pass has released the series, a
    // later open owns the slot, and this pass's cover phase settling afterwards
    // must not drop somebody else's dedupe.
    if (inFlight.get(key) === materialized) inFlight.delete(key);
    resolveMaterialized();
  };

  void (async () => {
    try {
      const file = await unifiedCloudManager.refreshSeriesIndexForSeries(seriesTitle);
      if (!file) return;

      // Fire-and-forget: a facts-only or partial series.json converges toward
      // having every archive's entry, but pulling sidecars must not hold up
      // materialization or the caller waiting on it. Best-effort by contract —
      // never rejects, never surfaces UI.
      void backfillSeriesEntries(seriesTitle);

      await materializeSeriesVolumes({
        seriesTitle,
        entries: file.volumes,
        cloudVolumeTitles: unifiedCloudManager.cloudVolumeTitlesFor(seriesTitle)
      });
      finishMaterialization();

      // Covers are installed even when nothing was materialized: rows from an
      // earlier open may still be missing theirs.
      await installCoversForSeries(seriesTitle);
    } catch (error) {
      console.debug(`[series-open] could not load '${seriesTitle}':`, error);
    } finally {
      finishMaterialization();
    }
  })();

  inFlight.set(key, materialized);
  return materialized;
}
