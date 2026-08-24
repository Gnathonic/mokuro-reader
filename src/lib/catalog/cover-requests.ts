import type { VolumeMetadata } from '$lib/types';
import type { CloudThumbnailResult } from './cloud-thumbnails';

export type CoverFetcher = (volume: VolumeMetadata) => Promise<CloudThumbnailResult | null>;

/**
 * How long to wait before asking again for a cover that produced nothing, per attempt.
 *
 * Releasing the uuid is only half the fix: it lets the NEXT run of the surface's effect
 * ask again, and during a bulk download the catalog emits constantly so that run comes
 * along within seconds. But the same failure happens in a burst that goes quiet — the
 * provider connects, the listing lands, a dozen covers race a saturated account, and then
 * nothing re-renders the catalog at all. Those cards would sit blank with no one left to
 * ask. Verified: with release-only, 12 injected failures inside a 6-second window were
 * re-asked 5 times while the app was still starting up, then never again.
 *
 * Two retries, deliberately: enough to ride out a connect burst, few enough that a
 * provider which is down is not asked four times for every cover on screen. After that
 * the uuid is released and any later re-run is free to try once more.
 */
const DEFAULT_RETRY_DELAYS_MS = [2000, 8000];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Ask for a volume's cover at most once per surface — but only count the request as
 * spent when it actually produced a cover.
 *
 * Every surface that draws cloud covers (the catalog card, the spine shelf, the volume
 * placeholder) runs its fetch inside an effect that re-runs for reasons which have
 * nothing to do with covers: a settings write, a re-sort, a metadata emission. Without a
 * ledger each of those re-requests every cover that has not landed yet, and each request
 * that resolves writes state that can re-run the effect again.
 *
 * The ledger must NOT be a one-way ratchet, though. `fetchCloudThumbnail` deliberately
 * caches nothing on failure: a 15s timeout, a provider that was not connected yet, an
 * account saturated by a bulk download all resolve to `null` and are meant to be
 * retried. Holding the uuid across one of those turns a transient failure into a cover
 * that stays blank until the component remounts — which is exactly the "freshly
 * downloaded series has no covers until I navigate away and back" bug. Reproduced end to
 * end: 12 injected cover-download failures inside a 6-second window left every card on
 * screen cover-less for good, long after the provider was healthy again.
 *
 * So the uuid is held while the request (and its bounded retries) is in flight, and kept
 * afterwards ONLY if `commit` reported that a cover was actually stored. A `null` result,
 * a throw, or a superseded effect run that discards its own answer all release it, and
 * the next run of the effect is free to ask again.
 *
 * The fetcher is injected rather than imported so this rule carries no dependency on the
 * cloud stack — it is request bookkeeping, and every surface must apply it identically.
 *
 * @param ledger  The surface's record of what it has asked for. Never reactive: it is a
 *                record of what the surface has done, not an input to what it draws.
 * @param commit  Stores the cover. Return `false` when it was NOT stored (a superseded
 *                run), which releases the uuid.
 * @param retryDelaysMs  Override the retry schedule; `[]` disables retrying.
 */
export async function requestCoverOnce(
  ledger: Set<string>,
  volume: VolumeMetadata,
  fetchCover: CoverFetcher,
  commit: (result: CloudThumbnailResult) => boolean | void,
  retryDelaysMs: number[] = DEFAULT_RETRY_DELAYS_MS
): Promise<void> {
  const uuid = volume.volume_uuid;
  if (ledger.has(uuid)) return;
  ledger.add(uuid);

  let committed = false;
  try {
    for (let attempt = 0; ; attempt++) {
      const result = await fetchCover(volume);
      if (result) {
        committed = commit(result) !== false;
        break;
      }
      if (attempt >= retryDelaysMs.length) break;
      await sleep(retryDelaysMs[attempt]);
    }
  } catch (error) {
    // The fetcher already funnels its own failures to `null`; this is the belt for
    // anything the commit callback throws.
    console.warn(`Cover request failed for ${volume.volume_title}:`, error);
  } finally {
    if (!committed) ledger.delete(uuid);
  }
}
