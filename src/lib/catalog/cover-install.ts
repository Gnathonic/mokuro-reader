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
 * Returns how many covers were installed.
 */
export async function installCoversForSeries(seriesTitle: string): Promise<number> {
  void seriesTitle;
  return 0;
}
