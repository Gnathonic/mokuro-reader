import type { Readable } from 'svelte/store';
import type { CloudFileMetadata, ProviderType, UploadFileResult } from './provider-interface';

/**
 * Cloud Cache Interface
 *
 * Defines the contract for provider-specific cloud file caches.
 * Each provider keeps its own native metadata format (DriveFileMetadata, MegaFileMetadata, etc.)
 * instead of forcing normalization to a common format that loses provider-specific features.
 *
 * This interface provides common operations while preserving provider-specific capabilities
 * like Drive's duplicate detection, MEGA's deduplication, etc.
 */

/**
 * The metadata `add()` accepts — `T` with `modifiedTimeProvisional` promoted
 * from optional to REQUIRED.
 *
 * `add()` runs at upload/rename time, the one moment a caller actually knows
 * whether the `modifiedTime` it is about to cache came from the provider's
 * own response or was fabricated from the client clock (see
 * `CloudFileMetadata.modifiedTimeProvisional`'s own doc for why that
 * distinction matters downstream). Leaving the field optional on `add()`
 * itself let a call site omit the question entirely and default to
 * "server-truth" by silence — which is exactly the class of bug a stale/
 * fabricated timestamp in `series.json` comes from. Requiring it here makes
 * that omission a compile error instead of a runtime data hazard.
 *
 * Whole-account listing installs (each provider's `fetch()`, which replaces
 * the cache wholesale via its own store's `set()`) do not go through `add()`
 * at all and need no such flag: every entry there is server-reported by
 * construction, never client-clock-fabricated.
 */
export type CacheAddMetadata<T> = T & { modifiedTimeProvisional: boolean };

/**
 * What one change-feed refresh did ({@link CloudCache.refreshFromChanges}):
 * nothing to apply, changes applied, or a full listing instead.
 */
export type ChangeFeedResult = 'unchanged' | 'applied' | 'reset';

/**
 * The cache entry ONE successful upload earns — the single rule for
 * post-upload cache maintenance, shared by every uploader
 * (`unifiedCloudManager.uploadFile`, the sync service's direct
 * volume-data/profiles uploads).
 *
 * A targeted `cache.add` of this entry is ALL an upload needs for
 * convergence: it carries the upload response's own fileId, and the SERVER's
 * mtime when the response reported one — marked provisional otherwise, so no
 * stamp publisher ever mistakes a client clock for a server fact
 * (`cloud-sidecar-stamps.ts`). Refetching the listing instead is what the
 * Google Drive provider used to do INSIDE `uploadFile`: a full paged walk of
 * the account (13+ `files.list` calls on a 12,500-file library) after every
 * upload, so each sidecar-backfill volume cost two whole listings for data
 * nothing needed to read back. Pure and stateless on purpose — suites that
 * mock the cache manager still exercise THIS rule for real.
 */
export function uploadCacheEntry(
  providerType: ProviderType,
  path: string,
  uploadedBytes: number,
  uploaded: Pick<
    UploadFileResult,
    'fileId' | 'modifiedTime' | 'size' | 'revision' | 'parentId' | 'name'
  >,
  description?: string
): CacheAddMetadata<CloudFileMetadata & { parentId?: string; name?: string }> {
  return {
    provider: providerType,
    fileId: uploaded.fileId,
    path,
    modifiedTime: uploaded.modifiedTime ?? new Date().toISOString(),
    modifiedTimeProvisional: !uploaded.modifiedTime,
    size: uploaded.size ?? uploadedBytes,
    description,
    // The receipt's change token, and on Drive where the file now lives
    // (`deleteSeriesFolder` reads `parentId`; `renameFile` falls back to a
    // folder lookup without it). Absent fields stay absent.
    ...(uploaded.revision ? { revision: uploaded.revision } : {}),
    ...(uploaded.parentId ? { parentId: uploaded.parentId } : {}),
    ...(uploaded.name ? { name: uploaded.name } : {})
  };
}

/**
 * Generic interface for cloud file caches
 *
 * @template T The provider-specific metadata type (e.g., DriveFileMetadata)
 */
export interface CloudCache<T = any> {
  /**
   * Reactive store containing the cache data
   * Format depends on provider implementation (Map, Array, etc.)
   */
  store: Readable<any>;

  /**
   * Reactive store indicating whether a fetch is in progress
   * Optional - if not provided, isFetching() method is used instead
   */
  isFetchingState?: Readable<boolean>;

  /**
   * Check if a file exists at the given path
   * @param path Full path like "SeriesTitle/VolumeTitle.cbz"
   */
  has(path: string): boolean;

  /**
   * Get file(s) at the given path
   * Returns first file if multiple exist (for providers that support duplicates)
   * @param path Full path like "SeriesTitle/VolumeTitle.cbz"
   */
  get(path: string): T | null;

  /**
   * Get all files at the given path
   * Returns array to handle providers that allow duplicate paths (like Drive)
   * @param path Full path like "SeriesTitle/VolumeTitle.cbz"
   */
  getAll(path: string): T[];

  /**
   * Get all files for a specific series
   * @param seriesTitle Series title to filter by
   */
  getBySeries(seriesTitle: string): T[];

  /**
   * Get all cached files
   */
  getAllFiles(): T[];

  /**
   * A token that changes whenever the cached contents do (see
   * `CoalescedCacheStore.revision`). Optional: a cache without one is simply
   * never memoised over.
   */
  revision?(): object;

  /**
   * Fetch fresh data from cloud provider and populate cache
   */
  fetch(): Promise<void>;

  /**
   * Bring the cache up to date from the provider's change feed — the changes
   * since the last listing, not the listing again; falls back to a full
   * {@link fetch} whenever the feed cannot answer (`'reset'`). Never toggles
   * the fetching/loaded state, and leaves the cache untouched (same identity)
   * when nothing changed. OPTIONAL: Google Drive's cache is the one with a
   * feed today (`changes.list`).
   */
  refreshFromChanges?(): Promise<ChangeFeedResult>;

  /**
   * Clear all cached data
   */
  clear(): void;

  /**
   * Check if cache is currently being fetched
   */
  isFetching(): boolean;

  /**
   * Check if cache has been loaded at least once
   */
  isLoaded(): boolean;

  // Optional update methods (not all providers may support these)

  /**
   * Add a file to the cache (e.g., after upload)
   * @param path File path
   * @param metadata File metadata — `modifiedTimeProvisional` is required,
   *   not optional; see {@link CacheAddMetadata}.
   */
  add?(path: string, metadata: CacheAddMetadata<T>): void;

  /**
   * Remove a file from the cache by file ID
   * @param fileId Provider-specific file ID
   */
  removeById?(fileId: string): void;

  /**
   * Update file metadata in the cache
   * @param fileId Provider-specific file ID
   * @param updates Partial metadata to update
   */
  update?(fileId: string, updates: Partial<T>): void;
}

/**
 * Helper type for extracting metadata type from a CloudCache
 */
export type CacheMetadata<C extends CloudCache> = C extends CloudCache<infer T> ? T : never;
