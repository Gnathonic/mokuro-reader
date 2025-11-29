import Dexie from 'dexie';
import type { Page, VolumeMetadata } from '$lib/types';
import { CatalogDexieV3 } from '../db-v3';
import { countChars } from '$lib/util/count-chars';
import { deleteOldDatabase } from './detection';
import type { MigrationProgressCallback } from './types';
import { generateThumbnail, type ThumbnailResult } from '../thumbnails';

function naturalSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Get the first image file from a files record (sorted naturally).
 */
function getFirstImageFile(files: Record<string, File> | undefined): File | null {
  if (!files) return null;
  const fileNames = Object.keys(files).sort(naturalSort);
  return fileNames.length > 0 ? files[fileNames[0]] : null;
}

/**
 * Get dimensions from an existing image file.
 */
async function getImageDimensions(file: File): Promise<{ width: number; height: number } | null> {
  try {
    const img = new Image();
    const imgUrl = URL.createObjectURL(file);
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = reject;
      img.src = imgUrl;
    });
    URL.revokeObjectURL(imgUrl);
    return { width: img.width, height: img.height };
  } catch (error) {
    console.error('Failed to get image dimensions:', error);
    return null;
  }
}

/**
 * Ensure we have a thumbnail with dimensions.
 * - If thumbnail exists, get its dimensions
 * - If no thumbnail but files exist, generate one
 */
async function ensureThumbnail(
  existingThumbnail: File | undefined,
  files: Record<string, File> | undefined
): Promise<ThumbnailResult | null> {
  // If we have an existing thumbnail, just get its dimensions
  if (existingThumbnail) {
    const dims = await getImageDimensions(existingThumbnail);
    if (dims) {
      return { file: existingThumbnail, width: dims.width, height: dims.height };
    }
    return null;
  }

  // No thumbnail - try to generate one from files
  const firstImage = getFirstImageFile(files);
  if (!firstImage) return null;
  try {
    return await generateThumbnail(firstImage);
  } catch (error) {
    console.error('Failed to generate thumbnail during migration:', error);
    return null;
  }
}

const DEBUG_LOG_KEY = 'mokuro_migration_debug_log';

function debugLog(message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] ${message}${data ? ': ' + JSON.stringify(data) : ''}`;
  console.log('[Migration]', entry);

  // Persist to localStorage (keep last 50 entries)
  try {
    const existing = JSON.parse(localStorage.getItem(DEBUG_LOG_KEY) || '[]') as string[];
    existing.push(entry);
    if (existing.length > 50) existing.shift();
    localStorage.setItem(DEBUG_LOG_KEY, JSON.stringify(existing));
  } catch {
    // Ignore localStorage errors
  }
}

export function getMigrationDebugLog(): string[] {
  try {
    return JSON.parse(localStorage.getItem(DEBUG_LOG_KEY) || '[]');
  } catch {
    return [];
  }
}

export function clearMigrationDebugLog() {
  localStorage.removeItem(DEBUG_LOG_KEY);
}

/**
 * Calculate cumulative character counts for each page.
 * Returns an array where index i contains total chars through page i.
 */
export function calculateCumulativeCharCounts(pages: Page[]): number[] {
  let cumulative = 0;
  return pages.map((page) => {
    for (const block of page.blocks || []) {
      for (const line of block.lines || []) {
        cumulative += countChars(line);
      }
    }
    return cumulative;
  });
}

/**
 * Legacy v1 Dexie class for reading old data
 */
class LegacyDexieV1 extends Dexie {
  catalog!: Dexie.Table<{ id: string; manga: any[] }>;

  constructor() {
    super('mokuro');
    this.version(1).stores({
      catalog: 'id, manga'
    });
  }
}

/**
 * Legacy v2 Dexie class for reading old data
 */
class LegacyDexieV2 extends Dexie {
  volumes!: Dexie.Table<VolumeMetadata & { thumbnail?: File }>;
  volumes_data!: Dexie.Table<{ volume_uuid: string; pages: Page[]; files?: Record<string, File> }>;

  constructor() {
    super('mokuro');
    this.version(2).stores({
      volumes_data: 'volume_uuid',
      volumes: 'volume_uuid',
      catalog: null
    });
  }
}

interface VolumeDataForMigration {
  metadata: Omit<VolumeMetadata, 'page_char_counts'>;
  thumbnail?: File;
  thumbnailResult?: ThumbnailResult | null;
  pages: Page[];
  files?: Record<string, File>;
}

interface PreparedVolumeData {
  volumeData: VolumeDataForMigration;
  pageCharCounts: number[];
}

/**
 * Write multiple volumes to the new v3 database in a single transaction.
 * Char counts must be pre-calculated to avoid CPU work inside the transaction.
 */
async function writeVolumeBatchToV3(
  newDb: CatalogDexieV3,
  batch: PreparedVolumeData[]
): Promise<void> {
  await newDb.transaction('rw', [newDb.volumes, newDb.volume_ocr, newDb.volume_files], async () => {
    for (const { volumeData, pageCharCounts } of batch) {
      const uuid = volumeData.metadata.volume_uuid;

      // thumbnailResult contains either existing thumbnail with dimensions or newly generated one
      const thumbnail = volumeData.thumbnailResult?.file;
      const thumbnailWidth = volumeData.thumbnailResult?.width;
      const thumbnailHeight = volumeData.thumbnailResult?.height;

      await newDb.volumes.add({
        ...volumeData.metadata,
        page_char_counts: pageCharCounts,
        thumbnail,
        thumbnail_width: thumbnailWidth,
        thumbnail_height: thumbnailHeight
      });

      await newDb.volume_ocr.add({
        volume_uuid: uuid,
        pages: volumeData.pages
      });

      if (volumeData.files && Object.keys(volumeData.files).length > 0) {
        await newDb.volume_files.add({
          volume_uuid: uuid,
          files: volumeData.files
        });
      }
    }
  });
}

/**
 * Migrate from v1 database - processes one series at a time to minimize memory usage.
 * Deletes each series after migration to free space and track progress.
 */
async function migrateFromV1(
  newDb: CatalogDexieV3,
  migratedSet: Set<string>,
  onProgress: MigrationProgressCallback
): Promise<number> {
  let totalVolumes = 0;
  let migratedCount = 0;
  let seriesIds: string[] = [];
  let totalSeries = 0;

  // First pass: count total volumes and get series IDs
  onProgress({
    phase: 'counting',
    volumesCurrent: 0,
    volumesTotal: 0
  });

  {
    const db = new LegacyDexieV1();
    try {
      await db.catalog.each((entry) => {
        totalVolumes += entry.manga?.length || 0;
      });
      seriesIds = (await db.catalog.toCollection().primaryKeys()) as string[];
      totalSeries = seriesIds.length;
    } finally {
      db.close();
    }
  }

  onProgress({
    phase: 'counting',
    volumesCurrent: migratedCount,
    volumesTotal: totalVolumes,
    seriesCurrent: 0,
    seriesTotal: totalSeries
  });

  // Process each series with fresh connections
  for (let seriesIndex = 0; seriesIndex < seriesIds.length; seriesIndex++) {
    const seriesId = seriesIds[seriesIndex];
    let seriesTitle = 'Unknown Series';

    // Report loading series
    onProgress({
      phase: 'loading_series',
      volumesCurrent: migratedCount,
      volumesTotal: totalVolumes,
      seriesCurrent: seriesIndex + 1,
      seriesTotal: totalSeries
    });

    // Load series with fresh connection, then close immediately
    let manga: any[] = [];
    {
      const db = new LegacyDexieV1();
      try {
        const entry = await db.catalog.get(seriesId);
        if (entry?.manga) {
          manga = entry.manga;
          seriesTitle = manga[0]?.mokuroData?.title || 'Unknown Series';
        }
      } finally {
        db.close();
      }
    }

    if (manga.length === 0) continue;

    const volumeCount = manga.length;

    // Migrate all volumes from this series one at a time
    for (let volIndex = 0; volIndex < volumeCount; volIndex++) {
      const volume = manga[volIndex];
      if (!volume) continue;

      const uuid = volume.mokuroData?.volume_uuid;
      if (!uuid) continue;

      // Skip if already in v3 (from a previous partial run)
      if (migratedSet.has(uuid)) {
        migratedCount++;
        manga[volIndex] = null;
        continue;
      }

      // Generate thumbnail if missing
      const generatedThumbnail = await ensureThumbnail(volume.thumbnail, volume.files);

      const volumeData: VolumeDataForMigration = {
        metadata: {
          mokuro_version: volume.mokuroData.version,
          series_title: volume.mokuroData.title,
          series_uuid: volume.mokuroData.title_uuid,
          volume_title: volume.mokuroData.volume,
          volume_uuid: uuid,
          page_count: volume.mokuroData.pages?.length || 0,
          character_count: volume.mokuroData.chars || 0
        },
        thumbnail: volume.thumbnail,
        thumbnailResult: generatedThumbnail,
        pages: volume.mokuroData.pages || [],
        files: volume.files
      };

      // Pre-calculate char counts outside the transaction
      const pageCharCounts = calculateCumulativeCharCounts(volumeData.pages);

      // Report writing volume
      onProgress({
        phase: 'writing_volume',
        volumesCurrent: migratedCount,
        volumesTotal: totalVolumes,
        volumeTitle: volumeData.metadata.volume_title,
        seriesTitle,
        seriesCurrent: seriesIndex + 1,
        seriesTotal: totalSeries
      });

      await writeVolumeBatchToV3(newDb, [{ volumeData, pageCharCounts }]);
      migratedSet.add(uuid);
      migratedCount++;

      // Clear this volume from memory to allow GC
      manga[volIndex] = null;

      // Yield to event loop between volumes for GC
      await new Promise((r) => setTimeout(r, 0));
    }

    // Clear manga array reference
    manga = null as any;

    // Give GC time to collect the series data before loading next series
    await new Promise((r) => setTimeout(r, 100));

    // Note: We skip incremental deletes from the old database due to browser bugs
    // with deleting large IndexedDB records. The old database will be deleted
    // entirely after migration completes (scheduled via scheduleOldDbDeletion).
    debugLog('Series migrated, skipping incremental delete', { seriesId, seriesTitle });
  }

  return totalVolumes;
}

/**
 * Migrate from v2 database - processes one volume at a time.
 * Loads all metadata first and sorts by series/volume for nicer display.
 */
async function migrateFromV2(
  newDb: CatalogDexieV3,
  migratedSet: Set<string>,
  onProgress: MigrationProgressCallback
): Promise<number> {
  const oldDb = new LegacyDexieV2();
  let migratedCount = 0;

  try {
    onProgress({
      phase: 'counting',
      volumesCurrent: 0,
      volumesTotal: 0
    });

    // Load all metadata (small enough to fit in memory) and sort by series/volume
    const allMetadata = await oldDb.volumes.toArray();
    allMetadata.sort((a, b) => {
      const seriesCompare = (a.series_title || '').localeCompare(b.series_title || '');
      if (seriesCompare !== 0) return seriesCompare;
      return (a.volume_title || '').localeCompare(b.volume_title || '');
    });

    // Filter to only volumes that need migration
    const toMigrate = allMetadata.filter((m) => !migratedSet.has(m.volume_uuid));
    const totalVolumes = allMetadata.length;
    migratedCount = totalVolumes - toMigrate.length;

    onProgress({
      phase: 'counting',
      volumesCurrent: migratedCount,
      volumesTotal: totalVolumes
    });

    // Collect UUIDs to delete in batches
    const DELETE_BATCH_SIZE = 50;
    const pendingDeletes: string[] = [];

    // Process one volume at a time
    for (const metadata of toMigrate) {
      const uuid = metadata.volume_uuid;

      // Report progress
      onProgress({
        phase: 'writing_volume',
        volumesCurrent: migratedCount,
        volumesTotal: totalVolumes,
        volumeTitle: metadata.volume_title,
        seriesTitle: metadata.series_title
      });

      // Load this volume's data
      const data = await oldDb.volumes_data.get(uuid);
      const { thumbnail, ...metadataWithoutThumbnail } = metadata;

      // Generate thumbnail if missing
      const generatedThumbnail = await ensureThumbnail(thumbnail, data?.files);

      const volumeData: VolumeDataForMigration = {
        metadata: metadataWithoutThumbnail,
        thumbnail,
        thumbnailResult: generatedThumbnail,
        pages: data?.pages || [],
        files: data?.files
      };

      // Pre-calculate char counts outside the transaction
      const pageCharCounts = calculateCumulativeCharCounts(volumeData.pages);

      // Write single volume
      await writeVolumeBatchToV3(newDb, [{ volumeData, pageCharCounts }]);
      migratedSet.add(uuid);
      migratedCount++;

      // Queue for deletion
      pendingDeletes.push(uuid);

      // Bulk delete every DELETE_BATCH_SIZE volumes (fire-and-forget)
      if (pendingDeletes.length >= DELETE_BATCH_SIZE) {
        const toDelete = pendingDeletes.splice(0, DELETE_BATCH_SIZE);
        oldDb.volumes.bulkDelete(toDelete);
        oldDb.volumes_data.bulkDelete(toDelete);
      }
    }

    // Delete any remaining volumes (fire-and-forget)
    if (pendingDeletes.length > 0) {
      oldDb.volumes.bulkDelete(pendingDeletes);
      oldDb.volumes_data.bulkDelete(pendingDeletes);
    }

    return totalVolumes;
  } finally {
    oldDb.close();
  }
}

/**
 * Run the migration from old database to v3.
 * This is a blocking operation with progress callbacks.
 *
 * Resumability: If migration is interrupted, volumes already written to v3
 * will be skipped on retry (checked via migratedSet).
 */
export async function runMigration(
  sourceVersion: 1 | 2,
  onProgress: MigrationProgressCallback
): Promise<void> {
  debugLog('Starting migration', { sourceVersion });

  // Build set of already-migrated volumes from v3 database for skip logic
  const newDb = new CatalogDexieV3();
  const existingUuids = await newDb.volumes.toCollection().primaryKeys();
  const migratedSet = new Set(existingUuids as string[]);

  debugLog('Found existing volumes in v3', { count: migratedSet.size });

  try {
    if (sourceVersion === 1) {
      await migrateFromV1(newDb, migratedSet, onProgress);
    } else {
      await migrateFromV2(newDb, migratedSet, onProgress);
    }

    // Delete old database immediately after successful migration
    debugLog('Migration complete, deleting old database');
    await deleteOldDatabase();
    debugLog('Old database deleted');
  } finally {
    newDb.close();
  }
}

/**
 * Rollback a failed migration by deleting the new database.
 */
export async function rollbackMigration(): Promise<void> {
  await Dexie.delete('mokuro_v3');
}
