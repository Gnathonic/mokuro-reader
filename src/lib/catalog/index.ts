import { db } from '$lib/catalog/db';
import type { VolumeData, VolumeMetadata } from '$lib/types';
import { liveQuery } from 'dexie';
import { derived, readable, type Readable } from 'svelte/store';
import { deriveSeriesFromVolumes } from '$lib/catalog/catalog';
import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
import { generatePlaceholders } from '$lib/catalog/placeholders';
import { routeParams } from '$lib/util/hash-router';

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
  ([$volumes, $cloudFiles]) => {
    // Skip placeholder generation if no cloud files
    if ($cloudFiles.size === 0) {
      return $volumes;
    }

    // Generate placeholders synchronously
    const placeholders = generatePlaceholders($cloudFiles, Object.values($volumes));

    // Combine local volumes with placeholders
    const combined = { ...$volumes };

    for (const placeholder of placeholders) {
      combined[placeholder.volume_uuid] = placeholder;
    }

    return combined;
  },
  {} as Record<string, VolumeMetadata>
);

// Each derived store needs to be passed as an array if using multiple inputs
export const catalog = derived([volumesWithPlaceholders], ([$volumesWithPlaceholders]) => {
  // Return null while loading (before first data emission)
  if ($volumesWithPlaceholders === undefined) {
    return null;
  }
  return deriveSeriesFromVolumes(Object.values($volumesWithPlaceholders));
});

export const currentSeries = derived([routeParams, catalog], ([$routeParams, $catalog]) =>
  ($catalog?.find((volume) => volume.series_uuid === $routeParams.manga)?.volumes || []).sort(
    sortVolumes
  )
);

export const currentVolume = derived([routeParams, volumes], ([$routeParams, $volumes]) => {
  if ($routeParams && $volumes && $routeParams.volume) {
    return $volumes[$routeParams.volume]; // Direct lookup instead of find()
  }
  return undefined;
});

export const currentVolumeData: Readable<VolumeData | undefined> = derived(
  [currentVolume],
  ([$currentVolume], set: (value: VolumeData | undefined) => void) => {
    // Track the last volume UUID to avoid unnecessary clears
    // This prevents flash when unrelated volumes are added to the database
    const newUuid = $currentVolume?.volume_uuid;

    // Only clear data when actually navigating to a different volume
    // Don't clear if the store just emitted a new object reference for the same volume
    if (newUuid !== currentVolumeDataLastUuid) {
      currentVolumeDataLastUuid = newUuid;
      // Clear old data synchronously to prevent state leaks between volumes
      set(undefined);
    }

    if ($currentVolume) {
      // Assemble VolumeData from volume_ocr and volume_files tables
      Promise.all([
        db.volume_ocr.get($currentVolume.volume_uuid),
        db.volume_files.get($currentVolume.volume_uuid)
      ]).then(([ocr, files]) => {
        if (ocr) {
          set({
            volume_uuid: $currentVolume.volume_uuid,
            pages: ocr.pages,
            files: files?.files
          });
        }
      });
    }
  },
  undefined // Initial value
);

// Track last volume UUID to prevent unnecessary data clears
let currentVolumeDataLastUuid: string | undefined;

/**
 * Japanese character count for current volume.
 * Uses page_char_counts from metadata for O(1) lookup when available.
 */
export const currentVolumeCharacterCount = derived(
  [currentVolume, currentVolumeData],
  ([$currentVolume, $currentVolumeData]) => {
    if (!$currentVolume) return 0;

    // Use pre-calculated cumulative char counts from metadata (v3)
    if ($currentVolume.page_char_counts && $currentVolume.page_char_counts.length > 0) {
      // Last element of cumulative array is the total
      return $currentVolume.page_char_counts[$currentVolume.page_char_counts.length - 1];
    }

    // Fallback: calculate from pages if page_char_counts not available
    if ($currentVolumeData && $currentVolumeData.pages) {
      const japaneseRegex =
        /[○◯々-〇〻ぁ-ゖゝ-ゞァ-ヺー\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

      let totalChars = 0;
      for (const page of $currentVolumeData.pages) {
        for (const block of page.blocks) {
          for (const line of block.lines) {
            totalChars += Array.from(line).filter((char) => japaneseRegex.test(char)).length;
          }
        }
      }
      return totalChars;
    }

    return 0;
  }
);
