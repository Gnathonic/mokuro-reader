import { writable } from 'svelte/store';
import { driveApiClient } from './api-client';
import { GOOGLE_DRIVE_CONFIG } from './constants';
import { unifiedCloudManager } from '../../unified-cloud-manager';
import type { CacheAddMetadata, CloudCache } from '../../cloud-cache-interface';
import { CoalescedCacheStore } from '../../coalesced-cache-store';
import type { DriveFileMetadata } from '../../provider-interface';
import { isRootConfigFile, isSidecarFile } from '../../syncable-file';

/**
 * In-memory representation of Google Drive's mokuro-reader folder state
 *
 * This cache mirrors the state of all managed reader files in Google Drive, serving two purposes:
 * 1. Detect backup status by checking if local volume paths exist in Drive (path collision check)
 * 2. Discover remote-only files for download placeholders (future feature)
 *
 * The cache is populated with a single bulk API call and lives only for the session.
 * It does NOT track local files - only what exists in Google Drive.
 *
 * Implements CloudCache interface for multi-provider architecture compatibility.
 */
/** One in-place edit of the cache map: takes the current map, returns the next. */
type CacheMutation = (cache: Map<string, DriveFileMetadata[]>) => Map<string, DriveFileMetadata[]>;

/**
 * How many times a dedup-triggered refetch may re-enter `fetchAllFiles`
 * before the chain gives up. A converged dedup needs exactly one; anything
 * beyond that means duplicates are being recreated between passes, and a
 * whole-account fetch per round is not a fix for that.
 */
const MAX_DEDUP_REFETCHES = 2;

/**
 * Everything about one cached file that a consumer can observe, as one
 * comparable token. `fileId` alone is not enough — a re-upload keeps the id
 * and moves the size/mtime, which is exactly what a staleness check reads.
 */
function fileToken(file: DriveFileMetadata): string {
  return [
    file.fileId,
    file.path,
    file.name,
    file.modifiedTime,
    file.size,
    file.description ?? '',
    file.parentId ?? ''
    // Joined on a separator, so "ab" + "c" can never read as "a" + "bc".
  ].join('\u0001');
}

/**
 * Do two built cache maps describe the same account state?
 *
 * Order-insensitive WITHIN a folder: the entries come out of the Drive
 * listing in whatever order the API paged them, and two fetches of an
 * unchanged account can legitimately hand back the same files in a different
 * order. Comparing them order-sensitively would report "changed" on every
 * fetch and give back nothing.
 */
function sameCacheMap(
  a: Map<string, DriveFileMetadata[]>,
  b: Map<string, DriveFileMetadata[]>
): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [key, aFiles] of a) {
    const bFiles = b.get(key);
    if (!bFiles || bFiles.length !== aFiles.length) return false;
    const aTokens = aFiles.map(fileToken).sort();
    const bTokens = bFiles.map(fileToken).sort();
    for (let i = 0; i < aTokens.length; i++) {
      if (aTokens[i] !== bTokens[i]) return false;
    }
  }
  return true;
}

class DriveFilesCacheManager implements CloudCache<DriveFileMetadata> {
  // State split from emission: `read()` is synchronous and never lagged (all
  // the getters below use it), while subscribers get incremental mutations
  // coalesced — see `CoalescedCacheStore`.
  private cache = new CoalescedCacheStore<DriveFileMetadata[]>();
  private isFetchingStore = writable<boolean>(false);
  private cacheLoadedStore = writable<boolean>(false);
  private fetchingFlag = false;
  private lastFetchTime: number | null = null;
  private readerFolderId: string | null = null;
  private fetchPromise: Promise<void> | null = null;
  /**
   * How many times IN A ROW a dedup-triggered refetch has re-entered
   * `fetchAllFiles`. Reset by any fetch that is not itself dedup-triggered.
   * See {@link MAX_DEDUP_REFETCHES}.
   */
  private dedupRefetchDepth = 0;
  /**
   * Mutations applied to the live cache WHILE a whole-account fetch is in
   * flight, so the fetch can replay them onto its own result instead of
   * throwing them away. `null` when no fetch is running — see {@link mutate}.
   */
  private mutationsDuringFetch: CacheMutation[] | null = null;
  /**
   * Bumped by anything that invalidates the cache outright (`clearCache`,
   * which logout and account switching go through). A fetch that started
   * before the bump must not publish its result over the top.
   */
  private cacheGeneration = 0;

  get store() {
    // Return Map grouped by series for efficient series-based operations
    return this.cache;
  }

  get isFetchingState() {
    return this.isFetchingStore;
  }

  get cacheLoaded() {
    return this.cacheLoadedStore;
  }

  getVolumeDataFileId(): string | null {
    const files = this.getVolumeDataFiles();
    return files.length > 0 ? files[0].fileId : null;
  }

  getVolumeDataFiles(): DriveFileMetadata[] {
    const currentCache = this.cache.read();

    return currentCache.get(GOOGLE_DRIVE_CONFIG.FILE_NAMES.VOLUME_DATA) || [];
  }

  /**
   * Fetch metadata for all managed files in the mokuro-reader folder
   * and cache them in memory for the session
   *
   * `options.dedupRefetch` marks the re-entry `runDeduplication` performs
   * after it merges duplicate folders — the ONLY caller that can call this
   * function as a result of this function. Every other caller resets the
   * re-entry counter, so an ordinary refresh is never charged for an earlier
   * dedup storm.
   */
  async fetchAllFiles(options?: { dedupRefetch?: boolean }): Promise<void> {
    if (this.fetchingFlag) {
      console.log('Drive files cache fetch already in progress');
      // Return existing promise to allow callers to wait
      if (this.fetchPromise) {
        return this.fetchPromise;
      }
      return;
    }

    if (!options?.dedupRefetch) this.dedupRefetchDepth = 0;

    this.fetchingFlag = true;
    this.isFetchingStore.set(true);
    // From here until the swap below, every mutation is recorded as well as
    // applied, so the snapshot this fetch is about to take cannot erase the
    // uploads that land while it pages. See `mutate`.
    this.mutationsDuringFetch = [];
    const startedAtGeneration = this.cacheGeneration;

    // Create promise for this fetch operation
    this.fetchPromise = (async () => {
      try {
        console.log('Fetching all Drive file metadata...');

        // Get only files owned by the user (guarantees edit permissions)
        // This filters out viewer-only shared files while keeping shared files with edit access that user owns
        const allItems = await driveApiClient.listFiles(
          `'me' in owners and trashed=false`,
          'files(id,name,mimeType,modifiedTime,size,parents,description)'
        );
        console.log('Found items:', allItems);

        // Count by file type
        const typeCounts: Record<string, number> = {};
        const cbzFiles: any[] = [];
        const sidecarFiles: any[] = [];
        const rootConfigFiles: any[] = [];
        const folderNames = new Map<string, string>();
        const foundFolderNames: string[] = [];

        for (const item of allItems) {
          const ext =
            item.name && item.name.includes('.')
              ? item.name.split('.').pop() || 'no-extension'
              : 'no-extension';
          typeCounts[ext] = (typeCounts[ext] || 0) + 1;

          if (item.mimeType === GOOGLE_DRIVE_CONFIG.MIME_TYPES.FOLDER) {
            folderNames.set(item.id, item.name);
            foundFolderNames.push(item.name);

            // Capture mokuro-reader folder ID
            if (item.name === GOOGLE_DRIVE_CONFIG.FOLDER_NAMES.READER) {
              this.readerFolderId = item.id;
              console.log('Found mokuro-reader folder ID:', item.id);
            }
          } else if (item.name.endsWith('.cbz')) {
            cbzFiles.push(item);
          } else if (isSidecarFile(item.name)) {
            // .mokuro / .mokuro.gz / cover images AND the per-series index
            // `<Series>/series.json`. Hand-rolling this test is what made
            // series.json invisible on Drive while every other provider listed
            // it — the shared allowlist is the only definition.
            sidecarFiles.push(item);
          } else if (isRootConfigFile(item.name)) {
            // volume-data.json, profiles.json, catalog.json
            rootConfigFiles.push(item);
          }
        }

        // Log warning if duplicates found
        const volumeDataCount = rootConfigFiles.filter(
          (file) => file.name.toLowerCase() === GOOGLE_DRIVE_CONFIG.FILE_NAMES.VOLUME_DATA
        ).length;
        if (volumeDataCount > 1) {
          console.warn(
            `Found ${volumeDataCount} volume-data.json files - duplicates will be merged and cleaned up during sync`
          );
        }

        console.log('File type counts:', typeCounts);
        console.log(
          `Found ${cbzFiles.length} .cbz files, ${sidecarFiles.length} sidecar files and ${folderNames.size} folders`
        );
        console.log('Folder names:', foundFolderNames);

        // Build cache from files using the folder map
        // Group by series title (folder name) for efficient series-based operations
        const cacheMap = new Map<string, DriveFileMetadata[]>();

        // Add archives and sidecars (group by series title)
        for (const file of [...cbzFiles, ...sidecarFiles]) {
          const parentId = file.parents?.[0];
          const parentName = parentId ? folderNames.get(parentId) : null;

          if (parentName) {
            const path = `${parentName}/${file.name}`;
            const metadata: DriveFileMetadata = {
              provider: 'google-drive',
              fileId: file.id,
              name: file.name,
              modifiedTime: file.modifiedTime || new Date().toISOString(),
              size: file.size ? parseInt(file.size) : 0,
              path: path,
              description: file.description,
              parentId: parentId
            };

            // Group by series title (parentName) instead of full path
            const existing = cacheMap.get(parentName);
            if (existing) {
              existing.push(metadata);
            } else {
              cacheMap.set(parentName, [metadata]);
            }
          }
        }

        // Add root config files, keyed by BASENAME (`get()`/`has()` derive the
        // cache key from `path.split('/')[0]`, so `catalog.json` is its own key).
        //
        // One that lives in a SERIES folder is NOT a root file: cached at the bare
        // name it would shadow the real root copy and readers would fetch the wrong
        // file. Those keep their full `<Series>/<name>` path and are grouped with
        // the series, exactly like the archives and sidecars above — the same guard
        // MEGA applies with `isJson && pathParts.length === 0`.
        for (const file of rootConfigFiles) {
          const parentId = file.parents?.[0];
          const parentName = parentId ? folderNames.get(parentId) : null;
          const seriesFolder =
            parentName && parentName !== GOOGLE_DRIVE_CONFIG.FOLDER_NAMES.READER
              ? parentName
              : null;

          const metadata: DriveFileMetadata = {
            provider: 'google-drive',
            fileId: file.id,
            name: file.name,
            modifiedTime: file.modifiedTime || new Date().toISOString(),
            size: file.size ? parseInt(file.size) : 0,
            path: seriesFolder ? `${seriesFolder}/${file.name}` : file.name,
            description: file.description,
            parentId
          };

          const key = seriesFolder ?? file.name.toLowerCase();
          const existing = cacheMap.get(key);
          if (existing) {
            existing.push(metadata);
          } else {
            cacheMap.set(key, [metadata]);
          }
        }

        console.log(
          `Cached ${cbzFiles.length} .cbz files, ${sidecarFiles.length} sidecar files and ${rootConfigFiles.length} root config file(s)`
        );
        // IDENTITY IS A SIGNAL, so do not spend it on a listing that did not
        // change. `catalog/index.ts`'s `volumesWithPlaceholders` decides
        // whether to re-mint EVERY placeholder object by comparing the
        // cloud-files Map by reference (`lastPlaceholderInputs.cloudFiles !==
        // $cloudFiles`) — that identity check is its documented contract and
        // the reason a cover landing no longer re-derives the catalog. A
        // brand-new Map after a fetch that found exactly the same files
        // therefore re-mints thousands of placeholders for nothing, and every
        // re-minted bare placeholder is re-resolved by `cover-service.ts`,
        // which schedules another `series.json` write, which (before
        // `ScheduleOptions.fromCloudListing`) fetched the whole account
        // again. Publishing the SAME Map when nothing moved cuts that at the
        // source, for every consumer rather than one.
        //
        // ATOMIC SWAP. `cacheMap` was built entirely off to the side — no
        // subscriber has seen a half-assembled listing — and it is installed
        // here in ONE `set`, with two corrections applied first:
        //
        // 1. Mutations that landed WHILE this fetch was paging are replayed
        //    on top, so an upload made during the fetch survives it (see
        //    `mutate` for why erasing them does not stay erased).
        // 2. A `clearCache()` during the fetch wins outright. It means the
        //    account went away (logout, or a switch to another provider);
        //    publishing the old account's listing over the empty cache would
        //    hand every consumer files it must not see.
        if (this.cacheGeneration !== startedAtGeneration) {
          console.log('Drive files cache was cleared mid-fetch; discarding this listing');
          return;
        }
        const replayed = (this.mutationsDuringFetch ?? []).reduce(
          (map, fn) => fn(map),
          cacheMap as Map<string, DriveFileMetadata[]>
        );
        this.mutationsDuringFetch = null;
        // Compared against the STATE (which already holds the replayed
        // mutations), not the published side: when they agree, the listing
        // brought nothing the state didn't know.
        const previous = this.cache.read();
        if (!sameCacheMap(previous, replayed)) {
          this.cache.set(replayed);
        } else {
          // The listing changed nothing — but mutations may still be riding
          // the coalescing timer, and "a fetch completed" is the moment
          // consumers wait on. Publish them now; a no-op (identity
          // preserved) when nothing is pending.
          this.cache.flush();
        }
        this.lastFetchTime = Date.now();
        this.cacheLoadedStore.set(true);
      } catch (error) {
        console.error('Failed to fetch Drive files cache:', error);
        console.error('Error details:', error);
        if (error instanceof Error) {
          console.error('Error message:', error.message);
          console.error('Error stack:', error.stack);
        }
        // Don't clear cache on error, keep stale data
      } finally {
        this.mutationsDuringFetch = null;
        this.fetchingFlag = false;
        this.isFetchingStore.set(false);
        this.fetchPromise = null;

        // Run folder deduplication after cache load (incremental - one pair at a time)
        this.runDeduplication();

        // Check if sync was requested after login (do this in finally to ensure fetch is complete)
        const shouldSync =
          typeof window !== 'undefined' &&
          localStorage.getItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.SYNC_AFTER_LOGIN) === 'true';

        if (shouldSync) {
          console.log('Cache loaded, triggering requested sync...');
          localStorage.removeItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.SYNC_AFTER_LOGIN);

          unifiedCloudManager
            .syncProgress({ silent: false })
            .catch((err: Error) => console.error('Sync after login failed:', err));
        }
      }
    })();

    return this.fetchPromise;
  }

  /**
   * Get the mokuro-reader folder ID from cache
   * Waits for ongoing fetch if needed
   * Returns null if folder doesn't exist (needs to be created)
   */
  async getReaderFolderId(): Promise<string | null> {
    // If we have the folder ID cached, return it immediately
    if (this.readerFolderId) {
      return this.readerFolderId;
    }

    // If a fetch is in progress, wait for it to complete
    if (this.fetchPromise) {
      console.log('Waiting for cache fetch to complete...');
      await this.fetchPromise;
      return this.readerFolderId;
    }

    // Cache is loaded but no folder found - it needs to be created
    return null;
  }

  /**
   * Set the reader folder ID in cache (after creating the folder)
   */
  setReaderFolderId(folderId: string): void {
    this.readerFolderId = folderId;
  }

  /**
   * Check if a file exists in Google Drive by path (parent/filename)
   * Used to determine if a local volume is already backed up
   */
  existsInDrive(seriesTitle: string, volumeTitle: string): boolean {
    const currentCache = this.cache.read();

    const path = `${seriesTitle}/${volumeTitle}.cbz`;
    const seriesFiles = currentCache.get(seriesTitle);
    return seriesFiles?.some((f) => f.path === path) || false;
  }

  /**
   * Get Drive file metadata by path (parent/filename)
   * Returns first file if there are duplicates
   */
  getDriveFile(seriesTitle: string, volumeTitle: string): DriveFileMetadata | undefined {
    const currentCache = this.cache.read();

    const path = `${seriesTitle}/${volumeTitle}.cbz`;
    const seriesFiles = currentCache.get(seriesTitle);
    return seriesFiles?.find((f) => f.path === path);
  }

  /**
   * Get ALL Drive file metadata by path (parent/filename)
   * Returns array of all files with this path (handles duplicates)
   */
  getDriveFiles(seriesTitle: string, volumeTitle: string): DriveFileMetadata[] {
    const currentCache = this.cache.read();

    const path = `${seriesTitle}/${volumeTitle}.cbz`;
    const seriesFiles = currentCache.get(seriesTitle);
    return seriesFiles?.filter((f) => f.path === path) || [];
  }

  /**
   * Get all files that exist in Drive
   * Future use: Discover remote-only volumes for download placeholders
   */
  getAllDriveFiles(): DriveFileMetadata[] {
    const currentCache = this.cache.read();

    const result: DriveFileMetadata[] = [];
    for (const files of currentCache.values()) {
      result.push(...files);
    }
    return result;
  }

  /**
   * Get all Drive files for a specific series
   * Future use: Show remote-only volumes in series view
   */
  getDriveFilesBySeries(seriesTitle: string): DriveFileMetadata[] {
    const currentCache = this.cache.read();

    // With series-grouped cache, just get the series directly (O(1) lookup)
    return currentCache.get(seriesTitle) || [];
  }

  /**
   * THE ONE WAY THIS CLASS CHANGES ITS CACHE OUTSIDE A FETCH.
   *
   * A whole-account fetch takes a snapshot of Drive at the moment it starts
   * paging and publishes it minutes later — on a 12,500-file library that is
   * thirteen `files.list` round trips. Anything that changed Drive in the
   * meantime is IN that snapshot only by luck, and the uploads this app makes
   * itself are the ones that matter: `uploadFile` records every upload here
   * via `cache.add`, precisely so a just-written `<Series>/series.json` is
   * visible before the next listing.
   *
   * Publishing the snapshot straight over the top erased exactly those
   * records, and the erasure is self-sustaining rather than merely wrong: the
   * reconcile pass reads the cache, sees a folder with archives and no
   * `series.json`, schedules the write again, the write uploads and re-adds,
   * the next fetch erases it again. The user sees a listing that never
   * converges and a status badge that never settles.
   *
   * So every mutation is also RECORDED while a fetch is in flight, and the
   * fetch replays them onto its own map before publishing. Replay order is
   * arrival order, and the functions are the same ones the live store ran, so
   * the replayed result is what the live cache would have held had the fetch
   * landed first.
   */
  private mutate(fn: CacheMutation): void {
    if (this.mutationsDuringFetch) this.mutationsDuringFetch.push(fn);
    this.cache.update(fn);
  }

  /**
   * Add or update the Drive state after successful upload
   */
  addDriveFile(seriesTitle: string, volumeTitle: string, metadata: DriveFileMetadata): void {
    this.mutate((cache) => {
      const newCache = new Map(cache);
      // Group by series title instead of full path
      const existing = newCache.get(seriesTitle);

      if (existing) {
        // Check if this file ID already exists, replace it
        const index = existing.findIndex((f) => f.fileId === metadata.fileId);
        if (index >= 0) {
          existing[index] = metadata;
        } else {
          existing.push(metadata);
        }
      } else {
        newCache.set(seriesTitle, [metadata]);
      }

      return newCache;
    });
  }

  /**
   * Remove specific file from cache by file ID
   */
  removeDriveFileById(fileId: string): void {
    this.mutate((cache) => {
      const newCache = new Map(cache);

      for (const [path, files] of newCache.entries()) {
        const filtered = files.filter((f) => f.fileId !== fileId);
        if (filtered.length === 0) {
          newCache.delete(path);
        } else if (filtered.length !== files.length) {
          newCache.set(path, filtered);
        }
      }

      return newCache;
    });
  }

  /**
   * Remove from cache after deletion from Drive (removes all files with this path)
   */
  removeDriveFile(seriesTitle: string, volumeTitle: string): void {
    this.mutate((cache) => {
      const path = `${seriesTitle}/${volumeTitle}.cbz`;
      const newCache = new Map(cache);
      const seriesFiles = newCache.get(seriesTitle);

      if (seriesFiles) {
        const filtered = seriesFiles.filter((f) => f.path !== path);
        if (filtered.length === 0) {
          newCache.delete(seriesTitle);
        } else {
          newCache.set(seriesTitle, filtered);
        }
      }

      return newCache;
    });
  }

  /**
   * Update file description in cache
   */
  updateFileDescription(fileId: string, description: string): void {
    this.mutate((cache) => {
      const newCache = new Map(cache);

      for (const [path, files] of newCache.entries()) {
        const updated = files.map((file) =>
          file.fileId === fileId ? { ...file, description } : file
        );
        newCache.set(path, updated);
      }

      return newCache;
    });
  }

  /**
   * Clear the entire cache (useful for sign out)
   */
  clearCache(): void {
    this.cacheGeneration += 1;
    this.cache.set(new Map());
    this.cacheLoadedStore.set(false);
    this.lastFetchTime = null;
    this.readerFolderId = null;
    this.fetchPromise = null;
  }

  /**
   * Get time since last fetch (for debugging/UI)
   */
  getLastFetchTime(): number | null {
    return this.lastFetchTime;
  }

  /**
   * Check if cache is currently being fetched
   */
  isFetchingCache(): boolean {
    return this.fetchingFlag;
  }

  // ========================================
  // CloudCache Interface Implementation
  // ========================================

  /**
   * Check if a file exists at the given path
   * @param path Full path like "SeriesTitle/VolumeTitle.cbz"
   */
  has(path: string): boolean {
    const currentCache = this.cache.read();

    // Extract series title from path and find within that series
    const seriesTitle = path.split('/')[0];
    const seriesFiles = currentCache.get(seriesTitle);
    return seriesFiles?.some((f) => f.path === path) || false;
  }

  /**
   * Get first file at the given path (for providers that support duplicates)
   * @param path Full path like "SeriesTitle/VolumeTitle.cbz"
   */
  get(path: string): DriveFileMetadata | null {
    const currentCache = this.cache.read();

    // Extract series title from path and find within that series
    const seriesTitle = path.split('/')[0];
    const seriesFiles = currentCache.get(seriesTitle);
    return seriesFiles?.find((f) => f.path === path) || null;
  }

  /**
   * Get all files at the given path (for duplicate detection)
   * @param path Full path like "SeriesTitle/VolumeTitle.cbz"
   */
  getAll(path: string): DriveFileMetadata[] {
    const currentCache = this.cache.read();

    // Extract series title from path and find all matches within that series
    const seriesTitle = path.split('/')[0];
    const seriesFiles = currentCache.get(seriesTitle);
    return seriesFiles?.filter((f) => f.path === path) || [];
  }

  /**
   * Get all files for a specific series
   * @param seriesTitle Series title to filter by
   */
  getBySeries(seriesTitle: string): DriveFileMetadata[] {
    return this.getDriveFilesBySeries(seriesTitle);
  }

  /**
   * Get all cached files
   */
  getAllFiles(): DriveFileMetadata[] {
    return this.getAllDriveFiles();
  }

  /**
   * Fetch fresh data from Google Drive and populate cache
   */
  async fetch(): Promise<void> {
    await this.fetchAllFiles();
  }

  /**
   * Clear all cached data
   */
  clear(): void {
    this.clearCache();
  }

  /**
   * Check if cache is currently being fetched
   */
  isFetching(): boolean {
    return this.isFetchingCache();
  }

  /**
   * Check if cache has been loaded at least once
   */
  isLoaded(): boolean {
    let loaded = false;
    this.cacheLoadedStore.subscribe((value) => {
      loaded = value;
    })();
    return loaded;
  }

  /**
   * Add a file to the cache (e.g., after upload)
   * @param path File path
   * @param metadata File metadata
   */
  add(path: string, metadata: CacheAddMetadata<DriveFileMetadata>): void {
    // Parse path to get series and volume title
    const parts = path.split('/');
    if (parts.length >= 2) {
      const seriesTitle = parts.slice(0, -1).join('/');
      const volumeTitle = parts[parts.length - 1]?.replace('.cbz', '') || '';
      this.addDriveFile(seriesTitle, volumeTitle, metadata);
    }
  }

  /**
   * Remove a file from the cache by file ID
   * @param fileId Provider-specific file ID
   */
  removeById(fileId: string): void {
    this.removeDriveFileById(fileId);
  }

  /**
   * Update file metadata in the cache
   * @param fileId Provider-specific file ID
   * @param updates Partial metadata to update
   */
  update(fileId: string, updates: Partial<DriveFileMetadata>): void {
    // For now, only description updates are common
    // Can be extended for other fields if needed
    if (updates.description !== undefined) {
      this.updateFileDescription(fileId, updates.description);
    }

    // For other fields, update the cache directly
    this.mutate((cache) => {
      const newCache = new Map(cache);

      for (const [path, files] of newCache.entries()) {
        const updated = files.map((file) =>
          file.fileId === fileId ? { ...file, ...updates } : file
        );
        newCache.set(path, updated);
      }

      return newCache;
    });
  }

  /**
   * Run folder deduplication asynchronously
   * Called after cache fetch completes
   *
   * The refetch below is the only path in this file that can make a fetch
   * cause another fetch, and it used to be UNCONDITIONAL — every merge bought
   * a whole-account refetch, whose own `finally` ran dedup again. That is
   * fine while dedup converges (`deduplicateAll` already loops internally
   * until it finds nothing, so the follow-up pass normally merges zero and
   * the chain stops after one refetch). It is not fine when duplicates keep
   * being CREATED between passes — `findOrCreateFolder` creates a folder
   * whenever its lookup misses, and Drive's file index is eventually
   * consistent, so a write landing during a dedup pass can mint the very
   * duplicate the next pass merges. That is an unbounded refetch engine, and
   * it exists on no other provider: WebDAV and MEGA run no dedup at all.
   *
   * So the chain is now DEPTH-BOUNDED. Convergence is unaffected (one refetch
   * is all a converged dedup ever needed); a pathological account gives up on
   * refreshing the view rather than fetching the whole account forever, and
   * says so once. The counter is reset by any fetch that is not itself a
   * dedup refetch, so the next ordinary refresh starts the budget over.
   */
  private runDeduplication(): void {
    // Import dynamically to avoid circular dependencies
    Promise.all([import('../../folder-deduplicator'), import('./google-drive-provider')])
      .then(async ([{ folderDeduplicator }, { googleDriveProvider }]) => {
        if (!googleDriveProvider.isAuthenticated()) {
          return;
        }

        const ops = googleDriveProvider.getFolderOperations();
        const result = await folderDeduplicator.deduplicateAll('google-drive', ops);

        if (result.groupsMerged === 0) return;

        if (this.dedupRefetchDepth >= MAX_DEDUP_REFETCHES) {
          console.warn(
            `[DriveCache] Dedup merged folders again after ${MAX_DEDUP_REFETCHES} refetches; ` +
              'not refetching. Duplicate folders are being recreated as fast as they are merged.'
          );
          return;
        }

        // Refetch cache to reflect the merged state
        // This will trigger another dedup pass for any new duplicates created
        this.dedupRefetchDepth += 1;
        console.log('[DriveCache] Dedup merged folders, refetching cache...');
        await this.fetchAllFiles({ dedupRefetch: true });
      })
      .catch((err) => {
        console.error('[DriveCache] Deduplication failed:', err);
      });
  }
}

export const driveFilesCache = new DriveFilesCacheManager();
