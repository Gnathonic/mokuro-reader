import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';

// vi.hoisted: the vi.mock factories below are hoisted above this module's imports, so the
// stores/spies they close over must be built here (same pattern as CatalogItem.shortcut.test.ts).
const {
  updateSeriesMetadata,
  emitSeriesMetadata,
  seriesMetadataMap,
  catalogSettings,
  progressStore,
  compositeCanvasProps
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
    // Read progress drives the card's "hide read volumes" subset, which the shelf mirrors.
    progressStore: createStore<Record<string, number>>({}),
    // Props CompositeCanvas was last mounted with — real drawing is a canvas no-op in
    // jsdom, so this is the only way to see what the showcase actually asked it to draw.
    compositeCanvasProps: [] as Record<string, unknown>[]
  };
});

// The real spine-offsets module stays in play (debounce, clamps, patch building); only the
// Dexie-backed store underneath it is stubbed.
vi.mock('$lib/metadata/store', () => ({ updateSeriesMetadata, seriesMetadataMap }));
vi.mock('$lib/settings/settings', () => ({ catalogSettings }));
// Mocked so the real module (Dexie-backed volume data) stays out of the graph.
vi.mock('$lib/settings/volume-data', () => ({ progress: progressStore }));
vi.mock('$lib/catalog/cloud-thumbnails', () => ({
  fetchCloudThumbnail: vi.fn(async () => null),
  getCachedCloudThumbnail: vi.fn(() => undefined)
}));
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
import { fetchCloudThumbnail } from '$lib/catalog/cloud-thumbnails';
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

class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
const originalIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;

function volume(overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    volume_uuid: 'uuid-1',
    series_uuid: 'series-uuid',
    series_title: 'One Piece',
    volume_title: 'Vol 1',
    page_count: 10,
    isPlaceholder: false,
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

describe('SeriesSpineShowcase', () => {
  beforeEach(() => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
      IntersectionObserverStub;
    updateSeriesMetadata.mockClear();
    vi.mocked(fetchCloudThumbnail).mockClear();
    catalogSettings.set({ horizontalStep: 11 });
    progressStore.set({});
    emitSeriesMetadata(new Map());
    compositeCanvasProps.length = 0;
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

    expect(resolvePatch(0, { spine_offset: 4 })).toEqual({ spine_offset: undefined });
  });

  it('alt+shift+right-click resets only the hovered volume', async () => {
    emitSeriesMetadata(metaMap({ volume_offsets: { 'uuid-0': 3, 'uuid-1': -5 } }));
    const { strip } = renderShowcase();
    await tick();

    pointer(strip, 'pointermove', { clientX: HIT_VOLUME_1_X });
    contextMenu(strip, { shiftKey: true, altKey: true });
    await flushSpineOffsetWrites();

    expect(resolvePatch(0, { volume_offsets: { 'uuid-0': 3, 'uuid-1': -5 } })).toEqual({
      volume_offsets: { 'uuid-0': 3 }
    });
  });

  it('Reset clears the series offset', async () => {
    emitSeriesMetadata(metaMap({ spine_offset: 4 }));
    const { getByText } = renderShowcase();
    await tick();

    await fireEvent.click(getByText('Reset'));
    await flushSpineOffsetWrites();

    expect(resolvePatch(0, { spine_offset: 4 })).toEqual({ spine_offset: undefined });
  });

  it('“Reset all volume offsets” drops every per-volume nudge', async () => {
    emitSeriesMetadata(metaMap({ volume_offsets: { 'uuid-0': 3, 'uuid-1': -5 } }));
    const { getByText } = renderShowcase();
    await tick();

    await fireEvent.click(getByText('Reset all volume offsets'));
    await flushSpineOffsetWrites();

    expect(resolvePatch(0, { volume_offsets: { 'uuid-0': 3, 'uuid-1': -5 } })).toEqual({
      volume_offsets: undefined
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

  it('caps how many volumes it renders and fetches thumbnails for', async () => {
    const many = Array.from({ length: 70 }, (_, i) =>
      volume({
        volume_uuid: `uuid-${String(i).padStart(3, '0')}`,
        volume_title: `Vol ${String(i + 1).padStart(3, '0')}`,
        isPlaceholder: true,
        thumbnail_width: undefined,
        thumbnail_height: undefined,
        cloudThumbnailFileId: `file-${i}`
      })
    );
    const { getByText } = renderShowcase(many);
    await tick();

    expect(vi.mocked(fetchCloudThumbnail)).toHaveBeenCalledTimes(60);
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
    progressStore.set({ 'uuid-0': 9 });
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
