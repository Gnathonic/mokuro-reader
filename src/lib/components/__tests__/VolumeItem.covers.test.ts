import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';

/**
 * THE SERIES PAGE IN LIST LAYOUT.
 *
 * `SeriesView` draws installed rows, "Available in <provider>" metadata-only rows AND
 * index-adopted placeholders through `VolumeItem variant="list"`. Its GRID variant has
 * always resolved a cloud cover (it delegates its empty case to `PlaceholderThumbnail`);
 * the list row painted `liveVolume.thumbnail` and nothing else, which worked only while
 * `generatePlaceholders` stamped the cached blob onto every placeholder and the catalog
 * decorated a metadata-only row's copy the same way. That decoration is what turned one
 * cover landing into a whole-library re-derive (a measured 1,784 ms main-thread long task
 * on a 1,027-series library), so it was removed — and this row went blank for every cloud
 * volume, permanently: `resolveAndDeliver`'s cache-hit gate means a cover already in
 * `cloud_covers` is never fetched onto the row either, so nothing would ever fill it.
 *
 * VolumeItem sits on top of the whole app, so everything below the template is stubbed
 * (same philosophy as `VolumeItem.test.ts`) — EXCEPT `$lib/catalog/db`, which has to be a
 * real Dexie over `fake-indexeddb` because the cover read under test is a keyed
 * `cloud_covers.get`.
 */

const { routeParams, catalogVolumes, publishCatalogVolumes } = vi.hoisted(() => {
  function createStore<T>(initial: T) {
    const subs = new Set<(v: T) => void>();
    let current = initial;
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
  const catalogVolumes = createStore<Record<string, unknown>>({});
  return {
    routeParams: createStore<Record<string, string | undefined>>({ manga: 'Dr Stone' }),
    catalogVolumes,
    publishCatalogVolumes: (value: Record<string, unknown>) => catalogVolumes.set(value)
  };
});

function emptyStore<T>(value: T) {
  return {
    subscribe(fn: (v: T) => void) {
      fn(value);
      return () => {};
    }
  };
}

const { getActiveProvider, providerStatus, publishAccountScope } = vi.hoisted(() => {
  type Status = {
    hasAnyAuthenticated: boolean;
    providers: Record<string, { accountScope?: string; isReadOnly?: boolean } | null>;
    currentProviderType: string | null;
  };
  const subscribers = new Set<(value: Status) => void>();
  let value: Status = { hasAnyAuthenticated: false, providers: {}, currentProviderType: null };
  return {
    getActiveProvider: vi.fn(),
    providerStatus: {
      subscribe(fn: (value: Status) => void) {
        subscribers.add(fn);
        fn(value);
        return () => subscribers.delete(fn);
      }
    },
    publishAccountScope(scope: string | null) {
      value = scope
        ? {
            hasAnyAuthenticated: true,
            providers: { webdav: { accountScope: scope, isReadOnly: false } },
            currentProviderType: 'webdav'
          }
        : { hasAnyAuthenticated: false, providers: {}, currentProviderType: null };
      for (const fn of subscribers) fn(value);
    }
  };
});

vi.mock('$lib/settings', () => ({
  deleteVolume: vi.fn(),
  progress: emptyStore<Record<string, number>>({}),
  volumes: emptyStore<Record<string, unknown>>({}),
  settings: emptyStore({ inactivityTimeoutMinutes: 5 }),
  markVolumeAsComplete: vi.fn(),
  markVolumeAsUnread: vi.fn()
}));
vi.mock('$lib/settings/reading-speed', () => ({
  personalizedReadingSpeed: emptyStore({ isPersonalized: false, charsPerMinute: 0 })
}));
vi.mock('$lib/catalog', () => ({ volumes: catalogVolumes }));
vi.mock('$lib/import', () => ({
  removeVolumeFiles: vi.fn(),
  deleteVolumeCompletely: vi.fn()
}));
vi.mock('$lib/util', () => ({ promptConfirmation: vi.fn(), showSnackbar: vi.fn() }));
vi.mock('$lib/util/modals', () => ({ promptExtraction: vi.fn(), promptVolumeEditor: vi.fn() }));
vi.mock('$lib/util/zip', () => ({ zipManga: vi.fn() }));
vi.mock('$lib/util/hash-router', () => ({
  nav: { toReader: vi.fn(), toSeries: vi.fn(), toCatalog: vi.fn(), toVolumeText: vi.fn() },
  routeParams
}));
// `cloudFiles` is here because the FIRST `acquireCover` of a session starts the keys-only
// cover key watch (`cover-resolver.ts`'s `ensureCoverKeyWatch`), which subscribes to this
// listing. An empty one means the watch starts, finds nothing to query, and stays inert.
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    getActiveProvider,
    cloudFiles: emptyStore(new Map()),
    isFetching: emptyStore(false),
    getDefaultProvider: () => null,
    deleteManagedVolume: vi.fn(),
    deleteFile: vi.fn()
  }
}));
vi.mock('$lib/util/sync', () => ({ providerManager: { status: providerStatus } }));
vi.mock('$lib/util/backup-queue', () => ({ backupQueue: { queueVolumeForBackup: vi.fn() } }));
vi.mock('$lib/util/download-queue', () => ({
  downloadQueue: {
    subscribe: (fn: (v: unknown[]) => void) => (fn([]), () => {}),
    queueVolume: vi.fn()
  }
}));
vi.mock('$lib/util/progress-tracker', () => ({
  progressTrackerStore: {
    subscribe: (fn: (v: { processes: unknown[] }) => void) => (fn({ processes: [] }), () => {})
  }
}));
vi.mock('../BackupButton.svelte', () => ({ default: () => ({}) }));
// Fetching a cover that is NOT cached is `cover-service.ts`'s job (pinned end to end in
// `cover-service.test.ts`); this file is about drawing one that already is. The request
// itself is still observed — the list row has to ASK, the way the grid variant does.
const { requestCoverMock } = vi.hoisted(() => ({ requestCoverMock: vi.fn() }));
vi.mock('$lib/catalog/cover-service', () => ({
  requestCover: (...a: Parameters<typeof requestCoverMock>) => requestCoverMock(...a),
  isCoverFetchTarget: (vol: { thumbnail?: unknown }) => !vol.thumbnail
}));

import VolumeItem from '../VolumeItem.svelte';
import type { VolumeMetadata } from '$lib/types';
import { db } from '$lib/catalog/db';
import { putCloudCovers, type CloudCover } from '$lib/catalog/cloud-covers';
import { _heldCoverCountForTests, _resetCoverResolverForTests } from '$lib/catalog/cover-resolver';
import {
  installIntersectionObserverStub,
  type ObservedCoverGate
} from '$lib/catalog/__tests__/intersection-observer-stub';

const SCOPE = 'webdav:https://host/dav|nathan';
const CLOUD_PATH = 'Dr Stone/Volume 03.cbz';

function useAccount(scope: string | null): void {
  getActiveProvider.mockReturnValue(
    scope ? { type: 'webdav', getStatus: () => ({ accountScope: scope }) } : null
  );
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

/**
 * A volume the series page lists but this device does not have the pages for, as the
 * catalog hands it down: `cloudPath` from the LISTING, no thumbnail.
 */
function cloudVolume(over: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    volume_uuid: 'cloud-uuid-3',
    series_uuid: 'series-uuid',
    series_title: 'Dr Stone',
    volume_title: 'Volume 03',
    mokuro_version: '0.4.11',
    page_count: 10,
    character_count: 100,
    page_char_counts: [100],
    isPlaceholder: true,
    cloudPath: CLOUD_PATH,
    ...over
  } as VolumeMetadata;
}

const originalCreate = globalThis.URL.createObjectURL;
const originalRevoke = globalThis.URL.revokeObjectURL;

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
  globalThis.URL.createObjectURL = vi.fn((blob: Blob) => `blob:${(blob as File).name}`) as never;
  globalThis.URL.revokeObjectURL = vi.fn() as never;
  requestCoverMock.mockClear();
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

function coverBox(container: HTMLElement) {
  return container.querySelector('img');
}

describe('VolumeItem list row resolves its own cloud cover', () => {
  it('paints a cached cover for an index-adopted placeholder', async () => {
    await putCloudCovers([cachedCover()]);

    const { container } = render(VolumeItem, {
      props: { volume: cloudVolume(), variant: 'list' }
    });
    await settle();

    expect(coverBox(container)?.getAttribute('src')).toBe('blob:cover.webp');
    expect(container.textContent).not.toContain('Cover');
  });

  /**
   * THE CASE `$catalogVolumes` HIDES. `liveVolume` prefers the STORED row, and a stored
   * row never carries `cloudPath` — no writer of those rows persists a cloud field. So
   * the moment a series open materializes its rows, a claim read off `liveVolume` alone
   * goes blank for exactly the metadata-only row the deleted decoration used to paint.
   */
  it('paints a cached cover for a materialized metadata-only row', async () => {
    await putCloudCovers([cachedCover()]);

    const listed = cloudVolume({ isPlaceholder: false, metadata_only: true });
    publishCatalogVolumes({
      [listed.volume_uuid]: { ...listed, cloudPath: undefined }
    });

    const { container } = render(VolumeItem, { props: { volume: listed, variant: 'list' } });
    await settle();

    expect(coverBox(container)?.getAttribute('src')).toBe('blob:cover.webp');
  });

  it('shows the honest "Cover" box when nothing is cached for its path', async () => {
    const { container } = render(VolumeItem, {
      props: { volume: cloudVolume(), variant: 'list' }
    });
    await settle();

    expect(coverBox(container)).toBeNull();
    expect(container.textContent).toContain('Cover');
  });

  it("prefers the row's own thumbnail and claims nothing from the resolver", async () => {
    await putCloudCovers([cachedCover()]);

    const rowCover = new File([new Uint8Array([7, 7])], 'row.jpg', { type: 'image/jpeg' });
    const { container } = render(VolumeItem, {
      props: { volume: cloudVolume({ thumbnail: rowCover }), variant: 'list' }
    });
    await settle();

    // The ROW's blob, by name — not the cached `cover.webp` sitting under the same path.
    expect(coverBox(container)?.getAttribute('src')).toBe('blob:row.jpg');
    expect(_heldCoverCountForTests()).toBe(0);
  });

  it('releases its claim on unmount', async () => {
    await putCloudCovers([cachedCover()]);

    const { unmount } = render(VolumeItem, {
      props: { volume: cloudVolume(), variant: 'list' }
    });
    await settle();
    expect(_heldCoverCountForTests()).toBe(1);

    unmount();
    await settle(1);
    expect(_heldCoverCountForTests()).toBe(0);
  });

  // The other half of what the grid variant gets from `PlaceholderThumbnail`: with
  // nothing cached anywhere, SOMETHING has to ask for the cover, or a series opened in
  // list layout could never acquire one in the first place.
  it('asks the cover service for a cloud volume it has no cover for', async () => {
    render(VolumeItem, { props: { volume: cloudVolume(), variant: 'list' } });
    await settle();

    expect(requestCoverMock).toHaveBeenCalledTimes(1);
    expect(requestCoverMock.mock.calls[0][0]).toMatchObject({ cloudPath: CLOUD_PATH });
  });
});

/**
 * THE GATE, ON THE ONE COVER SURFACE THAT HAD NO HELD-SHUT TEST.
 *
 * Everything above renders in bare jsdom, which has no `IntersectionObserver` — and
 * `observeNearViewport` deliberately opens the gate synchronously when there is none, so
 * an unstubbed suite behaves exactly as it did before the gate existed. That makes
 * "asks the cover service for a cloud volume it has no cover for" green whether or not
 * this row ever attaches `use:gate`: delete the directive and the list row would request
 * NOTHING, EVER, in a real browser, with nothing in the console and every test still
 * passing. That is the silent failure `warnIfUngated` exists to catch, and this row was
 * the last of the five cover surfaces without a case that catches it.
 *
 * So this describe installs the stub held SHUT and asserts the three things that
 * together can only be true of a gate that is really wired: a gate was armed, nothing
 * was requested before it opened, and opening it is what produced the request.
 */
describe('THE GATE: the list row asks for nothing until it scrolls into view', () => {
  let observer: { gates: ObservedCoverGate[]; restore(): void };
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    observer = installIntersectionObserverStub({ autoIntersect: false });
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    observer.restore();
    warn.mockRestore();
  });

  it('arms a gate, requests nothing while it is shut, and requests on open', async () => {
    render(VolumeItem, { props: { volume: cloudVolume(), variant: 'list' } });
    await settle();

    // Not vacuous: the row is mounted, its target list is derived, and it really did arm
    // a gate — the gate simply has not opened. A row with no `use:gate` arms none.
    expect(observer.gates).toHaveLength(1);
    expect(requestCoverMock).not.toHaveBeenCalled();

    // And `cover-claims`' dev warning agrees: nothing here is ungated.
    expect(
      warn.mock.calls.some(([first]) => String(first).includes('never attached `use:gate`'))
    ).toBe(false);

    // What a scroll does.
    for (const gate of observer.gates) gate.emit(true);
    await settle(1);

    expect(requestCoverMock).toHaveBeenCalledTimes(1);
    expect(requestCoverMock.mock.calls[0][0]).toMatchObject({ cloudPath: CLOUD_PATH });
  });

  it('paints a cached cover with the gate still shut — claiming is not gated', async () => {
    // The distinction the gate rests on: the row DRAWS what it already holds regardless
    // of the viewport; the gate only decides whether it goes to the network for what it
    // is missing.
    await putCloudCovers([cachedCover()]);

    const { container } = render(VolumeItem, {
      props: { volume: cloudVolume(), variant: 'list' }
    });
    await settle();

    expect(requestCoverMock).not.toHaveBeenCalled();
    expect(coverBox(container)?.getAttribute('src')).toBe('blob:cover.webp');
  });
});
