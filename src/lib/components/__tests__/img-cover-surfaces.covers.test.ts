import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';

/**
 * THE TWO `<img>` SURFACES THAT DRAW A CLOUD COVER.
 *
 * `PlaceholderThumbnail` (the series view's grid box, via `PlaceholderVolumeItem` and
 * `VolumeItem`) and `CatalogListItem` (the catalog's list mode) both used to get a
 * cloud volume's cover for free, on their props: `generatePlaceholders` stamped the
 * account's cached blob onto every placeholder, and the catalog decorated a
 * metadata-only row's copy the same way. That decoration is what made ONE cover landing
 * re-derive the whole library and re-render every mounted card — a measured 1,784 ms
 * main-thread long task on a 1,027-series library — so it was removed, and both surfaces
 * would have gone permanently blank for cloud volumes if they did not resolve their own.
 *
 * These are `<img>` surfaces, not canvases, so they read `ResolvedCover.url` — the lazily
 * minted, refcounted object URL `cover-resolver.ts` revokes on last release. The catalog
 * GRID card is canvas-drawn and deliberately never touches `.url`; that one is pinned in
 * `CatalogItem.covers.test.ts`. The THIRD `<img>` surface, `VolumeItem`'s list row (the
 * series page in list layout), needs the whole app stubbed under it and is pinned in
 * `VolumeItem.covers.test.ts`.
 */

const { getActiveProvider } = vi.hoisted(() => ({ getActiveProvider: vi.fn() }));
// `cloudFiles` is here because the FIRST `acquireCover` of a session starts the keys-only
// cover key watch (`cover-resolver.ts`'s `ensureCoverKeyWatch`), which subscribes to this
// listing. An empty one means the watch starts, finds nothing to query, and stays inert.
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    getActiveProvider,
    cloudFiles: {
      subscribe: (fn: (value: Map<string, unknown>) => void) => {
        fn(new Map());
        return () => {};
      }
    }
  }
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

// Fetching a cover that is NOT cached is `cover-service.ts`'s job; this file is about one
// that already is.
vi.mock('$lib/catalog/cover-service', () => ({
  requestCover: vi.fn(),
  isCoverFetchTarget: () => false
}));
vi.mock('$lib/util/modals', () => ({ promptSeriesEditor: vi.fn(), promptConfirmation: vi.fn() }));
vi.mock('$lib/catalog/series-delete', () => ({ promptSeriesRemoval: vi.fn() }));
vi.mock('$lib/util/download-queue', () => ({
  downloadQueue: {
    subscribe: (fn: (v: unknown[]) => void) => {
      fn([]);
      return () => {};
    },
    getSeriesQueueStatus: () => ({ hasQueued: false, hasDownloading: false })
  }
}));
// `CatalogListItem` joins the raw `volumes` store to prefer the STORED row when one
// exists. An EMPTY store is only the cloud-only case (the prop is all there is); the
// case that matters just as much is a store that HAS the row — see the metadata-only
// test below — so this one is publishable rather than a frozen `{}`.
const { catalogVolumes, publishCatalogVolumes } = vi.hoisted(() => {
  const subscribers = new Set<(value: Record<string, unknown>) => void>();
  let value: Record<string, unknown> = {};
  return {
    catalogVolumes: {
      subscribe(fn: (value: Record<string, unknown>) => void) {
        subscribers.add(fn);
        fn(value);
        return () => subscribers.delete(fn);
      }
    },
    publishCatalogVolumes(next: Record<string, unknown>) {
      value = next;
      for (const fn of subscribers) fn(value);
    }
  };
});
vi.mock('$lib/catalog', () => ({ volumes: catalogVolumes }));

import PlaceholderThumbnail from '../PlaceholderThumbnail.svelte';
import CatalogListItem from '../CatalogListItem.svelte';
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

const originalCreate = globalThis.URL.createObjectURL;
const originalRevoke = globalThis.URL.revokeObjectURL;
let created: string[] = [];
let revoked: string[] = [];

/**
 * The keyed `cloud_covers` read runs through `fake-indexeddb`, which drives its requests
 * off the real task queue — microtask flushes alone never let it land, and a handle that
 * has been ACQUIRED but not yet settled looks identical to one that resolved a miss.
 */
async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick();
  }
}

beforeEach(async () => {
  created = [];
  revoked = [];
  globalThis.URL.createObjectURL = vi.fn((blob: Blob) => {
    // NAMED after the blob, not counted: `blob:resolved-1` is what BOTH branches of the
    // "prefers the row's own thumbnail" test below produce, so a counter cannot tell the
    // row's cover apart from the resolver's and that assertion was vacuous.
    const url = `blob:${(blob as File).name}`;
    created.push(url);
    return url;
  }) as never;
  globalThis.URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  }) as never;
  _resetCoverResolverForTests();
  await db.cloud_covers.clear();
  publishCatalogVolumes({});
  useAccount(SCOPE);
});

afterEach(() => {
  cleanup();
  _resetCoverResolverForTests();
  globalThis.URL.createObjectURL = originalCreate;
  globalThis.URL.revokeObjectURL = originalRevoke;
});

describe('PlaceholderThumbnail resolves its own cloud cover', () => {
  it('paints a cached cover for a volume whose props carry none', async () => {
    await putCloudCovers([cachedCover()]);

    const { container } = render(PlaceholderThumbnail, { props: { volume: cloudVolume() } });
    await settle();

    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:cover.webp');
    expect(container.textContent).not.toContain('No thumbnail');
  });

  it('shows the honest placeholder when nothing is cached for its path', async () => {
    const { container } = render(PlaceholderThumbnail, { props: { volume: cloudVolume() } });
    await settle();

    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('No thumbnail');
  });

  it("prefers the row's own thumbnail and claims nothing from the resolver", async () => {
    await putCloudCovers([cachedCover()]);

    const rowCover = new File([new Uint8Array([7, 7])], 'row.jpg', { type: 'image/jpeg' });
    const { container } = render(PlaceholderThumbnail, {
      props: { volume: cloudVolume({ thumbnail: rowCover }) }
    });
    await settle();

    // The ROW's blob, by name — not the cached `cover.webp` sitting under the same path.
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:row.jpg');
    // Nothing was claimed: the row cover won outright, so the resolver never ran.
    expect(_heldCoverCountForTests()).toBe(0);
  });

  it('releases its claim on unmount', async () => {
    await putCloudCovers([cachedCover()]);

    const { unmount } = render(PlaceholderThumbnail, { props: { volume: cloudVolume() } });
    await settle();
    expect(_heldCoverCountForTests()).toBe(1);

    unmount();
    await settle(1);
    expect(_heldCoverCountForTests()).toBe(0);
    // The resolver owns the object URL and gives it up with the last holder.
    expect(revoked).toEqual(['blob:cover.webp']);
  });
});

describe('CatalogListItem resolves its own cloud cover', () => {
  it('paints a cached cover for a cloud-only series row', async () => {
    await putCloudCovers([cachedCover()]);

    const { container } = render(CatalogListItem, { props: { volumes: [cloudVolume()] } });
    await settle();

    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:cover.webp');
  });

  /**
   * THE CASE THE STORE'S OWN SHAPE HIDES.
   *
   * `liveVolume` is `$catalogVolumes[uuid] ?? volume`, and `$catalogVolumes` is the RAW
   * `volumes` store: a STORED row, which never carries `cloudPath` (no writer of those
   * rows persists a cloud field). So the moment a series is opened and its rows
   * materialize, a claim key read off `liveVolume` alone goes blank — permanently, for
   * exactly the metadata-only row the deleted placeholder decoration used to paint, and
   * with `resolveAndDeliver`'s cache-hit gate guaranteeing the row itself never gets
   * filled either. The other tests here mock the store as `{}`, which is the cloud-only
   * case and cannot see it.
   */
  it('paints a cached cover for a materialized metadata-only row', async () => {
    await putCloudCovers([cachedCover()]);

    const listed = cloudVolume({ isPlaceholder: false });
    // What `materializeSeriesVolumes` actually leaves in the store: the same uuid, no
    // thumbnail (its cover is in `cloud_covers`), and NO `cloudPath`.
    publishCatalogVolumes({
      [listed.volume_uuid]: { ...listed, cloudPath: undefined }
    });

    const { container } = render(CatalogListItem, { props: { volumes: [listed] } });
    await settle();

    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:cover.webp');
  });

  it('falls back to the download glyph with nothing cached', async () => {
    const { container } = render(CatalogListItem, { props: { volumes: [cloudVolume()] } });
    await settle();

    expect(container.querySelector('img')).toBeNull();
  });

  it('releases its claim on unmount', async () => {
    await putCloudCovers([cachedCover()]);

    const { unmount } = render(CatalogListItem, { props: { volumes: [cloudVolume()] } });
    await settle();
    expect(_heldCoverCountForTests()).toBe(1);

    unmount();
    await settle(1);
    expect(_heldCoverCountForTests()).toBe(0);
  });
});
