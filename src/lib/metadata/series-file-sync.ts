import { browser } from '$app/environment';
import { get } from 'svelte/store';
import { db } from '$lib/catalog/db';
import type { VolumeMetadata } from '$lib/types';
import { providerManager } from '$lib/util/sync/provider-manager';
import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
import { normalizeSeriesKey } from './series-key';
import { registerFactsChangeListener } from './store';

/**
 * The automatic half of the `series.json` index: local fact edits (link,
 * unlink, titles, synonyms, tag) publish themselves to the cloud after a short
 * quiet period. There is no button — the file is a cache of what the library
 * already knows, and a user editing a title should not have to think about it.
 *
 * Three rules keep this from becoming a nuisance or a loop:
 *
 * - Debounced per series, so typing in the tag field writes once, not per keystroke.
 * - Gated on a *writable* connected provider and on the series actually having a
 *   backup — publishing an index for a series that exists nowhere in the cloud
 *   would create folders out of thin air.
 * - Driven by `registerFactsChangeListener`, which only fires for local fact
 *   edits. Facts arriving FROM a sidecar (`upsertFromSeriesFile`) never
 *   schedule a write, so two devices cannot ping-pong the same file.
 * - Preceded by ONE cloud listing refresh per flush (shared by every series in
 *   it), because the write merges and prunes against that listing.
 *
 * Failures are logged and dropped: the next edit or backup rewrites the file.
 */

/** Long enough to swallow a burst of field edits, short enough to feel immediate. */
export const SERIES_FILE_WRITE_DEBOUNCE_MS = 2000;

/** series_key → pending timer. */
const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** series_key → the title to write with (the folder name, never derived). */
const pendingTitles = new Map<string, string>();

/** Is there a connected provider that can actually be written to? */
function hasWritableProvider(): boolean {
  const status = get(providerManager.status);
  if (!status.hasAnyAuthenticated) return false;
  const type = status.currentProviderType;
  if (!type) return false;
  return status.providers[type]?.isReadOnly !== true;
}

/**
 * Does this series have at least one volume backed up? Checked per volume
 * against the cloud listing rather than "the folder exists", so a stray sidecar
 * or an empty folder does not qualify.
 */
async function hasBackedUpVolume(seriesTitle: string): Promise<boolean> {
  const key = normalizeSeriesKey(seriesTitle);
  const volumes = (await db.volumes.toArray()) as VolumeMetadata[];
  return volumes.some((volume) => {
    if (volume.isPlaceholder) return false;
    if (normalizeSeriesKey(volume.series_title) !== key) return false;
    return unifiedCloudManager
      .getManagedCloudFilesForVolume(seriesTitle, volume.volume_title)
      .some((file) => file.path.toLowerCase().endsWith('.cbz'));
  });
}

/**
 * The listing refresh shared by everything flushed together, or `null` between
 * flushes.
 *
 * `writeSeriesFile` merges on top of the cloud copy the listing points at and
 * prunes against the volumes the listing shows, so a listing that predates
 * another device's write would erase that device's link and its newer volumes
 * on every edit. The refresh closes that window — but there is no per-folder
 * listing in the provider interface, so it is a whole-account fetch and a
 * burst of edits must not stack one per series: the first flusher starts it and
 * everyone flushed while it is in flight awaits the same promise.
 */
let listingRefresh: Promise<boolean> | null = null;

/** Refresh the cloud listing (coalesced). `false` = the view is still stale. */
function refreshCloudListing(): Promise<boolean> {
  if (listingRefresh) return listingRefresh;

  // Deferred to a microtask so the promise identity below exists before the
  // body can settle, whatever the provider does synchronously.
  const refresh = Promise.resolve().then(async () => {
    try {
      // No index refresh: that pass downloads sidecars, and this is a write
      // path that is about to publish one.
      await unifiedCloudManager.fetchAllCloudVolumes({ refreshIndexes: false });
      return true;
    } catch (error) {
      console.debug('[series-file-sync] could not refresh the cloud listing:', error);
      return false;
    }
  });

  listingRefresh = refresh;
  // Cleared once settled, so the NEXT flush gets its own listing.
  void refresh.finally(() => {
    if (listingRefresh === refresh) listingRefresh = null;
  });
  return refresh;
}

async function runWrite(seriesKey: string): Promise<void> {
  timers.delete(seriesKey);
  const seriesTitle = pendingTitles.get(seriesKey);
  pendingTitles.delete(seriesKey);
  if (!seriesTitle) return;

  try {
    if (!hasWritableProvider()) return;
    // Both gates below read the listing, so refresh it first — and skip the
    // write entirely when that fails rather than publish a file built from a
    // view we know may be hours old.
    if (!(await refreshCloudListing())) return;
    if (!(await hasBackedUpVolume(seriesTitle))) return;
    await unifiedCloudManager.writeSeriesFile(seriesTitle);
  } catch (error) {
    console.warn(`[series-file-sync] failed to write series.json for '${seriesTitle}':`, error);
  }
}

/**
 * Queue a `series.json` write for this series, coalescing anything already
 * queued for it. Safe to call from any edit path — the gates are evaluated when
 * the timer fires, not now.
 */
export function scheduleSeriesFileWrite(seriesTitle: string): void {
  const key = normalizeSeriesKey(seriesTitle);
  if (!key) return;

  pendingTitles.set(key, seriesTitle);
  const existing = timers.get(key);
  if (existing) clearTimeout(existing);
  timers.set(
    key,
    setTimeout(() => void runWrite(key), SERIES_FILE_WRITE_DEBOUNCE_MS)
  );
}

/** Run every queued write now (cancelling its timer). For tests and teardown. */
export async function flushSeriesFileWrites(): Promise<void> {
  const keys = [...timers.keys()];
  for (const key of keys) {
    clearTimeout(timers.get(key)!);
    timers.delete(key);
  }
  await Promise.all(keys.map((key) => runWrite(key)));
}

let teardown: (() => void) | null = null;

/**
 * Subscribe the debounced writer to local fact edits. Idempotent — a second
 * call while one is live returns the same disposer instead of registering the
 * listener twice. Mounted once in `+layout.svelte`.
 */
export function initSeriesFileSync(): () => void {
  if (!browser) return () => {};
  if (teardown) return teardown;

  const unregister = registerFactsChangeListener((seriesTitle) =>
    scheduleSeriesFileWrite(seriesTitle)
  );

  const dispose = () => {
    if (teardown !== dispose) return;
    teardown = null;
    unregister();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    pendingTitles.clear();
  };

  teardown = dispose;
  return dispose;
}
