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
import { uploadCacheEntry } from './cloud-cache-interface';
import { providerManager } from './provider-manager';
import { generateVolumeSidecarsFromDb } from '$lib/util/compress-volume';
import { isMetadataOnly } from '$lib/catalog/volume-state';
import { volumesForFoldedSeriesTitle } from '$lib/catalog/volumes-by-series';
import { naturalSort } from '$lib/util/natural-sort';
import { db } from '$lib/catalog/db';
import type { VolumeMetadata } from '$lib/types';
import {
  FACTLESS_UPDATED_AT,
  SERIES_FILE_NAME,
  buildSeriesFile,
  hasSeriesFacts,
  isSeriesFilePath,
  parseSeriesFileWithReport,
  seriesFactsStamp,
  type CloudSidecarStamp,
  type SeriesFile,
  type SeriesFileVolume,
  stringifySeriesFile
} from '$lib/metadata/series-file';
import { buildCloudSidecarStamps } from '$lib/metadata/cloud-sidecar-stamps';
import {
  CATALOG_FILE_NAME,
  buildCatalogFile,
  catalogEntryFromMeta,
  catalogSeriesEqual,
  isCatalogFilePath,
  parseCatalogFile,
  stringifyCatalogFile,
  type CatalogFile
} from '$lib/metadata/catalog-file';
import { normalizeSeriesKey, normalizeVolumeTitleKey } from '$lib/metadata/series-key';
import {
  getSeriesMetadataByFoldedTitle,
  getSeriesMetadataByFoldedTitles,
  getSeriesMetadataForTitle,
  upsertFromSeriesFile
} from '$lib/metadata/store';
import type { SeriesMetadata } from '$lib/metadata/types';
import {
  deleteSeriesIndex,
  getSeriesIndex,
  indexNeedsRefresh,
  moveSeriesIndexKey,
  putSeriesIndex,
  type SeriesIndexRecord
} from '$lib/metadata/series-index';
import {
  catalogNeedsRefresh,
  dropCatalogEntries,
  getCatalogIndex,
  moveCatalogIndexKey,
  putCatalogIndex
} from '$lib/metadata/catalog-index';
import { refreshSeriesIndexes } from '$lib/metadata/series-index-sync';
import { refreshCatalogIndex } from '$lib/metadata/catalog-index-sync';
import { markListingFresh, reconcileMissingMetadataFiles } from '$lib/metadata/series-file-sync';
import { sweepInstalledVolumesForSidecarBackfill } from './sidecar-backfill';

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
 * The managed extension a listed file carries (`.cbz`, `.mokuro.gz`, `.webp`…).
 *
 * Read off the file's OWN path rather than by slicing a base path built from the
 * caller's titles: a source file matched by fold can be spelled differently from
 * what was asked for — and a decomposed name is not even the same LENGTH — so
 * slicing would cut the name, not the extension.
 */
function managedExtensionOf(path: string): string {
  const normalized = normalizeCloudPath(path);
  return normalized.slice(stripManagedFileExtension(normalized).length);
}

/**
 * Which of two `series_metadata` records folding to the SAME series wins.
 *
 * Two can exist at once — a cloud upsert files one under a decomposed title
 * while a local import files one under the composed spelling — and the table's
 * key order is an accident, so the scan cannot just take the first match. Same
 * ranking every other merge in this module uses: a record that says something
 * about the series beats one that says nothing, and between two that both speak,
 * the newer FACTS clock wins (never `updated_at`, which every per-user write
 * bumps).
 */
function pickSeriesMetadata(
  current: SeriesMetadata | undefined,
  next: SeriesMetadata
): SeriesMetadata {
  if (!current) return next;

  const currentHasFacts = hasSeriesFacts(current);
  const nextHasFacts = hasSeriesFacts(next);
  if (currentHasFacts !== nextHasFacts) return nextHasFacts ? next : current;

  const currentStamp = seriesFactsStamp(current) ?? FACTLESS_UPDATED_AT;
  const nextStamp = seriesFactsStamp(next) ?? FACTLESS_UPDATED_AT;
  return nextStamp > currentStamp ? next : current;
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
   * Re-read the `series.json` sidecars the CURRENT listing shows as changed.
   *
   * Fire-and-forget by design: the listing itself is what the caller (catalog,
   * cloud screen, rename) is waiting on, while the index refresh is a cache
   * warm-up that may download files. Every failure path is swallowed — an index
   * that stays stale costs a placeholder its counts, nothing more.
   *
   * Public so a caller that had to suppress the automatic refresh (a listing it
   * was about to invalidate by writing sidecars — see `fetchAllCloudVolumes`)
   * can start it once its own writes are done.
   */
  refreshSeriesIndexesInBackground(): void {
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
      // The root catalog rides the same listing: one download for the whole
      // library, skipped entirely when its size/mtime has not moved.
      void Promise.resolve(refreshCatalogIndex(listing, provider.type)).catch((error) =>
        console.warn('Catalog index refresh failed:', error)
      );
      // The refreshes above READ the metadata files; this writes the ones that
      // were never produced. A library uploaded by an older build (or whose
      // facts were set before it was ever connected) has folders full of
      // archives and no `series.json`, and no other path fixes it: the backup
      // run only publishes indexes when it actually uploads something, and the
      // facts listener only fires on a fresh edit. The listing in hand is
      // exactly what the backfill needs, so it rides along here — stamped
      // first, because the writes it queues are 2 s out and would each open
      // with a second whole-account fetch of the listing already in hand.
      markListingFresh();
      void Promise.resolve(reconcileMissingMetadataFiles(files)).catch((error) =>
        console.warn('Metadata backfill failed:', error)
      );
      // The per-VOLUME counterpart of the reconcile above: archives this
      // listing shows without their `.mokuro`/cover sidecars, for volumes
      // installed locally, get them uploaded from local data. Rides the same
      // settled listing for the same reason — the writes it queues must never
      // re-fetch the listing that scheduled them (see `sidecar-backfill.ts`).
      void Promise.resolve(sweepInstalledVolumesForSidecarBackfill(files)).catch((error) =>
        console.warn('Volume sidecar backfill failed:', error)
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
    return this.performUpload(path, blob, description, onProgress, false);
  }

  /**
   * Write-and-forget upload: same contract and same targeted cache add as
   * {@link uploadFile}, but routed through the provider's `blindUploadFile`
   * when it has one — the variant that skips any post-upload refresh work the
   * provider's ordinary upload performs (Google Drive refetches its WHOLE
   * listing after every ordinary upload; see the interface doc). A provider
   * without the method IS already blind, so this falls back to `uploadFile`.
   *
   * WHO MAY USE THIS — the ruling (2026-08-28): most callers use the updated
   * cache to CONFIRM files are backed up and to RENDER those changes — the
   * backup queue's badges, `writeSeriesFile`/`writeCatalogFile` and every
   * flow a view reads back — and they stay on {@link uploadFile}. A caller
   * qualifies for the blind path only when ALL THREE hold, as they do for
   * the sidecar backfill:
   *
   * - the write changes NOTHING any view renders;
   * - the process can simply try again later (self-healing — the next
   *   session's sweep re-derives the gap and re-uploads);
   * - nothing important is lost when it fails.
   *
   * Do not convert another caller to this path on efficiency grounds alone —
   * check it against those three first.
   */
  async blindUploadFile(
    path: string,
    blob: UploadPayload,
    description?: string,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<string> {
    return this.performUpload(path, blob, description, onProgress, true);
  }

  private async performUpload(
    path: string,
    blob: UploadPayload,
    description: string | undefined,
    onProgress: ((loaded: number, total: number) => void) | undefined,
    blind: boolean
  ): Promise<string> {
    const provider = this.getActiveProvider();
    if (!provider) {
      throw new Error('No cloud provider authenticated');
    }

    const uploaded =
      blind && provider.blindUploadFile
        ? await provider.blindUploadFile(path, blob, description, onProgress)
        : await provider.uploadFile(path, blob, description, onProgress);
    const uploadSize =
      blob instanceof Blob
        ? blob.size
        : blob instanceof ArrayBuffer
          ? blob.byteLength
          : blob.byteLength;

    // The targeted post-upload cache maintenance, blind or not: an entry
    // built from the upload response's own provenance (server mtime when
    // reported, marked provisional otherwise) — see `uploadCacheEntry`.
    const cache = cacheManager.getCache(provider.type);
    cache?.add?.(path, uploadCacheEntry(provider.type, path, uploadSize, uploaded, description));

    return uploaded.fileId;
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
    // When the folder still holds volumes, its series.json now lists one too
    // many; either way the catalog's counts and freshness moved.
    await this.scheduleMetadataMaintenance([seriesTitle]);
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
  /**
   * After a delete/rename mutated cloud files, bring the metadata files back
   * in line: every affected series' `series.json` gets the standard debounced
   * rewrite (self-gating — an emptied folder writes nothing, a bunko server
   * merges it as an update request), and one catalog write follows (its own
   * scheduler refuses on servers that compile their own). Best-effort: the
   * heal-by-review pass catches anything this loses.
   */
  private async scheduleMetadataMaintenance(
    seriesTitles: Array<string | undefined>
  ): Promise<void> {
    try {
      const [{ scheduleSeriesFileWrite }, { scheduleCatalogFileWrite }] = await Promise.all([
        import('$lib/metadata/series-file-sync'),
        import('$lib/metadata/catalog-file-sync')
      ]);
      for (const title of new Set(seriesTitles.filter((t): t is string => !!t))) {
        scheduleSeriesFileWrite(title);
      }
      scheduleCatalogFileWrite();
    } catch (error) {
      console.debug('Could not schedule metadata maintenance:', error);
    }
  }

  private async cleanupSeriesFileIfFolderEmptied(seriesTitle: string): Promise<void> {
    try {
      // Same folder the write path uses, and the same key it cached the record
      // under: a caller holding the local spelling of a decomposed folder must
      // still find the sidecar it is cleaning up after.
      const folderTitle = this.resolveCloudFolderTitle(seriesTitle);
      const stillHasArchive = this.getCloudVolumesBySeries(folderTitle).some((file) =>
        normalizeCloudPath(file.path).toLowerCase().endsWith('.cbz')
      );
      if (stillHasArchive) return;

      const sidecar = this.getCloudSeriesFile(folderTitle);
      if (sidecar) await this.deleteFileIdempotent(sidecar);
      await deleteSeriesIndex(normalizeSeriesKey(folderTitle));
    } catch (error) {
      console.warn(`Failed to clean up series.json for '${seriesTitle}':`, error);
    }
  }

  private replaceCachedFile(oldFile: CloudFileMetadata, updatedFile: CloudFileMetadata): void {
    const provider = this.getActiveProvider();
    if (!provider) return;

    const cache = cacheManager.getCache(provider.type);
    cache?.removeById?.(oldFile.fileId);
    // `updatedFile` comes from `provider.renameFile`, which — like
    // `renameFolder` — already sets `modifiedTimeProvisional` correctly
    // per-provider; absent just isn't a `boolean` structurally, so make the
    // "absent means false" reading explicit (see the matching comment on the
    // `renameFolder` cache-replay loop above).
    cache?.add?.(updatedFile.path, {
      ...updatedFile,
      modifiedTimeProvisional: updatedFile.modifiedTimeProvisional ?? false
    });
  }

  /**
   * The cloud files belonging to ONE volume: `<Series>/<Volume Title>.<ext>`.
   * `<Series>/series.json` never matches — it is the series folder's own
   * sidecar, not any volume's (its basename is not a volume title, and `.json`
   * is not a managed volume extension).
   */
  getManagedCloudFilesForVolume(seriesTitle: string, volumeTitle: string): CloudFileMetadata[] {
    // Both halves resolve the same way the folder does: byte-exact first, and a
    // folded match only when nothing is spelled exactly right. A backend that
    // decomposes a folder name decomposes the FILENAMES too, so a byte-wise
    // lookup finds nothing to delete or move there — a silent no-op the UI
    // reports as success. The exact-first order is what keeps that from widening
    // anything: with the file the caller named present, a sibling that merely
    // folds the same way is somebody else's backup and is never touched.
    const folderTitle = this.resolveCloudFolderTitle(seriesTitle);
    const files = this.getCloudVolumesBySeries(folderTitle);

    const basePath = normalizeCloudPath(`${folderTitle}/${volumeTitle}`);
    const exact = files.filter(
      (file) => stripManagedFileExtension(normalizeCloudPath(file.path)) === basePath
    );
    if (exact.length > 0) return exact;

    const key = normalizeVolumeTitleKey(volumeTitle);
    if (!key) return exact;
    const byBase = new Map<string, CloudFileMetadata[]>();
    for (const file of files) {
      const base = stripManagedFileExtension(normalizeCloudPath(file.path));
      const name = base.slice(base.lastIndexOf('/') + 1);
      if (normalizeVolumeTitleKey(name) !== key) continue;
      const group = byBase.get(base);
      if (group) group.push(file);
      else byBase.set(base, [file]);
    }
    if (byBase.size === 0) return exact;
    // Still ONE volume's files, as the contract says: two filenames that fold
    // alike are two volumes, and the pick between them is ordered rather than
    // first-seen so it cannot depend on listing order (same rule as
    // `resolveCloudFolderTitle`).
    const base = [...byBase.keys()].sort(naturalSort)[0];
    return byBase.get(base)!;
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
    // The old folder as the CLOUD spells it, so every step below reads and
    // writes the folder that exists rather than the caller's local spelling of
    // it (see `resolveCloudFolderTitle`).
    const oldFolderTitle = this.resolveCloudFolderTitle(oldSeriesTitle);
    if (this.getManagedCloudFilesForVolume(oldFolderTitle, oldVolumeTitle).length === 0) {
      return 0;
    }

    // The remote rename GATES the local commit (caller updates the DB only if
    // this resolves). A read-only provider cannot perform it, so fail loudly
    // rather than let the caller commit a local rename that diverges from the
    // unchanged remote.
    this.assertWritable(provider);

    const changed = await this.renameVolumeFiles(
      provider,
      oldFolderTitle,
      oldVolumeTitle,
      newSeriesTitle,
      newVolumeTitle,
      volumeUuid,
      options
    );

    if (changed > 0 && oldFolderTitle !== newSeriesTitle) {
      // Sidecar first: while `series.json` is still there the old directory can
      // never be empty, so the prune below would always no-op.
      await this.cleanupSeriesFileIfFolderEmptied(oldFolderTitle);
      await this.pruneSeriesDirectoryIfEmpty(provider, oldFolderTitle);
    }

    if (changed > 0) {
      // The old folder's series.json still lists the moved volume (when other
      // volumes kept the folder alive), the new folder's needs the arrival —
      // and a plain retitle stales the entry in place. Rewrite both sides.
      await this.scheduleMetadataMaintenance([oldFolderTitle, newSeriesTitle]);
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
    // The DESTINATION folder as the cloud spells it, for the same reason the
    // source resolves: on a normalizing backend the caller's composed spelling
    // and a decomposed folder already there are ONE folder. The collision gate
    // below compares against files found under the resolved name, so a raw
    // `newBasePath` could never match them — and the gate would wave through
    // exactly the case it exists for. Unresolvable (a folder that does not exist
    // yet) returns the caller's spelling untouched, which is the normal path.
    const newFolderTitle = this.resolveCloudFolderTitle(newSeriesTitle);
    const newBasePath = normalizeCloudPath(`${newFolderTitle}/${newVolumeTitle}`);
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
    // A metadata-only volume has no OCR here to rebuild the sidecar from, so
    // there is nothing to read and the gate below turns it into a clear error.
    const volumeIsMetadataOnly = volumeUuid
      ? isMetadataOnly((await db.volumes.get(volumeUuid)) ?? ({} as VolumeMetadata))
      : false;
    if (volumeUuid && !volumeIsMetadataOnly) {
      const sidecars = await generateVolumeSidecarsFromDb(volumeUuid, {
        seriesTitle: newSeriesTitle,
        volumeTitle: newVolumeTitle
      });
      freshMokuroBlob = sidecars.mokuro?.blob ?? null;
    }

    // GATE (before any remote write): an OCR volume that already has a .mokuro
    // in the cloud but whose sidecar we COULDN'T regenerate (e.g. volume_ocr
    // row missing — a DB inconsistency, or a metadata-only volume whose OCR is
    // simply not on this device) must not be renamed. Moving its stale sidecar
    // would silently revert the rename on re-download — the exact bug this
    // fixes — so fail loudly while nothing has changed.
    if (volumeUuid && hasCloudMokuro && !freshMokuroBlob) {
      throw new ProviderError(
        volumeIsMetadataOnly
          ? 'Cannot rename: this volume is not on this device — download it first'
          : 'Cannot rename: the OCR sidecar could not be regenerated (volume_ocr data missing)',
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
      return destinationPaths.has(`${newBasePath}${managedExtensionOf(file.path)}`);
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
      await this.moveFile(provider, file, `${newBasePath}${managedExtensionOf(file.path)}`);
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
        await this.moveFile(provider, file, `${newBasePath}${managedExtensionOf(file.path)}`);
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

    // The OLD folder as the cloud spells it. Everything below reads that folder
    // — the file list, the gates built from its paths, the per-volume renames,
    // the sidecar carry-over and the empty-directory prune — so it is resolved
    // once, here, and never re-derived from the caller's (local) spelling.
    const oldFolderTitle = this.resolveCloudFolderTitle(oldSeriesTitle);
    const existingFiles = this.getCloudVolumesBySeries(oldFolderTitle);
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
        volumes.map((v) => normalizeCloudPath(`${oldFolderTitle}/${v.volumeTitle}`))
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
        const names = cloudOnlyBases.map((base) =>
          base.slice(normalizeCloudPath(oldFolderTitle).length + 1)
        );
        const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? ', …' : '');
        throw new ProviderError(
          `Series not renamed: ${names.length} backed-up volume(s) in this series ` +
            `are not in your local library (${shown}). Download them first, then rename the series.`,
          provider.type,
          'CLOUD_ONLY_VOLUMES'
        );
      }

      // GATE (before any remote write): a metadata-only volume that has OCR and
      // a `.mokuro` in the cloud cannot have that sidecar regenerated here —
      // its `volume_ocr` row is not on this device. Left to the fan-out it
      // would fail AFTER its siblings had already moved, splitting the series
      // across two cloud folders while `moveSeriesMetadataKey` carried the
      // series record to the new title, and no retry could ever converge. Same
      // answer as a cloud-only volume: download it first, nothing renamed.
      const localRows = await Promise.all(volumes.map((v) => db.volumes.get(v.volumeUuid)));
      const strandedTitles = volumes
        .filter((volume, index) => {
          const row = localRows[index];
          if (!row || !isMetadataOnly(row)) return false;
          // Image-only volumes have no sidecar to regenerate — they move fine.
          if (!row.mokuro_version?.trim()) return false;
          const base = normalizeCloudPath(`${oldFolderTitle}/${volume.volumeTitle}`);
          return existingFiles.some(
            (file) =>
              isMokuroSidecarPath(file.path) &&
              stripManagedFileExtension(normalizeCloudPath(file.path)) === base
          );
        })
        .map((volume) => volume.volumeTitle);
      if (strandedTitles.length > 0) {
        const shown =
          strandedTitles.slice(0, 3).join(', ') + (strandedTitles.length > 3 ? ', …' : '');
        throw new ProviderError(
          `Series not renamed: ${strandedTitles.length} volume(s) in this series are not on ` +
            `this device (${shown}), so their text data cannot be rewritten with the new name. ` +
            `Download them first, then rename the series.`,
          provider.type,
          'CLOUD_ONLY_VOLUMES'
        );
      }

      const result: SeriesRenameResult = { changed: 0, renamedVolumeUuids: [], failures: [] };
      for (const { volumeUuid, volumeTitle } of volumes) {
        try {
          result.changed += await this.renameVolumeFiles(
            provider,
            oldFolderTitle,
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
        await this.moveSeriesFileAfterRename(oldFolderTitle, newSeriesTitle);
      }

      // ONE prune attempt after the whole fan-out (not per volume): the
      // provider server-checks emptiness, so this is safe even when some
      // volumes failed and their files still occupy the old directory.
      if (result.renamedVolumeUuids.length > 0) {
        await this.pruneSeriesDirectoryIfEmpty(provider, oldFolderTitle);
        // The moved series.json still says "series_title": old name inside it,
        // and the catalog still lists the old folder. Rewrite both.
        await this.scheduleMetadataMaintenance([oldFolderTitle, newSeriesTitle]);
      }

      return result;
    }

    // Legacy path (no volume list, e.g. an image-only series): no .mokuro to
    // regenerate, so a provider-optimized bulk folder move is correct.
    const renamedFiles = await provider.renameFolder(oldFolderTitle, newSeriesTitle);

    // A folder move carries `series.json` along with everything else — only the
    // cached index, which is keyed by series title, has to follow. Keyed off the
    // FOLDER, which is the key every writer here cached it under.
    try {
      await moveSeriesIndexKey(oldFolderTitle, newSeriesTitle);
      await moveCatalogIndexKey(oldFolderTitle, newSeriesTitle);
    } catch (error) {
      console.warn(`Failed to move the cached series index to '${newSeriesTitle}':`, error);
    }
    // The carried series.json still names the old series inside it, and the
    // catalog still lists the old folder. Rewrite both.
    await this.scheduleMetadataMaintenance([oldFolderTitle, newSeriesTitle]);

    const cache = cacheManager.getCache(provider.type);
    if (cache?.removeById && cache?.add) {
      for (const file of existingFiles) {
        cache.removeById(file.fileId);
      }
      for (const file of renamedFiles) {
        // `renameFolder` already sets `modifiedTimeProvisional` correctly
        // per-provider (true when it fabricated the mtime, absent/false when
        // the server reported one back) — absent just isn't a `boolean`
        // structurally, so make the "absent means false" reading explicit.
        cache.add(file.path, {
          ...file,
          modifiedTimeProvisional: file.modifiedTimeProvisional ?? false
        });
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

  /**
   * Download + validate a cloud `series.json`. Returns `undefined` for junk
   * content. `entryCollapse` reports that the RAW bytes carried doubled
   * entries the parse healed away — the callers persist it as
   * `SeriesIndexRecord.raw_entry_collapse` so the heal seam can schedule the
   * overwrite that repairs the published file (see that field's doc).
   */
  private async readCloudSeriesFile(
    file: CloudFileMetadata
  ): Promise<{ file: SeriesFile; entryCollapse: boolean } | undefined> {
    const blob = await this.downloadFile(file);
    try {
      const report = parseSeriesFileWithReport(JSON.parse(await blob.text()));
      if (!report.file) return undefined;
      return { file: report.file, entryCollapse: report.entryCollapse };
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
   *
   * There is no way to switch the re-read off, and deliberately so: the stamp
   * check above already makes it free for every write of our own (our upload
   * stamped the cache with exactly what the listing shows), so the only time it
   * costs a GET is when ANOTHER device wrote the file — the one case where
   * skipping it would publish our stale copy over theirs. An earlier draft let
   * the mid-run per-volume write pass `skipRemoteRefresh` for a "zero network
   * reads" guarantee; it saved nothing on the paths it was aimed at and lost
   * exactly the writes it needed to keep.
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
    if (!indexNeedsRefresh(cached, stamp, providerType)) return cached?.file;

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
      file: fresh.file,
      source: {
        provider: providerType,
        path: normalizeCloudPath(cloudFile.path),
        size: stamp.size,
        modifiedTime: stamp.modifiedTime
      },
      fetched_at: new Date().toISOString(),
      ...(fresh.entryCollapse ? { raw_entry_collapse: true } : {})
    });
    return fresh.file;
  }

  /**
   * The series record for a title that may be a cloud FOLDER name.
   *
   * The exact key first — `series_metadata` is keyed by `normalizeSeriesKey`, so
   * that already absorbs case and whitespace and is the answer for every
   * ordinary call, at one primary-key `get`. Only when it misses does this fall
   * back to the folded lookup, because the one difference the key cannot absorb
   * is the unicode form: a folder that came back decomposed from the filesystem,
   * or a record written from a decomposed title. That fallback is an index read
   * on `folded_key`, not the whole-table scan it used to be — this runs once per
   * downloaded series.
   *
   * Without the fallback `writeSeriesFile` publishes an index full of volumes
   * (its rows filter DOES fold) and empty of facts — a file that unlinks the
   * series for every device that reads it, while `catalog.json`, which folds its
   * own lookup, publishes the same series linked.
   */
  private async resolveSeriesMetadata(seriesTitle: string): Promise<SeriesMetadata | undefined> {
    const exact = await getSeriesMetadataForTitle(seriesTitle);
    if (exact) return exact;

    let best: SeriesMetadata | undefined;
    for (const meta of await getSeriesMetadataByFoldedTitle(seriesTitle)) {
      best = pickSeriesMetadata(best, meta);
    }
    return best;
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
   * The folder name the CLOUD spells this series with.
   *
   * Every cache accessor keys the folder exactly (`path.startsWith(title + '/')`),
   * which is right — two folders that differ in case really are two folders on a
   * case-sensitive backend — but it cannot see through unicode form. A folder
   * that came back decomposed from the filesystem is reached by the reconcile
   * pass (which uses the listing's own spelling) and missed by every later
   * trigger, which carries the local composed title: the gate finds no archive,
   * the write is skipped, and the folder's facts never move again.
   *
   * Exact match first, so the ordinary case costs one cache read and nothing
   * else, and the answer is always the LISTING's spelling — the folder name is
   * the path a write goes to, and is never derived. Unresolvable (a series the
   * cloud does not hold) returns the title unchanged, so the gates downstream
   * skip exactly as they did before.
   */
  resolveCloudFolderTitle(seriesTitle: string): string {
    if (this.getCloudVolumesBySeries(seriesTitle).length > 0) return seriesTitle;

    const key = normalizeVolumeTitleKey(seriesTitle);
    if (!key) return seriesTitle;
    const candidates = [...this.cloudFolderNames()].filter(
      (title) => normalizeVolumeTitleKey(title) === key
    );
    if (candidates.length === 0) return seriesTitle;
    // Two folders CAN fold alike ("One Piece" beside "ONE  PIECE" on a
    // case-sensitive backend). Neither is more correct, but the pick must be
    // stable across listings — alternating would publish half an index to each —
    // so it is ordered, not first-seen.
    return candidates.sort(naturalSort)[0];
  }

  /**
   * Every folder the listing shows a file in — archives, sidecars, covers alike.
   *
   * Wider than `cloudSeriesTitles` (which wants a `.cbz`) because the callers of
   * {@link resolveCloudFolderTitle} include the clean-up paths: a folder whose
   * last archive was just deleted still has a `series.json` to retire, and it
   * has to be findable by the title the caller holds. Every gate downstream
   * still asks for archives separately, so widening this cannot make a write
   * happen for an empty folder.
   */
  private cloudFolderNames(): Set<string> {
    const folders = new Set<string>();
    for (const file of this.getAllCloudVolumes()) {
      const parts = normalizeCloudPath(file.path).split('/');
      if (parts.length !== 2 || !parts[0]) continue;
      folders.add(parts[0]);
    }
    return folders;
  }

  /**
   * Volume titles the cloud listing shows as `.cbz` archives in a series folder,
   * found by {@link resolveCloudFolderTitle} so a caller holding the local
   * spelling of a decomposed folder still sees them.
   */
  cloudVolumeTitlesFor(seriesTitle: string): Set<string> {
    return this.cloudVolumeTitles(this.resolveCloudFolderTitle(seriesTitle));
  }

  /**
   * Re-read ONE series' `series.json`, event-driven.
   *
   * The listing-wide pass (`series-index-sync.ts`) is a background warm-up that
   * may be minutes behind; opening a series must not wait for it. Same gate
   * though — size/mtime against the cached record — so re-opening a series
   * costs nothing, and same best-effort contract: never rejects, and returns the
   * freshest copy this device has (the cached one when the cloud has not moved,
   * `undefined` when there is no readable file at all).
   */
  async refreshSeriesIndexForSeries(seriesTitle: string): Promise<SeriesFile | undefined> {
    const seriesKey = normalizeSeriesKey(seriesTitle);
    if (!seriesKey) return undefined;

    // Every read is inside the try, including the cache lookup: this is called
    // from a view's load path and its contract is that it never rejects.
    let cached: SeriesIndexRecord | undefined;
    try {
      // The caller opens the series by its LOCAL title; everything below —
      // the archive gate, the sidecar, the cache record and the facts it
      // applies — belongs to the folder the cloud actually spells (see
      // `resolveCloudFolderTitle`). Resolving once and using it throughout is
      // what keeps ONE cached record per folder: keying the record with the
      // local spelling while the listing-driven pass keys it with the folder's
      // leaves two records for one file, each re-downloading it in turn.
      const folderTitle = this.resolveCloudFolderTitle(seriesTitle);
      const folderKey = normalizeSeriesKey(folderTitle) || seriesKey;
      cached = await getSeriesIndex(folderKey);

      const provider = this.getActiveProvider();
      if (!provider) return cached?.file;

      // Same contract as the listing-wide pass (`series-index-sync.ts`): the
      // index belongs to a folder of volumes. An orphan sidecar left behind by
      // a deleted series must not seed a cache record or a series_metadata row
      // — and bailing before the stamp check also stops it being re-downloaded
      // on every single open, since nothing would ever cache its stamp.
      if (this.cloudVolumeTitles(folderTitle).size === 0) return cached?.file;

      const cloudFile = this.getCloudSeriesFile(folderTitle);
      if (!cloudFile) return cached?.file;

      const stamp = { size: cloudFile.size ?? 0, modifiedTime: cloudFile.modifiedTime ?? '' };
      if (!indexNeedsRefresh(cached, stamp, provider.type)) return cached?.file;

      const fresh = await this.readCloudSeriesFile(cloudFile);
      if (!fresh) return cached?.file;

      await putSeriesIndex({
        series_key: folderKey,
        series_title: folderTitle,
        file: fresh.file,
        source: {
          provider: provider.type,
          path: normalizeCloudPath(cloudFile.path),
          size: stamp.size,
          modifiedTime: stamp.modifiedTime
        },
        fetched_at: new Date().toISOString(),
        ...(fresh.entryCollapse ? { raw_entry_collapse: true } : {})
      });
      // Facts only, strictly-newer only, never a write trigger. The shelf
      // alignment is not applied to the record — the `series_index` row cached
      // just above is what carries it, joined at display time
      // (`getSpineOffsets`), so it stays the publishing device's value.
      await upsertFromSeriesFile(folderTitle, fresh.file);
      return fresh.file;
    } catch (error) {
      console.debug(`Could not refresh series.json for '${seriesTitle}':`, error);
      return cached?.file;
    }
  }

  /**
   * Everything a `series.json` build needs besides the copy to merge on top
   * of, assembled the ONE way: the folded local rows, the series facts, the
   * folder as the LISTING spells it, the archive gate, and the current
   * listing's sidecar stamps.
   *
   * Shared by `writeSeriesFile` and `previewSeriesFileBuild` BY DESIGN, not
   * convenience: the heal seam (`series-backfill.ts`) compares a preview
   * build against the published copy to decide whether an overwrite is worth
   * scheduling, and the scheduled write then rebuilds through this same
   * assembly. If the two assemblies could drift, the heal predicate could
   * keep finding a "difference" the write never publishes — a write per
   * reconcile pass, forever. One assembly makes that structurally impossible.
   *
   * `undefined` = the write-side gates failed: the provider's listing cache
   * is not fully loaded (see the comment inline — pruning against a partial
   * listing deletes other devices' volumes), or the folder has no `.cbz` at
   * all (an index never describes an empty folder).
   */
  private async assembleSeriesBuildInputs(
    provider: SyncProvider,
    seriesTitle: string,
    localSeriesTitle: string | undefined,
    /**
     * How the local rows are read. `'scan'` (the write path) keeps
     * `writeSeriesFile`'s long-standing whole-table read; `'indexed'` (the
     * heal preview) answers off the `series_title` index instead —
     * `volumesForFoldedSeriesTitle`, the same read `runBackfill` and
     * `hasBackedUpVolume` use — because the preview runs once per
     * sidecar-bearing folder per reconcile pass, and a full table scan at
     * that frequency is exactly the per-series always-scan cost the
     * write-slot fix removed. Both sources feed the ONE filter below, so
     * they cannot disagree about which rows count.
     */
    rowSource: 'scan' | 'indexed'
  ): Promise<
    | {
        folderTitle: string;
        folderKey: string;
        meta: SeriesMetadata | undefined;
        localVolumes: VolumeMetadata[];
        cloudTitles: Set<string>;
        cloudSidecarStamps: Map<string, CloudSidecarStamp>;
      }
    | undefined
  > {
    // Folded with `normalizeVolumeTitleKey`, not the plain series key: this
    // matches a cloud FOLDER name against titles stored in IndexedDB, and a
    // folder that made the round trip through a filesystem can come back
    // decomposed (NFD) while the rows stay composed. Byte-wise the filter then
    // matches nothing and the index is published with no volumes at all.
    const localKey = normalizeVolumeTitleKey(localSeriesTitle ?? seriesTitle);
    const rows =
      rowSource === 'scan'
        ? ((await db.volumes.toArray()) as VolumeMetadata[])
        : await volumesForFoldedSeriesTitle(
            localSeriesTitle ?? seriesTitle,
            normalizeVolumeTitleKey
          );
    const localVolumes = rows.filter(
      (volume) => normalizeVolumeTitleKey(volume.series_title) === localKey && !volume.isPlaceholder
    );

    // Same reason as `localSeriesTitle` above: mid-rename the series_metadata
    // record is still filed under the old title, and dropping its facts here
    // would publish a file that unlinks the series everywhere else.
    const meta =
      (await this.resolveSeriesMetadata(seriesTitle)) ??
      (localSeriesTitle ? await this.resolveSeriesMetadata(localSeriesTitle) : undefined);

    // Both gates below need a COMPLETE listing, and only the cache knows it has
    // one: `uploadFile` adds every upload to it, so mid-`fetchAll()` the folder
    // lists this device's own uploads and nothing else — non-empty, and pruning
    // `buildSeriesFile` against it drops the volumes every other device
    // published. Callers prime the listing before writing, but priming is not
    // the same as finished.
    const cache = cacheManager.getCache(provider.type);
    if (!cache?.isLoaded()) return undefined;

    // From here on the CLOUD's spelling of the folder, and the key that goes
    // with it: the file is written into that folder, and its cached record must
    // be the one the listing-driven refresh reads back.
    const folderTitle = this.resolveCloudFolderTitle(seriesTitle);
    const folderKey = normalizeSeriesKey(folderTitle) || normalizeSeriesKey(seriesTitle);

    // The index describes a folder of volumes: with no `.cbz` in it there is
    // nothing to index, and writing would create `<Series>/series.json` (and
    // the folder itself) for a series the cloud does not hold — a local-only
    // series, or one whose volumes have all been deleted.
    const cloudTitles = this.cloudVolumeTitles(folderTitle);
    if (cloudTitles.size === 0) return undefined;

    // Cheap: the folder's listing is already fetched (the `cache?.isLoaded()`
    // gate above), so this is a local grouping pass, not a network call. Built
    // on every write, not just a backfill-triggered one — an ordinary install
    // or fact edit is exactly where an INSTALLED row picks up its own
    // `mokuro_size`/`cover_size` stamps (see `buildSeriesFile`).
    const cloudSidecarStamps = buildCloudSidecarStamps(this.getCloudVolumesBySeries(folderTitle));

    return { folderTitle, folderKey, meta, localVolumes, cloudTitles, cloudSidecarStamps };
  }

  /**
   * What `writeSeriesFile(seriesTitle)` WOULD publish, given `existing` as
   * the copy to merge on top of — built through the same
   * `assembleSeriesBuildInputs` a real write uses, with no network read and
   * no upload.
   *
   * For the heal seam only (`series-backfill.ts`'s
   * `maybeScheduleSeriesHealWrite`), which piggybacks on read cycles that
   * already hold the freshest cached copy of the published file — that is why
   * `existing` is an argument rather than re-resolved here: re-reading it
   * would add a network GET to a pure decision step, and the caller's copy
   * came through the stamp-gated `refreshSeriesIndexForSeries` moments
   * before. `undefined` when there is nothing a write could do: no provider,
   * a read-only provider, or the assembly gates (unloaded cache, archiveless
   * folder) say a write would be `'skipped'` anyway.
   */
  async previewSeriesFileBuild(
    seriesTitle: string,
    existing: SeriesFile | undefined
  ): Promise<{ built: SeriesFile | undefined; cloudTitleKeys: Set<string> } | undefined> {
    const provider = this.getActiveProvider();
    if (!provider) return undefined;
    if (provider.getStatus().isReadOnly) return undefined;
    if (!normalizeSeriesKey(seriesTitle)) return undefined;

    const inputs = await this.assembleSeriesBuildInputs(
      provider,
      seriesTitle,
      undefined,
      'indexed'
    );
    if (!inputs) return undefined;

    const built = buildSeriesFile({
      seriesTitle: inputs.folderTitle,
      meta: inputs.meta,
      localVolumes: inputs.localVolumes,
      existing,
      cloudVolumeTitles: inputs.cloudTitles,
      cloudSidecarStamps: inputs.cloudSidecarStamps
    });
    return {
      built,
      cloudTitleKeys: new Set([...inputs.cloudTitles].map(normalizeVolumeTitleKey))
    };
  }

  /**
   * Write `<Series Title>/series.json` — the shareable series facts plus the
   * unauthoritative index of the series' volumes.
   *
   * Merge before write (see `buildSeriesFile`): the copy already in the cloud
   * contributes the volumes of devices that are not this one, and its facts win
   * when they are newer. Local rows rank in three tiers, not two: INSTALLED
   * volumes override their index entry and are exempt from the listing prune;
   * metadata-only rows (including ones materialized from an index) only FILL an
   * entry the file lacks, never overriding and never exempting; placeholders
   * never contribute at all, their uuids and counts being derived.
   *
   * A folder the listing shows no `.cbz` in is `'skipped'`: the index belongs
   * to a folder of volumes, never to an empty one. A cloud copy we cannot read
   * is `'skipped'` too rather than overwritten blind; a failed upload throws to
   * the (background) caller, which logs it — a series.json write must never
   * surface in a reading flow.
   *
   * `options.localSeriesTitle` reads the installed volumes under a DIFFERENT
   * title than the one being written: during a series rename the cloud move
   * gates the local commit, so the DB still holds the old title while the file
   * must already be written under the new one.
   *
   * Everything CLOUD-facing here — the archive gate, the copy to merge on top
   * of, and the upload path itself — goes through the folder name the listing
   * actually shows (`resolveCloudFolderTitle`), because the path IS the folder:
   * writing under the caller's spelling of a decomposed folder would create a
   * second folder next to the real one. Everything LOCAL-facing keeps the
   * caller's title, folded where it has to meet the cloud.
   *
   * The only network READ this method can make is `resolveExistingSeriesFile`'s
   * re-read, and only when the listing shows a copy our cache has not seen (see
   * its doc comment). The `cache?.isLoaded()` and `cloudVolumeTitles` gates
   * below read the provider's already-fetched listing cache, and `uploadFile` at
   * the end is the write itself, not a read.
   */
  async writeSeriesFile(
    seriesTitle: string,
    options?: {
      localSeriesTitle?: string;
      /**
       * Entries a caller built by pulling sidecars straight from the cloud
       * folder for THIS write — see `buildSeriesFile`'s own doc for the rank
       * (above published, below installed). Two producers: `series-
       * backfill.ts`'s own direct call (a whole-series reconcile sweep) and
       * `series-file-sync.ts`'s debounced `performWrite`, which threads
       * through whatever `ScheduleOptions.cloudMeasuredVolumes` a caller
       * scheduled with — `cover-service.ts`'s render-demand bare-placeholder
       * resolution (decision-tree case 3) is that debounced path's own
       * producer. Every OTHER write publishes local state only.
       */
      cloudMeasuredVolumes?: SeriesFileVolume[];
    }
  ): Promise<'written' | 'skipped' | 'read-only'> {
    const provider = this.getActiveProvider();
    if (!provider) return 'skipped';
    if (provider.getStatus().isReadOnly) return 'read-only';

    const seriesKey = normalizeSeriesKey(seriesTitle);
    if (!seriesKey) return 'skipped';

    const inputs = await this.assembleSeriesBuildInputs(
      provider,
      seriesTitle,
      options?.localSeriesTitle,
      'scan'
    );
    if (!inputs) return 'skipped';
    const { folderTitle, folderKey, meta, localVolumes, cloudTitles, cloudSidecarStamps } = inputs;

    let existing: SeriesFile | undefined;
    try {
      existing = await this.resolveExistingSeriesFile(folderKey, folderTitle, provider.type);
    } catch (error) {
      console.warn(`Could not read the cloud series.json for '${folderTitle}':`, error);
      return 'skipped';
    }

    const file = buildSeriesFile({
      seriesTitle: folderTitle,
      meta,
      localVolumes,
      existing,
      cloudVolumeTitles: cloudTitles,
      cloudMeasuredVolumes: options?.cloudMeasuredVolumes,
      cloudSidecarStamps
    });
    if (!file) return 'skipped';

    // No content-equality skip here, unlike `writeCatalogFile`. That is
    // deliberate: on a bunko-backed library a `series.json` PUT is an update
    // *request* the server folds into its own compilation, so a file identical
    // to the one already in the cloud still carries information (this device
    // vouching for it) and re-publishing costs one small upload. The catalog is
    // the opposite case — one big file every device re-downloads whenever its
    // stamp moves — which is why the skip lives there and not here.
    const path = normalizeCloudPath(`${folderTitle}/${SERIES_FILE_NAME}`);
    const blob = new Blob([stringifySeriesFile(file)], { type: 'application/json' });
    await this.uploadFile(path, blob);

    // Stamp the cache with EXACTLY what the file cache now holds for this path
    // (read back rather than re-derived): `indexNeedsRefresh` compares the
    // cached stamp against the listing, so a second `new Date()` here would
    // differ from the entry `uploadFile` just added and make the very next
    // listing re-download our own write. Providers that later report their own
    // modifiedTime still cost at most one extra refresh.
    const uploaded = this.getCloudSeriesFile(folderTitle);
    const now = new Date().toISOString();
    await putSeriesIndex({
      series_key: folderKey,
      series_title: folderTitle,
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

  /** The root `catalog.json` entry of the current listing, if any. */
  private getCloudCatalogFile(): CloudFileMetadata | undefined {
    const candidates = this.getAllCloudVolumes().filter((file) => isCatalogFilePath(file.path));
    return candidates.reduce<CloudFileMetadata | undefined>(
      (newest, file) =>
        !newest || (file.modifiedTime ?? '') > (newest.modifiedTime ?? '') ? file : newest,
      undefined
    );
  }

  /** Every series FOLDER the current listing shows (folder name, never derived). */
  private cloudSeriesTitles(): Set<string> {
    const titles = new Set<string>();
    for (const file of this.getAllCloudVolumes()) {
      const parts = normalizeCloudPath(file.path).split('/');
      if (parts.length !== 2) continue;
      if (!parts[1].toLowerCase().endsWith('.cbz')) continue;
      titles.add(parts[0]);
    }
    return titles;
  }

  /**
   * The catalog copy to merge on top of: the cached copy, unless the listing
   * shows a different (size, modifiedTime) — then another device wrote it after
   * our last fetch, so we re-read it first and the union keeps that device's
   * series. Throws when the re-read fails: writing on top of a copy we could not
   * read would silently clobber it.
   *
   * `faithful` says whether the returned copy is known to be what the cloud file
   * holds right now — true for a copy just downloaded, and for a cached copy the
   * listing stamp vouches for. It is false when there is no cloud file at all
   * and when the cloud copy was junk, which is exactly when an identical rebuild
   * must still be published rather than short-circuited as a no-op.
   */
  private async resolveExistingCatalogFile(
    providerType: ProviderType
  ): Promise<{ file: CatalogFile | undefined; faithful: boolean }> {
    const cached = await getCatalogIndex();

    const cloudFile = this.getCloudCatalogFile();
    if (!cloudFile) return { file: cached?.file, faithful: false };

    const stamp = { size: cloudFile.size ?? 0, modifiedTime: cloudFile.modifiedTime ?? '' };
    if (!catalogNeedsRefresh(cached, stamp, providerType))
      return { file: cached?.file, faithful: true };

    const blob = await this.downloadFile(cloudFile);
    let fresh: CatalogFile | undefined;
    try {
      fresh = parseCatalogFile(JSON.parse(await blob.text()));
    } catch {
      fresh = undefined;
    }
    // Junk in the cloud (hand-edited, truncated, a proxy error page): this write
    // replaces it, but the series other devices published are still known from
    // the last good fetch, so merge on top of the CACHE rather than nothing.
    return fresh ? { file: fresh, faithful: true } : { file: cached?.file, faithful: false };
  }

  /**
   * Write the root `catalog.json` — the name/mapping/search data for every
   * series folder the cloud holds.
   *
   * Union-by-key with the copy already in the cloud (newest facts stamp wins per
   * series, `buildCatalogFile`) so a device that only holds part of the library
   * cannot delete the rest, then pruned against the listing so a deleted folder
   * drops out. Never written when the listing is empty: that means "not fetched"
   * as often as "empty cloud", and publishing an empty catalog would blank every
   * other device's view.
   *
   * `'server-compiled'` on a bunko-backed provider: bunko is the sole producer of
   * this file, and a client write would race its regeneration.
   */
  async writeCatalogFile(): Promise<'written' | 'skipped' | 'read-only' | 'server-compiled'> {
    const provider = this.getActiveProvider();
    if (!provider) return 'skipped';
    const status = provider.getStatus();
    if (status.serverCompilesMetadata) return 'server-compiled';
    if (status.isReadOnly) return 'read-only';

    // The prune below is only sound against a COMPLETE listing, and a non-empty
    // one is no proof of that: `uploadFile` adds every upload to the cache, so a
    // backup running before `fetchAll()` finishes leaves a listing holding this
    // device's own uploads and nothing else. Publishing then prunes every series
    // this device has not seen out of the catalog — the whole library blanked
    // for everyone else. Only the cache itself knows it has been filled.
    const cache = cacheManager.getCache(provider.type);
    if (!cache?.isLoaded()) return 'skipped';

    const cloudTitles = this.cloudSeriesTitles();
    if (cloudTitles.size === 0) return 'skipped';

    let existing: CatalogFile | undefined;
    let faithful = false;
    try {
      ({ file: existing, faithful } = await this.resolveExistingCatalogFile(provider.type));
    } catch (error) {
      console.debug('Could not read the cloud catalog.json:', error);
      return 'skipped';
    }

    // Re-keyed with `normalizeVolumeTitleKey` on BOTH sides: `cloudTitles` are
    // folder names off a filesystem and can be decomposed (NFD) while the
    // records are keyed off the composed local title. A byte-wise lookup misses
    // and the series is published as a factless epoch entry — its links dropped
    // for every device that reads the catalog.
    // Read through the `folded_key` index for exactly the folders being
    // published, not the whole table: a library with series the cloud does not
    // hold never deserializes their records at all. `folded_key` is the stored
    // fold of `series_title`, so re-folding the row here would only be a chance
    // to disagree with the index that found it.
    const metaByFoldedKey = new Map(
      (await getSeriesMetadataByFoldedTitles(cloudTitles)).map((meta) => [meta.folded_key, meta])
    );
    const entries = [...cloudTitles].map((title) =>
      catalogEntryFromMeta(title, metaByFoldedKey.get(normalizeVolumeTitleKey(title)))
    );

    const file = buildCatalogFile({ entries, existing, cloudSeriesTitles: cloudTitles });
    if (!file) return 'skipped';

    // Nothing to say that the cloud copy does not already say. Publishing anyway
    // would change only the build stamp — new bytes, new mtime — and that flips
    // `catalogNeedsRefresh` on every other device, making them all re-download a
    // file that did not change. Only sound when the copy we compared against is
    // known to be the cloud's current content.
    if (faithful && catalogSeriesEqual(file.series, existing?.series)) {
      // Still stamp the cache. The content is known-good — freshly downloaded,
      // or a cached copy the listing stamp vouches for — and without the stamp
      // `catalogNeedsRefresh` stays true forever, so every later write would
      // re-download catalog.json just to reach this same conclusion.
      await this.stampCatalogCache(provider.type, file);
      return 'skipped';
    }

    const blob = new Blob([stringifyCatalogFile(file)], { type: 'application/json' });
    await this.uploadFile(CATALOG_FILE_NAME, blob);
    await this.stampCatalogCache(provider.type, file, blob.size);
    return 'written';
  }

  /**
   * Point the `catalog_index` cache at what the cloud's `catalog.json` holds
   * right now: `file`, stamped with the listing entry for that path.
   *
   * The stamp is read back from the file cache rather than re-derived, same
   * reason as `writeSeriesFile`: a second `new Date()` would differ from the
   * entry `uploadFile` just added and make the very next listing re-download our
   * own write. `fallbackSize` covers a provider whose cache has no entry yet.
   */
  private async stampCatalogCache(
    providerType: ProviderType,
    file: CatalogFile,
    fallbackSize = 0
  ): Promise<void> {
    const cloudFile = this.getCloudCatalogFile();
    const now = new Date().toISOString();
    const source = {
      provider: providerType,
      path: CATALOG_FILE_NAME,
      size: cloudFile?.size ?? fallbackSize,
      modifiedTime: cloudFile?.modifiedTime ?? now
    };
    // Same accessor the read half uses, so the cache has exactly one writer shape.
    await putCatalogIndex({ file, source, fetched_at: now });
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
    // The OLD folder as the cloud spells it — the sidecar being retired is its
    // file, and the "does it still hold archives?" test below reads the same
    // folder. Resolved once so the two cannot disagree.
    const oldFolderTitle = this.resolveCloudFolderTitle(oldSeriesTitle);
    const staleFile = this.getCloudSeriesFile(oldFolderTitle);
    try {
      // Move the cache first so the write below merges the OLD index instead of
      // starting from an empty one.
      await moveSeriesIndexKey(oldFolderTitle, newSeriesTitle);
      // Its own guard: the catalog cache is a disposable download cache, and an
      // abort while moving its key must not skip the series.json carry-over
      // below — the only step here that touches the cloud.
      try {
        await moveCatalogIndexKey(oldFolderTitle, newSeriesTitle);
      } catch (error) {
        console.debug(`Could not move the cached catalog entry to '${newSeriesTitle}':`, error);
      }
      const outcome = await this.writeSeriesFile(newSeriesTitle, {
        localSeriesTitle: oldSeriesTitle
      });
      // Retire the old file once the new one exists — or when the old folder
      // holds no archive any more (a stale sidecar with nothing to index). A
      // skipped write while the old folder still lists archives means the
      // moved files have not surfaced under the new title yet; keeping the old
      // index beats leaving the series with none until the next backup.
      const oldFolderStillHasArchive = this.getCloudVolumesBySeries(oldFolderTitle).some((file) =>
        normalizeCloudPath(file.path).toLowerCase().endsWith('.cbz')
      );
      if (staleFile && (outcome === 'written' || !oldFolderStillHasArchive)) {
        await this.deleteFileIdempotent(staleFile);
      }
    } catch (error) {
      console.warn(`Failed to move series.json to '${newSeriesTitle}':`, error);
    }
  }

  /**
   * Delete an entire series folder (all volumes in the series)
   */
  async deleteSeriesFolder(seriesTitle: string): Promise<{ succeeded: number; failed: number }> {
    // The folder as the CLOUD spells it: the files to delete live under that
    // name, and both cached records were written under its key.
    const folderTitle = this.resolveCloudFolderTitle(seriesTitle);
    const result = await this.deleteSeriesFolderFiles(folderTitle);
    // The cached index describes a folder that no longer exists. Dropping it is
    // safe either way: it is a download cache, re-fetched if the folder returns.
    try {
      await deleteSeriesIndex(normalizeSeriesKey(folderTitle));
    } catch (error) {
      console.warn(`Failed to drop the cached series index for '${folderTitle}':`, error);
    }
    try {
      await dropCatalogEntries([normalizeSeriesKey(folderTitle)]);
    } catch (error) {
      console.debug(`Could not drop the cached catalog entry for '${folderTitle}':`, error);
    }
    // The cloud catalog still lists the deleted series (client-produced
    // backends); the series write self-gates to nothing for a gone folder.
    await this.scheduleMetadataMaintenance([]);
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
