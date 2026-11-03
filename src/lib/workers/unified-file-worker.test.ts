/**
 * The Worker's backup wiring (`compress-from-db` to a cloud provider), driven
 * through its real message handler: WebDAV/bunko backups only ever take this
 * path, so the order the files go up in — and which layers the main thread
 * is told were sent — is pinned here, not only in `volume-upload-order.ts`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const uploadFile = vi.fn();
const generateVolumeSidecarsFromDb = vi.fn();

vi.mock('$lib/util/compress-volume', () => ({
  compressVolume: vi.fn(),
  compressVolumeFromDb: vi.fn(async () => new Blob(['zip'], { type: 'application/x-cbz' })),
  generateVolumeSidecarsFromDb: (...args: unknown[]) => generateVolumeSidecarsFromDb(...args)
}));

vi.mock('./cloud-providers', () => ({
  getWorkerCloudProvider: () => ({ uploadFile, downloadFile: vi.fn() })
}));

const layer = (layerId: string) => ({
  layerId,
  filename: `Vol 1.${layerId}.mokuro`,
  blob: new Blob([`{"${layerId}":1}`], { type: 'application/json' }),
  updatedAt: `t-${layerId}`
});

function sidecars() {
  return {
    mokuro: { filename: 'Vol 1.mokuro', blob: new Blob(['{}'], { type: 'application/json' }) },
    thumbnail: { filename: 'Vol 1.webp', blob: new Blob(['img'], { type: 'image/webp' }) },
    layers: [layer('gcv'), layer('edit')]
  };
}

const posted: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  vi.spyOn(self, 'postMessage').mockImplementation(((message: Record<string, unknown>) => {
    posted.push(message);
  }) as typeof self.postMessage);
  await import('./unified-file-worker');
});

beforeEach(() => {
  posted.length = 0;
  uploadFile.mockReset();
  uploadFile.mockImplementation(async ({ filename }: { filename: string }) => ({
    fileId: `id:${filename}`,
    modifiedTime: '2026-10-30T00:00:00.000Z'
  }));
  generateVolumeSidecarsFromDb.mockReset();
  generateVolumeSidecarsFromDb.mockResolvedValue(sidecars());
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.mocked(console.log).mockRestore();
  vi.mocked(console.warn).mockRestore();
});

async function backup(): Promise<Record<string, unknown>> {
  self.dispatchEvent(
    new MessageEvent('message', {
      data: {
        mode: 'compress-from-db',
        provider: 'webdav',
        volumeUuid: 'v1',
        volumeTitle: 'Vol 1',
        seriesTitle: 'Series',
        credentials: { serverUrl: 'https://host', username: 'a', password: 'p' },
        includeSidecars: true,
        serverCompilesMetadata: true,
        editLayerSync: 'push',
        accountScope: 'webdav:https://host|a'
      }
    })
  );
  await vi.waitFor(() => {
    expect(posted.some((m) => m.type === 'complete' || m.type === 'error')).toBe(true);
  });
  return posted.find((m) => m.type === 'complete' || m.type === 'error')!;
}

const sentNames = () => uploadFile.mock.calls.map(([args]) => args.filename);

describe('unified-file-worker compress-from-db backup', () => {
  it('sends the edit layer after the archive it is anchored on', async () => {
    const done = await backup();
    expect(done.type).toBe('complete');
    expect(sentNames()).toEqual([
      'Vol 1.mokuro',
      'Vol 1.gcv.mokuro',
      'Vol 1.webp',
      'Vol 1.cbz',
      'Vol 1.edit.mokuro'
    ]);
    expect(done.layerSnapshots).toEqual([
      { layerId: 'gcv', updatedAt: 't-gcv', size: layer('gcv').blob.size },
      { layerId: 'edit', updatedAt: 't-edit', size: layer('edit').blob.size }
    ]);
  });

  it('builds the layer sidecars for the provider it uploads to', async () => {
    // A server OCR pulled from bunko is kept off that provider by its
    // `cloud.server_compiled` mark, which only counts on the provider named.
    await backup();
    expect(generateVolumeSidecarsFromDb).toHaveBeenCalledWith(
      'v1',
      undefined,
      expect.objectContaining({ provider: 'webdav', cloud: true })
    );
  });

  it('reports only the layers that went up: a refused edit layer stays unstamped', async () => {
    uploadFile.mockImplementation(async ({ filename }: { filename: string }) => {
      if (filename === 'Vol 1.edit.mokuro') throw new Error('409 no-volume');
      return { fileId: `id:${filename}` };
    });
    const done = await backup();
    expect(done.type).toBe('complete');
    expect(done.fileId).toBe('id:Vol 1.cbz');
    expect(done.layerSnapshots).toEqual([
      { layerId: 'gcv', updatedAt: 't-gcv', size: layer('gcv').blob.size }
    ]);
  });

  it('a layer the server refuses (403) before the archive does not fail the backup', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    uploadFile.mockImplementation(async ({ filename }: { filename: string }) => {
      if (filename === 'Vol 1.gcv.mokuro') {
        throw Object.assign(new Error('WebDAV upload failed: 403 Forbidden'), { status: 403 });
      }
      return { fileId: `id:${filename}` };
    });
    const done = await backup();
    expect(done.type).toBe('complete');
    expect(sentNames()).toContain('Vol 1.cbz');
    expect(done.layerSnapshots).toEqual([
      { layerId: 'edit', updatedAt: 't-edit', size: layer('edit').blob.size }
    ]);
    vi.mocked(console.debug).mockRestore();
  });
});
