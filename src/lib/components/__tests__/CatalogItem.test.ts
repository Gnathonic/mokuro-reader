import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';

// vi.hoisted: the vi.mock factories below run before this module's own imports, so the
// spy they close over has to be created here rather than via a later top-level const.
const { promptSeriesEditor, promptSeriesRemoval } = vi.hoisted(() => ({
  promptSeriesEditor: vi.fn(),
  promptSeriesRemoval: vi.fn(async (_volumes: unknown[], _options?: unknown) => true)
}));
vi.mock('$lib/util/modals', () => ({ promptSeriesEditor, promptConfirmation: vi.fn() }));
// The removal flow itself is tested in $lib/catalog/series-delete.test.ts; the card's job
// is to hand it this series' volumes and nothing else.
vi.mock('$lib/catalog/series-delete', () => ({ promptSeriesRemoval }));

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

// What the card actually asked to be drawn. Transparent pass-through: records the props,
// then renders the real component (same trick as the spine shelf's suite).
const { compositeCanvasProps } = vi.hoisted(() => ({
  compositeCanvasProps: [] as Record<string, unknown>[]
}));
vi.mock('$lib/components/CompositeCanvas.svelte', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const Real = actual.default as (anchor: unknown, props: Record<string, unknown>) => unknown;
  return {
    ...actual,
    default: (anchor: unknown, props: Record<string, unknown>) => {
      compositeCanvasProps.push(props);
      return Real(anchor, props);
    }
  };
});

// The card reads/writes spine offsets through the series metadata store; stub the store
// (not `spine-offsets`) so the real debounce + patch building are exercised, without
// Dexie/liveQuery. `emitSeriesMetadata` plays the part of a liveQuery emission.
const { updateSeriesMetadata, emitSeriesMetadata, seriesMetadataMap } = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const subscribers = new Set<(v: Map<string, Row>) => void>();
  let value = new Map<string, Row>();
  return {
    updateSeriesMetadata: vi.fn(
      async (_seriesTitle: string, _patch: unknown): Promise<unknown> => undefined
    ),
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

// Everything else in spine-offsets stays real; `volumeOffsetsByIndex` is spied on because
// its call count is the observable signal of the stack layout being recomputed.
vi.mock('$lib/metadata/spine-offsets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/metadata/spine-offsets')>();
  return { ...actual, volumeOffsetsByIndex: vi.fn(actual.volumeOffsetsByIndex) };
});

import { tick } from 'svelte';
import CatalogItem from '../CatalogItem.svelte';
import type { VolumeMetadata } from '$lib/types';
import type { SeriesMetadata } from '$lib/metadata/types';
import { flushSpineOffsetWrites, volumeOffsetsByIndex } from '$lib/metadata/spine-offsets';
import { fetchCloudThumbnail } from '$lib/catalog/cloud-thumbnails';
import { updateCatalogSetting } from '$lib/settings/settings';
import { updateProgress } from '$lib/settings';

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

/**
 * The cover a row's stored dimensions describe. Dimensions never travel without one:
 * every writer sets `thumbnail`, `thumbnail_width` and `thumbnail_height` together, and
 * the card only counts a volume as drawable once it has pixels (CompositeCanvas paints
 * nothing for a volume without them).
 */
function coverFile(): File {
  return new File([], 'cover.jpg', { type: 'image/jpeg' });
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
    return localVolume({
      thumbnail: coverFile(),
      thumbnail_width: 250,
      thumbnail_height: 360,
      ...overrides
    });
  }

  const twoVolumes = () => [
    withThumbnail({ volume_uuid: 'uuid-0', volume_title: 'Vol 1' }),
    withThumbnail({ volume_uuid: 'uuid-1', volume_title: 'Vol 2' })
  ];

  function record(overrides: Partial<SeriesMetadata> = {}): Record<string, unknown> {
    return {
      series_key: 'one piece',
      series_title: 'One Piece',
      external_ids: {},
      titles: {},
      synonyms: [],
      read_count: 0,
      updated_at: '2026-01-01T00:00:00.000Z',
      ...overrides
    };
  }

  function meta(overrides: Partial<SeriesMetadata> = {}): Map<string, Record<string, unknown>> {
    return new Map([['one piece', record(overrides)]]);
  }

  /** The width the card sized its stack to — the visible effect of the series offset. */
  function stackWidth(container: HTMLElement): string {
    const el = container.querySelector('div.overflow-hidden');
    if (!el) throw new Error('stack container not found');
    return (el as HTMLElement).style.width;
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

  it('takes the wheel direction from deltaX when shift moved it there', async () => {
    // Chrome reports a shift+wheel as horizontal scrolling: deltaY is 0 and the whole
    // gesture arrives on deltaX.
    const { container } = render(CatalogItem, { props: { volumes: twoVolumes() } });
    const card = getCard(container);

    await fireEvent.mouseEnter(card);
    await fireEvent.wheel(card, { shiftKey: true, deltaX: 1, deltaY: 0 });
    await flushSpineOffsetWrites();

    expect(resolvePatch(0)).toEqual({ spine_offset: -0.25 });
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

  it('hit-tests where the canvas actually painted, not where centering would put it', async () => {
    // The canvas pins the stack's RIGHT edge to the container (`alignShift`); the hit test
    // used the centering inset instead. On a stack whose last spine is narrower than the
    // first, the two are ~139px apart — the pointer sits over volume 1's cover and the
    // nudge lands on volume 2.
    const mixedWidths = [
      withThumbnail({ volume_uuid: 'uuid-0', volume_title: 'Vol 1' }),
      withThumbnail({ volume_uuid: 'uuid-1', volume_title: 'Vol 2', thumbnail_width: 125 })
    ];
    const { container } = render(CatalogItem, { props: { volumes: mixedWidths } });
    const card = getCard(container);

    await fireEvent.mouseEnter(card);
    // Inside the painted first spine (drawn from x=152.5 across 250px, on top of the
    // narrower second one).
    await fireEvent.mouseMove(card, { clientX: 290, clientY: 10, shiftKey: true, altKey: true });
    await fireEvent.wheel(card, { shiftKey: true, altKey: true, deltaY: -1 });
    await flushSpineOffsetWrites();

    expect(resolvePatch(0)).toEqual({ volume_offsets: { 'uuid-0': 1 } });
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

  it('writes nothing for a wheel that carries no delta', async () => {
    // A stationary wheel (and some trackpad/inertia end events) reports 0 on both axes;
    // reading a direction off that would nudge the offset on every stray event.
    const { container } = render(CatalogItem, { props: { volumes: twoVolumes() } });
    const card = getCard(container);

    await fireEvent.mouseEnter(card);
    await fireEvent.wheel(card, { shiftKey: true, deltaY: 0, deltaX: 0 });
    await fireEvent.mouseMove(card, { clientX: 4000, clientY: 10, shiftKey: true, altKey: true });
    await fireEvent.wheel(card, { shiftKey: true, altKey: true, deltaY: 0, deltaX: 0 });
    await flushSpineOffsetWrites();

    expect(updateSeriesMetadata).not.toHaveBeenCalled();
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

describe('CatalogItem spine offset resync is stable', () => {
  class IntersectionObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  const originalIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;

  function record(overrides: Partial<SeriesMetadata> = {}): Record<string, unknown> {
    return {
      series_key: 'one piece',
      series_title: 'One Piece',
      external_ids: {},
      titles: {},
      synonyms: [],
      read_count: 0,
      updated_at: '2026-01-01T00:00:00.000Z',
      ...overrides
    };
  }

  const metaMap = (overrides: Partial<SeriesMetadata> = {}) =>
    new Map([['one piece', record(overrides)]]);

  const volumes = () => [
    localVolume({
      volume_uuid: 'uuid-0',
      thumbnail: coverFile(),
      thumbnail_width: 250,
      thumbnail_height: 360
    }),
    localVolume({
      volume_uuid: 'uuid-1',
      thumbnail: coverFile(),
      thumbnail_width: 250,
      thumbnail_height: 360
    })
  ];

  function stackWidth(container: HTMLElement): string {
    const el = container.querySelector('div.overflow-hidden');
    if (!el) throw new Error('stack container not found');
    return (el as HTMLElement).style.width;
  }

  beforeEach(() => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
      IntersectionObserverStub;
    updateSeriesMetadata.mockClear();
    vi.mocked(volumeOffsetsByIndex).mockClear();
    emitSeriesMetadata(new Map());
  });

  afterEach(async () => {
    cleanup();
    await flushSpineOffsetWrites();
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = originalIO;
  });

  it('keeps the gesture value when the PRE-write record is emitted after the write lands', async () => {
    emitSeriesMetadata(metaMap({ spine_offset: 4 }));
    const { container } = render(CatalogItem, { props: { volumes: volumes() } });
    const card = getCard(container);
    const seeded = stackWidth(container);

    // The store's write resolves when its transaction commits; the liveQuery emission
    // carrying the new record arrives later.
    updateSeriesMetadata.mockImplementationOnce(async () =>
      record({ spine_offset: 4.25, updated_at: '2026-01-02T00:00:00.000Z' })
    );
    await fireEvent.mouseEnter(card);
    await fireEvent.wheel(card, { shiftKey: true, deltaY: -1 });
    const nudged = stackWidth(container);
    expect(nudged).not.toBe(seeded);

    await flushSpineOffsetWrites();
    await tick();
    await tick();

    // Stale echo: the record as it was BEFORE our write.
    emitSeriesMetadata(metaMap({ spine_offset: 4 }));
    await tick();
    expect(stackWidth(container)).toBe(nudged);

    // Our own write finally comes back around — same value, and it settles there.
    emitSeriesMetadata(metaMap({ spine_offset: 4.25, updated_at: '2026-01-02T00:00:00.000Z' }));
    await tick();
    expect(stackWidth(container)).toBe(nudged);
  });

  it('adopts a genuinely newer record from another writer', async () => {
    emitSeriesMetadata(metaMap({ spine_offset: 4 }));
    const { container } = render(CatalogItem, { props: { volumes: volumes() } });
    const card = getCard(container);
    const seeded = stackWidth(container);

    updateSeriesMetadata.mockImplementationOnce(async () =>
      record({ spine_offset: 4.25, updated_at: '2026-01-02T00:00:00.000Z' })
    );
    await fireEvent.mouseEnter(card);
    await fireEvent.wheel(card, { shiftKey: true, deltaY: -1 });
    await flushSpineOffsetWrites();
    await tick();
    await tick();

    // Another device wrote after us: strictly newer, so the guard must not wedge.
    emitSeriesMetadata(metaMap({ spine_offset: 4, updated_at: '2026-01-03T00:00:00.000Z' }));
    await tick();
    expect(stackWidth(container)).toBe(seeded);
  });

  it('an equal re-emission does not recompute the stack layout', async () => {
    emitSeriesMetadata(metaMap({ volume_offsets: { 'uuid-1': 6 } }));
    const { container } = render(CatalogItem, { props: { volumes: volumes() } });
    await tick();
    const calls = vi.mocked(volumeOffsetsByIndex).mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    const width = stackWidth(container);

    // Any metadata write re-emits the whole table: same values for this series, fresh
    // objects. Nothing about this card changed, so nothing may be recomputed.
    emitSeriesMetadata(metaMap({ volume_offsets: { 'uuid-1': 6 } }));
    await tick();
    emitSeriesMetadata(metaMap({ volume_offsets: { 'uuid-1': 6 } }));
    await tick();

    expect(vi.mocked(volumeOffsetsByIndex).mock.calls.length).toBe(calls);
    expect(stackWidth(container)).toBe(width);
  });

  it('skips the write when a reset gesture lands on what is already stored', async () => {
    const { container } = render(CatalogItem, { props: { volumes: volumes() } });
    const card = getCard(container);

    await fireEvent.mouseEnter(card);
    // No record at all, no local offset: both resets are no-ops.
    await fireEvent.contextMenu(card, { shiftKey: true });
    await fireEvent.mouseMove(card, { clientX: 4000, clientY: 10, shiftKey: true, altKey: true });
    await fireEvent.contextMenu(card, { shiftKey: true, altKey: true });
    await flushSpineOffsetWrites();

    expect(updateSeriesMetadata).not.toHaveBeenCalled();
  });
});

describe('CatalogItem marks a series whose volumes are all absent', () => {
  // The badge rides on the drawn cover stack, which needs thumbnail dimensions and a
  // (no-op) IntersectionObserver for CompositeCanvas — same setup as the offset suites.
  class IntersectionObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  const originalIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;

  function cover(overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
    return localVolume({
      thumbnail: coverFile(),
      thumbnail_width: 250,
      thumbnail_height: 360,
      ...overrides
    });
  }

  beforeEach(() => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
      IntersectionObserverStub;
    emitSeriesMetadata(new Map());
  });

  afterEach(() => {
    cleanup();
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = originalIO;
  });

  function badges(container: HTMLElement) {
    return container.querySelectorAll('[data-testid="download-badge"]');
  }

  function cloudMarks(container: HTMLElement) {
    return container.querySelectorAll('[data-testid="cloud-card-mark"]');
  }

  it('draws no cloud mark while any volume is installed', () => {
    const { container } = render(CatalogItem, {
      props: {
        volumes: [cover(), cover({ volume_uuid: 'uuid-2', metadata_only: true })]
      }
    });
    expect(cloudMarks(container)).toHaveLength(0);
  });

  it('draws the cloud mark when every volume is metadata-only', () => {
    const { container } = render(CatalogItem, {
      props: {
        volumes: [
          cover({ metadata_only: true }),
          cover({ volume_uuid: 'uuid-2', metadata_only: true })
        ]
      }
    });
    // The cloud card's own mark, not the per-spine badge: an absent series is marked the
    // way cloud series have always been marked.
    expect(cloudMarks(container)).toHaveLength(1);
    expect(badges(container)).toHaveLength(0);
  });

  it('draws the same mark for a cloud-only (placeholder) series, as before', () => {
    const { container } = render(CatalogItem, {
      props: {
        volumes: [
          placeholderVolume({
            thumbnail: coverFile(),
            thumbnail_width: 250,
            thumbnail_height: 360
          })
        ]
      }
    });
    expect(cloudMarks(container)).toHaveLength(1);
    expect(badges(container)).toHaveLength(0);
  });

  it('never intercepts the card click', () => {
    const { container } = render(CatalogItem, {
      props: { volumes: [cover({ metadata_only: true })] }
    });
    const mark = cloudMarks(container)[0] as HTMLElement;
    expect(mark.className).toContain('pointer-events-none');
  });

  it('lets the download box speak for itself when no cover has arrived', () => {
    // No thumbnail dimensions: the card falls back to its download boxes. The 64px icon
    // and its caption ARE the mark — a corner glyph on top would only repeat them.
    const { container } = render(CatalogItem, {
      props: { volumes: [localVolume({ metadata_only: true })] }
    });
    expect(container.textContent).toContain('Click to download');
    expect(cloudMarks(container)).toHaveLength(0);
    expect(badges(container)).toHaveLength(0);
  });

  it('names the mark for screen readers — on a card it is the only cue', () => {
    const { container } = render(CatalogItem, {
      props: { volumes: [cover({ metadata_only: true })] }
    });
    const mark = cloudMarks(container)[0] as HTMLElement;
    expect(mark.querySelector('.sr-only')?.textContent).toBe('Not on this device');
    expect(mark.getAttribute('aria-hidden')).toBeNull();
  });
});

describe('CatalogItem hover + Delete raises the series removal dialog', () => {
  beforeEach(() => {
    promptSeriesRemoval.mockClear();
  });

  afterEach(() => {
    cleanup();
    document.querySelectorAll('dialog').forEach((el) => el.remove());
  });

  it('removes the hovered series, handing over its volumes', async () => {
    const volumes = [localVolume(), localVolume({ volume_uuid: 'uuid-2' })];
    const { container } = render(CatalogItem, { props: { volumes } });
    const card = getCard(container);

    await fireEvent.mouseEnter(card);
    await fireEvent.keyDown(window, { key: 'Delete' });

    expect(promptSeriesRemoval).toHaveBeenCalledTimes(1);
    expect(promptSeriesRemoval.mock.calls[0][0]).toEqual(volumes);
  });

  it('does nothing when the card is not hovered', async () => {
    render(CatalogItem, { props: { volumes: [localVolume()] } });
    await fireEvent.keyDown(window, { key: 'Delete' });
    expect(promptSeriesRemoval).not.toHaveBeenCalled();
  });

  it('does nothing while a search input has focus', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    const { container } = render(CatalogItem, { props: { volumes: [localVolume()] } });
    await fireEvent.mouseEnter(getCard(container));
    await fireEvent.keyDown(window, { key: 'Delete' });

    expect(promptSeriesRemoval).not.toHaveBeenCalled();
    input.remove();
  });

  it('ignores key repeats, so holding Delete cannot stack dialogs', async () => {
    const { container } = render(CatalogItem, { props: { volumes: [localVolume()] } });
    await fireEvent.mouseEnter(getCard(container));

    await fireEvent.keyDown(window, { key: 'Delete' });
    await fireEvent.keyDown(window, { key: 'Delete', repeat: true });

    expect(promptSeriesRemoval).toHaveBeenCalledTimes(1);
  });

  it('does not fire while a modal is already open', async () => {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    document.body.appendChild(dialog);

    const { container } = render(CatalogItem, { props: { volumes: [localVolume()] } });
    await fireEvent.mouseEnter(getCard(container));
    await fireEvent.keyDown(window, { key: 'Delete' });

    expect(promptSeriesRemoval).not.toHaveBeenCalled();
  });

  it('stops listening once the mouse leaves the card', async () => {
    const { container } = render(CatalogItem, { props: { volumes: [localVolume()] } });
    const card = getCard(container);

    await fireEvent.mouseEnter(card);
    await fireEvent.mouseLeave(card);
    await fireEvent.keyDown(window, { key: 'Delete' });

    expect(promptSeriesRemoval).not.toHaveBeenCalled();
  });
});

describe('CatalogItem gives an all-absent series the placeholder identity', () => {
  class IntersectionObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  const originalIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;

  const cover = (overrides: Partial<VolumeMetadata> = {}) =>
    localVolume({
      thumbnail: coverFile(),
      thumbnail_width: 250,
      thumbnail_height: 360,
      ...overrides
    });
  const cloudCover = (overrides: Partial<VolumeMetadata> = {}) =>
    placeholderVolume({
      thumbnail: coverFile(),
      thumbnail_width: 250,
      thumbnail_height: 360,
      ...overrides
    });

  beforeEach(() => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
      IntersectionObserverStub;
    emitSeriesMetadata(new Map());
  });

  afterEach(() => {
    cleanup();
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = originalIO;
  });

  /** The cues that say WHAT KIND of series this card is (not what data it happens to hold). */
  function identity(container: HTMLElement) {
    const card = getCard(container);
    const title = card.querySelector('p.line-clamp-2') as HTMLElement | null;
    return {
      dimmed: card.className.includes('opacity-70'),
      mutedTitle: title?.className.includes('text-gray-400') ?? false,
      // The read marker: the one thing a series with history may say that a cloud-only
      // one cannot. Tracked here so a refactor cannot quietly drop it.
      greenTitle: card.className.includes('text-green-400'),
      chip: card.querySelector('p.text-xs')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      cloudMarks: card.querySelectorAll('[data-testid="cloud-card-mark"]').length,
      badges: card.querySelectorAll('[data-testid="download-badge"]').length
    };
  }

  it('reads exactly like a cloud-only series of the same size', () => {
    const cloud = render(CatalogItem, {
      props: {
        volumes: [cloudCover({ volume_uuid: 'p-1' }), cloudCover({ volume_uuid: 'p-2' })],
        providerName: 'Drive'
      }
    });
    const placeholderIdentity = identity(cloud.container);
    cleanup();

    const removed = render(CatalogItem, {
      props: {
        volumes: [
          cover({ volume_uuid: 'm-1', metadata_only: true }),
          cover({ volume_uuid: 'm-2', metadata_only: true })
        ],
        providerName: 'Drive'
      }
    });

    expect(identity(removed.container)).toEqual(placeholderIdentity);
    expect(placeholderIdentity).toEqual({
      dimmed: true,
      mutedTitle: true,
      greenTitle: false,
      chip: '2 volumes in Drive',
      cloudMarks: 1,
      badges: 0
    });
  });

  it('leaves a series with something to read alone', () => {
    const { container } = render(CatalogItem, {
      props: { volumes: [cover(), cover({ volume_uuid: 'm-2', metadata_only: true })] }
    });
    expect(identity(container)).toEqual({
      dimmed: false,
      mutedTitle: false,
      greenTitle: false,
      chip: null,
      // None of the CLOUD CARD's identity: no dimming, no muted title, no volume-count
      // chip and no corner mark. The one absent volume keeps its own spine badge — that
      // is the per-volume mark, which is exactly what a partly-here series should show.
      cloudMarks: 0,
      badges: 1
    });
  });

  it('still shows the read marker on a removed series that was finished', () => {
    // Exception #2 to the identity rule: progress is data, and a series whose pages are
    // gone still knows it was read. The muted grey yields to the green.
    updateProgress('m-1', 10, 0, true);
    try {
      const { container } = render(CatalogItem, {
        props: {
          volumes: [cover({ volume_uuid: 'm-1', metadata_only: true })],
          providerName: 'Drive'
        }
      });

      expect(identity(container)).toEqual({
        dimmed: true,
        mutedTitle: false,
        greenTitle: true,
        chip: '1 volume in Drive',
        cloudMarks: 1,
        badges: 0
      });
    } finally {
      updateProgress('m-1', 0, 0, false);
    }
  });

  it('keeps the series editor shortcut and the link working on a removed series', async () => {
    const { container } = render(CatalogItem, {
      props: { volumes: [cover({ metadata_only: true })] }
    });
    const card = getCard(container);

    await fireEvent.mouseEnter(card);
    await fireEvent.keyDown(window, { key: 'e' });

    expect(promptSeriesEditor).toHaveBeenCalledWith('One Piece');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('#/series/One%20Piece');
  });

  /** The width the card sized its cover stack to — the shape of the stacking treatment. */
  function stackWidth(container: HTMLElement): string {
    const el = container.querySelector('div.overflow-hidden');
    if (!el) throw new Error('stack container not found');
    return (el as HTMLElement).style.width;
  }

  it('stacks like a cloud series, compact-cloud setting included', () => {
    // "Compact cloud-only series" collapses a cloud card to a single cover. A series with
    // nothing on the device IS a cloud series, so it must collapse identically.
    updateCatalogSetting('compactCloudSeries', true);
    try {
      const cloud = render(CatalogItem, {
        props: {
          volumes: [
            cloudCover({ volume_uuid: 'p-1' }),
            cloudCover({ volume_uuid: 'p-2' }),
            cloudCover({ volume_uuid: 'p-3' })
          ]
        }
      });
      const cloudWidth = stackWidth(cloud.container);
      cleanup();

      const removed = render(CatalogItem, {
        props: {
          volumes: [
            cover({ volume_uuid: 'm-1', metadata_only: true }),
            cover({ volume_uuid: 'm-2', metadata_only: true }),
            cover({ volume_uuid: 'm-3', metadata_only: true })
          ]
        }
      });
      expect(stackWidth(removed.container)).toBe(cloudWidth);
    } finally {
      updateCatalogSetting('compactCloudSeries', false);
    }
  });

  it('offers the download boxes, not "Generating…", when no cover has arrived', () => {
    const { container } = render(CatalogItem, {
      props: { volumes: [localVolume({ metadata_only: true })] }
    });
    expect(container.textContent).toContain('Click to download');
    expect(container.textContent).not.toContain('Generating');
  });
});

describe('CatalogItem marks the absent volumes inside a mostly-local stack', () => {
  class IntersectionObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  const originalIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;

  /** A volume the card's canvas actually paints: real dimensions AND pixels. */
  const painted = (overrides: Partial<VolumeMetadata> = {}) =>
    localVolume({
      thumbnail_width: 250,
      thumbnail_height: 360,
      thumbnail: new File([], 'cover.jpg', { type: 'image/jpeg' }),
      ...overrides
    });

  beforeEach(() => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
      IntersectionObserverStub;
    emitSeriesMetadata(new Map());
  });

  afterEach(() => {
    cleanup();
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = originalIO;
  });

  function badges(container: HTMLElement) {
    return [...container.querySelectorAll('[data-testid="download-badge"]')] as HTMLElement[];
  }

  it('badges only the spines whose volumes are not on this device', () => {
    // Volume 1 is here, 2 and 3 are not — the user's own example.
    const { container } = render(CatalogItem, {
      props: {
        volumes: [
          painted({ volume_uuid: 'v-1', volume_title: 'Vol 1' }),
          painted({ volume_uuid: 'v-2', volume_title: 'Vol 2', metadata_only: true }),
          painted({ volume_uuid: 'v-3', volume_title: 'Vol 3', metadata_only: true })
        ]
      }
    });

    const marks = badges(container);
    expect(marks).toHaveLength(2);
    // Named, and named for the right volume: on this card nothing else says so.
    expect(marks.map((el) => el.querySelector('.sr-only')?.textContent)).toEqual([
      'Vol 2 not on this device',
      'Vol 3 not on this device'
    ]);
    expect(marks[0].getAttribute('aria-hidden')).toBeNull();
    // One per spine, at its own place in the stack.
    const lefts = marks.map((el) => el.style.left);
    expect(new Set(lefts).size).toBe(2);
    for (const mark of marks) {
      expect(mark.className).toContain('pointer-events-none');
      expect(mark.style.top).not.toBe('');
    }
  });

  it('leaves an all-local stack unmarked', () => {
    const { container } = render(CatalogItem, {
      props: {
        volumes: [
          painted({ volume_uuid: 'v-1' }),
          painted({ volume_uuid: 'v-2' }),
          painted({ volume_uuid: 'v-3' })
        ]
      }
    });
    expect(badges(container)).toHaveLength(0);
  });

  it('does not double-mark: an all-absent series keeps the cloud card mark alone', () => {
    const { container } = render(CatalogItem, {
      props: {
        volumes: [
          painted({ volume_uuid: 'v-1', metadata_only: true }),
          painted({ volume_uuid: 'v-2', metadata_only: true }),
          painted({ volume_uuid: 'v-3', metadata_only: true })
        ]
      }
    });
    expect(container.querySelectorAll('[data-testid="cloud-card-mark"]')).toHaveLength(1);
    expect(badges(container)).toHaveLength(0);
  });

  it('marks only what the stack actually shows', () => {
    // Default stack count is 3, so volumes 4 and 5 are not drawn — and an undrawn volume
    // gets no mark.
    const { container } = render(CatalogItem, {
      props: {
        volumes: [
          painted({ volume_uuid: 'v-1' }),
          painted({ volume_uuid: 'v-2' }),
          painted({ volume_uuid: 'v-3' }),
          painted({ volume_uuid: 'v-4', metadata_only: true }),
          painted({ volume_uuid: 'v-5', metadata_only: true })
        ]
      }
    });
    expect(badges(container)).toHaveLength(0);
  });

  it('marks the cloud-only volume of a part-local series, which the card does stack', () => {
    // The stack of a series that is only partly here includes its cloud-only volumes;
    // each one carries the mark rather than being left out of the card.
    const { container } = render(CatalogItem, {
      props: {
        volumes: [
          painted({ volume_uuid: 'v-1' }),
          painted({ volume_uuid: 'v-2', volume_title: 'Vol 2', isPlaceholder: true })
        ]
      }
    });
    const marks = badges(container);
    expect(marks).toHaveLength(1);
    expect(marks[0].querySelector('.sr-only')?.textContent).toBe('Vol 2 not on this device');
  });

  it('marks nothing over a spine the canvas never painted', () => {
    const { container } = render(CatalogItem, {
      props: {
        volumes: [
          painted({ volume_uuid: 'v-1' }),
          // Dimensions but no pixels: CompositeCanvas skips it, so a mark would float.
          localVolume({
            volume_uuid: 'v-2',
            thumbnail_width: 250,
            thumbnail_height: 360,
            metadata_only: true
          })
        ]
      }
    });
    expect(badges(container)).toHaveLength(0);
  });
});

describe('CatalogItem stacks the volumes of a series that is only partly here', () => {
  class IntersectionObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  const originalIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;

  const painted = (overrides: Partial<VolumeMetadata> = {}) =>
    localVolume({
      thumbnail_width: 250,
      thumbnail_height: 360,
      thumbnail: new File([], 'cover.jpg', { type: 'image/jpeg' }),
      ...overrides
    });

  /** A cloud-only volume: no local pixels, but a cover sidecar to fetch. */
  const cloudOnly = (overrides: Partial<VolumeMetadata> = {}) =>
    placeholderVolume({
      series_title: 'One Piece',
      cloudThumbnailFileId: `thumb-${overrides.volume_uuid ?? 'c'}`,
      ...overrides
    });

  beforeEach(() => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
      IntersectionObserverStub;
    emitSeriesMetadata(new Map());
    compositeCanvasProps.length = 0;
    vi.mocked(fetchCloudThumbnail).mockResolvedValue({
      file: new File([], 'cloud.jpg', { type: 'image/jpeg' }),
      width: 250,
      height: 360
    } as never);
    updateCatalogSetting('stackCount', 0);
  });

  afterEach(() => {
    cleanup();
    updateCatalogSetting('stackCount', 3);
    vi.mocked(fetchCloudThumbnail).mockReset();
    vi.mocked(fetchCloudThumbnail).mockResolvedValue(null as never);
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = originalIO;
  });

  function drawnUuids(): string[] {
    const props = compositeCanvasProps.at(-1);
    if (!props) throw new Error('CompositeCanvas was never mounted');
    return (props.volumes as VolumeMetadata[]).map((vol) => vol.volume_uuid);
  }

  const mixedSeries = () => [
    painted({ volume_uuid: 'v-1', volume_title: 'Vol 1' }),
    painted({ volume_uuid: 'v-2', volume_title: 'Vol 2' }),
    cloudOnly({ volume_uuid: 'c-3', volume_title: 'Vol 3' }),
    cloudOnly({ volume_uuid: 'c-4', volume_title: 'Vol 4' })
  ];

  it('draws its cloud-only volumes alongside the ones it has', async () => {
    render(CatalogItem, { props: { volumes: mixedSeries() } });
    await tick();

    expect(drawnUuids()).toEqual(['v-1', 'v-2', 'c-3', 'c-4']);
  });

  it('fetches the covers of those cloud-only volumes so they actually paint', async () => {
    const { container } = render(CatalogItem, { props: { volumes: mixedSeries() } });
    await vi.waitFor(() => expect(fetchCloudThumbnail).toHaveBeenCalledTimes(2));
    await tick();

    const props = compositeCanvasProps.at(-1) as { volumes: VolumeMetadata[] };
    const cloudSpines = props.volumes.filter((vol) => vol.volume_uuid.startsWith('c-'));
    expect(cloudSpines.every((vol) => !!vol.thumbnail)).toBe(true);
    // …and once painted, each carries the not-on-device mark.
    expect(container.querySelectorAll('[data-testid="download-badge"]')).toHaveLength(2);
  });

  it('asks for each missing cover once — the fetch must not feed itself', async () => {
    // The effect that fetches covers writes `cloudThumbnailData`. If its target list is
    // derived from the ENRICHED volumes (which carry that data), every arriving cover
    // re-runs it and re-requests everything still outstanding: quadratic fetches, a
    // permanently busy effect, and a frozen card.
    let resolvers: (() => void)[] = [];
    vi.mocked(fetchCloudThumbnail).mockImplementation(
      (vol) =>
        new Promise((resolve) => {
          resolvers.push(() =>
            resolve({
              file: new File([], `${vol.volume_uuid}.jpg`, { type: 'image/jpeg' }),
              width: 250,
              height: 360
            } as never)
          );
        })
    );

    render(CatalogItem, {
      props: {
        volumes: [
          painted({ volume_uuid: 'v-1', volume_title: 'Vol 1' }),
          ...Array.from({ length: 6 }, (_, i) =>
            cloudOnly({ volume_uuid: `c-${i + 2}`, volume_title: `Vol ${i + 2}` })
          )
        ]
      }
    });
    await tick();
    expect(fetchCloudThumbnail).toHaveBeenCalledTimes(6);

    // Let the covers land one at a time, the way a real listing does.
    for (const resolve of [...resolvers]) {
      resolve();
      await tick();
      await tick();
    }
    await tick();

    // Still six: one request per volume, no re-request storm as each one arrives.
    expect(fetchCloudThumbnail).toHaveBeenCalledTimes(6);
  });

  it('paints the metadata-only row it just fetched a cover for', async () => {
    // A row whose files were removed is drawn from the stack's LOCAL half, but
    // the cover fetch targets it too (no thumbnail, a cover sidecar in the
    // cloud). If only the placeholder half is enriched, the request is spent and
    // the spine stays blank — CompositeCanvas paints nothing without pixels.
    render(CatalogItem, {
      props: {
        volumes: [
          painted({ volume_uuid: 'v-1', volume_title: 'Vol 1' }),
          localVolume({
            volume_uuid: 'm-2',
            volume_title: 'Vol 2',
            metadata_only: true,
            cloudThumbnailFileId: 'thumb-m-2'
          })
        ]
      }
    });
    await vi.waitFor(() => expect(fetchCloudThumbnail).toHaveBeenCalledTimes(1));
    await tick();

    const props = compositeCanvasProps.at(-1) as { volumes: VolumeMetadata[] };
    expect(props.volumes.map((vol) => vol.volume_uuid)).toEqual(['v-1', 'm-2']);
    expect(props.volumes.filter((vol) => !vol.thumbnail)).toEqual([]);
  });

  it('keeps a volume that is missing from the middle in its own place', async () => {
    render(CatalogItem, {
      props: {
        volumes: [
          painted({ volume_uuid: 'v-1', volume_title: 'Vol 1' }),
          cloudOnly({ volume_uuid: 'c-2', volume_title: 'Vol 2' }),
          painted({ volume_uuid: 'v-3', volume_title: 'Vol 3' })
        ]
      }
    });
    await tick();

    expect(drawnUuids()).toEqual(['v-1', 'c-2', 'v-3']);
  });

  it('stacks AND paints every volume of a partly-here series, past the cloud cap', async () => {
    // The user's own shelf: 42 volumes, only the last one downloaded. The 25-cover cap is
    // for a series whose whole stack comes from the cloud; this one is stacked by the
    // local rules, all of it — and a spine with no cover fetched for it is a spine the
    // canvas never paints, so the covers have to be asked for too.
    const volumes = [
      ...Array.from({ length: 41 }, (_, i) =>
        cloudOnly({ volume_uuid: `c-${i + 1}`, volume_title: `Vol ${i + 1}` })
      ),
      painted({ volume_uuid: 'v-42', volume_title: 'Vol 42' })
    ];
    render(CatalogItem, { props: { volumes } });
    await vi.waitFor(() => expect(fetchCloudThumbnail).toHaveBeenCalledTimes(41));
    await tick();

    expect(drawnUuids()).toHaveLength(42);
    expect(drawnUuids().at(-1)).toBe('v-42');
    const props = compositeCanvasProps.at(-1) as { volumes: VolumeMetadata[] };
    // Every spine has pixels: nothing is silently trimmed out of the picture.
    expect(props.volumes.filter((vol) => !vol.thumbnail)).toEqual([]);
  });

  it('hides a finished volume of either kind when "hide read" is on', async () => {
    // Progress is keyed by uuid, and an indexed placeholder carries the volume's real one,
    // so a cloud volume can be finished on another device. "Hide read" must treat it like
    // any other finished volume.
    updateProgress('v-1', 10, 0, true);
    updateProgress('c-3', 10, 0, true);
    try {
      render(CatalogItem, {
        props: {
          volumes: [
            painted({ volume_uuid: 'v-1', volume_title: 'Vol 1' }),
            painted({ volume_uuid: 'v-2', volume_title: 'Vol 2' }),
            cloudOnly({ volume_uuid: 'c-3', volume_title: 'Vol 3', page_count: 10 }),
            cloudOnly({ volume_uuid: 'c-4', volume_title: 'Vol 4', page_count: 10 })
          ]
        }
      });
      await tick();

      expect(drawnUuids()).toEqual(['v-2', 'c-4']);
    } finally {
      updateProgress('v-1', 0, 0, false);
      updateProgress('c-3', 0, 0, false);
    }
  });

  it('keeps the cloud tail inside the stack count', async () => {
    updateCatalogSetting('stackCount', 3);
    render(CatalogItem, { props: { volumes: mixedSeries() } });
    await tick();

    expect(drawnUuids()).toEqual(['v-1', 'v-2', 'c-3']);
  });
});

/**
 * The freshly-downloaded-series bug: the card mounts while the series has no cover at
 * all, and the covers arrive afterwards — a thumbnail generated in the background, a
 * cover sidecar downloaded, a request that failed the first time.
 */
describe('CatalogItem draws the covers that arrive after it mounted', () => {
  class IntersectionObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  const originalIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;

  const bare = (overrides: Partial<VolumeMetadata> = {}) =>
    localVolume({ series_title: 'Fresh Series', ...overrides });
  const generated = (overrides: Partial<VolumeMetadata> = {}) =>
    localVolume({
      series_title: 'Fresh Series',
      thumbnail: coverFile(),
      thumbnail_width: 250,
      thumbnail_height: 360,
      ...overrides
    });
  const cloudOnly = (overrides: Partial<VolumeMetadata> = {}) =>
    placeholderVolume({
      series_title: 'Fresh Series',
      cloudThumbnailFileId: `thumb-${overrides.volume_uuid ?? 'c'}`,
      ...overrides
    });

  beforeEach(() => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
      IntersectionObserverStub;
    emitSeriesMetadata(new Map());
    compositeCanvasProps.length = 0;
    vi.mocked(fetchCloudThumbnail).mockReset();
    vi.mocked(fetchCloudThumbnail).mockResolvedValue(null as never);
  });

  afterEach(() => {
    cleanup();
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = originalIO;
  });

  it('replaces "Generating…" with the cover stack once the thumbnails commit', async () => {
    // Exactly what a download leaves behind: rows with pages but no cover yet.
    const { container, rerender } = render(CatalogItem, {
      props: { volumes: [bare({ volume_uuid: 'f-1' }), bare({ volume_uuid: 'f-2' })] }
    });
    await tick();
    expect(container.textContent).toContain('Generating');
    expect(container.querySelector('canvas')).toBeNull();

    // The background thumbnail pass writes the covers and the catalog re-emits the rows.
    await rerender({
      volumes: [generated({ volume_uuid: 'f-1' }), generated({ volume_uuid: 'f-2' })]
    });
    await tick();

    expect(container.textContent).not.toContain('Generating');
    const props = compositeCanvasProps.at(-1) as { volumes: VolumeMetadata[] };
    // Every volume handed to the canvas has pixels: a stack of dimensions with nothing
    // to paint is a correctly-sized, permanently empty box.
    expect(props.volumes.map((vol) => vol.volume_uuid)).toEqual(['f-1', 'f-2']);
    expect(props.volumes.filter((vol) => !vol.thumbnail)).toEqual([]);
  });

  it('asks again for a cover whose request produced nothing', async () => {
    // A saturated provider mid-bulk-download answers `null`, and nothing below caches
    // that. Spending the request on it is what leaves the card cover-less until it
    // remounts — the "no covers until I navigate away and back" report.
    vi.useFakeTimers();
    try {
      render(CatalogItem, {
        props: {
          volumes: [
            generated({ volume_uuid: 'f-1', volume_title: 'Vol 1' }),
            cloudOnly({ volume_uuid: 'c-2', volume_title: 'Vol 2' })
          ]
        }
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchCloudThumbnail).toHaveBeenCalledTimes(1);

      // The card asks again on its own — nothing else has to re-render it.
      await vi.advanceTimersByTimeAsync(2000);
      expect(fetchCloudThumbnail).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(8000);
      expect(fetchCloudThumbnail).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases a cover request that never landed, so a re-run can try once more', async () => {
    vi.useFakeTimers();
    try {
      render(CatalogItem, {
        props: {
          volumes: [
            generated({ volume_uuid: 'f-1', volume_title: 'Vol 1' }),
            cloudOnly({ volume_uuid: 'c-2', volume_title: 'Vol 2' })
          ]
        }
      });
      // Spend the whole retry schedule.
      await vi.advanceTimersByTimeAsync(11000);
      expect(fetchCloudThumbnail).toHaveBeenCalledTimes(3);

      // Anything re-runs the effect — during a bulk download the catalog emits constantly.
      updateCatalogSetting('horizontalStep', 12);
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchCloudThumbnail).toHaveBeenCalledTimes(4);
      updateCatalogSetting('horizontalStep', 11);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a cover that landed, and does not ask for it twice', async () => {
    vi.mocked(fetchCloudThumbnail).mockResolvedValue({
      file: new File([], 'cloud.jpg', { type: 'image/jpeg' }),
      width: 250,
      height: 360
    } as never);
    render(CatalogItem, {
      props: {
        volumes: [
          generated({ volume_uuid: 'f-1', volume_title: 'Vol 1' }),
          cloudOnly({ volume_uuid: 'c-2', volume_title: 'Vol 2' })
        ]
      }
    });
    await vi.waitFor(() => expect(fetchCloudThumbnail).toHaveBeenCalledTimes(1));
    await tick();

    updateCatalogSetting('horizontalStep', 12);
    await tick();
    await tick();

    expect(fetchCloudThumbnail).toHaveBeenCalledTimes(1);
    const props = compositeCanvasProps.at(-1) as { volumes: VolumeMetadata[] };
    expect(props.volumes.filter((vol) => !vol.thumbnail)).toEqual([]);
    updateCatalogSetting('horizontalStep', 11);
  });
});
