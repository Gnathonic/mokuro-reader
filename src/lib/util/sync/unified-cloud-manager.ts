import { derived, type Readable } from 'svelte/store';
import {
  ProviderError,
  type SyncProvider,
  type CloudFileMetadata,
  type ProviderType,
  type UploadPayload
} from './provider-interface';
import { unifiedSyncService, type SyncOptions, type SyncResult } from './unified-sync-service';
import { cacheManager } from './cache-manager';
import { providerManager } from './provider-manager';
import { generateVolumeSidecarsFromDb } from '$lib/util/compress-volume';

/** A managed sidecar whose CONTENT embeds the volume's title/series. */
function isMokuroSidecarPath(path: string): boolean {
  const lower = normalizeCloudPath(path).toLowerCase();
  return lower.endsWith('.mokuro') || lower.endsWith('.mokuro.gz');
}

/** Did a provider op fail because the resource was already gone (idempotent re-run)? */
function isNotFoundError(error: unknown): boolean {
  if (error instanceof ProviderError) {
    if (error.code === 'NOT_FOUND' || error.code === 'FILE_NOT_FOUND') return true;
  }
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return msg.includes('404') || msg.includes('not found');
}

/**
 * CloudFileMetadata with provider information for placeholder generation
 */
export interface CloudVolumeWithProvider extends CloudFileMetadata {
  provider: ProviderType;
}

function normalizeCloudPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

function stripManagedFileExtension(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.cbz')) return path.slice(0, -4);
  if (lower.endsWith('.mokuro.gz')) return path.slice(0, -10);
  if (lower.endsWith('.mokuro')) return path.slice(0, -7);
  if (lower.endsWith('.jpeg')) return path.slice(0, -5);
  if (lower.endsWith('.webp')) return path.slice(0, -5);
  if (lower.endsWith('.jpg')) return path.slice(0, -4);
  return path;
}

/**
 * Unified Cloud Manager - Single Provider Design
 *
 * Provides a convenient interface for cloud storage operations.
 * Delegates to THE current provider via providerManager.
 *
 * ARCHITECTURE NOTE:
 * This manager provides a unified API but delegates all operations to:
 * - providerManager.getActiveProvider() for provider operations
 * - cacheManager for cache operations
 *
 * Only ONE provider can be active at a time.
 */

class UnifiedCloudManager {
  /**
   * Store containing cloud volumes from the current provider
   * Returns Map<seriesTitle, CloudVolumeWithProvider[]> for efficient series-based operations
   * Delegates to cacheManager and adds provider field to each file
   */
  get cloudFiles(): Readable<Map<string, CloudVolumeWithProvider[]>> {
    return derived(
      cacheManager.allFiles,
      ($filesMap) => {
        const provider = this.getActiveProvider();
        if (!provider) return new Map();

        // Add provider field to each file in the map
        const resultMap = new Map<string, CloudVolumeWithProvider[]>();
        for (const [seriesTitle, files] of $filesMap.entries()) {
          resultMap.set(
            seriesTitle,
            files.map((file) => ({
              ...file,
              provider: provider.type
            }))
          );
        }
        return resultMap;
      },
      new Map()
    );
  }

  /**
   * Store indicating whether a fetch is in progress
   * Delegates to cacheManager's reactive fetching state
   */
  get isFetching(): Readable<boolean> {
    return cacheManager.isFetchingState;
  }

  /**
   * Fetch all cloud volumes from the current provider
   * Delegates to cacheManager
   */
  async fetchAllCloudVolumes(): Promise<void> {
    await cacheManager.fetchAll();
  }

  /**
   * Get all cloud volumes (current cached value)
   */
  getAllCloudVolumes(): CloudFileMetadata[] {
    return cacheManager.getAllFiles() as CloudFileMetadata[];
  }

  /**
   * Get cloud volume by file ID
   */
  getCloudVolume(fileId: string): CloudFileMetadata | undefined {
    const volumes = this.getAllCloudVolumes();
    return volumes.find((v) => v.fileId === fileId);
  }

  /**
   * Get cloud volumes for a specific series
   */
  getCloudVolumesBySeries(seriesTitle: string): CloudFileMetadata[] {
    return cacheManager.getBySeries(seriesTitle) as CloudFileMetadata[];
  }

  /**
   * Get the current provider
   */
  getActiveProvider(): SyncProvider | null {
    return providerManager.getActiveProvider();
  }

  /**
   * Upload a volume CBZ to the current provider
   */
  async uploadFile(
    path: string,
    blob: UploadPayload,
    description?: string,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<string> {
    const provider = this.getActiveProvider();
    if (!provider) {
      throw new Error('No cloud provider authenticated');
    }

    const fileId = await provider.uploadFile(path, blob, description, onProgress);
    const uploadSize =
      blob instanceof Blob
        ? blob.size
        : blob instanceof ArrayBuffer
          ? blob.byteLength
          : blob.byteLength;

    // Update cache via cacheManager
    const cache = cacheManager.getCache(provider.type);
    if (cache && cache.add) {
      cache.add(path, {
        fileId,
        path,
        modifiedTime: new Date().toISOString(),
        size: uploadSize,
        description
      });
    }

    return fileId;
  }

  /**
   * Download a volume CBZ using the active provider
   */
  async downloadFile(
    file: CloudFileMetadata,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<Blob> {
    const provider = this.getActiveProvider();
    console.log('[Unified Cloud Manager] downloadFile:', {
      fileId: file.fileId,
      path: file.path,
      activeProvider: provider?.type,
      hasProvider: !!provider
    });

    if (!provider) {
      throw new Error(`No cloud provider authenticated`);
    }

    return await provider.downloadFile(file, onProgress);
  }

  /**
   * Delete a volume CBZ from the current provider
   */
  async deleteFile(file: CloudFileMetadata): Promise<void> {
    const provider = this.getActiveProvider();
    if (!provider) {
      throw new Error('No cloud provider authenticated');
    }

    await provider.deleteFile(file);

    // Remove from cache via cacheManager
    const cache = cacheManager.getCache(provider.type);
    if (cache && cache.removeById) {
      cache.removeById(file.fileId);
    }
  }

  private replaceCachedFile(oldFile: CloudFileMetadata, updatedFile: CloudFileMetadata): void {
    const provider = this.getActiveProvider();
    if (!provider) return;

    const cache = cacheManager.getCache(provider.type);
    cache?.removeById?.(oldFile.fileId);
    cache?.add?.(updatedFile.path, updatedFile);
  }

  private getManagedCloudFilesForVolume(
    seriesTitle: string,
    volumeTitle: string
  ): CloudFileMetadata[] {
    const basePath = normalizeCloudPath(`${seriesTitle}/${volumeTitle}`);
    return this.getCloudVolumesBySeries(seriesTitle).filter(
      (file) => stripManagedFileExtension(normalizeCloudPath(file.path)) === basePath
    );
  }

  /**
   * Rename or move a backed-up volume and its sidecars in the current provider.
   * Returns the number of remote files updated.
   */
  async renameVolume(
    oldSeriesTitle: string,
    oldVolumeTitle: string,
    newSeriesTitle: string,
    newVolumeTitle: string,
    volumeUuid?: string
  ): Promise<number> {
    const provider = this.getActiveProvider();
    if (!provider) {
      return 0;
    }

    // The remote rename GATES the local commit (caller updates the DB only if
    // this resolves). A read-only provider cannot perform it, so fail loudly
    // rather than let the caller commit a local rename that diverges from the
    // unchanged remote.
    if (provider.getStatus().isReadOnly) {
      throw new ProviderError(
        'Cannot rename: the cloud provider is read-only',
        provider.type,
        'READ_ONLY'
      );
    }

    await this.fetchAllCloudVolumes();
    return this.renameVolumeFiles(
      provider,
      oldSeriesTitle,
      oldVolumeTitle,
      newSeriesTitle,
      newVolumeTitle,
      volumeUuid
    );
  }

  /**
   * Move/regenerate ONE volume's managed cloud files into a new series/volume
   * name. Assumes the caller already checked write access and refreshed the
   * cache, so a series rename can fan this out over many volumes on a single
   * fetch. Idempotent + destructive-last → converges on retry. Returns the
   * number of remote files changed. Provider-agnostic: only the SyncProvider
   * interface (uploadFile/renameFile/deleteFile + optional removeDirectoryIfEmpty).
   */
  private async renameVolumeFiles(
    provider: SyncProvider,
    oldSeriesTitle: string,
    oldVolumeTitle: string,
    newSeriesTitle: string,
    newVolumeTitle: string,
    volumeUuid?: string
  ): Promise<number> {
    const oldBasePath = normalizeCloudPath(`${oldSeriesTitle}/${oldVolumeTitle}`);
    const newBasePath = normalizeCloudPath(`${newSeriesTitle}/${newVolumeTitle}`);
    if (oldBasePath === newBasePath) {
      return 0;
    }

    const managedFiles = this.getManagedCloudFilesForVolume(oldSeriesTitle, oldVolumeTitle);
    if (managedFiles.length === 0) {
      return 0;
    }

    // Regenerate the fresh .mokuro FIRST (no remote mutation yet), built with
    // the new names (overrides — the DB still holds the old ones until this
    // gate clears). Only the .mokuro embeds the title, so it's the one file we
    // regenerate rather than move.
    const hasCloudMokuro = managedFiles.some((file) => isMokuroSidecarPath(file.path));
    let freshMokuroBlob: Blob | null = null;
    if (volumeUuid) {
      const sidecars = await generateVolumeSidecarsFromDb(volumeUuid, {
        seriesTitle: newSeriesTitle,
        volumeTitle: newVolumeTitle
      });
      freshMokuroBlob = sidecars.mokuro?.blob ?? null;
    }

    // GATE (before any remote write): an OCR volume that already has a .mokuro
    // in the cloud but whose sidecar we COULDN'T regenerate (e.g. volume_ocr
    // row missing — a DB inconsistency) must not be renamed. Moving its stale
    // sidecar would silently revert the rename on re-download — the exact bug
    // this fixes — so fail loudly while nothing has changed.
    if (volumeUuid && hasCloudMokuro && !freshMokuroBlob) {
      throw new ProviderError(
        'Cannot rename: the OCR sidecar could not be regenerated (volume_ocr data missing)',
        provider.type,
        'SIDECAR_REGEN_FAILED'
      );
    }

    let changed = 0;

    // 1. Upload the fresh .mokuro at the new path. Idempotent (overwrite) on retry.
    if (freshMokuroBlob) {
      await this.uploadFile(`${newBasePath}.mokuro`, freshMokuroBlob);
      changed++;
    }

    // 2. Move the non-mokuro files (cbz, cover). Their content is name-agnostic.
    //    Idempotent: a source already moved by a prior partial run 404s → skip.
    for (const file of managedFiles) {
      if (isMokuroSidecarPath(file.path)) continue;
      const suffix = normalizeCloudPath(file.path).slice(oldBasePath.length);
      if (await this.moveFileIdempotent(provider, file, `${newBasePath}${suffix}`)) changed++;
    }

    // 3. DESTRUCTIVE, LAST: drop the stale .mokuro now that the fresh one is up.
    //    When we have no fresh mokuro (legacy callers that pass no volumeUuid),
    //    MOVE it instead so OCR is never lost — the gate above already rejected
    //    the dangerous "had a UUID but couldn't regenerate" case.
    for (const file of managedFiles) {
      if (!isMokuroSidecarPath(file.path)) continue;
      if (freshMokuroBlob) {
        if (await this.deleteFileIdempotent(file)) changed++;
      } else {
        const suffix = normalizeCloudPath(file.path).slice(oldBasePath.length);
        if (await this.moveFileIdempotent(provider, file, `${newBasePath}${suffix}`)) changed++;
      }
    }

    // 4. Best-effort prune of the now-empty old series directory (server-checked
    //    emptiness inside the provider — never a blind recursive delete).
    if (oldSeriesTitle !== newSeriesTitle && provider.removeDirectoryIfEmpty) {
      if (this.getCloudVolumesBySeries(oldSeriesTitle).length === 0) {
        try {
          await provider.removeDirectoryIfEmpty(oldSeriesTitle);
        } catch {
          // Non-fatal: an orphaned empty directory is harmless.
        }
      }
    }

    return changed;
  }

  /** renameFile, treating an already-moved source (404) as success. Updates cache. */
  private async moveFileIdempotent(
    provider: SyncProvider,
    file: CloudFileMetadata,
    newPath: string
  ): Promise<boolean> {
    try {
      const updated = await provider.renameFile(file, newPath);
      this.replaceCachedFile(file, updated);
      return true;
    } catch (error) {
      if (isNotFoundError(error)) return false; // already moved by a prior attempt
      throw error;
    }
  }

  /** deleteFile, treating an already-gone target (404) as success. Returns whether it actually deleted. */
  private async deleteFileIdempotent(file: CloudFileMetadata): Promise<boolean> {
    try {
      await this.deleteFile(file);
      return true;
    } catch (error) {
      if (isNotFoundError(error)) return false; // already deleted by a prior attempt
      throw error;
    }
  }

  /**
   * Rename or move a backed-up series folder in the current provider.
   * Returns the number of remote files updated.
   */
  async renameSeries(
    oldSeriesTitle: string,
    newSeriesTitle: string,
    volumes?: Array<{ volumeUuid: string; volumeTitle: string }>
  ): Promise<number> {
    const provider = this.getActiveProvider();
    if (!provider) {
      return 0;
    }

    // Remote gates the local commit; a read-only provider can't rename.
    if (provider.getStatus().isReadOnly) {
      throw new ProviderError(
        'Cannot rename: the cloud provider is read-only',
        provider.type,
        'READ_ONLY'
      );
    }

    const normalizedOldTitle = normalizeCloudPath(oldSeriesTitle);
    const normalizedNewTitle = normalizeCloudPath(newSeriesTitle);
    if (normalizedOldTitle === normalizedNewTitle) {
      return 0;
    }

    await this.fetchAllCloudVolumes();

    const existingFiles = this.getCloudVolumesBySeries(oldSeriesTitle);
    if (existingFiles.length === 0) {
      return 0;
    }

    // Each volume's .mokuro embeds the SERIES title, so a bulk folder move would
    // leave every sidecar stale — silently reverting the rename on re-download.
    // With the volume list, fan out the per-volume rename instead: it
    // regenerates each .mokuro with the new series title, moves cbz/cover, then
    // drops the stale sidecar — idempotent + destructive-last, so a partial
    // failure converges on retry. The single fetch above feeds the whole loop
    // (the in-memory cache updates as each volume moves). More requests than a
    // bulk folder rename, but series renames are rare and recovery matters.
    if (volumes && volumes.length > 0) {
      let changed = 0;
      for (const { volumeUuid, volumeTitle } of volumes) {
        changed += await this.renameVolumeFiles(
          provider,
          oldSeriesTitle,
          volumeTitle,
          newSeriesTitle,
          volumeTitle,
          volumeUuid
        );
      }
      return changed;
    }

    // Legacy path (no volume list, e.g. an image-only series): no .mokuro to
    // regenerate, so a provider-optimized bulk folder move is correct.
    const renamedFiles = await provider.renameFolder(oldSeriesTitle, newSeriesTitle);

    const cache = cacheManager.getCache(provider.type);
    if (cache?.removeById && cache?.add) {
      for (const file of existingFiles) {
        cache.removeById(file.fileId);
      }
      for (const file of renamedFiles) {
        cache.add(file.path, file);
      }
    }

    return renamedFiles.length;
  }

  /**
   * Delete an entire series folder (all volumes in the series)
   */
  async deleteSeriesFolder(seriesTitle: string): Promise<{ succeeded: number; failed: number }> {
    const provider = this.getActiveProvider();
    if (!provider) {
      throw new Error('No cloud provider authenticated');
    }

    // Get all volumes for this series from the current provider
    const seriesVolumes = this.getCloudVolumesBySeries(seriesTitle);

    if (seriesVolumes.length === 0) {
      return { succeeded: 0, failed: 0 };
    }

    const archives: CloudFileMetadata[] = [];
    const nonArchivesByBase = new Map<string, CloudFileMetadata[]>();
    for (const file of seriesVolumes) {
      if (file.path.toLowerCase().endsWith('.cbz')) {
        archives.push(file);
        continue;
      }
      const base = stripManagedFileExtension(file.path);
      const existing = nonArchivesByBase.get(base);
      if (existing) {
        existing.push(file);
      } else {
        nonArchivesByBase.set(base, [file]);
      }
    }

    const orderedSeriesVolumes: CloudFileMetadata[] = [];
    for (const archive of archives) {
      orderedSeriesVolumes.push(archive);
      const base = stripManagedFileExtension(archive.path);
      const related = nonArchivesByBase.get(base);
      if (related && related.length > 0) {
        orderedSeriesVolumes.push(...related);
        nonArchivesByBase.delete(base);
      }
    }
    for (const leftovers of nonArchivesByBase.values()) {
      orderedSeriesVolumes.push(...leftovers);
    }

    // Helper to delete files individually
    const deleteFilesIndividually = async (): Promise<{ succeeded: number; failed: number }> => {
      let successCount = 0;
      let failCount = 0;

      for (const volume of orderedSeriesVolumes) {
        try {
          await this.deleteFile(volume);
          successCount++;
        } catch (error) {
          console.error(`Failed to delete ${volume.path}:`, error);
          failCount++;
        }
      }

      return { succeeded: successCount, failed: failCount };
    };

    // Check if provider has a deleteSeriesFolder method
    if (provider.deleteSeriesFolder) {
      try {
        await provider.deleteSeriesFolder(seriesTitle);

        // Remove all volumes from cache
        const cache = cacheManager.getCache(provider.type);
        if (cache && cache.removeById) {
          for (const volume of orderedSeriesVolumes) {
            cache.removeById(volume.fileId);
          }
        }

        return { succeeded: seriesVolumes.length, failed: 0 };
      } catch (error: unknown) {
        // Check if this is a "folder not found" error - fall back to individual deletion
        if (
          typeof error === 'object' &&
          error !== null &&
          'errorType' in error &&
          (error as { errorType?: string }).errorType === 'FOLDER_NOT_FOUND'
        ) {
          console.log(`Series folder not found, falling back to individual file deletion`);
          return deleteFilesIndividually();
        }

        console.error(`Failed to delete series folder:`, error);
        return { succeeded: 0, failed: seriesVolumes.length };
      }
    } else {
      // Provider doesn't support folder deletion - delete files individually
      return deleteFilesIndividually();
    }
  }

  /**
   * Check if a volume exists in the current provider by path
   */
  existsInCloud(seriesTitle: string, volumeTitle: string): boolean {
    const path = `${seriesTitle}/${volumeTitle}.cbz`;
    return cacheManager.has(path);
  }

  /**
   * Get cloud file metadata by path from the current provider
   */
  getCloudFile(seriesTitle: string, volumeTitle: string): CloudFileMetadata | null {
    const path = `${seriesTitle}/${volumeTitle}.cbz`;
    return cacheManager.get(path) as CloudFileMetadata | null;
  }

  /**
   * Get the default provider for uploads (the current provider)
   */
  getDefaultProvider(): SyncProvider | null {
    return this.getActiveProvider();
  }

  /**
   * Clear all cached data
   */
  clearCache(): void {
    cacheManager.clearAll();
  }

  /**
   * Update cache entry (e.g., after modifying description)
   */
  updateCacheEntry(fileId: string, updates: Partial<CloudFileMetadata>): void {
    const provider = this.getActiveProvider();
    if (!provider) return;

    const cache = cacheManager.getCache(provider.type);
    if (cache && cache.update) {
      cache.update(fileId, updates);
    }
  }

  /**
   * Sync progress (volume data and optionally profiles) with the current provider
   */
  async syncProgress(options?: SyncOptions): Promise<SyncResult> {
    const provider = this.getActiveProvider();
    if (!provider) {
      return {
        totalProviders: 0,
        succeeded: 0,
        failed: 0,
        results: []
      };
    }

    const result = await unifiedSyncService.syncProvider(provider, options);
    return {
      totalProviders: 1,
      succeeded: result.success ? 1 : 0,
      failed: result.success ? 0 : 1,
      results: [result]
    };
  }

  /**
   * Check if sync is currently in progress
   */
  get isSyncing(): Readable<boolean> {
    return unifiedSyncService.isSyncing;
  }
}

export const unifiedCloudManager = new UnifiedCloudManager();
