import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted: state that the vi.mock factory can close over without TDZ issues.
// The factory must NOT reference any module-level imports (they'd be in TDZ when
// the factory is registered), so we use vi.hoisted for shared mutable state and
// implement EventEmitter inline to avoid importing 'events'.
const state = vi.hoisted(() => ({
  lastFileOpts: null as any,
  fileNodeIdAfterConstruct: null as any,
  chunks: [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]
}));

vi.mock('megajs', () => {
  // Minimal EventEmitter — no external import needed inside a hoisted factory.
  class SimpleEmitter {
    private _h: Record<string, Array<(...args: any[]) => void>> = {};
    on(event: string, fn: (...args: any[]) => void) {
      (this._h[event] ??= []).push(fn);
      return this;
    }
    emit(event: string, ...args: any[]) {
      (this._h[event] ?? []).forEach((h) => h(...args));
      return true;
    }
  }

  class MockStorage {
    api: any = { sid: null };
    constructor(_opts: any) {}
  }

  class MockFile extends SimpleEmitter {
    nodeId: any = null;
    constructor(opts: any) {
      super();
      state.lastFileOpts = opts;
    }
    download() {
      state.fileNodeIdAfterConstruct = this.nodeId;
      const stream = new SimpleEmitter() as any;
      queueMicrotask(() => {
        let loaded = 0;
        for (const c of state.chunks) {
          loaded += c.length;
          stream.emit('data', c);
          stream.emit('progress', { bytesLoaded: loaded, bytesTotal: 5 });
        }
        stream.emit('end');
      });
      return stream;
    }
  }

  return { Storage: MockStorage, File: MockFile };
});

import { megaCore, isImageUpload, resolveSeriesUploadFolder } from './mega-core';

describe('resolveSeriesUploadFolder (no duplicate series folders)', () => {
  function makeStorage(opts: { files?: any; rootChildren?: any[]; reloadAdds?: any } = {}) {
    const storage: any = {
      files: { ...(opts.files ?? {}) },
      root: {
        children: opts.rootChildren ?? [],
        mkdir: vi.fn(async (name: string) => ({
          name,
          directory: true,
          children: [],
          mkdir: vi.fn(async (n: string) => ({ name: n, directory: true, children: [] }))
        }))
      },
      reload: vi.fn(async () => {
        Object.assign(storage.files, opts.reloadAdds ?? {});
      })
    };
    return storage;
  }

  it('returns the folder by id without reload or mkdir when already in the tree', async () => {
    const folder = { nodeId: 'F1', name: 'S', directory: true };
    const storage = makeStorage({ files: { F1: folder } });
    const result = await resolveSeriesUploadFolder(storage, 'F1', 'S');
    expect(result).toBe(folder);
    expect(storage.reload).not.toHaveBeenCalled();
    expect(storage.root.mkdir).not.toHaveBeenCalled();
  });

  it('reloads once to find a folder created after the cached tree, never mkdir', async () => {
    const folder = { nodeId: 'F1', name: 'S', directory: true };
    const storage = makeStorage({ files: {}, reloadAdds: { F1: folder } });
    const result = await resolveSeriesUploadFolder(storage, 'F1', 'S');
    expect(storage.reload).toHaveBeenCalledWith(true);
    expect(result).toBe(folder);
    expect(storage.root.mkdir).not.toHaveBeenCalled();
  });

  it('falls back to finding an existing folder by name when no id is provided', async () => {
    const seriesFolder = { name: 'S', directory: true };
    const mokuro = { name: 'mokuro-reader', directory: true, children: [seriesFolder] };
    const storage = makeStorage({ rootChildren: [mokuro] });
    const result = await resolveSeriesUploadFolder(storage, undefined, 'S');
    expect(result).toBe(seriesFolder);
    expect(storage.root.mkdir).not.toHaveBeenCalled();
  });

  it('only creates folders by name in the legacy no-id path', async () => {
    const storage = makeStorage({ rootChildren: [] });
    await resolveSeriesUploadFolder(storage, undefined, 'New Series');
    expect(storage.root.mkdir).toHaveBeenCalledWith('mokuro-reader');
  });
});

describe('isImageUpload (MEGA thumbnail eligibility)', () => {
  it('detects images by mime type', () => {
    expect(isImageUpload('image/webp', 'cover.bin')).toBe(true);
    expect(isImageUpload('image/jpeg', 'x')).toBe(true);
  });
  it('detects images by filename extension when mime is missing/generic', () => {
    expect(isImageUpload(undefined, 'thumb.webp')).toBe(true);
    expect(isImageUpload('application/octet-stream', 'thumb.PNG')).toBe(true);
  });
  it('rejects non-images (cbz, json)', () => {
    expect(isImageUpload('application/x-cbz', 'Vol 1.cbz')).toBe(false);
    expect(isImageUpload('application/json', 'volume-data.json')).toBe(false);
    expect(isImageUpload(undefined, 'series.mokuro')).toBe(false);
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  state.lastFileOpts = null;
  state.fileNodeIdAfterConstruct = null;
  state.chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
});

describe('megaCore.downloadFile() (Phase 2)', () => {
  it('builds an owned-node File (downloadId+key+api) and forces file.nodeId', async () => {
    const onProgress = vi.fn();
    const buf = await megaCore.downloadFile({
      fileId: 'node1',
      credentials: { sid: 'SID123', nodeId: 'node1', fileKey: '____' },
      onProgress
    } as any);

    expect(state.lastFileOpts.downloadId).toBe('node1');
    expect(state.lastFileOpts.key).toBe('____');
    expect(state.lastFileOpts.api.sid).toBe('SID123');
    expect(state.fileNodeIdAfterConstruct).toBe('node1'); // owned-node path forced
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect(onProgress).toHaveBeenLastCalledWith(5, 5);
  });
});
