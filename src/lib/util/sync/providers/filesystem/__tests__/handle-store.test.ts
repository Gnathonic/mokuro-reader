import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { saveRootHandle, loadRootHandle, clearRootHandle } from '../handle-store';

// Minimal fake that satisfies structured clone
function makeFakeHandle(name: string): FileSystemDirectoryHandle {
  return {
    kind: 'directory' as const,
    name
    // structured-clonable no-op methods not required for the test;
    // fake-indexeddb only needs the object to be structured-clonable
  } as unknown as FileSystemDirectoryHandle;
}

describe('handle-store', () => {
  beforeEach(async () => {
    // Reset the fake IDB for each test
    const { IDBFactory } = await import('fake-indexeddb');
    // @ts-expect-error — replace globally for isolation
    globalThis.indexedDB = new IDBFactory();
  });

  it('returns null when no handle has been saved', async () => {
    expect(await loadRootHandle()).toBeNull();
  });

  it('round-trips a saved handle', async () => {
    const handle = makeFakeHandle('Pictures');
    await saveRootHandle(handle);
    const loaded = await loadRootHandle();
    expect(loaded).not.toBeNull();
    expect(loaded?.name).toBe('Pictures');
  });

  it('overwrites the previous handle on re-save', async () => {
    await saveRootHandle(makeFakeHandle('First'));
    await saveRootHandle(makeFakeHandle('Second'));
    const loaded = await loadRootHandle();
    expect(loaded?.name).toBe('Second');
  });

  it('clears a saved handle', async () => {
    await saveRootHandle(makeFakeHandle('Pictures'));
    await clearRootHandle();
    expect(await loadRootHandle()).toBeNull();
  });

  it('clear is idempotent when nothing is stored', async () => {
    await expect(clearRootHandle()).resolves.toBeUndefined();
  });
});
