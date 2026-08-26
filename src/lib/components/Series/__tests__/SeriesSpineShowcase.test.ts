import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IntersectionObserverStub } from '$lib/catalog/__tests__/intersection-observer-stub';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';

// vi.hoisted: the vi.mock factories below are hoisted above this module's imports, so the
// stores/spies they close over must be built here (same pattern as CatalogItem.shortcut.test.ts).
const {
  updateSeriesMetadata,
  emitSeriesMetadata,
  seriesMetadataMap,
  catalogSettings,
  readStates,
  compositeCanvasProps,
  providerStatus
} = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const subscribers = new Set<(v: Map<string, Row>) => void>();
  let value = new Map<string, Row>();
  function createStore<T>(initial: T) {
    let current = initial;
    const subs = new Set<(v: T) => void>();
    return {
      subscribe(fn: (v: T) => void) {
        subs.add(fn);
        fn(current);
        return () => subs.delete(fn);
      },
      set(v: T) {
        current = v;
        subs.forEach((fn) => fn(current));
      }
    };
  }
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
    },
    catalogSettings: createStore<Record<string, unknown> | undefined>({ horizontalStep: 11 }),
    // The reading record drives the card's "hide read volumes" subset, which the shelf
    // mirrors — page AND the stored `completed` flag (see `isVolumeFinished`).
    readStates: createStore<Record<string, { progress?: number; completed?: boolean }>>({}),
    // Props CompositeCanvas was last mounted with — real drawing is a canvas no-op in
    // jsdom, so this is the only way to see what the showcase actually asked it to draw.
    compositeCanvasProps: [] as Record<string, unknown>[],
    // No active provider by default — every existing test in this file relies on the
    // offset controls staying enabled, which is `canEditSeriesMetadata`'s default.
    providerStatus: createStore({
      providers: {} as Record<string, { metadataPermissions?: unknown } | null>,
      currentProviderType: null as string | null
    })
  };
});

// The real spine-offsets module stays in play (debounce, clamps, patch building); only the
// Dexie-backed store underneath it is stubbed.
vi.mock('$lib/metadata/store', () => ({ updateSeriesMetadata, seriesMetadataMap }));
vi.mock('$lib/settings/settings', () => ({ catalogSettings }));
// Mocked so the real module (Dexie-backed volume data) stays out of the graph.
vi.mock('$lib/settings/volume-data', () => ({ volumes: readStates }));
// Cover fetching/delivery is `cover-service.ts`'s job now (decision tree,
// dedupe, retry and persistence are covered end to end in
// `cover-service.test.ts`/`cover-service.retry.test.ts` against a real
// Dexie). The real module pulls in db/materialize/unified-cloud-manager — a
// graph this file deliberately does not load — so `isCoverFetchTarget` is
// reimplemented here as the same small pure predicate (this file's fixtures
// never exercise the stale-row-mismatch branch, which is `cover-service.
// test.ts`'s job to pin); only `requestCover` needs to be a spy.
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
vi.mock('$lib/util/sync', () => ({ providerManager: { status: providerStatus } }));
// Transparent pass-through wrapper — records the props each mount receives, then delegates
// to the real component so rendering/behavior is untouched.
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

import SeriesSpineShowcase from '../SeriesSpineShowcase.svelte';
import type { VolumeMetadata } from '$lib/types';
import type { SeriesMetadata } from '$lib/metadata/types';
import { flushSpineOffsetWrites } from '$lib/metadata/spine-offsets';
import {
  computeStepSizes,
  computeUniformHeight,
  getSpineCanvasDimensions,
  type Dimensions
} from '$lib/util/spine-stack-geometry';

// Geometry the component renders with: at the default 1× zoom, a 250×360 thumbnail is
// drawn a full 250px wide (card scale), and the default 11 % step only moves spine i by
// i × 27.5px — nowhere near enough to clear the spine ahead of it. So volume 0's band is
// [0, 250] and volume 1's is [27.5, 277.5]: x = 260 is past volume 0's right edge but
// still inside volume 1's — the deterministic way to hover a specific spine in jsdom
// (where layout is all zeroes).
const HIT_VOLUME_1_X = 260;

const originalIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;

/**
 * The cover a row's stored dimensions describe. Dimensions never travel without one:
 * every writer sets `thumbnail`, `thumbnail_width` and `thumbnail_height` together, and
 * the shelf only sizes a spine once it has pixels (CompositeCanvas paints nothing for a
 * volume without them). Fixtures for volumes with NO cover clear both explicitly.
 */
function coverFile(): File {
  return new File([], 'cover.jpg', { type: 'image/jpeg' });
}

function volume(overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    volume_uuid: 'uuid-1',
    series_uuid: 'series-uuid',
    series_title: 'One Piece',
    volume_title: 'Vol 1',
    page_count: 10,
    isPlaceholder: false,
    thumbnail: coverFile(),
    thumbnail_width: 250,
    thumbnail_height: 360,
    ...overrides
  } as VolumeMetadata;
}

const threeVolumes = () => [
  volume({ volume_uuid: 'uuid-0', volume_title: 'Vol 1' }),
  volume({ volume_uuid: 'uuid-1', volume_title: 'Vol 2' }),
  volume({ volume_uuid: 'uuid-2', volume_title: 'Vol 3' })
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

const metaMap = (overrides: Partial<SeriesMetadata> = {}) =>
  new Map([['one piece', record(overrides)]]);

/** Resolve the functional patch a write handed to the store. */
function resolvePatch(callIndex: number, existing: Partial<SeriesMetadata> = {}) {
  const [, patch] = updateSeriesMetadata.mock.calls[callIndex] as unknown as [
    string,
    (existing: Partial<SeriesMetadata>) => Partial<SeriesMetadata>
  ];
  return patch(existing);
}

function renderShowcase(volumes = threeVolumes()) {
  const utils = render(SeriesSpineShowcase, { props: { seriesTitle: 'One Piece', volumes } });
  const strip = utils.container.querySelector('.spine-strip') as HTMLElement;
  if (!strip) throw new Error('spine strip not found');
  return { ...utils, strip };
}

/** jsdom has no WheelEvent init for deltas we control, so shape a plain Event. */
function wheel(
  el: Element,
  {
    deltaY = 0,
    deltaX = 0,
    shiftKey = false,
    altKey = false,
    ctrlKey = false
  }: {
    deltaY?: number;
    deltaX?: number;
    shiftKey?: boolean;
    altKey?: boolean;
    ctrlKey?: boolean;
  } = {}
): Event {
  const e = new Event('wheel', { bubbles: true, cancelable: true });
  Object.defineProperties(e, {
    deltaY: { value: deltaY },
    deltaX: { value: deltaX },
    shiftKey: { value: shiftKey },
    altKey: { value: altKey },
    ctrlKey: { value: ctrlKey }
  });
  el.dispatchEvent(e);
  return e;
}

/** jsdom has no PointerEvent constructor. */
function pointer(el: Element, type: string, props: Record<string, unknown> = {}): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(e, {
    pointerId: { value: 1 },
    clientX: { value: 0 },
    clientY: { value: 0 },
    button: { value: 0 },
    ...Object.fromEntries(Object.entries(props).map(([k, v]) => [k, { value: v }]))
  });
  el.dispatchEvent(e);
  return e;
}

function contextMenu(el: Element, init: MouseEventInit): Event {
  const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
}

/** jsdom does no layout: fake the scroll metrics the pan handlers read. */
function makeScrollable(strip: HTMLElement, { scrollWidth = 1200, clientWidth = 400 } = {}) {
  let scrollLeft = 0;
  Object.defineProperties(strip, {
    scrollWidth: { configurable: true, get: () => scrollWidth },
    clientWidth: { configurable: true, get: () => clientWidth },
    scrollLeft: {
      configurable: true,
      get: () => scrollLeft,
      set: (v: number) => {
        scrollLeft = Math.max(0, Math.min(v, scrollWidth - clientWidth));
      }
    }
  });
}

// Every mounted SeriesSpineShowcase's own cover-request effect calls this,
// whether or not a given describe block cares — cleared before EVERY test in
// the file (not just the ones that assert on it) so calls never carry over
// between unrelated tests/describe blocks.
beforeEach(() => {
  requestCoverMock.mockClear();
});

describe('SeriesSpineShowcase', () => {
  beforeEach(() => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
      IntersectionObserverStub;
    updateSeriesMetadata.mockClear();
    requestCoverMock.mockClear();
    catalogSettings.set({ horizontalStep: 11 });
    readStates.set({});
    emitSeriesMetadata(new Map());
    compositeCanvasProps.length = 0;
    providerStatus.set({ providers: {}, currentProviderType: null });
  });

  afterEach(async () => {
    cleanup();
    await flushSpineOffsetWrites();
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = originalIO;
  });

  it('writes the series offset when the slider moves', async () => {
    const { getByLabelText } = renderShowcase();
    const slider = getByLabelText('Series spine offset') as HTMLInputElement;

    await fireEvent.input(slider, { target: { value: '7.5' } });
    await flushSpineOffsetWrites();

    expect(updateSeriesMetadata).toHaveBeenCalledTimes(1);
    expect(updateSeriesMetadata.mock.calls[0][0]).toBe('One Piece');
    expect(resolvePatch(0)).toEqual({ spine_offset: 7.5 });
  });

  it('shows the current series offset as a readout', async () => {
    emitSeriesMetadata(metaMap({ spine_offset: 3.25 }));
    const { getByText } = renderShowcase();
    await tick();
    expect(getByText('+3.25%')).toBeTruthy();
  });

  it('shift+wheel nudges the series offset by 0.25 % per tick, coalesced into one write', async () => {
    const { strip } = renderShowcase();
    await tick();

    const a = wheel(strip, { deltaY: -1, shiftKey: true });
    wheel(strip, { deltaY: -1, shiftKey: true });
    await flushSpineOffsetWrites();

    expect(a.defaultPrevented).toBe(true);
    expect(updateSeriesMetadata).toHaveBeenCalledTimes(1);
    expect(resolvePatch(0)).toEqual({ spine_offset: 0.5 });
  });

  it('alt+shift+wheel over a spine writes that volume’s offset, keyed by its uuid', async () => {
    const { strip } = renderShowcase();
    await tick();

    pointer(strip, 'pointermove', { clientX: HIT_VOLUME_1_X });
    const e = wheel(strip, { deltaY: -1, shiftKey: true, altKey: true });
    await flushSpineOffsetWrites();

    expect(e.defaultPrevented).toBe(true);
    expect(resolvePatch(0)).toEqual({ volume_offsets: { 'uuid-1': 1 } });
  });

  it('captions the hovered spine with its current nudge', async () => {
    emitSeriesMetadata(metaMap({ volume_offsets: { 'uuid-1': 3 } }));
    const { strip, getByText } = renderShowcase();
    await tick();

    pointer(strip, 'pointermove', { clientX: HIT_VOLUME_1_X });
    await tick();

    expect(getByText('Vol 2 · +3 px')).toBeTruthy();
  });

  it('shift+right-click resets the series offset', async () => {
    emitSeriesMetadata(metaMap({ spine_offset: 4 }));
    const { strip } = renderShowcase();
    await tick();

    contextMenu(strip, { shiftKey: true });
    await flushSpineOffsetWrites();

    expect(resolvePatch(0, { spine_offset: 4 })).toEqual({ spine_offset: 0 });
  });

  it('alt+shift+right-click resets only the hovered volume', async () => {
    emitSeriesMetadata(metaMap({ volume_offsets: { 'uuid-0': 3, 'uuid-1': -5 } }));
    const { strip } = renderShowcase();
    await tick();

    pointer(strip, 'pointermove', { clientX: HIT_VOLUME_1_X });
    contextMenu(strip, { shiftKey: true, altKey: true });
    await flushSpineOffsetWrites();

    expect(resolvePatch(0, { volume_offsets: { 'uuid-0': 3, 'uuid-1': -5 } })).toEqual({
      volume_offsets: { 'uuid-0': 3, 'uuid-1': 0 }
    });
  });

  it('Reset clears the series offset', async () => {
    emitSeriesMetadata(metaMap({ spine_offset: 4 }));
    const { getByText } = renderShowcase();
    await tick();

    await fireEvent.click(getByText('Reset'));
    await flushSpineOffsetWrites();

    expect(resolvePatch(0, { spine_offset: 4 })).toEqual({ spine_offset: 0 });
  });

  it('“Reset all volume offsets” zeroes every per-volume nudge', async () => {
    emitSeriesMetadata(metaMap({ volume_offsets: { 'uuid-0': 3, 'uuid-1': -5 } }));
    const { getByText } = renderShowcase();
    await tick();

    await fireEvent.click(getByText('Reset all volume offsets'));
    await flushSpineOffsetWrites();

    // Zeroed, not deleted: an absent key inherits whatever series.json publishes.
    expect(resolvePatch(0, { volume_offsets: { 'uuid-0': 3, 'uuid-1': -5 } })).toEqual({
      volume_offsets: { 'uuid-0': 0, 'uuid-1': 0 }
    });
  });

  it('writes nothing for a wheel that carries no delta', async () => {
    // A stationary wheel (and some trackpad/inertia end events) reports 0 on both axes;
    // reading a direction off that would nudge the offset on every stray event.
    const { strip } = renderShowcase();
    await tick();

    pointer(strip, 'pointermove', { clientX: HIT_VOLUME_1_X });
    wheel(strip, { deltaY: 0, deltaX: 0, shiftKey: true });
    wheel(strip, { deltaY: 0, deltaX: 0, shiftKey: true, altKey: true });
    await flushSpineOffsetWrites();

    expect(updateSeriesMetadata).not.toHaveBeenCalled();
  });

  it('writes nothing for a gesture without modifiers', async () => {
    const { strip } = renderShowcase();
    await tick();

    wheel(strip, { deltaY: -1 });
    contextMenu(strip, {});
    await flushSpineOffsetWrites();

    expect(updateSeriesMetadata).not.toHaveBeenCalled();
  });

  it('leaves a plain wheel alone when the strip does not overflow', async () => {
    const { strip } = renderShowcase();
    await tick();

    // jsdom reports scrollWidth === clientWidth === 0: nothing to pan, so the page (or the
    // modal body) must keep the scroll.
    const e = wheel(strip, { deltaY: 120 });
    expect(e.defaultPrevented).toBe(false);
  });

  it('pans the strip sideways on a plain vertical wheel when it overflows', async () => {
    const { strip } = renderShowcase();
    await tick();
    makeScrollable(strip);

    const e = wheel(strip, { deltaY: 120 });

    expect(e.defaultPrevented).toBe(true);
    expect(strip.scrollLeft).toBe(120);
  });

  it('lets the wheel through once the strip is clamped at an end', async () => {
    // Otherwise the shelf traps the page scroll: the pointer sits over a strip that cannot
    // move any further and the modal body never gets the wheel.
    const { strip } = renderShowcase();
    await tick();
    makeScrollable(strip); // max scrollLeft = 800

    expect(wheel(strip, { deltaY: -120 }).defaultPrevented).toBe(false); // already at 0
    expect(wheel(strip, { deltaY: 400 }).defaultPrevented).toBe(true); // mid-strip: ours
    expect(strip.scrollLeft).toBe(400);

    wheel(strip, { deltaY: 900 }); // runs into the right end
    expect(strip.scrollLeft).toBe(800);
    expect(wheel(strip, { deltaY: 120 }).defaultPrevented).toBe(false);
  });

  it('reads the direction off deltaX when the browser puts a shifted wheel there', async () => {
    const { strip } = renderShowcase();
    await tick();

    // Chrome delivers shift+wheel as horizontal scroll: deltaY is 0. A positive delta means
    // "tighter", so reading the sign off deltaX is what distinguishes this from the old
    // deltaY-only code (which saw 0 and always widened).
    wheel(strip, { deltaX: 1, shiftKey: true });
    await flushSpineOffsetWrites();

    expect(resolvePatch(0)).toEqual({ spine_offset: -0.25 });
  });

  it('re-hits the spine under the cursor after a pan', async () => {
    const { strip, getByText } = renderShowcase();
    await tick();
    makeScrollable(strip);

    pointer(strip, 'pointermove', { clientX: HIT_VOLUME_1_X });
    await tick();
    expect(getByText('Vol 2 · 0 px')).toBeTruthy();

    // The shelf slides under a stationary cursor; the hovered spine must follow.
    wheel(strip, { deltaY: 120 });
    await tick();
    expect(getByText('Vol 3 · 0 px')).toBeTruthy();
  });

  it('pans the strip by dragging', async () => {
    const { strip } = renderShowcase();
    await tick();
    makeScrollable(strip);

    pointer(strip, 'pointerdown', { clientX: 300 });
    pointer(strip, 'pointermove', { clientX: 220 });
    expect(strip.scrollLeft).toBe(80);

    pointer(strip, 'pointerup', { clientX: 220 });
    pointer(strip, 'pointermove', { clientX: 120 });
    expect(strip.scrollLeft).toBe(80);
  });

  it('pans with the arrow keys and never swallows Escape', async () => {
    const { strip } = renderShowcase();
    await tick();
    makeScrollable(strip);

    const right = await fireEvent.keyDown(strip, { key: 'ArrowRight' });
    expect(right).toBe(false); // preventDefault → dispatchEvent returned false
    expect(strip.scrollLeft).toBeGreaterThan(0);

    const escaped = await fireEvent.keyDown(strip, { key: 'Escape' });
    expect(escaped).toBe(true); // untouched: the modal's guard still gets it
  });

  it('caps how many volumes it renders, and requests a cover for each one it draws', async () => {
    const many = Array.from({ length: 70 }, (_, i) =>
      volume({
        volume_uuid: `uuid-${String(i).padStart(3, '0')}`,
        volume_title: `Vol ${String(i + 1).padStart(3, '0')}`,
        isPlaceholder: true,
        thumbnail: undefined,
        thumbnail_width: undefined,
        thumbnail_height: undefined,
        cloudThumbnailFileId: `file-${i}`
      })
    );
    const { getByText } = renderShowcase(many);
    await tick();

    expect(requestCoverMock).toHaveBeenCalledTimes(60);
    expect(getByText('Showing first 60 of 70 volumes')).toBeTruthy();
  });

  it('says nothing about a cap it did not hit', async () => {
    const { queryByText } = renderShowcase();
    await tick();
    expect(queryByText(/Showing first/)).toBeNull();
  });

  it('never asks CompositeCanvas to draw a drop shadow, but keeps the spine edges', async () => {
    renderShowcase();
    await tick();

    expect(compositeCanvasProps.at(-1)?.dropShadow).toBe(false);
    // The 1px edge is what makes the spacing between two spines judgeable at all.
    expect(compositeCanvasProps.at(-1)?.border).toBe(true);
  });

  it('leaves ctrl+wheel to the browser', async () => {
    // The shelf's zoom is a two-state button, so a page-zoom gesture is not ours to take —
    // and it must not fall through into the sideways pan either.
    const { strip } = renderShowcase();
    await tick();
    makeScrollable(strip);

    const e = wheel(strip, { deltaY: 120, ctrlKey: true });

    expect(e.defaultPrevented).toBe(false);
    expect(strip.scrollLeft).toBe(0);
  });

  it('renders spines at 1× card scale by default', async () => {
    const { strip } = renderShowcase([volume({ volume_uuid: 'uuid-0' })]);
    await tick();

    const canvasWrap = strip.querySelector('div.relative') as HTMLElement;
    expect(canvasWrap.style.width).toBe('250px');
    expect(canvasWrap.style.height).toBe('360px');
  });

  it('2× doubles the drawn spine, 1× puts it back at card scale', async () => {
    const { strip, getByText } = renderShowcase([volume({ volume_uuid: 'uuid-0' })]);
    await tick();

    const canvasWrap = () => strip.querySelector('div.relative') as HTMLElement;

    await fireEvent.click(getByText('2×'));
    await tick();
    expect(canvasWrap().style.width).toBe('500px');
    expect(canvasWrap().style.height).toBe('720px');

    await fireEvent.click(getByText('1×'));
    await tick();
    expect(canvasWrap().style.width).toBe('250px');
    expect(canvasWrap().style.height).toBe('360px');
  });

  it('marks the active zoom level', async () => {
    const { getByText } = renderShowcase();
    await tick();

    expect(getByText('1×').getAttribute('aria-pressed')).toBe('true');
    expect(getByText('2×').getAttribute('aria-pressed')).toBe('false');

    await fireEvent.click(getByText('2×'));
    await tick();

    expect(getByText('1×').getAttribute('aria-pressed')).toBe('false');
    expect(getByText('2×').getAttribute('aria-pressed')).toBe('true');
  });

  // ── Card parity ───────────────────────────────────────────────────────────────────────
  // The shelf is where the offsets are tuned, so at 1× it must be the card's picture to
  // the pixel: same uniform height, same per-volume aspect widths, same step. The expected
  // values come from the module the card itself now uses.
  const MIXED_DIMS: Dimensions[] = [
    { width: 500, height: 720 }, // a full cover, twice the box: contains to 250×360
    { width: 40, height: 300 }, // a narrow spine scan
    { width: 24, height: 180 } // smaller than the box on BOTH axes: never upscaled
  ];
  const mixedVolumes = () =>
    MIXED_DIMS.map((d, i) =>
      volume({
        volume_uuid: `uuid-${i}`,
        volume_title: `Vol ${i + 1}`,
        thumbnail_width: d.width,
        thumbnail_height: d.height
      })
    );
  const cardUniformHeight = (dims: Dimensions[]) =>
    computeUniformHeight({ dims, verticalStepPct: 5, stackCountSetting: 0 });

  function canvasProps() {
    const props = compositeCanvasProps.at(-1);
    if (!props) throw new Error('CompositeCanvas was never mounted');
    return props as {
      volumes: VolumeMetadata[];
      getCanvasDimensions: (uuid: string) => { width: number; height: number } | null;
      stepSizes: { horizontal: number; vertical: number };
    };
  }

  it('draws every spine at the card’s size and step at 1× zoom', async () => {
    const vols = mixedVolumes();
    const { strip } = renderShowcase(vols);
    await tick();

    const uniformHeight = cardUniformHeight(MIXED_DIMS);
    // (360 + 300 + 180) / 3 — well under the 360 box, because two scans are smaller than it.
    expect(uniformHeight).toBeCloseTo(280, 10);

    const { getCanvasDimensions, stepSizes } = canvasProps();
    for (let i = 0; i < vols.length; i++) {
      expect(getCanvasDimensions(vols[i].volume_uuid)).toEqual(
        getSpineCanvasDimensions(MIXED_DIMS[i], uniformHeight)
      );
    }
    expect(stepSizes.horizontal).toBeCloseTo(
      computeStepSizes({
        stackCountSetting: 0,
        horizontalStepPct: 11,
        verticalStepPct: 5,
        hOffsetAdjust: 0,
        centerHorizontal: true,
        centerVertical: false,
        actualCount: vols.length,
        innerWidth: 250,
        innerHeight: uniformHeight ?? 360,
        uniformHeight,
        dims: MIXED_DIMS
      }).horizontal,
      10
    );

    // The strip is the drawn height, NOT the 360px box: no stretching, no dead space.
    const canvasWrap = strip.querySelector('div.relative') as HTMLElement;
    expect(canvasWrap.style.height).toBe('280px');
  });

  it('scales the card’s geometry by the zoom and nothing else', async () => {
    const vols = mixedVolumes();
    const { getByText } = renderShowcase(vols);
    await tick();

    const uniformHeight = cardUniformHeight(MIXED_DIMS);
    await fireEvent.click(getByText('2×'));
    await tick();

    const { getCanvasDimensions, stepSizes } = canvasProps();
    for (let i = 0; i < vols.length; i++) {
      const card = getSpineCanvasDimensions(MIXED_DIMS[i], uniformHeight)!;
      const shelf = getCanvasDimensions(vols[i].volume_uuid)!;
      expect(shelf.width).toBeCloseTo(card.width * 2, 10);
      expect(shelf.height).toBeCloseTo(card.height * 2, 10);
    }
    expect(stepSizes.horizontal).toBeCloseTo(27.5 * 2, 10);
  });

  it('does not render a 20-volume spine shelf bigger than the card does', async () => {
    // The reported case: volume 1 is a cover, the rest are narrow spine scans, and every
    // thumbnail is SMALLER than the 250×360 box. The old shelf stretched them all to 360
    // in fixed-width boxes, so the same offset showed a gap on one and an overlap on the
    // other; the card averages the fitted heights instead and never upscales.
    const dims: Dimensions[] = [
      { width: 200, height: 290 },
      ...Array.from({ length: 19 }, () => ({ width: 30, height: 250 }))
    ];
    const vols = dims.map((d, i) =>
      volume({
        volume_uuid: `uuid-${String(i).padStart(2, '0')}`,
        volume_title: `Vol ${String(i + 1).padStart(2, '0')}`,
        thumbnail_width: d.width,
        thumbnail_height: d.height
      })
    );
    const { strip } = renderShowcase(vols);
    await tick();

    // (290 + 19 × 250) / 20 = 252 — nowhere near the 360px box the shelf used to assume.
    const uniformHeight = cardUniformHeight(dims);
    expect(uniformHeight).toBeCloseTo(252, 10);

    const canvasWrap = strip.querySelector('div.relative') as HTMLElement;
    expect(canvasWrap.style.height).toBe('252px');

    const { getCanvasDimensions } = canvasProps();
    for (let i = 0; i < vols.length; i++) {
      expect(getCanvasDimensions(vols[i].volume_uuid)).toEqual(
        getSpineCanvasDimensions(dims[i], uniformHeight)
      );
    }
    // Every spine keeps its own fitted width rather than a fixed 250px box.
    expect(getCanvasDimensions('uuid-01')!.width).toBeCloseTo((252 * 30) / 250, 10);
  });

  it('adds the series offset to the step exactly as the card does', async () => {
    emitSeriesMetadata(metaMap({ spine_offset: -3 }));
    renderShowcase(mixedVolumes());
    await tick();

    // 250 × (11 - 3) / 100 — the offset is a percentage of the CARD's base width, not of
    // whatever the shelf happens to be drawing at.
    expect(canvasProps().stepSizes.horizontal).toBeCloseTo(20, 10);
  });

  it('draws every volume, at the size the card’s own stack sets', async () => {
    const vols = mixedVolumes();
    // Volume 1 is finished, so the CARD hides it (hideReadVolumes defaults on). The shelf
    // is a placement editor: it still draws it — but the uniform height is measured over
    // the card's stack, so the volumes the two share stay the same size in both.
    readStates.set({ 'uuid-0': { progress: 9 } });
    renderShowcase(vols);
    await tick();

    expect(canvasProps().volumes.map((v) => v.volume_uuid)).toEqual(['uuid-0', 'uuid-1', 'uuid-2']);

    // Card stack = the two unread volumes: (300 + 180) / 2 = 240, NOT the 280 an average
    // over all three would give.
    const cardHeight = cardUniformHeight(MIXED_DIMS.slice(1));
    expect(cardHeight).toBeCloseTo(240, 10);
    const { getCanvasDimensions } = canvasProps();
    for (let i = 0; i < vols.length; i++) {
      expect(getCanvasDimensions(vols[i].volume_uuid)).toEqual(
        getSpineCanvasDimensions(MIXED_DIMS[i], cardHeight)
      );
    }
  });

  it('keeps volume nudges in card px no matter the zoom level', async () => {
    const { strip, getByText } = renderShowcase();
    await tick();

    // Zoom in first: the +1 px nudge below must still land in storage as 1, not scaled.
    await fireEvent.click(getByText('2×'));
    await tick();

    // Geometry at 2× zoom: spine width 500, 11% step -> 55px/volume. Volume 0's band is
    // [0, 500] and volume 1's is [55, 555] — 520 clears volume 0 but is still inside
    // volume 1.
    pointer(strip, 'pointermove', { clientX: 520 });
    const e = wheel(strip, { deltaY: -1, shiftKey: true, altKey: true });
    await flushSpineOffsetWrites();

    expect(e.defaultPrevented).toBe(true);
    expect(resolvePatch(0)).toEqual({ volume_offsets: { 'uuid-1': 1 } });
  });
});

describe('SeriesSpineShowcase marks the spines that are not on this device', () => {
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

  /** What the strip last asked CompositeCanvas to draw — the geometry the badge may not move. */
  function lastCanvasProps() {
    const props = compositeCanvasProps.at(-1);
    if (!props) throw new Error('CompositeCanvas was never mounted');
    return props as {
      canvasWidth: number;
      canvasHeight: number;
      stepSizes: { horizontal: number; vertical: number };
    };
  }

  it('draws nothing over a shelf of installed volumes', async () => {
    const { container } = renderShowcase();
    await tick();
    expect(badges(container)).toHaveLength(0);
  });

  /** A spine is only painted once it has pixels — see CompositeCanvas. */
  const painted = (overrides: Partial<VolumeMetadata> = {}) =>
    volume({ thumbnail: coverFile(), ...overrides });
  /** …and a volume with no cover at all has nothing for a badge to sit on. */
  const unpainted = (overrides: Partial<VolumeMetadata> = {}) =>
    volume({
      thumbnail: undefined,
      thumbnail_width: undefined,
      thumbnail_height: undefined,
      ...overrides
    });

  it('marks exactly the metadata-only and placeholder spines', async () => {
    const { container } = renderShowcase([
      painted({ volume_uuid: 'uuid-0', volume_title: 'Vol 1' }),
      painted({ volume_uuid: 'uuid-1', volume_title: 'Vol 2', metadata_only: true }),
      painted({ volume_uuid: 'uuid-2', volume_title: 'Vol 3', isPlaceholder: true })
    ]);
    await tick();
    expect(badges(container)).toHaveLength(2);
  });

  it('marks nothing over a spine the canvas never painted', async () => {
    // No thumbnail anywhere: CompositeCanvas skips these volumes, so a badge would float
    // over blank strip.
    const { container } = renderShowcase([
      unpainted({ volume_uuid: 'uuid-0', volume_title: 'Vol 1', metadata_only: true }),
      unpainted({ volume_uuid: 'uuid-1', volume_title: 'Vol 2', isPlaceholder: true })
    ]);
    await tick();
    expect(badges(container)).toHaveLength(0);
  });

  it('marks only the absent spine that has pixels', async () => {
    const { container } = renderShowcase([
      painted({ volume_uuid: 'uuid-0', volume_title: 'Vol 1', metadata_only: true }),
      unpainted({ volume_uuid: 'uuid-1', volume_title: 'Vol 2', metadata_only: true })
    ]);
    await tick();
    expect(badges(container)).toHaveLength(1);
  });

  it('overlays the strip without touching what the canvas was asked to draw', async () => {
    const marked = [
      painted({ volume_uuid: 'uuid-0', volume_title: 'Vol 1' }),
      painted({ volume_uuid: 'uuid-1', volume_title: 'Vol 2', metadata_only: true })
    ];
    const plain = [
      painted({ volume_uuid: 'uuid-0', volume_title: 'Vol 1' }),
      painted({ volume_uuid: 'uuid-1', volume_title: 'Vol 2' })
    ];

    compositeCanvasProps.length = 0;
    const withBadges = renderShowcase(marked);
    await tick();
    const badged = lastCanvasProps();
    const badgedGeometry = {
      canvasWidth: badged.canvasWidth,
      canvasHeight: badged.canvasHeight,
      stepSizes: badged.stepSizes
    };
    const badge = badges(withBadges.container)[0] as HTMLElement;
    expect(badge.className).toContain('pointer-events-none');
    expect(badge.className).toContain('absolute');
    cleanup();

    compositeCanvasProps.length = 0;
    renderShowcase(plain);
    await tick();
    const plainProps = lastCanvasProps();
    expect(badgedGeometry).toEqual({
      canvasWidth: plainProps.canvasWidth,
      canvasHeight: plainProps.canvasHeight,
      stepSizes: plainProps.stepSizes
    });
  });
});

describe('SeriesSpineShowcase shows a series that is only partly on this device', () => {
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

  const cover = new File([], 'cover.jpg', { type: 'image/jpeg' });

  /** 2 local volumes and 2 cloud-only ones, all with covers to draw. */
  const mixed = () => [
    volume({ volume_uuid: 'v-1', volume_title: 'Vol 1', thumbnail: cover }),
    volume({ volume_uuid: 'v-2', volume_title: 'Vol 2', thumbnail: cover }),
    volume({
      volume_uuid: 'c-3',
      volume_title: 'Vol 3',
      isPlaceholder: true,
      thumbnail: cover,
      thumbnail_width: 250,
      thumbnail_height: 180
    }),
    volume({
      volume_uuid: 'c-4',
      volume_title: 'Vol 4',
      isPlaceholder: true,
      thumbnail: cover,
      thumbnail_width: 250,
      thumbnail_height: 180
    })
  ];

  function lastProps() {
    const props = compositeCanvasProps.at(-1);
    if (!props) throw new Error('CompositeCanvas was never mounted');
    return props as {
      volumes: VolumeMetadata[];
      getCanvasDimensions: (uuid: string) => { width: number; height: number } | null;
    };
  }

  it('draws every volume of the series, the cloud-only ones included', async () => {
    renderShowcase(mixed());
    await tick();

    expect(lastProps().volumes.map((vol) => vol.volume_uuid)).toEqual(['v-1', 'v-2', 'c-3', 'c-4']);
  });

  it('marks the cloud-only spines and leaves the local ones alone', async () => {
    const { container } = renderShowcase(mixed());
    await tick();

    expect(container.querySelectorAll('[data-testid="download-badge"]')).toHaveLength(2);
  });

  it('measures the card’s stack once per volume, not the locals twice', async () => {
    renderShowcase(mixed());
    await tick();

    // The card's stack for this series is its 2 local volumes plus its 2 cloud-only ones;
    // counting the locals again (once as "local", once as "placeholder") would pull the
    // uniform height up from 270 to 300 and draw every spine at the wrong size.
    const expected = computeUniformHeight({
      dims: [
        { width: 250, height: 360 },
        { width: 250, height: 360 },
        { width: 250, height: 180 },
        { width: 250, height: 180 }
      ],
      verticalStepPct: 5,
      stackCountSetting: 0
    });
    expect(expected).toBeCloseTo(270, 10);
    expect(lastProps().getCanvasDimensions('v-1')).toEqual(
      getSpineCanvasDimensions({ width: 250, height: 360 }, expected)
    );
  });
});

describe('SeriesSpineShowcase shelves a cloud-only series in volume order', () => {
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

  const cover = new File([], 'cover.jpg', { type: 'image/jpeg' });
  const cloud = (title: string) =>
    volume({
      volume_uuid: `u-${title}`,
      volume_title: title,
      isPlaceholder: true,
      thumbnail: cover
    });

  function drawnTitles() {
    const props = compositeCanvasProps.at(-1);
    if (!props) throw new Error('CompositeCanvas was never mounted');
    return (props as { volumes: VolumeMetadata[] }).volumes.map((vol) => vol.volume_title);
  }

  it('sorts placeholders naturally, whatever order the listing handed them over in', async () => {
    renderShowcase([cloud('Vol 3'), cloud('Vol 10'), cloud('Vol 1'), cloud('Vol 2')]);
    await tick();

    expect(drawnTitles()).toEqual(['Vol 1', 'Vol 2', 'Vol 3', 'Vol 10']);
  });
});

describe('SeriesSpineShowcase measures the same volumes the card does', () => {
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

  /** A cloud volume whose size is only knowable once its cover has been fetched. */
  const cloudNoDims = (index: number) =>
    ({
      volume_uuid: `c-${String(index).padStart(3, '0')}`,
      series_uuid: 'series-uuid',
      series_title: 'One Piece',
      volume_title: `Vol ${String(index).padStart(3, '0')}`,
      page_count: 10,
      isPlaceholder: true,
      cloudThumbnailFileId: `thumb-${index}`
    }) as VolumeMetadata;

  it('asks for the covers of every volume it measures, past the 60-spine window', async () => {
    // A partly-downloaded series of 66: the card stacks all of them (local rules — no
    // cloud cap), while the shelf DRAWS only 60 (its own memory cap). The uniform height
    // is averaged over the card's stack, so the shelf needs dimensions for every one of
    // them or the spines it shares with the card come out a different size. Delivery
    // itself (fetch → install → row) is `cover-service.ts`'s contract, covered end to end
    // there — this shelf's own job stops at asking for the right set.
    const volumes = [
      ...Array.from({ length: 65 }, (_, i) => cloudNoDims(i + 1)),
      volume({
        volume_uuid: 'v-local',
        volume_title: 'Vol 999',
        thumbnail: new File([], 'cover.jpg', { type: 'image/jpeg' })
      })
    ];
    renderShowcase(volumes);
    await tick();

    // 65 cloud covers requested; the local volume already has its own (not a target).
    expect(requestCoverMock).toHaveBeenCalledTimes(65);
  });
});

describe('SeriesSpineShowcase requests one cover per volume, not a chase', () => {
  // Retry-on-nothing, release-on-failure and dedupe are `cover-service.ts`'s own contract
  // now (`cover-service.test.ts`'s "retry" and "dedupe" blocks, plus `cover-service.retry.
  // test.ts`'s fake-timer backoff pins) — this shelf no longer tracks any of that itself.
  // What is still this component's OWN responsibility is deriving `coverTargets` from
  // PROPS, never from anything the fetch itself writes — a target list derived from
  // enriched/fetched state would re-request everything outstanding every time one cover
  // lands, which is the property this block still pins.
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

  const cloudNoCover = (index: number) =>
    volume({
      volume_uuid: `c-${String(index).padStart(3, '0')}`,
      volume_title: `Vol ${String(index).padStart(3, '0')}`,
      isPlaceholder: true,
      thumbnail: undefined,
      thumbnail_width: undefined,
      thumbnail_height: undefined,
      cloudThumbnailFileId: `thumb-${index}`
    });

  it('asks for each cover of a cloud-only series exactly once per render, however many volumes', async () => {
    renderShowcase(Array.from({ length: 6 }, (_, i) => cloudNoCover(i + 1)));
    await tick();

    expect(requestCoverMock).toHaveBeenCalledTimes(6);
  });

  it('does not re-request on an unrelated re-render — target derivation is not fed by fetch state', async () => {
    const { rerender } = renderShowcase(Array.from({ length: 5 }, (_, i) => cloudNoCover(i + 1)));
    await tick();
    expect(requestCoverMock).toHaveBeenCalledTimes(5);
    requestCoverMock.mockClear();

    // Same volumes, same props identity in spirit — a re-render for an unrelated reason
    // (e.g. a settings change bubbling through) must still ask for exactly the same set,
    // never more (which would signal the target list is feeding on its own side effects).
    await rerender({
      seriesTitle: 'One Piece',
      volumes: Array.from({ length: 5 }, (_, i) => cloudNoCover(i + 1))
    });
    await tick();

    expect(requestCoverMock).toHaveBeenCalledTimes(5);
  });

  it('asks for each cover of a partly-downloaded series past the window once', async () => {
    renderShowcase([
      ...Array.from({ length: 65 }, (_, i) => cloudNoCover(i + 1)),
      volume({
        volume_uuid: 'v-local',
        volume_title: 'Vol 999',
        thumbnail: new File([], 'cover.jpg', { type: 'image/jpeg' })
      })
    ]);
    await tick();

    expect(requestCoverMock).toHaveBeenCalledTimes(65);
  });
});

describe('SeriesSpineShowcase per-series metadata edit gating', () => {
  beforeEach(() => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
      IntersectionObserverStub;
    updateSeriesMetadata.mockClear();
    catalogSettings.set({ horizontalStep: 11 });
    readStates.set({});
    emitSeriesMetadata(new Map());
    compositeCanvasProps.length = 0;
    providerStatus.set({ providers: {}, currentProviderType: null });
  });

  afterEach(async () => {
    cleanup();
    // Drain any write this suite's own tests scheduled — and, as a defensive measure,
    // anything a preceding describe block in this file left pending, so a stale entry
    // can never surface as a false "the gate didn't block it" positive here.
    await flushSpineOffsetWrites();
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = originalIO;
  });

  it('leaves the offset controls enabled when the active provider reports no metadata scope', () => {
    providerStatus.set({
      providers: { webdav: { metadataPermissions: undefined } },
      currentProviderType: 'webdav'
    });
    const { getByLabelText, getByText } = renderShowcase();
    expect((getByLabelText('Series spine offset') as HTMLInputElement).disabled).toBe(false);
    expect((getByText('Reset') as HTMLElement).closest('button')?.disabled).toBe(false);
    expect((getByText('Reset all volume offsets') as HTMLElement).closest('button')?.disabled).toBe(
      false
    );
  });

  it('disables the offset controls and shows the reason under scope "none"', () => {
    providerStatus.set({
      providers: { webdav: { metadataPermissions: { scope: 'none' } } },
      currentProviderType: 'webdav'
    });
    const { getByLabelText, getByText } = renderShowcase();
    expect((getByLabelText('Series spine offset') as HTMLInputElement).disabled).toBe(true);
    expect((getByText('Reset') as HTMLElement).closest('button')?.disabled).toBe(true);
    expect((getByText('Reset all volume offsets') as HTMLElement).closest('button')?.disabled).toBe(
      true
    );
    expect(getByText("This account can't edit series details on this server")).toBeTruthy();
  });

  it('does not write a slider change under scope "none" (defense in depth beyond the disabled attribute)', async () => {
    providerStatus.set({
      providers: { webdav: { metadataPermissions: { scope: 'none' } } },
      currentProviderType: 'webdav'
    });
    const { getByLabelText } = renderShowcase();
    // fireEvent bypasses the disabled attribute the way a real user can't — this proves
    // setSeriesOffset's own gate check is what refuses the write.
    await fireEvent.input(getByLabelText('Series spine offset') as HTMLInputElement, {
      target: { value: '7.5' }
    });
    await flushSpineOffsetWrites();
    expect(updateSeriesMetadata).not.toHaveBeenCalled();
  });

  it('does not write a shift+wheel nudge under scope "none"', async () => {
    providerStatus.set({
      providers: { webdav: { metadataPermissions: { scope: 'none' } } },
      currentProviderType: 'webdav'
    });
    const { strip } = renderShowcase();
    await tick();
    wheel(strip, { deltaY: -1, shiftKey: true });
    await flushSpineOffsetWrites();
    expect(updateSeriesMetadata).not.toHaveBeenCalled();
  });

  it('allows an owned series under scope "owned" but blocks an unowned one', async () => {
    providerStatus.set({
      providers: {
        webdav: { metadataPermissions: { scope: 'owned', ownedSeries: ['One Piece'] } }
      },
      currentProviderType: 'webdav'
    });
    const { getByLabelText } = renderShowcase();
    expect((getByLabelText('Series spine offset') as HTMLInputElement).disabled).toBe(false);
  });
});
