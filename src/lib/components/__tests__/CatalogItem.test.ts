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
import { updateCatalogSetting } from '$lib/settings/settings';

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
    localVolume({ volume_uuid: 'uuid-0', thumbnail_width: 250, thumbnail_height: 360 }),
    localVolume({ volume_uuid: 'uuid-1', thumbnail_width: 250, thumbnail_height: 360 })
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
    return localVolume({ thumbnail_width: 250, thumbnail_height: 360, ...overrides });
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

  it('draws no badge while any volume is installed', () => {
    const { container } = render(CatalogItem, {
      props: {
        volumes: [cover(), cover({ volume_uuid: 'uuid-2', metadata_only: true })]
      }
    });
    expect(badges(container)).toHaveLength(0);
  });

  it('draws one badge when every volume is metadata-only', () => {
    const { container } = render(CatalogItem, {
      props: {
        volumes: [
          cover({ metadata_only: true }),
          cover({ volume_uuid: 'uuid-2', metadata_only: true })
        ]
      }
    });
    expect(badges(container)).toHaveLength(1);
  });

  it('draws one badge for a cloud-only (placeholder) series, as before', () => {
    const { container } = render(CatalogItem, {
      props: {
        volumes: [placeholderVolume({ thumbnail_width: 250, thumbnail_height: 360 })]
      }
    });
    expect(badges(container)).toHaveLength(1);
  });

  it('never intercepts the card click', () => {
    const { container } = render(CatalogItem, {
      props: { volumes: [cover({ metadata_only: true })] }
    });
    const badge = badges(container)[0] as HTMLElement;
    expect(badge.className).toContain('pointer-events-none');
  });

  it('marks the card whose covers have not arrived', () => {
    // No thumbnail dimensions: the card falls back to its download boxes, which must
    // carry the mark too — it is not tied to the CompositeCanvas branch.
    const { container } = render(CatalogItem, {
      props: { volumes: [localVolume({ metadata_only: true })] }
    });
    expect(container.textContent).toContain('Click to download');
    expect(badges(container)).toHaveLength(1);
  });

  it('names the mark for screen readers — on a card it is the only cue', () => {
    const { container } = render(CatalogItem, {
      props: { volumes: [cover({ metadata_only: true })] }
    });
    const badge = badges(container)[0] as HTMLElement;
    expect(badge.querySelector('.sr-only')?.textContent).toBe('Not on this device');
    expect(badge.getAttribute('aria-hidden')).toBeNull();
    expect(badge.getAttribute('title')).toBeNull();
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
    localVolume({ thumbnail_width: 250, thumbnail_height: 360, ...overrides });
  const cloudCover = (overrides: Partial<VolumeMetadata> = {}) =>
    placeholderVolume({ thumbnail_width: 250, thumbnail_height: 360, ...overrides });

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
      chip: card.querySelector('p.text-xs')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
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
      chip: '2 volumes in Drive',
      badges: 1
    });
  });

  it('leaves a series with something to read alone', () => {
    const { container } = render(CatalogItem, {
      props: { volumes: [cover(), cover({ volume_uuid: 'm-2', metadata_only: true })] }
    });
    expect(identity(container)).toEqual({
      dimmed: false,
      mutedTitle: false,
      chip: null,
      badges: 0
    });
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

  it('does not double-mark: an all-absent series keeps the one card-level mark', () => {
    const { container } = render(CatalogItem, {
      props: {
        volumes: [
          painted({ volume_uuid: 'v-1', metadata_only: true }),
          painted({ volume_uuid: 'v-2', metadata_only: true }),
          painted({ volume_uuid: 'v-3', metadata_only: true })
        ]
      }
    });
    expect(badges(container)).toHaveLength(1);
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

  it('marks nothing for a cloud-only volume, which a part-local card never stacks', () => {
    // selectCardStackVolumes stacks the local volumes of a series that has any; a
    // cloud-only volume of such a series is not drawn, so there is no spine to mark.
    const { container } = render(CatalogItem, {
      props: {
        volumes: [
          painted({ volume_uuid: 'v-1' }),
          painted({ volume_uuid: 'v-2', isPlaceholder: true })
        ]
      }
    });
    expect(badges(container)).toHaveLength(0);
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
