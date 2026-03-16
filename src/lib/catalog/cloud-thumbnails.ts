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
const MAX_CONCURRENT_FETCHES = 4;
const FETCH_TIMEOUT_MS = 15000;
let activeFetches = 0;
const waiters: Array<() => void> = [];

async function acquireFetchSlot(): Promise<void> {
  if (activeFetches < MAX_CONCURRENT_FETCHES) {
    activeFetches += 1;
    return;
  }

  await new Promise<void>((resolve) => {
    waiters.push(resolve);
  });
  activeFetches += 1;
}

function releaseFetchSlot(): void {
  activeFetches = Math.max(0, activeFetches - 1);
  const next = waiters.shift();
  if (next) next();
}

async function downloadThumbnailWithTimeout(volume: VolumeMetadata): Promise<Blob> {
  const downloadPromise = unifiedCloudManager.downloadFile({
    provider: volume.cloudProvider!,
    fileId: volume.cloudThumbnailFileId!,
    path: `${volume.series_title}/${volume.volume_title}.webp`,
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
  volume: VolumeMetadata
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
    await acquireFetchSlot();
    try {
      const blob = await downloadThumbnailWithTimeout(volume);

      const file = new File([blob], `${volume.volume_title}.webp`, { type: 'image/webp' });

      // Measure dimensions using createImageBitmap (most reliable for pixel dimensions)
      const bitmap = await createImageBitmap(file);
      const width = bitmap.width;
      const height = bitmap.height;
      bitmap.close();

      // Compare with Image API to detect discrepancies
      const img = new Image();
      const imgUrl = URL.createObjectURL(file);
      const imgDims = await new Promise<{ w: number; h: number }>((resolve) => {
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => resolve({ w: 0, h: 0 });
        img.src = imgUrl;
      });
      URL.revokeObjectURL(imgUrl);

      console.log(
        `[CloudThumbnail] ${volume.volume_title}: bitmap=${width}x${height}, img=${imgDims.w}x${imgDims.h}, file size: ${file.size} bytes`
      );
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
