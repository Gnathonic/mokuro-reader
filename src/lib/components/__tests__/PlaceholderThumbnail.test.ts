import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';

// The cover pipeline is exercised in its own suites; here only the CACHED branch
// matters — the one that paints synchronously and owns an object URL.
vi.mock('$lib/catalog/cloud-thumbnails', () => ({
  fetchCloudThumbnail: vi.fn(async () => null),
  getCachedCloudThumbnail: vi.fn(() => undefined)
}));
vi.mock('$lib/catalog/cover-requests', () => ({ requestCoverOnce: vi.fn(async () => {}) }));

import { tick } from 'svelte';
import PlaceholderThumbnail from '../PlaceholderThumbnail.svelte';
import { getCachedCloudThumbnail } from '$lib/catalog/cloud-thumbnails';
import type { VolumeMetadata } from '$lib/types';

function volume(uuid: string): VolumeMetadata {
  return {
    volume_uuid: uuid,
    series_uuid: 'series-uuid',
    series_title: 'One Piece',
    volume_title: 'Vol 1',
    page_count: 10,
    isPlaceholder: true,
    cloudThumbnailFileId: `thumb-${uuid}`
  } as VolumeMetadata;
}

describe('PlaceholderThumbnail cover lifetime', () => {
  const originalCreate = globalThis.URL.createObjectURL;
  const originalRevoke = globalThis.URL.revokeObjectURL;
  let created: string[] = [];
  let revoked: string[] = [];

  beforeEach(() => {
    created = [];
    revoked = [];
    globalThis.URL.createObjectURL = vi.fn(() => {
      const url = `blob:cover-${created.length + 1}`;
      created.push(url);
      return url;
    }) as unknown as typeof URL.createObjectURL;
    globalThis.URL.revokeObjectURL = vi.fn((url: string) => {
      revoked.push(url);
    });
    vi.mocked(getCachedCloudThumbnail).mockImplementation((uuid: string) =>
      uuid === 'c-1'
        ? ({
            file: new File([], 'cover.jpg', { type: 'image/jpeg' }),
            width: 250,
            height: 360
          } as never)
        : undefined
    );
  });

  afterEach(() => {
    cleanup();
    globalThis.URL.createObjectURL = originalCreate;
    globalThis.URL.revokeObjectURL = originalRevoke;
    vi.mocked(getCachedCloudThumbnail).mockReset();
  });

  it('stops showing a cover whose URL it revoked when the volume changes', async () => {
    // The card reuses one PlaceholderThumbnail across volumes (a re-sort, a page of
    // results). Revoking without clearing the state leaves the <img> pointing at a dead
    // blob URL: a broken-image icon where the next volume's placeholder belongs.
    const { container, rerender } = render(PlaceholderThumbnail, {
      props: { volume: volume('c-1') }
    });
    await tick();
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:cover-1');

    await rerender({ volume: volume('c-2') });
    await tick();

    expect(revoked).toEqual(['blob:cover-1']);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('No thumbnail');
  });
});
