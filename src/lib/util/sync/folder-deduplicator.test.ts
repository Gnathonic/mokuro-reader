import { describe, expect, it } from 'vitest';
import { folderDeduplicator, type FolderOperations } from './folder-deduplicator';

// The merge rule over an in-memory drive: what each copy of a file becomes
// when two duplicate folders merge. Provider-specific behaviour (what a
// provider lists, what its trash is) is covered by each provider's own tests.

interface Node {
  id: string;
  name: string;
  parentId: string | null;
  isFolder: boolean;
  createdTime?: string;
  modifiedTime?: string;
  trashed?: boolean;
}

function memoryDrive(nodes: Node[]) {
  const byId = new Map(nodes.map((n) => [n.id, { ...n }]));
  const live = () => [...byId.values()].filter((n) => !n.trashed);
  const ops: FolderOperations = {
    rootFolderName: 'mokuro-reader',
    listFolders: async () =>
      live()
        .filter((n) => n.isFolder)
        .map(({ id, name, parentId, createdTime }) => ({ id, name, parentId, createdTime })),
    listFolderContents: async (folderId) =>
      live()
        .filter((n) => n.parentId === folderId)
        .map(({ id, name, isFolder, modifiedTime }) => ({ id, name, isFolder, modifiedTime })),
    moveItem: async (itemId, newParentId) => {
      byId.get(itemId)!.parentId = newParentId;
    },
    deleteFolder: async (folderId) => {
      if (live().some((n) => n.parentId === folderId)) {
        throw new Error(`deleteFolder on a folder that still holds items: ${folderId}`);
      }
      byId.delete(folderId);
    },
    trashFile: async (fileId) => {
      byId.get(fileId)!.trashed = true;
    }
  };
  /** Live file ids under `folderId`, by name. */
  const filesIn = (folderId: string) =>
    live()
      .filter((n) => n.parentId === folderId && !n.isFolder)
      .map((n) => `${n.name}#${n.id}`)
      .sort();
  const trashed = () =>
    [...byId.values()]
      .filter((n) => n.trashed)
      .map((n) => n.id)
      .sort();
  return { ops, filesIn, trashed };
}

const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString();

/** Two `mokuro-reader` roots: KEEP (older, canonical) and DUP. */
function twoRoots(files: Node[]) {
  return memoryDrive([
    { id: 'KEEP', name: 'mokuro-reader', parentId: 'DRIVE', isFolder: true, createdTime: at(0) },
    { id: 'DUP', name: 'mokuro-reader', parentId: 'DRIVE', isFolder: true, createdTime: at(5) },
    ...files
  ]);
}

const file = (id: string, parentId: string, name: string, modifiedTime?: string): Node => ({
  id,
  name,
  parentId,
  isFolder: false,
  modifiedTime
});

describe('FolderDeduplicator: same-named files when duplicate folders merge', () => {
  it("keeps the duplicate folder's copy when it is the newer one, and trashes the older", async () => {
    const drive = twoRoots([
      file('OLD', 'KEEP', 'profiles.json', at(10)),
      file('NEW', 'DUP', 'profiles.json', at(20))
    ]);

    await folderDeduplicator.deduplicateAll('mega', drive.ops);

    expect(drive.filesIn('KEEP')).toEqual(['profiles.json#NEW']);
    expect(drive.trashed()).toEqual(['OLD']);
  });

  it("trashes the duplicate folder's copy when it is the older one", async () => {
    const drive = twoRoots([
      file('NEW', 'KEEP', 'catalog.json', at(20)),
      file('OLD', 'DUP', 'catalog.json', at(10))
    ]);

    await folderDeduplicator.deduplicateAll('mega', drive.ops);

    expect(drive.filesIn('KEEP')).toEqual(['catalog.json#NEW']);
    expect(drive.trashed()).toEqual(['OLD']);
  });

  it('keeps the kept folder’s copy when either time is unknown or both are equal', async () => {
    const drive = twoRoots([
      file('K1', 'KEEP', 'a.cbz', at(10)),
      file('D1', 'DUP', 'a.cbz'),
      file('K2', 'KEEP', 'b.cbz', at(10)),
      file('D2', 'DUP', 'b.cbz', at(10))
    ]);

    await folderDeduplicator.deduplicateAll('mega', drive.ops);

    expect(drive.filesIn('KEEP')).toEqual(['a.cbz#K1', 'b.cbz#K2']);
    expect(drive.trashed()).toEqual(['D1', 'D2']);
  });

  it('keeps BOTH copies of volume-data.json and goals.json: sync folds every copy into one', async () => {
    const drive = twoRoots([
      file('VK', 'KEEP', 'volume-data.json', at(10)),
      file('VD', 'DUP', 'volume-data.json', at(20)),
      file('GK', 'KEEP', 'goals.json', at(20)),
      file('GD', 'DUP', 'goals.json', at(10))
    ]);

    await folderDeduplicator.deduplicateAll('mega', drive.ops);

    expect(drive.filesIn('KEEP')).toEqual([
      'goals.json#GD',
      'goals.json#GK',
      'volume-data.json#VD',
      'volume-data.json#VK'
    ]);
    expect(drive.trashed()).toEqual([]);
  });

  it('moves a file in beside a folder of the same name instead of trashing either', async () => {
    const drive = twoRoots([
      { id: 'FOLDER', name: 'Notes', parentId: 'KEEP', isFolder: true, createdTime: at(1) },
      file('FILE', 'DUP', 'Notes', at(30))
    ]);

    await folderDeduplicator.deduplicateAll('mega', drive.ops);

    expect(drive.filesIn('KEEP')).toEqual(['Notes#FILE']);
    expect(drive.trashed()).toEqual([]);
  });

  it('merges same-named series folders on the next pass, keeping every volume', async () => {
    const drive = memoryDrive([
      { id: 'KEEP', name: 'mokuro-reader', parentId: 'DRIVE', isFolder: true, createdTime: at(0) },
      { id: 'DUP', name: 'mokuro-reader', parentId: 'DRIVE', isFolder: true, createdTime: at(5) },
      { id: 'SK', name: 'Ippo', parentId: 'KEEP', isFolder: true, createdTime: at(1) },
      { id: 'SD', name: 'Ippo', parentId: 'DUP', isFolder: true, createdTime: at(6) },
      file('V1', 'SK', 'Ippo 01.cbz', at(2)),
      file('V2', 'SD', 'Ippo 02.cbz', at(7)),
      file('J1', 'SK', 'series.json', at(2)),
      file('J2', 'SD', 'series.json', at(8))
    ]);

    const result = await folderDeduplicator.deduplicateAll('mega', drive.ops);

    expect(result.groupsMerged).toBe(2);
    expect(drive.filesIn('SK')).toEqual(['Ippo 01.cbz#V1', 'Ippo 02.cbz#V2', 'series.json#J2']);
    expect(drive.trashed()).toEqual(['J1']);
  });
});
