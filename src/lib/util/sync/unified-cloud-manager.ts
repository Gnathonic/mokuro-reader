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
import { db } from '$lib/catalog/db';
import type { VolumeMetadata } from '$lib/types';
import {
  SERIES_FILE_NAME,
  buildSeriesFile,
  isSeriesFilePath,
  parseSeriesFile,
  type SeriesFile
} from '$lib/metadata/series-file';
import { normalizeSeriesKey } from '$lib/metadata/series-key';
import { getSeriesMetadataForTitle } from '$lib/metadata/store';
import {
  deleteSeriesIndex,
  getSeriesIndex,
  indexNeedsRefresh,
  moveSeriesIndexKey,
  putSeriesIndex
} from '$lib/metadata/series-index';
import { refreshSeriesIndexes } from '$lib/metadata/series-index-sync';

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
   *
   * `refreshIndexes: false` suppresses the background `series.json` refresh for
   * listings that are about to be invalidated — the pre-flight fetch of a
   * rename, whose listing still shows the OLD folder. Refreshing from it would
   * race the rename and re-create the series' `series_metadata` row under the
   * old title (via `upsertFromSeriesFile`) after `moveSeriesMetadataKey` already
   * moved it, leaving a ghost series in the catalog that no cleanup owns.
   */
  async fetchAllCloudVolumes(options?: { refreshIndexes?: boolean }): Promise<void> {
    await cacheManager.fetchAll();
    if (options?.refreshIndexes === false) return;
    this.refreshSeriesIndexesInBackground();
  }

  /**
   * Re-read the `series.json` sidecars this listing shows as changed.
   *
   * Fire-and-forget by design: the listing itself is what the caller (catalog,
   * cloud screen, rename) is waiting on, while the index refresh is a cache
   * warm-up that may download files. Every failure path is swallowed — an index
   * that stays stale costs a placeholder its counts, nothing more.
   */
  private refreshSeriesIndexesInBackground(): void {
    try {
      const provider = this.getActiveProvider();
      if (!provider) return;

      const files = (this.getAllCloudVolumes() ?? []) as CloudFileMetadata[];
      if (files.length === 0) return;

      const listing = new Map<string, CloudVolumeWithProvider[]>();
      for (const file of files) {
        const folder = normalizeCloudPath(file.path).split('/')[0];
        if (!folder) continue;
        const entry: CloudVolumeWithProvider = { ...file, provider: provider.type };
        const existing = listing.get(folder);
        if (existing) existing.push(entry);
        else listing.set(folder, [entry]);
      }

      // Bound to THIS provider: the run may start long after the switch that
      // makes these ids and paths meaningless.
      void Promise.resolve(refreshSeriesIndexes(listing, provider.type)).catch((error) =>
        console.warn('Series index refresh failed:', error)
      );
    } catch (error) {
      console.warn('Series index refresh could not start:', error);
    }
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

    await this.cleanupSeriesFileIfFolderEmptied(seriesTitle);
  }

  /**
   * Drop `<Series>/series.json` (and its cached record) once the folder holds no
   * `.cbz` any more — after the last volume was deleted or moved out.
   *
   * An index for a series with no volumes is worse than no index: the refresh
   * pass ignores such folders, so the file would linger forever, and any device
   * that still had the cached record would keep showing a series that is gone.
   * Best-effort — an orphaned sidecar is harmless, so nothing here is allowed to
   * fail the delete/rename that triggered it.
   *
   * CAVEAT (deferred): "no `.cbz` left" is read from the CACHED listing, which
   * the caller has just mutated locally. A cache that under-reports the folder
   * (a listing that predates another device's upload) makes this delete a real
   * remote `series.json` — recoverable, since the next write republishes it from
   * the cached index, but it is a destructive step gated on local state.
   */
  private async cleanupSeriesFileIfFolderEmptied(seriesTitle: string): Promise<void> {
    try {
      const stillHasArchive = this.getCloudVolumesBySeries(seriesTitle).some((file) =>
        normalizeCloudPath(file.path).toLowerCase().endsWith('.cbz')
      );
      if (stillHasArchive) return;

      const sidecar = this.getCloudSeriesFile(seriesTitle);
      if (sidecar) await this.deleteFileIdempotent(sidecar);
      await deleteSeriesIndex(normalizeSeriesKey(seriesTitle));
    } catch (error) {
      console.warn(`Failed to clean up series.json for '${seriesTitle}':`, error);
    }
  }

  private replaceCachedFile(oldFile: CloudFileMetadata, updatedFile: CloudFileMetadata): void {
    const provider = this.getActiveProvider();
    if (!provider) return;

    const cache = cacheManager.getCache(provider.type);
    cache?.removeById?.(oldFile.fileId);
    cache?.add?.(updatedFile.path, updatedFile);
  }

  /**
   * The cloud files belonging to ONE volume: `<Series>/<Volume Title>.<ext>`.
   * `<Series>/series.json` never matches — it is the series folder's own
   * sidecar, not any volume's (its basename is not a volume title, and `.json`
   * is not a managed volume extension).
   */
  getManagedCloudFilesForVolume(seriesTitle: string, volumeTitle: string): CloudFileMetadata[] {
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

    // Pre-rename listing: no index refresh (see fetchAllCloudVolumes).
    await this.fetchAllCloudVolumes({ refreshIndexes: false });

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

    const changed = await this.renameVolumeFiles(
      provider,
      oldSeriesTitle,
      oldVolumeTitle,
      newSeriesTitle,
      newVolumeTitle,
      volumeUuid,
      options
    );

    if (changed > 0 && oldSeriesTitle !== newSeriesTitle) {
      // Sidecar first: while `series.json` is still there the old directory can
      // never be empty, so the prune below would always no-op.
      await this.cleanupSeriesFileIfFolderEmptied(oldSeriesTitle);
      await this.pruneSeriesDirectoryIfEmpty(provider, oldSeriesTitle);
    }

    return changed;
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
   * Best-effort prune of a series directory a rename may have emptied.
   * The provider verifies emptiness against the SERVER; the local cache is
   * deliberately NOT consulted — a debounced provider-event rebuild can
   * transiently repopulate old-path entries mid-rename (e.g. MEGA's tree
   * lags a deletion until the sc packet lands), and gating on the cache made
   * real prunes get skipped.
   */
  private async pruneSeriesDirectoryIfEmpty(
    provider: SyncProvider,
    seriesTitle: string
  ): Promise<void> {
    if (!provider.removeDirectoryIfEmpty) return;
    try {
      await provider.removeDirectoryIfEmpty(seriesTitle);
    } catch {
      // Non-fatal: an orphaned empty directory is harmless.
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

    // (Old-directory pruning happens in the public entry points AFTER all of
    // a rename's volumes are processed — see pruneSeriesDirectoryIfEmpty.)

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

    // Pre-rename listing: no index refresh (see fetchAllCloudVolumes).
    await this.fetchAllCloudVolumes({ refreshIndexes: false });

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
            // The series' own sidecar belongs to no volume — it is rewritten at
            // the new title below, so it must not read as a cloud-only volume.
            .filter((file) => !isSeriesFilePath(file.path))
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

      // The series sidecar follows the volumes, once, after the fan-out: it
      // describes the folder, not any single volume.
      if (result.renamedVolumeUuids.length > 0) {
        await this.moveSeriesFileAfterRename(oldSeriesTitle, newSeriesTitle);
      }

      // ONE prune attempt after the whole fan-out (not per volume): the
      // provider server-checks emptiness, so this is safe even when some
      // volumes failed and their files still occupy the old directory.
      if (result.renamedVolumeUuids.length > 0) {
        await this.pruneSeriesDirectoryIfEmpty(provider, oldSeriesTitle);
      }

      return result;
    }

    // Legacy path (no volume list, e.g. an image-only series): no .mokuro to
    // regenerate, so a provider-optimized bulk folder move is correct.
    const renamedFiles = await provider.renameFolder(oldSeriesTitle, newSeriesTitle);

    // A folder move carries `series.json` along with everything else — only the
    // cached index, which is keyed by series title, has to follow.
    try {
      await moveSeriesIndexKey(oldSeriesTitle, newSeriesTitle);
    } catch (error) {
      console.warn(`Failed to move the cached series index to '${newSeriesTitle}':`, error);
    }

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
   * The `<Series>/series.json` entry of a series folder's cached listing, if any.
   * The NEWEST one when several are cached: providers whose overwrite is really
   * "delete + upload" (MEGA) mint a new file id, so the previous entry can
   * linger in the cache until the next full fetch.
   */
  private getCloudSeriesFile(seriesTitle: string): CloudFileMetadata | undefined {
    const candidates = this.getCloudVolumesBySeries(seriesTitle).filter((file) =>
      isSeriesFilePath(file.path)
    );
    return candidates.reduce<CloudFileMetadata | undefined>(
      (newest, file) =>
        !newest || (file.modifiedTime ?? '') > (newest.modifiedTime ?? '') ? file : newest,
      undefined
    );
  }

  /** Download + validate a cloud `series.json`. Returns `undefined` for junk content. */
  private async readCloudSeriesFile(file: CloudFileMetadata): Promise<SeriesFile | undefined> {
    const blob = await this.downloadFile(file);
    try {
      return parseSeriesFile(JSON.parse(await blob.text()));
    } catch {
      // Not JSON at all (hand-edited, truncated upload). Same outcome as a file
      // that fails validation: it carries no usable state, so it gets replaced.
      return undefined;
    }
  }

  /**
   * The index copy to merge on top of: the cached one, unless the cloud listing
   * shows a different (size, modifiedTime) — then another device wrote it after
   * our last fetch and we re-read it first, so the union keeps that device's
   * volumes and its facts still get to win the newest-wins comparison.
   *
   * Throws when the re-read fails: writing on top of a copy we could not read
   * would silently clobber it.
   */
  private async resolveExistingSeriesFile(
    seriesKey: string,
    seriesTitle: string,
    providerType: ProviderType
  ): Promise<SeriesFile | undefined> {
    const cached = await getSeriesIndex(seriesKey);
    const cloudFile = this.getCloudSeriesFile(seriesTitle);
    if (!cloudFile) return cached?.file;

    const stamp = { size: cloudFile.size ?? 0, modifiedTime: cloudFile.modifiedTime ?? '' };
    if (!indexNeedsRefresh(cached, stamp)) return cached?.file;

    const fresh = await this.readCloudSeriesFile(cloudFile);
    if (!fresh) {
      // The cloud copy is junk (hand-edited, truncated, a proxy error page), so
      // this write replaces it — but the volumes another device published are
      // still known from the last good fetch. Merging on top of the CACHED copy
      // keeps them; starting from nothing would quietly delete them from the
      // index for everyone.
      return cached?.file;
    }
    await putSeriesIndex({
      series_key: seriesKey,
      series_title: seriesTitle,
      file: fresh,
      source: {
        provider: providerType,
        path: normalizeCloudPath(cloudFile.path),
        size: stamp.size,
        modifiedTime: stamp.modifiedTime
      },
      fetched_at: new Date().toISOString()
    });
    return fresh;
  }

  /** Volume titles the cloud listing shows as `.cbz` archives in a series folder. */
  private cloudVolumeTitles(seriesTitle: string): Set<string> {
    const titles = new Set<string>();
    for (const file of this.getCloudVolumesBySeries(seriesTitle)) {
      const path = normalizeCloudPath(file.path);
      if (!path.toLowerCase().endsWith('.cbz')) continue;
      const basename = path.split('/').pop();
      if (basename) titles.add(basename.slice(0, -4));
    }
    return titles;
  }

  /**
   * Write `<Series Title>/series.json` — the shareable series facts plus the
   * unauthoritative index of the series' volumes.
   *
   * Merge before write (see `buildSeriesFile`): the copy already in the cloud
   * contributes the volumes of devices that are not this one, and its facts win
   * when they are newer. Installed volumes always override their index entry;
   * placeholders never contribute (their uuids and counts are derived).
   *
   * A cloud copy we cannot read is reported as `'skipped'` rather than
   * overwritten blind; a failed upload throws to the (background) caller, which
   * logs it — a series.json write must never surface in a reading flow.
   *
   * `options.localSeriesTitle` reads the installed volumes under a DIFFERENT
   * title than the one being written: during a series rename the cloud move
   * gates the local commit, so the DB still holds the old title while the file
   * must already be written under the new one.
   */
  async writeSeriesFile(
    seriesTitle: string,
    options?: { localSeriesTitle?: string }
  ): Promise<'written' | 'skipped' | 'read-only'> {
    const provider = this.getActiveProvider();
    if (!provider) return 'skipped';
    if (provider.getStatus().isReadOnly) return 'read-only';

    const seriesKey = normalizeSeriesKey(seriesTitle);
    if (!seriesKey) return 'skipped';

    const localKey = normalizeSeriesKey(options?.localSeriesTitle ?? seriesTitle);
    const allVolumes = (await db.volumes.toArray()) as VolumeMetadata[];
    const localVolumes = allVolumes.filter(
      (volume) => normalizeSeriesKey(volume.series_title) === localKey && !volume.isPlaceholder
    );

    // Same reason as `localSeriesTitle` above: mid-rename the series_metadata
    // record is still filed under the old title, and dropping its facts here
    // would publish a file that unlinks the series everywhere else.
    const meta =
      (await getSeriesMetadataForTitle(seriesTitle)) ??
      (options?.localSeriesTitle
        ? await getSeriesMetadataForTitle(options.localSeriesTitle)
        : undefined);

    let existing: SeriesFile | undefined;
    try {
      existing = await this.resolveExistingSeriesFile(seriesKey, seriesTitle, provider.type);
    } catch (error) {
      console.warn(`Could not read the cloud series.json for '${seriesTitle}':`, error);
      return 'skipped';
    }

    // An empty listing means "not fetched", not "the cloud folder is empty":
    // pruning against it would delete every entry this device does not have.
    const cloudTitles = this.cloudVolumeTitles(seriesTitle);

    const file = buildSeriesFile({
      seriesTitle,
      meta,
      localVolumes,
      existing,
      cloudVolumeTitles: cloudTitles.size > 0 ? cloudTitles : undefined
    });
    if (!file) return 'skipped';

    const path = normalizeCloudPath(`${seriesTitle}/${SERIES_FILE_NAME}`);
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
    await this.uploadFile(path, blob);

    // Stamp the cache with EXACTLY what the file cache now holds for this path
    // (read back rather than re-derived): `indexNeedsRefresh` compares the
    // cached stamp against the listing, so a second `new Date()` here would
    // differ from the entry `uploadFile` just added and make the very next
    // listing re-download our own write. Providers that later report their own
    // modifiedTime still cost at most one extra refresh.
    const uploaded = this.getCloudSeriesFile(seriesTitle);
    const now = new Date().toISOString();
    await putSeriesIndex({
      series_key: seriesKey,
      series_title: seriesTitle,
      file,
      source: {
        provider: provider.type,
        path,
        size: uploaded?.size ?? blob.size,
        modifiedTime: uploaded?.modifiedTime ?? now
      },
      fetched_at: now
    });
    return 'written';
  }

  /**
   * Carry a series' `series.json` to a renamed folder: write it at the new
   * title (merging whatever the old cached/cloud copy held) and drop the stale
   * file. Best-effort — the volumes are already renamed at this point, and the
   * index is a rebuildable convenience.
   */
  private async moveSeriesFileAfterRename(
    oldSeriesTitle: string,
    newSeriesTitle: string
  ): Promise<void> {
    const staleFile = this.getCloudSeriesFile(oldSeriesTitle);
    try {
      // Move the cache first so the write below merges the OLD index instead of
      // starting from an empty one.
      await moveSeriesIndexKey(oldSeriesTitle, newSeriesTitle);
      await this.writeSeriesFile(newSeriesTitle, { localSeriesTitle: oldSeriesTitle });
      if (staleFile) await this.deleteFileIdempotent(staleFile);
    } catch (error) {
      console.warn(`Failed to move series.json to '${newSeriesTitle}':`, error);
    }
  }

  /**
   * Delete an entire series folder (all volumes in the series)
   */
  async deleteSeriesFolder(seriesTitle: string): Promise<{ succeeded: number; failed: number }> {
    const result = await this.deleteSeriesFolderFiles(seriesTitle);
    // The cached index describes a folder that no longer exists. Dropping it is
    // safe either way: it is a download cache, re-fetched if the folder returns.
    try {
      await deleteSeriesIndex(normalizeSeriesKey(seriesTitle));
    } catch (error) {
      console.warn(`Failed to drop the cached series index for '${seriesTitle}':`, error);
    }
    return result;
  }

  private async deleteSeriesFolderFiles(
    seriesTitle: string
  ): Promise<{ succeeded: number; failed: number }> {
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
