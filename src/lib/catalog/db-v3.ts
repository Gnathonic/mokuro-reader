import type { VolumeMetadata, VolumeOCR, VolumeFiles } from '$lib/types';
import type { StoredSeriesMetadata } from '$lib/metadata/types';
import type { SeriesIndexRecord } from '$lib/metadata/series-index';
import type { CatalogIndexRecord } from '$lib/metadata/catalog-index';
import type { CloudCover } from './cloud-covers';
import Dexie, { type Table } from 'dexie';
import { generateThumbnail } from '$lib/catalog/thumbnails';
import { browser } from '$app/environment';
import { progressTrackerStore } from '$lib/util/progress-tracker';
import { naturalSort } from '$lib/util/natural-sort';
import { isVolumeInstalled } from '$lib/catalog/volume-state';
import { MOKURO_DB_NAME, declareMokuroSchema } from './db-schema';

export class CatalogDexieV3 extends Dexie {
  volumes!: Table<VolumeMetadata>;
  volume_ocr!: Table<VolumeOCR>;
  volume_files!: Table<VolumeFiles>;
  series_metadata!: Table<StoredSeriesMetadata>;
  series_index!: Table<SeriesIndexRecord>;
  catalog_index!: Table<CatalogIndexRecord>;
  cloud_covers!: Table<CloudCover>;

  constructor(dbName: string = MOKURO_DB_NAME) {
    super(dbName);

    // The one declaration, shared with every other connection to this database
    // (the export Worker's in `compress-volume.ts`, the test fixtures). See
    // `db-schema.ts` for what a divergence costs.
    declareMokuroSchema(this);
  }

  async processThumbnails(batchSize: number = 5): Promise<void> {
    const processId = 'thumbnail-generation';

    // Get volumes that need thumbnail generation/regeneration
    // Missing any of thumbnail, width, or height indicates need for (re)generation.
    // Metadata-only rows are excluded: their images are not on this device, so
    // there is nothing to generate from and every pass would retry them forever.
    const volumesNeedingThumbnails = await this.volumes
      .filter(
        (vol) =>
          isVolumeInstalled(vol) &&
          (!vol.thumbnail || !vol.thumbnail_width || !vol.thumbnail_height)
      )
      .primaryKeys();

    if (volumesNeedingThumbnails.length === 0) return;

    const total = volumesNeedingThumbnails.length;
    let processed = 0;

    // Add process to tracker
    progressTrackerStore.addProcess({
      id: processId,
      description: 'Generating thumbnails',
      status: `0 / ${total}`,
      progress: 0
    });

    try {
      // Process all volumes in batches
      for (let i = 0; i < total; i += batchSize) {
        const batch = volumesNeedingThumbnails.slice(i, i + batchSize);

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

        // Update progress after each batch
        processed += batch.length;
        const percent = Math.round((processed / total) * 100);
        progressTrackerStore.updateProcess(processId, {
          status: `${processed} / ${total}`,
          progress: percent
        });
      }
    } finally {
      // Remove process from tracker after a short delay
      setTimeout(() => progressTrackerStore.removeProcess(processId), 2000);
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
