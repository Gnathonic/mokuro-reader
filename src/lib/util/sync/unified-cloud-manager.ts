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

/**
 * Did a provider op fail because THIS operation's target was already gone?
 * Typed only: providers throw code 'NOT_FOUND' at the boundary where the
 * status is unambiguous. Message sniffing ('404'/'not found') is forbidden
 * here — wrapped errors (folder resolution, proxy pages, stale ids) match
 * those substrings and would let a genuine failure gate a destructive step.
 */
function isAlreadyGoneError(error: unknown): boolean {
  return error instanceof ProviderError && error.code === 'NOT_FOUND';
}

/**
 * CloudFileMetadata with provider information for placeholder generation
 */
export interface CloudVolumeWithProvider extends CloudFileMetadata {
  provider: ProviderType;
}

/** Per-volume outcome of a series rename fan-out. */
export interface SeriesRenameFailure {
  volumeUuid: string;
  volumeTitle: string;
  error: unknown;
}

export interface SeriesRenameResult {
  /** Remote files changed across all volumes. */
  changed: number;
  /** Volumes whose cloud files are fully at the new path (incl. volumes with
   * nothing backed up — trivially consistent). Safe to commit locally. */
  renamedVolumeUuids: string[];
  /** Volumes whose cloud rename failed — must NOT be committed locally. */
  failures: SeriesRenameFailure[];
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

  /**
   * Delete a backed-up volume and ALL its managed cloud files (archive + sidecars).
   * deleteFile() removes only a single node, which leaves the .mokuro and thumbnail
   * sidecars orphaned. Sidecars are deleted first and the .cbz archive last, so a
   * sidecar failure leaves the volume still marked backed-up (and retryable) rather
   * than half-deleted.
   */
  async deleteManagedVolume(seriesTitle: string, volumeTitle: string): Promise<void> {
    const provider = this.getActiveProvider();
    if (!provider) {
      throw new Error('No cloud provider authenticated');
    }

    const files = this.getManagedCloudFilesForVolume(seriesTitle, volumeTitle);
    if (files.length === 0) return;

    const ordered = [...files].sort(
      (a, b) =>
        Number(normalizeCloudPath(a.path).endsWith('.cbz')) -
        Number(normalizeCloudPath(b.path).endsWith('.cbz'))
    );

    const cache = cacheManager.getCache(provider.type);
    const failures: string[] = [];
    for (const file of ordered) {
      try {
        await provider.deleteFile(file);
        cache?.removeById?.(file.fileId);
      } catch (error) {
        failures.push(`${file.path}: ${error instanceof Error ? error.message : 'error'}`);
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `Failed to delete ${failures.length} of ${files.length} file(s): ${failures.join('; ')}`
      );
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
    volumeUuid?: string,
    options?: { overwrite?: boolean }
  ): Promise<number> {
    const provider = this.getActiveProvider();
    if (!provider) {
      return 0;
    }

    await this.fetchAllCloudVolumes();

    // Nothing backed up → nothing remote to keep in sync. This must be
    // decided BEFORE the read-only gate so a read-only provider (anonymous
    // session, or auto-demoted after a write failure) never blocks a
    // purely-local rename.
    if (this.getManagedCloudFilesForVolume(oldSeriesTitle, oldVolumeTitle).length === 0) {
      return 0;
    }

    // The remote rename GATES the local commit (caller updates the DB only if
    // this resolves). A read-only provider cannot perform it, so fail loudly
    // rather than let the caller commit a local rename that diverges from the
    // unchanged remote.
    this.assertWritable(provider);

    return this.renameVolumeFiles(
      provider,
      oldSeriesTitle,
      oldVolumeTitle,
      newSeriesTitle,
      newVolumeTitle,
      volumeUuid,
      options
    );
  }

  private assertWritable(provider: SyncProvider): void {
    if (provider.getStatus().isReadOnly) {
      throw new ProviderError(
        'Cannot rename: the cloud provider is read-only',
        provider.type,
        'READ_ONLY'
      );
    }
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
    volumeUuid?: string,
    options?: { overwrite?: boolean }
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

    // COLLISION GATE (before any remote write): if a managed source file still
    // exists while a file already occupies its destination, this rename would
    // land on ANOTHER volume's backup. Step 1's .mokuro upload is an overwrite
    // on every provider, so proceeding would corrupt that volume's sidecar
    // before the cbz move could fail with TARGET_EXISTS. A retry of a partial
    // rename does not trip this: its already-moved sources are gone from the
    // old path, so they no longer pair with the destination files.
    const destinationFiles = this.getManagedCloudFilesForVolume(newSeriesTitle, newVolumeTitle);
    const destinationPaths = new Set(destinationFiles.map((f) => normalizeCloudPath(f.path)));
    const collision = managedFiles.some((file) => {
      if (isMokuroSidecarPath(file.path)) return false; // regenerated, not moved
      const suffix = normalizeCloudPath(file.path).slice(oldBasePath.length);
      return destinationPaths.has(`${newBasePath}${suffix}`);
    });
    if (collision) {
      if (!options?.overwrite) {
        throw new ProviderError(
          `A backup already exists at '${newBasePath}' in the cloud`,
          provider.type,
          'TARGET_EXISTS'
        );
      }
      // Explicit, user-confirmed overwrite: clear the occupant's files so the
      // moves below land cleanly.
      for (const file of destinationFiles) {
        if (await this.deleteFileIdempotent(file)) changed++;
      }
    }

    // 1. Upload the fresh .mokuro at the new path. Idempotent (overwrite) on retry.
    if (freshMokuroBlob) {
      await this.uploadFile(`${newBasePath}.mokuro`, freshMokuroBlob);
      changed++;
    }

    // 2. Move the non-mokuro files (cbz, cover). Their content is name-agnostic.
    //    Move errors PROPAGATE — the destructive step 3 must never run after a
    //    failed move. Retry convergence needs no error-swallowing here: a file
    //    moved by a prior attempt is simply absent from the old path after the
    //    fresh fetch, so it never re-enters this loop.
    for (const file of managedFiles) {
      if (isMokuroSidecarPath(file.path)) continue;
      const suffix = normalizeCloudPath(file.path).slice(oldBasePath.length);
      await this.moveFile(provider, file, `${newBasePath}${suffix}`);
      changed++;
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
        await this.moveFile(provider, file, `${newBasePath}${suffix}`);
        changed++;
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

  /**
   * renameFile + cache update. Errors propagate untouched: a NOT_FOUND during
   * a move is a GENUINE failure on every provider (an already-moved file is
   * absent from the fresh source listing and never reaches here; WebDAV
   * additionally converges internally), so nothing may be swallowed — the
   * destructive delete step must never run after a failed move.
   */
  private async moveFile(
    provider: SyncProvider,
    file: CloudFileMetadata,
    newPath: string
  ): Promise<void> {
    const updated = await provider.renameFile(file, newPath);
    this.replaceCachedFile(file, updated);
  }

  /**
   * deleteFile, treating an already-gone target as success — absence IS the
   * postcondition of a delete, which is why this is safe here and NOT for
   * moves. Only the provider's typed NOT_FOUND counts. Returns whether it
   * actually deleted.
   */
  private async deleteFileIdempotent(file: CloudFileMetadata): Promise<boolean> {
    try {
      await this.deleteFile(file);
      return true;
    } catch (error) {
      if (isAlreadyGoneError(error)) {
        // Already deleted by a prior attempt — drop the stale cache entry so
        // it stops advertising a file that no longer exists.
        const provider = this.getActiveProvider();
        const cache = provider ? cacheManager.getCache(provider.type) : null;
        cache?.removeById?.(file.fileId);
        return false;
      }
      throw error;
    }
  }

  /**
   * Rename or move a backed-up series folder in the current provider.
   *
   * With a volume list, this fans out per-volume and reports per-volume
   * outcomes instead of throwing mid-loop: each volume either fully renames
   * in the cloud (→ renamedVolumeUuids, safe to commit locally) or fails
   * (→ failures, must keep the old title locally). Volumes with nothing
   * backed up are trivially consistent and count as renamed. Throws ONLY on
   * pre-flight gates (read-only, cloud-only volumes), i.e. before any remote
   * write — a throw always means "nothing changed anywhere".
   */
  async renameSeries(
    oldSeriesTitle: string,
    newSeriesTitle: string,
    volumes?: Array<{ volumeUuid: string; volumeTitle: string }>,
    options?: { overwrite?: boolean }
  ): Promise<SeriesRenameResult> {
    const allRenamed = (): SeriesRenameResult => ({
      changed: 0,
      renamedVolumeUuids: (volumes ?? []).map((v) => v.volumeUuid),
      failures: []
    });

    const provider = this.getActiveProvider();
    if (!provider) {
      // No cloud connected: every volume is local-only and trivially in sync.
      return allRenamed();
    }

    const normalizedOldTitle = normalizeCloudPath(oldSeriesTitle);
    const normalizedNewTitle = normalizeCloudPath(newSeriesTitle);
    if (normalizedOldTitle === normalizedNewTitle) {
      return allRenamed();
    }

    await this.fetchAllCloudVolumes();

    const existingFiles = this.getCloudVolumesBySeries(oldSeriesTitle);
    if (existingFiles.length === 0) {
      // Nothing backed up under the old title — decided BEFORE the read-only
      // gate so a read-only provider never blocks a purely-local rename.
      return allRenamed();
    }

    // Remote gates the local commit; a read-only provider can't rename.
    this.assertWritable(provider);

    // Each volume's .mokuro embeds the SERIES title, so a bulk folder move would
    // leave every sidecar stale — silently reverting the rename on re-download.
    // With the volume list, fan out the per-volume rename instead: it
    // regenerates each .mokuro with the new series title, moves cbz/cover, then
    // drops the stale sidecar — idempotent + destructive-last, so a partial
    // failure converges on retry. The single fetch above feeds the whole loop
    // (the in-memory cache updates as each volume moves). More requests than a
    // bulk folder rename, but series renames are rare and recovery matters.
    if (volumes && volumes.length > 0) {
      // GATE (before any remote write): refuse when the old series folder
      // holds managed files belonging to none of the volumes we can
      // regenerate — cloud-only volumes, or local titles that no longer match
      // their cloud filenames. Renaming around them would split the series
      // across two cloud folders and leave stale sidecars that resurrect the
      // old title on re-download.
      // TODO(data-update): the proper fix is downloading a volume's .mokuro/
      // metadata WITHOUT the full archive, so cloud-only volumes can be
      // regenerated and renamed too. That depends on the planned
      // metadata-persistence data update (metadata surviving volume deletion,
      // see PR #201). Until then we fail loudly and ask the user to download
      // the missing volumes first.
      const knownBases = new Set(
        volumes.map((v) => normalizeCloudPath(`${oldSeriesTitle}/${v.volumeTitle}`))
      );
      const cloudOnlyBases = [
        ...new Set(
          existingFiles
            .map((file) => stripManagedFileExtension(normalizeCloudPath(file.path)))
            .filter((base) => !knownBases.has(base))
        )
      ];
      if (cloudOnlyBases.length > 0) {
        const names = cloudOnlyBases.map((base) => base.slice(normalizedOldTitle.length + 1));
        const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? ', …' : '');
        throw new ProviderError(
          `Series not renamed: ${names.length} backed-up volume(s) in this series ` +
            `are not in your local library (${shown}). Download them first, then rename the series.`,
          provider.type,
          'CLOUD_ONLY_VOLUMES'
        );
      }

      const result: SeriesRenameResult = { changed: 0, renamedVolumeUuids: [], failures: [] };
      for (const { volumeUuid, volumeTitle } of volumes) {
        try {
          result.changed += await this.renameVolumeFiles(
            provider,
            oldSeriesTitle,
            volumeTitle,
            newSeriesTitle,
            volumeTitle,
            volumeUuid,
            options
          );
          result.renamedVolumeUuids.push(volumeUuid);
        } catch (error) {
          console.error(`Cloud rename failed for volume '${volumeTitle}':`, error);
          result.failures.push({ volumeUuid, volumeTitle, error });
        }
      }
      return result;
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

    return { changed: renamedFiles.length, renamedVolumeUuids: [], failures: [] };
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
