# Cloud Metadata Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move cloud-volume enrichment out of the `volumes` table into an expiring, account-scoped cache so the local library stays small and cloud browsing stops triggering full-table scan storms.

**Architecture:** A new `cloud_covers` Dexie table keyed by `[account_scope+path]` holds just the thumbnail blob (plus its dimensions) for cloud volumes the user has neither installed nor read, and a `cached_at` stamp that drives its own expiry — nothing else, because `series_index` already caches every other per-volume field (identity, counts, and the cover sidecar's own `cover_size`/`cover_modified` stamps). `volumes` keeps only installed volumes and metadata-only rows that carry reading history. The catalog renders a cloud series by joining three sources: the listing (which files exist), `series_index` (identity/counts), and `cloud_covers` (the blob) — so cover writes never touch `volumes` and never fire its liveQuery. The remaining hot full-table scans are narrowed to indexed per-series queries, and the catalog's liveQuery is coalesced.

**Tech Stack:** SvelteKit 5 (runes), Dexie 4 / IndexedDB, Vitest + @testing-library/svelte.

**Spec:** `docs/superpowers/specs/2026-08-25-cloud-metadata-cache-design.md`

## Global Constraints

- **No migration code.** The feature never shipped; no user database contains `metadata_only` rows. The schema change is purely additive (a new table). Never write upgrade logic that moves, rewrites, or deletes existing rows.
- **Expiry is age-only: 14 days after the cover was cached.** No size quotas, no LRU byte budgets. There is deliberately no access-refresh — see decision 3 in the spec.
- **Cache key is `[account_scope+path]`, the primary key of the `cloud_covers` table.** Cloud UUIDs are unavailable. `account_scope` must never contain a secret (no passwords, no tokens).
- **The cover table stores blobs and nothing else — every other per-volume field comes from `series_index`.** Never duplicate a field that table already holds. A cover is considered stale by comparing `series_index`'s `cover_size`/`cover_modified` for that volume against the current listing, never by anything stored in `cloud_covers` itself.
- **`volumes` holds only:** installed volumes, and metadata-only rows for volumes with reading history.
- **Svelte 5 performance rule (CLAUDE.md):** `$derived` runs per component instance; never put expensive work there.
- **Existing test suite must stay green:** `npm test` (2,385 tests at plan time). Run `npx prettier --write` on touched files before committing (husky enforces prettier + eslint).
- **Commit with explicit pathspecs only.** Never `git add -A` — this worktree is shared with other agents.

---

### Task 1: Account scope identity

A cache entry belongs to one cloud account. Switching from MEGA to WebDAV, or between two MEGA accounts, must not surface the other's covers. `ProviderStatus` carries no account identity today, so we add one.

**Files:**

- Create: `src/lib/catalog/cloud-cache-key.ts`
- Create: `src/lib/catalog/cloud-cache-key.test.ts`
- Modify: `src/lib/util/sync/provider-interface.ts` (add `accountScope?: string` to `ProviderStatus`, near `metadataPermissions` ~line 128)
- Modify: `src/lib/util/sync/providers/mega/mega-provider.ts`, `providers/webdav/webdav-provider.ts`, `providers/google-drive/google-drive-provider.ts`, `providers/onedrive/onedrive-provider.ts`, `providers/filesystem/filesystem-provider.ts` (populate it in `getStatus()`)

**Interfaces:**

- Produces: `cloudCacheKey(scope: string, path: string): [string, string]`, `activeAccountScope(): string | null`, `normalizeCachePath(path: string): string`
- Consumes: `ProviderStatus.accountScope` (new, optional string), `unifiedCloudManager.getActiveProvider()`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/catalog/cloud-cache-key.test.ts
import { describe, it, expect, vi } from 'vitest';

const { getActiveProvider } = vi.hoisted(() => ({ getActiveProvider: vi.fn() }));
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: { getActiveProvider }
}));

import { cloudCacheKey, activeAccountScope, normalizeCachePath } from './cloud-cache-key';

describe('normalizeCachePath', () => {
  it('folds leading slashes and duplicate separators', () => {
    expect(normalizeCachePath('//Dr Stone//Volume 01.cbz')).toBe('Dr Stone/Volume 01.cbz');
    expect(normalizeCachePath('/Dr Stone/Volume 01.cbz')).toBe('Dr Stone/Volume 01.cbz');
  });

  it('NFC-normalizes so a decomposed listing matches a composed one', () => {
    const nfd = 'ポケモン/Volume 01.cbz'.normalize('NFD');
    expect(normalizeCachePath(nfd)).toBe('ポケモン/Volume 01.cbz'.normalize('NFC'));
  });

  it('preserves case — cloud paths are case-sensitive', () => {
    expect(normalizeCachePath('Dr Stone/VOLUME 01.cbz')).toBe('Dr Stone/VOLUME 01.cbz');
  });
});

describe('cloudCacheKey', () => {
  it('is a [scope, path] tuple with the path normalized', () => {
    expect(cloudCacheKey('mega:a@b.com', '//X/Y.cbz')).toEqual(['mega:a@b.com', 'X/Y.cbz']);
  });
});

describe('activeAccountScope', () => {
  it('returns null when no provider is connected', () => {
    getActiveProvider.mockReturnValue(null);
    expect(activeAccountScope()).toBeNull();
  });

  it('returns null when the provider reports no account scope', () => {
    getActiveProvider.mockReturnValue({ getStatus: () => ({ isAuthenticated: true }) });
    expect(activeAccountScope()).toBeNull();
  });

  it('returns the provider-reported scope', () => {
    getActiveProvider.mockReturnValue({
      getStatus: () => ({ isAuthenticated: true, accountScope: 'webdav:https://h/dav|nathan' })
    });
    expect(activeAccountScope()).toBe('webdav:https://h/dav|nathan');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/lib/catalog/cloud-cache-key.test.ts`
Expected: FAIL — `Failed to resolve import "./cloud-cache-key"`.

- [ ] **Step 3: Implement the helper**

```ts
// src/lib/catalog/cloud-cache-key.ts
import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';

/**
 * Cloud paths as a cache key. Folded exactly as far as identity allows and no
 * further: leading/duplicate separators are noise from different providers'
 * listing shapes, and NFD vs NFC is the same filename on a decomposing
 * filesystem — but CASE is meaningful, because cloud storage is case-sensitive
 * and two files can legitimately differ only in case.
 */
export function normalizeCachePath(path: string): string {
  return path
    .normalize('NFC')
    .split('/')
    .filter((segment) => segment.length > 0)
    .join('/');
}

/** The cache's composite primary key: which account, which file. */
export function cloudCacheKey(scope: string, path: string): [string, string] {
  return [scope, normalizeCachePath(path)];
}

/**
 * Which account's cache the app should read and write right now, or null when
 * nothing is connected. Null means "do not touch the cache" — never a fallback
 * scope, which would blend two accounts' covers into one bucket.
 */
export function activeAccountScope(): string | null {
  const provider = unifiedCloudManager.getActiveProvider();
  if (!provider) return null;
  return provider.getStatus().accountScope ?? null;
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `npx vitest run src/lib/catalog/cloud-cache-key.test.ts`

- [ ] **Step 5: Add `accountScope` to `ProviderStatus`**

In `src/lib/util/sync/provider-interface.ts`, inside `interface ProviderStatus`, directly below `metadataPermissions`:

```ts
  /**
   * Stable, non-secret identifier for the connected account, used to scope the
   * cloud metadata cache so switching accounts cannot cross-contaminate it.
   * Shape: `<provider>:<discriminator>`. NEVER include a password or token —
   * this is persisted to IndexedDB. Absent = the provider cannot identify an
   * account, and the cache is skipped entirely for it.
   */
  accountScope?: string;
```

- [ ] **Step 6: Populate it in each provider's `getStatus()`**

Use the account discriminator each provider already holds. Add to the returned object:

- `mega-provider.ts`: `accountScope: this.email ? \`mega:${this.email}\` : undefined`
- `webdav-provider.ts`: `accountScope: this.serverUrl && this.username ? \`webdav:${this.serverUrl}|${this.username}\` : undefined`
- `google-drive-provider.ts`: `accountScope: this.isAuthenticated() ? 'google-drive:default' : undefined`
- `onedrive-provider.ts`: `accountScope: this.account?.homeAccountId ? \`onedrive:${this.account.homeAccountId}\` : undefined`
- `filesystem-provider.ts`: `accountScope: this.directoryHandle?.name ? \`filesystem:${this.directoryHandle.name}\` : undefined`

If a provider's field names differ from the above, use the equivalent field it already stores for that account and keep the `<provider>:<discriminator>` shape. Never read a password/token field.

- [ ] **Step 7: Verify types and suite**

Run: `npm run check && npx vitest run src/lib/catalog src/lib/util/sync`
Expected: 0 errors, all green.

- [ ] **Step 8: Commit**

```bash
npx prettier --write src/lib/catalog/cloud-cache-key.ts src/lib/catalog/cloud-cache-key.test.ts src/lib/util/sync/provider-interface.ts src/lib/util/sync/providers/mega/mega-provider.ts src/lib/util/sync/providers/webdav/webdav-provider.ts src/lib/util/sync/providers/google-drive/google-drive-provider.ts src/lib/util/sync/providers/onedrive/onedrive-provider.ts src/lib/util/sync/providers/filesystem/filesystem-provider.ts
git add src/lib/catalog/cloud-cache-key.ts src/lib/catalog/cloud-cache-key.test.ts src/lib/util/sync/provider-interface.ts src/lib/util/sync/providers/mega/mega-provider.ts src/lib/util/sync/providers/webdav/webdav-provider.ts src/lib/util/sync/providers/google-drive/google-drive-provider.ts src/lib/util/sync/providers/onedrive/onedrive-provider.ts src/lib/util/sync/providers/filesystem/filesystem-provider.ts
git commit -m "feat(catalog): account-scoped cloud cache keys"
```

---

### Task 2: The cover table (collapsed schema v2) and its CRUD

**Files:**

- Modify: `src/lib/catalog/db-v3.ts` (add the `cloud_covers` table field ~line 18; replace the `version(2)`/`version(3)`/`version(4)` blocks at lines 32–59 with one `version(2)` — see Step 3)
- Create: `src/lib/catalog/cloud-covers.ts`
- Create: `src/lib/catalog/cloud-covers.test.ts`

**Interfaces:**

- Consumes: `cloudCacheKey`, `normalizeCachePath`, `activeAccountScope` (Task 1)
- Produces: `interface CloudCover`, `putCloudCovers(covers: CloudCover[]): Promise<void>`, `getCloudCovers(scope: string, paths: string[]): Promise<Map<string, CloudCover>>`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/catalog/cloud-covers.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from './db';
import { putCloudCovers, getCloudCovers, type CloudCover } from './cloud-covers';

function cover(over: Partial<CloudCover> = {}): CloudCover {
  return {
    account_scope: 'mega:a@b.com',
    path: 'Dr Stone/Volume 01.cbz',
    thumbnail: new File([new Uint8Array([1, 2, 3])], 'c.webp', { type: 'image/webp' }),
    width: 250,
    height: 350,
    cached_at: 1756000000000,
    ...over
  };
}

beforeEach(async () => {
  await db.cloud_covers.clear();
});

describe('cloud cover CRUD', () => {
  it('round-trips a cover under its composite key', async () => {
    await putCloudCovers([cover()]);
    const rows = await getCloudCovers('mega:a@b.com', ['Dr Stone/Volume 01.cbz']);
    expect(rows.size).toBe(1);
    expect(rows.get('Dr Stone/Volume 01.cbz')?.width).toBe(250);
  });

  it('keeps two accounts separate even for the identical path', async () => {
    await putCloudCovers([
      cover({ account_scope: 'mega:a@b.com', width: 111 }),
      cover({ account_scope: 'mega:other@b.com', width: 222 })
    ]);
    const a = await getCloudCovers('mega:a@b.com', ['Dr Stone/Volume 01.cbz']);
    const other = await getCloudCovers('mega:other@b.com', ['Dr Stone/Volume 01.cbz']);
    expect(a.get('Dr Stone/Volume 01.cbz')?.width).toBe(111);
    expect(other.get('Dr Stone/Volume 01.cbz')?.width).toBe(222);
  });

  it('normalizes the path on write so a decomposed listing hits the same row', async () => {
    await putCloudCovers([cover({ path: '//Dr Stone//Volume 01.cbz' })]);
    const rows = await getCloudCovers('mega:a@b.com', ['Dr Stone/Volume 01.cbz']);
    expect(rows.size).toBe(1);
  });

  it('reads only the requested paths, keyed by normalized path — never the rest of the table', async () => {
    await putCloudCovers([
      cover({ path: 'Dr Stone/Volume 01.cbz' }),
      cover({ path: 'Naruto/Volume 01.cbz', width: 999 })
    ]);
    const rows = await getCloudCovers('mega:a@b.com', ['Naruto/Volume 01.cbz']);
    expect(Array.from(rows.keys())).toEqual(['Naruto/Volume 01.cbz']);
    expect(rows.get('Naruto/Volume 01.cbz')?.width).toBe(999);
  });

  it('returns an empty map for an empty path list, without touching the db', async () => {
    const rows = await getCloudCovers('mega:a@b.com', []);
    expect(rows.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/lib/catalog/cloud-covers.test.ts`
Expected: FAIL — cannot resolve `./cloud-covers`.

- [ ] **Step 3: Add the table to the schema**

In `src/lib/catalog/db-v3.ts`, add the field beside the others (~line 18):

```ts
  cloud_covers!: Table<CloudCover>;
```

Import the type at the top: `import type { CloudCover } from './cloud-covers';`

Then **replace the whole `version(2)`/`version(3)`/`version(4)` sequence with a single `version(2)`**. Verified 2026-08-25: only `version(1)` has ever shipped — `main` and `develop` both declare it alone, and the commits that added `series_metadata` (a3d41deb), `series_index`, and `catalog_index` (11a1f8de) are contained in `feat/series-metadata` and no other branch. Those three versions are development history of an unreleased branch, so preserving them as separate upgrade steps would encode a migration path no database has ever taken. There are no `.upgrade()` callbacks and no code reads `db.verno`, so collapsing is a pure simplification.

The constructor becomes exactly this:

```ts
// v1: the shipped schema — three tables, thumbnails inlined in volumes.
// This is the only version any released build has written, so it must stay
// exactly as-is for every existing user database to upgrade from.
this.version(1).stores({
  volumes: 'volume_uuid, series_uuid, series_title',
  volume_ocr: 'volume_uuid',
  volume_files: 'volume_uuid'
});

// v2: everything the series-metadata work adds, in one step.
//
// Collapsed deliberately: `series_metadata`, `series_index` and
// `catalog_index` were separate versions during development but never
// shipped, so no database exists at those intermediate versions and the
// steps between them are fiction. A released client upgrades 1 -> 2 once
// and gets all four new tables.
//
// `cloud_covers` holds ONLY the thumbnail blob (+ dimensions) for a cloud
// volume the user has neither installed nor read, keyed by account + path
// because providers expose no uuid for a file the client has not opened, and
// the same path under a different account is a different file. Everything
// else a cloud card needs — title, counts, the cover sidecar's own
// size/modified stamps — already lives in the cached `series_index` row for
// that series, so this table carries no other field and needs no secondary
// index: a read is always "these exact paths for this account."
this.version(2).stores({
  volumes: 'volume_uuid, series_uuid, series_title',
  volume_ocr: 'volume_uuid',
  volume_files: 'volume_uuid',
  series_metadata: 'series_key',
  series_index: 'series_key',
  catalog_index: 'series_key',
  cloud_covers: '[account_scope+path], cached_at'
});
```

**Consequence for anyone running this branch:** a local database currently at version 3 or 4 is _newer_ than the declared version 2, so Dexie will refuse to open it with a `VersionError`. That is expected and affects only developer machines — clearing site data for the origin (Task 9, Step 1) resolves it, and no released database is at those versions.

- [ ] **Step 4: Implement the CRUD module**

```ts
// src/lib/catalog/cloud-covers.ts
import { db } from './db';
import { normalizeCachePath } from './cloud-cache-key';

/**
 * One cloud volume's thumbnail, cached because the user browsed past it.
 *
 * Deliberately narrow: everything else a cloud card needs — title, counts,
 * archive size, the cover sidecar's own size/modified stamps — already lives
 * in the cached `series_index` row for that series. Duplicating those fields
 * here would just be a second invalidation path to get wrong. This table
 * exists only for the one thing nothing else holds: the blob.
 *
 * NOT a `volumes` row: nothing here is a relationship with the volume, it is
 * catalog knowledge that may be discarded at any time (see
 * `pruneExpiredCloudCovers`). A volume the user installs or reads graduates
 * to a real `volumes` row and its cover entry becomes redundant.
 *
 * PK is `[account_scope+path]` because providers do not expose volume uuids
 * for files the client has not opened, and the same path under a different
 * account is a different file.
 */
export interface CloudCover {
  account_scope: string;
  /** Library-relative path, normalized by `normalizeCachePath`. */
  path: string;
  thumbnail: File;
  width: number;
  height: number;
  /**
   * Epoch ms. Drives expiry only — see `pruneExpiredCloudCovers`. Staleness
   * of the cover ITSELF is decided elsewhere, by comparing `series_index`'s
   * `cover_size`/`cover_modified` for this volume against the current
   * listing; nothing stored on this row participates in that comparison.
   */
  cached_at: number;
}

/** Write covers, normalizing paths so every caller lands on the same key. */
export async function putCloudCovers(covers: CloudCover[]): Promise<void> {
  if (covers.length === 0) return;
  await db.cloud_covers.bulkPut(covers.map((c) => ({ ...c, path: normalizeCachePath(c.path) })));
}

/**
 * The requested paths' cached covers for one account, via the primary key —
 * an indexed point read per path, never a table scan. Callers already know
 * which paths are on screen (from the listing joined with `series_index`), so
 * this never needs to discover paths itself, and an empty request short-
 * circuits before touching the db.
 */
export async function getCloudCovers(
  scope: string,
  paths: string[]
): Promise<Map<string, CloudCover>> {
  if (paths.length === 0) return new Map();
  const keys = paths.map((p) => [scope, normalizeCachePath(p)] as [string, string]);
  const rows = await db.cloud_covers.where('[account_scope+path]').anyOf(keys).toArray();
  return new Map(rows.map((r) => [r.path, r]));
}

// NOTE (final review, 2026-08-25): an earlier draft of this plan also specified a
// `touchCloudCovers` here, to refresh `cached_at` on read. It is deliberately NOT
// implemented. Any read path that wrote to `cloud_covers` would re-fire
// `cloudCoverMap`'s liveQuery, which would touch again — an unbounded feedback
// loop (verified empirically). Expiry therefore measures from when a cover was
// CACHED, not from last access. Do not add it back.
```

- [ ] **Step 5: Run the test — expect PASS**

Run: `npx vitest run src/lib/catalog/cloud-covers.test.ts`

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/lib/catalog/cloud-covers.ts src/lib/catalog/cloud-covers.test.ts src/lib/catalog/db-v3.ts
git add src/lib/catalog/cloud-covers.ts src/lib/catalog/cloud-covers.test.ts src/lib/catalog/db-v3.ts
git commit -m "feat(catalog): cloud_covers table; collapse unshipped schema versions"
```

---

### Task 3: Age-based expiry (14 days)

**Files:**

- Modify: `src/lib/catalog/cloud-covers.ts` (add prune + constant)
- Modify: `src/lib/catalog/cloud-covers.test.ts` (add the expiry describe block)
- Modify: `src/routes/+layout.svelte` (call the prune once on app start, beside the existing startup work)

**Interfaces:**

- Produces: `CLOUD_COVER_MAX_AGE_MS` (14 days), `pruneExpiredCloudCovers(nowMs?: number): Promise<number>`

- [ ] **Step 1: Write the failing test**

```ts
// append to src/lib/catalog/cloud-covers.test.ts
import { pruneExpiredCloudCovers, CLOUD_COVER_MAX_AGE_MS } from './cloud-covers';

describe('cloud cover expiry', () => {
  const NOW = 1_800_000_000_000;

  it('is 14 days', () => {
    expect(CLOUD_COVER_MAX_AGE_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });

  it('deletes covers untouched for longer than the max age', async () => {
    await putCloudCovers([
      cover({ path: 'Old/Volume 01.cbz', cached_at: NOW - CLOUD_COVER_MAX_AGE_MS - 1 }),
      cover({ path: 'Fresh/Volume 01.cbz', cached_at: NOW - 1000 })
    ]);

    const deleted = await pruneExpiredCloudCovers(NOW);

    expect(deleted).toBe(1);
    expect((await getCloudCovers('mega:a@b.com', ['Old/Volume 01.cbz'])).size).toBe(0);
    expect((await getCloudCovers('mega:a@b.com', ['Fresh/Volume 01.cbz'])).size).toBe(1);
  });

  it('keeps a cover exactly at the boundary', async () => {
    await putCloudCovers([cover({ cached_at: NOW - CLOUD_COVER_MAX_AGE_MS })]);
    expect(await pruneExpiredCloudCovers(NOW)).toBe(0);
  });

  it('prunes across every account, not just the connected one', async () => {
    const stale = NOW - CLOUD_COVER_MAX_AGE_MS - 1;
    await putCloudCovers([
      cover({ account_scope: 'mega:a@b.com', cached_at: stale }),
      cover({ account_scope: 'webdav:h|nathan', cached_at: stale })
    ]);
    expect(await pruneExpiredCloudCovers(NOW)).toBe(2);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/lib/catalog/cloud-covers.test.ts`
Expected: FAIL — `pruneExpiredCloudCovers is not a function`.

- [ ] **Step 3: Implement**

```ts
// append to src/lib/catalog/cloud-covers.ts

/** Covers untouched for this long are discarded. Age only — no size quota. */
export const CLOUD_COVER_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Drop covers nobody has looked at in `CLOUD_COVER_MAX_AGE_MS`. Returns how
 * many were deleted.
 *
 * Deletes through the `cached_at` index rather than scanning: this table
 * carries blobs, and a full scan here would reintroduce exactly the cost this
 * split exists to remove. Account-agnostic on purpose — an account the user
 * stopped using should age out, not linger because it is disconnected.
 */
export async function pruneExpiredCloudCovers(nowMs: number = Date.now()): Promise<number> {
  const cutoff = nowMs - CLOUD_COVER_MAX_AGE_MS;
  return db.cloud_covers.where('cached_at').below(cutoff).delete();
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `npx vitest run src/lib/catalog/cloud-covers.test.ts`

- [ ] **Step 5: Sweep once on app start**

In `src/routes/+layout.svelte`, inside the existing `onMount` beside the other startup calls, add a fire-and-forget sweep. It must never block boot and never surface UI:

```ts
void import('$lib/catalog/cloud-covers')
  .then((m) => m.pruneExpiredCloudCovers())
  .catch((error) => console.debug('[cloud-covers] prune skipped:', error));
```

- [ ] **Step 6: Verify and commit**

```bash
npm run check && npx vitest run src/lib/catalog
npx prettier --write src/lib/catalog/cloud-covers.ts src/lib/catalog/cloud-covers.test.ts src/routes/+layout.svelte
git add src/lib/catalog/cloud-covers.ts src/lib/catalog/cloud-covers.test.ts src/routes/+layout.svelte
git commit -m "feat(catalog): expire cloud covers after 14 days"
```

---

### Task 4: Route cover installs to the cover table instead of `volumes`

Today `installCover` writes a `volumes` row for every cover, which is what fires the liveQuery storm. After this task, a cover for a cloud volume with no local row lands in `cloud_covers`; a cover for an installed or history-carrying volume keeps its current path.

**Files:**

- Modify: `src/lib/catalog/cover-persist.ts` (`installCover` ~line 142, `flushPendingCoverPersists` ~line 164)
- Modify: `src/lib/catalog/cover-persist.test.ts`

**Interfaces:**

- Consumes: `putCloudCovers`, `CloudCover` (Task 2), `activeAccountScope` (Task 1)
- Produces: unchanged public surface — `installCover` and `flushPendingCoverPersists` keep their current names and signatures.

- [ ] **Step 1: Write the failing test**

```ts
// append to src/lib/catalog/cover-persist.test.ts
import { getCloudCovers } from './cloud-covers';

describe('cover installs route by relationship', () => {
  it('writes a cloud volume’s cover to cloud_covers, never to volumes', async () => {
    const before = await db.volumes.count();
    installCover(
      {
        volume_uuid: 'cloud-1',
        series_title: 'Dr Stone',
        volume_title: 'Volume 01',
        isPlaceholder: true,
        cloudPath: 'Dr Stone/Volume 01.cbz'
      } as never,
      {
        file: new File([new Uint8Array([1])], 'c.webp', { type: 'image/webp' }),
        width: 250,
        height: 350
      }
    );
    await flushPendingCoverPersists();

    expect(await db.volumes.count()).toBe(before);
    const cached = await getCloudCovers('mega:a@b.com', ['Dr Stone/Volume 01.cbz']);
    expect(cached.get('Dr Stone/Volume 01.cbz')?.width).toBe(250);
    expect(cached.get('Dr Stone/Volume 01.cbz')?.thumbnail).toBeInstanceOf(File);
  });

  it('still writes onto a metadata-only row that has reading history', async () => {
    await db.volumes.put({
      volume_uuid: 'read-1',
      series_uuid: 's',
      series_title: 'Dr Stone',
      volume_title: 'Volume 02',
      mokuro_version: '0.4.11',
      page_count: 180,
      character_count: 1,
      page_char_counts: [],
      metadata_only: true
    } as never);

    installCover(
      {
        volume_uuid: 'read-1',
        series_title: 'Dr Stone',
        volume_title: 'Volume 02',
        metadata_only: true
      } as never,
      {
        file: new File([new Uint8Array([2])], 'c.webp', { type: 'image/webp' }),
        width: 250,
        height: 350
      }
    );
    await flushPendingCoverPersists();

    const row = await db.volumes.get('read-1');
    expect(row?.thumbnail).toBeInstanceOf(File);
  });
});
```

Add to the file's existing mock of `$lib/util/sync/unified-cloud-manager` an active provider reporting `accountScope: 'mega:a@b.com'`, so `activeAccountScope()` resolves in tests.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/lib/catalog/cover-persist.test.ts`
Expected: FAIL — the cloud cover is written to `volumes`, so `db.volumes.count()` grew and `cloud_covers` is empty.

- [ ] **Step 3: Implement the routing**

In `flushPendingCoverPersists`, split the drained queue by destination before writing. Inside the existing `db.transaction('rw', db.volumes, …)`, keep only the entries whose row exists; collect the rest for the cover table:

```ts
const forCoverTable: CloudCover[] = [];
const scope = activeAccountScope();

await db.transaction('rw', db.volumes, async () => {
  for (const [volumeUuid, pending] of drained) {
    const fresh = await db.volumes.get(volumeUuid);
    // A row exists only for volumes this device owns or has read; that is the
    // one case a cover belongs on the row itself.
    if (fresh) {
      if (!needsDownload(fresh) || fresh.thumbnail) continue;
      await db.volumes.update(volumeUuid, pending.patch);
      continue;
    }
    // No row: catalog knowledge. It belongs in cloud_covers, and only when we
    // can attribute it to an account — an unscoped write would blend accounts.
    if (scope && pending.cachePath) {
      forCoverTable.push({
        account_scope: scope,
        path: pending.cachePath,
        thumbnail: pending.thumbnail,
        width: pending.width,
        height: pending.height,
        cached_at: Date.now()
      });
    }
  }
});

await putCloudCovers(forCoverTable);
```

`installCover` must capture the cover fields at schedule time, while the fetched blob is still in hand — never re-read them at flush time, which would break the decision-time snapshot rule the stamps already follow. Because `CloudCover` is now just the blob, dimensions and path, this capture is a straight passthrough of what the cover fetch already returned. Extend the queued `pending` object:

```ts
const cachePath = (volume as VolumeMetadata & { cloudPath?: string }).cloudPath;
pending.set(volume.volume_uuid, {
  patch, // unchanged: what a volumes row would receive
  cachePath,
  thumbnail: result.file,
  width: result.width,
  height: result.height
});
```

A volume with no `cloudPath` has no cover-table identity, so it is queued for the row path only; if it has no row either, the flush drops it (nothing to attribute it to).

- [ ] **Step 4: Run the test — expect PASS**

Run: `npx vitest run src/lib/catalog/cover-persist.test.ts`

- [ ] **Step 5: Full suite and commit**

```bash
npx vitest run
npx prettier --write src/lib/catalog/cover-persist.ts src/lib/catalog/cover-persist.test.ts
git add src/lib/catalog/cover-persist.ts src/lib/catalog/cover-persist.test.ts
git commit -m "feat(catalog): cloud covers persist to cloud_covers, not the volumes table"
```

---

### Task 5: Stop materializing rows for browsed cloud volumes

**Files:**

- Modify: `src/lib/catalog/cover-service.ts` (the decision tree ~line 300-340 — the branch that materializes an index-adopted placeholder)
- Modify: `src/lib/catalog/cover-service.test.ts`

**Interfaces:**

- Consumes: `putCloudCovers` (Task 2, via Task 4's `installCover` routing)
- Produces: no new exports; `requestCover` behaviour changes for volumes with no local row.

- [ ] **Step 1: Write the failing test**

```ts
// append to src/lib/catalog/cover-service.test.ts
import { getCloudCovers } from './cloud-covers';

describe('browsing does not mint volumes rows', () => {
  it('an indexed placeholder is cached, not materialized', async () => {
    const before = await db.volumes.count();
    requestCover(indexedPlaceholder({ volume_uuid: 'idx-1', cloudPath: 'Dr Stone/Volume 03.cbz' }));
    await settleCoverService();

    expect(await db.volumes.count()).toBe(before);
    const cached = await getCloudCovers('mega:a@b.com', ['Dr Stone/Volume 03.cbz']);
    expect(cached.has('Dr Stone/Volume 03.cbz')).toBe(true);
  });

  it('a volume with reading history still gets its row', async () => {
    // history rows are created by the download/read path, not by browsing:
    // requesting a cover for one must fill the row, not the cover table.
    await db.volumes.put(metadataOnlyRow({ volume_uuid: 'hist-1' }) as never);
    requestCover({
      volume_uuid: 'hist-1',
      series_title: 'Dr Stone',
      volume_title: 'Volume 04',
      metadata_only: true
    } as never);
    await settleCoverService();

    expect((await db.volumes.get('hist-1'))?.thumbnail).toBeInstanceOf(File);
  });
});
```

Reuse the file's existing `indexedPlaceholder`/`metadataOnlyRow`/`settleCoverService` helpers; if a helper does not exist under that name, use the file's equivalent and keep the assertions.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/lib/catalog/cover-service.test.ts`
Expected: FAIL — `db.volumes.count()` grew by one.

- [ ] **Step 3: Remove the materialize-on-render branch**

In `cover-service.ts`, the decision-tree branch that calls `materializeSeriesVolumes` for an index-adopted placeholder is deleted. The cover result flows to `installCover` exactly as before; Task 4's routing decides where it lands. Keep the bare-placeholder branch that pulls a `.mokuro` to build a full row's worth of fields — that data still feeds `pending.patch` for the case a volume graduates to an installed/history row, but it no longer needs to populate a cover-table entry: Task 4's `installCover` now captures the cover's `cachePath` plus the fetched blob and dimensions directly, and nothing else lands in `cloud_covers`.

Delete the now-unused `materializeSeriesVolumes` import if nothing else in the file uses it.

- [ ] **Step 4: Run the test — expect PASS**

Run: `npx vitest run src/lib/catalog/cover-service.test.ts`

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/lib/catalog/cover-service.ts src/lib/catalog/cover-service.test.ts
git add src/lib/catalog/cover-service.ts src/lib/catalog/cover-service.test.ts
git commit -m "feat(catalog): browsing caches cloud covers instead of minting rows"
```

---

### Task 6: Render cloud series by joining the listing, `series_index` and `cloud_covers`

The catalog already joins `series_index` into placeholder generation for identity and counts — `generatePlaceholders` takes an `indexMap` parameter (the cached `series.json` per series), wired through `volumesWithPlaceholders` in `index.ts` as its third `derived` input, with a content-based `seriesIndexSignature` so a liveQuery re-emission that changed nothing does not trigger a recompute. What a placeholder still cannot show is a cover blob — today that only exists once a cover-fetch path (Task 4/5) installs it, and until now the only place to install it was a `volumes` row. This task adds `cloud_covers` as the fourth input, so an already-cached cover blob shows up on a placeholder the moment it exists, keyed by the placeholder's cloud path, with no `volumes` row involved.

**Files:**

- Modify: `src/lib/catalog/placeholders.ts` (`generatePlaceholders` ~line 267 — accept a cover map and set `thumbnail`/`thumbnail_width`/`thumbnail_height` on a placeholder when its `cloudPath` has a cached cover)
- Modify: `src/lib/catalog/placeholders.test.ts` (the enrichment tests — a placeholder actually carrying the cached blob)
- Modify: `src/lib/catalog/index.ts` (`volumesWithPlaceholders` ~line 124 — add `cloudCoverMap` as a fourth `derived` input, alongside `volumes`, `unifiedCloudManager.cloudFiles`, `seriesIndexMap`, with its own content signature)
- Create: `src/lib/catalog/cloud-covers-store.ts` (a live view over `cloud_covers`, scoped to exactly the paths the current listing names, exposing `Map<path, CloudCover>`)
- Modify: `src/lib/catalog/catalog-store.test.ts` (the call-through and recompute-coalescing tests — `generatePlaceholders` is mocked in this file, so it cannot assert enrichment content)

**Interfaces:**

- Consumes: `getCloudCovers`, `CloudCover`, `activeAccountScope` (Task 2/1); `unifiedCloudManager.cloudFiles` (existing)
- Produces: `cloudCoverMap: Readable<Map<string, CloudCover>>` (key = normalized path)

- [ ] **Step 1: Write the failing tests**

First, the enrichment logic itself — `generatePlaceholders` already runs for real in this file (only `$app/environment` and `cloud-ocr-upgrade` are mocked):

```ts
// append to src/lib/catalog/placeholders.test.ts
describe('generatePlaceholders with a cover map', () => {
  const cloudFiles = new Map<string, CloudVolumeWithProvider[]>([
    ['One Piece', [cloudFile('One Piece/Volume 1.cbz')]]
  ]);

  it('attaches a cached cover by cloud path, without needing an index entry', () => {
    const covers = new Map([
      [
        'One Piece/Volume 1.cbz',
        {
          account_scope: 'mega:a@b.com',
          path: 'One Piece/Volume 1.cbz',
          thumbnail: new File([new Uint8Array([1])], 'c.webp'),
          width: 250,
          height: 350,
          cached_at: 1000
        }
      ]
    ]);

    const placeholders = generatePlaceholders(cloudFiles, [], undefined, covers);

    expect(placeholders[0].thumbnail).toBeInstanceOf(File);
    expect(placeholders[0].thumbnail_width).toBe(250);
    expect(placeholders[0].thumbnail_height).toBe(350);
  });

  it('leaves a placeholder bare when its path has no cached cover', () => {
    const placeholders = generatePlaceholders(cloudFiles, [], undefined, new Map());
    expect(placeholders[0].thumbnail).toBeUndefined();
  });
});
```

Second, that `volumesWithPlaceholders` actually threads the cover map through and coalesces its own recompute the same way it already does for `seriesIndexMap` — `generatePlaceholders` is mocked in this file, so this is a call-through/recompute test, not an enrichment test:

```ts
// append to src/lib/catalog/catalog-store.test.ts, inside describe('volumesWithPlaceholders', ...)
it('passes the cover map to generatePlaceholders and recomputes only when its content changes', () => {
  const generate = vi.mocked(generatePlaceholders);
  generate.mockClear();
  cloudFiles.set(cloudListing);
  seriesIndexMap.set(new Map([['one piece', indexRecord('2026-08-17T00:00:00.000Z')]]));

  const coverAt = (lastAccessed: number, blobLength = 3) => ({
    account_scope: 'webdav:h|nathan',
    path: 'One Piece/Volume 2.cbz',
    thumbnail: new File([new Uint8Array(blobLength)], 'c.webp'),
    width: 250,
    height: 350,
    cached_at: lastAccessed
  });
  cloudCoverMap.set(new Map([['One Piece/Volume 2.cbz', coverAt(1000)]]));

  const unsubscribe = volumesWithPlaceholders.subscribe(() => {});
  expect(generate).toHaveBeenCalledTimes(1);
  expect(generate).toHaveBeenLastCalledWith(
    cloudListing,
    expect.any(Array),
    expect.any(Map) as unknown as Map<string, unknown>,
    expect.any(Map) as unknown as Map<string, unknown>
  );

  // A touch bumps cached_at and re-emits a fresh Map, but the cached blob
  // — and therefore what a placeholder would show — hasn't changed.
  cloudCoverMap.set(new Map([['One Piece/Volume 2.cbz', coverAt(2000)]]));
  expect(generate).toHaveBeenCalledTimes(1);

  // A genuinely different blob does recompute.
  cloudCoverMap.set(new Map([['One Piece/Volume 2.cbz', coverAt(2000, 4)]]));
  expect(generate).toHaveBeenCalledTimes(2);

  unsubscribe();
  cloudFiles.set(new Map());
  cloudCoverMap.set(new Map());
});
```

Add a `cloudCoverMap` hoisted store to the file's `vi.hoisted` block alongside `cloudFiles`/`seriesIndexMap`, and `vi.mock('$lib/catalog/cloud-covers-store', () => ({ cloudCoverMap }));`.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/lib/catalog/placeholders.test.ts src/lib/catalog/catalog-store.test.ts`
Expected: FAIL — `generatePlaceholders` takes at most 3 params today, and `cloud-covers-store` does not exist.

- [ ] **Step 3: Add the cover store**

```ts
// src/lib/catalog/cloud-covers-store.ts
import { liveQuery } from 'dexie';
import { readable, type Readable } from 'svelte/store';
import { db } from './db';
import { activeAccountScope, normalizeCachePath } from './cloud-cache-key';
import { getCloudCovers, type CloudCover } from './cloud-covers';
import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';

/**
 * The active account's cached covers for exactly the paths currently listed.
 *
 * `cloud_covers` can hold thousands of blobs across a large catalog, so this
 * never reads the whole table for one account — only the on-screen path set,
 * rebuilt from the cloud listing each time it changes. Still backed by a
 * Dexie `liveQuery` per path set, so a cover finishing its download (Task 4's
 * write) is picked up without a manual refresh.
 */
export const cloudCoverMap: Readable<Map<string, CloudCover>> = readable(
  new Map<string, CloudCover>(),
  (set) => {
    let inner: { unsubscribe: () => void } | null = null;

    const outer = unifiedCloudManager.cloudFiles.subscribe((listing) => {
      inner?.unsubscribe();
      inner = null;

      const scope = activeAccountScope();
      const paths = Array.from(listing.values()).flatMap((files) =>
        files.map((f) => normalizeCachePath(f.path))
      );
      if (!scope || paths.length === 0) {
        set(new Map());
        return;
      }

      inner = liveQuery(() => getCloudCovers(scope, paths)).subscribe({
        next: (covers) => set(covers),
        error: (err) => console.debug('[cloud-covers] live query failed:', err)
      });
    });

    return () => {
      inner?.unsubscribe();
      outer();
    };
  }
);
```

`db` and `liveQuery` are unused imports if your editor complains — `db` is threaded through `getCloudCovers`, kept here only if a future direct query needs it; drop it if lint flags it as unused.

- [ ] **Step 4: Join it in `generatePlaceholders`**

Give `generatePlaceholders` a fourth, optional parameter `coverMap?: Map<string, CloudCover>`. Where it currently reads `thumbnailMap.get(basePath)` to decorate a placeholder with `cloudThumbnailFileId`/`cloudThumbnailPath`/etc (the pointer to where a cover CAN be fetched from), also look up `coverMap?.get(normalizeCachePath(cloudFile.path))` and, when present, set `placeholder.thumbnail`, `placeholder.thumbnail_width`, `placeholder.thumbnail_height` from it — the blob ALREADY fetched, as opposed to the sidecar pointer to one that might not be. The two are independent: a placeholder can carry a fetch pointer with no cached blob yet (first render), or — after Task 4 — a cached blob for a path whose sidecar pointer already resolved once.

In `catalog/index.ts`, add `cloudCoverMap` as the fourth member of the `derived([...])` input array. Because it is liveQuery-backed like `seriesIndexMap`, it re-emits a brand-new `Map` of brand-new row objects on every write to `cloud_covers`. Give it the same treatment `seriesIndexSignature` already gives `seriesIndexMap`: a content signature (path + blob byte length is enough — a cover overwrite is the only case that should force a recompute, and a same-length coincidental overwrite recomputing anyway is a harmless false positive) compared against the previous signature, alongside the existing `volumes`/`cloudFiles` reference checks and `indexSignature` check, before calling `generatePlaceholders` again.

- [ ] **Step 5: Run the tests — expect PASS**

Run: `npx vitest run src/lib/catalog/placeholders.test.ts src/lib/catalog/catalog-store.test.ts`

- [ ] **Step 6: Full suite and commit**

```bash
npx vitest run && npm run check
npx prettier --write src/lib/catalog/cloud-covers-store.ts src/lib/catalog/placeholders.ts src/lib/catalog/placeholders.test.ts src/lib/catalog/index.ts src/lib/catalog/catalog-store.test.ts
git add src/lib/catalog/cloud-covers-store.ts src/lib/catalog/placeholders.ts src/lib/catalog/placeholders.test.ts src/lib/catalog/index.ts src/lib/catalog/catalog-store.test.ts
git commit -m "feat(catalog): render cloud covers from cloud_covers, keyed by path"
```

---

### Task 7: Narrow the hot full-table scans

Four call sites answer per-series questions with a whole-table scan, and they are the ones that fire repeatedly during convergence. `volumes` already indexes `series_title`, so each becomes an indexed range read.

The other eleven `db.volumes.toArray()` sites (`series-merge.ts`, `series-rename.ts`, `volume-editor.ts`, `volume-sidecars.ts`, `UploadView.svelte`, `hole-patch.ts`, `progress-tracker.ts`, `volume-data.ts`) are deliberately left alone: each runs once per explicit user action (a rename, an import, a sync) rather than per write, and after Task 5 they scan a table of hundreds rather than tens of thousands. Narrowing them would add risk for no measurable gain.

`unified-cloud-manager.ts:1311` is also left alone, but not for that reason — **correction from the final whole-plan review's Finding 4**: this one is not "per explicit user action". `writeSeriesFile` is called from `series-file-sync.ts`'s debounced `performWrite`, scheduled once per series by `cover-service.ts` and `series-open.ts`, so a reconcile/convergence pass over the whole catalog runs it once per series (~1,032 full scans at the measured library scale), 2-wide via `write-slot.ts`. It is still left alone because, after Task 5, the table it scans is ~10x smaller than before and it never fires the `volumes` liveQuery — it is a candidate for `volumesForFoldedSeriesTitle` in a future pass, not a regression this plan introduced.

**Files:**

- Modify: `src/lib/metadata/series-file-sync.ts:151` (`hasBackedUpVolume`), `:540` (`locallyKnownSeriesKeys`)
- Modify: `src/lib/metadata/series-backfill.ts:455`
- Modify: `src/lib/catalog/stranded-rows.ts:35`
- Modify: `src/lib/metadata/series-file-sync.test.ts`, `src/lib/catalog/stranded-rows.test.ts`

**Interfaces:**

- Produces: no new exports; behaviour identical, cost per call drops from O(table) to O(series).

- [ ] **Step 1: Write the failing test**

```ts
// append to src/lib/metadata/series-file-sync.test.ts
it('asks about one series without scanning the whole table', async () => {
  const scans = { toArray: 0 };
  // The db mock in this file exposes volumes.toArray; count its calls.
  volumesToArraySpy.mockImplementation(async () => {
    scans.toArray++;
    return [...volumeRows];
  });

  backUp('One Piece', 'Volume 1');
  addVolume('One Piece', 'Volume 1');
  scheduleSeriesFileWrite('One Piece');
  await vi.advanceTimersByTimeAsync(2000);

  expect(scans.toArray).toBe(0);
  expect(writeSeriesFile).toHaveBeenCalledWith('One Piece');
});
```

Extend the file's `db` mock with a `where(index)` implementation returning `{ equals: (v) => ({ toArray: async () => volumeRows.filter((r) => r[index] === v) }) }` so the narrowed query works under test.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/lib/metadata/series-file-sync.test.ts`
Expected: FAIL — `scans.toArray` is 1.

- [ ] **Step 3: Narrow each site**

`hasBackedUpVolume` (series-file-sync.ts:151) — replace the scan with the indexed read, keeping the existing NFC folding by comparing folded titles on the returned subset:

```ts
const volumes = (await db.volumes
  .where('series_title')
  .equals(seriesTitle)
  .toArray()) as VolumeMetadata[];
```

Because a decomposed folder name will not match the stored composed title byte-for-byte, fall back to the folded comparison **only when the indexed read returns nothing**:

```ts
const candidates =
  volumes.length > 0 ? volumes : ((await db.volumes.toArray()) as VolumeMetadata[]);
```

Apply the same pattern to `series-backfill.ts:455` and `stranded-rows.ts:35`. For `locallyKnownSeriesKeys` (series-file-sync.ts:540), which genuinely needs every series key, switch to `db.volumes.orderBy('series_title').uniqueKeys()` — an index-only read that never deserializes a row.

- [ ] **Step 4: Run the tests — expect PASS**

Run: `npx vitest run src/lib/metadata src/lib/catalog`

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/lib/metadata/series-file-sync.ts src/lib/metadata/series-backfill.ts src/lib/catalog/stranded-rows.ts src/lib/metadata/series-file-sync.test.ts src/lib/catalog/stranded-rows.test.ts
git add src/lib/metadata/series-file-sync.ts src/lib/metadata/series-backfill.ts src/lib/catalog/stranded-rows.ts src/lib/metadata/series-file-sync.test.ts src/lib/catalog/stranded-rows.test.ts
git commit -m "perf(catalog): answer per-series questions with indexed reads"
```

---

### Task 8: Coalesce the catalog's liveQuery emissions

Even a cheap scan should not run once per write. This collapses a burst into one recompute.

**Files:**

- Modify: `src/lib/catalog/index.ts` (the `volumes` readable ~line 72)
- Modify: `src/lib/catalog/catalog-store.test.ts`

**Interfaces:**

- Produces: `VOLUMES_EMISSION_COALESCE_MS` (exported for tests)

- [ ] **Step 1: Write the failing test**

```ts
// append to src/lib/catalog/catalog-store.test.ts
describe('volumes emissions coalesce', () => {
  it('collapses a burst of writes into one recompute', async () => {
    vi.useFakeTimers();
    let emissions = 0;
    const unsub = volumes.subscribe(() => emissions++);
    emissions = 0;

    for (let i = 0; i < 20; i++) emitLiveQuery({ ['v' + i]: {} });
    await vi.advanceTimersByTimeAsync(VOLUMES_EMISSION_COALESCE_MS * 2);

    expect(emissions).toBe(1);
    unsub();
    vi.useRealTimers();
  });

  it('still delivers the latest value after the quiet period', async () => {
    vi.useFakeTimers();
    let latest: unknown = null;
    const unsub = volumes.subscribe((v) => (latest = v));
    emitLiveQuery({ first: {} });
    emitLiveQuery({ second: {} });
    await vi.advanceTimersByTimeAsync(VOLUMES_EMISSION_COALESCE_MS * 2);
    expect(Object.keys(latest as object)).toEqual(['second']);
    unsub();
    vi.useRealTimers();
  });
});
```

`emitLiveQuery` is the file's existing hook for pushing a value through the mocked `liveQuery`; if it does not exist, add one to the mock.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/lib/catalog/catalog-store.test.ts`
Expected: FAIL — 20 emissions, not 1.

- [ ] **Step 3: Implement**

```ts
/**
 * A burst of writes must cost ONE recompute, not one per write.
 *
 * Every emission re-derives placeholders, display titles and the sort for the
 * whole library, so an uncoalesced burst pays that repeatedly for a view nobody
 * saw — measured at 74 full recomputes in ten seconds during cover convergence.
 * Trailing-edge on purpose: subscribers get the final state of the burst, and
 * the delay is imperceptible for catalog updates while being long enough to
 * absorb a batch write.
 */
export const VOLUMES_EMISSION_COALESCE_MS = 150;
```

Replace the direct `set(value)` in the `volumes` readable with a trailing-edge timer:

```ts
export const volumes = readable<Record<string, VolumeMetadata>>({}, (set) => {
  let newest: Record<string, VolumeMetadata> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    if (newest) {
      set(newest);
      newest = null;
    }
  };

  const subscription = liveQuery(async () => {
    const volumesArray = await db.volumes.toArray();
    return volumesArray.reduce(
      (acc, vol) => {
        acc[vol.volume_uuid] = vol;
        return acc;
      },
      {} as Record<string, VolumeMetadata>
    );
  }).subscribe({
    next: (value) => {
      newest = value;
      // Trailing edge only: the first write of a burst arms the timer and every
      // later one replaces the payload, so subscribers see the burst's final
      // state exactly once.
      if (!timer) timer = setTimeout(flush, VOLUMES_EMISSION_COALESCE_MS);
    },
    error: (err) => console.error(err)
  });

  return () => {
    if (timer) clearTimeout(timer);
    subscription.unsubscribe();
  };
});
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `npx vitest run src/lib/catalog/catalog-store.test.ts`

- [ ] **Step 5: Full suite, then commit**

```bash
npx vitest run && npm run check
npx prettier --write src/lib/catalog/index.ts src/lib/catalog/catalog-store.test.ts
git add src/lib/catalog/index.ts src/lib/catalog/catalog-store.test.ts
git commit -m "perf(catalog): coalesce volumes liveQuery emissions"
```

---

### Task 9: Verify against a real library

Unit tests cannot show scan-storm behaviour. This task measures the assembled result the same way the regression was diagnosed.

**Files:**

- Modify: `docs/superpowers/specs/2026-08-25-cloud-metadata-cache-design.md` (append a "Measured after" section)

- [ ] **Step 1: Wipe local web-app storage**

In the browser running the dev server, clear site data for `http://localhost:5173` (DevTools → Application → Storage → Clear site data). Per the Global Constraints there is no migration: the database rebuilds from the cloud.

- [ ] **Step 2: Rebuild by browsing**

Connect the cloud provider, open the catalog, and let it settle. Then open several series so `cloud_covers` populates.

- [ ] **Step 3: Measure the scan rate**

In the DevTools console, patch and count for ten seconds:

```js
const orig = IDBObjectStore.prototype.getAll;
window.__scans = 0;
IDBObjectStore.prototype.getAll = function (r, c) {
  if (this.name === 'volumes' && r == null && c == null) window.__scans++;
  return orig.call(this, r, c);
};
setTimeout(() => console.log('volumes full scans in 10s:', window.__scans), 10000);
```

Expected: a small number (single digits), versus 74 before this plan.

- [ ] **Step 4: Confirm the table sizes**

```js
const db = await new Promise((res) => {
  const r = indexedDB.open('mokuro_v3');
  r.onsuccess = () => res(r.result);
});
const count = (s) =>
  new Promise((res) => {
    const t = db.transaction(s, 'readonly').objectStore(s).count();
    t.onsuccess = () => res(t.result);
  });
console.log({ volumes: await count('volumes'), covers: await count('cloud_covers') });
```

Expected: `volumes` in the hundreds (installed + history), `cloud_covers` holding the browsed remainder — thumbnails only, so its per-row size is smaller than the old fat-row cache would have been.

- [ ] **Step 5: Record the numbers and commit**

Append the measured scan count and table sizes to the spec's new "Measured after" section, then:

```bash
git add docs/superpowers/specs/2026-08-25-cloud-metadata-cache-design.md
git commit -m "docs: record post-split measurements"
```
