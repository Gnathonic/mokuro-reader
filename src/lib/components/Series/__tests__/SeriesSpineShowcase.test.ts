import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';

// vi.hoisted: the vi.mock factories below are hoisted above this module's imports, so the
// stores/spies they close over must be built here (same pattern as CatalogItem.shortcut.test.ts).
const { updateSeriesMetadata, emitSeriesMetadata, seriesMetadataMap, catalogSettings } = vi.hoisted(
  () => {
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
      catalogSettings: createStore<Record<string, unknown> | undefined>({ horizontalStep: 11 })
    };
  }
);

// The real spine-offsets module stays in play (debounce, clamps, patch building); only the
// Dexie-backed store underneath it is stubbed.
vi.mock('$lib/metadata/store', () => ({ updateSeriesMetadata, seriesMetadataMap }));
vi.mock('$lib/settings/settings', () => ({ catalogSettings }));
vi.mock('$lib/catalog/cloud-thumbnails', () => ({
  fetchCloudThumbnail: vi.fn(async () => null),
  getCachedCloudThumbnail: vi.fn(() => undefined)
}));

import SeriesSpineShowcase from '../SeriesSpineShowcase.svelte';
import type { VolumeMetadata } from '$lib/types';
import type { SeriesMetadata } from '$lib/metadata/types';
import { flushSpineOffsetWrites } from '$lib/metadata/spine-offsets';
import { fetchCloudThumbnail } from '$lib/catalog/cloud-thumbnails';

// Geometry the component renders with: a 250×360 thumbnail drawn at a uniform 200px tall
// spine is 138.89px wide, and the default 11 % step puts spine i at i × 15.28px. So
// x = 150 is past volume 0's right edge but still inside volume 1's — the deterministic
// way to hover a specific spine in jsdom (where layout is all zeroes).
const HIT_VOLUME_1_X = 150;

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
  { deltaY = 0, shiftKey = false, altKey = false }: Partial<Record<string, unknown>> & object = {}
): Event {
  const e = new Event('wheel', { bubbles: true, cancelable: true });
  Object.defineProperties(e, {
    deltaY: { value: deltaY },
    deltaX: { value: 0 },
    shiftKey: { value: shiftKey },
    altKey: { value: altKey }
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
    emitSeriesMetadata(new Map());
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
    renderShowcase(many);
    await tick();

    expect(vi.mocked(fetchCloudThumbnail)).toHaveBeenCalledTimes(60);
  });
});
