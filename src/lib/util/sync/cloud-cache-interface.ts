import type { Readable } from 'svelte/store';

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
   * Fetch fresh data from cloud provider and populate cache
   */
  fetch(): Promise<void>;

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
   * @param metadata File metadata
   */
  add?(path: string, metadata: T): void;

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
