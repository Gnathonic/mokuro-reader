import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';

/**
 * A stand-in for the real thumbnail cache with the same three moving parts the canvas
 * depends on: a synchronous read, an async load, and a commit notification. Loads are
 * held open so a test can decide exactly when a bitmap lands.
 */
const { fakeCache } = vi.hoisted(() => {
  const entries = new Map<string, unknown>();
  const waiting = new Map<string, (entry: unknown) => void>();
  const listeners = new Set<(uuid: string) => void>();
  return {
    fakeCache: {
      getSync: vi.fn((uuid: string) => entries.get(uuid)),
      get: vi.fn(
        (uuid: string) =>
          new Promise((resolve) => {
            waiting.set(uuid, resolve);
          })
      ),
      subscribeCommits: vi.fn((fn: (uuid: string) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      }),
      /** Land a bitmap the canvas itself asked for. */
      commit(uuid: string) {
        const entry = { bitmap: { width: 250, height: 360 }, width: 250, height: 360, size: 1 };
        entries.set(uuid, entry);
        const resolve = waiting.get(uuid);
        waiting.delete(uuid);
        resolve?.(entry);
        for (const fn of listeners) fn(uuid);
      },
      /** Land a bitmap someone ELSE asked for: no promise of ours resolves. */
      commitExternally(uuid: string) {
        const entry = { bitmap: { width: 250, height: 360 }, width: 250, height: 360, size: 1 };
        entries.set(uuid, entry);
        for (const fn of listeners) fn(uuid);
      },
      pendingCount: () => waiting.size,
      reset() {
        entries.clear();
        waiting.clear();
        listeners.clear();
      }
    }
  };
});
vi.mock('$lib/catalog/thumbnail-cache', () => ({ thumbnailCache: fakeCache }));

import CompositeCanvas from '../CompositeCanvas.svelte';
import type { VolumeMetadata } from '$lib/types';

let drawnBitmaps: unknown[] = [];

function installCanvasStub() {
  (HTMLCanvasElement.prototype as unknown as Record<string, unknown>).getContext = function () {
    return {
      clearRect: () => {},
      save: () => {},
      restore: () => {},
      strokeRect: () => {},
      drawImage: (bitmap: unknown) => drawnBitmaps.push(bitmap)
    };
  };
}

/** jsdom has no IntersectionObserver; report the canvas as on screen. */
function installIntersectionObserver() {
  class IO {
    private cb: (entries: unknown[]) => void;
    constructor(cb: (entries: unknown[]) => void) {
      this.cb = cb;
    }
    observe() {
      this.cb([{ isIntersecting: true }]);
    }
    disconnect() {}
  }
  (globalThis as unknown as Record<string, unknown>).IntersectionObserver = IO;
}

function volume(uuid: string, withThumbnail: boolean): VolumeMetadata {
  return {
    volume_uuid: uuid,
    series_uuid: 'series',
    series_title: 'Series',
    volume_title: uuid,
    page_count: 10,
    thumbnail: withThumbnail ? (new Blob(['cover']) as unknown as File) : undefined,
    thumbnail_width: withThumbnail ? 250 : undefined,
    thumbnail_height: withThumbnail ? 360 : undefined
  } as VolumeMetadata;
}

const baseProps = {
  canvasWidth: 320,
  canvasHeight: 400,
  getCanvasDimensions: () => ({ width: 250, height: 360 }),
  stepSizes: { horizontal: 20, vertical: 0, leftOffset: 0, topOffset: 0 }
};

/** Let the effects run and the rAF-scheduled draw actually happen. */
async function settle(frames = 4) {
  for (let i = 0; i < frames; i++) {
    await tick();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    await tick();
  }
}

beforeEach(() => {
  drawnBitmaps = [];
  fakeCache.reset();
  fakeCache.getSync.mockClear();
  fakeCache.get.mockClear();
  installCanvasStub();
  installIntersectionObserver();
});

afterEach(() => cleanup());

describe('CompositeCanvas redraws when thumbnails arrive after it mounted', () => {
  it('paints the stack once the covers land, having mounted with none', async () => {
    const { rerender } = render(CompositeCanvas, {
      props: { ...baseProps, volumes: [volume('a', false), volume('b', false)] } as never
    });
    await settle();

    // Nothing to paint yet, and nothing asked of the cache: a volume with no cover has
    // no pixels to load.
    expect(drawnBitmaps).toHaveLength(0);
    expect(fakeCache.get).not.toHaveBeenCalled();

    // The covers are generated/downloaded and the catalog re-emits the rows.
    await rerender({ volumes: [volume('a', true), volume('b', true)] } as never);
    await settle();
    expect(fakeCache.get).toHaveBeenCalledTimes(2);

    fakeCache.commit('a');
    fakeCache.commit('b');
    await settle();

    expect(drawnBitmaps.length).toBeGreaterThanOrEqual(2);
  });

  it('paints a cover committed by another surface, with no re-render of its own', async () => {
    // The bitmap is already loading when this canvas mounts (another card sharing the
    // volume, a cover install, a re-decode) — so no load of its own resolves for it.
    const { container } = render(CompositeCanvas, {
      props: { ...baseProps, volumes: [volume('shared', true)] } as never
    });
    await settle();
    expect(drawnBitmaps).toHaveLength(0);
    expect(container.querySelectorAll('canvas').length).toBeGreaterThan(0);

    fakeCache.commitExternally('shared');
    await settle();

    // Without a commit subscription this canvas has no way to learn the cover landed.
    expect(drawnBitmaps).toHaveLength(1);
  });

  it('stops listening for commits once it is destroyed', async () => {
    const { unmount } = render(CompositeCanvas, {
      props: { ...baseProps, volumes: [volume('gone', true)] } as never
    });
    await settle();
    unmount();
    await settle();

    expect(() => fakeCache.commitExternally('gone')).not.toThrow();
    expect(drawnBitmaps).toHaveLength(0);
  });
});
