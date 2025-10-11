import { page } from '$app/stores';
import { db } from '$lib/catalog/db';
import type { VolumeData, VolumeMetadata } from '$lib/types';
import { liveQuery } from 'dexie';
import { derived, readable, type Readable } from 'svelte/store';
import { deriveSeriesFromVolumes } from '$lib/catalog/catalog';
import { driveFilesCache } from '$lib/util/google-drive/drive-files-cache';
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

// Merge local volumes with Drive placeholders
export const volumesWithPlaceholders = derived(
  [volumes, driveFilesCache.store],
  ([$volumes, $driveCache], set) => {
    // Generate placeholders from Drive files
    const driveFiles = Array.from($driveCache.values()).flat();

    generatePlaceholders(driveFiles).then(placeholders => {
      // Combine local volumes with placeholders
      const combined = { ...$volumes };

      for (const placeholder of placeholders) {
        combined[placeholder.volume_uuid] = placeholder;
      }

      set(combined);
    }).catch(error => {
      console.error('Failed to generate placeholders:', error);
      // On error, just use local volumes
      set($volumes);
    });
  },
  {} as Record<string, VolumeMetadata>
);

// Each derived store needs to be passed as an array if using multiple inputs
export const catalog = derived([volumesWithPlaceholders], ([$volumesWithPlaceholders]) =>
  deriveSeriesFromVolumes(Object.values($volumesWithPlaceholders))
);

export const currentSeries = derived([page, catalog], ([$page, $catalog]) =>
  ($catalog.find((volume) => volume.series_uuid === $page.params.manga)?.volumes || []).sort(
    sortVolumes
  )
);

export const currentVolume = derived([page, volumes], ([$page, $volumes]) => {
  if ($page && $volumes) {
    return $volumes[$page.params.volume]; // Direct lookup instead of find()
  }
  return undefined;
});

// Track the last volume UUID outside the derived store to maintain state across updates
let lastVolumeUuid: string | undefined;

export const currentVolumeData: Readable<VolumeData | undefined> = derived(
  [currentVolume],
  ([$currentVolume], set: (value: VolumeData | undefined) => void) => {
    const newVolumeUuid = $currentVolume?.volume_uuid;

    // Only clear data if we're actually navigating to a different volume
    // This prevents flashing when unrelated volumes are added to the catalog
    if (newVolumeUuid !== lastVolumeUuid) {
      // Navigation detected - clear old data to prevent state leaks
      set(undefined);
      lastVolumeUuid = newVolumeUuid;
    }

    if ($currentVolume) {
      db.volumes_data.get($currentVolume.volume_uuid).then((data) => {
        // Verify this is still the current volume before setting
        // (user might have navigated away during the async gap)
        if (data && $currentVolume.volume_uuid === lastVolumeUuid) {
          set(data);
        }
      });
    }
  },
  undefined // Initial value
);
