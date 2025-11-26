import { derived, writable, type Readable } from 'svelte/store';
import type { CloudCache } from './cloud-cache-interface';
import type { ProviderType } from './provider-interface';

/**
 * Cache Manager
 *
 * Central routing point for provider-specific caches.
 * Routes operations to the correct cache while preserving provider-specific features.
 * Provides a unified reactive store that merges all provider caches.
 *
 * Key principles:
 * - Routes to provider caches, doesn't maintain its own normalized cache
 * - Preserves provider-specific metadata (Drive duplicates, MEGA dedup, etc.)
 * - Reactive via Svelte stores
 * - Allows direct cache access for provider-specific features
 */

/**
 * Generic cloud file metadata that can represent any provider's file
 * This is used for the merged allFiles store
 */
export interface GenericCloudFile {
  provider: ProviderType;
  fileId: string;
  path: string;
  modifiedTime?: string;
  size?: number;
  description?: string;
  // Provider-specific raw metadata is preserved here
  _raw?: any;
}

class CacheManager {
  private activeProviderType: ProviderType | null = null;
  private activeCache: CloudCache | null = null;
  // Keep a registry for lookup purposes
  private cacheRegistry = new Map<ProviderType, CloudCache>();
  // Writable store to track active cache changes
  private activeCacheStore = writable<CloudCache | null>(null);

  /**
   * Register a provider-specific cache
   * @param provider Provider type
   * @param cache CloudCache implementation for this provider
   */
  registerCache(provider: ProviderType, cache: CloudCache): void {
    this.cacheRegistry.set(provider, cache);
  }

  /**
   * Set the active provider's cache (called when switching providers)
   * Clears the old cache if switching to a different provider
   * @param provider Provider type
   */
  setActiveProvider(provider: ProviderType): void {
    const cache = this.cacheRegistry.get(provider);
    if (!cache) {
      console.warn(`Cache for provider ${provider} not registered`);
      return;
    }

    // Clear old cache if switching providers
    if (this.activeCache && this.activeProviderType !== provider) {
      console.log(`Clearing cache for ${this.activeProviderType} when switching to ${provider}`);
      this.activeCache.clear();
    }

    this.activeProviderType = provider;
    this.activeCache = cache;
    this.activeCacheStore.set(cache); // Update the store
    console.log(`Active cache set to: ${provider}`);
  }

  /**
   * Get cache for a specific provider (for internal use)
   * @param provider Provider type
   * @returns CloudCache instance or null if not registered
   */
  getCache(provider: ProviderType): CloudCache | null {
    return this.cacheRegistry.get(provider) || null;
  }

  /**
   * Reactive store containing files from the active provider's cache
   * Returns a Map<seriesTitle, files[]> for efficient series-based operations
   * Returns an empty Map if no provider is active
   */
  get allFiles(): Readable<Map<string, any[]>> {
    return derived(
      this.activeCacheStore,
      ($activeCache, set) => {
        if (!$activeCache) {
          set(new Map());
          return;
        }
        // Subscribe to the active cache's store
        const unsubscribe = $activeCache.store.subscribe((files) => {
          set(files);
        });
        return unsubscribe;
      },
      new Map()
    );
  }

  /**
   * Reactive store indicating whether a fetch is in progress
   * Returns false if no provider is active
   */
  get isFetchingState(): Readable<boolean> {
    return derived(
      this.activeCacheStore,
      ($activeCache, set) => {
        if (!$activeCache) {
          set(false);
          return;
        }
        // Subscribe to the active cache's isFetchingState if it exists
        if ($activeCache.isFetchingState) {
          const unsubscribe = $activeCache.isFetchingState.subscribe((fetching) => {
            set(fetching);
          });
          return unsubscribe;
        } else {
          // Fallback to non-reactive method if store not available
          set($activeCache.isFetching());
        }
      },
      false
    );
  }

  /**
   * Check if a file exists in the active provider by path
   * @param path Full path like "SeriesTitle/VolumeTitle.cbz"
   */
  has(path: string): boolean {
    return this.activeCache?.has(path) ?? false;
  }

  /**
   * Get file at path from the active provider
   * @param path Full path like "SeriesTitle/VolumeTitle.cbz"
   */
  get(path: string): any | null {
    return this.activeCache?.get(path) ?? null;
  }

  /**
   * Get all files at path from the active provider
   * @param path Full path like "SeriesTitle/VolumeTitle.cbz"
   */
  getAll(path: string): any[] {
    return this.activeCache?.getAll(path) ?? [];
  }

  /**
   * Get all files for a series from the active provider
   * @param seriesTitle Series title to filter by
   */
  getBySeries(seriesTitle: string): any[] {
    return this.activeCache?.getBySeries(seriesTitle) ?? [];
  }

  /**
   * Get all files from the active provider
   */
  getAllFiles(): any[] {
    return this.activeCache?.getAllFiles() ?? [];
  }

  /**
   * Fetch fresh data from the active provider
   */
  async fetchAll(): Promise<void> {
    if (this.activeCache) {
      await this.activeCache.fetch();
    }
  }

  /**
   * Clear the active cache
   */
  clearAll(): void {
    if (this.activeCache) {
      this.activeCache.clear();
    }
    this.activeCache = null;
    this.activeProviderType = null;
    this.activeCacheStore.set(null);
  }

  /**
   * Check if the active cache is currently fetching
   */
  isFetching(): boolean {
    return this.activeCache?.isFetching() ?? false;
  }
}

// Create singleton instance
// Note: Caches are registered by their provider modules when loaded (self-registration pattern)
export const cacheManager = new CacheManager();
