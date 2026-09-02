import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';

// The cover pipeline itself is exercised in `cover-service.test.ts`; this
// card's own job — tested here — is to draw through the SHARED cover claims
// exactly like every other cover-drawing surface: the row's thumbnail first,
// the cached cover second, and one request once gated.
const { requestCover, isCoverFetchTarget } = vi.hoisted(() => ({
  requestCover: vi.fn(async () => 'row' as const),
  isCoverFetchTarget: vi.fn(() => true)
}));
vi.mock('$lib/catalog/cover-service', () => ({ requestCover, isCoverFetchTarget }));

import VolumeCard from '../VolumeCard.svelte';
import type { VolumeMetadata } from '$lib/types';

function volume(uuid: string, overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    volume_uuid: uuid,
    series_uuid: 'series-uuid',
    series_title: 'One Piece',
    volume_title: 'Vol 1',
    mokuro_version: '0.4.11',
    page_count: 100,
    character_count: 1000,
    page_char_counts: [],
    ...overrides
  } as VolumeMetadata;
}

const baseProps = {
  volumeId: 'v-1',
  seriesId: 'series-uuid',
  volumeTitle: 'Vol 1',
  progressPercentString: '10%',
  remainingPages: 90,
  isHovered: false,
  onHover: () => {},
  showProgressBar: false,
  showDeadline: false
};

describe('VolumeCard covers', () => {
  const originalCreate = globalThis.URL.createObjectURL;
  const originalRevoke = globalThis.URL.revokeObjectURL;
  let created: string[] = [];

  beforeEach(() => {
    created = [];
    requestCover.mockClear();
    isCoverFetchTarget.mockClear();
    isCoverFetchTarget.mockReturnValue(true);
    globalThis.URL.createObjectURL = vi.fn(() => {
      const url = `blob:cover-${created.length + 1}`;
      created.push(url);
      return url;
    }) as unknown as typeof URL.createObjectURL;
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    cleanup();
    globalThis.URL.createObjectURL = originalCreate;
    globalThis.URL.revokeObjectURL = originalRevoke;
  });

  it('renders the row thumbnail as an object URL, and asks for nothing more', async () => {
    isCoverFetchTarget.mockReturnValue(false); // a fresh thumbnail is never a target
    const { container } = render(VolumeCard, {
      props: {
        ...baseProps,
        volume: volume('v-1', { thumbnail: new File([], 'c.jpg', { type: 'image/jpeg' }) })
      }
    });
    await tick();

    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:cover-1');
    expect(requestCover).not.toHaveBeenCalled();
  });

  it('shows the placeholder box and asks the service once, gated, when the row has no cover', async () => {
    const { container } = render(VolumeCard, {
      props: {
        ...baseProps,
        volume: volume('v-1', {
          metadata_only: true,
          cloudPath: 'One Piece/Vol 1.cbz',
          cloudThumbnailFileId: 'thumb-1'
        })
      }
    });
    await tick();

    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('Vol 1');
    // jsdom has no IntersectionObserver, so the gate opens synchronously.
    expect(requestCover).toHaveBeenCalledTimes(1);
    expect(requestCover).toHaveBeenCalledWith(
      expect.objectContaining({ volume_uuid: 'v-1', cloudPath: 'One Piece/Vol 1.cbz' }),
      expect.objectContaining({ stillNear: expect.any(Function) })
    );
  });

  it('asks for nothing when the tracker entry has no catalog row at all', async () => {
    const { container } = render(VolumeCard, { props: { ...baseProps, volume: undefined } });
    await tick();

    expect(container.querySelector('img')).toBeNull();
    expect(requestCover).not.toHaveBeenCalled();
  });
});
