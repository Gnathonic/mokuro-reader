import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';

vi.mock('$lib/util/download-queue', () => ({
  downloadQueue: {
    subscribe: (fn: (v: unknown[]) => void) => {
      fn([]);
      return () => {};
    },
    queueVolume: vi.fn()
  }
}));
vi.mock('$lib/util/progress-tracker', () => ({
  progressTrackerStore: {
    subscribe: (fn: (v: { processes: unknown[] }) => void) => {
      fn({ processes: [] });
      return () => {};
    }
  }
}));
vi.mock('$lib/util', () => ({ showSnackbar: vi.fn(), promptConfirmation: vi.fn() }));
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: { deleteFile: vi.fn() }
}));
vi.mock('$lib/catalog/cloud-thumbnails', () => ({
  fetchCloudThumbnail: vi.fn(async () => null),
  getCachedCloudThumbnail: vi.fn(() => undefined)
}));

import PlaceholderVolumeItem from '../PlaceholderVolumeItem.svelte';
import type { VolumeMetadata } from '$lib/types';

function placeholder(): VolumeMetadata {
  return {
    volume_uuid: 'uuid-cloud-1',
    series_uuid: 'series-uuid',
    series_title: 'One Piece',
    volume_title: 'Vol 1',
    page_count: 10,
    isPlaceholder: true
  } as VolumeMetadata;
}

describe('PlaceholderVolumeItem archive size', () => {
  afterEach(() => cleanup());

  for (const variant of ['list', 'grid'] as const) {
    it(`shows the listed size in the same words a volume row uses (${variant})`, () => {
      const { container } = render(PlaceholderVolumeItem, {
        props: { volume: { ...placeholder(), cloudSize: 193_000_000 }, variant }
      });
      expect(container.querySelector('[data-testid="archive-size"]')?.textContent).toContain(
        '184 MB'
      );
    });

    it(`says the size is unknown when the listing reports none (${variant})`, () => {
      const { container } = render(PlaceholderVolumeItem, {
        props: { volume: placeholder(), variant }
      });
      expect(container.querySelector('[data-testid="archive-size"]')?.textContent).toContain(
        'Unknown size'
      );
    });
  }
});

describe('PlaceholderVolumeItem carries the same not-on-device badge', () => {
  afterEach(() => cleanup());

  for (const variant of ['list', 'grid'] as const) {
    it(`draws the badge in the ${variant} variant`, () => {
      const { container } = render(PlaceholderVolumeItem, {
        props: { volume: placeholder(), variant }
      });
      const badges = container.querySelectorAll('[data-testid="download-badge"]');
      expect(badges).toHaveLength(1);
      expect((badges[0] as HTMLElement).className).toContain('pointer-events-none');
    });
  }
});
