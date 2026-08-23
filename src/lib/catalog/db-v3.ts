import type { VolumeMetadata, VolumeOCR, VolumeFiles } from '$lib/types';
import type { SeriesMetadata } from '$lib/metadata/types';
import type { SeriesIndexRecord } from '$lib/metadata/series-index';
import type { CatalogIndexRecord } from '$lib/metadata/catalog-index';
import Dexie, { type Table } from 'dexie';
import { generateThumbnail } from '$lib/catalog/thumbnails';
import { browser } from '$app/environment';
import { progressTrackerStore } from '$lib/util/progress-tracker';
import { naturalSort } from '$lib/util/natural-sort';
import { isVolumeInstalled } from '$lib/catalog/volume-state';

export class CatalogDexieV3 extends Dexie {
  volumes!: Table<VolumeMetadata>;
  volume_ocr!: Table<VolumeOCR>;
  volume_files!: Table<VolumeFiles>;
  series_metadata!: Table<SeriesMetadata>;
  series_index!: Table<SeriesIndexRecord>;
  catalog_index!: Table<CatalogIndexRecord>;

  constructor(dbName: string = 'mokuro_v3') {
    super(dbName);

    // v3 schema: 3 tables (thumbnails are inlined in volumes)
    this.version(1).stores({
      volumes: 'volume_uuid, series_uuid, series_title',
      volume_ocr: 'volume_uuid',
      volume_files: 'volume_uuid'
    });

    // v3.2: per-series metadata (AniList link, titles, tag, tracking). Keyed by
    // normalizeSeriesKey(series_title). Additive — no data migration.
    this.version(2).stores({
      volumes: 'volume_uuid, series_uuid, series_title',
      volume_ocr: 'volume_uuid',
      volume_files: 'volume_uuid',
      series_metadata: 'series_key'
    });

    // v3.3: cached per-series series.json sidecar (facts + unauthoritative volume
    // index), keyed the same as series_metadata. Additive — no data migration.
    this.version(3).stores({
      volumes: 'volume_uuid, series_uuid, series_title',
      volume_ocr: 'volume_uuid',
      volume_files: 'volume_uuid',
      series_metadata: 'series_key',
      series_index: 'series_key'
    });

    // v3.4: cached root catalog.json entries (name/mapping/search data per
    // series, plus the cloud file stamp they were fetched at). Keyed the same as
    // series_metadata/series_index. Additive — no data migration.
    this.version(4).stores({
      volumes: 'volume_uuid, series_uuid, series_title',
      volume_ocr: 'volume_uuid',
      volume_files: 'volume_uuid',
      series_metadata: 'series_key',
      series_index: 'series_key',
      catalog_index: 'series_key'
    });
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
