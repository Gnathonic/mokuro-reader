import type { ProviderType } from './provider-interface';
import { syncMergesEveryCopy } from './syncable-file';

/**
 * Folder information for deduplication
 */
export interface FolderInfo {
  id: string;
  name: string;
  parentId: string | null;
  createdTime?: string;
}

/**
 * Item in a folder (file or subfolder)
 */
export interface FolderItem {
  id: string;
  name: string;
  isFolder: boolean;
  /** ISO time of the last write, when the provider knows it. */
  modifiedTime?: string;
}

/**
 * Interface for folder operations needed by the deduplicator
 * Providers that support folder dedup implement this
 */
export interface FolderOperations {
  /**
   * The folders that may be merged: the app's own folders only. On a
   * provider that can see the whole account (MEGA), this must not reach
   * folders the user keeps for anything else.
   */
  listFolders(): Promise<FolderInfo[]>;

  /** List contents of a specific folder */
  listFolderContents(folderId: string): Promise<FolderItem[]>;

  /** Move an item to a new parent folder */
  moveItem(itemId: string, newParentId: string, oldParentId: string): Promise<void>;

  /** Delete a folder (should be empty) */
  deleteFolder(folderId: string): Promise<void>;

  /**
   * Move a superseded copy of a file to the provider's trash. Never a
   * permanent delete: a shared name says nothing about shared content.
   */
  trashFile(fileId: string): Promise<void>;

  /** Called when root app folder ID is confirmed (e.g., mokuro-reader) */
  onRootFolderConfirmed?(folderId: string): void;

  /** The root folder name to look for (e.g., 'mokuro-reader') */
  readonly rootFolderName: string;
}

/**
 * Result of a deduplication pass
 */
export interface DeduplicationResult {
  /** Number of duplicate groups found and merged */
  groupsMerged: number;
  /** Total number of duplicate folders deleted */
  foldersDeleted: number;
  /** Total number of items moved */
  itemsMoved: number;
}

/** Strictly newer by the provider's write time; unknown or equal times keep the canonical copy. */
function isNewer(a: FolderItem, b: FolderItem): boolean {
  const ta = a.modifiedTime ? Date.parse(a.modifiedTime) : NaN;
  const tb = b.modifiedTime ? Date.parse(b.modifiedTime) : NaN;
  return Number.isFinite(ta) && Number.isFinite(tb) && ta > tb;
}

/**
 * Generic folder deduplicator that works with any provider
 *
 * Providers like Google Drive and MEGA allow multiple folders with the same name.
 * This class detects and merges duplicate folders.
 *
 * Works incrementally by level:
 * - Pass 1: Merges ALL duplicate groups at current state (e.g., 2 mokuro-reader folders,
 *           each containing Trigun folders → 1 mokuro-reader with multiple Trigun folders)
 * - Pass 2: Sees the new duplicates created by Pass 1 and merges those
 * - And so on until no duplicates remain
 */
class FolderDeduplicator {
  private runningProviders = new Set<ProviderType>();

  /**
   * Run deduplication for a provider
   * Finds ALL duplicate folder groups and merges each group
   * Does NOT recurse into merged folders - that's handled by the next pass
   *
   * @param provider Provider type identifier
   * @param ops Folder operations for this provider
   * @returns Result with counts of what was merged
   */
  async deduplicateAll(
    provider: ProviderType,
    ops: FolderOperations
  ): Promise<DeduplicationResult> {
    const result: DeduplicationResult = {
      groupsMerged: 0,
      foldersDeleted: 0,
      itemsMoved: 0
    };

    if (this.runningProviders.has(provider)) {
      console.log(`[Dedup:${provider}] Already running, skipping`);
      return result;
    }

    this.runningProviders.add(provider);

    // Cap pass count to prevent runaway loops if a provider keeps reporting duplicates
    // (e.g., move/delete silently failing). Real-world depth is small.
    const MAX_PASSES = 20;

    try {
      for (let pass = 1; pass <= MAX_PASSES; pass++) {
        const folders = await ops.listFolders();
        if (folders.length === 0) break;

        const duplicateGroups = this.findAllDuplicateGroups(folders);
        if (duplicateGroups.length === 0) {
          if (pass === 1) {
            console.log(`[Dedup:${provider}] No duplicate folders found`);
          }
          break;
        }

        console.log(
          `[Dedup:${provider}] Pass ${pass}: merging ${duplicateGroups.length} duplicate group(s)`
        );

        for (const group of duplicateGroups) {
          const mergeResult = await this.mergeGroup(provider, ops, group);
          result.groupsMerged++;
          result.foldersDeleted += mergeResult.foldersDeleted;
          result.itemsMoved += mergeResult.itemsMoved;
        }

        if (pass === MAX_PASSES) {
          console.warn(
            `[Dedup:${provider}] Hit MAX_PASSES (${MAX_PASSES}); stopping. Duplicates may remain.`
          );
        }
      }

      if (result.groupsMerged > 0) {
        console.log(
          `[Dedup:${provider}] Merged ${result.groupsMerged} groups, ` +
            `deleted ${result.foldersDeleted} folders, moved ${result.itemsMoved} items`
        );
      }

      return result;
    } catch (error) {
      console.error(`[Dedup:${provider}] Error during deduplication:`, error);
      return result;
    } finally {
      this.runningProviders.delete(provider);
    }
  }

  /**
   * Find all groups of duplicate folders (same name + same parent)
   * Each group is sorted by creation time (oldest first = canonical)
   */
  private findAllDuplicateGroups(folders: FolderInfo[]): FolderInfo[][] {
    // Group folders by "parentId:name" key
    const byKey = new Map<string, FolderInfo[]>();

    for (const folder of folders) {
      const key = `${folder.parentId || 'root'}:${folder.name}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.push(folder);
      } else {
        byKey.set(key, [folder]);
      }
    }

    // Filter to only groups with duplicates and sort each by creation time
    const duplicateGroups: FolderInfo[][] = [];

    for (const group of byKey.values()) {
      if (group.length > 1) {
        // Sort by creation time - oldest first (canonical)
        group.sort((a, b) => {
          const dateA = new Date(a.createdTime || 0).getTime();
          const dateB = new Date(b.createdTime || 0).getTime();
          return dateA - dateB;
        });
        duplicateGroups.push(group);
      }
    }

    return duplicateGroups;
  }

  /**
   * Merge a group of duplicate folders into the canonical (first/oldest)
   * Returns counts of what was done
   */
  private async mergeGroup(
    provider: ProviderType,
    ops: FolderOperations,
    group: FolderInfo[]
  ): Promise<{ foldersDeleted: number; itemsMoved: number }> {
    const canonical = group[0];
    const duplicates = group.slice(1);
    let foldersDeleted = 0;
    let itemsMoved = 0;

    console.log(
      `[Dedup:${provider}] Merging ${duplicates.length} duplicate(s) of "${canonical.name}" into ${canonical.id}`
    );

    // Merge each duplicate into canonical
    for (const duplicate of duplicates) {
      // Listed afresh per duplicate, for collision detection: a sync running
      // beside a long merge may have written into the canonical folder since.
      const canonicalContents = await ops.listFolderContents(canonical.id);
      const canonicalItems = new Map(canonicalContents.map((c) => [c.name, c]));
      const contents = await ops.listFolderContents(duplicate.id);

      for (const item of contents) {
        const existing = canonicalItems.get(item.name);
        if (!existing) {
          // No collision - move to canonical
          console.log(`[Dedup:${provider}]   Moving: ${item.name}`);
          await ops.moveItem(item.id, canonical.id, duplicate.id);
          canonicalItems.set(item.name, item);
          itemsMoved++;
        } else if (item.isFolder || existing.isFolder || syncMergesEveryCopy(item.name)) {
          // Moved in beside the same name: two folders merge on the next
          // pass; a file next to a folder is no duplicate; and sync folds
          // every copy of volume-data.json / goals.json into one, so dropping
          // either here would lose what only that copy held.
          console.log(`[Dedup:${provider}]   Moving (name kept twice): ${item.name}`);
          await ops.moveItem(item.id, canonical.id, duplicate.id);
          itemsMoved++;
        } else if (isNewer(item, existing)) {
          // Two copies of one file: the newer stays, the other goes to the trash.
          console.log(`[Dedup:${provider}]   Trashing the older copy of: ${item.name}`);
          await ops.trashFile(existing.id);
          await ops.moveItem(item.id, canonical.id, duplicate.id);
          canonicalItems.set(item.name, item);
          itemsMoved++;
        } else {
          console.log(`[Dedup:${provider}]   Trashing the older copy of: ${item.name}`);
          await ops.trashFile(item.id);
        }
      }

      // Delete the now-empty duplicate folder
      console.log(`[Dedup:${provider}] Deleting empty folder: ${duplicate.id}`);
      await ops.deleteFolder(duplicate.id);
      foldersDeleted++;
    }

    // Notify provider if this was the root folder
    if (canonical.name === ops.rootFolderName && ops.onRootFolderConfirmed) {
      ops.onRootFolderConfirmed(canonical.id);
    }

    return { foldersDeleted, itemsMoved };
  }
}

export const folderDeduplicator = new FolderDeduplicator();
