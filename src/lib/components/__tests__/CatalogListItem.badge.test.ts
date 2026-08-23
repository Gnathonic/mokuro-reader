import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';

// Same stubs the shortcut suite uses: the row's dependency graph (Dexie, the sync stack)
// has nothing to do with whether the "not on this device" badge is drawn.
vi.mock('$lib/util/modals', () => ({ promptSeriesEditor: vi.fn(), promptConfirmation: vi.fn() }));
vi.mock('$lib/util/download-queue', () => ({
  downloadQueue: {
    subscribe: (fn: (v: unknown[]) => void) => {
      fn([]);
      return () => {};
    },
    getSeriesQueueStatus: () => ({ hasQueued: false, hasDownloading: false })
  }
}));
vi.mock('$lib/catalog', () => ({
  volumes: {
    subscribe: (fn: (v: Record<string, unknown>) => void) => {
      fn({});
      return () => {};
    }
  }
}));

import CatalogListItem from '../CatalogListItem.svelte';
import type { VolumeMetadata } from '$lib/types';

function volume(overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    volume_uuid: 'uuid-1',
    series_uuid: 'series-uuid',
    series_title: 'One Piece',
    volume_title: 'Vol 1',
    page_count: 10,
    isPlaceholder: false,
    ...overrides
  } as VolumeMetadata;
}

function badges(container: HTMLElement) {
  return container.querySelectorAll('[data-testid="download-badge"]');
}

describe('CatalogListItem marks a series whose volumes are all absent', () => {
  afterEach(() => cleanup());

  it('draws no badge while any volume is installed', () => {
    const { container } = render(CatalogListItem, {
      props: { volumes: [volume(), volume({ volume_uuid: 'uuid-2', metadata_only: true })] }
    });
    expect(badges(container)).toHaveLength(0);
  });

  it('draws the badge when every volume is metadata-only', () => {
    const { container } = render(CatalogListItem, {
      props: { volumes: [volume({ metadata_only: true })] }
    });
    expect(badges(container)).toHaveLength(1);
    expect((badges(container)[0] as HTMLElement).className).toContain('pointer-events-none');
  });

  it('draws the badge for a cloud-only (placeholder) series', () => {
    const { container } = render(CatalogListItem, {
      props: { volumes: [volume({ isPlaceholder: true })] }
    });
    expect(badges(container)).toHaveLength(1);
  });
});
