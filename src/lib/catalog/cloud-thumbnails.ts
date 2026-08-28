import type { VolumeMetadata } from '$lib/types';
import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';

export interface CloudThumbnailResult {
  file: File;
  width: number;
  height: number;
}

// Session cache: volumeUuid -> result
const cache = new Map<string, CloudThumbnailResult>();

// Coalesce concurrent requests for the same volume
const pendingFetches = new Map<string, Promise<CloudThumbnailResult | null>>();

/**
 * Cover downloads in flight at once. Was 4 — a number picked at this module's
 * birth (commit 94824089), before the visible-first grant order existed, and
 * never re-justified since. Covers are tiny (~32KB mean on the reference
 * library), so the fetch is latency-bound, not bandwidth-bound: doubling the
 * parallelism roughly doubles how fast the visible screenful fills, at ~256KB
 * in flight. User ruling: the user wants to see covers asap — jank is solved
 * by backgrounding, never by pacing downloads.
 *
 * Why 8 and not higher: on an HTTP/1.1 provider (WebDAV) the browser's
 * per-host connection pool is 6, and every slot granted beyond it just parks
 * the request in the browser's own FIFO queue — where the visible-first
 * stack below can no longer reorder it. 8 keeps that spillover small enough
 * that ordering stays in our hands, while HTTP/2 providers (Drive, OneDrive,
 * MEGA) multiplex all 8 streams outright. Not split on `turboMode`: that
 * setting gates memory-heavy archive processing, and a 32KB fetch has no
 * memory-pressure story.
 */
export const MAX_CONCURRENT_FETCHES = 8;
const FETCH_TIMEOUT_MS = 15000;
let activeFetches = 0;

/**
 * A request waiting for a download slot, and — when its surface supplied one —
 * the probe that says whether that surface is STILL near the viewport
 * (`isNearViewport` via `cover-claims`). Probes are consulted only at grant
 * time, never while waiting: a handful of rect reads per second, not a
 * per-card observer.
 */
interface FetchWaiter {
  grant: () => void;
  stillNear?: () => boolean;
}

/**
 * A STACK, not a queue — LIFO with a visibility preference.
 *
 * The old FIFO shape optimized for the wrong reader: a fast scroll through a
 * big catalog enqueues a cover request for every card it passes (each one
 * crossed the viewport-gate margin), so by the time the user STOPS, the four
 * download slots are serving cards thousands of pixels behind and the covers
 * actually on screen are at the back of the line. Granting newest-first
 * inverts that: the most recently seen cards — where the user is — are served
 * first, and the flown-past backlog drains whenever nothing fresher waits.
 *
 * The visibility preference sharpens it further: at each grant the stack is
 * scanned newest-first for the first waiter whose surface is STILL near the
 * viewport, so scrolling BACK over an old, still-queued card serves it ahead
 * of newer requests the user has since left behind. When no waiter is near
 * the viewport, the newest is granted anyway — the stack always drains, no
 * request starves, and every fetched cover lands in the cache for the next
 * pass regardless.
 */
const waiters: FetchWaiter[] = [];

async function acquireFetchSlot(stillNear?: () => boolean): Promise<void> {
  if (activeFetches < MAX_CONCURRENT_FETCHES) {
    activeFetches += 1;
    return;
  }

  await new Promise<void>((resolve) => {
    waiters.push({ grant: resolve, stillNear });
  });
  activeFetches += 1;
}

function releaseFetchSlot(): void {
  activeFetches = Math.max(0, activeFetches - 1);
  if (waiters.length === 0) return;
  // Newest-first among the still-visible; a probe that throws is treated as
  // visible rather than letting one broken surface wedge the whole queue.
  for (let i = waiters.length - 1; i >= 0; i--) {
    const waiter = waiters[i];
    let near = true;
    try {
      near = waiter.stillNear ? waiter.stillNear() : true;
    } catch {
      near = true;
    }
    if (near) {
      waiters.splice(i, 1);
      waiter.grant();
      return;
    }
  }
  // Nothing visible is waiting: drain the backlog newest-first anyway.
  waiters.pop()?.grant();
}

function getThumbnailMime(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  return 'image/webp';
}

async function downloadThumbnailWithTimeout(volume: VolumeMetadata): Promise<Blob> {
  const thumbnailPath =
    volume.cloudThumbnailPath ?? `${volume.series_title}/${volume.volume_title}.webp`;
  const downloadPromise = unifiedCloudManager.downloadFile({
    provider: volume.cloudProvider!,
    fileId: volume.cloudThumbnailFileId!,
    path: thumbnailPath,
    modifiedTime: '',
    size: 0
  });

  const timeoutPromise = new Promise<Blob>((_, reject) => {
    setTimeout(
      () => reject(new Error(`Thumbnail download timed out after ${FETCH_TIMEOUT_MS}ms`)),
      FETCH_TIMEOUT_MS
    );
  });

  try {
    return await Promise.race([downloadPromise, timeoutPromise]);
  } finally {
    // Prevent unhandled rejections if the download finishes after timeout.
    void downloadPromise.catch(() => {});
  }
}

/**
 * Get a cached cloud thumbnail synchronously (returns undefined if not cached)
 */
export function getCachedCloudThumbnail(volumeUuid: string): CloudThumbnailResult | undefined {
  return cache.get(volumeUuid);
}

/**
 * Fetch a cloud thumbnail for a placeholder volume.
 * Downloads the .webp file, measures dimensions, and caches the result.
 * Coalesces concurrent requests for the same volume.
 */
export async function fetchCloudThumbnail(
  volume: VolumeMetadata,
  stillNear?: () => boolean
): Promise<CloudThumbnailResult | null> {
  if (!volume.cloudThumbnailFileId) return null;
  if (!volume.cloudProvider) return null;

  const activeProvider = unifiedCloudManager.getActiveProvider();
  if (!activeProvider || activeProvider.type !== volume.cloudProvider) {
    return null;
  }

  // Check session cache
  const cached = cache.get(volume.volume_uuid);
  if (cached) return cached;

  // Coalesce concurrent requests
  const pending = pendingFetches.get(volume.volume_uuid);
  if (pending) return pending;

  const fetchPromise = (async (): Promise<CloudThumbnailResult | null> => {
    await acquireFetchSlot(stillNear);
    try {
      const blob = await downloadThumbnailWithTimeout(volume);

      const thumbnailPath =
        volume.cloudThumbnailPath ?? `${volume.series_title}/${volume.volume_title}.webp`;
      const ext = thumbnailPath.split('.').pop()!.toLowerCase();
      const mime = getThumbnailMime(thumbnailPath);
      const file = new File([blob], `${volume.volume_title}.${ext}`, { type: mime });

      // Measure dimensions using createImageBitmap (most reliable for pixel dimensions)
      const bitmap = await createImageBitmap(file);
      const width = bitmap.width;
      const height = bitmap.height;
      bitmap.close();

      const result: CloudThumbnailResult = { file, width, height };
      cache.set(volume.volume_uuid, result);
      return result;
    } catch (error) {
      console.warn(`Failed to fetch cloud thumbnail for ${volume.volume_title}:`, error);
      return null;
    } finally {
      releaseFetchSlot();
      pendingFetches.delete(volume.volume_uuid);
    }
  })();

  pendingFetches.set(volume.volume_uuid, fetchPromise);
  return fetchPromise;
}
