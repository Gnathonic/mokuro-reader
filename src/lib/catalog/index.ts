import { page } from '$app/stores';
import { db } from '$lib/catalog/db';
import type { VolumeData, VolumeMetadata } from '$lib/types';
import { liveQuery } from 'dexie';
import { derived, readable, type Readable } from 'svelte/store';
import { deriveSeriesFromVolumes } from '$lib/catalog/catalog';
import { reconcileDriveWithLocal } from '$lib/catalog/placeholders';
import { driveFilesCache, tokenManager } from '$lib/util/google-drive';

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

// Catalog merges local volumes with Drive placeholders
// When authenticated, adds placeholder volumes for Drive-only files
export const catalog = derived(
  [volumes, driveFilesCache.store, tokenManager.token],
  ([$volumes, $driveCache, $token], set) => {
    const localVolumes = Object.values($volumes);

    // If authenticated and cache is populated, reconcile with Drive
    if ($token && $driveCache.size > 0) {
      const driveFiles = Array.from($driveCache.values());
      reconcileDriveWithLocal(localVolumes, driveFiles).then((reconciledVolumes) => {
        set(deriveSeriesFromVolumes(reconciledVolumes));
      });
    } else {
      // Not authenticated or no cache - just show local volumes
      set(deriveSeriesFromVolumes(localVolumes));
    }
  }
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

export const currentVolumeData: Readable<VolumeData | undefined> = derived(
  [currentVolume],
  ([$currentVolume], set) => {
    if ($currentVolume) {
      db.volumes_data.get($currentVolume.volume_uuid).then((data) => {
        if (data) {
          set(data as VolumeData);
        }
      });
    } else {
      set(undefined);
    }
  }
);
