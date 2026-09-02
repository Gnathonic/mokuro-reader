import { browser } from '$app/environment';
import { isVolumeComplete } from '$lib/util/volume-helpers';
import { get } from 'svelte/store';
import { VolumeData, volumesWithTrash } from '../settings/volume-data';

const BACKFILL_KEY = 'volumes.completedAtBackfill.v1';
const BACKFILL_ATTEMPTS_KEY = 'volumes.completedAtBackfill.attempts';

/**
 * How many boots to keep waiting for page counts before settling for what we
 * have. Some volumes never get one — a cloud volume with no `series.json`
 * entry keeps `page_count: 0` forever — so an unbounded wait means the flag is
 * never written and the whole pass re-runs on every focus, for good.
 */
const MAX_DEFERRALS = 5;

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
export function backfillCompletedAt(
  pageCounts: Record<string, number>,
  { countDeferral = false }: { countDeferral?: boolean } = {}
): void {
  if (!browser) return;
  if (window.localStorage.getItem(BACKFILL_KEY)) return;
  // The catalog has not loaded yet. Returning without marking the key done
  // means we simply try again on the next call.
  if (Object.keys(pageCounts).length === 0) return;

  const epoch = new Date(0).toISOString();
  const attempts = Number(window.localStorage.getItem(BACKFILL_ATTEMPTS_KEY) ?? '0') || 0;

  /*
   * Scanned OUTSIDE `update()`, and the store is written only when something
   * actually changed.
   *
   * `_volumesInternal` is a plain writable and Svelte's `safe_not_equal`
   * reports every object as changed, so calling `update()` to return `prev`
   * unchanged still fires the persist subscriber — re-serializing the whole
   * library and writing it to localStorage. On the deferral path that happened
   * on every focus, every visibility change and every reader exit.
   */
  const prev = get(volumesWithTrash);

  /*
   * NOTHING TO EXAMINE IS NOT SUCCESS.
   *
   * The reading records load from localStorage, but on a device whose progress
   * arrives by SYNC the store is legitimately empty for the first moments of a
   * session — and a pass that runs then finds no volume to stamp and none to
   * defer, so it recorded the migration as complete and never ran again. The
   * 503 finished volumes that synced in a second later stayed undated forever:
   * counted toward no goal, listed in no section, with no way to recover.
   */
  if (Object.keys(prev).length === 0) return;

  const stamps: Record<string, string> = {};
  let deferred = false;

  {
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

      stamps[volumeId] = stamp;
    }
  }

  /*
   * Hold the flag back while a volume still has no page count to judge it by —
   * the catalog gains its cloud placeholders only after the first remote
   * listing, and marking the pass done before then would permanently strand
   * the completion dates of every volume this device has never downloaded.
   *
   * BOUNDED, because some volumes never get a page count at all. After
   * MAX_DEFERRALS boots we settle for what we have rather than re-scanning
   * forever.
   */
  if (deferred && attempts < MAX_DEFERRALS) {
    // Counted once per BOOT, by the boot pass alone. The recurring passes still
    // RUN — they are the only ones that ever see the cloud listing, which
    // arrives long after the local catalog resolves — but if they also spent
    // the budget, a few tab switches would exhaust it. And if only the boot
    // pass ran, the budget would expire having never once observed a cloud
    // page count, which is exactly what it is waiting for.
    if (countDeferral) {
      window.localStorage.setItem(BACKFILL_ATTEMPTS_KEY, String(attempts + 1));
    }
  } else {
    window.localStorage.setItem(BACKFILL_KEY, new Date().toISOString());
    window.localStorage.removeItem(BACKFILL_ATTEMPTS_KEY);
  }

  if (Object.keys(stamps).length === 0) return;

  volumesWithTrash.update((current) => {
    const updated = { ...current };
    for (const [volumeId, stamp] of Object.entries(stamps)) {
      const volumeData = current[volumeId];
      // Re-checked against the CURRENT store: the scan above read a snapshot.
      if (!volumeData || volumeData.completedAt) continue;
      updated[volumeId] = new VolumeData({ ...volumeData, completedAt: stamp });
    }
    return updated;
  });
}
