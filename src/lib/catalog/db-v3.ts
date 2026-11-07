import type {
  VolumeMetadata,
  VolumeOCR,
  VolumeFiles,
  VolumeOcrLayer,
  VolumeOcrLayerPages
} from '$lib/types';
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
import { isRasterImageType, toRasterImageFile } from '$lib/util/raster-image';
import { MOKURO_DB_NAME, declareMokuroSchema } from './db-schema';

export class CatalogDexieV3 extends Dexie {
  volumes!: Table<VolumeMetadata>;
  volume_ocr!: Table<VolumeOCR>;
  volume_files!: Table<VolumeFiles>;
  series_metadata!: Table<StoredSeriesMetadata>;
  series_index!: Table<SeriesIndexRecord>;
  catalog_index!: Table<CatalogIndexRecord>;
  cloud_covers!: Table<CloudCover>;
  // One layer = a row in EACH of these two, same key — go through
  // `layer-store.ts`, never the tables directly.
  volume_ocr_layers!: Table<VolumeOcrLayer>;
  volume_ocr_layer_pages!: Table<VolumeOcrLayerPages>;

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
    // So does a stored thumbnail whose type is not a raster one, in ANY state:
    // SVG is an unsupported format (an SVG or HTML blob opened in a new tab
    // runs as the app), and rows written before that rule may hold one. Such a
    // thumbnail is re-typed from its bytes when they are raster, else dropped
    // (and rebuilt from the first page when the pages are here).
    // Metadata-only rows are otherwise excluded: their images are not on this
    // device, so there is nothing to generate from and every pass would retry
    // them forever.
    const volumesNeedingThumbnails = await this.volumes
      .filter(
        (vol) =>
          (!!vol.thumbnail && !isRasterImageType(vol.thumbnail.type)) ||
          (isVolumeInstalled(vol) &&
            (!vol.thumbnail || !vol.thumbnail_width || !vol.thumbnail_height))
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
              if (await this.repairThumbnailType(volumeUuid as string)) return;
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

  /**
   * Re-validate a stored thumbnail's type (see `processThumbnails`). Returns
   * true when the row needs nothing more: its thumbnail was re-typed from its
   * bytes and has its dimensions, or the row is not installed and there is
   * nothing to rebuild it from.
   */
  private async repairThumbnailType(volumeUuid: string): Promise<boolean> {
    const vol = await this.volumes.get(volumeUuid);
    if (!vol) return true;
    const stored = vol.thumbnail;
    if (stored && !isRasterImageType(stored.type)) {
      const name = (stored as Partial<File>).name || 'thumbnail';
      const retyped = await toRasterImageFile(stored, name);
      if (retyped) {
        await this.volumes.update(volumeUuid, { thumbnail: retyped });
        if (vol.thumbnail_width && vol.thumbnail_height) return true;
      } else {
        console.warn(
          `[thumbnails] Dropped a stored thumbnail that is not a raster image (type '${stored.type}'):`,
          volumeUuid
        );
        await this.volumes.update(volumeUuid, {
          thumbnail: undefined,
          thumbnail_width: undefined,
          thumbnail_height: undefined
        });
      }
    }
    return !isVolumeInstalled(vol);
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
