import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudFileMetadata, SyncProvider } from './provider-interface';

const getCache = vi.fn();
const showSnackbar = vi.fn();
const addProcess = vi.fn();
const updateProcess = vi.fn();
const removeProcess = vi.fn();
const exportLibraries = vi.fn(() => []);

vi.mock('./cache-manager', () => ({
  cacheManager: {
    getCache
  }
}));

vi.mock('../snackbar', () => ({
  showSnackbar
}));

vi.mock('../progress-tracker', () => ({
  progressTrackerStore: {
    addProcess,
    updateProcess,
    removeProcess
  }
}));

vi.mock('$lib/settings', async () => {
  const { writable } = await vi.importActual<typeof import('svelte/store')>('svelte/store');

  return {
    volumesWithTrash: writable<Record<string, any>>({}),
    profiles: writable<Record<string, any>>({}),
    profilesWithTrash: writable<Record<string, any>>({}),
    parseVolumesFromJson: (storedData: string) => JSON.parse(storedData),
    migrateProfiles: (data: Record<string, any>) => data
  };
});

vi.mock('$lib/settings/libraries', async () => {
  const { writable } = await vi.importActual<typeof import('svelte/store')>('svelte/store');

  return {
    librariesStore: writable([]),
    importLibraries: vi.fn(),
    exportLibraries
  };
});

function createWebDAVProvider(
  downloadFile: (file: CloudFileMetadata) => Promise<Blob>
): SyncProvider {
  return {
    type: 'webdav',
    name: 'WebDAV',
    supportsWorkerDownload: true,
    uploadConcurrencyLimit: 8,
    downloadConcurrencyLimit: 8,
    isAuthenticated: () => true,
    getStatus: () => ({
      isAuthenticated: true,
      hasStoredCredentials: true,
      needsAttention: false,
      statusMessage: 'Connected'
    }),
    login: vi.fn(),
    logout: vi.fn(),
    listCloudVolumes: vi.fn(async () => []),
    uploadFile: vi.fn(async () => '/mokuro-reader/volume-data.json'),
    downloadFile: vi.fn(downloadFile),
    deleteFile: vi.fn(),
    renameFile: vi.fn(),
    renameFolder: vi.fn(),
    getStorageQuota: vi.fn(async () => ({
      used: 0,
      total: null,
      available: null
    }))
  } as unknown as SyncProvider;
}

function jsonBlob(data: unknown): Blob {
  return {
    text: async () => JSON.stringify(data)
  } as Blob;
}

describe('UnifiedSyncService cache refresh on sync JSON miss', () => {
  beforeEach(async () => {
    vi.clearAllMocks();

    const settings = await import('$lib/settings');
    settings.volumesWithTrash.set({});
    settings.profilesWithTrash.set({});
  });

  it('refreshes the cache before reading volume-data.json', async () => {
    let cachePrimed = false;
    const volumeMetadata: CloudFileMetadata = {
      provider: 'webdav',
      fileId: '/mokuro-reader/volume-data.json',
      path: 'volume-data.json',
      modifiedTime: '2026-03-13T00:00:00.000Z',
      size: 128
    };
    const cache = {
      getAll: vi.fn((path: string) =>
        cachePrimed && path === 'volume-data.json' ? [volumeMetadata] : []
      ),
      get: vi.fn(() => null),
      fetch: vi.fn(async () => {
        cachePrimed = true;
      })
    };
    getCache.mockReturnValue(cache);

    const cloudVolumes = {
      'vol-1': {
        progress: 12,
        lastProgressUpdate: '2026-03-13T00:00:00.000Z'
      }
    };

    const provider = createWebDAVProvider(async (file) => {
      expect(file).toEqual(volumeMetadata);
      return jsonBlob(cloudVolumes);
    });

    const { unifiedSyncService } = await import('./unified-sync-service');
    const result = await unifiedSyncService.syncProvider(provider);
    const settings = await import('$lib/settings');

    expect(result).toEqual({ provider: 'webdav', success: true });
    expect(cache.fetch).toHaveBeenCalledTimes(1);
    expect(provider.downloadFile).toHaveBeenCalledTimes(1);
    expect(provider.uploadFile).not.toHaveBeenCalled();
    expect(get(settings.volumesWithTrash)).toEqual(cloudVolumes);
  });

  it('refreshes the cache before reading profiles.json', async () => {
    let cachePrimed = false;
    const profilesMetadata: CloudFileMetadata = {
      provider: 'webdav',
      fileId: '/mokuro-reader/profiles.json',
      path: 'profiles.json',
      modifiedTime: '2026-03-13T00:00:00.000Z',
      size: 96
    };
    const cache = {
      getAll: vi.fn(() => []),
      get: vi.fn((path: string) =>
        cachePrimed && path === 'profiles.json' ? profilesMetadata : null
      ),
      fetch: vi.fn(async () => {
        cachePrimed = true;
      })
    };
    getCache.mockReturnValue(cache);

    const cloudProfiles = {
      default: {
        lastUpdated: '2026-03-13T00:00:00.000Z',
        defaultFullscreen: true
      }
    };

    const provider = createWebDAVProvider(async (file) => {
      expect(file).toEqual(profilesMetadata);
      return jsonBlob(cloudProfiles);
    });

    const { unifiedSyncService } = await import('./unified-sync-service');
    const result = await unifiedSyncService.downloadProfiles(provider);
    const settings = await import('$lib/settings');

    expect(result).toEqual(cloudProfiles);
    expect(cache.fetch).toHaveBeenCalledTimes(1);
    expect(provider.downloadFile).toHaveBeenCalledWith(profilesMetadata);
    settings.profilesWithTrash.set(result || {});
    expect(get(settings.profilesWithTrash)).toEqual(cloudProfiles);
  });
});
