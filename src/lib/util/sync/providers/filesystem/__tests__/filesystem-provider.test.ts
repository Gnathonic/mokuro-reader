import { describe, it, expect, beforeEach, vi } from 'vitest';

// Constructor should not attempt to restore a stored handle in tests.
vi.mock('$app/environment', () => ({ browser: false }));

import { FilesystemProvider } from '../filesystem-provider';
import { ProviderError } from '../../../provider-interface';
import {
  refreshCloudBunkoMarker,
  resetCloudBunkoMarkersForTest
} from '$lib/catalog/cloud-bunko-marker';
import { servedMarker } from '$lib/catalog/__fixtures__/bunko-marker';

// ---------------------------------------------------------------------------
// Minimal in-memory File System Access API fake (just enough for the provider:
// getDirectoryHandle / getFileHandle / removeEntry / values / createWritable).
// ---------------------------------------------------------------------------
let clock = 1000;

function notFound(name: string): Error {
  const e = new Error(`A requested entry was not found: ${name}`);
  e.name = 'NotFoundError';
  return e;
}

function typeMismatch(message: string): Error {
  const e = new Error(`TypeMismatch: ${message}`);
  e.name = 'TypeMismatchError';
  return e;
}

class FakeWritable {
  private parts: BlobPart[] = [];
  constructor(private handle: FakeFileHandle) {}
  async write(data: BlobPart) {
    this.parts.push(data);
  }
  async close() {
    this.handle._blob = new Blob(this.parts);
    this.handle._lastModified = clock++;
  }
}

class FakeFileHandle {
  readonly kind = 'file' as const;
  _blob: Blob = new Blob([]);
  _lastModified = clock++;
  constructor(public name: string) {}
  async getFile(): Promise<File> {
    return new File([this._blob], this.name, { lastModified: this._lastModified });
  }
  async createWritable() {
    // Real createWritable truncates existing content by default.
    this._blob = new Blob([]);
    return new FakeWritable(this);
  }
}

class FakeDirHandle {
  readonly kind = 'directory' as const;
  children = new Map<string, FakeDirHandle | FakeFileHandle>();
  constructor(public name: string) {}
  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    let h = this.children.get(name);
    if (!h) {
      if (!opts?.create) throw notFound(name);
      h = new FakeDirHandle(name);
      this.children.set(name, h);
    }
    if (h.kind !== 'directory') throw typeMismatch(`${name} is a file`);
    return h;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }) {
    let h = this.children.get(name);
    if (!h) {
      if (!opts?.create) throw notFound(name);
      h = new FakeFileHandle(name);
      this.children.set(name, h);
    }
    if (h.kind !== 'file') throw typeMismatch(`${name} is a directory`);
    return h;
  }
  async removeEntry(name: string, _opts?: { recursive?: boolean }) {
    if (!this.children.has(name)) throw notFound(name);
    this.children.delete(name);
  }
  async *values() {
    yield* this.children.values();
  }
}

async function seedFile(root: FakeDirHandle, path: string, content: string) {
  const segments = path.split('/');
  const filename = segments.pop() as string;
  let dir = root;
  for (const s of segments) dir = await dir.getDirectoryHandle(s, { create: true });
  const fh = await dir.getFileHandle(filename, { create: true });
  const w = await fh.createWritable();
  await w.write(new Blob([content]));
  await w.close();
}

function makeProvider(root: FakeDirHandle): FilesystemProvider {
  const provider = new FilesystemProvider();
  // Inject the fake root directly (private field, set via cast for the test).
  (provider as unknown as { rootHandle: FileSystemDirectoryHandle }).rootHandle =
    root as unknown as FileSystemDirectoryHandle;
  return provider;
}

describe('FilesystemProvider.renameFolder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('moves files and removes the old folder on a normal rename', async () => {
    const root = new FakeDirHandle('');
    await seedFile(root, 'Naruto/v1.cbz', 'NARUTO-V1');
    const provider = makeProvider(root);

    await provider.renameFolder('Naruto', 'Boruto');

    const paths = (await provider.listCloudVolumes()).map((v) => v.path);
    expect(paths).toContain('Boruto/v1.cbz');
    expect(paths).not.toContain('Naruto/v1.cbz');
    expect(root.children.has('Naruto')).toBe(false);
  });

  it('does not destroy data when the new path nests under the old folder', async () => {
    const content = 'NARUTO-V1';
    const expectedSize = new Blob([content]).size;
    const root = new FakeDirHandle('');
    await seedFile(root, 'Naruto/v1.cbz', content);
    const provider = makeProvider(root);

    // e.g. a user renames series "Naruto" to "Naruto/Archive" (free-text input).
    await provider.renameFolder('Naruto', 'Naruto/Archive');

    const vols = await provider.listCloudVolumes();
    const moved = vols.find((v) => v.path === 'Naruto/Archive/v1.cbz');
    expect(moved, 'the renamed file must still exist').toBeDefined();

    // ...and its bytes must be intact (not truncated/destroyed by the cleanup
    // that, with the bug, recursively deleted the whole old folder).
    expect(moved!.size).toBe(expectedSize);
  });
});

function notAllowed(): Error {
  const e = new Error('The request is not allowed');
  e.name = 'NotAllowedError';
  return e;
}

describe('error classification', () => {
  it('converts NotFoundError to a typed NOT_FOUND ProviderError with a sniffable message', async () => {
    const root = new FakeDirHandle('');
    const provider = makeProvider(root);

    const err = await provider
      .downloadFile({
        provider: 'filesystem',
        fileId: 'S/v.cbz',
        path: 'S/v.cbz',
        modifiedTime: '',
        size: 1
      })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toMatch(/not found/i);
  });

  it('converts NotAllowedError to isAuthError and flips into needs-reconnect state', async () => {
    const root = new FakeDirHandle('');
    root.getFileHandle = vi.fn().mockRejectedValue(notAllowed());
    const provider = makeProvider(root);
    (provider as unknown as { hasStoredHandle: boolean }).hasStoredHandle = true;

    const err = await provider
      .downloadFile({
        provider: 'filesystem',
        fileId: 'v.cbz',
        path: 'v.cbz',
        modifiedTime: '',
        size: 1
      })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect(err.isAuthError).toBe(true);
    expect(provider.isAuthenticated()).toBe(false);
    expect(provider.getStatus().needsAttention).toBe(true);
  });

  it('converts deleteFile NotFoundError to the typed NOT_FOUND consumed by idempotent deletes', async () => {
    const root = new FakeDirHandle('');
    const provider = makeProvider(root);

    const err = await provider
      .deleteFile({
        provider: 'filesystem',
        fileId: 'S/v.cbz',
        path: 'S/v.cbz',
        modifiedTime: '',
        size: 1
      })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe('NOT_FOUND');
  });
});

describe('renameFile idempotency', () => {
  it('treats source-gone + matching destination as an already-completed rename', async () => {
    const root = new FakeDirHandle('');
    await seedFile(root, 'B/v.cbz', '42-bytes-content-simulated-here-abcdefghi'); // 41 chars
    const destSize = new Blob(['42-bytes-content-simulated-here-abcdefghi']).size;
    const provider = makeProvider(root);

    const result = await provider.renameFile(
      {
        provider: 'filesystem',
        fileId: 'A/v.cbz',
        path: 'A/v.cbz',
        modifiedTime: '',
        size: destSize
      },
      'B/v.cbz'
    );

    expect(result.path).toBe('B/v.cbz');
    expect(result.size).toBe(destSize);
  });

  it('still throws typed NOT_FOUND when the source is gone and no matching destination exists', async () => {
    const root = new FakeDirHandle('');
    const provider = makeProvider(root);

    const err = await provider
      .renameFile(
        {
          provider: 'filesystem',
          fileId: 'A/v.cbz',
          path: 'A/v.cbz',
          modifiedTime: '',
          size: 42
        },
        'B/v.cbz'
      )
      .catch((e) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe('NOT_FOUND');
  });

  it('does not converge on a destination whose size differs from the source record', async () => {
    const root = new FakeDirHandle('');
    await seedFile(root, 'B/v.cbz', 'different-length-content');
    const provider = makeProvider(root);

    const err = await provider
      .renameFile(
        {
          provider: 'filesystem',
          fileId: 'A/v.cbz',
          path: 'A/v.cbz',
          modifiedTime: '',
          size: 99999
        },
        'B/v.cbz'
      )
      .catch((e) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe('NOT_FOUND');
  });
});

describe('getStorageQuota', () => {
  it('returns the unavailable shape — origin estimate is not folder disk space', async () => {
    const provider = makeProvider(new FakeDirHandle(''));
    await expect(provider.getStorageQuota()).resolves.toEqual({
      used: 0,
      total: null,
      available: null
    });
  });
});

describe('removeDirectoryIfEmpty', () => {
  it('removes an empty directory non-recursively', async () => {
    const root = new FakeDirHandle('');
    await root.getDirectoryHandle('Old Series', { create: true });
    const removeSpy = vi.spyOn(root, 'removeEntry');
    const provider = makeProvider(root);

    await provider.removeDirectoryIfEmpty('Old Series');

    expect(removeSpy).toHaveBeenCalledWith('Old Series');
    expect(root.children.has('Old Series')).toBe(false);
  });

  it('keeps a directory that still has entries', async () => {
    const root = new FakeDirHandle('');
    await seedFile(root, 'Old Series/v.cbz', 'DATA');
    const removeSpy = vi.spyOn(root, 'removeEntry');
    const provider = makeProvider(root);

    await provider.removeDirectoryIfEmpty('Old Series');

    expect(removeSpy).not.toHaveBeenCalled();
    expect(root.children.has('Old Series')).toBe(true);
  });

  it('is best-effort: swallows a missing directory', async () => {
    const provider = makeProvider(new FakeDirHandle(''));
    await expect(provider.removeDirectoryIfEmpty('Old Series')).resolves.toBeUndefined();
  });
});

describe('FilesystemProvider.getStatus metadata gates', () => {
  it('states the two metadata flags explicitly instead of leaving them undefined', () => {
    // `series.json` / `catalog.json` writing gates on these. Omitting them
    // reads as "not read-only, not server-compiled" by accident rather than by
    // decision — and the next gate added would default the other way.
    const provider = makeProvider(new FakeDirHandle(''));
    const status = provider.getStatus();

    // The picker asks for `readwrite` and a restored handle is only adopted
    // when that permission is already granted, so a connected folder is
    // writable by construction.
    expect(status.isReadOnly).toBe(false);
    // No server on the other end of a local folder — this client compiles both.
    expect(status.serverCompilesMetadata).toBe(false);
  });

  it('keeps the flags set while disconnected, so the gates never read undefined', () => {
    const status = new FilesystemProvider().getStatus();

    expect(status.isAuthenticated).toBe(false);
    expect(status.isReadOnly).toBe(false);
    expect(status.serverCompilesMetadata).toBe(false);
  });

  it('is `filesystem:<folder name>` once a folder is connected', () => {
    const provider = makeProvider(new FakeDirHandle('my-manga-library'));

    expect(provider.getStatus().accountScope).toBe('filesystem:my-manga-library');
  });

  it('is undefined before any folder is connected', () => {
    const status = new FilesystemProvider().getStatus();

    expect(status.accountScope).toBeUndefined();
  });
});

describe('FilesystemProvider.statFile (conditional root-file reads)', () => {
  it('stats the file without reading it: lastModified and size, as the listing reports them', async () => {
    const root = new FakeDirHandle('');
    await seedFile(root, 'volume-data.json', '{"a":1}');
    const provider = makeProvider(root);
    const [listed] = await provider.listCloudVolumes();
    expect(await provider.statFile(listed)).toEqual({
      size: listed.size,
      modifiedTime: listed.modifiedTime
    });
  });

  it('moves with a write; a gone file is null', async () => {
    const root = new FakeDirHandle('');
    await seedFile(root, 'volume-data.json', '{"a":1}');
    const provider = makeProvider(root);
    const [listed] = await provider.listCloudVolumes();
    const before = await provider.statFile(listed);
    const uploaded = await provider.uploadFile('volume-data.json', new Blob(['{"a":2}']));
    const after = await provider.statFile(listed);
    expect(after).not.toEqual(before);
    // The upload receipt is the stamp the next stat reports.
    expect(after).toEqual({ size: uploaded.size, modifiedTime: uploaded.modifiedTime });

    await provider.deleteFile(listed);
    expect(await provider.statFile(listed)).toBeNull();
  });
});

describe('FilesystemProvider.readControlFile (a Bunko managing the folder)', () => {
  beforeEach(() => {
    localStorage.clear();
    resetCloudBunkoMarkersForTest();
  });

  it('is null when the folder has no such file, or a folder of that name', async () => {
    const root = new FakeDirHandle('manga');
    const provider = makeProvider(root);
    expect(await provider.readControlFile('.mokuro-bunko.json')).toBeNull();
    await root.getDirectoryHandle('.mokuro-queue.json', { create: true });
    expect(await provider.readControlFile('.mokuro-queue.json')).toBeNull();
  });

  it('reads the root file as one node, versioned by lastModified and size', async () => {
    const root = new FakeDirHandle('manga');
    await seedFile(root, '.mokuro-queue.json', '{"version":1}');
    const provider = makeProvider(root);
    const result = await provider.readControlFile('.mokuro-queue.json');
    if (!result || result === 'not-modified') throw new Error('expected nodes');
    const file = await (await root.getFileHandle('.mokuro-queue.json')).getFile();
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({
      id: '.mokuro-queue.json',
      etag: `${file.lastModified}:${file.size}`,
      modified: new Date(file.lastModified).toISOString()
    });
    expect(await result.nodes[0].blob.text()).toBe('{"version":1}');
  });

  it("answers 'not-modified' while lastModified:size is unchanged, without reading the bytes", async () => {
    const root = new FakeDirHandle('manga');
    await seedFile(root, '.mokuro-queue.json', '{"version":1}');
    const provider = makeProvider(root);
    const first = await provider.readControlFile('.mokuro-queue.json');
    if (!first || first === 'not-modified') throw new Error('expected nodes');
    const arrayBuffer = vi.spyOn(Blob.prototype, 'arrayBuffer');
    try {
      expect(
        await provider.readControlFile('.mokuro-queue.json', { ifNoneMatch: first.etag })
      ).toBe('not-modified');
      // A stat only: the bytes are not read again.
      expect(arrayBuffer).not.toHaveBeenCalled();
    } finally {
      arrayBuffer.mockRestore();
    }
  });

  it('reads again after the file changed', async () => {
    const root = new FakeDirHandle('manga');
    await seedFile(root, '.mokuro-queue.json', '{"version":1}');
    const provider = makeProvider(root);
    const first = await provider.readControlFile('.mokuro-queue.json');
    if (!first || first === 'not-modified') throw new Error('expected nodes');
    // Bunko writes its next version (a rename over the old one: new mtime).
    await seedFile(root, '.mokuro-queue.json', '{"version":1,"held":null}');
    const second = await provider.readControlFile('.mokuro-queue.json', {
      ifNoneMatch: first.etag
    });
    if (!second || second === 'not-modified') throw new Error('expected nodes');
    expect(second.etag).not.toBe(first.etag);
    expect(await second.nodes[0].blob.text()).toBe('{"version":1,"held":null}');
  });

  describe('in a series folder ({ folder })', () => {
    const SQ = '.mokuro-series-queue.json';

    it('reads <folder>/<name> by handle: one node, its id the path, versioned by lastModified:size', async () => {
      const root = new FakeDirHandle('manga');
      await seedFile(root, `Example Saga/${SQ}`, '{"v":2}');
      await seedFile(root, SQ, '{"root":true}');
      const provider = makeProvider(root);

      const result = await provider.readControlFile(SQ, { folder: 'Example Saga' });
      if (!result || result === 'not-modified') throw new Error('expected nodes');
      const dir = await root.getDirectoryHandle('Example Saga');
      const file = await (await dir.getFileHandle(SQ)).getFile();
      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0]).toMatchObject({
        id: `Example Saga/${SQ}`,
        etag: `${file.lastModified}:${file.size}`
      });
      expect(await result.nodes[0].blob.text()).toBe('{"v":2}');

      // The root file of the same name is its own read.
      const atRoot = await provider.readControlFile(SQ);
      if (!atRoot || atRoot === 'not-modified') throw new Error('expected nodes');
      expect(await atRoot.nodes[0].blob.text()).toBe('{"root":true}');

      const arrayBuffer = vi.spyOn(Blob.prototype, 'arrayBuffer');
      try {
        expect(
          await provider.readControlFile(SQ, { folder: 'Example Saga', ifNoneMatch: result.etag })
        ).toBe('not-modified');
        expect(arrayBuffer).not.toHaveBeenCalled();
      } finally {
        arrayBuffer.mockRestore();
      }
    });

    it('finds the folder by its folded name when no folder has the exact one — every match', async () => {
      const root = new FakeDirHandle('manga');
      await seedFile(root, `Example Saga/${SQ}`, '{"rev":1}');
      await seedFile(root, `EXAMPLE SAGA/${SQ}`, '{"rev":2}');
      await seedFile(root, `Other Saga/${SQ}`, '{"rev":3}');
      const provider = makeProvider(root);

      const result = await provider.readControlFile(SQ, { folder: 'example saga' });
      if (!result || result === 'not-modified') throw new Error('expected nodes');
      expect(result.nodes.map((n) => n.id).sort()).toEqual([
        `EXAMPLE SAGA/${SQ}`,
        `Example Saga/${SQ}`
      ]);

      // An exact name is the one lookup (a case-insensitive disk has no other).
      const exact = await provider.readControlFile(SQ, { folder: 'Example Saga' });
      if (!exact || exact === 'not-modified') throw new Error('expected nodes');
      expect(exact.nodes.map((n) => n.id)).toEqual([`Example Saga/${SQ}`]);
    });

    it('is null for a missing folder or file, a file in the folder’s place, and a name that is no one folder', async () => {
      const root = new FakeDirHandle('manga');
      await seedFile(root, 'Empty Saga/Vol 1.cbz', 'CBZ');
      await seedFile(root, 'Not A Folder', 'x');
      await seedFile(root, `Example Saga/${SQ}`, '{"v":2}');
      const provider = makeProvider(root);

      expect(await provider.readControlFile(SQ, { folder: 'Missing' })).toBeNull();
      expect(await provider.readControlFile(SQ, { folder: 'Empty Saga' })).toBeNull();
      expect(await provider.readControlFile(SQ, { folder: 'Not A Folder' })).toBeNull();
      const lookups = vi.spyOn(root, 'getDirectoryHandle');
      for (const folder of ['', '.', '..', 'Example Saga/..', 'Example Saga/Sub']) {
        expect(await provider.readControlFile(SQ, { folder })).toBeNull();
      }
      expect(lookups).not.toHaveBeenCalled();
    });
  });

  it('a revoked permission is an auth error', async () => {
    const root = new FakeDirHandle('manga');
    const provider = makeProvider(root);
    vi.spyOn(root, 'getFileHandle').mockRejectedValue(notAllowed());
    const error = await provider.readControlFile('.mokuro-bunko.json').catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).isAuthError).toBe(true);
  });

  it('a fresh marker in the folder turns serverCompilesMetadata on, as on Drive', async () => {
    const now = Date.now();
    const root = new FakeDirHandle('manga');
    await seedFile(root, '.mokuro-bunko.json', JSON.stringify(servedMarker(now)));
    const provider = makeProvider(root);
    expect(provider.getStatus().serverCompilesMetadata).toBe(false);

    expect(await refreshCloudBunkoMarker(provider)).toBe(true);

    const status = provider.getStatus();
    expect(status.serverCompilesMetadata).toBe(true);
    expect(status.cloudBunko?.fresh).toBe(true);
  });
});
