import { writable } from 'svelte/store';
import type { CacheAddMetadata, ChangeFeedResult, CloudCache } from '../../cloud-cache-interface';
import { ProviderError, type CloudFileMetadata } from '../../provider-interface';
import { CoalescedCacheStore } from '../../coalesced-cache-store';
import { addMutations, removeMutations } from '../../listing-mutations';
import { onedriveProvider } from './onedrive-provider';
import { onedriveTokenManager } from './token-manager';
import { readDelta, startDelta } from './graph-client';
import { applyDelta, planDelta, type OneDriveFolderMap } from './onedrive-delta';

/**
 * How long the change feed may stand in for a full walk of the library — the
 * same safety net as Google Drive's (`CHANGE_FEED_MAX_AGE_MS`): whatever the
 * feed could ever miss is corrected at least this often.
 */
export const CHANGE_FEED_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The fewest delta pages a read may take before it lists in full instead. The
 * walk costs one `children` request per folder, so the cap is the larger of
 * this and the folder count: past it, reading the log costs more than the
 * listing it would save.
 */
export const MIN_DELTA_PAGES = 10;

/**
 * With no feed to read (no position yet, or one Graph would not give), a
 * refresh this soon after the last full walk reuses it instead of walking
 * again: startup lists and then syncs at once. Drive's `FULL_LISTING_REUSE_MS`.
 */
export const FULL_LISTING_REUSE_MS = 30_000;

/** An auth failure: the token manager has flagged the session, so a walk would fail the same way. */
function isAuthFailure(error: unknown): boolean {
  if (error instanceof ProviderError) return error.isAuthError;
  return (
    error instanceof Error &&
    (error.name === 'InteractionRequiredAuthError' || /Not authenticated/i.test(error.message))
  );
}

/**
 * A refusal the feed will meet again however often it asks — a 403 (the
 * account or token may not read the feed) or a 501 (Graph does not serve it
 * here): the feed is off for the session, like Drive's `feedUnavailable`.
 * Anything else (a 400 for a position Graph no longer reads, a 404, a 429, a
 * 5xx, offline) only costs this refresh a walk, whose own position is fresh.
 */
function isLastingRefusal(error: unknown): boolean {
  const code = error instanceof ProviderError ? (error.code ?? '') : '';
  return code === 'GRAPH_403' || code === 'GRAPH_501';
}

class OneDriveCacheManager implements CloudCache<CloudFileMetadata> {
  // State split from emission: `read()` is synchronous and never lagged,
  // subscribers get incremental mutations coalesced — see CoalescedCacheStore.
  private cache = new CoalescedCacheStore<CloudFileMetadata[]>();
  private isFetchingStore = writable<boolean>(false);
  /** The listing in flight (true = installed); every fetch() meanwhile joins it. */
  private fetchPromise: Promise<boolean> | null = null;
  /** The newest walk started (settled or not), for a feed read it overtook. */
  private latestWalk: Promise<boolean> | null = null;
  private loadedFlag = false;
  /** Why the last full walk failed, for a feed refresh that had to fall back to it. */
  private lastLoadError: unknown = null;
  /** Bumped by clear() (sign-out, account switch): work begun before it installs nothing. */
  private generation = 0;
  /** Bumped when a full walk starts: a feed read it overtook is dropped. */
  private fetchEpoch = 0;
  /** When the last full walk was installed. */
  private lastFullListingAt: number | null = null;
  /**
   * Every folder of the library by id, as the last full walk saw it and the
   * feed has kept it since — how a delta item, which names only its parent's
   * id, finds its path.
   */
  private folders: OneDriveFolderMap = new Map();
  /** The mokuro folder's id at the last walk. */
  private rootId: string | null = null;
  /**
   * Where the feed resumes (a deltaLink taken BEFORE the walk it belongs to,
   * so it means "everything changed since that walk began"), and the
   * generation it belongs to. Null = list in full.
   */
  private deltaLink: string | null = null;
  private deltaGeneration = -1;
  /** Graph refused the feed for good this session (see `isLastingRefusal`). */
  private feedUnavailable = false;
  private feedPromise: Promise<ChangeFeedResult> | null = null;

  get store() {
    return this.cache;
  }

  get isFetchingState() {
    return this.isFetchingStore;
  }

  fetch(): Promise<void> {
    return this.startFetch().then(() => undefined);
  }

  /** {@link fetch}, answering whether the walk was installed. */
  private startFetch(): Promise<boolean> {
    // Join a listing in flight: every caller reads the cache next, and one
    // that returned at once would read the listing from before it. A joined
    // listing is as fresh as when it BEGAN: writes made since ride it via the
    // replay, but a remote change after that waits for the next listing.
    if (this.fetchPromise) return this.fetchPromise;
    if (!onedriveProvider.isAuthenticated()) return Promise.resolve(false);

    this.isFetchingStore.set(true);
    const run: Promise<boolean> = this.load().finally(() => {
      if (this.fetchPromise !== run) return; // cleared meanwhile
      this.fetchPromise = null;
      this.isFetchingStore.set(false);
    });
    this.fetchPromise = run;
    this.latestWalk = run;
    return run;
  }

  /**
   * Whether the newest walk installed its listing, once it settled — the
   * newest one, should another start while waiting. For a feed read a walk
   * overtook: it may only be dropped for a walk that took its place.
   */
  private async latestWalkResult(): Promise<boolean> {
    let walk: Promise<boolean> | null;
    let installed = false;
    do {
      walk = this.latestWalk;
      if (!walk) return false;
      installed = await walk;
    } while (walk !== this.latestWalk);
    return installed;
  }

  private async load(): Promise<boolean> {
    const generation = this.generation;
    this.fetchEpoch += 1;
    // Uploads and deletes made while the walk runs are replayed onto its map.
    const listing = this.cache.beginListing();
    try {
      // The feed's position, taken BEFORE the walk: a change made while it
      // runs is then read again by the next feed (applying it twice changes
      // nothing), never missed.
      const position = await this.takeDeltaPosition();
      const { files, folders, rootId } = await onedriveProvider.listLibrary();
      const cacheMap = new Map<string, CloudFileMetadata[]>();
      for (const volume of files) {
        const seriesTitle = volume.path.split('/')[0];
        const existing = cacheMap.get(seriesTitle);
        if (existing) {
          existing.push(volume);
        } else {
          cacheMap.set(seriesTitle, [volume]);
        }
      }
      // A clear() meanwhile (sign-out): this listing is a dead account's.
      if (generation !== this.generation || !listing.install(cacheMap)) return false;
      this.folders = folders;
      this.rootId = rootId;
      // No mokuro folder yet: nothing the feed could place a file under, and
      // the walk that finds one costs a single lookup.
      this.deltaLink = rootId ? position : null;
      this.deltaGeneration = generation;
      this.lastFullListingAt = Date.now();
      this.loadedFlag = true;
      this.lastLoadError = null;
      console.log(
        `✅ OneDrive cache populated with ${files.length} files in ${cacheMap.size} series`
      );
      return true;
    } catch (error) {
      this.lastLoadError = error;
      console.error('Failed to fetch OneDrive cache:', error);
      return false;
    } finally {
      listing.abandon();
    }
  }

  /**
   * The feed's current head, for a walk about to start; null when Graph would
   * not give one (the next refresh lists in full again). An auth failure fails
   * the walk instead: it would fail the same way.
   */
  private async takeDeltaPosition(): Promise<string | null> {
    if (this.feedUnavailable) return null;
    try {
      return await startDelta(await onedriveTokenManager.getAccessToken());
    } catch (error) {
      if (isAuthFailure(error)) throw error;
      this.noteFeedFailure(error);
      console.warn(
        '[OneDriveCache] No change-feed position; the next refresh lists in full:',
        error
      );
      return null;
    }
  }

  private noteFeedFailure(error: unknown): void {
    if (!isLastingRefusal(error)) return;
    if (!this.feedUnavailable) {
      console.warn('[OneDriveCache] Change feed unavailable; listing in full until the next login');
    }
    this.feedUnavailable = true;
  }

  /**
   * Bring the cache up to date from Graph's change feed (root `delta`): one
   * small request when nothing changed, instead of the walk (one `children`
   * request per folder, one at a time). How this device learns about other
   * devices' writes between full listings.
   *
   * - `'unchanged'`: the feed held nothing the cache did not already show —
   *   including the echo of this device's own uploads, whose receipts are
   *   already cached. The map is not touched, so its identity holds.
   * - `'applied'`: files added, changed, moved or removed, and folders made
   *   or removed, by `planDelta`/`applyDelta` (`onedrive-delta.ts`).
   * - `'reset'`: it walked the library instead — no position (never listed,
   *   an account switch, no mokuro folder at the last walk, a position Graph
   *   would not give), a 410/`resyncRequired`, a log longer than the walk, a
   *   failed feed read, a batch it could not place exactly (a folder renamed
   *   or moved, one moved in with contents, the mokuro folder removed), or a
   *   last full walk over a day old (`CHANGE_FEED_MAX_AGE_MS`). Also when a
   *   walk overtook this read and installed (the read is dropped: the walk
   *   is newer); one that failed leaves the snapshot this batch continues,
   *   and the batch is applied after all.
   *
   * Never toggles `isFetchingState` or `loadedFlag`, and runs one at a time:
   * concurrent callers share the read. Throws after an AUTH failure, and when
   * the walk it fell back to failed: the cache is then NOT current, and a
   * caller about to prune against it (`ensureFreshCloudListing`) must hear so.
   */
  refreshFromChanges(): Promise<ChangeFeedResult> {
    if (this.feedPromise) return this.feedPromise;
    const run = this.readChangeFeed().finally(() => {
      if (this.feedPromise === run) this.feedPromise = null;
    });
    this.feedPromise = run;
    return run;
  }

  private async readChangeFeed(): Promise<ChangeFeedResult> {
    // A walk in flight replaces the position: read the feed from ITS position.
    if (this.fetchPromise) await this.fetchPromise;
    const generation = this.generation;
    const link = this.deltaLink;
    if (this.feedUnavailable || !link || this.deltaGeneration !== generation || !this.loadedFlag) {
      if (this.listedJustNow()) return 'unchanged';
      return this.listInFull(
        this.feedUnavailable ? 'the change feed is unavailable' : 'no change-feed position'
      );
    }
    if (
      this.lastFullListingAt === null ||
      Date.now() - this.lastFullListingAt > CHANGE_FEED_MAX_AGE_MS
    ) {
      return this.listInFull('the last full listing is over a day old');
    }
    const epoch = this.fetchEpoch;
    const maxPages = Math.max(MIN_DELTA_PAGES, this.folders.size);

    let batch: Awaited<ReturnType<typeof readDelta>>;
    try {
      batch = await readDelta(await onedriveTokenManager.getAccessToken(), link, maxPages);
    } catch (error) {
      if (isAuthFailure(error)) throw error;
      if (generation !== this.generation) return 'reset';
      this.noteFeedFailure(error);
      return this.listInFull('the change feed could not be read', error);
    }
    // The account went away meanwhile (sign-out, switch): nothing to apply to.
    if (generation !== this.generation) return 'reset';
    if (epoch !== this.fetchEpoch) {
      // A walk started meanwhile: it is newer than this batch, and its own
      // position reads again whatever this batch held — once it installs.
      const installed = await this.latestWalkResult();
      if (generation !== this.generation) return 'reset';
      if (installed) return 'reset';
      // It failed (a throttled or failed `children` request) and installed
      // nothing: the cache is still the snapshot at `link`, which this batch
      // continues — apply it. Anything else moved the position: the cache is
      // not current, and a caller about to prune against it must hear so.
      if (this.deltaLink !== link || !this.loadedFlag) {
        throw (
          this.lastLoadError ??
          new ProviderError('OneDrive listing was not installed', 'onedrive', 'LISTING_FAILED')
        );
      }
    }
    if (batch === 'resync') return this.listInFull('Graph no longer knows the position (410)');
    if (batch === 'too-long') return this.listInFull(`more than ${maxPages} pages of changes`);

    let plan: ReturnType<typeof planDelta>;
    let current: Map<string, CloudFileMetadata[]>;
    let next: Map<string, CloudFileMetadata[]>;
    try {
      plan = planDelta(batch.items, this.folders, this.rootId!);
      if ('relist' in plan) return this.listInFull(plan.relist);
      current = this.cache.read();
      next = applyDelta(current, plan);
    } catch (error) {
      // Never step past a batch that was not applied: the walk is what the
      // batch would have made.
      return this.listInFull('a change batch could not be applied', error);
    }
    const applied = plan;
    this.folders = applied.folders;
    this.deltaLink = batch.deltaLink;
    if (next === current) return 'unchanged';
    // `next` is the apply on the state as it stands; a replay onto another
    // map (a walk's) decides afresh by the same rules.
    this.cache.update((map) => (map === current ? next : applyDelta(map, applied)));
    return 'applied';
  }

  /** Is the cache a full walk installed within `FULL_LISTING_REUSE_MS`? */
  private listedJustNow(): boolean {
    return (
      this.loadedFlag &&
      this.lastFullListingAt !== null &&
      Date.now() - this.lastFullListingAt < FULL_LISTING_REUSE_MS
    );
  }

  /**
   * Walk the library. The position is NOT dropped first: a walk that succeeds
   * installs its own, and one that fails (offline) leaves the cache the exact
   * snapshot at the old position, so the next refresh catches up with one
   * feed read. A walk that fails throws, so no caller takes the old listing
   * for a current one.
   */
  private async listInFull(reason: string, error?: unknown): Promise<'reset'> {
    if (error) console.warn(`[OneDriveCache] Listing in full (${reason}):`, error);
    else console.log(`[OneDriveCache] Listing in full (${reason})`);
    if (!onedriveProvider.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'onedrive', 'NOT_AUTHENTICATED', true);
    }
    if (!(await this.startFetch())) {
      throw (
        this.lastLoadError ??
        new ProviderError('OneDrive listing was not installed', 'onedrive', 'LISTING_FAILED')
      );
    }
    return 'reset';
  }

  has(path: string): boolean {
    const current = this.cache.read();
    const seriesTitle = path.split('/')[0];
    return current.get(seriesTitle)?.some((f) => f.path === path) || false;
  }

  get(path: string): CloudFileMetadata | null {
    const current = this.cache.read();
    const seriesTitle = path.split('/')[0];
    return current.get(seriesTitle)?.find((f) => f.path === path) || null;
  }

  getAll(path: string): CloudFileMetadata[] {
    const current = this.cache.read();
    const seriesTitle = path.split('/')[0];
    return current.get(seriesTitle)?.filter((f) => f.path === path) || [];
  }

  getBySeries(seriesTitle: string): CloudFileMetadata[] {
    const current = this.cache.read();
    const result: CloudFileMetadata[] = [];
    for (const files of current.values()) {
      result.push(...files.filter((file) => file.path.startsWith(`${seriesTitle}/`)));
    }
    return result;
  }

  getAllFiles(): CloudFileMetadata[] {
    const current = this.cache.read();
    const result: CloudFileMetadata[] = [];
    for (const files of current.values()) result.push(...files);
    return result;
  }

  revision(): object {
    return this.cache.revision();
  }

  clear(): void {
    this.cache.set(new Map());
    this.loadedFlag = false;
    this.fetchPromise = null;
    this.latestWalk = null;
    this.feedPromise = null;
    this.isFetchingStore.set(false);
    this.generation += 1;
    this.folders = new Map();
    this.rootId = null;
    this.deltaLink = null;
    this.lastFullListingAt = null;
    this.feedUnavailable = false;
  }

  isFetching(): boolean {
    return this.fetchPromise !== null;
  }

  isLoaded(): boolean {
    return this.loadedFlag;
  }

  add(path: string, metadata: CacheAddMetadata<CloudFileMetadata>): void {
    this.cache.update(...addMutations(path, metadata));
  }

  removeById(fileId: string): void {
    this.cache.update(...removeMutations(fileId));
  }

  update(fileId: string, updates: Partial<CloudFileMetadata>): void {
    this.cache.update((cache) => {
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
}

export const onedriveCache = new OneDriveCacheManager();
