import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A new cover goes up beside the volume's archive as `<Volume>.webp`. On a
 * bunko that records series owners (0.8), a series another account owns is
 * closed to this one: no PUT is tried, and a refusal the server answers anyway
 * is that file's alone — the cover is saved on this device either way.
 */

vi.mock('$app/environment', () => ({ browser: true }));

const { provider, uploadFile, volumes } = vi.hoisted(() => {
  const state = { status: {} as Record<string, unknown> };
  return {
    provider: {
      type: 'webdav',
      state,
      isAuthenticated: () => true,
      getStatus: () => state.status
    },
    uploadFile: vi.fn(async () => 'file-id'),
    volumes: {
      get: vi.fn(async () => ({
        volume_uuid: 'v1',
        series_title: 'Admin Series',
        volume_title: 'Volume 1'
      })),
      update: vi.fn(async () => 1)
    }
  };
});

vi.mock('$lib/catalog/db', () => ({ db: { volumes } }));
vi.mock('$lib/catalog/thumbnails', () => ({
  convertToWebP: vi.fn(async () => new Blob(['webp'], { type: 'image/webp' })),
  generateThumbnail: vi.fn(async () => ({
    file: new File(['thumb'], 'thumb.webp', { type: 'image/webp' }),
    width: 10,
    height: 10
  }))
}));
vi.mock('$lib/catalog/thumbnail-cache', () => ({ thumbnailCache: { invalidate: vi.fn() } }));
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: { getActiveProvider: () => provider, uploadFile }
}));

import { updateVolumeCover } from './volume-editor';
import { ProviderError } from './sync/provider-interface';

const image = () => new File(['png'], 'cover.png', { type: 'image/png' });

beforeEach(() => {
  vi.clearAllMocks();
  provider.state.status = { canAddFiles: true };
});

describe('a volume cover on a server that records series owners', () => {
  it('uploads the cover to a series this account may add to', async () => {
    provider.state.status = {
      canAddFiles: true,
      addFilesPermissions: { scope: 'open', closedSeries: ['Berserk'] }
    };
    await updateVolumeCover('v1', image());
    expect(uploadFile).toHaveBeenCalledWith('Admin Series/Volume 1.webp', expect.any(Blob));
  });

  it('a series another account owns gets no PUT, and the cover is still saved', async () => {
    provider.state.status = {
      canAddFiles: true,
      addFilesPermissions: { scope: 'open', closedSeries: ['admin series'] }
    };
    await expect(updateVolumeCover('v1', image())).resolves.toBeUndefined();
    expect(volumes.update).toHaveBeenCalledTimes(1);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('a refusal the server answers anyway is not a failed cover change', async () => {
    provider.state.status = {
      canAddFiles: true,
      addFilesPermissions: { scope: 'open', closedSeries: [] }
    };
    uploadFile.mockRejectedValueOnce(
      new ProviderError('The server refused it', 'webdav', 'PERMISSION_DENIED', false, false)
    );
    await expect(updateVolumeCover('v1', image())).resolves.toBeUndefined();
    expect(volumes.update).toHaveBeenCalledTimes(1);
  });

  // Only a server that records owners makes a 403 one file's refusal. Anywhere
  // else (plain WebDAV, an older bunko, a bunko whose /me never answered) the
  // provider may just have gone read-only over it: the user is told, as before.
  it('a refusal from a server that records no owners still fails the change, as before', async () => {
    uploadFile.mockRejectedValueOnce(
      new ProviderError('Server is read-only', 'webdav', 'PERMISSION_DENIED', false, false)
    );
    await expect(updateVolumeCover('v1', image())).rejects.toThrow('Server is read-only');
  });

  it('any other failure still surfaces', async () => {
    uploadFile.mockRejectedValueOnce(
      new ProviderError('offline', 'webdav', 'UPLOAD_FAILED', false, true)
    );
    await expect(updateVolumeCover('v1', image())).rejects.toThrow('offline');
  });
});
