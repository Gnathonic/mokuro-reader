import type { VolumeData, VolumeMetadata } from '$lib/types';
import Dexie, { type Table } from 'dexie';
import { generateThumbnail } from '$lib/catalog/thumbnails';
import { writable } from 'svelte/store';
import { browser } from '$app/environment';

function naturalSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export const isUpgrading = writable(false);

export class CatalogDexie extends Dexie {
  volumes!: Table<VolumeMetadata>;
  volumes_data!: Table<VolumeData>;
  catalog!: Table<{ id: string; manga: any[] }>;

  constructor() {
    super('mokuro');
    this.version(1).stores({
      catalog: 'id, manga'
    });

    // Add volumes table with all fields from MokuroData and Volume types
    this.version(2)
      .stores({
        volumes_data: 'volume_uuid',
        volumes: 'volume_uuid',
        catalog: null // Remove old catalog table
      })
      .upgrade(async (tx) => {
        isUpgrading.set(true);
        const oldCatalog = await tx.table('catalog').toArray();
        const volumes: VolumeMetadata[] = [];
        const volumes_data: VolumeData[] = [];

        for (const entry of oldCatalog) {
          for (const volume of entry.manga) {
            volumes.push({
              mokuro_version: volume.mokuroData.version,
              series_title: volume.mokuroData.title,
              series_uuid: volume.mokuroData.title_uuid,
              page_count: volume.mokuroData.pages.length,
              character_count: volume.mokuroData.chars,
              volume_title: volume.mokuroData.volume,
              volume_uuid: volume.mokuroData.volume_uuid
            });
            volumes_data.push({
              volume_uuid: volume.mokuroData.volume_uuid,
              pages: volume.mokuroData.pages,
              files: volume.files
            });
          }
        }

        await tx.table('volumes').bulkAdd(volumes);
        await tx.table('volumes_data').bulkAdd(volumes_data);
      });

    // Only start thumbnail processing in browser environment
    if (browser) {
      startThumbnailProcessing();
    }
  }

  async processThumbnails(batchSize: number = 5): Promise<void> {
    // Get volumes without thumbnails and not currently being processed
    const volumes = await this.volumes
      .filter((volume) => !volume.thumbnail)
      .limit(batchSize)
      .toArray();

    if (volumes.length === 0) return;

    // Process thumbnails in parallel
    await Promise.all(
      volumes.map(async (volume) => {
        try {
          // Properly await the data fetch
          const data = await db.volumes_data.get({ volume_uuid: volume.volume_uuid });
          if (data && data.files) {
            // Get the first image file when sorted naturally
            const fileNames = Object.keys(data.files).sort(naturalSort);
            const firstImageFile = fileNames.length > 0 ? data.files[fileNames[0]] : null;

            if (firstImageFile) {
              const thumbnail = await generateThumbnail(firstImageFile);
              // Update the volume with the thumbnail
              volume.thumbnail = thumbnail;
              await this.volumes.where('volume_uuid').equals(volume.volume_uuid).modify(volume);
            }
          }
        } catch (error) {
          console.error('Failed to generate thumbnail for volume:', volume.volume_uuid, error);
        }
      })
    );

    // Continue processing remaining volumes
    await this.processThumbnails(batchSize);
  }
}

export const db = new CatalogDexie();

// Start thumbnail processing in the background
export function startThumbnailProcessing(): void {
  // Process thumbnails in the background
  setTimeout(() => {
    db.processThumbnails().catch((error) => {
      console.error('Error in thumbnail processing:', error);
    });
  }, 1000); // Start after 1 second delay to let the app initialize
}
