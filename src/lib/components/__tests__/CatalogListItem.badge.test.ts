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
import { updateProgress } from '$lib/settings';
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

  /** The chip that has always said "this series lives in the cloud". */
  function chipOf(container: HTMLElement): string | null {
    return (
      [...container.querySelectorAll('span')]
        .map((el) => el.textContent?.trim() ?? '')
        .find((text) => text.startsWith('In ')) ?? null
    );
  }

  it('leaves a series with something to read unmarked', () => {
    const { container } = render(CatalogListItem, {
      props: { volumes: [volume(), volume({ volume_uuid: 'uuid-2', metadata_only: true })] }
    });
    expect(chipOf(container)).toBeNull();
    expect(badges(container)).toHaveLength(0);
  });

  it('marks a metadata-only series the way cloud rows have always been marked', () => {
    const { container } = render(CatalogListItem, {
      props: { volumes: [volume({ metadata_only: true })], providerName: 'Drive' }
    });
    // The chip and the dimming, no corner badge: the row's established design language.
    expect(chipOf(container)).toBe('In Drive');
    expect(badges(container)).toHaveLength(0);
  });

  it('marks a cloud-only (placeholder) series identically', () => {
    const { container } = render(CatalogListItem, {
      props: { volumes: [volume({ isPlaceholder: true })], providerName: 'Drive' }
    });
    expect(chipOf(container)).toBe('In Drive');
    expect(badges(container)).toHaveLength(0);
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
      // No corner badge on an absent row: the chip and the dimming are the mark.
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
      badges: 0
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

  /** The download glyph a cloud row shows where a cover would be. */
  function downloadGlyphs(container: HTMLElement) {
    return container.querySelectorAll('svg');
  }

  it('shows the spinner when this series starts downloading', async () => {
    const { container } = render(CatalogListItem, {
      props: { volumes: [volume({ isPlaceholder: true })] }
    });
    expect(spinners(container)).toHaveLength(0);
    expect(downloadGlyphs(container)).toHaveLength(1);

    emitQueue([{ seriesTitle: 'One Piece' }], { hasQueued: false, hasDownloading: true });
    await tick();

    expect(spinners(container)).toHaveLength(1);
  });

  it('clears the spinner when the download leaves the queue', async () => {
    const { container } = render(CatalogListItem, {
      props: { volumes: [volume({ isPlaceholder: true })] }
    });

    emitQueue([{ seriesTitle: 'One Piece' }], { hasQueued: true, hasDownloading: false });
    await tick();
    expect(spinners(container)).toHaveLength(1);

    emitQueue([], { hasQueued: false, hasDownloading: false });
    await tick();
    expect(spinners(container)).toHaveLength(0);
    expect(downloadGlyphs(container)).toHaveLength(1);
  });
});

describe('CatalogListItem reads completion the way every other surface does', () => {
  afterEach(() => cleanup());

  function greenTitle(container: HTMLElement): boolean {
    const title = container.querySelector('p.font-semibold') as HTMLElement | null;
    return title?.className.includes('text-green-400') ?? false;
  }

  it('does not call a never-opened short series finished', () => {
    // The grid card says "not read" for this series (its own rule went through
    // isVolumeComplete); the list row used to disagree, because page 1 of a 1-page volume
    // looked like the end to its inline copy of the rule.
    const { container } = render(CatalogListItem, {
      props: { volumes: [volume({ page_count: 1 })] }
    });
    expect(greenTitle(container)).toBe(false);
  });

  it('does not call a never-opened two-page series finished either', () => {
    const { container } = render(CatalogListItem, {
      props: { volumes: [volume({ page_count: 2 })] }
    });
    expect(greenTitle(container)).toBe(false);
  });

  it('still calls a series finished once its volumes have been read', () => {
    updateProgress('uuid-1', 10, 0, true);
    try {
      const { container } = render(CatalogListItem, {
        props: { volumes: [volume({ page_count: 10 })] }
      });
      expect(greenTitle(container)).toBe(true);
    } finally {
      updateProgress('uuid-1', 0, 0, false);
    }
  });
});
