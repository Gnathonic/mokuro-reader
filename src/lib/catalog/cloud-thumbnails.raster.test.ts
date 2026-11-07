import { describe, expect, it, vi } from 'vitest';
import type { VolumeMetadata } from '$lib/types';

/**
 * A cloud cover is typed by its bytes, never by its name (`<Volume>.webp`) or
 * the provider's type: SVG is unsupported, and an SVG kept as an object URL
 * would run as the app when the cover is opened in a new tab.
 */

const cloud = vi.hoisted(() => ({ next: null as Blob | null }));

vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    getActiveProvider: () => ({ type: 'webdav' }),
    downloadFile: vi.fn(async () => cloud.next)
  }
}));

import { fetchCloudThumbnail } from './cloud-thumbnails';

(globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () => ({
  width: 250,
  height: 350,
  close() {}
});

let seq = 0;
function vol(): VolumeMetadata {
  seq += 1;
  return {
    volume_uuid: `uuid-${seq}`,
    series_title: 'Series',
    volume_title: 'Vol 1.5',
    cloudProvider: 'webdav',
    cloudThumbnailFileId: `thumb-${seq}`,
    cloudThumbnailPath: 'Series/Vol 1.5.webp'
  } as VolumeMetadata;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

describe('fetchCloudThumbnail', () => {
  it('types a cover by its bytes, not its .webp name', async () => {
    cloud.next = new Blob([PNG], { type: 'image/webp' });
    const result = await fetchCloudThumbnail(vol());
    expect(result?.file.type).toBe('image/png');
    expect(result?.file.name).toBe('Vol 1.5.png');
    expect(result?.width).toBe(250);
  });

  it('refuses an SVG cover, whatever it is named or typed as', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const type of ['image/svg+xml', 'image/webp', '']) {
      cloud.next = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'], {
        type
      });
      expect(await fetchCloudThumbnail(vol()), type).toBeNull();
    }
    expect(warn.mock.calls.flat().map(String).join(' ')).toContain('not a supported raster image');
    warn.mockRestore();
  });
});
