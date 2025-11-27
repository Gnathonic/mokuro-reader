import type { VolumeMetadata, VolumeOCR, VolumeFiles } from '$lib/types';
import Dexie, { type Table } from 'dexie';
import { generateThumbnail } from '$lib/catalog/thumbnails';
import { browser } from '$app/environment';

function naturalSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export class CatalogDexieV3 extends Dexie {
  volumes!: Table<VolumeMetadata>;
  volume_ocr!: Table<VolumeOCR>;
  volume_files!: Table<VolumeFiles>;

  constructor(dbName: string = 'mokuro_v3') {
    super(dbName);

    // v3 schema: 3 tables (thumbnails are inlined in volumes)
    this.version(1).stores({
      volumes: 'volume_uuid, series_uuid, series_title',
      volume_ocr: 'volume_uuid',
      volume_files: 'volume_uuid'
    });
  }

  async processThumbnails(batchSize: number = 5): Promise<void> {
    // Get volumes that need thumbnail generation/regeneration
    // Missing any of thumbnail, width, or height indicates need for (re)generation
    const volumesNeedingThumbnails = await this.volumes
      .filter((vol) => !vol.thumbnail || !vol.thumbnail_width || !vol.thumbnail_height)
      .primaryKeys();

    if (volumesNeedingThumbnails.length === 0) return;

    // Process in batches
    const batch = volumesNeedingThumbnails.slice(0, batchSize);

    await Promise.all(
      batch.map(async (volumeUuid) => {
        try {
          const files = await this.volume_files.get(volumeUuid as string);
          if (files && files.files) {
            // Get the first image file when sorted naturally
            const fileNames = Object.keys(files.files).sort(naturalSort);
            const firstImageFile = fileNames.length > 0 ? files.files[fileNames[0]] : null;

            if (firstImageFile) {
              const thumbnailResult = await generateThumbnail(firstImageFile);
              // Store thumbnail and dimensions directly in volumes table
              await this.volumes.update(volumeUuid as string, {
                thumbnail: thumbnailResult.file,
                thumbnail_width: thumbnailResult.width,
                thumbnail_height: thumbnailResult.height
              });
            }
          }
        } catch (error) {
          console.error('Failed to generate thumbnail for volume:', volumeUuid, error);
        }
      })
    );

    // Continue processing remaining volumes
    if (volumesNeedingThumbnails.length > batchSize) {
      await this.processThumbnails(batchSize);
    }
  }
}

// Singleton instance - will be initialized after migration check
let dbInstance: CatalogDexieV3 | null = null;

export function getV3Database(): CatalogDexieV3 {
  if (!dbInstance) {
    dbInstance = new CatalogDexieV3();
  }
  return dbInstance;
}

// Start thumbnail processing in the background
export function startThumbnailProcessing(): void {
  if (!browser) return;

  const db = getV3Database();
  setTimeout(() => {
    db.processThumbnails().catch((error) => {
      console.error('Error in thumbnail processing:', error);
    });
  }, 1000);
}
