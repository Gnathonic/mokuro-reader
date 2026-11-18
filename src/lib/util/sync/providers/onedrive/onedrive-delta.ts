/**
 * OneDrive's change feed (Graph `delta`) applied to the listing cache — the
 * pure half: what one batch of delta items means for the folder map and the
 * cached files. `onedrive-cache.ts` reads the feed and decides when to list
 * in full instead.
 *
 * The feed is root-scoped (`graph-client.ts` `startDelta`), so it reports
 * every change in the drive. What sits under the mokuro folder is known by
 * FOLDER ID, from the folder map the last full listing recorded and the feed
 * has kept since: a batch item names its parent's id only, and the path is
 * built from names. Items with an unknown parent are outside the library.
 *
 * Conservative where it cannot be sure, because the metadata writers merge
 * and prune `series.json`/`catalog.json` against what the cache holds:
 * anything the batch cannot place exactly asks for a full listing (`relist`)
 * instead of guessing —
 * - a known folder renamed or moved (Graph reports the folder, not what is
 *   under it; renames are rare, and re-pathing a subtree from here would be
 *   the one place a wrong path could creep in);
 * - a folder that entered the library holding more than the batch shows (a
 *   move in from elsewhere in the drive: its contents never changed, so the
 *   feed never lists them);
 * - the mokuro folder itself removed.
 */
import type { CloudFileMetadata } from '../../provider-interface';
import { isSyncableFile } from '../../syncable-file';
import { oneDriveRevision } from '../../core/providers/onedrive-core';
import type { DriveItem } from './graph-client';

/**
 * One live folder of the library: its name, its parent's id, and its path
 * under the mokuro folder (`''` for the mokuro folder itself).
 */
export interface OneDriveFolder {
  name: string;
  parent?: string;
  path: string;
}

/** Folder id → folder, every live folder under (and including) the mokuro folder. */
export type OneDriveFolderMap = Map<string, OneDriveFolder>;

/** A file change, decided against the folder map: put this entry, or drop this id. */
type FileEffect = { put: CloudFileMetadata } | { remove: string };

/** Everything one batch decided, so the apply can run again on another map (a replay). */
export interface DeltaPlan {
  /** The folder map after this batch. */
  folders: OneDriveFolderMap;
  /** Paths of the folders the batch removed: every cached file under one goes. */
  removedPaths: string[];
  /** The batch's file effects, one per file id (the item's last occurrence). */
  files: FileEffect[];
}

/** The batch cannot be applied exactly: list in full, for this reason. */
export interface DeltaRelist {
  relist: string;
}

/** The listing entry a live file item makes under `folder`. */
export function listingEntry(item: DriveItem, folder: OneDriveFolder): CloudFileMetadata {
  const revision = oneDriveRevision(item);
  return {
    provider: 'onedrive',
    fileId: item.id,
    path: folder.path ? `${folder.path}/${item.name}` : item.name,
    // Never the client clock: a missing server stamp is the epoch, which
    // every stamp check reads as "older than anything".
    modifiedTime: item.lastModifiedDateTime ?? new Date(0).toISOString(),
    size: item.size ?? 0,
    ...(revision ? { revision } : {})
  };
}

/** Does `path` sit at or under the folder at `folderPath`? */
function isUnder(path: string, folderPath: string): boolean {
  return folderPath === '' || path === folderPath || path.startsWith(`${folderPath}/`);
}

/**
 * Sort one delta batch into folder and file effects against `held` (the
 * folder map before it). Pure. `rootId` is the mokuro folder's id.
 */
export function planDelta(
  batch: DriveItem[],
  held: OneDriveFolderMap,
  rootId: string
): DeltaPlan | DeltaRelist {
  // Graph may report an item more than once; its last occurrence is its state.
  const latest = new Map<string, DriveItem>();
  for (const item of batch) {
    if (!item?.id) continue;
    latest.delete(item.id);
    latest.set(item.id, item);
  }

  const folders: OneDriveFolderMap = new Map(held);
  const gone = new Set<string>();
  const added = new Map<string, DriveItem>();
  const fileItems: DriveItem[] = [];
  /** Live items per parent id, to tell a new folder from one moved in. */
  const childrenInBatch = new Map<string, number>();

  for (const item of latest.values()) {
    if (item.root) continue; // the drive's own root
    const parent = item.parentReference?.id;
    if (!item.deleted && parent)
      childrenInBatch.set(parent, (childrenInBatch.get(parent) ?? 0) + 1);

    const known = folders.get(item.id);
    if (item.deleted) {
      // A delete names no kind: a folder is known by its id alone.
      if (known) gone.add(item.id);
      else fileItems.push(item);
      continue;
    }
    if (!item.folder) {
      fileItems.push(item);
      continue;
    }
    if (!known) {
      added.set(item.id, item);
      continue;
    }
    // A known folder: an ancestor of something that changed (no-op), or renamed/moved.
    const renamed = item.name !== undefined && item.name !== known.name;
    const moved = parent !== undefined && known.parent !== undefined && parent !== known.parent;
    if (renamed || moved) {
      return { relist: `folder '${known.path || item.name}' was renamed or moved` };
    }
    if (known.parent === undefined && parent !== undefined) {
      // The listing did not know this folder's parent (the mokuro folder's
      // lookup may omit it): learn it rather than call it a move next time.
      folders.set(item.id, { ...known, parent });
    }
  }

  if (gone.has(rootId)) return { relist: 'the mokuro folder was removed' };

  // New folders, parents before children whatever order the batch had.
  let progress = true;
  while (progress && added.size > 0) {
    progress = false;
    for (const [id, item] of added) {
      const parent = item.parentReference?.id;
      const parentFolder = parent !== undefined ? folders.get(parent) : undefined;
      if (!parentFolder || gone.has(parent!)) continue;
      // Created here, its contents are in the batch; moved in from elsewhere
      // in the drive, they are not (they never changed).
      const childCount = item.folder?.childCount;
      if (typeof childCount !== 'number' || childCount > (childrenInBatch.get(id) ?? 0)) {
        return { relist: `folder '${item.name}' entered the library with contents` };
      }
      folders.set(id, {
        name: item.name,
        parent,
        path: parentFolder.path ? `${parentFolder.path}/${item.name}` : item.name
      });
      added.delete(id);
      progress = true;
    }
  }
  // What is left has a parent outside the library: not ours.

  // A removed folder takes everything under it — by ID, through the parent
  // links, never by path: a folder deleted and made again under the same name
  // in one batch (a series removed and uploaded again) is a NEW id at the old
  // path, and must stay. Cached FILES do go by path (`removedPaths`): the
  // batch's own puts, applied after, bring the new folder's files back.
  const removedPaths: string[] = [];
  if (gone.size > 0) {
    const removed = new Set<string>();
    let grew = true;
    while (grew) {
      grew = false;
      for (const [id, folder] of folders) {
        if (removed.has(id)) continue;
        if (gone.has(id) || (folder.parent !== undefined && removed.has(folder.parent))) {
          removed.add(id);
          grew = true;
        }
      }
    }
    for (const id of removed) {
      if (gone.has(id)) removedPaths.push(folders.get(id)!.path);
      folders.delete(id);
    }
  }

  const files: FileEffect[] = [];
  for (const item of fileItems) {
    const parent = item.parentReference?.id;
    const folder = !item.deleted && item.file && parent ? folders.get(parent) : undefined;
    if (!folder) {
      // Deleted, moved out of the library, or not a file: whatever the cache
      // held under this id goes (a no-op when it held nothing).
      files.push({ remove: item.id });
      continue;
    }
    const entry = listingEntry(item, folder);
    files.push(isSyncableFile(entry.path) ? { put: entry } : { remove: item.id });
  }
  return { folders, removedPaths, files };
}

/**
 * Is a delta entry for a file the cache holds just the cache's own record
 * coming back — the echo of this device's upload, whose receipt the cache
 * already has? Revisions are compared when both sides carry one.
 */
function sameEntry(held: CloudFileMetadata, listed: CloudFileMetadata): boolean {
  if (held.modifiedTimeProvisional) return false;
  if (held.path !== listed.path || held.size !== listed.size) return false;
  if (held.revision && listed.revision && held.revision !== listed.revision) return false;
  return Date.parse(held.modifiedTime) === Date.parse(listed.modifiedTime);
}

/**
 * Is the cache's record NEWER than the feed's? A receipt that landed while
 * the delta page was on the wire. By server mtime (a client-clock stamp
 * proves nothing); only for the same path.
 */
function heldIsNewer(held: CloudFileMetadata, listed: CloudFileMetadata): boolean {
  if (held.modifiedTimeProvisional || held.path !== listed.path) return false;
  const heldAt = Date.parse(held.modifiedTime);
  const listedAt = Date.parse(listed.modifiedTime);
  return Number.isFinite(heldAt) && Number.isFinite(listedAt) && heldAt > listedAt;
}

/**
 * One planned batch applied to a cache map (files grouped by the first
 * segment of their path). Returns the SAME map when nothing changes (the
 * echo of this device's own writes), so identity is not spent. Pure: a
 * replay onto another map decides afresh by the same rules.
 */
export function applyDelta(
  map: Map<string, CloudFileMetadata[]>,
  plan: DeltaPlan
): Map<string, CloudFileMetadata[]> {
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

  if (plan.removedPaths.length > 0) {
    for (const files of map.values()) {
      for (const entry of files) {
        if (plan.removedPaths.some((path) => isUnder(entry.path, path))) remove(entry.fileId);
      }
    }
  }

  for (const effect of plan.files) {
    if ('remove' in effect) {
      remove(effect.remove);
      continue;
    }
    const entry = effect.put;
    const held = find(entry.fileId);
    if (held && (sameEntry(held.entry, entry) || heldIsNewer(held.entry, entry))) continue;
    const key = entry.path.split('/')[0];
    if (held && held.key === key) {
      const files = [...next.get(key)!];
      files[held.index] = entry;
      writable().set(key, files);
      continue;
    }
    if (held) remove(entry.fileId);
    writable().set(key, [...(next.get(key) ?? []), entry]);
  }
  return next;
}
