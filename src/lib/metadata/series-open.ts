import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
import { materializeSeriesVolumes } from '$lib/catalog/materialize';
import { installCoversForSeries } from '$lib/catalog/cover-install';
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
 */
const inFlight = new Map<string, Promise<void>>();

export function openSeries(seriesTitle: string): Promise<void> {
  const key = normalizeSeriesKey(seriesTitle);
  if (!key) return Promise.resolve();

  const running = inFlight.get(key);
  if (running) return running;

  const run = (async () => {
    try {
      const file = await unifiedCloudManager.refreshSeriesIndexForSeries(seriesTitle);
      if (!file) return;

      await materializeSeriesVolumes({
        seriesTitle,
        entries: file.volumes,
        cloudVolumeTitles: unifiedCloudManager.cloudVolumeTitlesFor(seriesTitle)
      });
      // Covers are installed even when nothing was materialized: rows from an
      // earlier open may still be missing theirs.
      await installCoversForSeries(seriesTitle);
    } catch (error) {
      console.debug(`[series-open] could not load '${seriesTitle}':`, error);
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, run);
  return run;
}
