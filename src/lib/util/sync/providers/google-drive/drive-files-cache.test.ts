import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api-client', () => ({
  driveApiClient: {
    listFiles: vi.fn()
  }
}));

vi.mock('../../folder-deduplicator', () => ({
  folderDeduplicator: {
    deduplicateAll: vi.fn().mockResolvedValue({ groupsMerged: 0 })
  }
}));

vi.mock('./google-drive-provider', () => ({
  googleDriveProvider: {
    isAuthenticated: vi.fn(() => false),
    getFolderOperations: vi.fn(() => ({}))
  }
}));

import { driveApiClient } from './api-client';
import { folderDeduplicator } from '../../folder-deduplicator';
import { googleDriveProvider } from './google-drive-provider';
import { driveFilesCache } from './drive-files-cache';
import { CACHE_MUTATION_COALESCE_MS } from '../../coalesced-cache-store';

describe('driveFilesCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    driveFilesCache.clear();
  });

  it('caches Drive sidecar files needed for downloads', async () => {
    (driveApiClient.listFiles as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'folder-1',
        name: 'Series',
        mimeType: 'application/vnd.google-apps.folder'
      },
      {
        id: 'cbz-1',
        name: 'Volume 1.cbz',
        mimeType: 'application/x-cbz',
        parents: ['folder-1'],
        modifiedTime: '2026-03-09T00:00:00.000Z',
        size: '100'
      },
      {
        id: 'mokuro-1',
        name: 'Volume 1.mokuro',
        mimeType: 'application/json',
        parents: ['folder-1'],
        modifiedTime: '2026-03-09T00:00:00.000Z',
        size: '20'
      },
      {
        id: 'mokurogz-1',
        name: 'Volume 1.mokuro.gz',
        mimeType: 'application/gzip',
        parents: ['folder-1'],
        modifiedTime: '2026-03-09T00:00:00.000Z',
        size: '10'
      },
      {
        id: 'webp-1',
        name: 'Volume 1.webp',
        mimeType: 'image/webp',
        parents: ['folder-1'],
        modifiedTime: '2026-03-09T00:00:00.000Z',
        size: '5'
      }
    ]);

    await driveFilesCache.fetch();

    expect(
      driveFilesCache
        .getAllFiles()
        .map((file) => file.path)
        .sort()
    ).toEqual([
      'Series/Volume 1.cbz',
      'Series/Volume 1.mokuro',
      'Series/Volume 1.mokuro.gz',
      'Series/Volume 1.webp'
    ]);
  });
});

/**
 * The cache — NOT `GoogleDriveProvider.listCloudVolumes()` — is Drive's real
 * sync path (`cacheManager.registerCache('google-drive', driveFilesCache)`), so
 * the root-config classification has to be right HERE.
 *
 * Root config files are keyed by BASENAME, and `get()/has()` resolve a key from
 * `path.split('/')[0]`. A `<Series>/catalog.json` cached at the bare name would
 * therefore shadow the real root catalog and readers would fetch the wrong file.
 */
describe('driveFilesCache root config classification', () => {
  const FOLDER_MIME = 'application/vnd.google-apps.folder';

  beforeEach(() => {
    (driveApiClient.listFiles as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'reader-root', name: 'mokuro-reader', mimeType: FOLDER_MIME },
      { id: 'series-1', name: 'Dr Stone', mimeType: FOLDER_MIME, parents: ['reader-root'] },
      {
        id: 'root-catalog',
        name: 'catalog.json',
        mimeType: 'application/json',
        parents: ['reader-root'],
        modifiedTime: '2026-08-23T00:00:00.000Z',
        size: '30'
      },
      {
        id: 'nested-catalog',
        name: 'catalog.json',
        mimeType: 'application/json',
        parents: ['series-1'],
        modifiedTime: '2026-08-23T00:00:00.000Z',
        size: '40'
      },
      {
        id: 'root-progress',
        name: 'volume-data.json',
        mimeType: 'application/json',
        parents: ['reader-root'],
        modifiedTime: '2026-08-23T00:00:00.000Z',
        size: '50'
      }
    ]);
  });

  it('caches the ROOT catalog.json at its bare name', async () => {
    await driveFilesCache.fetch();

    expect(driveFilesCache.getAll('catalog.json').map((f) => f.fileId)).toEqual(['root-catalog']);
  });

  it('never lets a NESTED catalog.json shadow the root one', async () => {
    await driveFilesCache.fetch();

    // Grouped under its series, addressable by its full path — never at the root key.
    expect(driveFilesCache.get('Dr Stone/catalog.json')?.fileId).toBe('nested-catalog');
    expect(driveFilesCache.getAllFiles().filter((f) => f.path === 'catalog.json')).toHaveLength(1);
  });

  it('still caches volume-data.json for the progress sync path', async () => {
    await driveFilesCache.fetch();

    expect(driveFilesCache.getVolumeDataFileId()).toBe('root-progress');
  });
});

/**
 * `<Series>/series.json` is a sidecar of the SERIES FOLDER. Drive's cache is the
 * only listing that hand-rolled its sidecar test, so the file was invisible here
 * while every other provider listed it through the shared allowlist — the whole
 * series-index read/refresh path was dead against Drive.
 */
describe('driveFilesCache series.json sidecar', () => {
  const FOLDER_MIME = 'application/vnd.google-apps.folder';

  function listing(files: Array<Record<string, unknown>>) {
    (driveApiClient.listFiles as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'reader-root', name: 'mokuro-reader', mimeType: FOLDER_MIME },
      { id: 'series-1', name: 'Dr Stone', mimeType: FOLDER_MIME, parents: ['reader-root'] },
      ...files
    ]);
  }

  it('caches <Series>/series.json under its series folder', async () => {
    listing([
      {
        id: 'series-file-1',
        name: 'series.json',
        mimeType: 'application/json',
        parents: ['series-1'],
        modifiedTime: '2026-08-23T00:00:00.000Z',
        size: '60'
      }
    ]);

    await driveFilesCache.fetch();

    expect(driveFilesCache.get('Dr Stone/series.json')?.fileId).toBe('series-file-1');
    expect(driveFilesCache.getBySeries('Dr Stone').map((f) => f.path)).toEqual([
      'Dr Stone/series.json'
    ]);
  });

  it('still ignores a .json that merely ENDS with series.json', async () => {
    listing([
      {
        id: 'not-ours',
        name: 'my-series.json',
        mimeType: 'application/json',
        parents: ['series-1'],
        modifiedTime: '2026-08-23T00:00:00.000Z',
        size: '60'
      }
    ]);

    await driveFilesCache.fetch();

    expect(driveFilesCache.getAllFiles()).toEqual([]);
  });
});

/**
 * A whole-account fetch takes a snapshot when it starts paging and publishes
 * it much later — thirteen `files.list` round trips on a 12,500-file library.
 * What happens to everything that changed in between is not a detail: the app
 * records its OWN uploads here (`uploadFile` → `cache.add`) so a just-written
 * `<Series>/series.json` is visible before the next listing, and erasing those
 * records does not merely lose information, it feeds a loop — the reconcile
 * pass reads the cache, sees archives with no `series.json`, schedules the
 * write again, the write uploads and re-adds, the next fetch erases it again.
 */
describe('driveFilesCache fetch/mutation interleaving', () => {
  const FOLDER_MIME = 'application/vnd.google-apps.folder';

  beforeEach(() => {
    vi.clearAllMocks();
    driveFilesCache.clear();
  });

  /** The listing as it stood when this fetch started paging — no series.json. */
  const LISTING_WITHOUT_SIDECAR = [
    { id: 'reader-root', name: 'mokuro-reader', mimeType: FOLDER_MIME },
    { id: 'series-1', name: 'Dr Stone', mimeType: FOLDER_MIME, parents: ['reader-root'] },
    {
      id: 'cbz-1',
      name: 'Volume 1.cbz',
      mimeType: 'application/x-cbz',
      parents: ['series-1'],
      modifiedTime: '2026-08-25T00:00:00.000Z',
      size: '100'
    }
  ];

  /**
   * A fetch whose paging is still in flight, so a test can mutate the cache
   * at exactly the moment the real hazard occurs.
   */
  function pendingFetch(): { finish: (files: unknown[]) => void; done: Promise<void> } {
    let release!: (files: unknown[]) => void;
    const paged = new Promise<unknown[]>((resolve) => {
      release = resolve;
    });
    (driveApiClient.listFiles as unknown as ReturnType<typeof vi.fn>).mockReturnValue(paged);
    const done = driveFilesCache.fetch();
    return { finish: release, done };
  }

  it('keeps an upload that landed while the fetch was paging', async () => {
    const { finish, done } = pendingFetch();

    // The write this app made itself, mid-fetch — the exact thing
    // `uploadFile` records so the reconcile pass can see it.
    driveFilesCache.add('Dr Stone/series.json', {
      provider: 'google-drive',
      fileId: 'series-file-1',
      name: 'series.json',
      path: 'Dr Stone/series.json',
      modifiedTime: '2026-08-25T01:00:00.000Z',
      modifiedTimeProvisional: false,
      size: 60
    });

    finish(LISTING_WITHOUT_SIDECAR);
    await done;

    expect(driveFilesCache.get('Dr Stone/series.json')?.fileId).toBe('series-file-1');
    // ...and the listing's own files are still there: the replay adds, it does
    // not replace.
    expect(driveFilesCache.get('Dr Stone/Volume 1.cbz')?.fileId).toBe('cbz-1');
  });

  it('TYPE PIN: add() requires modifiedTimeProvisional to be stated, not omitted', () => {
    // `CloudCache['add']`'s metadata parameter is `CacheAddMetadata<T>` —
    // `T` with `modifiedTimeProvisional` promoted from optional to required
    // — specifically so a call site cannot silently default to
    // "server-truth" by leaving it out. This omits it on purpose: if a
    // future change ever loosens `add()`'s signature back to accepting the
    // plain (optional-flag) metadata type, this line stops producing a type
    // error and the unused `@ts-expect-error` directive itself becomes a
    // compile error (TS2578) under `npm run check` — the loosening cannot
    // land silently.
    // @ts-expect-error modifiedTimeProvisional omitted — see comment above
    driveFilesCache.add('Dr Stone/series.json', {
      provider: 'google-drive',
      fileId: 'series-file-1',
      name: 'series.json',
      path: 'Dr Stone/series.json',
      modifiedTime: '2026-08-25T01:00:00.000Z',
      size: 60
    });
  });

  it('discards a listing whose account was cleared mid-fetch', async () => {
    const { finish, done } = pendingFetch();

    // Logout / provider switch, both of which go through `clear()`.
    driveFilesCache.clear();

    finish(LISTING_WITHOUT_SIDECAR);
    await done;

    expect(driveFilesCache.getAllFiles()).toEqual([]);
  });

  it('publishes the SAME map identity when the listing has not changed', async () => {
    (driveApiClient.listFiles as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      LISTING_WITHOUT_SIDECAR
    );

    await driveFilesCache.fetch();
    let first: unknown;
    driveFilesCache.store.subscribe((value) => {
      first = value;
    })();

    await driveFilesCache.fetch();
    let second: unknown;
    driveFilesCache.store.subscribe((value) => {
      second = value;
    })();

    // Identity IS the signal `catalog/index.ts` re-mints every placeholder on.
    expect(second).toBe(first);
  });

  it('publishes a NEW map identity when the listing really moved', async () => {
    (driveApiClient.listFiles as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      LISTING_WITHOUT_SIDECAR
    );
    await driveFilesCache.fetch();
    let first: unknown;
    driveFilesCache.store.subscribe((value) => {
      first = value;
    })();

    (driveApiClient.listFiles as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      ...LISTING_WITHOUT_SIDECAR,
      {
        id: 'cbz-2',
        name: 'Volume 2.cbz',
        mimeType: 'application/x-cbz',
        parents: ['series-1'],
        modifiedTime: '2026-08-25T00:00:00.000Z',
        size: '200'
      }
    ]);
    await driveFilesCache.fetch();
    let second: unknown;
    driveFilesCache.store.subscribe((value) => {
      second = value;
    })();

    expect(second).not.toBe(first);
    expect(driveFilesCache.get('Dr Stone/Volume 2.cbz')?.fileId).toBe('cbz-2');
  });
});

/**
 * The state/emission split, at Drive's own cache — the one with the
 * mutation-replay machinery and the `sameCacheMap` identity skip, both of
 * which the coalescing has to coexist with. (The primitive itself is pinned
 * in `coalesced-cache-store.test.ts`; the cross-provider path in
 * `cache-emission-coalescing.test.ts`.)
 */
describe('driveFilesCache emission coalescing', () => {
  const FOLDER_MIME = 'application/vnd.google-apps.folder';

  const LISTING_WITHOUT_SIDECAR = [
    { id: 'reader-root', name: 'mokuro-reader', mimeType: FOLDER_MIME },
    { id: 'series-1', name: 'Dr Stone', mimeType: FOLDER_MIME, parents: ['reader-root'] },
    {
      id: 'cbz-1',
      name: 'Volume 1.cbz',
      mimeType: 'application/x-cbz',
      parents: ['series-1'],
      modifiedTime: '2026-08-25T00:00:00.000Z',
      size: '100'
    }
  ];

  /**
   * The same account WITH the sidecar this suite's `add()` writes — built so
   * the listing's entry tokenizes identically to the added one (`fileToken`
   * compares fileId, path, name, mtime, size, description, parentId), which
   * is exactly what a listing that has caught up with our own upload looks
   * like.
   */
  const LISTING_WITH_SIDECAR = [
    ...LISTING_WITHOUT_SIDECAR,
    {
      id: 'series-file-1',
      name: 'series.json',
      mimeType: 'application/json',
      parents: ['series-1'],
      modifiedTime: '2026-08-25T01:00:00.000Z',
      size: '60'
    }
  ];

  const SIDECAR_ADD = {
    provider: 'google-drive',
    fileId: 'series-file-1',
    name: 'series.json',
    path: 'Dr Stone/series.json',
    modifiedTime: '2026-08-25T01:00:00.000Z',
    modifiedTimeProvisional: false,
    size: 60,
    parentId: 'series-1'
  } as const;

  let seen: unknown[];
  let unsubscribe: () => void;

  function watchStore(): void {
    seen = [];
    unsubscribe = driveFilesCache.store.subscribe((map) => {
      seen.push(map);
    });
    seen.length = 0; // drop the subscribe-time replay
  }

  function pendingFetch(): { finish: (files: unknown[]) => void; done: Promise<void> } {
    let release!: (files: unknown[]) => void;
    const paged = new Promise<unknown[]>((resolve) => {
      release = resolve;
    });
    (driveApiClient.listFiles as unknown as ReturnType<typeof vi.fn>).mockReturnValue(paged);
    const done = driveFilesCache.fetch();
    return { finish: release, done };
  }

  function pathsIn(map: unknown): string[] {
    return [...(map as Map<string, { path: string }[]>).values()]
      .flat()
      .map((file) => file.path)
      .sort();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    driveFilesCache.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    unsubscribe?.();
    vi.useRealTimers();
  });

  it('shows an add() to the synchronous readers IMMEDIATELY while the store emission is pending', () => {
    watchStore();

    driveFilesCache.add('Dr Stone/series.json', SIDECAR_ADD);

    // The reads the backfill drain and reconcile re-derive from at upload
    // time — un-lagged, or a just-uploaded sidecar would be re-uploaded.
    expect(driveFilesCache.get('Dr Stone/series.json')?.fileId).toBe('series-file-1');
    expect(driveFilesCache.getBySeries('Dr Stone').map((f) => f.path)).toEqual([
      'Dr Stone/series.json'
    ]);
    expect(driveFilesCache.has('Dr Stone/series.json')).toBe(true);

    // ...while the emission is GENUINELY still pending: without this line
    // the reads above would also pass under publish-per-add and pin nothing.
    expect(seen).toHaveLength(0);

    vi.advanceTimersByTime(CACHE_MUTATION_COALESCE_MS);
    expect(seen).toHaveLength(1);
    expect(pathsIn(seen[0])).toEqual(['Dr Stone/series.json']);
  });

  it('publishes a burst of adds ONCE, not once per file', () => {
    watchStore();

    for (let vol = 1; vol <= 5; vol++) {
      driveFilesCache.add(`Dr Stone/Volume ${vol}.mokuro`, {
        ...SIDECAR_ADD,
        fileId: `mokuro-${vol}`,
        name: `Volume ${vol}.mokuro`,
        path: `Dr Stone/Volume ${vol}.mokuro`
      });
    }

    expect(seen).toHaveLength(0);
    vi.advanceTimersByTime(CACHE_MUTATION_COALESCE_MS);

    expect(seen).toHaveLength(1);
    expect(pathsIn(seen[0])).toHaveLength(5);

    vi.advanceTimersByTime(10 * CACHE_MUTATION_COALESCE_MS);
    expect(seen).toHaveLength(1);
  });

  it('a coalesced add pending when a fetch installs a CHANGED listing is superseded — replayed into the install, never fired after it', async () => {
    const { finish, done } = pendingFetch();
    watchStore();

    // Mid-fetch upload: recorded for replay AND riding the coalescing timer.
    driveFilesCache.add('Dr Stone/series.json', SIDECAR_ADD);
    expect(seen).toHaveLength(0);

    finish(LISTING_WITHOUT_SIDECAR);
    await done;

    // ONE emission: the atomic swap, already carrying the replayed add.
    expect(seen).toHaveLength(1);
    expect(pathsIn(seen[0])).toEqual(['Dr Stone/Volume 1.cbz', 'Dr Stone/series.json']);

    // The pre-fetch timer is dead — nothing fires later to spend another Map
    // identity (or worse, publish the pre-fetch state) on top of the install.
    vi.advanceTimersByTime(10 * CACHE_MUTATION_COALESCE_MS);
    expect(seen).toHaveLength(1);
  });

  it('the sameCacheMap skip still delivers a pending add AT fetch completion (flush), preserving identity when nothing is pending', async () => {
    // Seed: the account as fetched once already.
    (driveApiClient.listFiles as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      LISTING_WITHOUT_SIDECAR
    );
    await driveFilesCache.fetch();

    watchStore();

    // Second fetch in flight; our own upload lands mid-page.
    const { finish, done } = pendingFetch();
    driveFilesCache.add('Dr Stone/series.json', SIDECAR_ADD);
    expect(seen).toHaveLength(0);

    // The listing comes back already CONTAINING that upload — content-equal
    // to the state, so the identity-preserving skip refuses the set()...
    finish(LISTING_WITH_SIDECAR);
    await done;

    // ...but the pending add is flushed AT completion, not left to the
    // timer: consumers treat "the fetch resolved" as "the listing is
    // visible". No timer advance before this assertion, deliberately.
    expect(seen).toHaveLength(1);
    expect(pathsIn(seen[0])).toEqual(['Dr Stone/Volume 1.cbz', 'Dr Stone/series.json']);

    // And quiet afterwards: the flush consumed the pending emission.
    vi.advanceTimersByTime(10 * CACHE_MUTATION_COALESCE_MS);
    expect(seen).toHaveLength(1);
  });
});

/**
 * `runDeduplication` re-enters `fetchAllFiles` whenever a merge happened. That
 * is fine while dedup converges, and an unbounded whole-account refetch engine
 * when duplicate folders keep being created between passes — a Drive-only
 * failure mode, since no other provider runs a dedup pass at all.
 */
describe('driveFilesCache dedup refetch', () => {
  it('stops re-entering the fetch once the merge count refuses to settle', async () => {
    driveFilesCache.clear();
    const listFiles = driveApiClient.listFiles as unknown as ReturnType<typeof vi.fn>;
    listFiles.mockReset();
    let fetches = 0;
    listFiles.mockImplementation(async () => {
      fetches += 1;
      return [];
    });
    (googleDriveProvider.isAuthenticated as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      true
    );
    // Every pass reports a merge, exactly as an account whose duplicates are
    // recreated as fast as they are merged would — until a HARD CEILING well
    // above the bound lets the chain terminate. Without that ceiling an
    // unbounded chain does not fail this test, it hangs the whole suite
    // forever, which is a worse way to learn the same thing.
    const RUNAWAY_CEILING = 10;
    (folderDeduplicator.deduplicateAll as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => ({
        groupsMerged: fetches > RUNAWAY_CEILING ? 0 : 1,
        foldersDeleted: 1,
        itemsMoved: 1
      })
    );

    await driveFilesCache.fetch();
    // Drain the fire-and-forget dedup chain (dynamic imports + microtasks).
    for (let round = 0; round < RUNAWAY_CEILING + 5; round++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    // 1 initial + at most MAX_DEDUP_REFETCHES re-entries. Unbounded before —
    // this ran to the ceiling instead.
    expect(fetches).toBeLessThanOrEqual(3);
    // ...and the chain really did engage: a bound that never fired would
    // prove nothing.
    expect(fetches).toBeGreaterThan(1);
  });
});
