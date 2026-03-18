import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/cloud-provider-core-registry', () => ({
  getCloudProviderCore: vi.fn(() => ({
    downloadFile: vi.fn(),
    uploadFile: vi.fn()
  }))
}));

vi.mock('../../provider-detection', () => ({
  setActiveProviderKey: vi.fn(),
  clearActiveProviderKey: vi.fn()
}));

describe('WebDAVProvider listing normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('normalizes depth-infinity listings into canonical cache paths', async () => {
    const { WebDAVProvider } = await import('./webdav-provider');
    const provider = new WebDAVProvider();

    const client = {
      exists: vi.fn(async () => true),
      getDirectoryContents: vi.fn(async (_path: string, options?: { deep?: boolean }) => {
        expect(_path).toBe('/mokuro-reader');
        expect(options).toEqual({ deep: true });

        return [
          {
            type: 'file',
            filename: 'http://localhost:8080/mokuro-reader/volume-data.json',
            basename: 'volume-data.json',
            lastmod: '2026-03-13T00:00:00.000Z',
            size: 42
          },
          {
            type: 'file',
            filename: 'http://localhost:8080/mokuro-reader/Series%20Name/Vol%201.cbz',
            basename: 'Vol 1.cbz',
            lastmod: '2026-03-13T00:00:01.000Z',
            size: 128
          }
        ];
      })
    };

    (provider as any).client = client;

    const files = await provider.listCloudVolumes();

    expect(files).toEqual([
      {
        provider: 'webdav',
        fileId: '/mokuro-reader/volume-data.json',
        path: 'volume-data.json',
        modifiedTime: '2026-03-13T00:00:00.000Z',
        size: 42
      },
      {
        provider: 'webdav',
        fileId: '/mokuro-reader/Series Name/Vol 1.cbz',
        path: 'Series Name/Vol 1.cbz',
        modifiedTime: '2026-03-13T00:00:01.000Z',
        size: 128
      }
    ]);
  });

  it('normalizes recursive listings into canonical cache paths', async () => {
    const { WebDAVProvider } = await import('./webdav-provider');
    const provider = new WebDAVProvider();

    const client = {
      exists: vi.fn(async () => true),
      getDirectoryContents: vi.fn(async (path: string) => {
        if (path === '/mokuro-reader') {
          return [
            {
              type: 'directory',
              filename: 'http://localhost:8080/mokuro-reader/Series%20Name',
              basename: 'Series Name',
              lastmod: '2026-03-13T00:00:00.000Z',
              size: 0
            },
            {
              type: 'file',
              filename: 'http://localhost:8080/mokuro-reader/profiles.json',
              basename: 'profiles.json',
              lastmod: '2026-03-13T00:00:02.000Z',
              size: 64
            }
          ];
        }

        if (path === '/mokuro-reader/Series Name') {
          return [
            {
              type: 'file',
              filename: 'http://localhost:8080/mokuro-reader/Series%20Name/Vol%201.cbz',
              basename: 'Vol 1.cbz',
              lastmod: '2026-03-13T00:00:03.000Z',
              size: 256
            }
          ];
        }

        throw new Error(`Unexpected path: ${path}`);
      })
    };

    (provider as any).client = client;
    (provider as any)._supportsDepthInfinity = false;

    const files = await provider.listCloudVolumes();

    expect(files).toEqual([
      {
        provider: 'webdav',
        fileId: '/mokuro-reader/Series Name/Vol 1.cbz',
        path: 'Series Name/Vol 1.cbz',
        modifiedTime: '2026-03-13T00:00:03.000Z',
        size: 256
      },
      {
        provider: 'webdav',
        fileId: '/mokuro-reader/profiles.json',
        path: 'profiles.json',
        modifiedTime: '2026-03-13T00:00:02.000Z',
        size: 64
      }
    ]);
  });
});
