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

import { megaCore } from './mega-core';

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
