import { writable, get } from 'svelte/store';
import { progressTrackerStore } from '../progress-tracker';
import {
  volumesWithTrash,
  profiles,
  profilesWithTrash,
  parseVolumesFromJson,
  migrateProfiles,
  parseSeriesSection,
  mergeSeriesSections,
  detectBogusSeriesKeys,
  seriesReadingState,
  setSeriesReadingStates,
  SERIES_SECTION_KEY,
  type SeriesReadingStates,
  type VolumeData
} from '$lib/settings';
import { showSnackbar } from '../snackbar';
import { ProviderError } from './provider-interface';
import type { SyncProvider, ProviderType, CloudFileMetadata } from './provider-interface';
import { cacheManager } from './cache-manager';
import { uploadCacheEntry } from './cloud-cache-interface';
import { FUTURE_TOLERANCE_MS, normalizeUpdatedAt } from '$lib/metadata/sanitize';

/**
 * Deep-sorts object keys before `JSON.stringify` so two values that differ
 * only in key order compare equal. Used to decide whether `volume-data.json`
 * needs to be re-uploaded without false positives from key ordering alone.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    const out: Record<string, unknown> = {};
    for (const [key, v] of entries) out[key] = sortKeysDeep(v);
    return out;
  }
  return value;
}

export interface SyncOptions {
  /** If true, suppress snackbar notifications */
  silent?: boolean;
}

export interface ProviderSyncResult {
  provider: ProviderType;
  success: boolean;
  error?: string;
}

export interface SyncResult {
  totalProviders: number;
  succeeded: number;
  failed: number;
  results: ProviderSyncResult[];
}

/**
 * `volume-data.json` as it comes off the cloud: the volume map plus the
 * reserved `series` section (series-level reading state). Two independently
 * merged halves of one file — volumes by `lastProgressUpdate`, series by
 * `lastUpdated`.
 */
export interface CloudVolumeDataFile {
  volumes: Record<string, VolumeData>;
  series: SeriesReadingStates;
  /**
   * The `series` section exactly as the surviving cloud copy holds it —
   * unparsed, unsanitized, undefined when the file has no section.
   *
   * The upload decision compares against THIS, never against `series`.
   * `parseSeriesSection` rewrites what it reads: a `lastUpdated` more than five
   * minutes in the future is clamped to the reading device's `now`. Comparing
   * the merge against the parsed section would make the clamped value look
   * identical to what the cloud already holds, so the poison would never be
   * written back — and every device would re-clamp it to a fresher `now` on
   * every sync, silently reverting every honest edit to that series, forever.
   * Comparing against the raw section makes the first sync upload the healed
   * value and converge — the same rule, for the same reason, that the retired
   * root series-metadata sync followed before this file absorbed its job.
   */
  rawSeries?: unknown;
  /**
   * Series keys whose RAW `lastUpdated` needed clamping, UNIONED across every
   * readable copy inspected — not only the one that survives the delete
   * sweep (`rawSeries` above). A duplicate `volume-data.json` that gets
   * deleted after the fold is exactly as real a source of poison as the
   * survivor; deriving this only from `rawSeries` would let a bogus stamp on
   * a non-surviving copy escape detection entirely once that copy is gone.
   * Drives FORFEIT-ON-BOGUS in `syncVolumeData`'s cloud-vs-local merge.
   */
  bogusSeriesKeys?: ReadonlySet<string>;
}

/**
 * Unified Sync Service
 *
 * Syncs read progress, series reading state and settings profiles across all
 * authenticated cloud providers. Works with the SyncProvider interface,
 * making it provider-agnostic.
 */
class UnifiedSyncService {
  private isSyncingStore = writable<boolean>(false);
  private syncLock = false;

  get isSyncing() {
    return this.isSyncingStore;
  }

  /**
   * Sync with all authenticated providers
   */
  async syncAllProviders(
    providers: SyncProvider[],
    options: SyncOptions = {}
  ): Promise<SyncResult> {
    // Prevent concurrent syncs
    if (this.syncLock) {
      console.log('⏭️ Sync already in progress, skipping');
      if (!options.silent) {
        showSnackbar('Sync already in progress');
      }
      return {
        totalProviders: 0,
        succeeded: 0,
        failed: 0,
        results: []
      };
    }

    this.syncLock = true;
    this.isSyncingStore.set(true);

    // Filter to only authenticated providers
    const authenticatedProviders = providers.filter((p) => p.isAuthenticated());

    if (authenticatedProviders.length === 0) {
      console.log('ℹ️ No authenticated providers to sync');
      if (!options.silent) {
        showSnackbar('No cloud providers connected');
      }
      this.syncLock = false;
      this.isSyncingStore.set(false);
      return {
        totalProviders: 0,
        succeeded: 0,
        failed: 0,
        results: []
      };
    }

    const processId = 'unified-sync';

    try {
      if (!options.silent) {
        progressTrackerStore.addProcess({
          id: processId,
          description: 'Syncing with cloud providers',
          progress: 0,
          status: `Syncing with ${authenticatedProviders.length} provider(s)...`
        });
      }

      // Sync with all providers in parallel
      const results = await Promise.allSettled(
        authenticatedProviders.map((provider) => this.syncProvider(provider, options))
      );

      // Count successes and failures
      let succeeded = 0;
      let failed = 0;
      const providerResults: ProviderSyncResult[] = [];

      results.forEach((result, index) => {
        const provider = authenticatedProviders[index];
        if (result.status === 'fulfilled' && result.value.success) {
          succeeded++;
          providerResults.push(result.value);
        } else {
          failed++;
          providerResults.push({
            provider: provider.type,
            success: false,
            error:
              result.status === 'rejected'
                ? result.reason?.message || 'Unknown error'
                : result.value.error
          });
        }
      });

      // Show completion message
      if (!options.silent) {
        progressTrackerStore.updateProcess(processId, {
          progress: 100,
          status: 'Sync complete'
        });

        if (failed === 0) {
          showSnackbar(`Synced with ${succeeded} provider(s) successfully`);
        } else {
          showSnackbar(`Synced with ${succeeded} provider(s), ${failed} failed`);
        }
      }

      return {
        totalProviders: authenticatedProviders.length,
        succeeded,
        failed,
        results: providerResults
      };
    } catch (error) {
      console.error('Unified sync error:', error);
      if (!options.silent) {
        progressTrackerStore.updateProcess(processId, {
          progress: 0,
          status: 'Sync failed'
        });
        showSnackbar('Sync failed');
      }
      return {
        totalProviders: authenticatedProviders.length,
        succeeded: 0,
        failed: authenticatedProviders.length,
        results: authenticatedProviders.map((p) => ({
          provider: p.type,
          success: false,
          error: 'Sync failed'
        }))
      };
    } finally {
      if (!options.silent) {
        setTimeout(() => progressTrackerStore.removeProcess(processId), 3000);
      }
      this.syncLock = false;
      this.isSyncingStore.set(false);
    }
  }

  /**
   * Sync with a single provider
   */
  async syncProvider(
    provider: SyncProvider,
    options: SyncOptions = {}
  ): Promise<ProviderSyncResult> {
    // Set syncing state
    this.isSyncingStore.set(true);

    try {
      console.log(`🔄 Syncing with ${provider.name}...`);
      console.log('🔄 Sync options:', options);

      // Check authentication - if provider needs to re-authenticate, let it handle that
      if (!provider.isAuthenticated()) {
        // For Google Drive specifically, trigger the auth flow if needed
        if (provider.type === 'google-drive') {
          console.log('Google Drive not authenticated, triggering login...');
          await provider.login();
        } else {
          throw new Error(`${provider.name} is not authenticated`);
        }
      }

      // Sync volume data (read progress + series-level reading state)
      console.log('🔄 Syncing volume data...');
      await this.syncVolumeData(provider);
      console.log('✅ Volume data synced');

      // Profiles get the same treatment: read → merge (newest `lastUpdated` per
      // profile, tombstones honoured) → push. It used to be a button nobody
      // pressed, which is how devices ended up with divergent settings.
      console.log('🔄 Syncing profiles...');
      await this.syncProfiles(provider);
      console.log('✅ Profiles synced');

      console.log(`✅ ${provider.name} sync complete`);
      return {
        provider: provider.type,
        success: true
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`❌ ${provider.name} sync failed:`, error);

      // If it's an authentication error for Google Drive, that's expected behavior
      if (provider.type === 'google-drive' && errorMessage.includes('not authenticated')) {
        console.log('Google Drive re-authentication in progress...');
      }

      return {
        provider: provider.type,
        success: false,
        error: errorMessage
      };
    } finally {
      // Clear syncing state
      this.isSyncingStore.set(false);
    }
  }

  /**
   * Convert Blob to JSON object
   */
  private async blobToJson(blob: Blob): Promise<any> {
    const text = await blob.text();
    return JSON.parse(text);
  }

  /**
   * Convert JSON object to Blob
   */
  private jsonToBlob(data: any): Blob {
    const json = JSON.stringify(data);
    return new Blob([json], { type: 'application/json' });
  }

  /**
   * Find volume-data.json files from provider using generic cache
   * Returns array of CloudFileMetadata for all volume-data.json files found
   */
  private findVolumeDataFiles(provider: SyncProvider): CloudFileMetadata[] {
    const cache = cacheManager.getCache(provider.type);
    if (!cache) {
      return [];
    }

    // Query cache for volume-data.json files
    const files = cache.getAll('volume-data.json');
    return files || [];
  }

  /**
   * Find profiles.json file from provider using generic cache
   * Returns CloudFileMetadata if file exists, null otherwise
   */
  private findProfilesFile(provider: SyncProvider): CloudFileMetadata | null {
    const cache = cacheManager.getCache(provider.type);
    if (!cache) {
      return null;
    }

    // Query cache for profiles.json file
    return cache.get('profiles.json');
  }

  /**
   * Download volume-data.json file from provider using generic file operations
   * Handles duplicate files by merging them (Google Drive specific)
   *
   * Returns both halves of the file: the volume map and the reserved `series`
   * section. `parseVolumesFromJson` drops the section, so every path that
   * parses a copy has to lift it out separately — the single-file path and the
   * duplicate-merge path alike.
   */
  private async downloadVolumeDataFile(
    provider: SyncProvider,
    reloadCacheOnFileNotFound = true
  ): Promise<CloudVolumeDataFile | null> {
    try {
      const volumeDataFiles = await this.findVolumeDataFiles(provider);

      if (volumeDataFiles.length === 0) {
        return null;
      }

      // Handle duplicates: download all, merge, and clean up
      if (volumeDataFiles.length > 1) {
        console.log(
          `📦 Found ${volumeDataFiles.length} volume-data.json files - merging and deduplicating...`
        );

        // Download all copies. A listed copy can be a ghost — deleted
        // server-side but still present in a stale provider cache — so a
        // not-found copy must not discard the readable copies with it.
        const downloads = await Promise.allSettled(
          volumeDataFiles.map(async (file): Promise<CloudVolumeDataFile> => {
            const blob = await provider.downloadFile(file);
            const data = await this.blobToJson(blob);
            return {
              volumes: parseVolumesFromJson(JSON.stringify(data)),
              series: parseSeriesSection(data?.[SERIES_SECTION_KEY]),
              rawSeries: data?.[SERIES_SECTION_KEY]
            };
          })
        );

        const transient = downloads.find(
          (result): result is PromiseRejectedResult =>
            result.status === 'rejected' && !this.isFileNotFoundError(result.reason)
        );
        if (transient) {
          throw transient.reason;
        }

        const readable = downloads
          .map((result, index) => ({ result, index }))
          .filter(
            (
              entry
            ): entry is { result: PromiseFulfilledResult<CloudVolumeDataFile>; index: number } =>
              entry.result.status === 'fulfilled'
          );

        if (readable.length === 0) {
          // Every copy is a ghost — fall through to the caller's not-found
          // recovery (one cache refresh + retry).
          throw (downloads[0] as PromiseRejectedResult).reason;
        }

        // Per-copy bogus-key detection (on each copy's OWN raw section), and
        // the UNION across every readable copy — not only the one that ends
        // up surviving the delete sweep below. A poisoned stamp on a copy
        // that gets deleted is exactly as real a poison as one on the
        // survivor; deriving this from only one copy's raw section would let
        // it escape detection entirely once that copy is gone.
        const perCopyBogusKeys = readable.map((entry) =>
          detectBogusSeriesKeys(entry.result.value.rawSeries)
        );
        const bogusSeriesKeys = new Set<string>();
        for (const keys of perCopyBogusKeys) for (const key of keys) bogusSeriesKeys.add(key);

        // Merge all readable copies (newest lastProgressUpdate wins per volume)
        const merged: Record<string, VolumeData> = {};
        let mergedSeries: SeriesReadingStates = {};
        for (let i = 0; i < readable.length; i++) {
          const entry = readable[i];
          for (const [volumeId, volumeData] of Object.entries(entry.result.value.volumes)) {
            const existing = merged[volumeId];
            if (!existing) {
              merged[volumeId] = volumeData;
            } else {
              // Keep the volume with the most recent progress update
              const existingTime = new Date(existing.lastProgressUpdate || 0).getTime();
              const newTime = new Date(volumeData.lastProgressUpdate || 0).getTime();
              if (newTime > existingTime) {
                merged[volumeId] = volumeData;
              }
            }
          }

          // The series section folds by its own key, newest `lastUpdated`
          // wins — except FORFEIT-ON-BOGUS applies within this cloud-vs-cloud
          // fold too: a key THIS copy holds with a bogus (pre-clamp) stamp
          // must not clobber an honest entry from ANOTHER copy, regardless of
          // fold order. Such a key is excluded from this copy's contribution
          // whenever some other readable copy holds it honestly — that other
          // copy's own turn in this loop supplies it instead. Only when NO
          // readable copy holds the key honestly does the bogus (clamped)
          // value get folded in at all, as the best available answer.
          const entryBogus = perCopyBogusKeys[i];
          const foldable: SeriesReadingStates = {};
          for (const [key, state] of Object.entries(entry.result.value.series)) {
            const honestElsewhere =
              entryBogus.has(key) &&
              readable.some(
                (_other, j) =>
                  j !== i && key in readable[j].result.value.series && !perCopyBogusKeys[j].has(key)
              );
            if (honestElsewhere) continue;
            foldable[key] = state;
          }
          mergedSeries = mergeSeriesSections(mergedSeries, foldable, entryBogus);
        }

        // Keep the first readable copy; delete every other listed copy.
        // An already-gone delete target means converged, not failed.
        const keepIndex = readable[0].index;
        for (let i = 0; i < volumeDataFiles.length; i++) {
          if (i === keepIndex) continue;
          console.log(`🗑️ Deleting duplicate volume-data.json (${volumeDataFiles[i].fileId})`);
          try {
            await provider.deleteFile(volumeDataFiles[i]);
          } catch (error) {
            if (!this.isFileNotFoundError(error)) throw error;
          }
        }

        console.log(`✅ Merged ${readable.length} readable copies into 1`);
        // The raw section comes from the copy that SURVIVES the delete sweep —
        // the fold is only durable once it is written back over that copy, so
        // that copy is what the upload decision has to be measured against.
        // `bogusSeriesKeys`, unlike `rawSeries`, is the UNION across every
        // copy inspected — see the field doc on `CloudVolumeDataFile`.
        return {
          volumes: merged,
          series: mergedSeries,
          rawSeries: readable[0].result.value.rawSeries,
          bogusSeriesKeys
        };
      }

      // Single file - download normally
      const blob = await provider.downloadFile(volumeDataFiles[0]);
      const data = await this.blobToJson(blob);
      const rawSeries = data?.[SERIES_SECTION_KEY];
      return {
        volumes: parseVolumesFromJson(JSON.stringify(data)),
        series: parseSeriesSection(rawSeries),
        rawSeries,
        bogusSeriesKeys: detectBogusSeriesKeys(rawSeries)
      };
    } catch (error) {
      // File not found is not an error
      if (this.isFileNotFoundError(error)) {
        if (reloadCacheOnFileNotFound) {
          console.log('📥 Download failed with file not found - refreshing cache and retrying...');
          const cache = cacheManager.getCache(provider.type);
          if (cache) {
            await cache.fetch();
          }
          return await this.downloadVolumeDataFile(provider, false);
        } else {
          return null;
        }
      }
      throw error;
    }
  }

  /**
   * True when an error means "this file does not exist": the typed provider
   * code first, then message heuristics for providers predating typed codes.
   */
  private isFileNotFoundError(error: unknown): boolean {
    if (error instanceof ProviderError && error.code === 'NOT_FOUND') {
      return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('not found') || message.includes('404') || message.includes('ENOENT');
  }

  /**
   * Upload volume-data.json file to provider using generic file operations
   */
  private async uploadVolumeDataFile(provider: SyncProvider, data: any): Promise<void> {
    const blob = this.jsonToBlob(data);
    const path = 'volume-data.json';
    const uploaded = await provider.uploadFile(path, blob);
    // Targeted cache add, so `findVolumeDataFiles` (which reads the CACHE)
    // sees a first-ever upload without waiting for the next full listing —
    // maintenance only Drive's in-provider refetch used to provide, by brute
    // force; other providers never provided it at all.
    cacheManager
      .getCache(provider.type)
      ?.add?.(path, uploadCacheEntry(provider.type, path, blob.size, uploaded));
  }

  /**
   * The bytes of `volume-data.json`: the volume map, plus the `series` section
   * when there is any. Omitted when empty so a library that has never had
   * series-level state produces byte-identical files to before this existed —
   * no spurious upload, no mtime churn on every other device.
   */
  private composeVolumeDataFile(volumes: any, series: SeriesReadingStates): any {
    return Object.keys(series).length > 0
      ? { ...volumes, [SERIES_SECTION_KEY]: series }
      : { ...volumes };
  }

  /**
   * Sync volume data (read progress) with a provider
   */
  private async syncVolumeData(provider: SyncProvider): Promise<void> {
    // Step 1: Download cloud data (volumes + the series section)
    const cloud = await this.downloadVolumeDataFile(provider);

    // Step 2: Get local data (including tombstones for deletion sync)
    const localVolumes = get(volumesWithTrash);

    // Step 3: Merge each half by its own key. FORFEIT-ON-BOGUS: a series key
    // whose RAW cloud stamp needed clamping must not out-rank a pending local
    // edit — `bogusSeriesKeys` is computed by `downloadVolumeDataFile` itself
    // (unioned across every readable copy when duplicates existed; see the
    // field doc on `CloudVolumeDataFile`), never re-derived from `rawSeries`
    // here, since `rawSeries` alone only ever reflects the ONE copy that
    // happens to survive the delete sweep.
    const mergedVolumes = this.mergeVolumeData(localVolumes, cloud?.volumes || {});
    const mergedSeries = mergeSeriesSections(
      get(seriesReadingState),
      cloud?.series ?? {},
      cloud?.bogusSeriesKeys ?? new Set()
    );

    // Step 4: Purge tombstones older than 30 days
    const purgedVolumes = this.purgeTombstones(mergedVolumes);

    // Step 5: Update local storage (including tombstones)
    volumesWithTrash.set(purgedVolumes);
    setSeriesReadingStates(mergedSeries);

    // Step 6: Upload if anything differs from what the cloud actually holds.
    //
    // The series half is compared against the RAW cloud section, not the parsed
    // one (see `CloudVolumeDataFile.rawSeries`): otherwise a clamped or
    // sanitized value looks like a match and never heals. `stableStringify`
    // sorts keys, so two devices whose maps hold identical state in different
    // insertion orders stop re-uploading the same bytes at each other.
    const nextFile = this.composeVolumeDataFile(purgedVolumes, mergedSeries);
    const cloudFile = this.composeVolumeDataFile(
      cloud?.volumes ?? {},
      (cloud?.rawSeries as SeriesReadingStates) ?? {}
    );

    if (stableStringify(nextFile) !== stableStringify(cloudFile)) {
      await this.uploadVolumeDataFile(provider, nextFile);
    }
  }

  /**
   * Download profiles.json file from provider using generic file operations
   * Public method for manual profile downloads
   */
  async downloadProfiles(provider: SyncProvider): Promise<any | null> {
    return await this.downloadProfilesFile(provider);
  }

  /**
   * Download profiles.json file from provider using generic file operations
   */
  private async downloadProfilesFile(provider: SyncProvider): Promise<any | null> {
    try {
      console.log('🔎 Finding profiles.json in cache...');
      const profilesFile = await this.findProfilesFile(provider);
      console.log('🔎 findProfilesFile result:', profilesFile);

      if (!profilesFile) {
        console.log('⚠️ profiles.json not found in cache, returning null');
        return null;
      }

      console.log('⬇️ Downloading profiles.json from cloud...');
      const blob = await provider.downloadFile(profilesFile);
      console.log('⬇️ Downloaded blob, converting to JSON...');
      const json = await this.blobToJson(blob);
      console.log('✅ Successfully parsed profiles JSON:', json);
      return json;
    } catch (error) {
      console.error('❌ Error downloading profiles:', error);
      // File not found is not an error
      if (
        error instanceof Error &&
        (error.message.includes('not found') ||
          error.message.includes('404') ||
          error.message.includes('ENOENT'))
      ) {
        console.log('📝 Error was "not found", returning null');
        return null;
      }
      console.log('🔥 Re-throwing error (not a "not found" error)');
      throw error;
    }
  }

  /**
   * Upload profiles to provider using generic file operations
   * Public method for manual profile uploads
   */
  async uploadProfiles(provider: SyncProvider, profiles: any): Promise<void> {
    await this.uploadProfilesFile(provider, profiles);
  }

  /**
   * Upload profiles.json file to provider using generic file operations
   */
  private async uploadProfilesFile(provider: SyncProvider, data: any): Promise<void> {
    const blob = this.jsonToBlob(data);
    const path = 'profiles.json';
    const uploaded = await provider.uploadFile(path, blob);
    // Same targeted add as `uploadVolumeDataFile` — `findProfilesFiles` reads
    // the cache too.
    cacheManager
      .getCache(provider.type)
      ?.add?.(path, uploadCacheEntry(provider.type, path, blob.size, uploaded));
  }

  /**
   * Sync profiles with a provider
   */
  private async syncProfiles(provider: SyncProvider): Promise<void> {
    console.log('🔵 syncProfiles() function called for provider:', provider.name);

    // Step 1: Download cloud profiles
    console.log('📥 Downloading cloud profiles...');
    const cloudProfiles = await this.downloadProfilesFile(provider);
    console.log('📥 Downloaded cloud profiles:', cloudProfiles);

    // Step 2: Get local profiles (including tombstones for deletion sync)
    const localProfiles = get(profilesWithTrash);
    console.log('💾 Local profiles:', localProfiles);

    // Step 3: Merge profiles (handles deletedOn timestamps)
    console.log('🔀 About to merge profiles...');
    const mergedProfiles = this.mergeProfiles(localProfiles, cloudProfiles || {});
    console.log('✅ Merged profiles:', mergedProfiles);

    // Step 4: Purge tombstones older than 30 days
    const purgedProfiles = this.purgeProfileTombstones(mergedProfiles);

    // Step 5: Update local storage (including tombstones)
    profilesWithTrash.set(purgedProfiles);

    // Step 6: Upload purged profiles if changed. `stableStringify` sorts keys
    // first, the same way the volume-data half does, so two devices whose
    // profile maps hold identical state in different insertion orders don't
    // re-upload the same bytes at each other forever.
    if (stableStringify(purgedProfiles) !== stableStringify(cloudProfiles || {})) {
      await this.uploadProfilesFile(provider, purgedProfiles);
    }
  }

  /**
   * Merge volume data using newest-wins strategy with deletion tracking support
   * Handles addedOn/deletedOn timestamps to properly sync deletions across devices
   * IMPORTANT: Always returns VolumeData class instances to ensure toJSON() is available
   */
  private mergeVolumeData(local: any, cloud: any): any {
    const merged: any = {};
    const allVolumeIds = new Set([...Object.keys(local), ...Object.keys(cloud)]);

    allVolumeIds.forEach((volumeId) => {
      const localVol = local[volumeId];
      const cloudVol = cloud[volumeId];

      if (!localVol) {
        // Only in cloud - parse plain object to VolumeData instance
        const parsed = parseVolumesFromJson(JSON.stringify({ [volumeId]: cloudVol }));
        merged[volumeId] = parsed[volumeId];
      } else if (!cloudVol) {
        // Only in local - already a VolumeData instance
        merged[volumeId] = localVol;
      } else {
        // In both - determine which has the most recent user action
        // Consider all timestamps: lastProgressUpdate (reading), addedOn (import), deletedOn (deletion)
        // Treat undefined timestamps as epoch (0) for legacy volumes
        const localMostRecent = Math.max(
          new Date(localVol.lastProgressUpdate || 0).getTime(),
          new Date(localVol.addedOn || 0).getTime(),
          new Date(localVol.deletedOn || 0).getTime()
        );

        const cloudMostRecent = Math.max(
          new Date(cloudVol.lastProgressUpdate || 0).getTime(),
          new Date(cloudVol.addedOn || 0).getTime(),
          new Date(cloudVol.deletedOn || 0).getTime()
        );

        let winner;
        if (cloudMostRecent > localMostRecent) {
          // Cloud has more recent user action
          const parsed = parseVolumesFromJson(JSON.stringify({ [volumeId]: cloudVol }));
          winner = parsed[volumeId];
        } else if (localMostRecent > cloudMostRecent) {
          // Local has more recent user action
          winner = localVol;
        } else {
          // Timestamps equal (including both at epoch)
          // Prefer active over deleted to prevent accidental data loss
          if (cloudVol.deletedOn && !localVol.deletedOn) {
            winner = localVol; // Local is active, keep it
          } else if (localVol.deletedOn && !cloudVol.deletedOn) {
            const parsed = parseVolumesFromJson(JSON.stringify({ [volumeId]: cloudVol }));
            winner = parsed[volumeId]; // Cloud is active, keep it
          } else {
            // Both same state (both active or both deleted) - arbitrary choice: local
            winner = localVol;
          }
        }

        // Preserve metadata from both records - fill in missing fields
        // (only if the winner is not deleted - tombstones keep minimal data)
        if (!winner.deletedOn) {
          merged[volumeId] = parseVolumesFromJson(
            JSON.stringify({
              [volumeId]: {
                ...winner,
                series_uuid: winner.series_uuid || localVol.series_uuid || cloudVol.series_uuid,
                series_title: winner.series_title || localVol.series_title || cloudVol.series_title,
                volume_title: winner.volume_title || localVol.volume_title || cloudVol.volume_title
              }
            })
          )[volumeId];
        } else {
          // Winner is a tombstone - keep it as-is (minimal data)
          merged[volumeId] = winner;
        }
      }
    });

    return merged;
  }

  /**
   * Purge tombstones (deleted volumes) older than 30 days
   * This prevents the sync data from accumulating deleted entries indefinitely
   */
  private purgeTombstones(volumes: any): any {
    const now = Date.now();
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

    return Object.fromEntries(
      Object.entries(volumes).filter(([volumeId, vol]: [string, any]) => {
        // Keep active volumes (no deletedOn timestamp)
        if (!vol.deletedOn) return true;

        // Purge tombstones older than 30 days
        const deletedTimestamp = new Date(vol.deletedOn).getTime();
        const age = now - deletedTimestamp;
        return age < THIRTY_DAYS_MS;
      })
    );
  }

  /**
   * Purge tombstones (deleted profiles) older than 30 days
   * This prevents the sync data from accumulating deleted entries indefinitely
   */
  private purgeProfileTombstones(profiles: any): any {
    const now = Date.now();
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

    return Object.fromEntries(
      Object.entries(profiles).filter(([profileName, profile]: [string, any]) => {
        // Keep active profiles (no deletedOn timestamp)
        if (!profile.deletedOn) return true;

        // Purge tombstones older than 30 days
        const deletedTimestamp = new Date(profile.deletedOn).getTime();
        const age = now - deletedTimestamp;
        return age < THIRTY_DAYS_MS;
      })
    );
  }

  /**
   * Clamp a cloud profile's untrusted timestamps the way `normalizeUpdatedAt`
   * clamps the series section's `lastUpdated` (see `series-data.ts`): a
   * `lastUpdated` or `deletedOn` more than five minutes in the future — clock
   * skew on another device, a hand-edited cloud file — is clamped to `now`.
   *
   * `touchProfile`/`deleteProfile` stamp the writing device's raw clock with
   * no ceiling, so without this a single fast-clock edit would permanently
   * outrank every honest later edit (`Math.max` can never let a real
   * timestamp catch up to one that is already in the future). Only the CLOUD
   * side is clamped — this device's own edits are trusted at the point they
   * are made; it is what comes back from elsewhere that is untrusted input.
   *
   * The upload decision in `syncProfiles` already compares against the RAW
   * cloud bytes, never a migrated/clamped copy, so a clamped merge that
   * differs from that raw file uploads the healed profile and the poison is
   * gone after one sync — the same mechanism `rawSeries` uses for the series
   * section.
   *
   * Clamping alone is not the whole fix: see `isBogusCloudProfile` and the
   * FORFEIT-ON-BOGUS branch in `mergeProfiles` for the race this leaves open.
   */
  private clampCloudProfileStamps(profile: any, now: number): any {
    if (!profile || typeof profile !== 'object') return profile;
    const clamped = { ...profile };
    if (profile.lastUpdated !== undefined) {
      clamped.lastUpdated = normalizeUpdatedAt(profile.lastUpdated, now) ?? profile.lastUpdated;
    }
    if (profile.deletedOn !== undefined) {
      clamped.deletedOn = normalizeUpdatedAt(profile.deletedOn, now) ?? profile.deletedOn;
    }
    return clamped;
  }

  /**
   * True when a cloud profile's RAW `lastUpdated` or `deletedOn` is more than
   * `FUTURE_TOLERANCE_MS` ahead of `now` — checked on the PRE-clamp value,
   * since that is what triggers FORFEIT-ON-BOGUS in `mergeProfiles`.
   *
   * Clamping a bogus stamp sets it to exactly this device's own `now`, which
   * always ties-or-beats any local stamp (a local edit is, by definition,
   * timestamped at or before `now`). Without this check, a poisoned cloud
   * profile would silently discard a pending honest local edit — once per
   * poisoning, under a stamp that now looks perfectly healthy.
   */
  private isBogusCloudProfile(profile: any, now: number): boolean {
    if (!profile || typeof profile !== 'object') return false;
    return (['lastUpdated', 'deletedOn'] as const).some((key) => {
      const raw = profile[key];
      if (typeof raw !== 'string') return false;
      const parsed = Date.parse(raw);
      return !Number.isNaN(parsed) && parsed > now + FUTURE_TOLERANCE_MS;
    });
  }

  /**
   * Merge profiles using timestamp-based conflict resolution
   * Handles deletedOn timestamps to properly sync deletions across devices
   * Migrates profiles to ensure all settings fields exist with defaults
   */
  private mergeProfiles(local: any, cloud: any): any {
    console.log('🔍 mergeProfiles called:', {
      localProfiles: Object.keys(local || {}),
      cloudProfiles: Object.keys(cloud || {}),
      localData: local,
      cloudData: cloud
    });

    // Migrate both local and cloud profiles to ensure all fields exist
    const migratedLocal = migrateProfiles(local || {});
    const migratedCloud = migrateProfiles(cloud || {});
    const now = Date.now();

    const merged: any = {};
    const allProfileNames = new Set([
      ...Object.keys(migratedLocal || {}),
      ...Object.keys(migratedCloud || {})
    ]);

    allProfileNames.forEach((profileName) => {
      const localProfile = migratedLocal?.[profileName];
      const rawCloudProfile = migratedCloud?.[profileName];
      const cloudProfile = this.clampCloudProfileStamps(rawCloudProfile, now);

      if (!localProfile) {
        // No local content to protect — adopt the cloud entry (healed if bogus).
        merged[profileName] = cloudProfile;
      } else if (!cloudProfile) {
        // Only in local - use local version (already migrated)
        merged[profileName] = localProfile;
      } else if (this.isBogusCloudProfile(rawCloudProfile, now)) {
        // FORFEIT-ON-BOGUS: the cloud entry's raw stamp needed clamping, and
        // local content exists — local wins outright regardless of stamps.
        // The upload below then carries the honest local content and its
        // real timestamp, which is what actually heals the cloud copy.
        console.log(`  🚫 Cloud forfeits [${profileName}] — raw stamp was bogus, local exists`);
        merged[profileName] = localProfile;
      } else {
        // In both - determine which has the most recent user action
        // Consider all timestamps: lastUpdated (settings change), deletedOn (deletion)
        // Treat undefined timestamps as epoch (0) for legacy profiles
        const localMostRecent = Math.max(
          new Date(localProfile.lastUpdated || 0).getTime(),
          new Date(localProfile.deletedOn || 0).getTime()
        );

        const cloudMostRecent = Math.max(
          new Date(cloudProfile.lastUpdated || 0).getTime(),
          new Date(cloudProfile.deletedOn || 0).getTime()
        );

        console.log(`🔄 Profile merge [${profileName}]:`, {
          local: {
            charCount: localProfile.charCount,
            lastUpdated: localProfile.lastUpdated,
            timestamp: localMostRecent
          },
          cloud: {
            charCount: cloudProfile.charCount,
            lastUpdated: cloudProfile.lastUpdated,
            timestamp: cloudMostRecent
          }
        });

        let winner;
        if (cloudMostRecent > localMostRecent) {
          console.log(`  ☁️ Cloud wins (${cloudProfile.charCount})`);
          winner = cloudProfile;
        } else if (localMostRecent > cloudMostRecent) {
          console.log(`  💻 Local wins (${localProfile.charCount})`);
          winner = localProfile;
        } else {
          // Timestamps equal (including both at epoch)
          // Prefer active over deleted to prevent accidental data loss
          if (cloudProfile.deletedOn && !localProfile.deletedOn) {
            console.log(`  💻 Local wins (active vs deleted)`);
            winner = localProfile; // Local is active, keep it
          } else if (localProfile.deletedOn && !cloudProfile.deletedOn) {
            console.log(`  ☁️ Cloud wins (active vs deleted)`);
            winner = cloudProfile; // Cloud is active, keep it
          } else {
            // Both same state (both active or both deleted) - prefer local
            console.log(`  💻 Local wins (tie, prefer local)`);
            winner = localProfile;
          }
        }

        merged[profileName] = winner;
      }
    });

    return merged;
  }
}

export const unifiedSyncService = new UnifiedSyncService();
