import { browser } from '$app/environment';
import { isVolumeComplete } from '$lib/util/volume-helpers';
import { VolumeData, volumesWithTrash } from '../settings/volume-data';

const BACKFILL_KEY = 'volumes.completedAtBackfill.v1';

/**
 * Date the completions that predate the `completedAt` field.
 *
 * Without this, a user whose 400-volume library is finished opens the tracker
 * and sees zero completions this year, and the whole feature reads as broken.
 * Dating them once, from the best evidence on disk, is strictly better than
 * deriving forever: it freezes the best available answer BEFORE further edits
 * erode `lastProgressUpdate`, and it is what makes `completedAt` monotone,
 * which the whole-entry sync merge relies on.
 *
 * Evidence, best first:
 *  1. `recentPageTurns` — scan backwards for the last turn that completed the
 *     volume. That is the actual moment, and it survives a later
 *     `toggleHasCover` or page-input edit that moved `lastProgressUpdate`.
 *  2. `lastProgressUpdate`, when it is not the epoch sentinel. For a volume
 *     finished and never touched again this IS the completion moment.
 *  3. Nothing — leave the stamp absent. Never guess `now`: a fabricated date
 *     would pile the user's entire back catalogue into the current period,
 *     which is exactly the wrong answer, confidently.
 *
 * `lastProgressUpdate` is deliberately NOT bumped: this is bookkeeping, not a
 * user action, and bumping it would make whichever device upgraded last win
 * every volume merge.
 */
export function backfillCompletedAt(pageCounts: Record<string, number>): void {
  if (!browser) return;
  if (window.localStorage.getItem(BACKFILL_KEY)) return;
  // The catalog has not loaded yet. Returning without marking the key done
  // means we simply try again on the next call.
  if (Object.keys(pageCounts).length === 0) return;

  const epoch = new Date(0).toISOString();

  volumesWithTrash.update((prev) => {
    let changed = false;
    let deferred = false;
    const updated = { ...prev };

    for (const [volumeId, volumeData] of Object.entries(prev)) {
      if (volumeData.deletedOn || volumeData.completedAt) continue;

      const pageCount = pageCounts[volumeId] ?? 0;
      // A volume with progress but no known length cannot be judged yet — the
      // catalog may simply not have its cloud row. Come back next boot.
      if (pageCount <= 0 && !volumeData.completed && volumeData.progress > 0) {
        deferred = true;
        continue;
      }
      // The app's union predicate, not the bare flag: this is precisely the
      // population whose flag an older client's `toggleHasCover` clobbered.
      if (!volumeData.completed && !isVolumeComplete(volumeData.progress, pageCount)) continue;

      let stamp: string | undefined;
      for (let i = volumeData.recentPageTurns.length - 1; i >= 0; i -= 1) {
        const [timestamp, page] = volumeData.recentPageTurns[i];
        if (isVolumeComplete(page, pageCount)) {
          stamp = new Date(timestamp).toISOString();
          break;
        }
      }
      if (!stamp && volumeData.lastProgressUpdate !== epoch) {
        stamp = volumeData.lastProgressUpdate;
      }
      if (!stamp) continue;

      updated[volumeId] = new VolumeData({ ...volumeData, completedAt: stamp });
      changed = true;
    }

    // Only declare the backfill done once every finished volume had a page
    // count to judge it by. The catalog gains its cloud placeholders after the
    // first remote listing, so an early run sees a local-only catalog: marking
    // it done there would permanently strand the completion dates of every
    // volume this device has never downloaded.
    if (!deferred) {
      window.localStorage.setItem(BACKFILL_KEY, new Date().toISOString());
    }

    return changed ? updated : prev;
  });
}
