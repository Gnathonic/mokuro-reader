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
import {
  TRACKING_SECTION_KEY,
  copyTrackingEntry,
  detectBogusTrackingKeys,
  mergeTrackingSections,
  parseTrackingSection,
  setTrackingStates,
  trackingState,
  type TrackingState
} from '$lib/settings/tracking-data';
import { showSnackbar } from '../snackbar';
import { ProviderError } from './provider-interface';
import type { SyncProvider, ProviderType, CloudFileMetadata } from './provider-interface';
import { cacheManager } from './cache-manager';
import { uploadCacheEntry } from './cloud-cache-interface';
import { isHistoryFilePath } from '$lib/reading-history/paths';
import { FUTURE_TOLERANCE_MS, normalizeUpdatedAt } from '$lib/metadata/sanitize';
import { applyForgetHorizon, mergeLiveVolumeRecords } from './volume-record-merge';
import {
  GOALS_FILE_NAME,
  composeGoalsFile,
  detectBogusGoalKeys,
  emptySections,
  mergeGoalsSections,
  parseGoalsFile,
  purgeGoalTombstones,
  sectionsAreEmpty,
  type GoalsFileSections,
  type GoalsSectionName
} from '$lib/goals/goals-file';
// LEAF MODULES, never the `$lib/goals` barrel: that re-exports the snapshot
// BUILDER and `active-progress`, which reach `$lib/catalog` and so drag Dexie
// and the cloud manager into the sync layer — and into every sync test.
import { deadlinesWithTrash, setVolumeDeadlineEntries } from '$lib/goals/goal-settings';
import {
  dropDanglingCustomSelection,
  goalsWithTrash,
  setGoalSections
} from '$lib/goals/goals-data';
import { goalSnapshots, setGoalSnapshots } from '$lib/goals/snapshots-store';

/**
 * `goals.json` as it comes off the cloud.
 *
 * `raw` is the UNPARSED survivor: the upload decision compares against it, not
 * against `sections`, for the same reason `CloudVolumeDataFile.rawSeries`
 * exists — a clamped stamp compares equal to the poison once parsed, so the
 * file would never heal and every device would re-clamp it to a fresher `now`
 * on every sync, reverting every honest edit to that key forever.
 *
 * `bogusKeys` is the union across every readable copy, per section.
 */
interface CloudGoalsFile {
  sections: GoalsFileSections;
  raw: Record<string, unknown>;
  bogusKeys: Partial<Record<GoalsSectionName, ReadonlySet<string>>>;
}

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
  /** The `tracking` section (idle cutoff), parsed; same rules as `series`. */
  tracking?: TrackingState;
  /** The `tracking` section as the surviving copy holds it (see `rawSeries`). */
  rawTracking?: unknown;
  /** Tracking keys whose raw stamp needed clamping, in any readable copy. */
  bogusTrackingKeys?: ReadonlySet<string>;
}

/**
 * Unified Sync Service
 *
 * Syncs read progress, series reading state and settings profiles across all
 * authenticated cloud providers. Works with the SyncProvider interface,
 * making it provider-agnostic.
 */
interface SyncFlight {
  running: Promise<ProviderSyncResult>;
  followUp?: {
    silent: boolean;
    promise: Promise<ProviderSyncResult>;
    resolve: (result: ProviderSyncResult) => void;
    reject: (error: unknown) => void;
  };
}

class UnifiedSyncService {
  private isSyncingStore = writable<boolean>(false);
  private syncLock = false;
  /** Syncs (or `syncAllProviders` runs) in progress; `isSyncing` is "any". */
  private activeSyncs = 0;
  /** The sync running per provider type, and the one queued behind it. */
  private flights = new Map<string, SyncFlight>();

  private beginSyncing(): void {
    this.activeSyncs++;
    this.isSyncingStore.set(true);
  }

  private endSyncing(): void {
    this.activeSyncs = Math.max(0, this.activeSyncs - 1);
    if (this.activeSyncs === 0) this.isSyncingStore.set(false);
  }

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
    this.beginSyncing();

    // Filter to only authenticated providers
    const authenticatedProviders = providers.filter((p) => p.isAuthenticated());

    if (authenticatedProviders.length === 0) {
      console.log('ℹ️ No authenticated providers to sync');
      if (!options.silent) {
        showSnackbar('No cloud providers connected');
      }
      this.syncLock = false;
      this.endSyncing();
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
      this.endSyncing();
    }
  }

  /**
   * Sync with a single provider. One at a time per provider: two overlapping
   * syncs each download the config files, merge and upload, and the second
   * can read a file the first is rewriting (a Local Folder `File` goes
   * unreadable mid-read). A request made while one runs waits for it, and
   * every such request shares ONE follow-up sync — silent only if all were.
   */
  syncProvider(provider: SyncProvider, options: SyncOptions = {}): Promise<ProviderSyncResult> {
    const flight = this.flights.get(provider.type);
    if (!flight) return this.startFlight(provider, options, false);
    if (flight.followUp) {
      if (!options.silent) flight.followUp.silent = false;
      return flight.followUp.promise;
    }
    let resolve!: (result: ProviderSyncResult) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<ProviderSyncResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    flight.followUp = { silent: !!options.silent, promise, resolve, reject };
    return promise;
  }

  /** Run a sync and, when it ends, the follow-up queued behind it — with no gap a third could slip into. */
  private startFlight(
    provider: SyncProvider,
    options: SyncOptions,
    continuing: boolean
  ): Promise<ProviderSyncResult> {
    if (!continuing) this.beginSyncing();
    const flight: SyncFlight = { running: undefined as unknown as Promise<ProviderSyncResult> };
    this.flights.set(provider.type, flight);
    flight.running = this.runProviderSync(provider, options).finally(() => {
      const next = flight.followUp;
      if (next) {
        this.startFlight(provider, { silent: next.silent }, true).then(next.resolve, next.reject);
      } else {
        this.flights.delete(provider.type);
        this.endSyncing();
      }
    });
    return flight.running;
  }

  private async runProviderSync(
    provider: SyncProvider,
    options: SyncOptions
  ): Promise<ProviderSyncResult> {
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

      // Goals ride the same unconditional round-trip. AFTER volume data on
      // purpose: a closed period's snapshot is permanent, and it should be
      // built from the progress this sync just merged, not from what this
      // device happened to know before it.
      console.log('🔄 Syncing goals...');
      await this.syncGoals(provider);
      console.log('✅ Goals synced');

      // Reading history last: best-effort, it never fails the sync above.
      await this.syncReadingHistory(provider, options);

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
              rawSeries: data?.[SERIES_SECTION_KEY],
              tracking: parseTrackingSection(data?.[TRACKING_SECTION_KEY]),
              rawTracking: data?.[TRACKING_SECTION_KEY]
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

        // The tracking section folds the same way as the series section below:
        // newest per key, and a copy's bogus key never beats another copy's
        // honest one.
        const perCopyBogusTracking = readable.map((entry) =>
          detectBogusTrackingKeys(entry.result.value.rawTracking)
        );
        const bogusTrackingKeys = new Set<string>();
        for (const keys of perCopyBogusTracking) for (const key of keys) bogusTrackingKeys.add(key);
        let mergedTracking: TrackingState = {};
        readable.forEach((entry, i) => {
          const own = entry.result.value.tracking ?? {};
          const foldable: TrackingState = {};
          for (const key of Object.keys(own) as Array<keyof TrackingState>) {
            const honestElsewhere =
              perCopyBogusTracking[i].has(key) &&
              readable.some(
                (_other, j) =>
                  j !== i &&
                  readable[j].result.value.tracking?.[key] &&
                  !perCopyBogusTracking[j].has(key)
              );
            if (!honestElsewhere) copyTrackingEntry(foldable, own, key);
          }
          mergedTracking = mergeTrackingSections(mergedTracking, foldable, perCopyBogusTracking[i]);
        });

        // Merge all readable copies volume by volume (`mergeVolumePair`)
        const merged: Record<string, VolumeData> = {};
        let mergedSeries: SeriesReadingStates = {};
        for (let i = 0; i < readable.length; i++) {
          const entry = readable[i];
          for (const [volumeId, volumeData] of Object.entries(entry.result.value.volumes)) {
            const existing = merged[volumeId];
            // Same rules as the local/cloud merge: newest position, both
            // copies' reading.
            merged[volumeId] = existing
              ? this.mergeVolumePair(volumeId, existing, volumeData)
              : volumeData;
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
          bogusSeriesKeys,
          tracking: mergedTracking,
          rawTracking: readable[0].result.value.rawTracking,
          bogusTrackingKeys
        };
      }

      // Single file - download normally
      const blob = await provider.downloadFile(volumeDataFiles[0]);
      const data = await this.blobToJson(blob);
      const rawSeries = data?.[SERIES_SECTION_KEY];
      const rawTracking = data?.[TRACKING_SECTION_KEY];
      return {
        volumes: parseVolumesFromJson(JSON.stringify(data)),
        series: parseSeriesSection(rawSeries),
        rawSeries,
        bogusSeriesKeys: detectBogusSeriesKeys(rawSeries),
        tracking: parseTrackingSection(rawTracking),
        rawTracking,
        bogusTrackingKeys: detectBogusTrackingKeys(rawTracking)
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
  private composeVolumeDataFile(
    volumes: any,
    series: SeriesReadingStates,
    tracking: unknown = {}
  ): any {
    const file: Record<string, unknown> = { ...volumes };
    if (Object.keys(series).length > 0) file[SERIES_SECTION_KEY] = series;
    // Same rule for the tracking section: absent until the user sets something.
    if (tracking && typeof tracking === 'object' && Object.keys(tracking).length > 0) {
      file[TRACKING_SECTION_KEY] = tracking;
    }
    return file;
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
    const mergedTracking = mergeTrackingSections(
      get(trackingState),
      cloud?.tracking ?? {},
      cloud?.bogusTrackingKeys ?? new Set()
    );

    // Step 4: Purge tombstones older than 30 days
    const purgedVolumes = this.purgeTombstones(mergedVolumes);

    // Step 5: Update local storage (including tombstones)
    volumesWithTrash.set(purgedVolumes);
    setSeriesReadingStates(mergedSeries);
    setTrackingStates(mergedTracking);

    // Step 5b: page turns the merge brought back (an older client, a device
    // that has not converted yet) become reading-history events and leave the
    // records — but only where history itself can sync. The file keeps
    // carrying turns (every turn history projects) until this provider holds
    // them as history: on mokuro-bunko and read-only providers always, and
    // elsewhere until the converted turns are confirmed uploaded (the history
    // pass runs after this upload, so that is the next sync).
    const finalVolumes = await this.volumesForUpload(provider);

    // Step 6: Upload if anything differs from what the cloud actually holds.
    //
    // The series half is compared against the RAW cloud section, not the parsed
    // one (see `CloudVolumeDataFile.rawSeries`): otherwise a clamped or
    // sanitized value looks like a match and never heals. `stableStringify`
    // sorts keys, so two devices whose maps hold identical state in different
    // insertion orders stop re-uploading the same bytes at each other.
    const nextFile = this.composeVolumeDataFile(finalVolumes, mergedSeries, mergedTracking);
    const cloudFile = this.composeVolumeDataFile(
      cloud?.volumes ?? {},
      (cloud?.rawSeries as SeriesReadingStates) ?? {},
      cloud?.rawTracking ?? {}
    );

    if (stableStringify(nextFile) !== stableStringify(cloudFile)) {
      await this.uploadVolumeDataFile(provider, nextFile);
    }
  }

  // -------------------------------------------------------------------------
  // goals.json — reading goals, closed-period snapshots, per-volume deadlines.
  //
  // A ROOT CONFIG file, so a failed write propagates like a failed progress
  // write: out of `syncGoals` -> `syncProvider`'s catch -> `success: false` ->
  // the "N failed" snackbar, and WebDAV's classifier demotes to read-only. It
  // is deliberately NOT in `isBestEffortMetadataPath`: that exists for files a
  // bunko server compiles and rejects BY DESIGN, and nothing compiles a user's
  // personal goals.
  // -------------------------------------------------------------------------

  /**
   * Every `goals.json` the cache knows about.
   *
   * `getAll`, not `get` like the profiles half: Drive mints duplicate files,
   * and a `get`-only path silently ignores every copy but one — losing whatever
   * only the other copies held.
   */
  private findGoalsFiles(provider: SyncProvider): CloudFileMetadata[] {
    const cache = cacheManager.getCache(provider.type);
    if (!cache) return [];
    return cache.getAll(GOALS_FILE_NAME) || [];
  }

  private async downloadGoalsFile(provider: SyncProvider): Promise<CloudGoalsFile | null> {
    const files = this.findGoalsFiles(provider);
    if (files.length === 0) return null;

    // A listed copy can be a ghost — deleted server-side but still in a stale
    // provider cache — so a not-found copy must not discard the readable ones.
    const downloads = await Promise.allSettled(
      files.map(async (file) => {
        const blob = await provider.downloadFile(file);
        return (await this.blobToJson(blob)) as unknown;
      })
    );

    const transient = downloads.find(
      (result): result is PromiseRejectedResult =>
        result.status === 'rejected' && !this.isFileNotFoundError(result.reason)
    );
    if (transient) throw transient.reason;

    const readable = downloads
      .filter((r): r is PromiseFulfilledResult<unknown> => r.status === 'fulfilled')
      .map((r) => r.value);

    if (readable.length === 0) return null;

    // Bogus-key detection runs on each copy's OWN RAW sections, before the
    // parse-time clamp hides the poison, and the result is the UNION across
    // every readable copy — not just whichever copy wins the fold below.
    const bogusKeys: Record<GoalsSectionName, Set<string>> = {
      targets: new Set(),
      customGoals: new Set(),
      snapshots: new Set(),
      volumeDeadlines: new Set()
    };
    for (const raw of readable) {
      const record = (raw ?? {}) as Record<string, unknown>;
      for (const section of ['targets', 'customGoals', 'volumeDeadlines'] as GoalsSectionName[]) {
        for (const key of detectBogusGoalKeys(record[section])) bogusKeys[section].add(key);
      }
    }

    // Fold duplicate copies into one, by the same union/newest-wins rules the
    // cloud-vs-local merge uses, so no copy's content is lost before we start —
    // and honouring `bogusKeys`, so a poisoned stamp on one copy cannot clobber
    // an honest entry on another regardless of fold order. (The volume-data
    // fold next door calls this the `honestElsewhere` guard.)
    let sections = parseGoalsFile(readable[0]);
    for (const raw of readable.slice(1)) {
      sections = mergeGoalsSections(sections, parseGoalsFile(raw), bogusKeys);
    }

    // Compare the upload against what the cloud LITERALLY holds, never against
    // the parsed copy: a clamped or sanitized value looks identical to the
    // poison once parsed, so the file would never heal.
    const survivor = (readable[0] ?? {}) as Record<string, unknown>;

    return { sections, raw: survivor, bogusKeys };
  }

  private async uploadGoalsFile(provider: SyncProvider, data: unknown): Promise<void> {
    const blob = this.jsonToBlob(data);
    const uploaded = await provider.uploadFile(GOALS_FILE_NAME, blob);
    cacheManager
      .getCache(provider.type)
      ?.add?.(
        GOALS_FILE_NAME,
        uploadCacheEntry(provider.type, GOALS_FILE_NAME, blob.size, uploaded)
      );
  }

  /** The local half of `goals.json`, tombstones included. */
  private localGoalSections(): GoalsFileSections {
    const goals = get(goalsWithTrash);
    return {
      targets: goals.targets,
      customGoals: goals.customGoals,
      snapshots: get(goalSnapshots),
      volumeDeadlines: get(deadlinesWithTrash)
    };
  }

  private async syncGoals(provider: SyncProvider): Promise<void> {
    const cloud = await this.downloadGoalsFile(provider);
    const local = this.localGoalSections();

    const merged = purgeGoalTombstones(
      mergeGoalsSections(local, cloud?.sections ?? emptySections(), cloud?.bogusKeys ?? {})
    );

    setGoalSections(merged.targets, merged.customGoals);
    setGoalSnapshots(merged.snapshots);
    setVolumeDeadlineEntries(merged.volumeDeadlines);
    // A custom goal deleted on another device arrives here as a tombstone. The
    // selection is per-device and was not part of the merge, so without this
    // the goal card reads "Read 0 volumes in Unknown period" until the user
    // works out they have to pick something else.
    dropDanglingCustomSelection();

    // A library that has never used goals must not mint a file: an empty
    // goals.json in every user's folder is pure churn.
    if (sectionsAreEmpty(merged) && !cloud) return;

    const nextFile = composeGoalsFile(merged, new Date().toISOString());
    const cloudSections = cloud
      ? {
          targets: (cloud.raw.targets ?? {}) as GoalsFileSections['targets'],
          customGoals: (cloud.raw.customGoals ?? {}) as GoalsFileSections['customGoals'],
          snapshots: (cloud.raw.snapshots ?? {}) as GoalsFileSections['snapshots'],
          volumeDeadlines: (cloud.raw.volumeDeadlines ?? {}) as GoalsFileSections['volumeDeadlines']
        }
      : emptySections();

    // `updated_at` is informational, so it is excluded from the comparison —
    // including it would make every device re-upload on every sync forever.
    const contentOf = (file: ReturnType<typeof composeGoalsFile>) => {
      const { updated_at: _ignored, ...rest } = file;
      return stableStringify(rest);
    };

    if (contentOf(nextFile) !== contentOf(composeGoalsFile(cloudSections, ''))) {
      await this.uploadGoalsFile(provider, nextFile);
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
   * Convert and strip page turns still held in volume records (phase 2b).
   * Best-effort: on failure the turns simply stay in the file, as before.
   * Loaded lazily, like the history pass.
   */
  private async volumesForUpload(provider: SyncProvider): Promise<any> {
    const status = provider.getStatus?.() ?? ({} as Partial<ReturnType<SyncProvider['getStatus']>>);
    try {
      const [cutOver, historySync, historyDbModule] = await Promise.all([
        import('$lib/reading-history/cut-over'),
        import('$lib/reading-history/history-sync'),
        import('$lib/reading-history/history-db')
      ]);
      const historySyncs = historySync.historySyncAllowed(status) && !status.isReadOnly;
      if (historySyncs) await cutOver.cutOverLegacyTurns();
      const records = get(volumesWithTrash);
      const carried =
        historySyncs &&
        (await historySync.legacyCarriedBy(provider.type, historyDbModule.historyDb()));
      return carried ? records : await cutOver.attachProjectedTurns(records);
    } catch (error) {
      console.warn('Page-turn cut-over failed (turns stay in volume-data.json):', error);
      return get(volumesWithTrash);
    }
  }

  /**
   * Reading history (spec: Storage → Cloud): upload this device's months,
   * import every other device's. Best-effort — it is this device's copy of
   * data it keeps locally, so a failure logs and the next sync retries; it
   * never fails the progress sync. Loaded lazily: the history database module
   * must not be evaluated by suites that mock `dexie`.
   */
  private async syncReadingHistory(
    provider: SyncProvider,
    options: SyncOptions = {}
  ): Promise<void> {
    try {
      const cache = cacheManager.getCache(provider.type);
      if (!cache?.isLoaded?.() || cache.isFetching?.()) return;
      const listing = cache.getAllFiles().filter((f) => isHistoryFilePath(f.path));
      const [{ syncHistory }, { historyDb }] = await Promise.all([
        import('$lib/reading-history/history-sync'),
        import('$lib/reading-history/history-db')
      ]);
      const result = await syncHistory(provider, listing, historyDb(), {
        force: !options.silent,
        onUploaded: (path, bytes, uploaded) =>
          cache.add?.(path, uploadCacheEntry(provider.type, path, bytes, uploaded))
      });
      if (result.imported || result.uploaded.length || result.failed.length) {
        console.log('📚 Reading history:', result);
      }
    } catch (error) {
      console.warn('Reading history sync failed (will retry next sync):', error);
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
        merged[volumeId] = this.mergeVolumePair(volumeId, localVol, cloudVol);
      }
    });

    return merged;
  }

  /**
   * One volume held on both sides (or in two duplicate cloud copies; `a` wins
   * a tie). The newest user action picks the record whose position and
   * completion stand; when both are live, the other side's reading is merged
   * in (`mergeLiveVolumeRecords`).
   */
  private mergeVolumePair(volumeId: string, a: any, b: any): any {
    const parse = (vol: any) => parseVolumesFromJson(JSON.stringify({ [volumeId]: vol }))[volumeId];
    // The synced shape of a record (a VolumeData instance's `toJSON`).
    const plain = (vol: any) => JSON.parse(JSON.stringify(vol));
    const bothLive = !a.deletedOn && !b.deletedOn;

    // Treat undefined timestamps as epoch (0) for legacy volumes. Between two
    // live records `addedOn` does not count: opening a volume this device has
    // no record for creates one stamped only with `addedOn`, and that blank
    // record outranked real reading on every other device — progress went to
    // 0 everywhere. It still counts against a tombstone, so a re-import revives
    // a volume whose stats were forgotten.
    // One exception: a record that replaced a "forget stats" tombstone
    // (`forgotAt`) was opened deliberately after the forget, so its `addedOn`
    // does count — otherwise a stale pre-forget copy outranks it and brings
    // the forgotten progress, completion and timer back.
    const mostRecent = (vol: any) =>
      Math.max(
        new Date(vol.lastProgressUpdate || 0).getTime(),
        bothLive && !vol.forgotAt ? 0 : new Date(vol.addedOn || 0).getTime(),
        new Date(vol.deletedOn || 0).getTime()
      );
    const aMostRecent = mostRecent(a);
    const bMostRecent = mostRecent(b);

    let winner;
    let loser;
    if (bMostRecent > aMostRecent) {
      [winner, loser] = [b, a];
    } else if (aMostRecent > bMostRecent) {
      [winner, loser] = [a, b];
    } else if (b.deletedOn && !a.deletedOn) {
      // Timestamps equal: prefer active over deleted to prevent accidental data loss
      [winner, loser] = [a, b];
    } else if (a.deletedOn && !b.deletedOn) {
      [winner, loser] = [b, a];
    } else if (bothLive) {
      // A tie between live records must not depend on which side is local, or
      // two devices each keep their own copy and re-upload it on every sync.
      // The earlier-added record wins (a legacy one without `addedOn` first),
      // then the content decides.
      const addedA = new Date(a.addedOn || 0).getTime();
      const addedB = new Date(b.addedOn || 0).getTime();
      const bFirst =
        addedA !== addedB ? addedB < addedA : stableStringify(plain(b)) < stableStringify(plain(a));
      [winner, loser] = bFirst ? [b, a] : [a, b];
    } else {
      // Both deleted - arbitrary choice: a
      [winner, loser] = [a, b];
    }

    // Winner is a tombstone - keep it as-is (minimal data)
    if (winner.deletedOn) return winner === a ? a : parse(winner);

    const live = loser.deletedOn
      ? applyForgetHorizon(plain(winner), loser.deletedOn)
      : mergeLiveVolumeRecords(plain(winner), plain(loser));

    // Preserve metadata from both records - fill in missing fields
    return parse({
      ...live,
      series_uuid: winner.series_uuid || a.series_uuid || b.series_uuid,
      series_title: winner.series_title || a.series_title || b.series_title,
      volume_title: winner.volume_title || a.volume_title || b.volume_title,
      // A completed winner without a stamp (written by a client that
      // predates `completedAt`, or one that has not backfilled yet)
      // inherits the other side's: dropping it would re-date the
      // completion on every device. A winner that is not completed
      // was un-read, so there is nothing to carry.
      completedAt:
        winner.completedAt ?? (winner.completed ? (a.completedAt ?? b.completedAt) : undefined)
    });
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
