import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  installIntersectionObserverStub,
  IntersectionObserverStub
} from '$lib/catalog/__tests__/intersection-observer-stub';
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

// The card imports `showSnackbar` off the `$lib/util` barrel, which also re-exports the
// google-drive/backup/activity-tracker modules — mock it down to just that one export so
// none of that graph loads for a test about hover shortcuts and spine offsets.
const { showSnackbar } = vi.hoisted(() => ({ showSnackbar: vi.fn() }));
vi.mock('$lib/util', () => ({ showSnackbar }));

// No active provider by default — every existing test in this file relies on the spine
// offset gestures staying unrestricted, which is `canEditSeriesMetadata`'s default in
// that state. The gating describe block below overrides this per test.
const { providerStatus } = vi.hoisted(() => {
  function createStore<T>(initial: T) {
    let value = initial;
    return {
      subscribe(fn: (v: T) => void) {
        fn(value);
        return () => {};
      },
      set(v: T) {
        value = v;
      }
    };
  }
  return {
    providerStatus: createStore({
      providers: {} as Record<string, { metadataPermissions?: unknown } | null>,
      currentProviderType: null as string | null
    })
  };
});
vi.mock('$lib/util/sync', () => ({ providerManager: { status: providerStatus } }));

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
// Cover fetching/delivery is `cover-service.ts`'s job now (its own decision
// tree, dedupe, retry and persistence are covered end to end in
// `cover-service.test.ts`/`cover-service.retry.test.ts` against a real
// Dexie). This file's job is only the WIRING: does the card ask for a cover
// for exactly the volumes that need one. The real `cover-service.ts` pulls in
// db/materialize/unified-cloud-manager — a graph this file deliberately does
// not load (same reason `cloud-thumbnails`/`download-queue` are stubbed
// below) — so `isCoverFetchTarget` is reimplemented here as the same small
// pure predicate (no-thumbnail-yet gating; this file's fixtures never
// exercise the stale-row-mismatch branch, which is `cover-service.test.ts`'s
// job to pin).
const { requestCoverMock, isCoverFetchTargetMock } = vi.hoisted(() => ({
  requestCoverMock: vi.fn(),
  isCoverFetchTargetMock: vi.fn(
    (vol: { thumbnail?: unknown; isPlaceholder?: boolean; cloudThumbnailFileId?: string }) => {
      if (vol.thumbnail) return false;
      if (vol.isPlaceholder) return true;
      return !!vol.cloudThumbnailFileId;
    }
  )
}));
vi.mock('$lib/catalog/cover-service', () => ({
  requestCover: (...a: Parameters<typeof requestCoverMock>) => requestCoverMock(...a),
  isCoverFetchTarget: (...a: Parameters<typeof isCoverFetchTargetMock>) =>
    isCoverFetchTargetMock(...a)
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

// Every mounted CatalogItem's own cover-request effect calls this, whether or
// not a given describe block cares — cleared before EVERY test in the file
// (not just the ones that assert on it) so calls never carry over between
// unrelated tests.
beforeEach(() => {
  requestCoverMock.mockClear();
});

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

    // An explicit 0, not a deleted field: absent means "no opinion", which would
    // inherit the alignment another device published in series.json.
    expect(resolvePatch(0, { spine_offset: 4 })).toEqual({ spine_offset: 0 });
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

  it('alt+shift+right-click over a volume zeroes that volume key only', async () => {
    emitSeriesMetadata(meta({ volume_offsets: { 'uuid-0': 3, 'uuid-1': -5 } }));
    const { container } = render(CatalogItem, { props: { volumes: twoVolumes() } });
    const card = getCard(container);

    await fireEvent.mouseEnter(card);
    await fireEvent.mouseMove(card, { clientX: 4000, clientY: 10, shiftKey: true, altKey: true });
    await fireEvent.contextMenu(card, { shiftKey: true, altKey: true });
    await flushSpineOffsetWrites();

    expect(resolvePatch(0, { volume_offsets: { 'uuid-0': 3, 'uuid-1': -5 } })).toEqual({
      volume_offsets: { 'uuid-0': 3, 'uuid-1': 0 }
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

describe('CatalogItem spine-offset gestures respect the per-series metadata edit scope', () => {
  // Same fixture shape as "CatalogItem spine offsets persist to the series metadata" —
  // duplicated locally (not shared) so this describe's isolation doesn't depend on that
  // one's ordering.
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

  /** The width the card sized its stack to — the visible effect of the series offset. */
  function stackWidth(container: HTMLElement): string {
    const el = container.querySelector('div.overflow-hidden');
    if (!el) throw new Error('stack container not found');
    return (el as HTMLElement).style.width;
  }

  function setScopeNone() {
    providerStatus.set({
      providers: { webdav: { metadataPermissions: { scope: 'none' } } },
      currentProviderType: 'webdav'
    });
  }

  // The snackbar cooldown (see CatalogItem.svelte) lives in module scope, shared across
  // every card instance and every test in this file — not reset between tests. Each test
  // here anchors the fake clock at its OWN far-apart slot (well past the cooldown window
  // either side) so one test's gated gesture can never suppress or be suppressed by
  // another's, regardless of run order or real wall-clock speed.
  const FAKE_TIME_SLOT_MS = 60_000; // » the 4s snackbar cooldown
  let fakeTimeSlot = 0;

  beforeEach(() => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
      IntersectionObserverStub;
    updateSeriesMetadata.mockClear();
    showSnackbar.mockClear();
    emitSeriesMetadata(new Map());
    providerStatus.set({ providers: {}, currentProviderType: null });
    vi.useFakeTimers();
    fakeTimeSlot += 1;
    vi.setSystemTime(new Date(2026, 0, 1).getTime() + fakeTimeSlot * FAKE_TIME_SLOT_MS);
  });

  afterEach(async () => {
    cleanup();
    await flushSpineOffsetWrites();
    vi.useRealTimers();
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = originalIO;
  });

  it('absent capabilities: shift+wheel still changes the offset (unchanged default behavior)', async () => {
    const { container } = render(CatalogItem, { props: { volumes: twoVolumes() } });
    const card = getCard(container);
    const before = stackWidth(container);

    await fireEvent.mouseEnter(card);
    await fireEvent.wheel(card, { shiftKey: true, deltaY: -1 });

    expect(stackWidth(container)).not.toBe(before);
    await flushSpineOffsetWrites();
    expect(updateSeriesMetadata).toHaveBeenCalledTimes(1);
    expect(showSnackbar).not.toHaveBeenCalled();
  });

  it('scope "none": shift+wheel changes nothing locally and writes nothing', async () => {
    setScopeNone();
    const { container } = render(CatalogItem, { props: { volumes: twoVolumes() } });
    const card = getCard(container);
    const before = stackWidth(container);

    await fireEvent.mouseEnter(card);
    await fireEvent.wheel(card, { shiftKey: true, deltaY: -1 });

    // No local mutation: an offset applied only on this device, that can never publish,
    // would silently diverge from the server (see checkSpineOffsetEditAllowed's docs).
    expect(stackWidth(container)).toBe(before);
    await flushSpineOffsetWrites();
    expect(updateSeriesMetadata).not.toHaveBeenCalled();
  });

  it('scope "none": shift+wheel shows the reason via snackbar', async () => {
    setScopeNone();
    const { container } = render(CatalogItem, { props: { volumes: twoVolumes() } });
    const card = getCard(container);

    await fireEvent.mouseEnter(card);
    await fireEvent.wheel(card, { shiftKey: true, deltaY: -1 });

    expect(showSnackbar).toHaveBeenCalledWith(
      "This account can't edit series details on this server"
    );
  });

  it('scope "none": debounces the snackbar across a wheel burst — once, not once per tick', async () => {
    setScopeNone();
    const { container } = render(CatalogItem, { props: { volumes: twoVolumes() } });
    const card = getCard(container);

    await fireEvent.mouseEnter(card);
    await fireEvent.wheel(card, { shiftKey: true, deltaY: -1 });
    await fireEvent.wheel(card, { shiftKey: true, deltaY: -1 });
    await fireEvent.wheel(card, { shiftKey: true, deltaY: -1 });

    expect(showSnackbar).toHaveBeenCalledTimes(1);
  });

  it('scope "none": alt+shift+wheel over a volume is gated the same way', async () => {
    setScopeNone();
    const { container } = render(CatalogItem, { props: { volumes: twoVolumes() } });
    const card = getCard(container);
    const before = stackWidth(container);

    await fireEvent.mouseEnter(card);
    await fireEvent.mouseMove(card, { clientX: 4000, clientY: 10, shiftKey: true, altKey: true });
    await fireEvent.wheel(card, { shiftKey: true, altKey: true, deltaY: -1 });

    expect(stackWidth(container)).toBe(before);
    await flushSpineOffsetWrites();
    expect(updateSeriesMetadata).not.toHaveBeenCalled();
    expect(showSnackbar).toHaveBeenCalledWith(
      "This account can't edit series details on this server"
    );
  });

  it('scope "none": shift+right-click reset is gated the same way', async () => {
    setScopeNone();
    const { container } = render(CatalogItem, { props: { volumes: twoVolumes() } });
    const card = getCard(container);
    const before = stackWidth(container);

    await fireEvent.mouseEnter(card);
    await fireEvent.contextMenu(card, { shiftKey: true });

    expect(stackWidth(container)).toBe(before);
    await flushSpineOffsetWrites();
    expect(updateSeriesMetadata).not.toHaveBeenCalled();
    expect(showSnackbar).toHaveBeenCalledWith(
      "This account can't edit series details on this server"
    );
  });

  it('scope "owned" without this series listed: gated, same as "none"', async () => {
    providerStatus.set({
      providers: {
        webdav: { metadataPermissions: { scope: 'owned', ownedSeries: ['Some Other Series'] } }
      },
      currentProviderType: 'webdav'
    });
    const { container } = render(CatalogItem, { props: { volumes: twoVolumes() } });
    const card = getCard(container);
    const before = stackWidth(container);

    await fireEvent.mouseEnter(card);
    await fireEvent.wheel(card, { shiftKey: true, deltaY: -1 });

    expect(stackWidth(container)).toBe(before);
    expect(updateSeriesMetadata).not.toHaveBeenCalled();
  });

  it('scope "owned" WITH this series listed: allowed, same as absent capabilities', async () => {
    providerStatus.set({
      providers: {
        webdav: { metadataPermissions: { scope: 'owned', ownedSeries: ['One Piece'] } }
      },
      currentProviderType: 'webdav'
    });
    const { container } = render(CatalogItem, { props: { volumes: twoVolumes() } });
    const card = getCard(container);
    const before = stackWidth(container);

    await fireEvent.mouseEnter(card);
    await fireEvent.wheel(card, { shiftKey: true, deltaY: -1 });

    expect(stackWidth(container)).not.toBe(before);
    await flushSpineOffsetWrites();
    expect(updateSeriesMetadata).toHaveBeenCalledTimes(1);
    expect(showSnackbar).not.toHaveBeenCalled();
  });
});

describe('CatalogItem spine offset resync is stable', () => {
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

  it('marks an ALL-PLACEHOLDER series finished when every volume of it is', () => {
    // The reported bug. Read history is keyed by uuid in localStorage and needs no
    // catalog row, so a series that exists only in the cloud is exactly as finishable as
    // a downloaded one. The card required a local row, which made "finished" false by
    // construction here — the series sorted to the bottom of the smart catalog (that
    // predicate counted every volume) and went green only once opening it minted rows.
    updateProgress('p-1', 10, 0, true);
    updateProgress('p-2', 10, 0, true);
    try {
      const { container } = render(CatalogItem, {
        props: {
          volumes: [cloudCover({ volume_uuid: 'p-1' }), cloudCover({ volume_uuid: 'p-2' })],
          providerName: 'Drive'
        }
      });

      expect(identity(container)).toEqual({
        dimmed: true,
        mutedTitle: false,
        greenTitle: true,
        chip: '2 volumes in Drive',
        cloudMarks: 1,
        badges: 0
      });
    } finally {
      updateProgress('p-1', 0, 0, false);
      updateProgress('p-2', 0, 0, false);
    }
  });

  it('marks a BARE placeholder series finished on the stored flag alone', () => {
    // A listing knows the volume exists and nothing else: page_count 0. The device that
    // actually read it synced `completed` against the same uuid, and that flag is the only
    // evidence there is — `isVolumeComplete` can only ever answer "no" without a length.
    updateProgress('p-1', 180, 0, true);
    try {
      const { container } = render(CatalogItem, {
        props: {
          volumes: [cloudCover({ volume_uuid: 'p-1', page_count: 0 })],
          providerName: 'Drive'
        }
      });

      expect(identity(container).greenTitle).toBe(true);
    } finally {
      updateProgress('p-1', 0, 0, false);
    }
  });

  it('marks a placeholder series the user marked finished, with no progress at all', () => {
    // "Reading history" is broader than page turns: no pages, no recorded time, no turns —
    // marked as finished still counts.
    updateProgress('p-1', 0, 0, true);
    try {
      const { container } = render(CatalogItem, {
        props: {
          volumes: [cloudCover({ volume_uuid: 'p-1', page_count: 0 })],
          providerName: 'Drive'
        }
      });

      expect(identity(container).greenTitle).toBe(true);
    } finally {
      updateProgress('p-1', 0, 0, false);
    }
  });

  it('leaves an all-placeholder series unmarked while one volume is still unread', () => {
    updateProgress('p-1', 10, 0, true);
    try {
      const { container } = render(CatalogItem, {
        props: {
          volumes: [cloudCover({ volume_uuid: 'p-1' }), cloudCover({ volume_uuid: 'p-2' })],
          providerName: 'Drive'
        }
      });

      expect(identity(container)).toEqual({
        dimmed: true,
        mutedTitle: true,
        greenTitle: false,
        chip: '2 volumes in Drive',
        cloudMarks: 1,
        badges: 0
      });
    } finally {
      updateProgress('p-1', 0, 0, false);
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
    updateCatalogSetting('stackCount', 0);
  });

  afterEach(() => {
    cleanup();
    updateCatalogSetting('stackCount', 3);
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = originalIO;
  });

  function drawnUuids(): string[] {
    const props = compositeCanvasProps.at(-1);
    if (!props) throw new Error('CompositeCanvas was never mounted');
    return (props.volumes as VolumeMetadata[]).map((vol) => vol.volume_uuid);
  }

  function requestedUuids(): string[] {
    return requestCoverMock.mock.calls.map(([vol]) => (vol as VolumeMetadata).volume_uuid);
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

  it('asks the cover service for exactly the cloud-only volumes, not the ones already painted', async () => {
    // Cover delivery itself (fetch → install → row → re-render) is
    // `cover-service.ts`'s contract, covered end to end there. This card's
    // own job stops at asking for the right set.
    render(CatalogItem, { props: { volumes: mixedSeries() } });
    await tick();

    expect(requestedUuids().sort()).toEqual(['c-3', 'c-4']);
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

  it('stacks every volume of a partly-here series, past the cloud cap, and asks a cover for each cloud one', async () => {
    // The user's own shelf: 42 volumes, only the last one downloaded. The 25-cover cap is
    // for a series whose whole stack comes from the cloud; this one is stacked by the
    // local rules, all of it.
    const volumes = [
      ...Array.from({ length: 41 }, (_, i) =>
        cloudOnly({ volume_uuid: `c-${i + 1}`, volume_title: `Vol ${i + 1}` })
      ),
      painted({ volume_uuid: 'v-42', volume_title: 'Vol 42' })
    ];
    render(CatalogItem, { props: { volumes } });
    await tick();

    expect(drawnUuids()).toHaveLength(42);
    expect(drawnUuids().at(-1)).toBe('v-42');
    expect(requestedUuids()).toHaveLength(41);
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

  it('hides the finished volumes of an ALL-ABSENT series when "hide read" is on', async () => {
    // "Hide completed volumes" was a local-only setting: the selector's hide-read branch
    // lived inside `if (localVolumes.length > 0)`, and the card zeroed both `localVolumes`
    // and `unreadVolumes` for a series with nothing on the device — so the cloud path had
    // no unread set to work from and stacked the finished volumes like any other.
    updateProgress('v-1', 10, 0, true);
    updateProgress('v-3', 10, 0, true);
    try {
      render(CatalogItem, {
        props: {
          volumes: [
            painted({ volume_uuid: 'v-1', volume_title: 'Vol 1', metadata_only: true }),
            painted({ volume_uuid: 'v-2', volume_title: 'Vol 2', metadata_only: true }),
            painted({ volume_uuid: 'v-3', volume_title: 'Vol 3', metadata_only: true }),
            painted({ volume_uuid: 'v-4', volume_title: 'Vol 4', metadata_only: true })
          ]
        }
      });
      await tick();

      expect(drawnUuids()).toEqual(['v-2', 'v-4']);
    } finally {
      updateProgress('v-1', 0, 0, false);
      updateProgress('v-3', 0, 0, false);
    }
  });

  it('hides the finished volumes of a CLOUD-ONLY series too', async () => {
    // Same series, no rows at all: progress reaches a placeholder through the volume uuid
    // its listing carries.
    const cloudPainted = (overrides: Partial<VolumeMetadata> = {}) =>
      placeholderVolume({
        series_title: 'One Piece',
        thumbnail_width: 250,
        thumbnail_height: 360,
        thumbnail: new File([], 'cover.jpg', { type: 'image/jpeg' }),
        ...overrides
      });

    updateProgress('c-1', 10, 0, true);
    try {
      render(CatalogItem, {
        props: {
          volumes: [
            cloudPainted({ volume_uuid: 'c-1', volume_title: 'Vol 1' }),
            cloudPainted({ volume_uuid: 'c-2', volume_title: 'Vol 2' })
          ]
        }
      });
      await tick();

      expect(drawnUuids()).toEqual(['c-2']);
    } finally {
      updateProgress('c-1', 0, 0, false);
    }
  });

  it('keeps showing a finished all-absent series rather than emptying its card', async () => {
    updateProgress('v-1', 10, 0, true);
    updateProgress('v-2', 10, 0, true);
    try {
      render(CatalogItem, {
        props: {
          volumes: [
            painted({ volume_uuid: 'v-1', volume_title: 'Vol 1', metadata_only: true }),
            painted({ volume_uuid: 'v-2', volume_title: 'Vol 2', metadata_only: true })
          ]
        }
      });
      await tick();

      expect(drawnUuids()).toEqual(['v-1', 'v-2']);
    } finally {
      updateProgress('v-1', 0, 0, false);
      updateProgress('v-2', 0, 0, false);
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
 * Cover delivery is unified behind `cover-service.ts`: every surface that
 * draws a cloud cover only REQUESTS one (`requestCover`), and delivery lands
 * through the DB (see `cover-service.test.ts`, `cover-persist.test.ts`).
 * This card's own responsibility is narrower — asking for a cover for every
 * eligible volume (a placeholder, or a real row with a cover id and no
 * thumbnail), and NEVER asking for one a row already carries.
 */
describe('CatalogItem requests covers for exactly the volumes that need one', () => {
  /**
   * Held SHUT, and opened by hand per test. The card asks for nothing until it is near
   * the viewport (`cover-claims.svelte.ts` + `cover-viewport.ts`), so an auto-opening
   * stub would make every assertion below a statement about the stub rather than about
   * the card, and every `not.toHaveBeenCalled()` in it vacuous.
   */
  let observer: ReturnType<typeof installIntersectionObserverStub>;

  /** What a scroll does: bring every observed card into the prefetch band. */
  async function scrollCardsIntoView(): Promise<void> {
    for (const gate of observer.gates) gate.emit(true);
    await tick();
  }

  const cloudOnly = (overrides: Partial<VolumeMetadata> = {}) =>
    placeholderVolume({
      series_title: 'One Piece',
      cloudThumbnailFileId: `thumb-${overrides.volume_uuid ?? 'c'}`,
      ...overrides
    });

  /** A materialized/retained row: a real DB row (not a placeholder) with no thumbnail yet. */
  const metadataOnlyRow = (overrides: Partial<VolumeMetadata> = {}) =>
    localVolume({
      series_title: 'One Piece',
      metadata_only: true,
      cloudThumbnailFileId: `thumb-${overrides.volume_uuid ?? 'm'}`,
      ...overrides
    });

  beforeEach(() => {
    observer = installIntersectionObserverStub({ autoIntersect: false });
    emitSeriesMetadata(new Map());
    compositeCanvasProps.length = 0;
  });

  afterEach(() => {
    cleanup();
    observer.restore();
  });

  it('THE GATE: a card thousands of pixels below the fold asks for nothing', async () => {
    // The measured defect: 1,027 cards x ~4 stacked volumes = ~4,347 cover requests on
    // mount, 134 MB in a 12.2-second burst, for a screenful of maybe six cards. The card
    // is fully mounted and its target list is fully derived here; only the viewport gate
    // is holding the requests back.
    render(CatalogItem, {
      props: {
        volumes: [
          cloudOnly({ volume_uuid: 'c-far-1', volume_title: 'Vol 1' }),
          cloudOnly({ volume_uuid: 'c-far-2', volume_title: 'Vol 2' })
        ]
      }
    });
    await tick();
    await tick();

    expect(requestCoverMock).not.toHaveBeenCalled();
    // Not vacuous: the card really did arm a gate, it simply has not opened.
    expect(observer.gates).toHaveLength(1);

    await scrollCardsIntoView();

    expect(requestCoverMock.mock.calls.map(([vol]) => vol.volume_uuid)).toEqual([
      'c-far-1',
      'c-far-2'
    ]);
  });

  it('requests a cover for a metadata-only row with no thumbnail yet', async () => {
    render(CatalogItem, {
      props: {
        volumes: [metadataOnlyRow({ volume_uuid: 'm-1', volume_title: 'Vol 1' })]
      }
    });
    await tick();
    await scrollCardsIntoView();

    expect(requestCoverMock).toHaveBeenCalledTimes(1);
    const [vol] = requestCoverMock.mock.calls[0];
    expect(vol.volume_uuid).toBe('m-1');
    expect(vol.isPlaceholder).toBeFalsy();
  });

  it('requests a cover for a pure placeholder too, forwarding it whole (isPlaceholder intact)', async () => {
    // `cover-service.ts` reads `isPlaceholder` itself to pick the right
    // decision-tree branch (materialize-then-install vs. install-only) — the
    // card must hand over the volume as-is, not a stripped copy.
    render(CatalogItem, {
      props: {
        volumes: [cloudOnly({ volume_uuid: 'c-1', volume_title: 'Vol 1' })]
      }
    });
    await tick();
    await scrollCardsIntoView();

    expect(requestCoverMock).toHaveBeenCalledTimes(1);
    expect(requestCoverMock.mock.calls[0][0].isPlaceholder).toBe(true);
  });

  it('PIN: a row WITH a thumbnail never enters cloudCoverTargets — zero requests, zero network next session', async () => {
    // The "next session" simulation: a row that a PRIOR session's commit
    // already persisted a thumbnail onto. If this row were still treated as
    // a fetch target, a session boundary would cost a network round trip
    // every time instead of reading straight from IndexedDB.
    const alreadyPersisted = metadataOnlyRow({
      volume_uuid: 'm-2',
      volume_title: 'Vol 2',
      thumbnail: coverFile(),
      thumbnail_width: 250,
      thumbnail_height: 360
    });

    render(CatalogItem, { props: { volumes: [alreadyPersisted] } });
    await tick();
    await scrollCardsIntoView();

    // Non-vacuous even though the gate is what usually keeps a card quiet: this card was
    // scrolled all the way into view and still asked for nothing.
    expect(observer.gates).toHaveLength(1);
    expect(requestCoverMock).not.toHaveBeenCalled();
  });
});

/**
 * The freshly-downloaded-series bug: the card mounts while the series has no cover at
 * all, and the covers arrive afterwards — a thumbnail generated in the background, a
 * cover sidecar downloaded, a request that failed the first time.
 */
describe('CatalogItem draws the covers that arrive after it mounted', () => {
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

  // Retry-on-nothing, release-on-failure and dedupe are `cover-service.ts`'s
  // own contract now (`cover-service.test.ts`'s "retry" and "dedupe" describe
  // blocks, plus `cover-service.retry.test.ts`'s fake-timer backoff pins) —
  // this card no longer tracks any of that itself, so there is nothing left
  // to re-test at this layer beyond the wiring already covered above
  // ("CatalogItem requests covers for exactly the volumes that need one").

  it('re-derives its cover-request targets when the catalog re-emits rows (a bulk-download tick, a setting change)', async () => {
    // A re-render must recompute `cloudCoverTargets` from the FRESH volumes
    // prop, not from stale local state — a cloud-only volume still without a
    // thumbnail after some unrelated re-render must still show up as a target.
    render(CatalogItem, {
      props: {
        volumes: [
          generated({ volume_uuid: 'f-1', volume_title: 'Vol 1' }),
          cloudOnly({ volume_uuid: 'c-2', volume_title: 'Vol 2' })
        ]
      }
    });
    await tick();
    expect(requestCoverMock).toHaveBeenCalledWith(
      expect.objectContaining({ volume_uuid: 'c-2' }),
      // The still-near-viewport probe every request now carries.
      expect.any(Function)
    );

    updateCatalogSetting('horizontalStep', 12);
    await tick();
    try {
      // `requestCover` is idempotent by contract, so a redundant call here is
      // harmless — the card is not expected to suppress it itself.
      expect(requestCoverMock).toHaveBeenCalledWith(
        expect.objectContaining({ volume_uuid: 'c-2' }),
        expect.any(Function)
      );
      // Arity matters here: with the probe argument, a volume-only matcher
      // would "not match" every call vacuously.
      expect(requestCoverMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ volume_uuid: 'f-1' }),
        expect.anything()
      );
    } finally {
      updateCatalogSetting('horizontalStep', 11);
    }
  });
});
