import { db } from '$lib/catalog/db';
import type { VolumeData, VolumeMetadata } from '$lib/types';
import { liveQuery } from 'dexie';
import { derived, readable, type Readable } from 'svelte/store';
import { deriveSeriesFromVolumes } from '$lib/catalog/catalog';
import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
import { generatePlaceholders } from '$lib/catalog/placeholders';
import { routeParams } from '$lib/util/hash-router';

// Single source of truth from the database
// Initial value is null to indicate "loading" state (vs {} which means "loaded but empty")
export const volumes = readable<Record<string, VolumeMetadata> | null>(null, (set) => {
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
// Returns null while volumes are still loading
export const volumesWithPlaceholders = derived(
  [volumes, unifiedCloudManager.cloudFiles],
  ([$volumes, $cloudFiles]) => {
    // Propagate loading state
    if ($volumes === null) {
      return null;
    }

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
  null as Record<string, VolumeMetadata> | null
);

// Each derived store needs to be passed as an array if using multiple inputs
// Returns null while loading, [] when loaded but empty
export const catalog = derived([volumesWithPlaceholders], ([$volumesWithPlaceholders]) => {
  // Propagate loading state (null means still loading)
  if ($volumesWithPlaceholders === null) {
    return null;
  }
  return deriveSeriesFromVolumes(Object.values($volumesWithPlaceholders));
});

// Returns null while catalog is loading, [] if series not found after load
export const currentSeries = derived([routeParams, catalog], ([$routeParams, $catalog]) => {
  // Propagate loading state
  if ($catalog === null) return null;
  if (!$routeParams.manga) return [];

  // Primary: match by title (folder name) - handles placeholder→local transition
  let series = $catalog.find((s) => s.title === $routeParams.manga);

  // Fallback: match by UUID (for legacy URLs)
  if (!series) {
    series = $catalog.find((s) => s.series_uuid === $routeParams.manga);
  }

  return series?.volumes || [];
});

// Returns null while volumes are loading, undefined if volume not found after load
export const currentVolume = derived([routeParams, volumes], ([$routeParams, $volumes]) => {
  // Propagate loading state
  if ($volumes === null) return null;

  if ($routeParams && $routeParams.volume) {
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
      currentVolumeDataLoadedUuid = undefined;
      currentVolumeDataRequestId++;
      // Clear old data synchronously to prevent state leaks between volumes
      set(undefined);
    }

    if ($currentVolume) {
      // If this volume's data is already loaded, skip redundant re-fetches.
      // This prevents reader flashes when unrelated volumes are imported.
      if (currentVolumeDataLoadedUuid === $currentVolume.volume_uuid) {
        return;
      }

      const requestId = ++currentVolumeDataRequestId;
      const volumeUuid = $currentVolume.volume_uuid;

      // Assemble VolumeData from volume_ocr and volume_files tables
      Promise.all([
        db.volume_ocr.get(volumeUuid),
        db.volume_files.get(volumeUuid)
      ]).then(([ocr, files]) => {
        // Ignore stale async results if user navigated away while fetching.
        if (requestId !== currentVolumeDataRequestId) {
          return;
        }

        currentVolumeDataLoadedUuid = volumeUuid;
        if (ocr) {
          set({
            volume_uuid: volumeUuid,
            pages: ocr.pages,
            files: files?.files
          });
        } else {
          set(undefined);
        }
      });
    }
  },
  undefined // Initial value
);

// Track last volume UUID to prevent unnecessary data clears
let currentVolumeDataLastUuid: string | undefined;
// Track which volume UUID has fully loaded data in currentVolumeData.
let currentVolumeDataLoadedUuid: string | undefined;
// Monotonic token to ignore stale async fetches.
let currentVolumeDataRequestId = 0;

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
