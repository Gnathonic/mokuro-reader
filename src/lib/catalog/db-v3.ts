import type { VolumeMetadata, VolumeOCR, VolumeFiles } from '$lib/types';
import type { SeriesMetadata } from '$lib/metadata/types';
import type { SeriesIndexRecord } from '$lib/metadata/series-index';
import type { CatalogIndexRecord } from '$lib/metadata/catalog-index';
import type { CloudCover } from './cloud-covers';
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
  cloud_covers!: Table<CloudCover>;

  constructor(dbName: string = 'mokuro_v3') {
    super(dbName);

    // v1: the shipped schema — three tables, thumbnails inlined in volumes.
    // This is the only version any released build has written, so it must stay
    // exactly as-is for every existing user database to upgrade from.
    this.version(1).stores({
      volumes: 'volume_uuid, series_uuid, series_title',
      volume_ocr: 'volume_uuid',
      volume_files: 'volume_uuid'
    });

    // v2: everything the series-metadata work adds, in one step.
    //
    // Collapsed deliberately: `series_metadata`, `series_index` and
    // `catalog_index` were separate versions during development but never
    // shipped, so no database exists at those intermediate versions and the
    // steps between them are fiction. A released client upgrades 1 -> 2 once
    // and gets all four new tables.
    //
    // `cloud_covers` holds ONLY the thumbnail blob (+ dimensions) for a cloud
    // volume the user has neither installed nor read, keyed by account + path
    // because providers expose no uuid for a file the client has not opened, and
    // the same path under a different account is a different file. Everything
    // else a cloud card needs — title, counts, the cover sidecar's own
    // size/modified stamps — already lives in the cached `series_index` row for
    // that series, so this table carries no other field and needs no secondary
    // index: a read is always "these exact paths for this account."
    this.version(2).stores({
      volumes: 'volume_uuid, series_uuid, series_title',
      volume_ocr: 'volume_uuid',
      volume_files: 'volume_uuid',
      series_metadata: 'series_key',
      series_index: 'series_key',
      catalog_index: 'series_key',
      cloud_covers: '[account_scope+path], cached_at'
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
