import { page } from '$app/stores';
import { db } from '$lib/catalog/db';
import type { VolumeData, VolumeMetadata } from '$lib/types';
import { liveQuery } from 'dexie';
import { derived, readable, type Readable } from 'svelte/store';
import { deriveSeriesFromVolumes } from '$lib/catalog/catalog';
import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
import { generatePlaceholders } from '$lib/catalog/placeholders';

function sortVolumes(a: VolumeMetadata, b: VolumeMetadata) {
  if (a.volume_title < b.volume_title) {
    return -1;
  }
  if (a.volume_title > b.volume_title) {
    return 1;
  }
  return 0;
}

// Single source of truth from the database
export const volumes = readable<Record<string, VolumeMetadata>>({}, (set) => {
  const subscription = liveQuery(async () => {
    const volumesArray = await db.volumes.toArray();

    return volumesArray.reduce(
      (acc, vol) => {
        acc[vol.volume_uuid] = vol;
        return acc;
      },
      {} as Record<string, VolumeMetadata>
    );
  }).subscribe({
    next: (value) => set(value),
    error: (err) => console.error(err)
  });
  return () => subscription.unsubscribe();
});

// Merge local volumes with cloud placeholders
export const volumesWithPlaceholders = derived(
  [volumes, unifiedCloudManager.cloudFiles],
  ([$volumes, $cloudFiles], set) => {
    const t0 = performance.now();
    console.log('[CATALOG] >>> volumesWithPlaceholders derived triggered, cloudFiles size:', $cloudFiles.size);

    // Early return if no cloud files - avoids unnecessary work
    if ($cloudFiles.size === 0) {
      console.log('[CATALOG] >>> No cloud files, skipping placeholder generation');
      set($volumes);
      const t1 = performance.now();
      console.log(`[CATALOG] ⏱️ Total time: ${(t1 - t0).toFixed(2)}ms (early return)`);
      return;
    }

    // Generate placeholders from cloud files
    console.log('[CATALOG] >>> About to call generatePlaceholders()');
    // Pass existing volumes to avoid re-reading from IndexedDB
    const t1 = performance.now();
    const localVolumesArray = Object.values($volumes);
    const t2 = performance.now();
    console.log(`[CATALOG] ⏱️ Object.values() took ${(t2 - t1).toFixed(2)}ms`);

    generatePlaceholders($cloudFiles, localVolumesArray).then(placeholders => {
      const t3 = performance.now();
      console.log('[CATALOG] >>> generatePlaceholders() resolved with', placeholders.length, 'placeholders');
      console.log(`[CATALOG] ⏱️ generatePlaceholders() took ${(t3 - t2).toFixed(2)}ms`);

      // Combine local volumes with placeholders
      const t4 = performance.now();
      const combined = { ...$volumes };
      const t5 = performance.now();
      console.log(`[CATALOG] ⏱️ Spreading $volumes took ${(t5 - t4).toFixed(2)}ms`);

      const t6 = performance.now();
      for (const placeholder of placeholders) {
        combined[placeholder.volume_uuid] = placeholder;
      }
      const t7 = performance.now();
      console.log(`[CATALOG] ⏱️ Adding ${placeholders.length} placeholders took ${(t7 - t6).toFixed(2)}ms`);

      console.log('[CATALOG] >>> About to call set() with combined volumes');
      set(combined);
      const t8 = performance.now();
      console.log('[CATALOG] >>> set() completed');
      console.log(`[CATALOG] ⏱️ Total time: ${(t8 - t0).toFixed(2)}ms`);
    }).catch(error => {
      console.error('[CATALOG] Failed to generate placeholders:', error);
      // On error, just use local volumes
      set($volumes);
    });
  },
  undefined as Record<string, VolumeMetadata> | undefined
);

// Each derived store needs to be passed as an array if using multiple inputs
export const catalog = derived([volumesWithPlaceholders], ([$volumesWithPlaceholders]) => {
  const t0 = performance.now();
  // Return null while loading (before first data emission)
  if ($volumesWithPlaceholders === undefined) {
    return null;
  }

  const t1 = performance.now();
  const volumesArray = Object.values($volumesWithPlaceholders);
  const t2 = performance.now();
  console.log(`[CATALOG] ⏱️ catalog derived: Object.values() took ${(t2 - t1).toFixed(2)}ms`);

  const result = deriveSeriesFromVolumes(volumesArray);
  const t3 = performance.now();
  console.log(`[CATALOG] ⏱️ catalog derived: Total time ${(t3 - t0).toFixed(2)}ms`);

  return result;
});

export const currentSeries = derived([page, catalog], ([$page, $catalog]) =>
  ($catalog?.find((volume) => volume.series_uuid === $page.params.manga)?.volumes || []).sort(
    sortVolumes
  )
);

export const currentVolume = derived([page, volumes], ([$page, $volumes]) => {
  if ($page && $volumes && $page.params.volume) {
    return $volumes[$page.params.volume]; // Direct lookup instead of find()
  }
  return undefined;
});

// v3: Load volume data from volumes_data table (OCR only)
export const currentVolumeData: Readable<VolumeData | undefined> = derived(
  [currentVolume],
  ([$currentVolume], set: (value: VolumeData | undefined) => void) => {
    // CRITICAL: Immediately clear old data synchronously to prevent state leaks
    set(undefined);

    if (!$currentVolume) return;

    const subscription = liveQuery(async () => {
      const volumeData = await db.volumes_data.get($currentVolume.volume_uuid);
      return volumeData;
    }).subscribe({
      next: (value) => set(value),
      error: (err) => console.error('[catalog] Failed to load volume data:', err)
    });

    return () => subscription.unsubscribe();
  },
  undefined // Initial value
);

// v3: Load volume images from volumes_images table
export const currentVolumeImages: Readable<Record<number, File> | undefined> = derived(
  [currentVolume],
  ([$currentVolume], set: (value: Record<number, File> | undefined) => void) => {
    // CRITICAL: Immediately clear old data synchronously to prevent state leaks
    set(undefined);

    if (!$currentVolume) return;

    const subscription = liveQuery(async () => {
      const images = await db.volumes_images
        .where('volume_uuid')
        .equals($currentVolume.volume_uuid)
        .toArray();

      // Convert array to Record<page_number, File> for easy lookup
      const imageMap: Record<number, File> = {};
      for (const img of images) {
        imageMap[img.page_number] = img.image;
      }
      return imageMap;
    }).subscribe({
      next: (value) => set(value),
      error: (err) => console.error('[catalog] Failed to load volume images:', err)
    });

    return () => subscription.unsubscribe();
  },
  undefined // Initial value
);

/**
 * Japanese character count for current volume
 * v3: Uses pre-calculated character_count from metadata (no OCR parsing needed!)
 */
export const currentVolumeCharacterCount = derived(
  [currentVolume],
  ([$currentVolume]) => {
    if (!$currentVolume) return 0;
    return $currentVolume.character_count || 0;
  }
);

/**
 * v3: Helper functions to load related data on-demand
 */

/**
 * Get volume cover thumbnail as a reactive store
 * Returns a readable store that updates when the thumbnail changes
 */
export function getVolumeCover(volumeUuid: string): Readable<File | undefined> {
  return readable<File | undefined>(undefined, (set) => {
    const subscription = liveQuery(async () => {
      const cover = await db.volumes_covers.get(volumeUuid);
      return cover?.thumbnail;
    }).subscribe({
      next: (value) => set(value),
      error: (err) => console.error(err)
    });
    return () => subscription.unsubscribe();
  });
}

/**
 * Get volume cover thumbnail (one-time fetch, not reactive)
 */
export async function fetchVolumeCover(volumeUuid: string): Promise<File | undefined> {
  const cover = await db.volumes_covers.get(volumeUuid);
  return cover?.thumbnail;
}
