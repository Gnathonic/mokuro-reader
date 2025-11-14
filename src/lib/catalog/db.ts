import type { VolumeData, VolumeMetadata, VolumeCover, VolumeImage } from '$lib/types';
import Dexie, { type Table } from 'dexie';
import { generateThumbnail } from '$lib/catalog/thumbnails';
import { writable } from 'svelte/store';
import { browser } from '$app/environment';
import { enrichAllOrphanedVolumes } from '$lib/settings/volume-data';

function naturalSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export const isUpgrading = writable(false);

// Migration progress tracking for background migration
export const migrationProgress = writable<{
  current: number;
  total: number;
  percent: number;
  currentVolume: string;
} | null>(null);

export class CatalogDexie extends Dexie {
  volumes!: Table<VolumeMetadata>;
  volumes_data!: Table<VolumeData>; // v3: OCR data only, images moved to volumes_images
  volumes_covers!: Table<VolumeCover>;
  volumes_images!: Table<VolumeImage>; // v3: Per-page image storage
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

        // Mark upgrade as complete and enrich any orphaned volumes
        isUpgrading.set(false);

        // v3: Metadata enrichment no longer needed - data already in IndexedDB
      });

    // Version 3: Separate images from OCR data for memory efficiency
    // Phase 1: Extract thumbnails and migrate images to volumes_images
    // Phase 2: Background calculation of characters_per_page cache
    this.version(3)
      .stores({
        volumes: 'volume_uuid',
        volumes_covers: 'volume_uuid',
        volumes_data: 'volume_uuid',
        volumes_images: '[volume_uuid+page_number], volume_uuid' // Compound primary key + volume index
      })
      .upgrade(async (tx) => {
        isUpgrading.set(true);
        console.log('[DB Migration v3] Phase 1: Extracting thumbnails and migrating images...');
        const startTime = performance.now();

        // Load old data
        const oldVolumes = await tx.table('volumes').toArray() as VolumeMetadata[];
        const oldVolumesData = await tx.table('volumes_data').toArray() as Array<VolumeData & { files?: Record<string, File> }>;
        console.log(`[DB Migration v3] Processing ${oldVolumes.length} volumes...`);

        // Clear and rebuild tables
        await tx.table('volumes').clear();
        await tx.table('volumes_data').clear();

        const covers: VolumeCover[] = [];
        const newVolumes: VolumeMetadata[] = [];
        const newVolumesData: VolumeData[] = [];
        const images: VolumeImage[] = [];

        for (const volume of oldVolumes) {
          const { thumbnail, ...metadata } = volume;

          // Create new volume metadata with empty characters_per_page (to be calculated in Phase 2)
          newVolumes.push({
            ...metadata,
            character_count: volume.character_count || 0,
            characters_per_page: [] // Will be populated during background migration
          } as VolumeMetadata);

          // Extract thumbnail to volumes_covers table
          if (thumbnail) {
            covers.push({ volume_uuid: volume.volume_uuid, thumbnail });
          }
        }

        // Migrate volumes_data: separate OCR (keep) from images (move to volumes_images)
        for (const volumeData of oldVolumesData) {
          const { files, ...ocrData } = volumeData;

          // Keep only OCR data in volumes_data
          newVolumesData.push(ocrData as VolumeData);

          // Move images to volumes_images table
          if (files) {
            const sortedFiles = Object.entries(files).sort(([a], [b]) =>
              a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
            );

            sortedFiles.forEach(([filename, image], pageNumber) => {
              images.push({
                volume_uuid: volumeData.volume_uuid,
                page_number: pageNumber,
                filename,
                image
              });
            });
          }
        }

        // Write new data
        await tx.table('volumes').bulkAdd(newVolumes);
        await tx.table('volumes_data').bulkAdd(newVolumesData);
        if (covers.length > 0) await tx.table('volumes_covers').bulkAdd(covers);
        if (images.length > 0) await tx.table('volumes_images').bulkAdd(images);

        const endTime = performance.now();
        console.log(`[DB Migration v3] Phase 1 complete in ${((endTime - startTime) / 1000).toFixed(1)}s`);
        console.log(`[DB Migration v3] - ${newVolumes.length} volumes`);
        console.log(`[DB Migration v3] - ${covers.length} covers`);
        console.log(`[DB Migration v3] - ${images.length} images migrated to volumes_images`);
        console.log('[DB Migration v3] Phase 2 will run in background (calculating characters_per_page)...');

        isUpgrading.set(false);
      });

    // Only start thumbnail processing in browser environment
    if (browser) {
      startThumbnailProcessing();
    }
  }

  async processThumbnails(batchSize: number = 5): Promise<void> {
    // Get volumes without covers
    const allVolumes = await this.volumes.toArray();

    // Check which ones don't have covers yet
    const volumesNeedingThumbnails: VolumeMetadata[] = [];
    for (const volume of allVolumes) {
      const existingCover = await this.volumes_covers.get(volume.volume_uuid);
      if (!existingCover) {
        volumesNeedingThumbnails.push(volume);
        // Limit batch size
        if (volumesNeedingThumbnails.length >= batchSize) {
          break;
        }
      }
    }

    // If no volumes need thumbnails, we're done
    if (volumesNeedingThumbnails.length === 0) {
      return;
    }

    // Process thumbnails in parallel
    let successCount = 0;
    await Promise.all(
      volumesNeedingThumbnails.map(async (volume) => {
        try {
          // Get the first image (page 0) from volumes_images
          const firstImage = await db.volumes_images.get([volume.volume_uuid, 0]);

          if (firstImage?.image) {
            const thumbnail = await generateThumbnail(firstImage.image);
            // Insert into volumes_covers table
            await this.volumes_covers.add({
              volume_uuid: volume.volume_uuid,
              thumbnail: thumbnail
            });
            successCount++;
          }
        } catch (error) {
          console.error('Failed to generate thumbnail for volume:', volume.volume_uuid, error);
        }
      })
    );

    // Only continue if we successfully generated thumbnails
    // This prevents infinite recursion if volumes have no images
    if (successCount > 0) {
      await this.processThumbnails(batchSize);
    }
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
