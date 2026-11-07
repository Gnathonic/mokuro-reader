import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudFileMetadata, SyncProvider } from './provider-interface';

const quickMergeVolumeData = vi.hoisted(() => vi.fn(async () => true));
vi.mock('./unified-sync-service', () => ({
  unifiedSyncService: { quickMergeVolumeData }
}));
const probePositions = vi.hoisted(() =>
  vi.fn(async () => ({ adopted: ['v'], deferred: [], uploaded: false }))
);
vi.mock('$lib/positions/positions-sync', () => ({ probePositions }));
const importHistory = vi.hoisted(() =>
  vi.fn(async (_provider: unknown, _listing: CloudFileMetadata[], _db: unknown) => 7)
);
vi.mock('$lib/reading-history/history-sync', () => ({ importHistory }));
vi.mock('$lib/reading-history/history-db', () => ({ historyDb: () => ({}) }));

import { _resetQuickSyncForTests, runQuickSync } from './quick-sync';

const entry = (path: string) =>
  ({
    provider: 'webdav',
    fileId: `/mokuro-reader/${path}`,
    path,
    modifiedTime: '',
    size: 1
  }) as CloudFileMetadata;

function provider(status: Record<string, unknown> = {}, extra: Partial<SyncProvider> = {}) {
  return {
    type: 'webdav',
    name: 'WebDAV',
    getStatus: () => ({ isAuthenticated: true, ...status }),
    readRootFileCopies: vi.fn(async () => []),
    listFolder: vi.fn(async () => [entry('history/dev-a/2026-10.events'), entry('history/x.txt')]),
    uploadFile: vi.fn(),
    deleteFile: vi.fn(),
    ...extra
  } as unknown as SyncProvider & { listFolder: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetQuickSyncForTests();
});

describe('runQuickSync', () => {
  it('runs progress, positions and history together, read-only', async () => {
    const p = provider();
    const report = await runQuickSync(p);
    expect(report).toMatchObject({ progress: 'merged', positions: 1, history: 7 });
    expect(quickMergeVolumeData).toHaveBeenCalledWith(p);
    expect(probePositions).toHaveBeenCalledWith(p);
    expect(p.listFolder).toHaveBeenCalledWith('history');
    // Only real history paths reach the import.
    expect(importHistory.mock.calls[0][1].map((f: CloudFileMetadata) => f.path)).toEqual([
      'history/dev-a/2026-10.events'
    ]);
    expect(p.uploadFile).not.toHaveBeenCalled();
    expect(p.deleteFile).not.toHaveBeenCalled();
  });

  it('history stays off where the server cannot keep it per user (bunko < 0.7.8)', async () => {
    const p = provider({ serverCompilesMetadata: true });
    expect((await runQuickSync(p)).history).toBe('off');
    expect(p.listFolder).not.toHaveBeenCalled();
  });

  it('one half failing never stops the others', async () => {
    quickMergeVolumeData.mockRejectedValueOnce(new Error('offline'));
    const report = await runQuickSync(provider());
    expect(report).toMatchObject({ progress: 'failed', positions: 1, history: 7 });
  });

  it('a run in flight answers a second request', async () => {
    const p = provider();
    const [a, b] = [runQuickSync(p), runQuickSync(p)];
    expect(await a).toBe(await b);
    expect(quickMergeVolumeData).toHaveBeenCalledTimes(1);
  });

  it('a provider without the quick verbs reports so', async () => {
    const p = provider({}, { readRootFileCopies: undefined, listFolder: undefined });
    expect(await runQuickSync(p)).toMatchObject({
      progress: 'unsupported',
      history: 'unsupported'
    });
  });
});
