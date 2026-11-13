import type { CoalescedCacheStore } from './coalesced-cache-store';
import type { CloudFileMetadata } from './provider-interface';
import { HISTORY_FOLDER, parseHistoryPath } from '$lib/reading-history/paths';

/** A listing cache's map: files grouped by the first segment of their path. */
type SeriesMap = Map<string, CloudFileMetadata[]>;
type Mutation = (map: SeriesMap) => SeriesMap;

/**
 * The live mutation and its replay onto a listing that was walking while it
 * ran — the two arguments of `CoalescedCacheStore.update`.
 *
 * A replay must not hide what the walk saw. Ids outlive an overwrite
 * (OneDrive keeps the item, WebDAV and Local Folder key by path), so a
 * listing can hold the file under the same id at a NEWER revision than this
 * device's write: the walk read the folder after another device wrote over
 * it. The stamp checks (series.json, catalog.json, history) read exactly that
 * difference as "another device wrote", so a replay yields to it. A stale
 * record left in place costs a re-read; a newer one hidden costs a lost write.
 */
export function addMutations(
  path: string,
  metadata: CloudFileMetadata
): [live: Mutation, replay: Mutation] {
  let held: CloudFileMetadata | undefined;
  return [
    (map) => {
      held = findById(map, metadata.fileId);
      return upsert(map, path, metadata);
    },
    // The listing's record is taken over only when it is the one this device
    // held before the upload (the walk read the folder first) — or absent.
    (map) => {
      const listed = findById(map, metadata.fileId);
      return listed && !sameRevision(listed, held) ? map : upsert(map, path, metadata);
    }
  ];
}

/** {@link addMutations}' rule for a delete: see there. */
export function removeMutations(fileId: string): [live: Mutation, replay: Mutation] {
  let held: CloudFileMetadata | undefined;
  return [
    (map) => {
      held = findById(map, fileId);
      return remove(map, fileId);
    },
    // A listed server revision other than the one deleted was read after the
    // delete: the path was written again (WebDAV and Local Folder key by it).
    (map) => {
      const listed = findById(map, fileId);
      const rewritten =
        listed && held && !held.modifiedTimeProvisional && !sameRevision(listed, held);
      return rewritten ? map : remove(map, fileId);
    }
  ];
}

/**
 * Replace every entry under `folder/` (exactly as spelled: a listing's first
 * segment) with `entries`, a scoped listing of that folder; every other
 * folder is left as it is. Never a whole-listing install: a series' scoped
 * pull must not touch what other folders hold.
 */
export function replaceFolderMutation<T extends CloudFileMetadata>(
  folder: string,
  entries: T[]
): (map: Map<string, T[]>) => Map<string, T[]> {
  const prefix = `${folder}/`;
  const own = entries.filter((f) => f.path.startsWith(prefix));
  return (map) => {
    const next = new Map(map);
    next.delete(folder);
    // A path under the folder filed elsewhere (never by the caches' own
    // grouping, which is by first segment) goes too.
    for (const [key, files] of next) {
      const kept = files.filter((f) => !f.path.startsWith(prefix));
      if (kept.length === 0) next.delete(key);
      else if (kept.length !== files.length) next.set(key, kept);
    }
    if (own.length > 0) next.set(folder, own);
    return next;
  };
}

/**
 * `CloudCache.replaceFolderEntries` over a cache's store: list `folder`, then
 * apply the replacement with the writes made meanwhile replayed on top.
 * `apply` is how the cache mutates (default: the store's own `update`).
 */
export async function replaceFolderInStore<T extends CloudFileMetadata>(
  store: CoalescedCacheStore<T[]>,
  loaded: boolean,
  folder: string,
  list: () => Promise<T[]>,
  apply: (fn: (map: Map<string, T[]>) => Map<string, T[]>) => void = (fn) => store.update(fn)
): Promise<boolean> {
  if (!loaded || !folder) return false;
  const partial = store.beginPartialListing();
  try {
    const entries = await list();
    const replace = partial.finish(replaceFolderMutation(folder, entries));
    if (!replace) return false;
    apply(replace);
    return true;
  } finally {
    partial.abandon();
  }
}

/**
 * Whether `listed` is the revision this device held: the same record, or the
 * same server stamps. A client-clock stamp proves nothing.
 */
function sameRevision(listed: CloudFileMetadata, held: CloudFileMetadata | undefined): boolean {
  if (!held) return false;
  if (listed === held) return true;
  return (
    !held.modifiedTimeProvisional &&
    listed.size === held.size &&
    listed.modifiedTime === held.modifiedTime
  );
}

function findById(map: SeriesMap, fileId: string): CloudFileMetadata | undefined {
  for (const files of map.values()) {
    const found = files.find((f) => f.fileId === fileId);
    if (found) return found;
  }
  return undefined;
}

function upsert(map: SeriesMap, path: string, metadata: CloudFileMetadata): SeriesMap {
  const next = new Map(map);
  const seriesTitle = path.split('/')[0];
  const existing = next.get(seriesTitle);
  if (!existing) {
    next.set(seriesTitle, [metadata]);
    return next;
  }
  const index = existing.findIndex((f) => f.fileId === metadata.fileId);
  next.set(
    seriesTitle,
    index >= 0
      ? [...existing.slice(0, index), metadata, ...existing.slice(index + 1)]
      : [...existing, metadata]
  );
  return next;
}

function remove(map: SeriesMap, fileId: string): SeriesMap {
  const next = new Map(map);
  for (const [key, files] of next.entries()) {
    const filtered = files.filter((f) => f.fileId !== fileId);
    if (filtered.length === 0) next.delete(key);
    else if (filtered.length !== files.length) next.set(key, filtered);
  }
  return next;
}

/**
 * What one {@link HistoryListingPatch.apply} did: installed the listing,
 * found nothing to change (the cache keeps its identity, so no subscriber
 * re-derives anything), or dropped it because the cache was replaced since
 * the patch began (a full listing installed, or a sign-out cleared it).
 */
export type HistoryPatchResult = 'applied' | 'unchanged' | 'superseded';

/**
 * A listing of `history/` alone, about to be folded into a whole-library
 * listing cache — the freshness a provider WITHOUT a change feed can afford
 * between full listings (`history-listing-refresh.ts`). Begun BEFORE the
 * folder is listed, so a cache replaced while the listing ran is detected.
 */
export interface HistoryListingPatch {
  /** When the cache last installed a full listing (epoch ms; 0 = never). */
  readonly listedAt: number;
  /**
   * Fold `listed` (`history/` alone, as `SyncProvider.listFolder` returns it)
   * into the cache — see {@link patchHistoryFolder} for the rule.
   */
  apply(listed: CloudFileMetadata[], ownDevice: string): HistoryPatchResult;
}

/**
 * The store side a {@link HistoryListingPatch} needs: the state, the
 * generation that every full install or clear bumps, and an incremental update.
 */
interface PatchableStore {
  read(): SeriesMap;
  generation(): number;
  update(fn: Mutation, replay?: Mutation): void;
}

/** Open a {@link HistoryListingPatch} on a listing cache's store. */
export function beginHistoryPatch(store: PatchableStore, listedAt: number): HistoryListingPatch {
  const generation = store.generation();
  return {
    listedAt,
    apply(listed, ownDevice) {
      if (store.generation() !== generation) return 'superseded';
      const current = store.read();
      if (patchHistoryFolder(current, listed, ownDevice) === current) return 'unchanged';
      // The replay onto a full listing in flight is the IDENTITY: that walk
      // read `history/` itself, and its view wins (see patchHistoryFolder).
      store.update(
        (map) => patchHistoryFolder(map, listed, ownDevice),
        (map) => map
      );
      return 'applied';
    }
  };
}

/**
 * A listing of `history/` alone, folded into a whole-library map (bucket
 * `history`, the first path segment):
 *
 * - every OTHER device's history file in the bucket is replaced by the listed
 *   ones — that is all this listing is for: their new months, rewritten
 *   segments and removals;
 * - THIS device's own entries are kept: each is the receipt of its own
 *   upload, which can be newer than what the PROPFIND read (an upload that
 *   landed while it ran). A listed own file the map does not hold is taken
 *   (it is on the server; without it the export would upload it again);
 * - anything else in the bucket is not history (a series folder that happens
 *   to be named `history`) and is left alone.
 *
 * Returns `map` itself when nothing would change, so a quiet refresh spends
 * no Map identity.
 *
 * NOT a change feed, and never to be wired as one (`refreshFromChanges`):
 * it freshens `history/` only, and `ensureFreshCloudListing` takes a feed's
 * answer as "the whole listing is current" — the series.json / catalog.json
 * writers would then prune against stale series folders.
 */
export function patchHistoryFolder(
  map: SeriesMap,
  listed: CloudFileMetadata[],
  ownDevice: string
): SeriesMap {
  const deviceOf = (path: string) => parseHistoryPath(path)?.device;
  const held = map.get(HISTORY_FOLDER) ?? [];
  const kept = held.filter((f) => {
    const device = deviceOf(f.path);
    return device === undefined || device === ownDevice;
  });
  const replaced = held.filter((f) => !kept.includes(f));
  const keptPaths = new Set(kept.map((f) => f.path));
  const incoming: CloudFileMetadata[] = [];
  const ownAdded: CloudFileMetadata[] = [];
  const seen = new Set<string>();
  for (const file of listed) {
    const device = deviceOf(file.path);
    if (device === undefined || seen.has(file.path)) continue;
    seen.add(file.path);
    if (device !== ownDevice) incoming.push(file);
    else if (!keptPaths.has(file.path)) ownAdded.push(file);
  }

  if (ownAdded.length === 0 && sameEntries(replaced, incoming)) return map;
  const next = new Map(map);
  const bucket = [...kept, ...ownAdded, ...incoming];
  if (bucket.length === 0) next.delete(HISTORY_FOLDER);
  else next.set(HISTORY_FOLDER, bucket);
  return next;
}

/** The same files at the same stamps, in any order. */
function sameEntries(a: CloudFileMetadata[], b: CloudFileMetadata[]): boolean {
  if (a.length !== b.length) return false;
  const byPath = new Map(a.map((f) => [f.path, f]));
  return b.every((f) => {
    const g = byPath.get(f.path);
    return (
      !!g &&
      g.fileId === f.fileId &&
      g.size === f.size &&
      g.modifiedTime === f.modifiedTime &&
      g.revision === f.revision
    );
  });
}
