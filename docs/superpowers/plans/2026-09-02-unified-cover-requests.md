# Unified Cover Requests + Sync-Time Metadata Resolution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `requestCover` the one entry point every cover installer goes through — promoting cached covers onto rows the user has read — and run synced-progress metadata resolution once after every progress sync instead of from view mounts, then refit the progress tracker onto both.

**Architecture:** Part A rewrites `cover-service.ts`'s `resolveAndDeliver` into a five-step ladder (skip → cached/promote → row → indexed placeholder → bare placeholder) with an outcome-recording dedupe ledger, and turns `cover-install.ts` and the backfill's stale refresh into candidate builders over it. Part B retains the series-index refresh promise on `unifiedCloudManager`, adds `resolveSyncedProgress()` in `hole-patch.ts` (awaits that promise, then the uncapped enrich→sweep→enrich), and starts it from `syncProgress()` via a dynamic import. Part C (on `feat/progress-tracker`) moves the tracker card onto `createCoverClaims`.

**Tech Stack:** SvelteKit 5 (runes), Dexie 4 over IndexedDB, Vitest + fake-indexeddb, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-02-unified-cover-requests-design.md`

## Global Constraints

- Never write the string `mokuro.moe` anywhere (code, comments, commits, docs).
- No Dexie schema version bump: the new `CloudCover` fields are non-indexed.
- `cloudPath` and the `cloudThumbnail*` fields stay listing decorations on in-memory copies; never persist them on a `volumes` row.
- Every path stays best-effort: nothing in parts A or B may reject into a view, a sync result, or a store subscriber.
- `perf-contracts.test.ts` must stay green untouched (CONTRACTS 1–6).
- Commit messages follow the repo's `type(scope): summary` style; each commit passes `lint-staged` (Prettier). Do not run `git stash`.
- Parts A and B land on `feat/unified-cover-requests` (worktree `/home/nathan/Projects/mokuro-reader-worktrees/feat-unified-cover-requests`). Part C lands on `feat/progress-tracker` (worktree `.../feat-progress-tracker`) after merging the first branch in.
- Run a single test file with `npx vitest run <path>`; the whole suite with `npx vitest run`; types with `npm run check`.

---

## File map

Part A (branch `feat/unified-cover-requests`):

- Modify `src/lib/settings/reading-activity.ts` — no change (imported as-is).
- Modify `src/lib/catalog/cloud-covers.ts` — `CloudCover.cover_size?`/`cover_modified?`.
- Modify `src/lib/catalog/cover-persist.ts` — export `coverBelongsOnRow`; write stamps on cache rows.
- Modify `src/lib/catalog/cover-service.ts` — `CoverOutcome`, options object, ledger `Map`, promotion step, return values.
- Modify `src/lib/catalog/cover-claims.svelte.ts` — `requestCover(vol, { stillNear })`.
- Modify `src/lib/catalog/cover-install.ts` — candidate builder over `requestCover`.
- Modify `src/lib/metadata/series-backfill.ts` — `refreshStaleCover` over `requestCover`.
- Tests: `cover-persist.test.ts`, `cover-service.test.ts` (+ new `cover-service.promote.test.ts`), `cover-install.test.ts`, `series-backfill.test.ts`, `cover-claims.test.ts`.

Part B (same branch):

- Modify `src/lib/util/sync/unified-cloud-manager.ts` — retain index-refresh promise; `whenSeriesIndexesSettled()`; `progressResolution`; start resolution in `syncProgress`.
- Modify `src/lib/metadata/hole-patch.ts` — `resolveSyncedProgress`; remove caps, memo, `patchProgressHolesWhenListingReady`.
- Modify `src/lib/metadata/history-rows.ts` — remove the two caps.
- Modify `src/lib/util/sync/init-providers.ts`, `src/lib/views/CatalogView.svelte`, `src/lib/views/ReadingSpeedView.svelte`.
- Tests: `hole-patch.test.ts`, `history-rows.test.ts`, `unified-cloud-manager.test.ts` (new describe).

Part C (branch `feat/progress-tracker`):

- Modify `src/lib/components/VolumeCard.svelte`, `src/lib/views/ProgressTrackerView.svelte`.
- Delete `docs/superpowers/plans/2026-08-31-metadata-resolution-trigger.md`.
- Tests: new `src/lib/components/__tests__/VolumeCard.covers.test.ts`; e2e `e2e/progress-tracker.spec.ts` re-run.

---

## Part A — Unified cover requests

### Task A1: `coverBelongsOnRow` predicate + stamps on cache rows

**Files:**

- Modify: `src/lib/catalog/cloud-covers.ts:22-40` (the `CloudCover` interface)
- Modify: `src/lib/catalog/cover-persist.ts:608-716` (`flushOneBatch`) and add the export
- Test: `src/lib/catalog/cover-persist.test.ts`

**Interfaces:**

- Produces: `export function coverBelongsOnRow(row: VolumeMetadata | undefined, history: ReadingHistoryEntry | undefined): boolean` in `cover-persist.ts`; `CloudCover.cover_size?: number; cover_modified?: number`.

- [ ] **Step 1: Write the failing tests** (append to `cover-persist.test.ts`; follow its existing harness — real Dexie via `CatalogDexieV3`, hand-rolled `volumes` store mock, `_getCloudCoversForTests`):

```ts
import { coverBelongsOnRow } from './cover-persist';

describe('coverBelongsOnRow', () => {
  const base = {
    volume_uuid: 'u',
    series_uuid: 's',
    series_title: 'S',
    volume_title: 'V',
    mokuro_version: '0.4.11',
    page_count: 1,
    character_count: 1,
    page_char_counts: []
  } as VolumeMetadata;

  it('is false with no row at all', () => {
    expect(coverBelongsOnRow(undefined, { progress: 3 })).toBe(false);
  });
  it('is false for an installed row — its cover comes from its own pages', () => {
    expect(coverBelongsOnRow(base, { progress: 3 })).toBe(false);
  });
  it('is false for a metadata-only row with no reading activity', () => {
    expect(coverBelongsOnRow({ ...base, metadata_only: true }, undefined)).toBe(false);
    expect(coverBelongsOnRow({ ...base, metadata_only: true }, { progress: 0 })).toBe(false);
  });
  it('is true for a metadata-only row the user has read', () => {
    expect(coverBelongsOnRow({ ...base, metadata_only: true }, { completed: true })).toBe(true);
  });
});

describe('cache rows carry the cover stamp', () => {
  it('writes cover_size/cover_modified on the cloud_covers row', async () => {
    // no row → routed to the cache; scope from the mocked provider
    installCover(
      { volume_uuid: 'no-row', cloudPath: 'S/V.cbz' },
      { file: new File(['x'], 'V.webp'), width: 1, height: 2 },
      { size: 321, modifiedTime: '2026-01-02T00:00:00.000Z' }
    );
    await flushPendingCoverPersists();
    const cached = await _getCloudCoversForTests('<scope used by this file>', ['S/V.cbz']);
    expect(cached.get('S/V.cbz')).toMatchObject({
      cover_size: 321,
      cover_modified: Math.floor(Date.parse('2026-01-02T00:00:00.000Z') / 1000)
    });
  });
});
```

(Read the existing file's `beforeEach` to copy the exact scope string its provider mock reports.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/catalog/cover-persist.test.ts`
Expected: FAIL — `coverBelongsOnRow` is not exported; `cover_size` undefined on the cache row.

- [ ] **Step 3: Implement**

In `cloud-covers.ts`, extend the interface (after `height`):

```ts
  /**
   * The listing stamp of the cover sidecar this blob was fetched from —
   * bytes + epoch seconds, the same two fields with the same guards as
   * `VolumeMetadata.cover_size`/`cover_modified`. Written by
   * `cover-persist.ts` at flush; read by `cover-service.ts` when it PROMOTES
   * a cached cover onto a row the user has since read, so the row inherits
   * the freshness the blob actually has rather than the listing's current
   * one. Absent on rows cached before this existed, which the staleness rule
   * treats as never-stale (the migration-safety inversion everywhere else).
   */
  cover_size?: number;
  cover_modified?: number;
```

In `cover-persist.ts`, add the predicate (above `installCover`) and use it in `flushOneBatch`:

```ts
/**
 * Does a cloud cover for this volume belong ON ITS `volumes` ROW?
 *
 * Yes exactly when the row exists, its pages are not on this device
 * (`needsDownload` — an installed volume's thumbnail was measured from its
 * own pages and is never replaced by a cloud guess) and the user has actually
 * read it (`hasReadingActivity`). Everything else — no row, a row minted
 * purely by browsing — is catalog knowledge and belongs in `cloud_covers`.
 *
 * ONE definition, consulted at REQUEST time (`cover-service.ts`, to decide
 * whether a cached cover should be promoted and what outcome to report) and
 * at FLUSH time (below, against the row re-read inside the write
 * transaction). Two copies of this rule would let the service promise a row
 * the queue then refuses.
 */
export function coverBelongsOnRow(
  row: VolumeMetadata | undefined,
  history: ReadingHistoryEntry | undefined
): boolean {
  if (!row) return false;
  if (!needsDownload(row)) return false;
  return hasReadingActivity(history);
}
```

In `flushOneBatch`, replace the `hasRelationship` block with:

```ts
        if (fresh && coverBelongsOnRow(fresh, readingHistory[volumeUuid])) {
          if (mode === 'fill' && fresh.thumbnail) continue;
          ... (unchanged patch + update)
          continue;
        }
```

and in the cache branch add the stamp fields:

```ts
forCoverTable.push({
  account_scope: scope,
  path: cachePath,
  thumbnail: result.file,
  width: result.width,
  height: result.height,
  cached_at: Date.now(),
  ...(coverSize !== undefined ? { cover_size: coverSize } : {}),
  ...(coverModified !== undefined ? { cover_modified: coverModified } : {})
});
```

Remove the now-unused `isVolumeInstalled` import if nothing else uses it.

- [ ] **Step 4: Run the file and the perf contracts**

Run: `npx vitest run src/lib/catalog/cover-persist.test.ts src/lib/catalog/__tests__/perf-contracts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/catalog/cloud-covers.ts src/lib/catalog/cover-persist.ts src/lib/catalog/cover-persist.test.ts
git commit -m "feat(covers): name the row-vs-cache routing rule, stamp cache rows"
```

### Task A2: `requestCover` — options object, outcomes, outcome-recording ledger

**Files:**

- Modify: `src/lib/catalog/cover-service.ts:165-232` (ledger), `:604-777` (`resolveAndDeliver`, `requestCover`)
- Modify: `src/lib/catalog/cover-claims.svelte.ts:296-300` (the request effect)
- Test: `src/lib/catalog/cover-service.test.ts` (adjust the dedupe describe), `src/lib/catalog/cover-claims.test.ts` (probe assertion shape)

**Interfaces:**

- Produces:
  ```ts
  export type CoverOutcome = 'row' | 'cache' | 'none' | 'skipped' | 'unresolved';
  export interface RequestCoverOptions {
    stillNear?: () => boolean;
    refresh?: boolean;
  }
  export function requestCover(
    vol: VolumeMetadata,
    options?: RequestCoverOptions
  ): Promise<CoverOutcome>;
  ```
- Consumes: `coverBelongsOnRow` (A1).

- [ ] **Step 1: Write the failing tests** — in `cover-service.test.ts`, replace the `dedupe` describe with:

```ts
describe('dedupe: the ledger records what was delivered, keyed by scope + uuid + listing stamp', () => {
  it('two requests before settling share ONE fetch; a request after settling is skipped', async () => {
    await db.volumes.put(row('u1'));
    const vol = row('u1', {
      cloudProvider: 'webdav',
      cloudThumbnailFileId: 'c',
      cloudPath: 'One Piece/Volume 01.cbz'
    });
    const [a, b] = await Promise.all([requestCover(vol), requestCover(vol)]);
    expect(fetchCloudThumbnailMock).toHaveBeenCalledTimes(1);
    expect(a).toBe('row');
    expect(b).toBe('row');
    expect(await requestCover(vol)).toBe('skipped');
    expect(fetchCloudThumbnailMock).toHaveBeenCalledTimes(1);
  });

  it('a changed listing stamp is a fresh request, not a skip', async () => {
    await db.volumes.put(row('u1'));
    const vol = row('u1', {
      cloudProvider: 'webdav',
      cloudThumbnailFileId: 'c',
      cloudPath: 'One Piece/Volume 01.cbz',
      cloudThumbnailSize: 10,
      cloudThumbnailModifiedTime: '2026-01-01T00:00:00.000Z'
    });
    expect(await requestCover(vol)).toBe('row');
    await waitForCover('u1');
    const thumbed = {
      ...(await db.volumes.get('u1'))!,
      ...vol,
      cloudThumbnailSize: 11,
      cloudThumbnailModifiedTime: '2026-02-01T00:00:00.000Z'
    } as VolumeMetadata;
    expect(await requestCover(thumbed)).toBe('row');
    expect(fetchCloudThumbnailMock).toHaveBeenCalledTimes(2);
  });

  it("'unresolved' never writes the ledger: the next request retries", async () => {
    fetchCloudThumbnailMock.mockResolvedValue(null);
    await db.volumes.put(row('u1'));
    const vol = row('u1', {
      cloudProvider: 'webdav',
      cloudThumbnailFileId: 'c',
      cloudPath: 'One Piece/Volume 01.cbz'
    });
    vi.useFakeTimers();
    const p = requestCover(vol);
    await vi.advanceTimersByTimeAsync(11000);
    expect(await p).toBe('unresolved');
    vi.useRealTimers();
    fetchCloudThumbnailMock.mockResolvedValue(coverResult());
    expect(await requestCover(vol)).toBe('row');
  });

  it('refresh: true bypasses the ledger and fetches again with mode overwrite', async () => {
    await db.volumes.put(row('u1'));
    const vol = row('u1', {
      cloudProvider: 'webdav',
      cloudThumbnailFileId: 'c',
      cloudPath: 'One Piece/Volume 01.cbz'
    });
    expect(await requestCover(vol)).toBe('row');
    const withThumb = await waitForCover('u1');
    const update = vi.spyOn(db.volumes, 'update');
    expect(
      await requestCover(
        { ...withThumb, ...vol, thumbnail: withThumb.thumbnail },
        { refresh: true }
      )
    ).toBe('row');
    await flushPendingCoverPersists();
    expect(fetchCloudThumbnailMock).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalled();
    update.mockRestore();
  });
});
```

Adjust the retry suite (`cover-service.retry.test.ts`) expectations to the returned outcomes where it inspects behaviour (it should still pass with fire-and-forget usage; only add `expect(await p).toBe('unresolved')` where it awaits the schedule).

In `cover-claims.test.ts`, the probe tests assert `requestCover` was called with `(vol, probe)`; change to `(vol, expect.objectContaining({ stillNear: expect.any(Function) }))` and read the probe from `mock.calls[0][1].stillNear`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/catalog/cover-service.test.ts src/lib/catalog/cover-claims.test.ts`
Expected: FAIL — `requestCover` returns `undefined`; second positional arg shape.

- [ ] **Step 3: Implement** — in `cover-service.ts`:

Replace the ledger declarations:

```ts
export type CoverOutcome = 'row' | 'cache' | 'none' | 'skipped' | 'unresolved';

export interface RequestCoverOptions {
  /** Liveness probe: is the requesting surface still near the viewport? Orders fetches only. */
  stillNear?: () => boolean;
  /**
   * The caller has already decided the cover on hand is STALE (a stamp it
   * computed against the listing): skip the target test, the cache
   * short-circuit and the ledger, fetch, and overwrite whatever is there.
   */
  refresh?: boolean;
}

/** What a settled request delivered, and against which listing stamp. */
interface SettledCover {
  target: 'row' | 'cache' | 'none';
  stamp: string;
}

/** Ledger key → what was delivered. See {@link ledgerKey} and {@link isRedundant}. */
const settled = new Map<string, SettledCover>();
/** Ledger key → the request currently running for it. */
const inFlight = new Map<string, Promise<CoverOutcome>>();

/** The listing's cover-sidecar stamp this request is made against; `':'` when unknown. */
function listingStamp(vol: VolumeMetadata): string {
  return `${vol.cloudThumbnailSize ?? ''}:${vol.cloudThumbnailModifiedTime ?? ''}`;
}

/**
 * Is there nothing left for a request to do? Only when a request for this
 * key already settled against the SAME listing stamp, and delivered to a
 * target at least as good as this volume needs now: a `'row'` or `'none'`
 * answer is final for that stamp; a `'cache'` answer is final only while the
 * volume still has no relationship (once it is read, the same cover must be
 * promoted onto its row).
 */
function isRedundant(vol: VolumeMetadata, entry: SettledCover | undefined): boolean {
  if (!entry || entry.stamp !== listingStamp(vol)) return false;
  if (entry.target !== 'cache') return true;
  return !wantsRow(vol);
}

/** Request-time view of `coverBelongsOnRow`: the volume as the caller holds it, plus the reading store. */
function wantsRow(vol: VolumeMetadata): boolean {
  if (vol.isPlaceholder) return false;
  const history = get(readingHistoryStore) as Record<string, ReadingHistoryEntry>;
  return coverBelongsOnRow(vol, history[vol.volume_uuid]);
}
```

(`get` from `svelte/store`, `volumes as readingHistoryStore` from `$lib/settings/volume-data`, `ReadingHistoryEntry` from `$lib/settings/reading-activity`, `coverBelongsOnRow` from `./cover-persist`.)

Change `resolveAndDeliver`'s signature to `(vol, options): Promise<CoverOutcome | 'retry'>` — every `return true` becomes the outcome it delivered (`'row'`/`'cache'`/`'none'`), every `return false` becomes `'retry'`. Concretely: case 1 → `wantsRow(vol) ? 'row' : 'cache'` after `deliverToRow`, `'none'` when the row has no `cloudThumbnailFileId`; the `!vol.isPlaceholder` no-row exit → `'none'`; case 2 → `'cache'` (or `'none'` with no cover id); case 3/4 → `'foreign'` → `'none'`, no cover → `'none'`, delivered → `'cache'`. The cached fast path returns `'cache'` for now (Task A3 turns it into promotion). `deliverToRow`'s `hadThumbnailAlready` becomes `!!vol.thumbnail || !!options.refresh`.

Rewrite `requestCover`:

```ts
export function requestCover(
  vol: VolumeMetadata,
  options: RequestCoverOptions = {}
): Promise<CoverOutcome> {
  const uuid = vol.volume_uuid;
  if (!uuid) return Promise.resolve('skipped');
  const key = ledgerKey(uuid);
  const running = inFlight.get(key);
  if (running) return running;
  if (!options.refresh) {
    if (isRedundant(vol, settled.get(key))) return Promise.resolve('skipped');
    if (!isCoverFetchTarget(vol)) return Promise.resolve('skipped');
  }

  const run = (async (): Promise<CoverOutcome> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const outcome = await resolveAndDeliver(vol, options);
        if (outcome !== 'retry') {
          settled.set(key, { target: outcome, stamp: listingStamp(vol) });
          return outcome;
        }
        if (attempt >= RETRY_DELAYS_MS.length) return 'unresolved';
        await sleep(RETRY_DELAYS_MS[attempt]);
      } catch (error) {
        if (attempt >= RETRY_DELAYS_MS.length) {
          console.warn(`Cover request failed for ${vol.volume_title}:`, error);
          return 'unresolved';
        }
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  })();

  inFlight.set(key, run);
  void run.finally(() => {
    if (inFlight.get(key) === run) inFlight.delete(key);
  });
  return run;
}
```

Update the module doc's DEDUPE paragraph to describe the outcome ledger. In `cover-claims.svelte.ts` the effect becomes `for (const vol of fetchTargets) void requestCover(vol, { stillNear });`. Update `_resetCoverServiceForTests` (`settled.clear()` still works on a Map).

- [ ] **Step 4: Run**

Run: `npx vitest run src/lib/catalog/`
Expected: PASS (cover-install and perf contracts included).

- [ ] **Step 5: Commit**

```bash
git add src/lib/catalog/cover-service.ts src/lib/catalog/cover-claims.svelte.ts src/lib/catalog/cover-service.test.ts src/lib/catalog/cover-claims.test.ts src/lib/catalog/cover-service.retry.test.ts
git commit -m "feat(covers): requestCover reports its outcome and dedupes on what it delivered"
```

### Task A3: Promotion — a cached cover reaches the row the volume has earned

**Files:**

- Modify: `src/lib/catalog/cover-service.ts` (the cached fast path in `resolveAndDeliver`)
- Test: create `src/lib/catalog/cover-service.promote.test.ts` (copy the harness header of `cover-service.test.ts` verbatim — the mocks, `row()`, `drainQueues`, `waitForCover`).

**Interfaces:**

- Consumes: `coverBelongsOnRow`, `CloudCover.cover_size/cover_modified` (A1); `isSidecarStale`, `isoToEpochSeconds` (`$lib/metadata/cloud-sidecar-stamps`).

- [ ] **Step 1: Write the failing tests**

```ts
async function cacheCover(
  path: string,
  stamp: { cover_size?: number; cover_modified?: number } = {}
) {
  await putCloudCovers([
    {
      account_scope: 'mega:a@b.com',
      path,
      thumbnail: new File(['cached'], 'c.webp', { type: 'image/webp' }),
      width: 100,
      height: 150,
      cached_at: Date.now(),
      ...stamp
    }
  ]);
}

describe('promotion: a cached cover is installed onto a row the user has read, with no fetch', () => {
  it('copies the cached blob and ITS stamp onto the row', async () => {
    await db.volumes.put(row('u1'));
    await cacheCover('One Piece/Volume 01.cbz', { cover_size: 5, cover_modified: 1700000000 });
    const update = vi.spyOn(db.volumes, 'update');
    const outcome = await requestCover(
      row('u1', {
        cloudProvider: 'webdav',
        cloudThumbnailFileId: 'c',
        cloudPath: 'One Piece/Volume 01.cbz',
        cloudThumbnailSize: 5,
        cloudThumbnailModifiedTime: '2023-11-14T22:13:20.000Z'
      })
    );
    await flushPendingCoverPersists();
    expect(outcome).toBe('row');
    expect(fetchCloudThumbnailMock).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({
        thumbnail: expect.any(File),
        thumbnail_width: 100,
        thumbnail_height: 150,
        cover_size: 5,
        cover_modified: 1700000000
      })
    );
    update.mockRestore();
  });

  it('a cached cover with no relationship stays in the cache and is not fetched', async () => {
    await cacheCover('One Piece/Volume 01.cbz');
    expect(await requestCover(indexedPlaceholder('p1', { cloudThumbnailFileId: 'c' }))).toBe(
      'cache'
    );
    expect(fetchCloudThumbnailMock).not.toHaveBeenCalled();
    expect(await db.volumes.count()).toBe(0);
  });

  it('a STALE cached cover is fetched fresh instead of promoted', async () => {
    await db.volumes.put(row('u1'));
    await cacheCover('One Piece/Volume 01.cbz', { cover_size: 5, cover_modified: 1 });
    const outcome = await requestCover(
      row('u1', {
        cloudProvider: 'webdav',
        cloudThumbnailFileId: 'c',
        cloudPath: 'One Piece/Volume 01.cbz',
        cloudThumbnailSize: 9,
        cloudThumbnailModifiedTime: '2026-01-01T00:00:00.000Z'
      })
    );
    expect(outcome).toBe('row');
    expect(fetchCloudThumbnailMock).toHaveBeenCalledTimes(1);
  });

  it('settled as cache while browsed, then promoted the first time it is rendered as read', async () => {
    // browsed: indexed placeholder, no row → cache
    expect(await requestCover(indexedPlaceholder('u1', { cloudThumbnailFileId: 'c' }))).toBe(
      'cache'
    );
    await drainQueues();
    // read elsewhere, row materialized, history arrived → same uuid, same stamp
    await db.volumes.put(row('u1'));
    fetchCloudThumbnailMock.mockClear();
    const outcome = await requestCover(
      row('u1', {
        cloudProvider: 'webdav',
        cloudThumbnailFileId: 'c',
        cloudPath: 'One Piece/Volume 01.cbz'
      })
    );
    expect(outcome).toBe('row');
    expect(fetchCloudThumbnailMock).not.toHaveBeenCalled();
    await waitForCover('u1');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/catalog/cover-service.promote.test.ts`
Expected: FAIL — outcome `'cache'`, no row update.

- [ ] **Step 3: Implement** — replace the cached fast path at the top of `resolveAndDeliver`:

```ts
if (!options.refresh && !vol.thumbnail && vol.cloudPath) {
  const cached = await readCachedCover(vol.cloudPath);
  if (cached === 'error') {
    // fall through: fetching is the safe answer when the cache is unreadable
  } else if (cached) {
    if (!wantsRow(vol)) return 'cache';
    const cachedStamp = { size: cached.cover_size, modified: cached.cover_modified };
    const current = {
      size: vol.cloudThumbnailSize,
      modified: isoToEpochSeconds(vol.cloudThumbnailModifiedTime)
    };
    if (!isSidecarStale(cachedStamp, current)) {
      // PROMOTION: the blob this account already holds, with the freshness
      // it actually has. `installCover` takes the stamp as (bytes, ISO) —
      // hand it the cached epoch back as ISO so the row records the same
      // seconds the cache row did.
      installCover(
        { volume_uuid: vol.volume_uuid, cloudPath: vol.cloudPath },
        { file: cached.thumbnail, width: cached.width, height: cached.height },
        {
          size: cached.cover_size,
          modifiedTime:
            cached.cover_modified !== undefined
              ? new Date(cached.cover_modified * 1000).toISOString()
              : undefined
        },
        'fill'
      );
      return 'row';
    }
    // Stale: fall through to a fetch, which the queue routes onto the row.
  }
}
```

with

```ts
/**
 * The cached cover row for `cloudPath` under the active account — blob
 * included, deliberately: this is the ONE read that wants the bytes, because
 * it is about to copy them onto a `volumes` row. Everything else that asks
 * "is it cached?" stays keys-only. `undefined` = not cached; `'error'` = the
 * cache could not be consulted (treated as a miss by the caller, exactly as
 * `withoutCachedCovers` used to).
 */
async function readCachedCover(cloudPath: string): Promise<CloudCover | undefined | 'error'> {
  try {
    const scope = activeAccountScope();
    if (!scope) return undefined;
    return await db.cloud_covers.get([scope, normalizeCachePath(cloudPath)]);
  } catch (error) {
    console.debug('[cover-service] could not consult the cover cache:', error);
    return 'error';
  }
}
```

Delete `isCachedCoverPath` and the `cachedCoverPaths` import if no longer used. Move the module doc's "RE-DOWNLOAD GUARD" paragraph onto `readCachedCover` and add a PROMOTION paragraph to the module doc (case 2 in the ladder, per the spec).

- [ ] **Step 4: Run**

Run: `npx vitest run src/lib/catalog/`
Expected: PASS. Check the perf contracts especially: CONTRACT 3 asserts no `volumes` rows are written for cache-only covers — placeholders never `wantsRow`, so it holds.

- [ ] **Step 5: Commit**

```bash
git add src/lib/catalog/cover-service.ts src/lib/catalog/cover-service.promote.test.ts
git commit -m "feat(covers): promote a cached cover onto the row a read volume has earned"
```

### Task A4: `installCoversForSeries` becomes a candidate builder

**Files:**

- Modify: `src/lib/catalog/cover-install.ts` (whole `runCoverInstall`, delete `withoutCachedCovers`, `MAX_CONCURRENT_COVER_INSTALLS`)
- Test: `src/lib/catalog/cover-install.test.ts`

**Interfaces:**

- Consumes: `requestCover(vol): Promise<CoverOutcome>` (A2/A3).
- Produces: `installCoversForSeries(seriesTitle): Promise<number>` unchanged signature (count of `'row' | 'cache'` outcomes).

- [ ] **Step 1: Retarget the tests.** Keep every `it` in `cover-install.test.ts` except the `concurrency pinning` describe (delete it and the `MAX_CONCURRENT_COVER_INSTALLS` import). Add, since the pass now goes through the service, a mock so `cover-service` is real but observable:

```ts
const { requestCoverSpy } = vi.hoisted(() => ({ requestCoverSpy: vi.fn() }));
vi.mock('$lib/catalog/cover-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/catalog/cover-service')>();
  return {
    ...actual,
    requestCover: (...a: Parameters<typeof actual.requestCover>) => {
      requestCoverSpy(...a);
      return actual.requestCover(...a);
    }
  };
});
```

Add `_resetCoverServiceForTests()` to `beforeEach` (import from `./cover-service`). Add one new case:

```ts
it('hands every candidate to requestCover, decorated from the LISTING, never storing cloud fields', async () => {
  await addRow();
  await installCoversForSeries('Dr Stone');
  expect(requestCoverSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      volume_uuid: 'uuid-1',
      cloudProvider: 'webdav',
      cloudPath: 'Dr Stone/Volume 1.cbz',
      cloudThumbnailFileId: 'cover-1',
      cloudThumbnailPath: 'Dr Stone/Volume 1.webp',
      cloudThumbnailSize: 1,
      cloudThumbnailModifiedTime: '2026-01-02T00:00:00.000Z'
    })
  );
  const stored = await db.volumes.get('uuid-1');
  expect(stored).not.toHaveProperty('cloudPath');
  expect(stored).not.toHaveProperty('cloudThumbnailFileId');
});

it('promotes a cached cover onto a READ row without fetching', async () => {
  await addRow();
  history.set({ 'uuid-1': { progress: 3 } });
  await db.cloud_covers.put({
    account_scope: 'webdav:a@b.com',
    path: 'Dr Stone/Volume 1.cbz',
    thumbnail: new File(['c'], 'c.webp'),
    width: 10,
    height: 15,
    cached_at: Date.now()
  });
  expect(await installCoversForSeries('Dr Stone')).toBe(1);
  expect(fetchCloudThumbnail).not.toHaveBeenCalled();
  expect((await db.volumes.get('uuid-1'))?.thumbnail_width).toBe(10);
});
```

The existing "never re-downloads a cover this account already has cached" case changes its second expectation: the second pass returns `0` still (the row now HAS the cover or the request is `'skipped'`) — keep as written; if the cached relationship-less row's second request returns `'cache'` again (it is `'skipped'` by the ledger), the count is 0 either way.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/catalog/cover-install.test.ts`
Expected: FAIL on the two new cases (no `requestCover` call; fetch called for the cached row).

- [ ] **Step 3: Implement** — replace `runCoverInstall` (keep `coverKey`, `foldCoverIndex`, `foldArchiveIndex`, `installCoversForSeries`'s dedupe wrapper):

```ts
async function runCoverInstall(seriesTitle: string): Promise<number> {
  const provider = unifiedCloudManager.getActiveProvider();
  if (!provider) return 0;

  const listing = unifiedCloudManager.getAllCloudVolumes();
  const covers = foldCoverIndex(indexCoverSidecarsByBasePath(listing));
  if (covers.size === 0) return 0;
  const archivePaths = foldArchiveIndex(listing);

  const seriesKey = normalizeSeriesKey(seriesTitle);
  const rows = (await db.volumes
    .where('series_title')
    .equalsIgnoreCase(seriesTitle)
    .toArray()) as VolumeMetadata[];

  // The listing's cover and archive for each row, decorated onto a COPY —
  // the same shape the catalog hands a card (`cloudFieldsForRemovedVolume`),
  // so `requestCover` sees exactly what it would see from a render. Nothing
  // here is ever written back to the row.
  const requests: Promise<CoverOutcome>[] = [];
  for (const row of rows) {
    if (normalizeSeriesKey(row.series_title) !== seriesKey) continue;
    if (!needsDownload(row) || row.thumbnail) continue;
    const key = coverKey(row.series_title, row.volume_title);
    const info = covers.get(key);
    if (!info) continue;
    const decorated: VolumeMetadata = {
      ...row,
      cloudProvider: provider.type,
      cloudPath: archivePaths.get(key) ?? row.cloudPath,
      cloudThumbnailFileId: info.fileId,
      cloudThumbnailPath: info.path,
      ...(isArchiveSize(info.size) ? { cloudThumbnailSize: info.size } : {}),
      ...(info.modifiedTime ? { cloudThumbnailModifiedTime: info.modifiedTime } : {})
    };
    requests.push(requestCover(decorated));
  }
  if (requests.length === 0) return 0;

  const outcomes = await Promise.all(requests);
  const installed = outcomes.filter((o) => o === 'row' || o === 'cache').length;
  // Drain what this pass queued before returning (see the doc above): the
  // caller awaits a series open or a backfill, and "installed" should mean
  // the covers have actually landed.
  if (installed > 0) await flushPendingCoverPersists();
  return installed;
}
```

Imports: `requestCover, type CoverOutcome` from `./cover-service`; `isArchiveSize` from `$lib/metadata/series-file`; drop `fetchCloudThumbnail`, `cachedCoverPaths`, `activeAccountScope`, `normalizeCachePath`, `installCover`. Rewrite the module doc: this module decides WHICH rows to ask for and from WHICH listing files; `cover-service.ts` decides everything after that (cache, promotion, fetch, routing). Note the dirty re-scan is unchanged.

Check for an import cycle: `cover-service.ts` imports `series-backfill.ts`, which imports `cover-install.ts`, which now imports `cover-service.ts`. That is a cycle (`cover-service → series-backfill → cover-install → cover-service`). Break it the way `cover-persist.ts` already does for its own case: `cover-install.ts` imports `requestCover` lazily —

```ts
async function requestCoverLazy(vol: VolumeMetadata): Promise<CoverOutcome> {
  const { requestCover } = await import('./cover-service');
  return requestCover(vol);
}
```

— and imports only `type CoverOutcome` statically. Document why in one paragraph (the cycle above; `series-backfill.ts` imports this module for its post-write flesh-out).

- [ ] **Step 4: Run**

Run: `npx vitest run src/lib/catalog/ src/lib/metadata/series-open.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/catalog/cover-install.ts src/lib/catalog/cover-install.test.ts
git commit -m "refactor(covers): the series pass builds candidates and asks the one cover service"
```

### Task A5: the backfill's stale refresh is a `refresh: true` request

**Files:**

- Modify: `src/lib/metadata/series-backfill.ts:410-440` (`refreshStaleCover`), imports at `:4-6`
- Test: `src/lib/metadata/series-backfill.test.ts` (the `fetchCloudThumbnail`/`installCover` mocks and the stale-cover cases at ~902–1100)

- [ ] **Step 1: Retarget the tests.** Replace the `cloud-thumbnails` mock with a `cover-service` mock:

```ts
const requestCover = vi.fn(async (_vol: unknown, _opts?: unknown) => 'row' as const);
vi.mock('$lib/catalog/cover-service', () => ({
  requestCover: (...a: Parameters<typeof requestCover>) => requestCover(...a)
}));
```

Every assertion `expect(fetchCloudThumbnail).toHaveBeenCalledTimes(1)` on a stale-cover case becomes

```ts
expect(requestCover).toHaveBeenCalledTimes(1);
expect(requestCover).toHaveBeenCalledWith(
  expect.objectContaining({
    volume_uuid: '<uuid the case uses>',
    cloudThumbnailFileId: '<cover fileId>',
    cloudThumbnailSize: 900,
    cloudThumbnailModifiedTime: '2026-07-01T00:00:00.000Z',
    cloudPath: '<archive path>'
  }),
  { refresh: true }
);
```

and `expect(fetchCloudThumbnail).not.toHaveBeenCalled()` becomes `expect(requestCover).not.toHaveBeenCalled()`. The "download finished mid-fetch" case (~963–1000) tested the write queue's guard through the old direct call; with the fetch inside the service that guard is the service's and cover-persist's own (covered in their suites) — reduce that case to asserting the request was made and nothing else was written by this module.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/metadata/series-backfill.test.ts`
Expected: FAIL — `requestCover` never called.

- [ ] **Step 3: Implement**

```ts
async function refreshStaleCover(
  providerType: SyncProvider['type'],
  volumeUuid: string,
  cover: CloudFileMetadata,
  archivePath: string | undefined
): Promise<void> {
  const row = (await db.volumes.get(volumeUuid)) as VolumeMetadata | undefined;
  if (!row || !needsDownload(row)) return;

  // The stale sidecar's OWN listing stamp rides as the `cloudThumbnail*`
  // decoration, so the service records exactly the bytes it is about to
  // fetch; `refresh: true` is what tells it not to trust the cache or its
  // ledger for this uuid. Decorated on a copy, never stored.
  await requestCover(
    {
      ...row,
      cloudProvider: providerType,
      cloudPath: archivePath ?? row.cloudPath,
      cloudThumbnailFileId: cover.fileId,
      cloudThumbnailPath: cover.path,
      ...(isArchiveSize(cover.size) ? { cloudThumbnailSize: cover.size } : {}),
      ...(cover.modifiedTime ? { cloudThumbnailModifiedTime: cover.modifiedTime } : {})
    },
    { refresh: true }
  );
  await flushPendingCoverPersists();
}
```

Imports: `requestCover` from `$lib/catalog/cover-service` — BUT `cover-service.ts` imports this module statically (`acquireBackfillSlot`, `pullMokuroEntry`, …), so this is the same cycle as A4: use the lazy `await import('$lib/catalog/cover-service')` inside the function, keep `flushPendingCoverPersists` from `cover-persist`, drop `fetchCloudThumbnail` and `installCover`. Trim the doc comment to what is still true.

- [ ] **Step 4: Run**

Run: `npx vitest run src/lib/metadata/ src/lib/catalog/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/metadata/series-backfill.ts src/lib/metadata/series-backfill.test.ts
git commit -m "refactor(covers): the backfill's stale refresh is a refresh request to the cover service"
```

### Task A6: Part A gate

- [ ] **Step 1:** `npm run check` → 0 errors. `npx vitest run` → all green. `npm run lint` → warnings at the develop baseline (272), 0 errors.
- [ ] **Step 2:** `grep -rn "fetchCloudThumbnail\|installCover(" src --include=*.ts --include=*.svelte | grep -v test | grep -v "catalog/cover-service\|catalog/cover-persist\|catalog/cloud-thumbnails"` → no callers outside the service. Report the output.
- [ ] **Step 3:** Update `CLAUDE.md`'s "Zoom architecture"-style bullet list? No — add ONE line under **Reader Input Handling**'s sibling sections is wrong; instead append to the `## Important Patterns` a short subsection:

```markdown
### Cloud covers

`requestCover(vol)` (`src/lib/catalog/cover-service.ts`) is the only way anything obtains a
cloud cover: surfaces through `createCoverClaims`, the series-open pass through
`installCoversForSeries` (a candidate builder), the backfill's stale refresh with
`{ refresh: true }`. Its ladder: fresh row thumbnail → cached in `cloud_covers` (promoted
onto the row when the volume is metadata-only AND read — `coverBelongsOnRow`) → fetch.
The write queue (`cover-persist.ts`) routes by the same predicate. Never fetch or write a
cover from anywhere else.
```

- [ ] **Step 4: Commit** `docs: cloud cover entry point in CLAUDE.md`.

---

## Part B — Resolution after every progress sync

### Task B1: the manager retains the index refresh and exposes it

**Files:**

- Modify: `src/lib/util/sync/unified-cloud-manager.ts:247-300` (`refreshSeriesIndexesInBackground`), add a field and method
- Test: `src/lib/util/sync/unified-cloud-manager.test.ts` (new describe; the file mocks `cache-manager`, `provider-manager`, `unified-sync-service`; add a mock for `$lib/metadata/series-index-sync` exposing `refreshSeriesIndexes`)

**Interfaces:**

- Produces: `unifiedCloudManager.whenSeriesIndexesSettled(): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
const refreshSeriesIndexes = vi.fn(async () => {});
vi.mock('$lib/metadata/series-index-sync', () => ({
  refreshSeriesIndexes: (...a: unknown[]) => refreshSeriesIndexes(...a)
}));
vi.mock('$lib/metadata/catalog-index-sync', () => ({ refreshCatalogIndex: vi.fn(async () => {}) }));
vi.mock('$lib/metadata/series-file-sync', () => ({
  markListingFresh: vi.fn(),
  reconcileMissingMetadataFiles: vi.fn(async () => {})
}));
vi.mock('$lib/util/sync/sidecar-backfill', () => ({
  sweepInstalledVolumesForSidecarBackfill: vi.fn(async () => {})
}));

describe('whenSeriesIndexesSettled', () => {
  it('resolves immediately when no refresh is running', async () => {
    await expect(unifiedCloudManager.whenSeriesIndexesSettled()).resolves.toBeUndefined();
  });

  it('waits for the refresh the last listing started', async () => {
    let release!: () => void;
    refreshSeriesIndexes.mockReturnValueOnce(new Promise<void>((r) => (release = r)));
    getActiveProvider.mockReturnValue({ type: 'webdav' });
    getAllFiles.mockReturnValue([{ path: 'S/V.cbz', fileId: '1', size: 1, modifiedTime: '' }]);
    unifiedCloudManager.refreshSeriesIndexesInBackground();
    let settled = false;
    const p = unifiedCloudManager.whenSeriesIndexesSettled().then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await p;
    expect(settled).toBe(true);
  });

  it('never rejects, even when the refresh does', async () => {
    refreshSeriesIndexes.mockRejectedValueOnce(new Error('boom'));
    getActiveProvider.mockReturnValue({ type: 'webdav' });
    getAllFiles.mockReturnValue([{ path: 'S/V.cbz', fileId: '1', size: 1, modifiedTime: '' }]);
    unifiedCloudManager.refreshSeriesIndexesInBackground();
    await expect(unifiedCloudManager.whenSeriesIndexesSettled()).resolves.toBeUndefined();
  });
});
```

(Check the existing mocks at the top of that file first: some of these modules may already be mocked — reuse rather than duplicate.)

- [ ] **Step 2: Run** — `npx vitest run src/lib/util/sync/unified-cloud-manager.test.ts` → FAIL, method missing.

- [ ] **Step 3: Implement** — in the class:

```ts
  /**
   * The `series.json` refresh the most recent listing started, or `null`.
   * Retained so a caller that needs the cached indexes to be CURRENT — the
   * post-sync progress resolution — can await the run already in flight
   * instead of starting a second one. Always a settled-without-rejecting
   * promise (the refresh logs its own failures).
   */
  private seriesIndexRefresh: Promise<void> | null = null;

  whenSeriesIndexesSettled(): Promise<void> {
    return this.seriesIndexRefresh ?? Promise.resolve();
  }
```

and in `refreshSeriesIndexesInBackground` replace the first `void Promise.resolve(refreshSeriesIndexes(...))` with:

```ts
const refresh = Promise.resolve(refreshSeriesIndexes(listing, provider.type)).catch((error) =>
  console.warn('Series index refresh failed:', error)
);
this.seriesIndexRefresh = refresh;
void refresh.finally(() => {
  if (this.seriesIndexRefresh === refresh) this.seriesIndexRefresh = null;
});
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(sync): retain the series-index refresh so resolution can await it`.

### Task B2: `resolveSyncedProgress` and the uncapped sweep

**Files:**

- Modify: `src/lib/metadata/hole-patch.ts` (remove `MAX_HOLE_PATCHES_PER_RUN`, `attemptedThisSession`, `resetHolePatchSessionForTests`, `patchProgressHolesWhenListingReady`, the `limit` option; add `resolveSyncedProgress`)
- Modify: `src/lib/metadata/history-rows.ts` (remove `MAX_HISTORY_ROWS_PER_RUN`, `MAX_HISTORY_SERIES_PER_RUN`, the `limit`/`seriesLimit` options and both cap checks)
- Test: `src/lib/metadata/hole-patch.test.ts`, `src/lib/metadata/history-rows.test.ts`

**Interfaces:**

- Produces: `export async function resolveSyncedProgress(): Promise<void>` (never rejects).
- Consumes: `unifiedCloudManager.whenSeriesIndexesSettled()` (B1).

- [ ] **Step 1: Retarget tests.**

`hole-patch.test.ts`: delete `de-duplicates by series and caps the run` (replace with `de-duplicates by series and pulls every dangling series in one run` asserting 7 distinct titles → 7 `openSeries` calls), delete the three session-memo cases (`does not re-attempt…`, `does not count an attempt left off…`, and the memo half of `is a no-op and memoizes nothing…` — keep the listing-gate half), delete the whole `patchProgressHolesWhenListingReady` describe, drop `resetHolePatchSessionForTests` from imports/`beforeEach`. Add to the manager mock `whenSeriesIndexesSettled: () => indexRefresh` where `let indexRefresh: Promise<void> = Promise.resolve();` and add:

```ts
describe('resolveSyncedProgress', () => {
  it('does nothing before the listing is loaded', async () => {
    cacheLoaded = false;
    progress = { v1: { series_title: 'Ghost' } };
    await resolveSyncedProgress();
    expect(materializeHistoryRows).not.toHaveBeenCalled();
    expect(enrichAllOrphanedVolumes).not.toHaveBeenCalled();
  });

  it('waits for the index refresh before sweeping', async () => {
    let release!: () => void;
    indexRefresh = new Promise<void>((r) => (release = r));
    progress = { v1: { series_title: 'Ghost' } };
    const run = resolveSyncedProgress();
    await Promise.resolve();
    expect(materializeHistoryRows).not.toHaveBeenCalled();
    release();
    await run;
    expect(materializeHistoryRows).toHaveBeenCalledTimes(1);
    expect(openSeries).toHaveBeenCalledWith('Ghost');
  });

  it('enriches before AND after the sweep', async () => {
    const order: string[] = [];
    enrichAllOrphanedVolumes.mockImplementation(async () => {
      order.push('enrich');
    });
    materializeHistoryRows.mockImplementation(async () => {
      order.push('sweep');
      return 0;
    });
    await resolveSyncedProgress();
    expect(order).toEqual(['enrich', 'sweep', 'enrich']);
  });

  it('never rejects', async () => {
    materializeHistoryRows.mockRejectedValueOnce(new Error('boom'));
    await expect(resolveSyncedProgress()).resolves.toBeUndefined();
  });
});
```

`history-rows.test.ts`: delete `honours the per-run cap and drains across runs` and `bounds the SERIES a run touches…`; in the large-library describe keep `writes only the volumes with history, in ONE transaction, without reading a row` and add an assertion that ALL seeded history volumes (make it more than 1000 across more than 200 series, e.g. 1200 volumes over 240 series) get a row in ONE run and ONE `readwrite` transaction (the describe already counts transactions with `countIdbOps`). Drop the two constant imports.

- [ ] **Step 2: Run** → FAIL (imports missing / caps still applied).

- [ ] **Step 3: Implement.**

`history-rows.ts`: delete the two constants and their doc blocks; `materializeHistoryRows(options?: { readIndexes?: ... })`; in step 4 remove `if (plannedUuids.size >= limit) break;` and the `plan.size >= seriesLimit` skip. Update the module doc's WORST-CASE WORK paragraph: the set is bounded by the user's reading history, and one run drains it entirely.

`hole-patch.ts`: delete `MAX_HOLE_PATCHES_PER_RUN`, `attemptedThisSession`, `resetHolePatchSessionForTests`, `patchProgressHolesWhenListingReady`; `patchProgressHoles()` takes no options and iterates `wanted` whole; keep the `listingIsLoaded()` re-check per attempt. Add:

```ts
/**
 * THE trigger. Runs once per progress sync, from
 * `unifiedCloudManager.syncProgress()` — never from a view.
 *
 * Waits for the `series.json` refresh the listing started, because that is
 * what phase 1 resolves against: measured 2026-08-31, the same sweep
 * materialized 5 of 30 series against a cold index cache and 30 of 30 against
 * a warm one, and on a network provider the startup sweep always ran cold.
 * With the refresh awaited, phase 1 is in-memory plus one bulk read, and
 * phase 2 only ever downloads an index the listing shows but the refresh
 * failed to cache.
 *
 * Starts no I/O the sync did not already imply: no listing is fetched here
 * (a Drive listing fetch can itself trigger a post-login sync, and a
 * resolution that fetched would close that loop). Without a loaded listing
 * it is a no-op; the next sync catches up. Never rejects.
 */
export async function resolveSyncedProgress(): Promise<void> {
  try {
    if (!listingIsLoaded()) return;
    await unifiedCloudManager.whenSeriesIndexesSettled();
    await patchProgressHolesAndEnrich();
  } catch (error) {
    console.debug('[hole-patch] resolution failed:', error);
  }
}
```

Rewrite the module doc for `patchProgressHoles` (no cap, no memo; why — the spec's B3 paragraph).

- [ ] **Step 4: Run** `npx vitest run src/lib/metadata/hole-patch.test.ts src/lib/metadata/history-rows.test.ts` → PASS.

- [ ] **Step 5: Commit** `feat(metadata): resolveSyncedProgress — await the index refresh, drop the coverage caps`.

### Task B3: wire the trigger; remove the view-mount triggers

**Files:**

- Modify: `src/lib/util/sync/unified-cloud-manager.ts:2017-2035` (`syncProgress`)
- Modify: `src/lib/util/sync/init-providers.ts:3,154-155`
- Modify: `src/lib/views/CatalogView.svelte:1-20`, `src/lib/views/ReadingSpeedView.svelte:19,704-733`
- Test: `src/lib/util/sync/unified-cloud-manager.test.ts`

- [ ] **Step 1: Write the failing test** (same file as B1; mock `$lib/metadata/hole-patch` with a hoisted `resolveSyncedProgress` spy):

```ts
describe('syncProgress starts resolution behind the result', () => {
  it('runs resolveSyncedProgress after a successful sync, without waiting for it', async () => {
    getActiveProvider.mockReturnValue({ type: 'webdav' });
    let release!: () => void;
    resolveSyncedProgress.mockReturnValueOnce(new Promise<void>((r) => (release = r)));
    (unifiedSyncService.syncProvider as Mock).mockResolvedValue({ success: true });
    const result = await unifiedCloudManager.syncProgress({ silent: true });
    expect(result.succeeded).toBe(1);
    expect(resolveSyncedProgress).toHaveBeenCalledTimes(1);
    release();
    await unifiedCloudManager.progressResolution;
  });

  it('does not start resolution after a failed sync', async () => {
    getActiveProvider.mockReturnValue({ type: 'webdav' });
    (unifiedSyncService.syncProvider as Mock).mockResolvedValue({ success: false });
    await unifiedCloudManager.syncProgress();
    expect(resolveSyncedProgress).not.toHaveBeenCalled();
  });
});
```

Because the manager uses a dynamic import, mock the module path with `vi.mock('$lib/metadata/hole-patch', () => ({ resolveSyncedProgress: (...a) => resolveSyncedProgress(...a) }))` — `vi.mock` intercepts dynamic imports too.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** in `syncProgress`, after `const result = await unifiedSyncService.syncProvider(provider, options);`:

```ts
if (result.success) this.startProgressResolution();
```

plus

```ts
  /**
   * The resolution run the last successful sync started (see
   * `resolveSyncedProgress` in `hole-patch.ts`), retained for callers and
   * tests that need the rows it mints. Sync itself never waits on it.
   */
  progressResolution: Promise<void> = Promise.resolve();

  /**
   * DYNAMIC import: `hole-patch.ts` imports this manager, and a static import
   * back would close that into a cycle — the same discipline
   * `cover-resolver.ts` uses for its key watch. A failure to import or run is
   * logged and never reaches a sync result.
   */
  private startProgressResolution(): void {
    this.progressResolution = import('$lib/metadata/hole-patch')
      .then(({ resolveSyncedProgress }) => resolveSyncedProgress())
      .catch((error) => console.debug('[sync] progress resolution failed to start:', error));
  }
```

`init-providers.ts`: delete the import and the `void patchProgressHoles();` lines (the startup `syncProgress` now does it; leave a one-line comment saying so).

`CatalogView.svelte`: delete the import and the `onMount` entirely (nothing else in it).

`ReadingSpeedView.svelte`: replace the hole-patch import with `import { enrichAllOrphanedVolumes } from '$lib/settings';` and the `onMount` body's sweep with `void enrichAllOrphanedVolumes();` plus a comment: this view groups by the reading record's titles; enrichment copies titles off rows this device already has and is the only fix for a legacy record on a device with no provider. Rows for synced progress are minted after each sync (`resolveSyncedProgress`), not from here.

- [ ] **Step 4:** `npm run check` → 0 errors; `npx vitest run` → PASS; grep `patchProgressHolesWhenListingReady\|MAX_HOLE_PATCHES\|MAX_HISTORY_` in `src` → nothing.

- [ ] **Step 5: Commit** `feat(sync): resolve synced progress after every sync, not from view mounts`.

### Task B4: cold-vs-warm harness and the Part B gate

**Files:**

- Test: `src/lib/metadata/hole-patch.integration.test.ts` (new; real Dexie like `history-rows.test.ts`, real `materializeHistoryRows`, mocked `openSeries` and manager with a controllable `whenSeriesIndexesSettled` that seeds the `series_index` table when released)

- [ ] **Step 1:** Write the harness: seed 30 series' progress records (one volume each, `progress: 5`), a listing with all 30 folders, an EMPTY `series_index`. Make `whenSeriesIndexesSettled` return a promise that, before resolving, `put`s all 30 index records (the refresh landing). Call `resolveSyncedProgress()`. Assert `db.volumes.count()` is 30 and `openSeries` was never called (phase 2 had nothing left). Then a second `resolveSyncedProgress()` with `countIdbOps` asserting zero `readwrite` transactions and zero `openSeries` calls.
- [ ] **Step 2:** Run → PASS (it is a characterization test of B1–B3; if it fails, the wiring is wrong — fix, don't relax).
- [ ] **Step 3:** Full gate: `npm run check`, `npx vitest run`, `npm run lint`. Then e2e on a dedicated port: `E2E_PORT=4187 E2E_CHROMIUM=$(ls -d ~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome | head -1) npx playwright test e2e/catalog-distribution.spec.ts` → 18 passed. Record the 12 pre-existing e2e failures elsewhere only if you run the whole suite.
- [ ] **Step 4: Commit** `test(metadata): cold index cache materializes every synced series in one run`.
- [ ] **Step 5:** Update `docs/superpowers/specs/2026-09-02-unified-cover-requests-design.md` status line to "implemented (parts A, B)" and commit.

---

## Part C — The tracker (branch `feat/progress-tracker`)

### Task C1: merge and reconcile

- [ ] **Step 1:** `cd .../feat-progress-tracker && git merge --no-ff feat/unified-cover-requests`. Expected conflicts: `ProgressTrackerView.svelte` does not conflict (only this branch touches it), but `hole-patch.ts`/tests may if the tracker branch touched them — it did not. Resolve any conflict keeping BOTH sides' intent.
- [ ] **Step 2:** `npm run check` → the tracker view now fails: `patchProgressHolesWhenListingReady` no longer exists. Proceed to C2.

### Task C2: the tracker view asks for enrichment only

**Files:**

- Modify: `src/lib/views/ProgressTrackerView.svelte:3,271-292`
- Delete: `docs/superpowers/plans/2026-08-31-metadata-resolution-trigger.md`

- [ ] **Step 1:** Replace the import with `import { enrichAllOrphanedVolumes } from '$lib/settings';` and the `onMount` tail with:

```ts
// Titles for legacy records that have a local row but no name yet; the
// completed-by-series grouping reads them off the reading record. Rows
// for progress synced from other devices are minted after each sync
// (`resolveSyncedProgress`), never from a view.
void enrichAllOrphanedVolumes();
```

- [ ] **Step 2:** `git rm docs/superpowers/plans/2026-08-31-metadata-resolution-trigger.md`; `npm run check` → 0 errors; `npx vitest run src/lib/views src/lib/goals` → PASS.
- [ ] **Step 3: Commit** `fix(goals): the tracker relies on sync-time resolution for its rows`.

### Task C3: `VolumeCard` draws through the shared cover claims

**Files:**

- Modify: `src/lib/components/VolumeCard.svelte` (drop the `thumbnail` prop; add claims; `use:gate`)
- Modify: `src/lib/views/ProgressTrackerView.svelte` (remove the four `thumbnail={...}` props)
- Test: create `src/lib/components/__tests__/VolumeCard.covers.test.ts` (pattern: `PlaceholderThumbnail.test.ts` — mock `$lib/catalog/cover-service` with `requestCover`/`isCoverFetchTarget`, stub `URL.createObjectURL`, `installIntersectionObserverStub`)

- [ ] **Step 1: Write the failing tests**

```ts
describe('VolumeCard covers', () => {
  it('renders the row thumbnail as an object URL', async () => {
    const { container } = render(VolumeCard, {
      props: { ...baseProps, volume: volume('v1', { thumbnail: new File([], 'c.jpg') }) }
    });
    await tick();
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:cover-1');
  });

  it('shows the placeholder box and asks for the cover when the row has none', async () => {
    const { container } = render(VolumeCard, {
      props: {
        ...baseProps,
        volume: volume('v1', {
          metadata_only: true,
          cloudPath: 'S/V.cbz',
          cloudThumbnailFileId: 't'
        })
      }
    });
    await tick();
    expect(container.querySelector('img')).toBeNull();
    expect(requestCover).toHaveBeenCalledWith(
      expect.objectContaining({ volume_uuid: 'v1' }),
      expect.objectContaining({ stillNear: expect.any(Function) })
    );
  });

  it('asks nothing for a volume with no row at all', async () => {
    render(VolumeCard, { props: { ...baseProps, volume: undefined } });
    await tick();
    expect(requestCover).not.toHaveBeenCalled();
  });
});
```

(`baseProps`: `volumeId: 'v1', seriesId: 's', volumeTitle: 'V', progressPercentString: '0%', remainingPages: 1, isHovered: false, onHover: () => {}`.)

- [ ] **Step 2: Run** → FAIL (no `requestCover` call; prop shape).

- [ ] **Step 3: Implement** in `VolumeCard.svelte`: remove `thumbnail` from `Props`; add

```ts
import { createCoverClaims } from '$lib/catalog/cover-claims.svelte';

/**
 * THE SHARED COVER EFFECT (see cover-claims.svelte.ts). Every volume this
 * card lists has reading activity, so a request from here resolves onto the
 * ROW — promoted from `cloud_covers` if the volume was browsed before it was
 * read, fetched otherwise — and the card repaints from `volume.thumbnail`
 * when that write lands. The claim shows the cached cover in the meantime.
 */
const coverClaims = createCoverClaims({
  claims: () => (volume ? [volume] : []),
  targets: () => (volume ? [volume] : [])
});
const { gate } = coverClaims;
```

Key the existing object-URL effect on `volume?.thumbnail` (content key `uuid:size:lastModified`, as now) and set `let displayUrl = $derived(thumbnailUrl ?? coverClaims.cover?.url);`. Put `use:gate` on the `.imagebox` div. Render `<img src={displayUrl}>` when set, else the existing `PlaceholderThumbnail` fallback — but pass it NO `volume` (it would create a second claim set for the same volume; this card owns the claim).

In `ProgressTrackerView.svelte` delete the four `thumbnail={...}` lines.

- [ ] **Step 4:** `npx vitest run src/lib/components/__tests__/VolumeCard.covers.test.ts src/lib/views` → PASS; `npm run check` → 0.

- [ ] **Step 5: Commit** `feat(goals): tracker cards draw through the shared cover claims`.

### Task C4: Part C gate

- [ ] **Step 1:** `npm run check`, `npx vitest run`, `npm run lint`.
- [ ] **Step 2:** `E2E_PORT=4188 E2E_CHROMIUM=... npx playwright test e2e/progress-tracker.spec.ts` → 7 passed (the `--spacing` regression assertion, the not-on-device card, the ghost-records case).
- [ ] **Step 3:** Browser verification of promotion against the local bunko test instance if it is running (`project_bunko_test_env` memory: port 9090, accounts `<role>/password`): connect as `registered`, browse the catalog so a cover caches, seed a reading record for that volume's real uuid via the page context, trigger a sync from the NavBar, open `#/progress-tracker`, and assert in the page context that `db.volumes.get(uuid)` has `thumbnail` and that no network request for the `.webp` was made after the sync (read the network log). Record what was observed; if the instance is not running, say so rather than starting a production-facing one.
- [ ] **Step 4:** Update `CHANGELOG.md` Unreleased on `feat/progress-tracker` if it lists tracker items (terse, ~8 words each): "Cover requests unified; cached covers install onto read volumes" and "Synced progress resolves after each sync, uncapped".
- [ ] **Step 5: Commit** and report.

---

## Self-review notes

- Spec A1–A9 → Tasks A1–A5 (+A6 docs). A8's `stillNear` shape → A2. A9 "cloud_covers row left in place" → nothing deletes it (A3 does not).
- Spec B1 → B3; B2 → B1+B2; B3 caps/memos → B2; B4 → history-rows untouched transaction shape (B2 removes cap checks only); B5 views → B3.
- Spec C → C1–C3.
- Types: `CoverOutcome`, `RequestCoverOptions`, `coverBelongsOnRow(row, history)`, `whenSeriesIndexesSettled()`, `progressResolution`, `resolveSyncedProgress()` used consistently above.
- Cycle hazards named where they exist (A4, A5, B3) with the lazy-import pattern already used in this codebase.
