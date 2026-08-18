import { describe, expect, it, vi } from 'vitest';
import type { CloudVolumeWithProvider } from '$lib/util/sync/unified-cloud-manager';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/catalog/cloud-ocr-upgrade', () => ({ enqueueCloudOcrUpgrade: vi.fn() }));

import { generatePlaceholders } from './placeholders';

function cloudFile(path: string, fileId = path): CloudVolumeWithProvider {
  return {
    provider: 'webdav',
    fileId,
    path,
    modifiedTime: '2026-08-17T00:00:00.000Z',
    size: 10
  } as CloudVolumeWithProvider;
}

describe('generatePlaceholders', () => {
  it('never turns the series sidecar into a cloud-only volume', () => {
    // `series.json` is now a listed, cached file. It is a sidecar of the SERIES
    // FOLDER — a placeholder built from it would show up in the catalog as a
    // volume named "series.json" that can never be downloaded.
    const cloudFiles = new Map<string, CloudVolumeWithProvider[]>([
      ['One Piece', [cloudFile('One Piece/Volume 1.cbz'), cloudFile('One Piece/series.json')]]
    ]);

    const placeholders = generatePlaceholders(cloudFiles, []);

    expect(placeholders).toHaveLength(1);
    expect(placeholders[0].volume_title).toBe('Volume 1');
  });

  it('produces nothing at all for a series folder holding only the sidecar', () => {
    const cloudFiles = new Map<string, CloudVolumeWithProvider[]>([
      ['One Piece', [cloudFile('One Piece/series.json')]]
    ]);

    expect(generatePlaceholders(cloudFiles, [])).toEqual([]);
  });
});
