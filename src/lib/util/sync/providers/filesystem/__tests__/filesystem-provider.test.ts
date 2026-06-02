import { describe, it, expect, beforeEach, vi } from 'vitest';

// Constructor should not attempt to restore a stored handle in tests.
vi.mock('$app/environment', () => ({ browser: false }));

import { FilesystemProvider } from '../filesystem-provider';

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
    if (h.kind !== 'directory') throw new Error(`TypeMismatch: ${name} is a file`);
    return h;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }) {
    let h = this.children.get(name);
    if (!h) {
      if (!opts?.create) throw notFound(name);
      h = new FakeFileHandle(name);
      this.children.set(name, h);
    }
    if (h.kind !== 'file') throw new Error(`TypeMismatch: ${name} is a directory`);
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
