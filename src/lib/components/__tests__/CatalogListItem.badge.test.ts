import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';

// Same stubs the shortcut suite uses: the row's dependency graph (Dexie, the sync stack)
// has nothing to do with whether the "not on this device" badge is drawn.
vi.mock('$lib/util/modals', () => ({ promptSeriesEditor: vi.fn(), promptConfirmation: vi.fn() }));
// A queue we can actually drive: the row is supposed to follow it.
const { emitQueue, resetQueue, downloadQueue } = vi.hoisted(() => {
  const subscribers = new Set<(v: unknown[]) => void>();
  let queue: unknown[] = [];
  let status = { hasQueued: false, hasDownloading: false };
  return {
    emitQueue(next: unknown[], nextStatus: { hasQueued: boolean; hasDownloading: boolean }) {
      queue = next;
      status = nextStatus;
      for (const fn of subscribers) fn(queue);
    },
    resetQueue() {
      queue = [];
      status = { hasQueued: false, hasDownloading: false };
    },
    downloadQueue: {
      subscribe(fn: (v: unknown[]) => void) {
        subscribers.add(fn);
        fn(queue);
        return () => subscribers.delete(fn);
      },
      getSeriesQueueStatus: () => status
    }
  };
});
vi.mock('$lib/util/download-queue', () => ({ downloadQueue }));
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

  it('names the mark for screen readers', () => {
    const { container } = render(CatalogListItem, {
      props: { volumes: [volume({ metadata_only: true })] }
    });
    const badge = badges(container)[0] as HTMLElement;
    expect(badge.querySelector('.sr-only')?.textContent).toBe('Not on this device');
    expect(badge.getAttribute('title')).toBeNull();
  });

  it('draws the badge for a cloud-only (placeholder) series', () => {
    const { container } = render(CatalogListItem, {
      props: { volumes: [volume({ isPlaceholder: true })] }
    });
    expect(badges(container)).toHaveLength(1);
  });
});

describe('CatalogListItem gives an all-absent series the placeholder identity', () => {
  beforeAll(() => {
    // jsdom has no object URLs; the row needs one to render a cover at all.
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:test');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => cleanup());

  const withCover = (overrides: Partial<VolumeMetadata> = {}) =>
    volume({ thumbnail: new File([], 'cover.jpg', { type: 'image/jpeg' }), ...overrides });

  /** The cues that say WHAT KIND of series this row is. */
  function identity(container: HTMLElement) {
    const row = container.querySelector('div') as HTMLElement;
    const title = row.querySelector('p.font-semibold') as HTMLElement | null;
    const chip = [...row.querySelectorAll('span')]
      .map((el) => el.textContent?.trim() ?? '')
      .find((text) => text.startsWith('In '));
    return {
      dimmed: row.className.includes('opacity-70'),
      mutedTitle: title?.className.includes('text-gray-400') ?? false,
      greenTitle: title?.className.includes('text-green-400') ?? false,
      chip: chip ?? null,
      badges: row.querySelectorAll('[data-testid="download-badge"]').length
    };
  }

  it('reads exactly like a cloud-only series', () => {
    const cloud = render(CatalogListItem, {
      props: { volumes: [volume({ isPlaceholder: true })], providerName: 'Drive' }
    });
    const placeholderIdentity = identity(cloud.container);
    cleanup();

    const removed = render(CatalogListItem, {
      props: { volumes: [volume({ metadata_only: true })], providerName: 'Drive' }
    });

    expect(identity(removed.container)).toEqual(placeholderIdentity);
    expect(placeholderIdentity).toEqual({
      dimmed: true,
      mutedTitle: true,
      // A series with nothing here is not a series you finished.
      greenTitle: false,
      chip: 'In Drive',
      badges: 1
    });
  });

  it('leaves a series with something to read alone', () => {
    const { container } = render(CatalogListItem, {
      props: { volumes: [volume(), volume({ volume_uuid: 'uuid-2', metadata_only: true })] }
    });
    expect(identity(container)).toEqual({
      dimmed: false,
      mutedTitle: false,
      greenTitle: false,
      chip: null,
      badges: 0
    });
  });

  it('shows the cover it has, whichever kind of absent series it is', () => {
    const cloud = render(CatalogListItem, {
      props: { volumes: [withCover({ isPlaceholder: true })] }
    });
    expect(cloud.container.querySelector('img')).not.toBeNull();
    cleanup();

    const removed = render(CatalogListItem, {
      props: { volumes: [withCover({ metadata_only: true })] }
    });
    expect(removed.container.querySelector('img')).not.toBeNull();
  });

  it('falls back to the download icon — never a blank "Cover" box — with no cover', () => {
    const { container } = render(CatalogListItem, {
      props: { volumes: [volume({ metadata_only: true })] }
    });
    expect(container.textContent).not.toContain('Cover');
    expect(container.querySelector('svg')).not.toBeNull();
  });
});

describe('CatalogListItem follows the download queue', () => {
  afterEach(() => {
    cleanup();
    resetQueue();
  });

  function spinners(container: HTMLElement) {
    return container.querySelectorAll('.animate-spin');
  }

  it('shows the spinner when this series starts downloading, and drops the badge', async () => {
    const { container } = render(CatalogListItem, {
      props: { volumes: [volume({ isPlaceholder: true })] }
    });
    expect(spinners(container)).toHaveLength(0);
    expect(badges(container)).toHaveLength(1);

    emitQueue([{ seriesTitle: 'One Piece' }], { hasQueued: false, hasDownloading: true });
    await tick();

    expect(spinners(container)).toHaveLength(1);
    expect(badges(container)).toHaveLength(0);
  });

  it('clears the spinner when the download leaves the queue', async () => {
    const { container } = render(CatalogListItem, {
      props: { volumes: [volume({ metadata_only: true })] }
    });

    emitQueue([{ seriesTitle: 'One Piece' }], { hasQueued: true, hasDownloading: false });
    await tick();
    expect(spinners(container)).toHaveLength(1);

    emitQueue([], { hasQueued: false, hasDownloading: false });
    await tick();
    expect(spinners(container)).toHaveLength(0);
    expect(badges(container)).toHaveLength(1);
  });
});
