import { writable } from 'svelte/store';
import { driveApiClient, escapeNameForDriveQuery, isDriveAuthFailure } from './api-client';
import { GOOGLE_DRIVE_CONFIG } from './constants';
import type { CacheAddMetadata, ChangeFeedResult, CloudCache } from '../../cloud-cache-interface';
import { CoalescedCacheStore } from '../../coalesced-cache-store';
import type { DriveFileMetadata } from '../../provider-interface';
import { isRootConfigFile, isSidecarFile } from '../../syncable-file';
import { compareByAge } from '../../folder-deduplicator';
import type { DriveChange, DriveFile } from './constants';
import { HISTORY_FOLDER, isHistoryFileName } from '$lib/reading-history/paths';
import { driveHistoryPath } from './drive-history-path';
import {
  cloudBunkoMergesDuplicates,
  refreshCloudBunkoMarker
} from '$lib/catalog/cloud-bunko-marker';

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

/** Which listed folders are directly in My Drive. */
type TopLevelTest = (f: DriveFile) => boolean;

/** Folder id → its name and (first) parent: what placing a file by its folders needs. */
type FolderMap = Map<string, { name: string; parent?: string }>;

const READER_FOLDER = GOOGLE_DRIVE_CONFIG.FOLDER_NAMES.READER;
const FOLDER_MIME = GOOGLE_DRIVE_CONFIG.MIME_TYPES.FOLDER;

/**
 * How long the change feed may stand in for a whole-account listing. A
 * safety net, not a schedule: whatever the feed could ever miss (a change it
 * does not report, an entry applied wrong) is corrected at least this often.
 */
export const CHANGE_FEED_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Past this many pages of changes (1,000 each) the log costs more than the
 * listing it would save — a 12,500-file account lists in 13 pages.
 */
export const MAX_CHANGE_PAGES = 13;

/**
 * With no feed to read (no position, or a feed Drive will not serve), a
 * refresh within this long of the last whole-account listing reuses it
 * instead of walking the account again — startup lists and then syncs at
 * once. The same window the metadata writers already accept as current
 * (`LISTING_TTL_MS`, `series-file-sync.ts`), and no longer: they merge and
 * prune against what a refresh leaves.
 */
export const FULL_LISTING_REUSE_MS = 30_000;

/**
 * What one change entry needs: the listing's file fields, plus whether it is
 * trashed or ours (the listing filters on both) and its `version`.
 */
const CHANGE_FIELDS =
  'changes(fileId,removed,file(id,name,mimeType,modifiedTime,size,parents,description,trashed,ownedByMe,version))';

/** Walk bound for a folder's ancestors: the reader's deepest path is three folders. */
const MAX_FOLDER_DEPTH = 8;

/** The cache's file kinds, by name; null = a folder, or nothing the reader syncs. */
type FileKind = 'archive' | 'history' | 'sidecar' | 'root-config';

function fileKind(file: { name: string; mimeType?: string }): FileKind | null {
  if (file.mimeType === FOLDER_MIME) return null;
  if (file.name.endsWith('.cbz')) return 'archive';
  // Reading history: placed by its full path, never by parent name.
  if (isHistoryFileName(file.name)) return 'history';
  // .mokuro / .mokuro.gz / cover images AND the per-series index
  // `<Series>/series.json`. Hand-rolling this test is what made series.json
  // invisible on Drive while every other provider listed it — the shared
  // allowlist is the only definition.
  if (isSidecarFile(file.name)) return 'sidecar';
  // volume-data.json, profiles.json, catalog.json, …
  if (isRootConfigFile(file.name)) return 'root-config';
  return null;
}

/**
 * Where ONE listed file lives in the cache — its group key and its entry —
 * judged by the folders it sits in; null when it is not the reader's. The one
 * rule for the whole-account fetch and the change feed alike:
 *
 * - archives and sidecars: `<parent>/<name>`, grouped by the parent folder's
 *   name; unplaceable without a known parent;
 * - reading history, two folders deep (`mokuro-reader/history/<device>/<file>`):
 *   its full path, grouped under `history` like every other provider;
 * - root config, keyed by BASENAME (`get()`/`has()` derive the key from
 *   `path.split('/')[0]`, so `catalog.json` is its own key) — unless it lives
 *   in a SERIES folder. Cached at the bare name, such a copy would shadow the
 *   real root copy and readers would fetch the wrong file, so it keeps its
 *   full `<Series>/<name>` path and is grouped with the series, exactly like
 *   the archives and sidecars — the same guard MEGA applies with
 *   `isJson && pathParts.length === 0`.
 */
function placeFile(
  file: DriveFile,
  folders: FolderMap
): { key: string; entry: DriveFileMetadata } | null {
  const kind = fileKind(file);
  if (!kind) return null;
  const parentId = file.parents?.[0];
  const parentName = parentId ? folders.get(parentId)?.name : undefined;
  const entry = (path: string): DriveFileMetadata => ({
    provider: 'google-drive',
    fileId: file.id,
    name: file.name,
    modifiedTime: file.modifiedTime || new Date().toISOString(),
    size: file.size ? parseInt(file.size) : 0,
    path,
    description: file.description,
    parentId,
    // A change entry carries the file's version; the listing does not ask.
    ...(file.version ? { revision: String(file.version) } : {})
  });
  switch (kind) {
    case 'archive':
    case 'sidecar':
      return parentName ? { key: parentName, entry: entry(`${parentName}/${file.name}`) } : null;
    case 'history': {
      const path = driveHistoryPath(file, folders, READER_FOLDER);
      return path ? { key: HISTORY_FOLDER, entry: entry(path) } : null;
    }
    case 'root-config': {
      const series = parentName && parentName !== READER_FOLDER ? parentName : null;
      return series
        ? { key: series, entry: entry(`${series}/${file.name}`) }
        : { key: file.name.toLowerCase(), entry: entry(file.name) };
    }
  }
}

/** Does `start`, or any folder above it in `folders`, belong to `ids`? */
function descendsFrom(start: string | undefined, ids: ReadonlySet<string>, folders: FolderMap) {
  if (ids.size === 0) return false;
  let id = start;
  for (let depth = 0; id && depth < MAX_FOLDER_DEPTH; depth++) {
    if (ids.has(id)) return true;
    id = folders.get(id)?.parent;
  }
  return false;
}

/**
 * Is a change entry for a file this cache holds just the cache's own record
 * coming back — nothing a consumer can observe has moved? The echo of this
 * device's own upload: the receipt already put exactly this into the cache.
 */
function sameEntry(held: DriveFileMetadata, listed: DriveFileMetadata): boolean {
  if (fileToken(held) === fileToken(listed)) return true;
  // The same instant spelled differently is the same stamp.
  return (
    fileToken({ ...held, modifiedTime: '' }) === fileToken({ ...listed, modifiedTime: '' }) &&
    Date.parse(held.modifiedTime) === Date.parse(listed.modifiedTime)
  );
}

/**
 * Is the cache's record of a file NEWER than what the feed says about it? A
 * receipt that landed while the feed's page was on the wire. Drive's
 * `version` is monotonic, so it decides when both sides have one; else the
 * server mtimes (a client-clock stamp proves nothing).
 */
function heldIsNewer(held: DriveFileMetadata, file: DriveFile): boolean {
  const heldVersion = Number(held.revision);
  const listedVersion = Number(file.version);
  if (
    held.revision &&
    file.version &&
    Number.isFinite(heldVersion) &&
    Number.isFinite(listedVersion)
  ) {
    return heldVersion > listedVersion;
  }
  if (held.modifiedTimeProvisional) return false;
  const heldAt = Date.parse(held.modifiedTime);
  const listedAt = Date.parse(file.modifiedTime ?? '');
  return Number.isFinite(heldAt) && Number.isFinite(listedAt) && heldAt > listedAt;
}

/** Everything one change-feed read decided, so the apply can run again on another map. */
interface FeedPlan {
  /** The folder map after this batch: live folders only. */
  folders: FolderMap;
  /**
   * Folders deleted, trashed or no longer ours, AND every folder that sits
   * under one once the batch's own moves are applied (Drive takes a folder's
   * contents with it). Closed: a file has left with its folder exactly when
   * its parent is in here.
   */
  removed: ReadonlySet<string>;
  /** Folders renamed, moved or new: whatever is under them is placed again. */
  moved: ReadonlySet<string>;
  /** The non-folder changes, in feed order. */
  files: DriveChange[];
}

/** Is this change the file's departure from what the listing would hold? */
function isGone(change: DriveChange): boolean {
  const file = change.file;
  return !!change.removed || !file || !!file.trashed || file.ownedByMe === false;
}

/**
 * One change-feed batch applied to a cache map; the SAME map when it changes
 * nothing (an echo of this device's own writes), so identity is not spent.
 * Pure: a replay onto another map decides afresh by the same rules.
 */
function applyFeed(
  map: Map<string, DriveFileMetadata[]>,
  plan: FeedPlan
): Map<string, DriveFileMetadata[]> {
  let next = map;
  const writable = () => {
    if (next === map) next = new Map(map);
    return next;
  };
  const find = (fileId: string) => {
    for (const [key, files] of next) {
      const index = files.findIndex((f) => f.fileId === fileId);
      if (index >= 0) return { key, index, entry: files[index] };
    }
    return null;
  };
  const remove = (fileId: string) => {
    const held = find(fileId);
    if (!held) return;
    const files = next.get(held.key)!.filter((f) => f.fileId !== fileId);
    if (files.length === 0) writable().delete(held.key);
    else writable().set(held.key, files);
  };
  const put = (key: string, entry: DriveFileMetadata) => {
    const held = find(entry.fileId);
    if (held && held.key === key) {
      const files = [...next.get(key)!];
      files[held.index] = entry;
      writable().set(key, files);
      return;
    }
    if (held) remove(entry.fileId);
    writable().set(key, [...(next.get(key) ?? []), entry]);
  };

  // Folders first: what sits in a removed one is gone with it (Drive takes
  // the children too), what sits under a renamed or moved one has a new path.
  if (plan.removed.size > 0 || plan.moved.size > 0) {
    for (const [key, files] of map) {
      for (const entry of files) {
        if (entry.parentId && plan.removed.has(entry.parentId)) {
          remove(entry.fileId);
          continue;
        }
        if (!descendsFrom(entry.parentId, plan.moved, plan.folders)) continue;
        const placed = placeFile(
          {
            id: entry.fileId,
            name: entry.name ?? entry.path.split('/').pop() ?? entry.path,
            mimeType: '',
            parents: entry.parentId ? [entry.parentId] : []
          },
          plan.folders
        );
        if (!placed) remove(entry.fileId);
        else if (placed.key !== key || placed.entry.path !== entry.path) {
          put(placed.key, { ...entry, path: placed.entry.path });
        }
      }
    }
  }

  for (const change of plan.files) {
    const fileId = change.file?.id ?? change.fileId;
    if (!fileId) continue;
    const placed = isGone(change) ? null : placeFile(change.file!, plan.folders);
    const held = find(fileId);
    if (!placed) {
      if (held) remove(fileId);
      continue;
    }
    if (held && (sameEntry(held.entry, placed.entry) || heldIsNewer(held.entry, change.file!))) {
      continue;
    }
    put(placed.key, placed.entry);
  }
  return next;
}

/**
 * The write root among several `mokuro-reader` folders, and whether Drive
 * could be asked which of them are top-level. An unconfirmed pick is the
 * best guess for this listing; dedup must not promote a root on it.
 */
export interface ReaderFolderPick {
  id: string | null;
  topLevelKnown: boolean;
}

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
  /**
   * Every live `mokuro-reader` folder the last whole-account listing found
   * (top-level and nested alike), plus any this session created; null until
   * a listing completes. `readControlFile` reads Bunko's marker from all of them.
   */
  private readerFolderIds: string[] | null = null;
  /** My Drive's own folder id, learnt once per session (see topLevelTest). */
  private myDriveRootId: string | null = null;
  /**
   * Roots the query said are NOT top-level, with the parent each had then:
   * while nothing it was asked about has moved or appeared, a "no top-level
   * root" answer holds and the query is not repeated (see topLevelTest).
   */
  private notTopLevel = new Map<string, string>();
  private topLevelPromise: Promise<TopLevelTest | null> | null = null;
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
  /**
   * Every live folder this account owns, as the last whole-account listing
   * saw it and the change feed has kept it since: a change entry names only
   * its parent's id, and the path is built from names.
   */
  private folders: FolderMap = new Map();
  /**
   * Where the change feed resumes (`changes.list`'s page token), and the
   * cache generation it belongs to. Taken before a whole-account walk, so it
   * means "everything changed since that listing began"; null = list in full.
   */
  private changesToken: string | null = null;
  private changesTokenGeneration = -1;
  /**
   * Drive refused a feed request in a way that will not clear (a 403 such as
   * a token that cannot read the feed — `driveApiClient`'s feed rule; a rate
   * limit or 5xx is not one). The feed is off for this session: every
   * refresh lists in full (`FULL_LISTING_REUSE_MS` aside), and no listing
   * asks for a position, until the next login or cache clear (`clearCache`).
   */
  private feedUnavailable = false;
  /** Bumped when a whole-account fetch starts: a feed read it overtook is dropped. */
  private fetchEpoch = 0;
  private feedPromise: Promise<ChangeFeedResult> | null = null;

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
    this.fetchEpoch += 1;
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

        // The change feed's position, taken BEFORE the walk: a change made
        // while it pages is then read again by the next feed (applying it
        // twice changes nothing), never missed.
        const startToken = await this.takeStartPageToken();

        // Get only files owned by the user (guarantees edit permissions)
        // This filters out viewer-only shared files while keeping shared files with edit access that user owns
        const allItems = await driveApiClient.listFiles(
          `'me' in owners and trashed=false`,
          'files(id,name,mimeType,modifiedTime,size,parents,description,createdTime)'
        );
        console.log('Found items:', allItems);

        // Count by file type
        const typeCounts: Record<string, number> = {};
        const cbzFiles: DriveFile[] = [];
        const sidecarFiles: DriveFile[] = [];
        const rootConfigFiles: DriveFile[] = [];
        const historyFiles: DriveFile[] = [];
        // id -> name + parent, for paths deeper than one folder (history/<device>/…)
        const folders: FolderMap = new Map();
        const foundFolderNames: string[] = [];
        const readerFolders: DriveFile[] = [];

        for (const item of allItems) {
          const ext =
            item.name && item.name.includes('.')
              ? item.name.split('.').pop() || 'no-extension'
              : 'no-extension';
          typeCounts[ext] = (typeCounts[ext] || 0) + 1;

          if (item.mimeType === FOLDER_MIME) {
            folders.set(item.id, { name: item.name, parent: item.parents?.[0] });
            foundFolderNames.push(item.name);

            if (item.name === READER_FOLDER) {
              readerFolders.push(item);
            }
            continue;
          }
          const kind = fileKind(item);
          if (kind === 'archive') cbzFiles.push(item);
          else if (kind === 'history') historyFiles.push(item);
          else if (kind === 'sidecar') sidecarFiles.push(item);
          else if (kind === 'root-config') rootConfigFiles.push(item);
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
          `Found ${cbzFiles.length} .cbz files, ${sidecarFiles.length} sidecar files and ${folders.size} folders`
        );
        console.log('Folder names:', foundFolderNames);

        // Build cache from files using the folder map (see `placeFile`, the
        // rule the change feed applies too). Archives and sidecars first, then
        // root config, then history: the order entries had before the rule
        // was shared, so `get()`'s first-of-duplicates pick is unchanged.
        const cacheMap = new Map<string, DriveFileMetadata[]>();
        for (const file of [...cbzFiles, ...sidecarFiles, ...rootConfigFiles, ...historyFiles]) {
          const placed = placeFile(file, folders);
          if (!placed) continue;
          const existing = cacheMap.get(placed.key);
          if (existing) existing.push(placed.entry);
          else cacheMap.set(placed.key, [placed.entry]);
        }

        console.log(
          `Cached ${cbzFiles.length} .cbz files, ${sidecarFiles.length} sidecar files and ${rootConfigFiles.length} root config file(s)`
        );
        // Chosen before the swap below, and kept only if the account is still
        // this one: the choice may ask Drive for My Drive's id.
        const { id: readerFolderId } = await this.pickReaderFolder(
          readerFolders,
          new Set(allItems.map((item) => item.id))
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
        if (readerFolderId) {
          this.readerFolderId = readerFolderId;
          console.log('Found mokuro-reader folder ID:', readerFolderId);
        }
        this.readerFolderIds = readerFolders.map((f) => f.id);
        // The feed resumes from this listing: its folders, and the position
        // taken before it began.
        this.folders = folders;
        this.changesToken = startToken;
        this.changesTokenGeneration = startedAtGeneration;
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
      }
    })();

    return this.fetchPromise;
  }

  /**
   * The change feed's current position, for a whole-account fetch about to
   * walk; null when Drive would not give one (the next refresh lists in full
   * again). An auth failure fails the fetch instead: the walk would fail the
   * same way and start the re-auth a second time.
   */
  private async takeStartPageToken(): Promise<string | null> {
    if (this.feedUnavailable) return null;
    try {
      return await driveApiClient.getStartPageToken();
    } catch (error) {
      if (isDriveAuthFailure(error)) throw error;
      this.noteFeedFailure(error);
      console.warn('[DriveCache] No change-feed position; the next refresh lists in full:', error);
      return null;
    }
  }

  /** A feed failure Drive meant for the session (see `feedUnavailable`). */
  private noteFeedFailure(error: unknown): void {
    if ((error as { feedUnavailable?: unknown } | null)?.feedUnavailable !== true) return;
    if (!this.feedUnavailable) {
      console.warn('[DriveCache] Change feed unavailable; listing in full until the next login');
    }
    this.feedUnavailable = true;
  }

  /**
   * Bring the cache up to date from Drive's change feed (`changes.list`):
   * one small request when nothing changed, instead of the whole-account
   * walk (13+ `files.list` pages at ~12,500 files). It is how this device
   * learns about other devices' writes between full listings.
   *
   * - `'unchanged'`: the feed held nothing the cache did not already show —
   *   including the echo of this device's own uploads, whose receipts are
   *   already cached. The map is not touched, so its identity holds.
   * - `'applied'`: owned files added, changed or removed, and whatever sits
   *   under a renamed or moved folder re-pathed, through the cache's mutation
   *   path with the same placement rule as the full listing (`placeFile`)
   *   and a receipt newer than the feed kept (`heldIsNewer`).
   * - `'reset'`: it listed in full instead — no position (never listed, an
   *   account switch, a position Drive refused), a log too long to be
   *   cheaper, a failed feed read, the write root gone, or a last full
   *   listing over a day old (`CHANGE_FEED_MAX_AGE_MS`). Also when a full
   *   listing overtook this read (the read is dropped: the listing is newer).
   *
   * Never toggles `isFetchingState` or `cacheLoaded` (the status badge and
   * `syncReady()` stay put), never picks the write root, and runs one at a
   * time: concurrent callers share the read. Throws only after an AUTH
   * failure, which the client has already handled; a full listing would only
   * fail the same way and start the re-auth again.
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
    // A whole-account fetch in flight replaces the position: read the feed
    // from ITS position once it lands.
    if (this.fetchPromise) await this.fetchPromise;
    const generation = this.cacheGeneration;
    if (this.feedUnavailable) {
      if (this.listedJustNow()) return 'unchanged';
      return this.listInFull('the change feed is unavailable');
    }
    const token = this.changesToken;
    if (!token || this.changesTokenGeneration !== generation || !this.isLoaded()) {
      if (this.listedJustNow()) return 'unchanged';
      return this.listInFull('no change-feed position');
    }
    if (this.lastFetchTime === null || Date.now() - this.lastFetchTime > CHANGE_FEED_MAX_AGE_MS) {
      return this.listInFull('the last full listing is over a day old');
    }
    const epoch = this.fetchEpoch;

    let feed: Awaited<ReturnType<typeof driveApiClient.listChanges>>;
    let resolved: FolderMap;
    try {
      feed = await driveApiClient.listChanges(token, CHANGE_FIELDS, MAX_CHANGE_PAGES);
      resolved = feed ? await this.resolveUnknownParents(feed.changes) : new Map();
    } catch (error) {
      if (isDriveAuthFailure(error)) throw error;
      if (generation !== this.cacheGeneration) return 'reset';
      this.noteFeedFailure(error);
      return this.listInFull('the change feed could not be read', error);
    }
    // The account went away meanwhile (sign-out, switch): nothing to apply to.
    if (generation !== this.cacheGeneration) return 'reset';
    if (epoch !== this.fetchEpoch) {
      // A full listing started meanwhile: it is newer than this batch, and its
      // own position reads again whatever this batch held.
      if (this.fetchPromise) await this.fetchPromise;
      return 'reset';
    }
    if (!feed) return this.listInFull(`more than ${MAX_CHANGE_PAGES} pages of changes`);

    let plan: FeedPlan;
    let current: Map<string, DriveFileMetadata[]>;
    let next: Map<string, DriveFileMetadata[]>;
    try {
      plan = this.planFeed(feed.changes, resolved);
      current = this.cache.read();
      next = applyFeed(current, plan);
    } catch (error) {
      // Never step past a batch that was not applied, and never fail every
      // sync on it either: the listing is what the batch would have made.
      return this.listInFull('a change batch could not be applied', error);
    }
    // The write root went away, itself or with a folder holding it: only a
    // full listing picks the next one.
    if (this.readerFolderId && plan.removed.has(this.readerFolderId)) {
      return this.listInFull('the reader folder was removed');
    }
    this.folders = plan.folders;
    // Every live reader root, as a full listing would name them: Bunko's
    // control files may sit in any of them (`getListedReaderFolderIds`).
    this.readerFolderIds = [...plan.folders]
      .filter(([, folder]) => folder.name === READER_FOLDER)
      .map(([id]) => id);
    this.changesToken = feed.newStartPageToken;
    if (next !== current) {
      // `next` is the apply on the state as it stands; a replay onto another
      // map (a fetch's) decides afresh by the same rules.
      this.mutate((map) => (map === current ? next : applyFeed(map, plan)));
    }
    if (this.collidingFolder(plan)) {
      // Two folders of one name under one parent: another device (or a race)
      // made a duplicate. Merge it as a full listing would have.
      this.dedupRefetchDepth = 0;
      this.runDeduplication();
    }
    return next !== current ? 'applied' : 'unchanged';
  }

  /**
   * Is the cache a whole-account listing finished within
   * `FULL_LISTING_REUSE_MS`? Only for a refresh with no feed to read: one
   * that met a feed failure or a batch it could not apply lists regardless,
   * since the listing is the only way past that batch.
   */
  private listedJustNow(): boolean {
    return (
      this.isLoaded() &&
      this.lastFetchTime !== null &&
      Date.now() - this.lastFetchTime < FULL_LISTING_REUSE_MS
    );
  }

  /**
   * List the whole account. The feed's position is NOT dropped first: a
   * listing that succeeds installs its own (taken before its walk), and one
   * that fails (offline) leaves the cache the exact snapshot at the old
   * position, so the next refresh catches up with one feed read instead of
   * another whole-account walk. A position Drive refused or a batch that could
   * not be applied fails the same way again and lists again: nothing is lost
   * by keeping it.
   */
  private async listInFull(reason: string, error?: unknown): Promise<'reset'> {
    if (error) console.warn(`[DriveCache] Listing in full (${reason}):`, error);
    else console.log(`[DriveCache] Listing in full (${reason})`);
    await this.fetchAllFiles();
    return 'reset';
  }

  /** Sort one batch into folder effects and file changes, against the folder map. */
  private planFeed(changes: DriveChange[], resolved: FolderMap): FeedPlan {
    const folders: FolderMap = new Map(this.folders);
    for (const [id, folder] of resolved) folders.set(id, folder);
    /** The folders the batch itself reports gone. */
    const gone = new Set<string>();
    const moved = new Set<string>();
    for (const id of resolved.keys()) moved.add(id);
    const files: DriveChange[] = [];

    for (const change of changes) {
      const id = change.file?.id ?? change.fileId;
      if (!id) continue;
      // A removal carries no file, so a folder is known by its id alone.
      const isFolder = change.file ? change.file.mimeType === FOLDER_MIME : folders.has(id);
      if (!isFolder) {
        files.push(change);
        continue;
      }
      if (isGone(change)) {
        gone.add(id);
        moved.delete(id);
        folders.delete(id);
        continue;
      }
      const file = change.file!;
      const next = { name: file.name, parent: file.parents?.[0] };
      const held = folders.get(id);
      folders.set(id, next);
      gone.delete(id);
      if (!held || held.name !== next.name || held.parent !== next.parent) moved.add(id);
    }
    // Drive removes a folder's contents with it: the folders under a removed
    // one leave the map too (their files go in `applyFeed`). "Under" is where
    // each folder sits AFTER this batch — `folders` already holds the batch's
    // moves — never where it sat before: another device's dedup merge moves
    // every series folder out of a duplicate root and then deletes the root,
    // and this device reads both in one batch. Judged by the old parent, the
    // series would leave with the root and take its files out of the cache.
    // The whole set is decided before anything leaves the map, so a folder
    // two levels down still finds its way up through its parent.
    const removed = new Set(gone);
    for (const [id, folder] of folders) {
      if (descendsFrom(folder.parent, gone, folders)) removed.add(id);
    }
    for (const id of removed) {
      folders.delete(id);
      moved.delete(id);
    }
    return { folders, removed, moved, files };
  }

  /** Does a folder this batch upserted share its name and parent with another? */
  private collidingFolder(plan: FeedPlan): boolean {
    for (const id of plan.moved) {
      const folder = plan.folders.get(id);
      if (!folder) continue;
      for (const [otherId, other] of plan.folders) {
        if (otherId !== id && other.name === folder.name && other.parent === folder.parent) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * The folders a batch's files sit in that the cache has never seen — one
   * `files.get` each, once per batch (three levels up for history, which is
   * placed by its device, `history` and reader folders). Normally empty: a
   * folder made by this app is in the feed beside its first file. A lookup
   * that names anything the whole-account listing would not hold (a 404, not
   * a folder, trashed, not ours) leaves the folder unknown, as it is to the
   * listing. A lookup that FAILS (a 5xx or rate limit past its retries,
   * offline) throws: the feed then lists in full instead of stepping past a
   * file it could not place, which it would never deliver again.
   */
  private async resolveUnknownParents(changes: DriveChange[]): Promise<FolderMap> {
    const resolved: FolderMap = new Map();
    const unknown = new Set<string>();
    const inBatch: FolderMap = new Map();
    for (const change of changes) {
      const file = change.file;
      if (file && !isGone(change) && file.mimeType === FOLDER_MIME) {
        inBatch.set(file.id, { name: file.name, parent: file.parents?.[0] });
      }
    }
    const known = (id: string) =>
      inBatch.get(id) ?? resolved.get(id) ?? this.folders.get(id) ?? undefined;

    for (const change of changes) {
      const file = change.file;
      if (!file || isGone(change)) continue;
      const kind = fileKind(file);
      if (!kind) continue;
      let id = file.parents?.[0];
      for (let depth = kind === 'history' ? 3 : 1; id && depth > 0; depth--) {
        // My Drive itself is no folder the app can read (a 404 under drive.file).
        if (unknown.has(id) || id === this.myDriveRootId) break;
        let folder = known(id);
        if (!folder) {
          folder = (await this.lookUpFolder(id)) ?? undefined;
          if (!folder) {
            unknown.add(id);
            break;
          }
          resolved.set(id, folder);
        }
        id = folder.parent;
      }
    }
    return resolved;
  }

  private async lookUpFolder(id: string): Promise<{ name: string; parent?: string } | null> {
    try {
      const meta = (await driveApiClient.getFileMetadata(
        id,
        'id,name,mimeType,parents,trashed,ownedByMe'
      )) as DriveFile | undefined;
      if (!meta || meta.mimeType !== FOLDER_MIME || meta.trashed || meta.ownedByMe === false) {
        return null;
      }
      return { name: meta.name, parent: meta.parents?.[0] };
    } catch (error) {
      if (isDriveAuthFailure(error)) throw error;
      // Drive's answer for a folder this app cannot see (`drive.file`): not
      // in the whole-account listing either.
      if ((error as { status?: unknown } | null)?.status === 404) return null;
      throw error;
    }
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
   * THE library folder among every live `mokuro-reader` folder (duplicates,
   * or one the user moved): one directly in My Drive first, then the oldest,
   * then the smaller id — the folder FolderDeduplicator keeps when it merges
   * the top-level ones, so writes never go to the copy the next merge
   * empties. A nested root is never merged away; it is the write root only
   * when there is no top-level one. The provider's dedup confirms a root only
   * when it is this same choice, so the two never disagree.
   *
   * When Drive cannot be asked which roots are top-level, the pick is a
   * guess, flagged `topLevelKnown: false`: the session's current write root
   * while the listing still has it (a failed query must not move writes to
   * an older nested root), else a root whose parent is NOT among `listedIds`
   * — the listing never holds My Drive itself, so a parent the app can see
   * is a folder, and the root under it is nested — then age and id.
   */
  async pickReaderFolder(
    folders: DriveFile[],
    listedIds?: ReadonlySet<string>
  ): Promise<ReaderFolderPick> {
    if (folders.length <= 1) return { id: folders[0]?.id ?? null, topLevelKnown: true };
    const atTop = await this.topLevelTest(folders);
    const byTopThenAge = (isTop: TopLevelTest) =>
      [...folders].sort((a, b) => Number(isTop(b)) - Number(isTop(a)) || compareByAge(a, b))[0].id;
    if (atTop) return { id: byTopThenAge(atTop), topLevelKnown: true };
    const current = this.readerFolderId;
    if (current && folders.some((f) => f.id === current)) {
      return { id: current, topLevelKnown: false };
    }
    const parentUnseen: TopLevelTest = (f) => {
      const parent = f.parents?.[0];
      return !parent || !listedIds?.has(parent);
    };
    return { id: byTopThenAge(parentUnseen), topLevelKnown: false };
  }

  /**
   * Is a folder directly in My Drive? Not `files.get('root')`: under the
   * app's drive.file scope that is a 404 (rclone hit the same). The `'root'`
   * alias does work in a query, so ask for the top-level `mokuro-reader`
   * folders; their parent is My Drive's id, remembered for the session. An
   * answer that names none is remembered per root asked about, with the
   * parent it had: the same roots under the same parents get the same
   * answer, so only a root that moved or appeared asks again. Null when the
   * query fails (asked again next time).
   */
  private async topLevelTest(folders: DriveFile[]): Promise<TopLevelTest | null> {
    const known = this.myDriveRootId;
    if (known) return (f) => f.parents?.[0] === known;
    if (folders.every((f) => this.notTopLevel.get(f.id) === (f.parents?.[0] ?? ''))) {
      return () => false;
    }
    if (!this.topLevelPromise) {
      const generation = this.cacheGeneration;
      const reader = escapeNameForDriveQuery(GOOGLE_DRIVE_CONFIG.FOLDER_NAMES.READER);
      const promise: Promise<TopLevelTest | null> = driveApiClient
        .listFiles(
          `'root' in parents and name='${reader}' and mimeType='${GOOGLE_DRIVE_CONFIG.MIME_TYPES.FOLDER}' and trashed=false`,
          'files(id,parents)'
        )
        .then((top: DriveFile[]) => {
          const id = top.find((f) => f.parents?.[0])?.parents?.[0];
          const ids = new Set(top.map((f) => f.id));
          const isTop: TopLevelTest = (f) => ids.has(f.id) || (!!id && f.parents?.[0] === id);
          // An answer for an account signed out meanwhile is not this one's.
          if (this.cacheGeneration === generation) {
            if (id) this.myDriveRootId = id;
            for (const f of folders) {
              if (!isTop(f)) this.notTopLevel.set(f.id, f.parents?.[0] ?? '');
            }
          }
          return isTop;
        })
        .catch((error: unknown) => {
          console.warn('[DriveCache] Could not list the top-level mokuro-reader folders:', error);
          return null;
        });
      this.topLevelPromise = promise;
      // Only this promise's own slot: a clear() meanwhile may have let a
      // newer query take the field, and that one must not be dropped.
      promise.finally(() => {
        if (this.topLevelPromise === promise) this.topLevelPromise = null;
      });
    }
    return this.topLevelPromise;
  }

  /**
   * Set the reader folder ID in cache (after creating the folder)
   */
  setReaderFolderId(folderId: string): void {
    this.readerFolderId = folderId;
    if (this.readerFolderIds && !this.readerFolderIds.includes(folderId)) {
      this.readerFolderIds = [...this.readerFolderIds, folderId];
    }
  }

  /**
   * The ids of every live `mokuro-reader` folder, as of the last whole-account
   * listing and the change batches applied since — not only the write root:
   * Bunko may hold the library in any of them. Null when no listing has
   * completed for this account.
   */
  getListedReaderFolderIds(): string[] | null {
    return this.readerFolderIds ? [...this.readerFolderIds] : null;
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
    this.readerFolderIds = null;
    this.myDriveRootId = null;
    this.notTopLevel.clear();
    this.topLevelPromise = null;
    this.fetchPromise = null;
    this.folders = new Map();
    this.changesToken = null;
    this.feedPromise = null;
    // The next login asks the feed again.
    this.feedUnavailable = false;
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

  revision(): object {
    return this.cache.revision();
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
      // Grouped by the FIRST segment, which is what `has`/`get`/`getAll` look
      // up. For every two-segment path (`<Series>/<file>`) that is the folder;
      // reading history (`history/<device>/<file>`) is the one deeper path.
      const seriesTitle = parts[0];
      const volumeTitle = parts[parts.length - 1]?.replace('.cbz', '') || '';
      this.addDriveFile(seriesTitle, volumeTitle, metadata);
      return;
    }

    // A ROOT config file (`volume-data.json`, `profiles.json`, `goals.json`,
    // `catalog.json`). This branch used to be missing entirely, so every
    // targeted post-upload `add()` for a root file was a silent no-op on Drive
    // alone — a first-ever upload stayed invisible to `get()`/`getAll()` until
    // the next full account listing, and every sync in between saw the cloud as
    // absent and re-uploaded identical bytes.
    //
    // Keyed by the LOWERCASED basename, matching how the fetch keys root config
    // files (`file.name.toLowerCase()`); `get()` keys off `path.split('/')[0]`,
    // and callers pass the already-lowercase literal basename.
    if (parts.length === 1 && parts[0]) {
      this.addDriveFile(parts[0].toLowerCase(), parts[0], metadata);
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
   * duplicate the next pass merges. That is an unbounded refetch engine
   * (MEGA's dedup, added later, bounds its refetch the same way; WebDAV runs
   * no dedup).
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

        // Before any merge: the merge below confirms its root itself, but a
        // root merged away elsewhere (or by the Bunko this skips for) is only
        // ever noticed here, as a listing that picks another one.
        if (this.readerFolderId) googleDriveProvider.adoptListedReaderFolder(this.readerFolderId);

        // A fresh Bunko lease holder that merges duplicates does it with the
        // same rule; a second merger on the same folders only races its moves.
        await refreshCloudBunkoMarker(googleDriveProvider);
        if (cloudBunkoMergesDuplicates(googleDriveProvider.type)) {
          console.log('[Dedup] a cloud-direct Bunko merges duplicates here; skipping');
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
