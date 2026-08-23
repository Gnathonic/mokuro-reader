/**
 * Install covers for a series' metadata-only rows from the per-volume cover
 * sidecars in the cloud folder, so a materialized row shows its real thumbnail
 * without downloading the archive.
 *
 * Stub — the fetch/decode/store pass lands in Task 9. Wired into `openSeries`
 * already so the call site and its ordering (refresh → materialize → covers)
 * are settled: returning 0 simply means "no cover installed", which is exactly
 * what the caller does with a series whose sidecars are missing.
 *
 * **Task 9 must give this its own per-series in-flight dedupe.** `openSeries`
 * deliberately releases its dedupe entry the moment materialization settles, so
 * that a slow cover phase cannot pin the series and silently no-op every later
 * open. The consequence is that re-opening a series while its covers are still
 * downloading calls this function again — it is the only thing that can stop
 * that becoming N concurrent downloads of the same sidecars.
 *
 * Returns how many covers were installed.
 */
export async function installCoversForSeries(seriesTitle: string): Promise<number> {
  void seriesTitle;
  return 0;
}
