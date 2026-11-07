import { describe, expect, it, vi } from 'vitest';
import type { VolumeMetadata } from '$lib/types';

/**
 * The session copy (`cloud-thumbnails.ts`): a cover downloaded once this
 * session is answered from memory — but only for the SAME cover version. A
 * cover changed in the cloud must never be answered from the old copy, and a
 * forced refresh always goes back to the cloud.
 */

const cloud = vi.hoisted(() => {
  let n = 0;
  const downloadFile = vi.fn(async () => {
    n++;
    // Real PNG magic: a cover is typed by its bytes, and anything else is refused.
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
    return new Blob([new Uint8Array(png), `bytes-${n}`], { type: 'image/webp' });
  });
  return { downloadFile };
});

vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    getActiveProvider: () => ({ type: 'webdav' }),
    downloadFile: cloud.downloadFile
  }
}));

import { fetchCloudThumbnail } from './cloud-thumbnails';

(globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () => ({
  width: 2,
  height: 3,
  close() {}
});

function vol(uuid: string, size: number, modified = '2026-01-01T00:00:00.000Z'): VolumeMetadata {
  return {
    volume_uuid: uuid,
    series_title: 'Series',
    volume_title: 'Vol 1',
    cloudProvider: 'webdav',
    cloudThumbnailFileId: 'Series/Vol 1.webp',
    cloudThumbnailPath: 'Series/Vol 1.webp',
    cloudThumbnailSize: size,
    cloudThumbnailModifiedTime: modified
  } as VolumeMetadata;
}

describe('the session copy is keyed by cover version', () => {
  it('answers the same version from memory', async () => {
    const first = await fetchCloudThumbnail(vol('a', 10));
    const second = await fetchCloudThumbnail(vol('a', 10));
    expect(cloud.downloadFile).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('downloads again when the listed cover changed, and returns the new bytes', async () => {
    cloud.downloadFile.mockClear();
    const old = await fetchCloudThumbnail(vol('b', 10));
    const changed = await fetchCloudThumbnail(vol('b', 11, '2026-02-01T00:00:00.000Z'));
    expect(cloud.downloadFile).toHaveBeenCalledTimes(2);
    expect(await changed!.file.text()).not.toBe(await old!.file.text());
  });

  it('a forced refresh downloads again even for the same version', async () => {
    cloud.downloadFile.mockClear();
    await fetchCloudThumbnail(vol('c', 10));
    await fetchCloudThumbnail(vol('c', 10), undefined, { refresh: true });
    expect(cloud.downloadFile).toHaveBeenCalledTimes(2);
  });
});
