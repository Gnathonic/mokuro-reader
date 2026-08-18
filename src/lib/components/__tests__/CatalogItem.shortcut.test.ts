import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';

// vi.hoisted: the vi.mock factories below run before this module's own imports, so the
// spy they close over has to be created here rather than via a later top-level const.
const { promptSeriesEditor } = vi.hoisted(() => ({ promptSeriesEditor: vi.fn() }));
vi.mock('$lib/util/modals', () => ({ promptSeriesEditor }));

// Stub the download-queue and cloud-thumbnails modules so this test doesn't drag in
// their real dependency graph (Dexie/db, google-drive api client, unified-cloud-manager,
// the whole import/sync pipeline) — none of which matter for the keyboard shortcut.
vi.mock('$lib/util/download-queue', () => ({
  downloadQueue: {
    subscribe: (fn: (v: unknown[]) => void) => {
      fn([]);
      return () => {};
    },
    getSeriesQueueStatus: () => ({ hasQueued: false, hasDownloading: false })
  }
}));
vi.mock('$lib/catalog/cloud-thumbnails', () => ({
  fetchCloudThumbnail: vi.fn(async () => null),
  getCachedCloudThumbnail: vi.fn(() => undefined)
}));

// The card reads/writes spine offsets through the series metadata store; stub the store
// (not `spine-offsets`) so the real debounce + patch building are exercised, without
// Dexie/liveQuery. `emitSeriesMetadata` plays the part of a liveQuery emission.
const { updateSeriesMetadata, emitSeriesMetadata, seriesMetadataMap } = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const subscribers = new Set<(v: Map<string, Row>) => void>();
  let value = new Map<string, Row>();
  return {
    updateSeriesMetadata: vi.fn(async (_seriesTitle: string, _patch: unknown) => undefined),
    emitSeriesMetadata: (next: Map<string, Row>) => {
      value = next;
      for (const fn of subscribers) fn(value);
    },
    seriesMetadataMap: {
      subscribe(fn: (v: Map<string, Row>) => void) {
        subscribers.add(fn);
        fn(value);
        return () => subscribers.delete(fn);
      }
    }
  };
});
vi.mock('$lib/metadata/store', () => ({ updateSeriesMetadata, seriesMetadataMap }));

import CatalogItem from '../CatalogItem.svelte';
import type { VolumeMetadata } from '$lib/types';
import type { SeriesMetadata } from '$lib/metadata/types';
import { flushSpineOffsetWrites } from '$lib/metadata/spine-offsets';

function localVolume(overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
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

function placeholderVolume(overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    volume_uuid: 'uuid-cloud-1',
    series_uuid: 'series-uuid',
    series_title: 'Cloud Only Series',
    volume_title: 'Vol 1',
    page_count: 10,
    isPlaceholder: true,
    ...overrides
  } as VolumeMetadata;
}

// The hovered card is the outer <div> the component itself renders inside its <a>.
function getCard(container: HTMLElement): HTMLElement {
  const card = container.querySelector('a > div');
  if (!card) throw new Error('card element not found');
  return card as HTMLElement;
}

describe('CatalogItem hover + "e" opens the series editor', () => {
  beforeEach(() => {
    promptSeriesEditor.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('opens the series editor with the raw series title on hover + "e"', async () => {
    const { container } = render(CatalogItem, { props: { volumes: [localVolume()] } });
    const card = getCard(container);

    await fireEvent.mouseEnter(card);
    await fireEvent.keyDown(window, { key: 'e' });

    expect(promptSeriesEditor).toHaveBeenCalledTimes(1);
    expect(promptSeriesEditor).toHaveBeenCalledWith('One Piece');
  });

  it('works for a placeholder (cloud-only) series card, using its raw title', async () => {
    const { container } = render(CatalogItem, { props: { volumes: [placeholderVolume()] } });
    const card = getCard(container);

    await fireEvent.mouseEnter(card);
    await fireEvent.keyDown(window, { key: 'e' });

    expect(promptSeriesEditor).toHaveBeenCalledWith('Cloud Only Series');
  });

  it('does not open when a search input has focus, even while hovered', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    const { container } = render(CatalogItem, { props: { volumes: [localVolume()] } });
    const card = getCard(container);

    await fireEvent.mouseEnter(card);
    await fireEvent.keyDown(window, { key: 'e' });

    expect(promptSeriesEditor).not.toHaveBeenCalled();

    input.remove();
  });

  it('does not open when the card is not hovered', async () => {
    render(CatalogItem, { props: { volumes: [localVolume()] } });

    await fireEvent.keyDown(window, { key: 'e' });

    expect(promptSeriesEditor).not.toHaveBeenCalled();
  });

  it('stops listening once the mouse leaves the card', async () => {
    const { container } = render(CatalogItem, { props: { volumes: [localVolume()] } });
    const card = getCard(container);

    await fireEvent.mouseEnter(card);
    await fireEvent.mouseLeave(card);
    await fireEvent.keyDown(window, { key: 'e' });

    expect(promptSeriesEditor).not.toHaveBeenCalled();
  });

  it('stops listening once the component is unmounted', async () => {
    const { container, unmount } = render(CatalogItem, { props: { volumes: [localVolume()] } });
    const card = getCard(container);

    await fireEvent.mouseEnter(card);
    unmount();
    await fireEvent.keyDown(window, { key: 'e' });

    expect(promptSeriesEditor).not.toHaveBeenCalled();
  });
});

describe('CatalogItem spine offsets persist to the series metadata', () => {
  // CompositeCanvas renders once the volumes have thumbnail dimensions; it only draws
  // when its IntersectionObserver reports visibility, so a no-op observer keeps jsdom
  // out of canvas painting while still binding the container the hit test needs.
  class IntersectionObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  const originalIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;

  function withThumbnail(overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
    return localVolume({ thumbnail_width: 250, thumbnail_height: 360, ...overrides });
  }

  const twoVolumes = () => [
    withThumbnail({ volume_uuid: 'uuid-0', volume_title: 'Vol 1' }),
    withThumbnail({ volume_uuid: 'uuid-1', volume_title: 'Vol 2' })
  ];

  function meta(overrides: Partial<SeriesMetadata> = {}): Map<string, Record<string, unknown>> {
    return new Map([
      [
        'one piece',
        {
          series_key: 'one piece',
          series_title: 'One Piece',
          external_ids: {},
          titles: {},
          synonyms: [],
          read_count: 0,
          updated_at: '2026-01-01T00:00:00.000Z',
          ...overrides
        }
      ]
    ]);
  }

  /** Resolve the functional patch the card's write handed to the store. */
  function resolvePatch(callIndex: number, existing: Partial<SeriesMetadata> = {}) {
    const [, patch] = updateSeriesMetadata.mock.calls[callIndex] as unknown as [
      string,
      (existing: Partial<SeriesMetadata>) => Partial<SeriesMetadata>
    ];
    return patch(existing);
  }

  beforeEach(() => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
      IntersectionObserverStub;
    updateSeriesMetadata.mockClear();
    emitSeriesMetadata(new Map());
  });

  afterEach(async () => {
    cleanup();
    await flushSpineOffsetWrites();
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = originalIO;
  });

  it('shift+wheel schedules one write with the new series offset', async () => {
    const { container } = render(CatalogItem, { props: { volumes: twoVolumes() } });
    const card = getCard(container);

    await fireEvent.mouseEnter(card);
    await fireEvent.wheel(card, { shiftKey: true, deltaY: -1 });
    await fireEvent.wheel(card, { shiftKey: true, deltaY: -1 });
    await fireEvent.wheel(card, { shiftKey: true, deltaY: -1 });

    await flushSpineOffsetWrites();

    // One coalesced write for the whole burst, carrying 3 × 0.25 %.
    expect(updateSeriesMetadata).toHaveBeenCalledTimes(1);
    expect(updateSeriesMetadata.mock.calls[0][0]).toBe('One Piece');
    expect(resolvePatch(0)).toEqual({ spine_offset: 0.75 });
  });

  it('seeds the series offset from the stored record', async () => {
    emitSeriesMetadata(meta({ spine_offset: 4 }));
    const { container } = render(CatalogItem, { props: { volumes: twoVolumes() } });
    const card = getCard(container);

    await fireEvent.mouseEnter(card);
    await fireEvent.wheel(card, { shiftKey: true, deltaY: 1 });
    await flushSpineOffsetWrites();

    expect(resolvePatch(0)).toEqual({ spine_offset: 3.75 });
  });

  it('shift+right-click resets the series offset', async () => {
    emitSeriesMetadata(meta({ spine_offset: 4 }));
    const { container } = render(CatalogItem, { props: { volumes: twoVolumes() } });
    const card = getCard(container);

    await fireEvent.mouseEnter(card);
    await fireEvent.contextMenu(card, { shiftKey: true });
    await flushSpineOffsetWrites();

    // `undefined` drops the field from the synced record.
    expect(resolvePatch(0, { spine_offset: 4 })).toEqual({ spine_offset: undefined });
  });

  it('alt+shift+wheel over the second volume writes volume_offsets keyed by ITS uuid', async () => {
    const { container } = render(CatalogItem, { props: { volumes: twoVolumes() } });
    const card = getCard(container);

    await fireEvent.mouseEnter(card);
    // Past the right edge of every spine: the hit test falls back to the last volume.
    await fireEvent.mouseMove(card, { clientX: 4000, clientY: 10, shiftKey: true, altKey: true });
    await fireEvent.wheel(card, { shiftKey: true, altKey: true, deltaY: -1 });
    await fireEvent.wheel(card, { shiftKey: true, altKey: true, deltaY: -1 });
    await flushSpineOffsetWrites();

    expect(updateSeriesMetadata).toHaveBeenCalledTimes(1);
    expect(resolvePatch(0)).toEqual({ volume_offsets: { 'uuid-1': 2 } });
  });

  it('alt+shift+right-click over a volume clears that volume key only', async () => {
    emitSeriesMetadata(meta({ volume_offsets: { 'uuid-0': 3, 'uuid-1': -5 } }));
    const { container } = render(CatalogItem, { props: { volumes: twoVolumes() } });
    const card = getCard(container);

    await fireEvent.mouseEnter(card);
    await fireEvent.mouseMove(card, { clientX: 4000, clientY: 10, shiftKey: true, altKey: true });
    await fireEvent.contextMenu(card, { shiftKey: true, altKey: true });
    await flushSpineOffsetWrites();

    expect(resolvePatch(0, { volume_offsets: { 'uuid-0': 3, 'uuid-1': -5 } })).toEqual({
      volume_offsets: { 'uuid-0': 3 }
    });
  });

  it('writes nothing without the modifier keys', async () => {
    const { container } = render(CatalogItem, { props: { volumes: twoVolumes() } });
    const card = getCard(container);

    await fireEvent.mouseEnter(card);
    await fireEvent.wheel(card, { deltaY: -1 });
    await fireEvent.contextMenu(card, {});
    await flushSpineOffsetWrites();

    expect(updateSeriesMetadata).not.toHaveBeenCalled();
  });
});
