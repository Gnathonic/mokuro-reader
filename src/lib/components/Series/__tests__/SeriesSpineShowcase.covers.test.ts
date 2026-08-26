import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';

/**
 * WHERE THE SPINE SHELF'S CLOUD COVERS COME FROM.
 *
 * The shelf used to get them for free: `generatePlaceholders` stamped the account's
 * cached cover blob onto every placeholder it minted, so a cloud volume arrived on the
 * `volumes` prop already carrying `thumbnail`. That decoration is exactly what made one
 * cover landing re-derive the whole catalog and re-render every mounted card (a measured
 * 1,784 ms main-thread long task on a 1,027-series library), so it was removed — and the
 * moment it was, this shelf would have lost its covers entirely unless it resolved them
 * itself.
 *
 * So this file pins the replacement: the shelf claims each drawn spine's cover by cloud
 * path through `cover-resolver.ts`, draws it, sizes the spine from the CACHE ROW's
 * dimensions (a cloud volume has none of its own), and releases every claim on teardown.
 * Plus the thing that must survive it: a volume with a `thumbnail` on its row still
 * paints from the row.
 */

const { getActiveProvider } = vi.hoisted(() => ({ getActiveProvider: vi.fn() }));
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: { getActiveProvider }
}));

const { providerStatus, publishAccountScope } = vi.hoisted(() => {
  type Status = {
    providers: Record<string, { accountScope?: string } | null>;
    currentProviderType: string | null;
  };
  const subscribers = new Set<(value: Status) => void>();
  let value: Status = { providers: {}, currentProviderType: null };
  return {
    providerStatus: {
      subscribe(fn: (value: Status) => void) {
        subscribers.add(fn);
        fn(value);
        return () => subscribers.delete(fn);
      }
    },
    publishAccountScope(scope: string | null) {
      value = scope
        ? { providers: { webdav: { accountScope: scope } }, currentProviderType: 'webdav' }
        : { providers: {}, currentProviderType: null };
      for (const fn of subscribers) fn(value);
    }
  };
});
vi.mock('$lib/util/sync', () => ({ providerManager: { status: providerStatus } }));

// Fetching a cover that is NOT cached is `cover-service.ts`'s job and has its own suites;
// this file is about one that already is.
vi.mock('$lib/catalog/cover-service', () => ({
  requestCover: vi.fn(),
  isCoverFetchTarget: () => false
}));
vi.mock('$lib/metadata/store', () => ({
  updateSeriesMetadata: vi.fn(),
  seriesMetadataMap: {
    subscribe(fn: (v: Map<string, unknown>) => void) {
      fn(new Map());
      return () => {};
    }
  }
}));
vi.mock('$lib/metadata/series-index', () => ({
  seriesIndexMap: {
    subscribe(fn: (v: Map<string, unknown>) => void) {
      fn(new Map());
      return () => {};
    }
  }
}));

// Records what the shelf asked to be drawn, then renders the real canvas.
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

import SeriesSpineShowcase from '../SeriesSpineShowcase.svelte';
import type { VolumeMetadata } from '$lib/types';
import { db } from '$lib/catalog/db';
import { putCloudCovers, type CloudCover } from '$lib/catalog/cloud-covers';
import { _heldCoverCountForTests, _resetCoverResolverForTests } from '$lib/catalog/cover-resolver';

const SCOPE = 'webdav:https://host/dav|nathan';
const CLOUD_PATH = 'Dr Stone/Volume 01.cbz';

function useAccount(scope: string | null): void {
  getActiveProvider.mockReturnValue(scope ? { getStatus: () => ({ accountScope: scope }) } : null);
  publishAccountScope(scope);
}

function cachedCover(over: Partial<CloudCover> = {}): CloudCover {
  return {
    account_scope: SCOPE,
    path: CLOUD_PATH,
    thumbnail: new File([new Uint8Array([1, 2, 3])], 'cover.webp', { type: 'image/webp' }),
    width: 250,
    height: 350,
    cached_at: 1756000000000,
    ...over
  };
}

/** A cloud-only volume: no row, so nothing on it can carry a cover — only a listing path. */
function cloudVolume(over: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    volume_uuid: 'cloud-uuid-1',
    series_uuid: 'series-uuid',
    series_title: 'Dr Stone',
    volume_title: 'Volume 01',
    mokuro_version: 'unknown',
    page_count: 10,
    character_count: 0,
    page_char_counts: [],
    isPlaceholder: true,
    cloudPath: CLOUD_PATH,
    ...over
  } as VolumeMetadata;
}

function installedVolume(over: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    volume_uuid: 'local-uuid-1',
    series_uuid: 'series-uuid',
    series_title: 'Dr Stone',
    volume_title: 'Volume 02',
    mokuro_version: '0.2.1',
    page_count: 10,
    character_count: 100,
    page_char_counts: [],
    isPlaceholder: false,
    thumbnail: new File([new Uint8Array([9, 9, 9, 9])], 'row-cover.jpg', { type: 'image/jpeg' }),
    thumbnail_width: 240,
    thumbnail_height: 340,
    ...over
  } as VolumeMetadata;
}

function installBrowserStubs(): void {
  class IO {
    private cb: (entries: unknown[]) => void;
    constructor(cb: (entries: unknown[]) => void) {
      this.cb = cb;
    }
    observe() {
      this.cb([{ isIntersecting: true }]);
    }
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  (globalThis as unknown as Record<string, unknown>).IntersectionObserver = IO;
  (HTMLCanvasElement.prototype as unknown as Record<string, unknown>).getContext = () => ({
    clearRect: () => {},
    save: () => {},
    restore: () => {},
    strokeRect: () => {},
    drawImage: () => {}
  });
}

async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await tick();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    await tick();
  }
}

function lastCanvasProps(): Record<string, unknown> {
  const props = compositeCanvasProps.at(-1);
  if (!props) throw new Error('CompositeCanvas was never mounted');
  return props;
}

const originalCreate = globalThis.URL.createObjectURL;
const originalRevoke = globalThis.URL.revokeObjectURL;

beforeEach(async () => {
  compositeCanvasProps.length = 0;
  // The shelf draws to a canvas from the `File`, so nothing here should mint an object
  // URL — stubbed anyway because jsdom implements neither.
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:spine-cover') as never;
  globalThis.URL.revokeObjectURL = vi.fn() as never;
  installBrowserStubs();
  _resetCoverResolverForTests();
  await db.cloud_covers.clear();
  useAccount(SCOPE);
});

afterEach(() => {
  cleanup();
  _resetCoverResolverForTests();
  globalThis.URL.createObjectURL = originalCreate;
  globalThis.URL.revokeObjectURL = originalRevoke;
});

describe('the spine shelf resolves its own cloud covers', () => {
  it('draws a cached cover for a cloud volume whose props carry none', async () => {
    await putCloudCovers([cachedCover()]);

    render(SeriesSpineShowcase, {
      props: { seriesTitle: 'Dr Stone', volumes: [cloudVolume()] }
    });
    await settle();

    const covers = lastCanvasProps().covers as Map<string, File>;
    expect(covers.get('cloud-uuid-1')).toBeInstanceOf(File);
    expect(covers.get('cloud-uuid-1')?.size).toBe(3);
  });

  it('sizes the spine from the cached cover row, which is the only place its dimensions live', async () => {
    // A `cloud_covers` row carries the cover's dimensions; a cloud volume's props carry
    // none, so without the resolver the shelf has nothing to size a spine with and paints
    // an empty strip.
    await putCloudCovers([cachedCover({ width: 199, height: 299 })]);

    render(SeriesSpineShowcase, {
      props: { seriesTitle: 'Dr Stone', volumes: [cloudVolume()] }
    });
    await settle();

    const dims = (
      lastCanvasProps().getCanvasDimensions as (uuid: string) => { width: number } | null
    )('cloud-uuid-1');
    expect(dims).not.toBeNull();
    // Contain-fitted to the strip's uniform height at 1x zoom, so the exact pixel value
    // is geometry's business — what matters is that it came from the 199x299 cover row
    // and not from the 250x350 default box.
    expect(dims!.width).toBeLessThan(250);
  });

  it('stays empty for a cloud volume with nothing cached for its path', async () => {
    render(SeriesSpineShowcase, {
      props: { seriesTitle: 'Dr Stone', volumes: [cloudVolume()] }
    });
    await settle();

    const covers = lastCanvasProps().covers as Map<string, File>;
    expect(covers.size).toBe(0);
    expect(
      (lastCanvasProps().getCanvasDimensions as (uuid: string) => unknown)('cloud-uuid-1')
    ).toBeNull();
  });

  it('keeps painting an installed volume from its own row', async () => {
    // The row's cover must always win: the resolver is the CLOUD path and nothing else.
    render(SeriesSpineShowcase, {
      props: { seriesTitle: 'Dr Stone', volumes: [installedVolume({ cloudPath: CLOUD_PATH })] }
    });
    await settle();

    const covers = lastCanvasProps().covers as Map<string, File>;
    expect(covers.size).toBe(0);
    expect(_heldCoverCountForTests()).toBe(0);
    const dims = (
      lastCanvasProps().getCanvasDimensions as (uuid: string) => { width: number } | null
    )('local-uuid-1');
    expect(dims).not.toBeNull();
  });

  it('releases every claim when the shelf goes away', async () => {
    await putCloudCovers([cachedCover()]);

    const { unmount } = render(SeriesSpineShowcase, {
      props: { seriesTitle: 'Dr Stone', volumes: [cloudVolume()] }
    });
    await settle();
    expect(_heldCoverCountForTests()).toBe(1);

    unmount();
    await settle(1);
    expect(_heldCoverCountForTests()).toBe(0);
  });
});
