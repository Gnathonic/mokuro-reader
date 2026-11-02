import { afterEach, describe, expect, it, vi } from 'vitest';

/** Breaks the keep-both rule for the control files, to test the guard behind it alone. */
const keepRule = vi.hoisted(() => ({ dropControlFiles: false }));
vi.mock('./syncable-file', async (importOriginal) => {
  const real = await importOriginal<typeof import('./syncable-file')>();
  return {
    ...real,
    dedupKeepsEveryCopy: (name: string) =>
      keepRule.dropControlFiles ? real.syncMergesEveryCopy(name) : real.dedupKeepsEveryCopy(name)
  };
});

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
      return true;
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
  afterEach(() => {
    keepRule.dropControlFiles = false;
  });

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

  it('keeps BOTH copies of the Bunko control files: Bunko reads every copy', async () => {
    const drive = twoRoots([
      file('MK', 'KEEP', '.mokuro-bunko.json', at(10)),
      file('MD', 'DUP', '.mokuro-bunko.json', at(20)),
      file('QK', 'KEEP', '.mokuro-queue.json', at(20)),
      file('QD', 'DUP', '.mokuro-queue.json', at(10))
    ]);

    await folderDeduplicator.deduplicateAll('mega', drive.ops);

    expect(drive.filesIn('KEEP')).toEqual([
      '.mokuro-bunko.json#MD',
      '.mokuro-bunko.json#MK',
      '.mokuro-queue.json#QD',
      '.mokuro-queue.json#QK'
    ]);
    expect(drive.trashed()).toEqual([]);
  });

  it('keeps BOTH copies of positions.json: positions sync folds every copy into one', async () => {
    const drive = twoRoots([
      file('PK', 'KEEP', 'positions.json', at(20)),
      file('PD', 'DUP', 'positions.json', at(10))
    ]);

    await folderDeduplicator.deduplicateAll('mega', drive.ops);

    expect(drive.filesIn('KEEP')).toEqual(['positions.json#PD', 'positions.json#PK']);
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

  it('never trashes a Bunko control file, even if the keep-both rule missed it', async () => {
    // The guard in front of every trash call, on its own: a newer duplicate
    // copy (MD) and an older one (QD) are both moved in instead.
    keepRule.dropControlFiles = true;
    const drive = twoRoots([
      file('MK', 'KEEP', '.mokuro-bunko.json', at(10)),
      file('MD', 'DUP', '.mokuro-bunko.json', at(20)),
      file('QK', 'KEEP', '.mokuro-queue.json', at(20)),
      file('QD', 'DUP', '.mokuro-queue.json', at(10)),
      file('PK', 'KEEP', 'profiles.json', at(10)),
      file('PD', 'DUP', 'profiles.json', at(20))
    ]);

    await folderDeduplicator.deduplicateAll('mega', drive.ops);

    expect(drive.filesIn('KEEP')).toEqual([
      '.mokuro-bunko.json#MD',
      '.mokuro-bunko.json#MK',
      '.mokuro-queue.json#QD',
      '.mokuro-queue.json#QK',
      'profiles.json#PD'
    ]);
    // Only the ordinary file's older copy went: the rule itself still works.
    expect(drive.trashed()).toEqual(['PK']);
  });
});

describe('FolderDeduplicator: which folder of a group is kept', () => {
  it('keeps the smaller id when the creation times are equal, whatever the listing order', async () => {
    for (const order of [
      ['B', 'A'],
      ['A', 'B']
    ]) {
      const drive = memoryDrive([
        ...order.map((id) => ({
          id,
          name: 'mokuro-reader',
          parentId: 'DRIVE',
          isFolder: true,
          createdTime: at(0)
        })),
        file('FA', 'A', 'a.cbz', at(1)),
        file('FB', 'B', 'b.cbz', at(1))
      ]);

      await folderDeduplicator.deduplicateAll('mega', drive.ops);

      expect(drive.filesIn('A')).toEqual(['a.cbz#FA', 'b.cbz#FB']);
      expect(drive.filesIn('B')).toEqual([]);
    }
  });

  it('never merges two roots under different parents', async () => {
    const drive = memoryDrive([
      { id: 'TOP', name: 'mokuro-reader', parentId: 'DRIVE', isFolder: true, createdTime: at(5) },
      { id: 'NEST', name: 'mokuro-reader', parentId: 'BACKUP', isFolder: true, createdTime: at(0) },
      file('F1', 'TOP', 'a.cbz', at(6)),
      file('F2', 'NEST', 'b.cbz', at(1))
    ]);

    const result = await folderDeduplicator.deduplicateAll('mega', drive.ops);

    expect(result.groupsMerged).toBe(0);
    expect(drive.filesIn('TOP')).toEqual(['a.cbz#F1']);
    expect(drive.filesIn('NEST')).toEqual(['b.cbz#F2']);
  });
});

describe('FolderDeduplicator: a duplicate folder the provider keeps', () => {
  /** A series folder in each root, with one volume each: a same-name group on pass 2. */
  const seriesInBothRoots = (name: string, keptId: string, dupId: string): Node[] => [
    { id: keptId, name, parentId: 'KEEP', isFolder: true, createdTime: at(1) },
    { id: dupId, name, parentId: 'DUP', isFolder: true, createdTime: at(2) },
    file(`${keptId}-v1`, keptId, 'v1.cbz', at(3)),
    file(`${dupId}-v2`, dupId, 'v2.cbz', at(3))
  ];

  it('counts a folder as deleted only when the provider says it removed it', async () => {
    const drive = twoRoots([file('F', 'DUP', 'a.cbz', at(1))]);
    const verdicts = [false, true];
    const ops: FolderOperations = {
      ...drive.ops,
      // Kept once (the server still listed something), removed on the next pass.
      deleteFolder: async (folderId) => {
        const removed = verdicts.shift()!;
        if (removed) await drive.ops.deleteFolder(folderId);
        return removed;
      }
    };

    const result = await folderDeduplicator.deduplicateAll('mega', ops);

    expect(result.foldersDeleted).toBe(1);
    expect(result.groupsMerged).toBe(2);
    expect(drive.filesIn('KEEP')).toEqual(['a.cbz#F']);
  });

  it('skips a group whose folder removal fails for the rest of the run, and still merges the others', async () => {
    const drive = twoRoots([
      ...seriesInBothRoots('Ippo', 'I1', 'I2'),
      ...seriesInBothRoots('Trigun', 'T1', 'T2')
    ]);
    const refused: string[] = [];
    const ops: FolderOperations = {
      ...drive.ops,
      deleteFolder: async (folderId) => {
        if (folderId === 'I2') {
          // What a provider throws on its second refusal: another device
          // keeps writing into this folder.
          refused.push(folderId);
          throw new Error(`duplicate folder ${folderId} still holds 1 item(s); stopping`);
        }
        await drive.ops.deleteFolder(folderId);
        return true;
      }
    };

    const result = await folderDeduplicator.deduplicateAll('mega', ops);

    // Pass 1 merged the roots; pass 2 gave up on Ippo but finished Trigun.
    expect(drive.filesIn('T1')).toEqual(['v1.cbz#T1-v1', 'v2.cbz#T2-v2']);
    expect((await ops.listFolders()).map((f) => f.id).sort()).toEqual(['I1', 'I2', 'KEEP', 'T1']);
    // Given up once, not retried on every remaining pass.
    expect(refused).toEqual(['I2']);
    expect(result.foldersDeleted).toBe(2);
    expect(result.groupsMerged).toBe(2);
  });
});
