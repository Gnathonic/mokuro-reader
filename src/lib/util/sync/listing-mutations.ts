import type { CloudFileMetadata } from './provider-interface';

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
