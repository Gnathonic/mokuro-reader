import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import { installIntersectionObserverStub } from '$lib/catalog/__tests__/intersection-observer-stub';

/**
 * WHERE A CATALOG CARD'S COVER COMES FROM.
 *
 * Covers used to reach a card by riding the catalog derivation: a cover landing in
 * `cloud_covers` re-materialised every row in that table, re-walked the whole cloud
 * listing, minted fresh placeholder objects and re-rendered every mounted card. Measured
 * on a 1,027-series library that was a 1,784 ms main-thread long task; freezing only the
 * re-derive dropped it to 122 ms.
 *
 * The fix is for a card to fetch its own cover by path (`cover-resolver.ts`), so cover
 * arrival can be cut out of the derivation entirely. That only works if a card can get a
 * cover with NOTHING on its `volumes` prop carrying one — which is what this file pins,
 * together with the two things that must survive it: an installed volume still painting
 * the cover on its own row, and every claim being released on unmount.
 */

// --- the account the resolver reads under -----------------------------------------
// `acquireCover` binds the scope at acquire time, so the card has to re-acquire when the
// account changes; `providerManager.status` is the reactive half and `getActiveProvider`
// the one the resolver itself calls. `useAccount` moves both together.
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

// --- the graph this file deliberately does not load --------------------------------
vi.mock('$lib/util/modals', () => ({ promptSeriesEditor: vi.fn(), promptConfirmation: vi.fn() }));
vi.mock('$lib/catalog/series-delete', () => ({ promptSeriesRemoval: vi.fn() }));
vi.mock('$lib/util', () => ({ showSnackbar: vi.fn() }));
vi.mock('$lib/util/download-queue', () => ({
  downloadQueue: {
    subscribe: (fn: (v: unknown[]) => void) => {
      fn([]);
      return () => {};
    },
    getSeriesQueueStatus: () => ({ hasQueued: false, hasDownloading: false })
  }
}));
// Fetching a cover that is NOT cached is `cover-service.ts`'s job and has its own suites;
// this file is about a cover that is already cached — so `isCoverFetchTarget` answers no
// by default and nothing here asks for anything. THE GATE describe at the bottom flips it
// on, which is the only place the ask path is in play.
const { requestCoverMock, isCoverFetchTargetMock } = vi.hoisted(() => ({
  requestCoverMock: vi.fn(),
  isCoverFetchTargetMock: vi.fn(() => false)
}));
vi.mock('$lib/catalog/cover-service', () => ({
  requestCover: (...args: Parameters<typeof requestCoverMock>) => requestCoverMock(...args),
  isCoverFetchTarget: (...args: unknown[]) =>
    (isCoverFetchTargetMock as unknown as (...a: unknown[]) => boolean)(...args)
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

/**
 * A stand-in for the bitmap cache, so the decode key is observable. `thumbnailCache` is
 * keyed by `volume_uuid` while the resolver is keyed by cloud PATH — the card has to
 * bridge those, and decoding a resolver-supplied cover under anything but the volume's
 * uuid would miss the cache on every re-render.
 */
const { fakeCache } = vi.hoisted(() => {
  const entries = new Map<string, unknown>();
  const listeners = new Set<(uuid: string) => void>();
  return {
    fakeCache: {
      getSync: vi.fn((uuid: string) => entries.get(uuid)),
      get: vi.fn(async (uuid: string) => {
        const entry = { bitmap: { width: 250, height: 350 }, width: 250, height: 350, size: 1 };
        entries.set(uuid, entry);
        for (const fn of listeners) fn(uuid);
        return entry;
      }),
      subscribeCommits: vi.fn((fn: (uuid: string) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      }),
      reset() {
        entries.clear();
        listeners.clear();
      }
    }
  };
});
vi.mock('$lib/catalog/thumbnail-cache', () => ({ thumbnailCache: fakeCache }));

// Records what the card asked to be drawn, then renders the real canvas.
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

import CatalogItem from '../CatalogItem.svelte';
import type { VolumeMetadata } from '$lib/types';
import { db } from '$lib/catalog/db';
import { putCloudCovers, type CloudCover } from '$lib/catalog/cloud-covers';
import {
  refreshCoverKeys,
  _heldCoverCountForTests,
  _resetCoverResolverForTests
} from '$lib/catalog/cover-resolver';

const SCOPE = 'webdav:https://host/dav|nathan';
const OTHER_SCOPE = 'webdav:https://host/dav|someone-else';
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

/** An installed volume, carrying its cover on the row exactly as it always has. */
function installedVolume(over: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    volume_uuid: 'local-uuid-1',
    series_uuid: 'series-uuid',
    series_title: 'One Piece',
    volume_title: 'Volume 01',
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

/** jsdom has no 2D context; hand the canvas one so it will "paint". */
function installCanvasContext(): void {
  (HTMLCanvasElement.prototype as unknown as Record<string, unknown>).getContext = () => ({
    clearRect: () => {},
    save: () => {},
    restore: () => {},
    strokeRect: () => {},
    drawImage: () => {}
  });
}

/**
 * The one `IntersectionObserver` stand-in, shared with every other cover suite.
 *
 * This file used to hand-roll its own always-intersecting class, which reported BOTH
 * kinds of observer visible: the canvas one (which this file wants — it stubs a context
 * above and asserts on what reached it) and the cover GATE (which it never meant to open
 * and never asserted about). The shared stub separates those: `canvasVisible: true` is
 * this file's real requirement, and the gate is left to be driven on purpose.
 */
let observer: ReturnType<typeof installIntersectionObserverStub>;

/** Let the effects, the resolver's keyed read and the rAF-scheduled draw all land. */
async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await tick();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    await tick();
  }
}

/** The props the last mounted CompositeCanvas was handed. */
function lastCanvasProps(): Record<string, unknown> {
  const props = compositeCanvasProps.at(-1);
  if (!props) throw new Error('CompositeCanvas was never mounted');
  return props;
}

// jsdom implements neither, and NOTHING on the catalog card's path should need them: the
// card draws its covers to a canvas from the `File`, so reading `ResolvedCover.url` would
// mint one object URL per cover — ~4,000 of them on a large library — for nothing.
const originalCreate = globalThis.URL.createObjectURL;
const originalRevoke = globalThis.URL.revokeObjectURL;
let createdObjectUrls = 0;

beforeEach(async () => {
  compositeCanvasProps.length = 0;
  fakeCache.reset();
  fakeCache.get.mockClear();
  fakeCache.getSync.mockClear();
  createdObjectUrls = 0;
  requestCoverMock.mockClear();
  isCoverFetchTargetMock.mockReturnValue(false);
  globalThis.URL.createObjectURL = vi.fn(() => `blob:cover-${++createdObjectUrls}`) as never;
  globalThis.URL.revokeObjectURL = vi.fn() as never;
  installCanvasContext();
  observer = installIntersectionObserverStub({ canvasVisible: true });
  _resetCoverResolverForTests();
  await db.cloud_covers.clear();
  useAccount(SCOPE);
});

afterEach(() => {
  cleanup();
  observer.restore();
  _resetCoverResolverForTests();
  globalThis.URL.createObjectURL = originalCreate;
  globalThis.URL.revokeObjectURL = originalRevoke;
});

describe('a cloud card resolves its own cover', () => {
  it('draws a cached cover for a volume whose props carry none', async () => {
    await putCloudCovers([cachedCover()]);

    // Nothing on this prop carries a cover: no `thumbnail`, no dimensions. Before the
    // card resolved covers itself, this rendered the "Click to download" boxes.
    render(CatalogItem, { props: { volumes: [cloudVolume()] } });
    await settle();

    const covers = lastCanvasProps().covers as Map<string, File>;
    expect(covers.get('cloud-uuid-1')).toBeInstanceOf(File);
    expect(covers.get('cloud-uuid-1')?.size).toBe(3);
  });

  it('decodes it under the volume uuid, so the bitmap cache can hit on re-render', async () => {
    await putCloudCovers([cachedCover()]);

    render(CatalogItem, { props: { volumes: [cloudVolume()] } });
    await settle();

    expect(fakeCache.get).toHaveBeenCalled();
    const [uuid, file] = fakeCache.get.mock.calls[0] as unknown as [string, File];
    expect(uuid).toBe('cloud-uuid-1');
    expect(file.size).toBe(3);
  });

  it('sizes the stack from the cover row, not from the volume prop', async () => {
    await putCloudCovers([cachedCover({ width: 199, height: 299 })]);

    render(CatalogItem, { props: { volumes: [cloudVolume()] } });
    await settle();

    const dims = lastCanvasProps().getCanvasDimensions as (
      uuid: string
    ) => { width: number; height: number } | null;
    const drawn = dims('cloud-uuid-1');
    // Aspect ratio comes from the cached cover (199x299), never the 250x350 default.
    expect(drawn).not.toBeNull();
    expect(drawn!.width / drawn!.height).toBeCloseTo(199 / 299, 3);
  });

  it('never mints an object URL for a cover it is going to draw to a canvas', async () => {
    await putCloudCovers([cachedCover()]);

    render(CatalogItem, { props: { volumes: [cloudVolume()] } });
    await settle();

    expect(lastCanvasProps().covers).toBeInstanceOf(Map);
    expect(createdObjectUrls).toBe(0);
  });

  it('stays on the download boxes when nothing is cached for its path', async () => {
    await putCloudCovers([cachedCover({ path: 'Naruto/Volume 01.cbz' })]);

    const { container } = render(CatalogItem, { props: { volumes: [cloudVolume()] } });
    await settle();

    expect(compositeCanvasProps).toHaveLength(0);
    expect(container.textContent).toContain('Click to download');
  });
});

describe('an installed volume keeps painting the cover on its row', () => {
  it('draws from the row thumbnail and claims nothing from the resolver', async () => {
    // A cached cover exists for a DIFFERENT identity; if the row path ever went through
    // the resolver this would be the only way it could paint at all.
    await putCloudCovers([cachedCover()]);

    render(CatalogItem, { props: { volumes: [installedVolume()] } });
    await settle();

    expect(fakeCache.get).toHaveBeenCalled();
    const [uuid, file] = fakeCache.get.mock.calls[0] as unknown as [string, File];
    expect(uuid).toBe('local-uuid-1');
    // The row's own bytes, not the cached cover's.
    expect(file.size).toBe(4);
    expect(file.name).toBe('row-cover.jpg');
    // A row that carries its cover has nothing to ask the resolver for.
    expect(_heldCoverCountForTests()).toBe(0);
  });

  it('keeps drawing its row cover with no cloud account connected at all', async () => {
    useAccount(null);

    render(CatalogItem, { props: { volumes: [installedVolume()] } });
    await settle();

    const [uuid, file] = fakeCache.get.mock.calls[0] as unknown as [string, File];
    expect(uuid).toBe('local-uuid-1');
    expect(file.name).toBe('row-cover.jpg');
  });

  it('uses the row cover even for a volume that also has a cloud path', async () => {
    // A metadata-only row: its files are gone (so it is decorated with cloud fields and
    // could be re-downloaded), but its thumbnail and history survived. The row wins.
    await putCloudCovers([cachedCover({ path: 'One Piece/Volume 01.cbz' })]);

    render(CatalogItem, {
      props: {
        volumes: [
          installedVolume({ metadata_only: true, cloudPath: 'One Piece/Volume 01.cbz' } as never)
        ]
      }
    });
    await settle();

    const [uuid, file] = fakeCache.get.mock.calls[0] as unknown as [string, File];
    expect(uuid).toBe('local-uuid-1');
    expect(file.name).toBe('row-cover.jpg');
    expect(_heldCoverCountForTests()).toBe(0);
  });
});

describe('claims are released', () => {
  it('holds one claim while mounted and none once unmounted', async () => {
    await putCloudCovers([cachedCover()]);

    const { unmount } = render(CatalogItem, { props: { volumes: [cloudVolume()] } });
    await settle();
    expect(_heldCoverCountForTests()).toBe(1);

    unmount();
    await settle(1);

    expect(_heldCoverCountForTests()).toBe(0);
  });

  it('drops the claim for a volume that leaves the drawn stack', async () => {
    await putCloudCovers([
      cachedCover(),
      cachedCover({ path: 'Dr Stone/Volume 02.cbz', width: 200, height: 300 })
    ]);

    const { rerender } = render(CatalogItem, {
      props: {
        volumes: [
          cloudVolume(),
          cloudVolume({
            volume_uuid: 'cloud-uuid-2',
            volume_title: 'Volume 02',
            cloudPath: 'Dr Stone/Volume 02.cbz'
          })
        ]
      }
    });
    await settle();
    expect(_heldCoverCountForTests()).toBe(2);

    await rerender({ volumes: [cloudVolume()] });
    await settle();

    expect(_heldCoverCountForTests()).toBe(1);
  });
});

/**
 * WHAT A CLAIM-SET CHANGE MUST NOT COST.
 *
 * The claim set is recomputed for things that have nothing to do with a cover: a stack
 * count or hide-read setting change, a series gaining or losing a volume, the series
 * index arriving and re-keying uuids, an account switch. Svelte runs the previous run's
 * TEARDOWN BEFORE the new run, so a card that released first would drop the only claim on
 * every path it is still showing (`dropEntry`), re-acquire into an empty entry, and
 * publish an empty cover map for however long the fresh async read takes — every card in
 * a cloud library swapping its painted stack for "Click to download" boxes at once, and
 * ~4,000 redundant keyed reads behind it.
 */
describe('a claim-set change on a card that is already showing its covers', () => {
  it('neither blanks the card nor re-reads a cover it already resolved', async () => {
    await putCloudCovers([
      cachedCover(),
      cachedCover({
        path: 'Dr Stone/Volume 02.cbz',
        thumbnail: new File([new Uint8Array(5)], 'v2.webp', { type: 'image/webp' })
      })
    ]);

    const { rerender, container } = render(CatalogItem, {
      props: { volumes: [cloudVolume()] }
    });
    await settle();
    // Painting: one canvas mounted, holding the cached cover.
    expect(compositeCanvasProps).toHaveLength(1);
    expect((lastCanvasProps().covers as Map<string, File>).get('cloud-uuid-1')?.size).toBe(3);

    // Every keyed read from HERE on, by path — a path already resolved must not be read
    // a second time just because the claim set moved.
    const realGet = db.cloud_covers.get.bind(db.cloud_covers);
    const readPaths: string[] = [];
    const get = vi.spyOn(db.cloud_covers, 'get').mockImplementation((async (
      key: [string, string]
    ) => {
      readPaths.push(key[1]);
      return realGet(key);
    }) as never);

    try {
      // The series gains a volume: same account, same first path, new claim set.
      await rerender({
        volumes: [
          cloudVolume(),
          cloudVolume({
            volume_uuid: 'cloud-uuid-2',
            volume_title: 'Volume 02',
            cloudPath: 'Dr Stone/Volume 02.cbz'
          })
        ]
      });

      // The frame the flash would happen in: the effect has re-run, and nothing async has
      // had a chance to land yet. The canvas must still be the one that was already up —
      // a remount here IS the card having dropped to the download boxes and come back.
      expect(container.textContent).not.toContain('Click to download');
      expect(compositeCanvasProps).toHaveLength(1);

      await settle();

      expect(container.textContent).not.toContain('Click to download');
      expect(compositeCanvasProps).toHaveLength(1);
      expect((lastCanvasProps().covers as Map<string, File>).get('cloud-uuid-1')?.size).toBe(3);
      expect((lastCanvasProps().covers as Map<string, File>).get('cloud-uuid-2')?.size).toBe(5);
      // Only the volume that JOINED needed a read.
      expect(readPaths).toEqual(['Dr Stone/Volume 02.cbz']);
      // Two paths claimed, each exactly once.
      expect(_heldCoverCountForTests()).toBe(2);
    } finally {
      get.mockRestore();
    }
  });

  it('still blanks rather than showing the previous account cover on a switch', async () => {
    // The one claim-set change where keeping what is resolved would be WRONG: the scope
    // is part of the claim key, so a switch acquires under the new account and finds
    // nothing until its own read lands.
    await putCloudCovers([
      cachedCover({ thumbnail: new File([new Uint8Array(3)], 'a.webp', { type: 'image/webp' }) })
    ]);

    const { container } = render(CatalogItem, { props: { volumes: [cloudVolume()] } });
    await settle();
    expect(compositeCanvasProps).toHaveLength(1);

    useAccount(OTHER_SCOPE);
    await tick();

    // No cover under the new account: the honest state is the download boxes, never the
    // other account's artwork.
    expect(container.textContent).toContain('Click to download');
  });
});

describe('a cover that lands after the card mounted', () => {
  it('reaches the mounted card through refreshCoverKeys, with no re-render of its own', async () => {
    // Mounted with nothing cached: the card resolves a MISS and shows the download boxes.
    render(CatalogItem, { props: { volumes: [cloudVolume()] } });
    await settle();
    expect(compositeCanvasProps).toHaveLength(0);

    // The download finishes and writes the blob (`cover-persist.ts`), then the cover key
    // set tells the resolver which paths just gained one.
    await putCloudCovers([cachedCover()]);
    refreshCoverKeys([CLOUD_PATH]);
    await settle();

    const covers = lastCanvasProps().covers as Map<string, File>;
    expect(covers.get('cloud-uuid-1')?.size).toBe(3);
  });

  it('repaints an ALREADY-MOUNTED canvas when a second cover lands', async () => {
    // One volume's cover is cached at mount, so the canvas is up and painting; the other
    // arrives later. Nothing else the canvas draws with has to move for that, so this is
    // the case where the cover map itself must be what triggers the redraw.
    await putCloudCovers([cachedCover()]);
    const both = [
      cloudVolume(),
      cloudVolume({
        volume_uuid: 'cloud-uuid-2',
        volume_title: 'Volume 02',
        cloudPath: 'Dr Stone/Volume 02.cbz'
      })
    ];

    render(CatalogItem, { props: { volumes: both } });
    await settle();
    expect(fakeCache.get.mock.calls.map((call) => call[0])).toEqual(['cloud-uuid-1']);

    await putCloudCovers([
      cachedCover({
        path: 'Dr Stone/Volume 02.cbz',
        thumbnail: new File([new Uint8Array(5)], 'v2.webp', { type: 'image/webp' })
      })
    ]);
    refreshCoverKeys(['Dr Stone/Volume 02.cbz']);
    await settle();

    expect(fakeCache.get.mock.calls.map((call) => call[0])).toContain('cloud-uuid-2');
  });
});

describe('switching cloud accounts', () => {
  it('re-acquires under the new scope instead of holding the old account cover', async () => {
    await putCloudCovers([
      cachedCover({ thumbnail: new File([new Uint8Array(3)], 'a.webp', { type: 'image/webp' }) }),
      cachedCover({
        account_scope: OTHER_SCOPE,
        thumbnail: new File([new Uint8Array(7)], 'b.webp', { type: 'image/webp' })
      })
    ]);

    render(CatalogItem, { props: { volumes: [cloudVolume()] } });
    await settle();
    expect((lastCanvasProps().covers as Map<string, File>).get('cloud-uuid-1')?.size).toBe(3);

    useAccount(OTHER_SCOPE);
    await settle();

    // Same path, same uuid, different account: the claim key carries the scope, so the
    // old handle is released and a new keyed read runs under the new one.
    expect((lastCanvasProps().covers as Map<string, File>).get('cloud-uuid-1')?.size).toBe(7);
    expect(_heldCoverCountForTests()).toBe(1);
  });
});

/**
 * THE GATE, ON THE SUITE MOST LIKELY TO BE BELIEVED ABOUT COVERS.
 *
 * Everything above is about a cover that is ALREADY cached, which the viewport gate has
 * no say over — a card claims and paints what it draws whether or not it is on screen.
 * That made this file's hand-rolled always-intersecting observer look harmless, and it
 * was not: it reported the gate open too, so the one cover suite anyone would read to
 * learn how covers reach a card was the one place the gate was not in play at all.
 *
 * So this describe drives it by hand. The measured defect it stands for: 1,027 cards x
 * ~4 stacked volumes = ~4,347 cover requests on mount, 134 MB in a 12.2-second burst,
 * for a screenful of maybe six cards.
 */
describe('THE GATE: a card below the fold asks for nothing until it scrolls into view', () => {
  beforeEach(() => {
    // Re-installed held SHUT. The canvas still has to answer visible — this file stubs a
    // 2D context and asserts on what reached it — so only the gate axis changes.
    observer.restore();
    observer = installIntersectionObserverStub({ canvasVisible: true, autoIntersect: false });
    // WHICH volumes are eligible is `cover-service.ts`'s predicate, pinned in
    // `CatalogItem.test.ts`. Every drawn volume is eligible here so that the gate is the
    // only thing left deciding whether anything is asked for.
    isCoverFetchTargetMock.mockReturnValue(true);
  });

  it('holds every request until the card comes within a screenful, then asks', async () => {
    await putCloudCovers([cachedCover()]);

    render(CatalogItem, { props: { volumes: [cloudVolume()] } });
    await settle();

    // Not vacuous: the card is fully mounted, its target list is fully derived, and it
    // really did arm a gate — the gate simply has not opened.
    expect(observer.gates).toHaveLength(1);
    expect(requestCoverMock).not.toHaveBeenCalled();

    // What a scroll does.
    for (const gate of observer.gates) gate.emit(true);
    await settle(1);

    expect(requestCoverMock.mock.calls.map(([vol]) => vol.volume_uuid)).toEqual(['cloud-uuid-1']);
  });

  it('still paints a cached cover while the gate is shut — claiming is not gated', async () => {
    // The distinction the gate rests on, and the reason the tests above were able to
    // pass with it silently open: a card DRAWS what it holds regardless of the viewport;
    // the gate only decides whether it goes to the network for what it is missing.
    await putCloudCovers([cachedCover()]);

    render(CatalogItem, { props: { volumes: [cloudVolume()] } });
    await settle();

    expect(requestCoverMock).not.toHaveBeenCalled();
    expect((lastCanvasProps().covers as Map<string, File>).get('cloud-uuid-1')?.size).toBe(3);
  });
});
