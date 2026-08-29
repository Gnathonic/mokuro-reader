# Series Metadata — Plan A: Link + Embed + Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user link a series (folder) to AniList, store the link + titles + a free-text tag in a new `series_metadata` table, embed those facts in every `.mokuro` the app writes (and read them back on import), sync the table across devices as `series-metadata.json`, and refresh already-backed-up sidecars on demand.

**Architecture:** A new `src/lib/metadata/` module owns the `SeriesMetadata` record (keyed by the normalized folder title), the AniList provider, and pure helpers (merge, embed, link targets). One shared `buildMokuroMetadata()` replaces the four duplicated `.mokuro` writers so the embed appears everywhere; `parseMokuroFile` reads it back. Cloud sync gets a root `series-metadata.json` handled exactly like `volume-data.json`. UI is a `SeriesMetadataBar` under the series title plus a `SeriesLinkModal`.

**Tech Stack:** SvelteKit 5 (runes), Dexie 4 (+ `fake-indexeddb` in tests), Flowbite Svelte, Vitest (jsdom), plain `fetch` to `https://graphql.anilist.co`.

**Spec:** `docs/superpowers/specs/2026-08-16-series-metadata-linking-design.md` (Phase A). Shared contract for Plans A/B/C: the "Interfaces" blocks below are authoritative — Plans B and C import these names.

## Global Constraints

- Work in worktree `/home/nathan/Projects/mokuro-reader-worktrees/feat/series-metadata` (branch `feat/series-metadata`). Never commit in the main checkout.
- The folder name (`series_title`) is **never** modified by this feature. Records are keyed by `normalizeSeriesKey(series_title)` = `trim / collapse whitespace / lowercase`.
- `.mokuro` embed contains series **facts + tag only**: `external_ids`, `titles`, `synonyms`, `tag`, `updated_at`. Never `tracking`, `title_preference`, `read_count`.
- Linking/tag edits never trigger an automatic mass re-upload; sidecar refresh is an explicit user action.
- Newest `updated_at` wins in every merge (tie → local).
- Modal action-button containers get `relative z-10` (night-mode `filter` stacking-context rule from CLAUDE.md).
- `compress-volume.ts` runs inside Web Workers: it must not import `$lib/catalog/db` or `$lib/metadata/store`; it opens its own Dexie handle (`getDatabase()`), which must declare the same `version(2)` schema.
- Tests: `npx vitest run <path>` for a file, `npx vitest run` for the suite; `npm run check` for svelte-check. All must pass before each commit.
- Commit messages: conventional (`feat(metadata): …`, `test: …`, `docs: …`).

---

## File map

| Path                                                                                             | Responsibility                                                                                                  |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `src/lib/metadata/types.ts` (create)                                                             | `SeriesMetadata`, `EmbeddedSeriesMetadata`, `DisplayTitleLanguage`, `TrackingUnit`, `createEmptySeriesMetadata` |
| `src/lib/metadata/series-key.ts` (create)                                                        | `normalizeSeriesKey`                                                                                            |
| `src/lib/catalog/catalog.ts`, `src/lib/catalog/index.ts` (modify)                                | use `normalizeSeriesKey` instead of private/inlined normalization                                               |
| `src/lib/catalog/db-v3.ts` (modify)                                                              | Dexie `version(2)` adds `series_metadata` table                                                                 |
| `src/lib/util/compress-volume.ts` (modify)                                                       | worker Dexie handle `version(2)`; writers use `buildMokuroMetadata`                                             |
| `src/lib/metadata/store.ts` (create)                                                             | table access, upsert/unlink/move helpers, `seriesMetadataMap` liveQuery store                                   |
| `src/lib/metadata/merge.ts` (create)                                                             | `mergeSeriesMetadata` (pure)                                                                                    |
| `src/lib/metadata/embed.ts` (create)                                                             | `toEmbedded` / `fromEmbedded` (pure)                                                                            |
| `src/lib/util/mokuro-metadata.ts` (create)                                                       | `MokuroMetadata` type + `buildMokuroMetadata` (pure)                                                            |
| `src/lib/util/volume-sidecars.ts`, `src/lib/util/zip.ts` (modify)                                | use `buildMokuroMetadata` + `getSeriesMetadataForTitle`                                                         |
| `src/lib/import/processing.ts`, `src/lib/import/types.ts`, `src/lib/import/database.ts` (modify) | parse `series_metadata`, carry to `ProcessedMetadata`, `upsertFromEmbedded` after save                          |
| `src/lib/metadata/provider-interface.ts` (create)                                                | `MetadataProvider`, `MetadataSearchResult`                                                                      |
| `src/lib/metadata/providers/anilist.ts` (create)                                                 | `anilistRequest`, rate guard, `anilistProvider`, `toSeriesMetadataPatch`, `parseAniListIdInput`                 |
| `src/lib/metadata/link-targets.ts` (create)                                                      | `getLinkTargets`                                                                                                |
| `src/lib/metadata/link-search.ts` (create)                                                       | debounced/abortable search controller used by the modal                                                         |
| `src/lib/util/sync/syncable-file.ts`, `src/lib/util/sync/unified-sync-service.ts` (modify)       | `series-metadata.json` root file + `syncSeriesMetadata`                                                         |
| `src/lib/util/sync/unified-cloud-manager.ts` (modify)                                            | `refreshVolumeSidecar`, `refreshSeriesSidecars`                                                                 |
| `src/lib/util/series-rename.ts` (modify)                                                         | `moveSeriesMetadataKey` after rename                                                                            |
| `src/lib/components/Series/SeriesLinkModal.svelte` (create)                                      | search + pick + paste URL/ID                                                                                    |
| `src/lib/components/Series/SeriesMetadataBar.svelte` (create)                                    | alt titles, link chips, Link/Change/Unlink, tag field, Update cloud sidecars                                    |
| `src/lib/views/SeriesView.svelte` (modify)                                                       | mount the bar under the title                                                                                   |
| `CLAUDE.md`, `CHANGELOG.md` (modify)                                                             | schema table + `.mokuro` embed note; Unreleased entry                                                           |

---

### Task 1: Types + `normalizeSeriesKey` (and use it in the catalog)

**Files:**

- Create: `src/lib/metadata/types.ts`
- Create: `src/lib/metadata/series-key.ts`
- Create: `src/lib/metadata/series-key.test.ts`
- Modify: `src/lib/catalog/catalog.ts:14-16` (private `normalizeSeriesTitle`), `src/lib/catalog/index.ts:105-107` (`currentSeries` inline normalization)

**Interfaces:**

- Produces: everything in `types.ts` below; `normalizeSeriesKey(title: string): string`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/metadata/series-key.test.ts
import { describe, expect, it } from 'vitest';
import { normalizeSeriesKey } from './series-key';
import { createEmptySeriesMetadata } from './types';

describe('normalizeSeriesKey', () => {
  it('trims, collapses whitespace and lowercases', () => {
    expect(normalizeSeriesKey('  One   Piece  ')).toBe('one piece');
    expect(normalizeSeriesKey('ONE\tPIECE')).toBe('one piece');
  });

  it('is idempotent', () => {
    const once = normalizeSeriesKey('  Yotsuba&!  ');
    expect(normalizeSeriesKey(once)).toBe(once);
  });
});

describe('createEmptySeriesMetadata', () => {
  it('keys the record by the normalized title and starts unlinked', () => {
    const meta = createEmptySeriesMetadata('  One Piece ', '2026-08-16T00:00:00.000Z');
    expect(meta.series_key).toBe('one piece');
    expect(meta.series_title).toBe('  One Piece ');
    expect(meta.external_ids).toEqual({});
    expect(meta.titles).toEqual({});
    expect(meta.synonyms).toEqual([]);
    expect(meta.read_count).toBe(0);
    expect(meta.updated_at).toBe('2026-08-16T00:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/metadata/series-key.test.ts`
Expected: FAIL — cannot resolve `./series-key` / `./types`.

- [ ] **Step 3: Create the two modules**

```ts
// src/lib/metadata/series-key.ts
/**
 * The identity of a series for metadata purposes: the catalog's grouping key.
 * MUST stay identical to how the catalog groups volumes (trim / collapse
 * whitespace / lowercase) — series_uuid is deliberately NOT used because it is
 * fragmented across cloud placeholders and merges.
 */
export function normalizeSeriesKey(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}
```

```ts
// src/lib/metadata/types.ts
import { normalizeSeriesKey } from './series-key';

export type DisplayTitleLanguage = 'imported' | 'native' | 'romaji' | 'english';
export type TrackingUnit = 'volumes' | 'chapters';

export interface SeriesTitles {
  native?: string;
  romaji?: string;
  english?: string;
}

export interface SeriesExternalIds {
  anilist?: number;
  mal?: number;
}

export interface SeriesTracking {
  enabled: boolean;
  unit: TrackingUnit;
  /** volume_uuid -> volume/chapter number override */
  number_overrides?: Record<string, number>;
  last_pushed?: { n: number; status: string; at: string };
}

/**
 * Per-series metadata record. PK = normalizeSeriesKey(series_title).
 * Synced as series-metadata.json (newest updated_at wins per key).
 * Only the "facts" (external_ids/titles/synonyms/tag) are embedded in .mokuro.
 */
export interface SeriesMetadata {
  series_key: string;
  series_title: string;
  external_ids: SeriesExternalIds;
  titles: SeriesTitles;
  synonyms: string[];
  /** Free text appended to the display name; exported in .mokuro for mokuro-bunko */
  tag?: string;
  format?: string;
  status?: string;
  total_volumes?: number;
  total_chapters?: number;
  cover_url?: string;
  title_preference?: DisplayTitleLanguage;
  /** Archived completed passes; timesRead = read_count + (all volumes completed now ? 1 : 0) */
  read_count: number;
  reread_prompt_suppressed?: boolean;
  tracking?: SeriesTracking;
  /** ISO timestamp — merge key */
  updated_at: string;
  linked_at?: string;
}

/** The subset written into a .mokuro file under `series_metadata`. */
export interface EmbeddedSeriesMetadata {
  external_ids: SeriesExternalIds;
  titles: SeriesTitles;
  synonyms: string[];
  tag?: string;
  updated_at: string;
}

export function createEmptySeriesMetadata(
  seriesTitle: string,
  now: string = new Date().toISOString()
): SeriesMetadata {
  return {
    series_key: normalizeSeriesKey(seriesTitle),
    series_title: seriesTitle,
    external_ids: {},
    titles: {},
    synonyms: [],
    read_count: 0,
    updated_at: now
  };
}
```

- [ ] **Step 4: Point the catalog at the shared normalizer**

In `src/lib/catalog/catalog.ts` replace the private function with an import:

```ts
import type { VolumeMetadata } from '$lib/types';
import { sortVolumes } from './sort-volumes';
import { normalizeSeriesKey } from '$lib/metadata/series-key';
```

Delete lines 14-16 (`function normalizeSeriesTitle …`) and change the call at line 23 to `const key = normalizeSeriesKey(entry.series_title);`.

In `src/lib/catalog/index.ts` add `import { normalizeSeriesKey } from '$lib/metadata/series-key';` and replace the two inline normalizations in `currentSeries`:

```ts
const routeKey = normalizeSeriesKey($routeParams.manga);
// Primary: match by title (folder name) - handles placeholder→local transition
let series = $catalog.find((s) => normalizeSeriesKey(s.title) === routeKey);
```

- [ ] **Step 5: Run tests + type check**

Run: `npx vitest run src/lib/metadata/series-key.test.ts src/lib/catalog && npm run check`
Expected: PASS; svelte-check reports 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/metadata/types.ts src/lib/metadata/series-key.ts src/lib/metadata/series-key.test.ts src/lib/catalog/catalog.ts src/lib/catalog/index.ts
git commit -m "feat(metadata): SeriesMetadata types + shared normalizeSeriesKey"
```

---

### Task 2: `series_metadata` Dexie table + `store.ts`

**Files:**

- Modify: `src/lib/catalog/db-v3.ts:8-22`
- Modify: `src/lib/util/compress-volume.ts:148-158` (`getDatabase`)
- Create: `src/lib/metadata/store.ts`
- Create: `src/lib/metadata/store.test.ts`

**Interfaces:**

- Consumes: `SeriesMetadata`, `EmbeddedSeriesMetadata`, `createEmptySeriesMetadata` (Task 1).
- Produces (used by Tasks 5, 6, 8, 10, 11, 12 and Plans B/C):
  - `getSeriesMetadata(seriesKey: string): Promise<SeriesMetadata | undefined>`
  - `getSeriesMetadataForTitle(seriesTitle: string): Promise<SeriesMetadata | undefined>`
  - `type SeriesMetadataPatch = Partial<Omit<SeriesMetadata, 'series_key' | 'series_title' | 'updated_at'>>`
  - `updateSeriesMetadata(seriesTitle: string, patch: SeriesMetadataPatch): Promise<SeriesMetadata>` (upsert; sets `series_title`, `updated_at = now`)
  - `unlinkSeries(seriesTitle: string): Promise<SeriesMetadata>`
  - `upsertFromEmbedded(seriesTitle: string, embedded: EmbeddedSeriesMetadata): Promise<void>` (only if newer)
  - `moveSeriesMetadataKey(oldTitle: string, newTitle: string): Promise<void>`
  - `getAllSeriesMetadata(): Promise<Record<string, SeriesMetadata>>`
  - `replaceAllSeriesMetadata(records: Record<string, SeriesMetadata>): Promise<void>`
  - `seriesMetadataMap: Readable<Map<string, SeriesMetadata>>`

- [ ] **Step 1: Write the failing tests** (real Dexie on fake-indexeddb, mocked `$lib/catalog/db` so db-v3's browser-only imports stay out)

```ts
// src/lib/metadata/store.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('$lib/catalog/db', async () => {
  const { default: Dexie } = await import('dexie');
  const db = new Dexie('series-metadata-store-test');
  db.version(1).stores({ series_metadata: 'series_key' });
  return { db };
});

import { db } from '$lib/catalog/db';
import {
  getSeriesMetadata,
  getSeriesMetadataForTitle,
  updateSeriesMetadata,
  unlinkSeries,
  upsertFromEmbedded,
  moveSeriesMetadataKey,
  getAllSeriesMetadata,
  replaceAllSeriesMetadata
} from './store';

describe('series metadata store', () => {
  beforeEach(async () => {
    await (db as any).table('series_metadata').clear();
  });

  it('updateSeriesMetadata upserts by normalized title and stamps updated_at', async () => {
    const before = Date.now();
    const meta = await updateSeriesMetadata('  One Piece ', { tag: '[color]' });
    expect(meta.series_key).toBe('one piece');
    expect(meta.series_title).toBe('  One Piece ');
    expect(meta.tag).toBe('[color]');
    expect(Date.parse(meta.updated_at)).toBeGreaterThanOrEqual(before);

    const again = await updateSeriesMetadata('one PIECE', { external_ids: { anilist: 30013 } });
    expect(again.tag).toBe('[color]'); // merged, not replaced
    expect(again.external_ids).toEqual({ anilist: 30013 });
    expect(await getSeriesMetadataForTitle('One Piece')).toEqual(again);
    expect(await getSeriesMetadata('one piece')).toEqual(again);
  });

  it('unlinkSeries clears link facts but keeps tag/preferences/read_count/tracking', async () => {
    await updateSeriesMetadata('One Piece', {
      external_ids: { anilist: 30013, mal: 13 },
      titles: { english: 'One Piece' },
      synonyms: ['ワンピース'],
      format: 'MANGA',
      status: 'RELEASING',
      total_volumes: 100,
      cover_url: 'https://x/y.jpg',
      linked_at: '2026-01-01T00:00:00.000Z',
      tag: '[bw]',
      title_preference: 'native',
      read_count: 2,
      tracking: { enabled: true, unit: 'volumes' }
    });
    const meta = await unlinkSeries('One Piece');
    expect(meta.external_ids).toEqual({});
    expect(meta.titles).toEqual({});
    expect(meta.synonyms).toEqual([]);
    expect(meta.format).toBeUndefined();
    expect(meta.total_volumes).toBeUndefined();
    expect(meta.cover_url).toBeUndefined();
    expect(meta.linked_at).toBeUndefined();
    expect(meta.tag).toBe('[bw]');
    expect(meta.title_preference).toBe('native');
    expect(meta.read_count).toBe(2);
    expect(meta.tracking).toEqual({ enabled: true, unit: 'volumes' });
    expect(Object.keys(meta)).not.toContain('format'); // undefined keys stripped, not stored
  });

  it('upsertFromEmbedded writes when local is missing or older, ignores when local is newer', async () => {
    await upsertFromEmbedded('One Piece', {
      external_ids: { anilist: 30013 },
      titles: { romaji: 'ONE PIECE' },
      synonyms: [],
      tag: '[color]',
      updated_at: '2026-02-01T00:00:00.000Z'
    });
    let meta = await getSeriesMetadataForTitle('One Piece');
    expect(meta?.external_ids).toEqual({ anilist: 30013 });
    expect(meta?.tag).toBe('[color]');
    expect(meta?.updated_at).toBe('2026-02-01T00:00:00.000Z');
    expect(meta?.linked_at).toBe('2026-02-01T00:00:00.000Z');

    // older embed → ignored
    await upsertFromEmbedded('One Piece', {
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: '2026-01-01T00:00:00.000Z'
    });
    meta = await getSeriesMetadataForTitle('One Piece');
    expect(meta?.external_ids).toEqual({ anilist: 30013 });

    // newer embed without ids → unlink propagates
    await upsertFromEmbedded('One Piece', {
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: '2026-03-01T00:00:00.000Z'
    });
    meta = await getSeriesMetadataForTitle('One Piece');
    expect(meta?.external_ids).toEqual({});
    expect(meta?.tag).toBeUndefined();
  });

  it('moveSeriesMetadataKey moves the record; newer record wins on collision', async () => {
    await updateSeriesMetadata('Old Name', { tag: '[old]' });
    await moveSeriesMetadataKey('Old Name', 'New Name');
    expect(await getSeriesMetadataForTitle('Old Name')).toBeUndefined();
    const moved = await getSeriesMetadataForTitle('New Name');
    expect(moved?.series_key).toBe('new name');
    expect(moved?.series_title).toBe('New Name');
    expect(moved?.tag).toBe('[old]');

    // collision: existing 'Third' is NEWER than 'New Name' → keep 'Third'
    await replaceAllSeriesMetadata({
      third: {
        ...moved!,
        series_key: 'third',
        series_title: 'Third',
        tag: '[third]',
        updated_at: '2999-01-01T00:00:00.000Z'
      }
    });
    await moveSeriesMetadataKey('New Name', 'Third');
    expect(await getSeriesMetadataForTitle('New Name')).toBeUndefined();
    expect((await getSeriesMetadataForTitle('Third'))?.tag).toBe('[third]');
  });

  it('moveSeriesMetadataKey keeps the record when only case/whitespace changed', async () => {
    await updateSeriesMetadata('one piece', { tag: '[x]' });
    await moveSeriesMetadataKey('one piece', 'One  Piece');
    const meta = await getSeriesMetadataForTitle('One Piece');
    expect(meta?.tag).toBe('[x]');
    expect(meta?.series_title).toBe('One  Piece');
  });

  it('getAll/replaceAll round-trip a record map', async () => {
    await updateSeriesMetadata('A', { tag: '1' });
    await updateSeriesMetadata('B', { tag: '2' });
    const all = await getAllSeriesMetadata();
    expect(Object.keys(all).sort()).toEqual(['a', 'b']);
    await replaceAllSeriesMetadata({ ...all, b: { ...all.b, tag: '22' } });
    expect((await getSeriesMetadataForTitle('B'))?.tag).toBe('22');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/metadata/store.test.ts`
Expected: FAIL — cannot resolve `./store`.

- [ ] **Step 3: Add the table to both Dexie openers**

`src/lib/catalog/db-v3.ts`:

```ts
import type { VolumeMetadata, VolumeOCR, VolumeFiles } from '$lib/types';
import type { SeriesMetadata } from '$lib/metadata/types';
import Dexie, { type Table } from 'dexie';
// ...existing imports unchanged...

export class CatalogDexieV3 extends Dexie {
  volumes!: Table<VolumeMetadata>;
  volume_ocr!: Table<VolumeOCR>;
  volume_files!: Table<VolumeFiles>;
  series_metadata!: Table<SeriesMetadata>;

  constructor(dbName: string = 'mokuro_v3') {
    super(dbName);

    // v3 schema: 3 tables (thumbnails are inlined in volumes)
    this.version(1).stores({
      volumes: 'volume_uuid, series_uuid, series_title',
      volume_ocr: 'volume_uuid',
      volume_files: 'volume_uuid'
    });

    // v3.2: per-series metadata (AniList link, titles, tag, tracking). Keyed by
    // normalizeSeriesKey(series_title). Additive — no data migration.
    this.version(2).stores({
      volumes: 'volume_uuid, series_uuid, series_title',
      volume_ocr: 'volume_uuid',
      volume_files: 'volume_uuid',
      series_metadata: 'series_key'
    });
  }
```

`src/lib/util/compress-volume.ts` `getDatabase()` — keep the worker handle's declared schema identical to the main one:

```ts
function getDatabase(): Dexie {
  if (!workerDb) {
    workerDb = new Dexie('mokuro_v3');
    workerDb.version(1).stores({
      volumes: 'volume_uuid, series_uuid, series_title',
      volume_ocr: 'volume_uuid',
      volume_files: 'volume_uuid'
    });
    // Must mirror CatalogDexieV3 version(2) (series_metadata is read to embed
    // series facts into regenerated .mokuro sidecars).
    workerDb.version(2).stores({
      volumes: 'volume_uuid, series_uuid, series_title',
      volume_ocr: 'volume_uuid',
      volume_files: 'volume_uuid',
      series_metadata: 'series_key'
    });
  }
  return workerDb;
}
```

- [ ] **Step 4: Write `store.ts`**

```ts
// src/lib/metadata/store.ts
import { db } from '$lib/catalog/db';
import { liveQuery } from 'dexie';
import { readable, type Readable } from 'svelte/store';
import { normalizeSeriesKey } from './series-key';
import {
  createEmptySeriesMetadata,
  type EmbeddedSeriesMetadata,
  type SeriesMetadata
} from './types';

export type SeriesMetadataPatch = Partial<
  Omit<SeriesMetadata, 'series_key' | 'series_title' | 'updated_at'>
>;

/** Drop `undefined` values so "cleared" fields disappear from IndexedDB and JSON. */
function stripUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

function hasAnyId(ids: SeriesMetadata['external_ids'] | undefined): boolean {
  return !!ids && Object.values(ids).some((v) => v != null);
}

export async function getSeriesMetadata(seriesKey: string): Promise<SeriesMetadata | undefined> {
  return db.series_metadata.get(seriesKey);
}

export async function getSeriesMetadataForTitle(
  seriesTitle: string
): Promise<SeriesMetadata | undefined> {
  return getSeriesMetadata(normalizeSeriesKey(seriesTitle));
}

/** Upsert: merges `patch` into the existing record (or a fresh one) and stamps updated_at. */
export async function updateSeriesMetadata(
  seriesTitle: string,
  patch: SeriesMetadataPatch
): Promise<SeriesMetadata> {
  const key = normalizeSeriesKey(seriesTitle);
  const now = new Date().toISOString();
  const existing =
    (await db.series_metadata.get(key)) ?? createEmptySeriesMetadata(seriesTitle, now);
  const next = stripUndefined<SeriesMetadata>({
    ...existing,
    ...patch,
    series_key: key,
    series_title: seriesTitle,
    updated_at: now
  });
  await db.series_metadata.put(next);
  return next;
}

/** Remove the external link + fetched facts; keep user preferences/tag/read_count/tracking. */
export async function unlinkSeries(seriesTitle: string): Promise<SeriesMetadata> {
  return updateSeriesMetadata(seriesTitle, {
    external_ids: {},
    titles: {},
    synonyms: [],
    format: undefined,
    status: undefined,
    total_volumes: undefined,
    total_chapters: undefined,
    cover_url: undefined,
    linked_at: undefined
  });
}

/**
 * Apply facts read from a .mokuro `series_metadata` block. Newest wins: only
 * writes when there is no local record or the embed is strictly newer.
 */
export async function upsertFromEmbedded(
  seriesTitle: string,
  embedded: EmbeddedSeriesMetadata
): Promise<void> {
  const key = normalizeSeriesKey(seriesTitle);
  const existing = await db.series_metadata.get(key);
  if (existing && existing.updated_at >= embedded.updated_at) return;

  const base = existing ?? createEmptySeriesMetadata(seriesTitle, embedded.updated_at);
  const linked = hasAnyId(embedded.external_ids);
  const next = stripUndefined<SeriesMetadata>({
    ...base,
    series_key: key,
    series_title: seriesTitle,
    external_ids: { ...embedded.external_ids },
    titles: { ...embedded.titles },
    synonyms: [...embedded.synonyms],
    tag: embedded.tag,
    updated_at: embedded.updated_at,
    linked_at: linked ? (base.linked_at ?? embedded.updated_at) : undefined
  });
  await db.series_metadata.put(next);
}

/** After a series rename: carry the record to the new key (newer record wins on collision). */
export async function moveSeriesMetadataKey(oldTitle: string, newTitle: string): Promise<void> {
  const oldKey = normalizeSeriesKey(oldTitle);
  const newKey = normalizeSeriesKey(newTitle);

  await db.transaction('rw', db.series_metadata, async () => {
    const oldRec = await db.series_metadata.get(oldKey);
    if (!oldRec) return;

    if (oldKey === newKey) {
      await db.series_metadata.put({ ...oldRec, series_title: newTitle });
      return;
    }

    const newRec = await db.series_metadata.get(newKey);
    const winner: SeriesMetadata =
      newRec && newRec.updated_at > oldRec.updated_at
        ? newRec
        : { ...oldRec, series_key: newKey, series_title: newTitle };
    await db.series_metadata.put(winner);
    await db.series_metadata.delete(oldKey);
  });
}

export async function getAllSeriesMetadata(): Promise<Record<string, SeriesMetadata>> {
  const rows = await db.series_metadata.toArray();
  return Object.fromEntries(rows.map((r) => [r.series_key, r]));
}

export async function replaceAllSeriesMetadata(
  records: Record<string, SeriesMetadata>
): Promise<void> {
  await db.series_metadata.bulkPut(Object.values(records));
}

/** Reactive view of the whole table, keyed by series_key. Empty Map before first emission. */
export const seriesMetadataMap: Readable<Map<string, SeriesMetadata>> = readable(
  new Map<string, SeriesMetadata>(),
  (set) => {
    const subscription = liveQuery(() => db.series_metadata.toArray()).subscribe({
      next: (rows) => set(new Map(rows.map((r) => [r.series_key, r]))),
      error: (err) => console.error('series_metadata liveQuery failed:', err)
    });
    return () => subscription.unsubscribe();
  }
);
```

- [ ] **Step 5: Run tests + type check**

Run: `npx vitest run src/lib/metadata/store.test.ts && npm run check`
Expected: PASS, 0 svelte-check errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/catalog/db-v3.ts src/lib/util/compress-volume.ts src/lib/metadata/store.ts src/lib/metadata/store.test.ts
git commit -m "feat(metadata): series_metadata Dexie table + store helpers"
```

---

### Task 3: `mergeSeriesMetadata` (pure)

**Files:**

- Create: `src/lib/metadata/merge.ts`
- Create: `src/lib/metadata/merge.test.ts`

**Interfaces:**

- Produces: `mergeSeriesMetadata(local: Record<string, SeriesMetadata>, cloud: Record<string, SeriesMetadata>): Record<string, SeriesMetadata>` (used by Task 8).

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/metadata/merge.test.ts
import { describe, expect, it } from 'vitest';
import { mergeSeriesMetadata } from './merge';
import { createEmptySeriesMetadata, type SeriesMetadata } from './types';

function rec(title: string, updated_at: string, tag?: string): SeriesMetadata {
  return { ...createEmptySeriesMetadata(title, updated_at), tag };
}

describe('mergeSeriesMetadata', () => {
  it('unions keys from both sides', () => {
    const merged = mergeSeriesMetadata(
      { a: rec('A', '2026-01-01T00:00:00.000Z') },
      { b: rec('B', '2026-01-01T00:00:00.000Z') }
    );
    expect(Object.keys(merged).sort()).toEqual(['a', 'b']);
  });

  it('newest updated_at wins per key', () => {
    const merged = mergeSeriesMetadata(
      { a: rec('A', '2026-01-01T00:00:00.000Z', 'local') },
      { a: rec('A', '2026-02-01T00:00:00.000Z', 'cloud') }
    );
    expect(merged.a.tag).toBe('cloud');
    const merged2 = mergeSeriesMetadata(
      { a: rec('A', '2026-03-01T00:00:00.000Z', 'local') },
      { a: rec('A', '2026-02-01T00:00:00.000Z', 'cloud') }
    );
    expect(merged2.a.tag).toBe('local');
  });

  it('tie keeps local', () => {
    const merged = mergeSeriesMetadata(
      { a: rec('A', '2026-01-01T00:00:00.000Z', 'local') },
      { a: rec('A', '2026-01-01T00:00:00.000Z', 'cloud') }
    );
    expect(merged.a.tag).toBe('local');
  });

  it('skips malformed cloud entries', () => {
    const merged = mergeSeriesMetadata(
      {},
      { a: { nope: true } as unknown as SeriesMetadata, b: rec('B', '2026-01-01T00:00:00.000Z') }
    );
    expect(Object.keys(merged)).toEqual(['b']);
  });

  it('does not mutate inputs', () => {
    const local = { a: rec('A', '2026-01-01T00:00:00.000Z', 'local') };
    const cloud = { a: rec('A', '2026-02-01T00:00:00.000Z', 'cloud') };
    mergeSeriesMetadata(local, cloud);
    expect(local.a.tag).toBe('local');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/metadata/merge.test.ts`
Expected: FAIL — cannot resolve `./merge`.

- [ ] **Step 3: Implement**

```ts
// src/lib/metadata/merge.ts
import type { SeriesMetadata } from './types';

function isRecordLike(value: unknown): value is SeriesMetadata {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as SeriesMetadata).series_key === 'string' &&
    typeof (value as SeriesMetadata).updated_at === 'string'
  );
}

/** Newest `updated_at` wins per key; tie keeps local; malformed cloud rows are ignored. */
export function mergeSeriesMetadata(
  local: Record<string, SeriesMetadata>,
  cloud: Record<string, SeriesMetadata>
): Record<string, SeriesMetadata> {
  const merged: Record<string, SeriesMetadata> = { ...local };
  for (const [key, cloudRec] of Object.entries(cloud)) {
    if (!isRecordLike(cloudRec)) continue;
    const localRec = merged[key];
    if (!localRec || cloudRec.updated_at > localRec.updated_at) {
      merged[key] = cloudRec;
    }
  }
  return merged;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/metadata/merge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/metadata/merge.ts src/lib/metadata/merge.test.ts
git commit -m "feat(metadata): newest-wins merge for series metadata"
```

---

### Task 4: `toEmbedded` / `fromEmbedded` (pure)

**Files:**

- Create: `src/lib/metadata/embed.ts`
- Create: `src/lib/metadata/embed.test.ts`

**Interfaces:**

- Produces: `toEmbedded(meta: SeriesMetadata | undefined | null): EmbeddedSeriesMetadata | undefined`; `fromEmbedded(value: unknown): EmbeddedSeriesMetadata | undefined` (used by Tasks 5, 6).

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/metadata/embed.test.ts
import { describe, expect, it } from 'vitest';
import { fromEmbedded, toEmbedded } from './embed';
import { createEmptySeriesMetadata } from './types';

describe('toEmbedded', () => {
  it('returns undefined for missing/empty metadata (nothing worth embedding)', () => {
    expect(toEmbedded(undefined)).toBeUndefined();
    expect(toEmbedded(null)).toBeUndefined();
    expect(toEmbedded(createEmptySeriesMetadata('X'))).toBeUndefined();
  });

  it('emits only facts + tag, never preferences/tracking', () => {
    const meta = {
      ...createEmptySeriesMetadata('One Piece', '2026-08-16T00:00:00.000Z'),
      external_ids: { anilist: 30013, mal: 13 },
      titles: { native: 'ONE PIECE', english: 'One Piece' },
      synonyms: ['ワンピース'],
      tag: '  [color] ',
      title_preference: 'native' as const,
      read_count: 3,
      tracking: { enabled: true, unit: 'volumes' as const }
    };
    expect(toEmbedded(meta)).toEqual({
      external_ids: { anilist: 30013, mal: 13 },
      titles: { native: 'ONE PIECE', english: 'One Piece' },
      synonyms: ['ワンピース'],
      tag: '[color]',
      updated_at: '2026-08-16T00:00:00.000Z'
    });
  });

  it('embeds a tag-only record (unlinked but tagged)', () => {
    const meta = { ...createEmptySeriesMetadata('X', '2026-08-16T00:00:00.000Z'), tag: '[bw]' };
    expect(toEmbedded(meta)).toEqual({
      external_ids: {},
      titles: {},
      synonyms: [],
      tag: '[bw]',
      updated_at: '2026-08-16T00:00:00.000Z'
    });
  });
});

describe('fromEmbedded', () => {
  it('rejects non-objects and missing/invalid updated_at', () => {
    expect(fromEmbedded(undefined)).toBeUndefined();
    expect(fromEmbedded('nope')).toBeUndefined();
    expect(fromEmbedded({})).toBeUndefined();
    expect(fromEmbedded({ updated_at: 'not a date' })).toBeUndefined();
  });

  it('accepts a full block and drops junk fields/values', () => {
    expect(
      fromEmbedded({
        external_ids: { anilist: 30013, mal: '13', bogus: 1 },
        titles: { native: 'ONE PIECE', english: '', romaji: 42 },
        synonyms: ['ワンピース', 7, null],
        tag: ' [color] ',
        tracking: { enabled: true },
        updated_at: '2026-08-16T00:00:00.000Z'
      })
    ).toEqual({
      external_ids: { anilist: 30013 },
      titles: { native: 'ONE PIECE' },
      synonyms: ['ワンピース'],
      tag: '[color]',
      updated_at: '2026-08-16T00:00:00.000Z'
    });
  });

  it('round-trips toEmbedded output', () => {
    const meta = {
      ...createEmptySeriesMetadata('One Piece', '2026-08-16T00:00:00.000Z'),
      external_ids: { anilist: 30013 },
      titles: { romaji: 'ONE PIECE' },
      synonyms: [],
      tag: '[color]'
    };
    const embedded = toEmbedded(meta)!;
    expect(fromEmbedded(JSON.parse(JSON.stringify(embedded)))).toEqual(embedded);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/metadata/embed.test.ts`
Expected: FAIL — cannot resolve `./embed`.

- [ ] **Step 3: Implement**

```ts
// src/lib/metadata/embed.ts
import type {
  EmbeddedSeriesMetadata,
  SeriesExternalIds,
  SeriesMetadata,
  SeriesTitles
} from './types';

const TITLE_KEYS = ['native', 'romaji', 'english'] as const;
const ID_KEYS = ['anilist', 'mal'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Facts + tag only. Returns undefined when there is nothing worth writing. */
export function toEmbedded(
  meta: SeriesMetadata | undefined | null
): EmbeddedSeriesMetadata | undefined {
  if (!meta) return undefined;
  const external_ids: SeriesExternalIds = {};
  for (const k of ID_KEYS)
    if (meta.external_ids?.[k] != null) external_ids[k] = meta.external_ids[k];
  const titles: SeriesTitles = {};
  for (const k of TITLE_KEYS) if (meta.titles?.[k]) titles[k] = meta.titles[k];
  const synonyms = [...(meta.synonyms ?? [])];
  const tag = meta.tag?.trim();

  const hasIds = Object.keys(external_ids).length > 0;
  const hasTitles = Object.keys(titles).length > 0;
  if (!hasIds && !hasTitles && !tag) return undefined;

  const out: EmbeddedSeriesMetadata = {
    external_ids,
    titles,
    synonyms,
    updated_at: meta.updated_at
  };
  if (tag) out.tag = tag;
  return out;
}

/** Validate an untrusted `series_metadata` block from a .mokuro file. */
export function fromEmbedded(value: unknown): EmbeddedSeriesMetadata | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.updated_at !== 'string' || Number.isNaN(Date.parse(value.updated_at))) {
    return undefined;
  }

  const rawIds = isRecord(value.external_ids) ? value.external_ids : {};
  const external_ids: SeriesExternalIds = {};
  for (const k of ID_KEYS) {
    const v = rawIds[k];
    if (typeof v === 'number' && Number.isInteger(v) && v > 0) external_ids[k] = v;
  }

  const rawTitles = isRecord(value.titles) ? value.titles : {};
  const titles: SeriesTitles = {};
  for (const k of TITLE_KEYS) {
    const v = rawTitles[k];
    if (typeof v === 'string' && v.trim()) titles[k] = v;
  }

  const synonyms = Array.isArray(value.synonyms)
    ? value.synonyms.filter((s): s is string => typeof s === 'string' && s.trim() !== '')
    : [];

  const out: EmbeddedSeriesMetadata = {
    external_ids,
    titles,
    synonyms,
    updated_at: value.updated_at
  };
  if (typeof value.tag === 'string' && value.tag.trim()) out.tag = value.tag.trim();
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/metadata/embed.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/metadata/embed.ts src/lib/metadata/embed.test.ts
git commit -m "feat(metadata): .mokuro embed encode/decode helpers"
```

---

### Task 5: `buildMokuroMetadata` replaces the four `.mokuro` writers

**Files:**

- Create: `src/lib/util/mokuro-metadata.ts`
- Create: `src/lib/util/mokuro-metadata.test.ts`
- Modify: `src/lib/util/compress-volume.ts:1-16` (type), `:160-198` (`generateVolumeSidecarsFromDb`), `:230-253` (`compressVolumeFromDb`)
- Modify: `src/lib/util/volume-sidecars.ts:1-30, 40-46`
- Modify: `src/lib/util/zip.ts:60-90, 165-192, 225-248`
- Modify: `src/lib/util/zip.test.ts:1-16` (add store mock)

**Interfaces:**

- Consumes: `toEmbedded` (Task 4), `getSeriesMetadataForTitle` (Task 2), `normalizeSeriesKey` (Task 1).
- Produces: `MokuroMetadata` (now with `series_metadata?: EmbeddedSeriesMetadata`), `buildMokuroMetadata(volume: VolumeMetadata, pages: unknown[], opts?: { seriesTitle?: string; volumeTitle?: string; seriesMetadata?: SeriesMetadata | null }): MokuroMetadata`. `compress-volume.ts` re-exports the type: `export type { MokuroMetadata } from './mokuro-metadata';`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/util/mokuro-metadata.test.ts
import { describe, expect, it } from 'vitest';
import { buildMokuroMetadata } from './mokuro-metadata';
import { createEmptySeriesMetadata } from '$lib/metadata/types';
import type { VolumeMetadata } from '$lib/types';

const volume: VolumeMetadata = {
  mokuro_version: '0.2.1',
  series_title: 'One Piece',
  series_uuid: 'series-uuid',
  volume_title: 'Vol 1',
  volume_uuid: 'vol-uuid',
  page_count: 2,
  character_count: 123,
  page_char_counts: [60, 123],
  spine_width: 17
};

const pages = [
  { img_path: '1.jpg', blocks: [] },
  { img_path: '2.jpg', blocks: [] }
];

describe('buildMokuroMetadata', () => {
  it('builds the classic mokuro shape from volume + pages, including spine_width', () => {
    const meta = buildMokuroMetadata(volume, pages);
    expect(meta).toEqual({
      version: '0.2.1',
      title: 'One Piece',
      title_uuid: 'series-uuid',
      volume: 'Vol 1',
      volume_uuid: 'vol-uuid',
      pages,
      chars: 123,
      spine_width: 17
    });
    expect('series_metadata' in meta).toBe(false);
  });

  it('omits spine_width when the volume has none', () => {
    const { spine_width: _omit, ...noSpine } = volume;
    expect('spine_width' in buildMokuroMetadata(noSpine, pages)).toBe(false);
  });

  it('applies title overrides (rename regeneration) without touching uuids', () => {
    const meta = buildMokuroMetadata(volume, pages, { seriesTitle: 'New', volumeTitle: 'V2' });
    expect(meta.title).toBe('New');
    expect(meta.volume).toBe('V2');
    expect(meta.title_uuid).toBe('series-uuid');
    expect(meta.volume_uuid).toBe('vol-uuid');
  });

  it('embeds series facts + tag when metadata is supplied', () => {
    const seriesMetadata = {
      ...createEmptySeriesMetadata('One Piece', '2026-08-16T00:00:00.000Z'),
      external_ids: { anilist: 30013, mal: 13 },
      titles: { english: 'One Piece' },
      tag: '[color]',
      tracking: { enabled: true, unit: 'volumes' as const }
    };
    const meta = buildMokuroMetadata(volume, pages, { seriesMetadata });
    expect(meta.series_metadata).toEqual({
      external_ids: { anilist: 30013, mal: 13 },
      titles: { english: 'One Piece' },
      synonyms: [],
      tag: '[color]',
      updated_at: '2026-08-16T00:00:00.000Z'
    });
    expect(JSON.stringify(meta)).not.toContain('tracking');
  });

  it('skips the embed for an empty record', () => {
    const meta = buildMokuroMetadata(volume, pages, {
      seriesMetadata: createEmptySeriesMetadata('One Piece')
    });
    expect('series_metadata' in meta).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/util/mokuro-metadata.test.ts`
Expected: FAIL — cannot resolve `./mokuro-metadata`.

- [ ] **Step 3: Create the shared builder**

```ts
// src/lib/util/mokuro-metadata.ts
import type { VolumeMetadata } from '$lib/types';
import type { EmbeddedSeriesMetadata, SeriesMetadata } from '$lib/metadata/types';
import { toEmbedded } from '$lib/metadata/embed';

/**
 * The .mokuro JSON the app writes (sidecars, CBZ-embedded, exports).
 * `series_metadata` and `spine_width` are reader extensions; upstream mokuro
 * ignores unknown keys, mokuro-bunko reads `series_metadata.tag`.
 */
export interface MokuroMetadata {
  version: string;
  title: string;
  title_uuid: string;
  volume: string;
  volume_uuid: string;
  pages: any[];
  chars: number;
  spine_width?: number;
  series_metadata?: EmbeddedSeriesMetadata;
}

export interface BuildMokuroMetadataOptions {
  /** Not-yet-committed rename: build with the NEW titles (uuids unchanged). */
  seriesTitle?: string;
  volumeTitle?: string;
  /** Series record to embed (facts + tag only). */
  seriesMetadata?: SeriesMetadata | null;
}

/** Single source of truth for every .mokuro the app writes. Pure; worker-safe. */
export function buildMokuroMetadata(
  volume: VolumeMetadata,
  pages: unknown[],
  opts: BuildMokuroMetadataOptions = {}
): MokuroMetadata {
  const meta: MokuroMetadata = {
    version: volume.mokuro_version,
    title: opts.seriesTitle ?? volume.series_title,
    title_uuid: volume.series_uuid,
    volume: opts.volumeTitle ?? volume.volume_title,
    volume_uuid: volume.volume_uuid,
    pages: pages as any[],
    chars: volume.character_count
  };
  if (volume.spine_width != null) meta.spine_width = volume.spine_width;
  const embedded = toEmbedded(opts.seriesMetadata);
  if (embedded) meta.series_metadata = embedded;
  return meta;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/util/mokuro-metadata.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewire `compress-volume.ts` (worker-safe: local Dexie handle only)**

Replace the interface at lines 7-16 with a re-export and add imports:

```ts
import { Uint8ArrayReader, BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js';
import Dexie from 'dexie';
import { buildMokuroMetadata, type MokuroMetadata } from './mokuro-metadata';
import { normalizeSeriesKey } from '$lib/metadata/series-key';
import type { SeriesMetadata } from '$lib/metadata/types';

// Re-exported for existing importers (volume-sidecars, zip, tests).
export type { MokuroMetadata } from './mokuro-metadata';
```

Add a worker-safe lookup next to `getDatabase()`:

```ts
/**
 * Series record for the .mokuro embed. Looked up by the volume's CURRENT title
 * first (a rename moves the record only after the cloud rename succeeds), then
 * by the override title.
 */
async function loadSeriesMetadataForEmbed(
  db: Dexie,
  currentSeriesTitle: string,
  overrideSeriesTitle?: string
): Promise<SeriesMetadata | null> {
  const table = db.table<SeriesMetadata>('series_metadata');
  const byCurrent = await table.get(normalizeSeriesKey(currentSeriesTitle));
  if (byCurrent) return byCurrent;
  if (overrideSeriesTitle && overrideSeriesTitle !== currentSeriesTitle) {
    return (await table.get(normalizeSeriesKey(overrideSeriesTitle))) ?? null;
  }
  return null;
}
```

In `generateVolumeSidecarsFromDb`, replace the `const metadata: MokuroMetadata = { … }` literal (lines 184-192) with:

```ts
const seriesMetadata = await loadSeriesMetadataForEmbed(
  db,
  volume.series_title,
  overrides?.seriesTitle
);
const metadata = buildMokuroMetadata(volume, volumeOcr.pages, {
  seriesTitle,
  volumeTitle,
  seriesMetadata
});
```

In `compressVolumeFromDb`, replace the `const metadata: MokuroMetadata | null = isImageOnly ? null : { … }` literal (lines 243-253) with:

```ts
const metadata: MokuroMetadata | null = isImageOnly
  ? null
  : buildMokuroMetadata(volume, volumeOcr?.pages || [], {
      seriesMetadata: await loadSeriesMetadataForEmbed(db, volume.series_title)
    });
```

- [ ] **Step 6: Rewire `volume-sidecars.ts`**

Replace the imports and delete the local `buildMokuroMetadata` (lines 20-29):

```ts
import { db } from '$lib/catalog/db';
import type { VolumeMetadata } from '$lib/types';
import { buildMokuroMetadata } from './mokuro-metadata';
import { getSeriesMetadataForTitle } from '$lib/metadata/store';
```

and inside `loadVolumeSidecars` change the call at line 44 to:

```ts
const seriesMetadata = await getSeriesMetadataForTitle(volume.series_title);
const metadata = buildMokuroMetadata(volume, volumeOcr.pages, { seriesMetadata });
```

(`VolumeMetadata` import stays only if still referenced elsewhere in the file; remove it if `npm run check` reports it unused.)

- [ ] **Step 7: Rewire `zip.ts` (three sites)**

Add imports at the top of `src/lib/util/zip.ts`:

```ts
import { buildMokuroMetadata, type MokuroMetadata } from './mokuro-metadata';
import { getSeriesMetadataForTitle } from '$lib/metadata/store';
```

(Remove the old `import type { MokuroMetadata } from './compress-volume'` if present — search the file; keep any value imports of `compressVolume`.)

Site 1 (`createArchiveBlob` area, lines 80-90) — replace the literal with:

```ts
const metadata: MokuroMetadata | null = isImageOnly
  ? null
  : buildMokuroMetadata(volume, volumeOcr.pages, {
      seriesMetadata: await getSeriesMetadataForTitle(volume.series_title)
    });
```

Site 2 (lines 177-192, `const mokuroData = { … }`) — replace with:

```ts
// Mokuro sidecar at the archive root (ZIP and CBZ), built by the shared writer
const mokuroData = buildMokuroMetadata(volume, volumeOcr.pages, {
  seriesMetadata: await getSeriesMetadataForTitle(volume.series_title)
});
```

Site 3 (lines 235-248) — replace the `const mokuroData = { … }` literal with the same two lines as site 2. If the enclosing function is not `async`, make it `async` and `await` its callers (the file already awaits `zipWriter.add` in that function, so it is async).

- [ ] **Step 8: Update `zip.test.ts` mocks** — add after the existing `vi.mock('$lib/catalog/db', …)` block:

```ts
vi.mock('$lib/metadata/store', () => ({
  getSeriesMetadataForTitle: vi.fn().mockResolvedValue(undefined)
}));
```

- [ ] **Step 9: Run the full suite + type check**

Run: `npx vitest run && npm run check`
Expected: PASS. If any other test file mocks `$lib/catalog/db` and now imports a module that reaches `$lib/metadata/store`, add the same `vi.mock('$lib/metadata/store', …)` block to it.

- [ ] **Step 10: Commit**

```bash
git add src/lib/util/mokuro-metadata.ts src/lib/util/mokuro-metadata.test.ts src/lib/util/compress-volume.ts src/lib/util/volume-sidecars.ts src/lib/util/zip.ts src/lib/util/zip.test.ts
git commit -m "feat(metadata): shared buildMokuroMetadata embeds series facts in every .mokuro"
```

---

### Task 6: Read `series_metadata` back on import

**Files:**

- Modify: `src/lib/import/processing.ts:38-47` (`ParsedMokuro`), `:156-185` (`parseMokuroFile`), `:674-690` (`ProcessedMetadata` literal)
- Modify: `src/lib/import/types.ts:167-189` (`ProcessedMetadata`)
- Modify: `src/lib/import/database.ts:45-135` (`saveVolume`)
- Modify: `src/lib/import/__tests__/database.test.ts:14-36` (add store mock)
- Modify: `src/lib/import/__tests__/processing.test.ts` (add parse test)
- Create: `src/lib/import/__tests__/series-metadata-roundtrip.test.ts`

**Interfaces:**

- Consumes: `fromEmbedded` (Task 4), `upsertFromEmbedded` (Task 2), `buildMokuroMetadata` (Task 5).
- Produces: `ParsedMokuro.seriesMetadata?: EmbeddedSeriesMetadata`, `ProcessedMetadata.seriesMetadata?: EmbeddedSeriesMetadata`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/import/__tests__/processing.test.ts` inside `describe('parseMokuroFile', …)`:

```ts
it('extracts a valid series_metadata block and ignores a malformed one', async () => {
  const good = new File(
    [
      JSON.stringify({
        version: '0.2.1',
        title: 'One Piece',
        title_uuid: 's',
        volume: 'Vol 1',
        volume_uuid: 'v',
        pages: [],
        series_metadata: {
          external_ids: { anilist: 30013 },
          titles: { english: 'One Piece' },
          synonyms: [],
          tag: '[color]',
          updated_at: '2026-08-16T00:00:00.000Z'
        }
      })
    ],
    'a.mokuro'
  );
  const parsed = await parseMokuroFile(good);
  expect(parsed.seriesMetadata).toEqual({
    external_ids: { anilist: 30013 },
    titles: { english: 'One Piece' },
    synonyms: [],
    tag: '[color]',
    updated_at: '2026-08-16T00:00:00.000Z'
  });

  const bad = new File(
    [
      JSON.stringify({
        version: '0.2.1',
        title: 'X',
        title_uuid: 's',
        volume: 'V',
        volume_uuid: 'v',
        pages: [],
        series_metadata: 'garbage'
      })
    ],
    'b.mokuro'
  );
  expect((await parseMokuroFile(bad)).seriesMetadata).toBeUndefined();
});
```

New round-trip test:

```ts
// src/lib/import/__tests__/series-metadata-roundtrip.test.ts
import { describe, expect, it } from 'vitest';
import { parseMokuroFile } from '../processing';
import { buildMokuroMetadata } from '$lib/util/mokuro-metadata';
import { createEmptySeriesMetadata } from '$lib/metadata/types';
import type { VolumeMetadata } from '$lib/types';

describe('.mokuro series_metadata round trip', () => {
  it('what buildMokuroMetadata writes, parseMokuroFile reads back identically', async () => {
    const volume: VolumeMetadata = {
      mokuro_version: '0.2.1',
      series_title: 'One Piece',
      series_uuid: 's',
      volume_title: 'Vol 1',
      volume_uuid: 'v',
      page_count: 1,
      character_count: 5,
      page_char_counts: [5]
    };
    const seriesMetadata = {
      ...createEmptySeriesMetadata('One Piece', '2026-08-16T00:00:00.000Z'),
      external_ids: { anilist: 30013, mal: 13 },
      titles: { native: 'ONE PIECE', romaji: 'ONE PIECE', english: 'One Piece' },
      synonyms: ['ワンピース'],
      tag: '[color]'
    };
    const written = buildMokuroMetadata(volume, [{ img_path: '1.jpg', blocks: [] }], {
      seriesMetadata
    });
    const file = new File([JSON.stringify(written)], 'Vol 1.mokuro');
    const parsed = await parseMokuroFile(file);
    expect(parsed.seriesMetadata).toEqual(written.series_metadata);
    expect(parsed.series).toBe('One Piece');
  });
});
```

In `src/lib/import/__tests__/database.test.ts` add after the `$lib/catalog/db` mock:

```ts
const upsertFromEmbedded = vi.fn();
vi.mock('$lib/metadata/store', () => ({
  upsertFromEmbedded: (...args: unknown[]) => upsertFromEmbedded(...args)
}));
```

and a new test inside the `saveVolume` describe block (copy the fixture-building style used by the neighbouring tests for `processed`; the important part is the assertion):

```ts
it('applies embedded series metadata after the volume is written', async () => {
  vi.mocked(db.transaction).mockImplementation(async (_m: any, _t: any, cb: any) => cb());
  vi.mocked(db.volumes.get).mockResolvedValue(undefined);
  vi.mocked(db.volume_ocr.get).mockResolvedValue(undefined);
  vi.mocked(db.volume_files.get).mockResolvedValue(undefined);
  const embedded = {
    external_ids: { anilist: 30013 },
    titles: {},
    synonyms: [],
    tag: '[color]',
    updated_at: '2026-08-16T00:00:00.000Z'
  };
  const processed = createProcessedVolume({
    metadata: { series: 'One Piece', seriesMetadata: embedded } as any
  });
  await saveVolume(processed);
  expect(upsertFromEmbedded).toHaveBeenCalledWith('One Piece', embedded);
});
```

(`createProcessedVolume` is the file's existing helper at line 44; it spreads `overrides.metadata` over the default `ProcessedMetadata`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/import`
Expected: FAIL — `seriesMetadata` undefined / `upsertFromEmbedded` not called.

- [ ] **Step 3: Implement parse + carry + apply**

`src/lib/import/processing.ts` — add import and field:

```ts
import { fromEmbedded } from '$lib/metadata/embed';
import type { EmbeddedSeriesMetadata } from '$lib/metadata/types';

export interface ParsedMokuro {
  version: string;
  series: string;
  seriesUuid: string;
  volume: string;
  volumeUuid: string;
  pages: MokuroPage[];
  chars: number;
  spineWidth?: number;
  /** Reader extension: series facts + tag embedded by mokuro-reader / mokuro-bunko */
  seriesMetadata?: EmbeddedSeriesMetadata;
}
```

In `parseMokuroFile`, before the `return`:

```ts
const seriesMetadata = fromEmbedded(obj.series_metadata);

return {
  version: obj.version as string,
  series: obj.title as string,
  seriesUuid: obj.title_uuid as string,
  volume: obj.volume as string,
  volumeUuid: obj.volume_uuid as string,
  pages: obj.pages as MokuroPage[],
  chars: (obj.chars as number) ?? 0,
  ...(obj.spine_width != null && { spineWidth: obj.spine_width as number }),
  ...(seriesMetadata && { seriesMetadata })
};
```

In the `ProcessedMetadata` literal near line 689 add `seriesMetadata: mokuroData?.seriesMetadata` after `spineWidth`.

`src/lib/import/types.ts` — in `ProcessedMetadata` add:

```ts
  /** Series facts + tag from the .mokuro `series_metadata` block (reader extension) */
  seriesMetadata?: import('$lib/metadata/types').EmbeddedSeriesMetadata;
```

`src/lib/import/database.ts` — import and apply after the transaction (before the thumbnail block):

```ts
import { upsertFromEmbedded } from '$lib/metadata/store';
```

```ts
// Series facts travel inside the .mokuro; apply them (newest wins) once the
// volume itself is committed. Never let this fail the import.
if (metadata.seriesMetadata) {
  try {
    await upsertFromEmbedded(volumeMetadata.series_title, metadata.seriesMetadata);
  } catch (error) {
    console.warn('Failed to apply embedded series metadata:', error);
  }
}
```

- [ ] **Step 4: Run tests + type check**

Run: `npx vitest run src/lib/import && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/import/processing.ts src/lib/import/types.ts src/lib/import/database.ts src/lib/import/__tests__/database.test.ts src/lib/import/__tests__/processing.test.ts src/lib/import/__tests__/series-metadata-roundtrip.test.ts
git commit -m "feat(import): read series_metadata from .mokuro and apply newest-wins"
```

---

### Task 7: AniList provider + link targets

**Files:**

- Create: `src/lib/metadata/provider-interface.ts`
- Create: `src/lib/metadata/providers/anilist.ts`
- Create: `src/lib/metadata/providers/anilist.test.ts`
- Create: `src/lib/metadata/link-targets.ts`
- Create: `src/lib/metadata/link-targets.test.ts`

**Interfaces:**

- Produces:
  - `MetadataSearchResult`, `MetadataProvider` (provider-interface.ts)
  - `AniListError` (`code: 'RATE_LIMITED' | 'UNAUTHORIZED' | 'NETWORK' | 'GRAPHQL'`, `retryAfterMs?: number`)
  - `anilistRequest<T>(query: string, variables?: Record<string, unknown>, token?: string | null, signal?: AbortSignal): Promise<T>` — Plan C reuses this for auth/mutations
  - `anilistProvider: MetadataProvider`
  - `toSeriesMetadataPatch(r: MetadataSearchResult): SeriesMetadataPatch`
  - `parseAniListIdInput(input: string): number | undefined`
  - `_resetRateGuardForTests(): void`
  - `getLinkTargets(ids: SeriesExternalIds): { provider: 'anilist' | 'mal'; label: string; url: string }[]`

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/metadata/providers/anilist.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AniListError,
  anilistProvider,
  anilistRequest,
  parseAniListIdInput,
  toSeriesMetadataPatch,
  _resetRateGuardForTests
} from './anilist';

const media = {
  id: 30013,
  idMal: 13,
  title: { romaji: 'ONE PIECE', english: 'One Piece', native: 'ONE PIECE' },
  synonyms: ['ワンピース', null],
  format: 'MANGA',
  status: 'RELEASING',
  chapters: null,
  volumes: null,
  startDate: { year: 1997 },
  coverImage: { medium: 'https://img/one-piece.jpg' },
  siteUrl: 'https://anilist.co/manga/30013'
};

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) }
  });
}

describe('anilist provider', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    _resetRateGuardForTests();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('search posts a GraphQL query and maps results', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { Page: { media: [media] } } }));
    const results = await anilistProvider.search('one piece');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://graphql.anilist.co');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body).variables).toEqual({ search: 'one piece' });
    expect(results).toEqual([
      {
        provider: 'anilist',
        id: 30013,
        idMal: 13,
        titles: { romaji: 'ONE PIECE', english: 'One Piece', native: 'ONE PIECE' },
        synonyms: ['ワンピース'],
        format: 'MANGA',
        status: 'RELEASING',
        year: 1997,
        coverUrl: 'https://img/one-piece.jpg',
        siteUrl: 'https://anilist.co/manga/30013'
      }
    ]);
  });

  it('search with a blank query returns [] without a request', async () => {
    expect(await anilistProvider.search('   ')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getById returns null on GraphQL not-found', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { Media: null }, errors: [{ message: 'Not Found.' }] }, { status: 404 })
    );
    expect(await anilistProvider.getById(1)).toBeNull();
  });

  it('sends the bearer token when given', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { Viewer: { id: 1 } } }));
    await anilistRequest('{ Viewer { id } }', {}, 'tok');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
  });

  it('maps 429 to RATE_LIMITED with Retry-After and blocks subsequent calls locally', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 429, headers: { 'Retry-After': '7' } }));
    await expect(anilistRequest('{ x }')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterMs: 7000
    });
    fetchMock.mockClear();
    await expect(anilistRequest('{ x }')).rejects.toBeInstanceOf(AniListError);
    expect(fetchMock).not.toHaveBeenCalled(); // guarded, no network
  });

  it('maps 401 to UNAUTHORIZED and fetch failure to NETWORK', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 401 }));
    await expect(anilistRequest('{ x }')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    fetchMock.mockRejectedValue(new TypeError('offline'));
    await expect(anilistRequest('{ x }')).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('toSeriesMetadataPatch maps a result to record fields', () => {
    const r = {
      provider: 'anilist' as const,
      id: 30013,
      idMal: 13,
      titles: { english: 'One Piece' },
      synonyms: ['ワンピース'],
      format: 'MANGA',
      status: 'RELEASING',
      volumes: 110,
      chapters: 1100,
      coverUrl: 'https://img/x.jpg',
      siteUrl: 'https://anilist.co/manga/30013'
    };
    expect(toSeriesMetadataPatch(r)).toEqual({
      external_ids: { anilist: 30013, mal: 13 },
      titles: { english: 'One Piece' },
      synonyms: ['ワンピース'],
      format: 'MANGA',
      status: 'RELEASING',
      total_volumes: 110,
      total_chapters: 1100,
      cover_url: 'https://img/x.jpg'
    });
    expect(
      Object.keys(toSeriesMetadataPatch({ ...r, idMal: undefined, volumes: undefined }))
    ).not.toContain('total_volumes');
  });

  it('parseAniListIdInput accepts a bare id or an anilist manga URL', () => {
    expect(parseAniListIdInput(' 30013 ')).toBe(30013);
    expect(parseAniListIdInput('https://anilist.co/manga/30013/ONE-PIECE/')).toBe(30013);
    expect(parseAniListIdInput('https://myanimelist.net/manga/13')).toBeUndefined();
    expect(parseAniListIdInput('one piece')).toBeUndefined();
  });
});
```

```ts
// src/lib/metadata/link-targets.test.ts
import { describe, expect, it } from 'vitest';
import { getLinkTargets } from './link-targets';

describe('getLinkTargets', () => {
  it('returns AniList and MAL links when ids are present, in that order', () => {
    expect(getLinkTargets({ anilist: 30013, mal: 13 })).toEqual([
      { provider: 'anilist', label: 'AniList', url: 'https://anilist.co/manga/30013' },
      { provider: 'mal', label: 'MyAnimeList', url: 'https://myanimelist.net/manga/13' }
    ]);
  });
  it('omits missing providers', () => {
    expect(getLinkTargets({ anilist: 1 })).toHaveLength(1);
    expect(getLinkTargets({})).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/metadata`
Expected: FAIL — cannot resolve `./providers/anilist` / `./link-targets`.

- [ ] **Step 3: Implement provider-interface, anilist, link-targets**

```ts
// src/lib/metadata/provider-interface.ts
import type { SeriesTitles } from './types';

export interface MetadataSearchResult {
  provider: 'anilist';
  id: number;
  idMal?: number;
  titles: SeriesTitles;
  synonyms: string[];
  format?: string;
  status?: string;
  year?: number;
  volumes?: number;
  chapters?: number;
  coverUrl?: string;
  siteUrl: string;
}

export interface MetadataProvider {
  id: 'anilist';
  search(query: string, signal?: AbortSignal): Promise<MetadataSearchResult[]>;
  getById(id: number): Promise<MetadataSearchResult | null>;
  siteUrl(id: number): string;
}
```

```ts
// src/lib/metadata/providers/anilist.ts
import type { MetadataProvider, MetadataSearchResult } from '../provider-interface';
import type { SeriesMetadataPatch } from '../store';

const ENDPOINT = 'https://graphql.anilist.co';

export type AniListErrorCode = 'RATE_LIMITED' | 'UNAUTHORIZED' | 'NETWORK' | 'GRAPHQL';

export class AniListError extends Error {
  constructor(
    public code: AniListErrorCode,
    message: string,
    public retryAfterMs?: number
  ) {
    super(message);
    this.name = 'AniListError';
  }
}

// ---- rate guard (30 req/min while AniList is degraded; honor server hints) ----
let blockedUntil = 0;
export function _resetRateGuardForTests(): void {
  blockedUntil = 0;
}

/**
 * POST a GraphQL document. Throws AniListError; never returns partial data.
 * `token` adds `Authorization: Bearer` (mutations / viewer queries — Plan C).
 */
export async function anilistRequest<T>(
  query: string,
  variables: Record<string, unknown> = {},
  token?: string | null,
  signal?: AbortSignal
): Promise<T> {
  const now = Date.now();
  if (now < blockedUntil) {
    throw new AniListError('RATE_LIMITED', 'AniList rate limit reached', blockedUntil - now);
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
      signal
    });
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    throw new AniListError('NETWORK', 'Could not reach AniList');
  }

  if (res.status === 429) {
    const retrySec = Number(res.headers.get('Retry-After') ?? '60');
    const retryAfterMs = (Number.isFinite(retrySec) ? retrySec : 60) * 1000;
    blockedUntil = Date.now() + retryAfterMs;
    throw new AniListError('RATE_LIMITED', 'AniList rate limit reached', retryAfterMs);
  }
  if (res.status === 401 || res.status === 403) {
    throw new AniListError('UNAUTHORIZED', 'AniList rejected the session');
  }

  const remaining = Number(res.headers.get('X-RateLimit-Remaining'));
  const resetEpoch = Number(res.headers.get('X-RateLimit-Reset'));
  if (remaining === 0 && Number.isFinite(resetEpoch) && resetEpoch > 0) {
    blockedUntil = resetEpoch * 1000;
  }

  let json: { data?: T; errors?: { message?: string }[] } | null = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (json?.errors?.length) {
    throw new AniListError('GRAPHQL', json.errors[0]?.message ?? 'AniList error');
  }
  if (!res.ok || !json?.data) {
    throw new AniListError('NETWORK', `AniList HTTP ${res.status}`);
  }
  return json.data;
}

// ---- queries ----
const MEDIA_FIELDS = `
  id idMal
  title { romaji english native }
  synonyms format status chapters volumes
  startDate { year }
  coverImage { medium }
  siteUrl`;

const SEARCH_QUERY = `query ($search: String) {
  Page(perPage: 10) {
    media(search: $search, type: MANGA, sort: SEARCH_MATCH) { ${MEDIA_FIELDS} }
  }
}`;

const BY_ID_QUERY = `query ($id: Int) {
  Media(id: $id, type: MANGA) { ${MEDIA_FIELDS} }
}`;

interface RawMedia {
  id: number;
  idMal: number | null;
  title: { romaji: string | null; english: string | null; native: string | null };
  synonyms: (string | null)[] | null;
  format: string | null;
  status: string | null;
  chapters: number | null;
  volumes: number | null;
  startDate: { year: number | null } | null;
  coverImage: { medium: string | null } | null;
  siteUrl: string;
}

function toResult(m: RawMedia): MetadataSearchResult {
  const titles: MetadataSearchResult['titles'] = {};
  if (m.title?.native) titles.native = m.title.native;
  if (m.title?.romaji) titles.romaji = m.title.romaji;
  if (m.title?.english) titles.english = m.title.english;
  const out: MetadataSearchResult = {
    provider: 'anilist',
    id: m.id,
    titles,
    synonyms: (m.synonyms ?? []).filter(
      (s): s is string => typeof s === 'string' && s.trim() !== ''
    ),
    siteUrl: m.siteUrl || `https://anilist.co/manga/${m.id}`
  };
  if (m.idMal != null) out.idMal = m.idMal;
  if (m.format) out.format = m.format;
  if (m.status) out.status = m.status;
  if (m.startDate?.year != null) out.year = m.startDate.year;
  if (m.volumes != null) out.volumes = m.volumes;
  if (m.chapters != null) out.chapters = m.chapters;
  if (m.coverImage?.medium) out.coverUrl = m.coverImage.medium;
  return out;
}

export const anilistProvider: MetadataProvider = {
  id: 'anilist',
  async search(query, signal) {
    const search = query.trim();
    if (!search) return [];
    const data = await anilistRequest<{ Page: { media: RawMedia[] } }>(
      SEARCH_QUERY,
      { search },
      null,
      signal
    );
    return (data.Page?.media ?? []).map(toResult);
  },
  async getById(id) {
    try {
      const data = await anilistRequest<{ Media: RawMedia | null }>(BY_ID_QUERY, { id });
      return data.Media ? toResult(data.Media) : null;
    } catch (error) {
      if (error instanceof AniListError && error.code === 'GRAPHQL') return null;
      throw error;
    }
  },
  siteUrl(id) {
    return `https://anilist.co/manga/${id}`;
  }
};

/** Fields to write into the SeriesMetadata record when the user picks a result. */
export function toSeriesMetadataPatch(r: MetadataSearchResult): SeriesMetadataPatch {
  const patch: SeriesMetadataPatch = {
    external_ids: r.idMal != null ? { anilist: r.id, mal: r.idMal } : { anilist: r.id },
    titles: { ...r.titles },
    synonyms: [...r.synonyms]
  };
  if (r.format) patch.format = r.format;
  if (r.status) patch.status = r.status;
  if (r.volumes != null) patch.total_volumes = r.volumes;
  if (r.chapters != null) patch.total_chapters = r.chapters;
  if (r.coverUrl) patch.cover_url = r.coverUrl;
  return patch;
}

/** "30013" or "https://anilist.co/manga/30013/One-Piece/" → 30013 */
export function parseAniListIdInput(input: string): number | undefined {
  const s = input.trim();
  if (/^\d+$/.test(s)) return Number(s);
  const m = s.match(/anilist\.co\/manga\/(\d+)/i);
  return m ? Number(m[1]) : undefined;
}
```

```ts
// src/lib/metadata/link-targets.ts
import type { SeriesExternalIds } from './types';

export interface LinkTarget {
  provider: 'anilist' | 'mal';
  label: string;
  url: string;
}

/** Outbound links for the known external ids (MAL is link-out only: no browser-callable API). */
export function getLinkTargets(ids: SeriesExternalIds): LinkTarget[] {
  const out: LinkTarget[] = [];
  if (ids.anilist != null) {
    out.push({
      provider: 'anilist',
      label: 'AniList',
      url: `https://anilist.co/manga/${ids.anilist}`
    });
  }
  if (ids.mal != null) {
    out.push({
      provider: 'mal',
      label: 'MyAnimeList',
      url: `https://myanimelist.net/manga/${ids.mal}`
    });
  }
  return out;
}
```

- [ ] **Step 4: Run tests + type check**

Run: `npx vitest run src/lib/metadata && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/metadata/provider-interface.ts src/lib/metadata/providers/anilist.ts src/lib/metadata/providers/anilist.test.ts src/lib/metadata/link-targets.ts src/lib/metadata/link-targets.test.ts
git commit -m "feat(metadata): AniList provider (search/getById, rate guard) + link targets"
```

---

### Task 8: `series-metadata.json` cloud sync

**Files:**

- Modify: `src/lib/util/sync/syncable-file.ts:16` + doc comment
- Modify: `src/lib/util/sync/syncable-file.test.ts` (root config test)
- Modify: `src/lib/util/sync/unified-sync-service.ts` (imports; `syncProvider` ~line 204; new private methods next to the profiles ones)
- Modify: `src/lib/util/sync/unified-sync-service.test.ts` (store mock + tests)

**Interfaces:**

- Consumes: `getAllSeriesMetadata`, `replaceAllSeriesMetadata` (Task 2), `mergeSeriesMetadata` (Task 3).
- Produces: root file `series-metadata.json` = `{ version: 1, series: Record<string, SeriesMetadata> }`; `private async syncSeriesMetadata(provider: SyncProvider): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

In `src/lib/util/sync/syncable-file.test.ts` extend the root-config test:

```ts
it('accepts the root config files', () => {
  expect(isSyncableFile('volume-data.json')).toBe(true);
  expect(isSyncableFile('profiles.json')).toBe(true);
  expect(isSyncableFile('series-metadata.json')).toBe(true);
  expect(isRootConfigFile('SERIES-METADATA.JSON')).toBe(true);
});
```

In `src/lib/util/sync/unified-sync-service.test.ts` add the store mock after the `$lib/settings` mock and a new describe block at the end:

```ts
const localSeries: Record<string, any> = {};
const replaceAll = vi.fn(async (records: Record<string, any>) => {
  for (const [k, v] of Object.entries(records)) localSeries[k] = v;
});
vi.mock('$lib/metadata/store', () => ({
  getAllSeriesMetadata: vi.fn(async () => ({ ...localSeries })),
  replaceAllSeriesMetadata: (records: Record<string, any>) => replaceAll(records)
}));
```

```ts
describe('syncSeriesMetadata — series-metadata.json', () => {
  const rec = (key: string, updated_at: string, tag: string) => ({
    series_key: key,
    series_title: key,
    external_ids: {},
    titles: {},
    synonyms: [],
    tag,
    read_count: 0,
    updated_at
  });

  beforeEach(() => {
    for (const k of Object.keys(localSeries)) delete localSeries[k];
    replaceAll.mockClear();
    getCache.mockReset();
  });

  it('merges newest-wins into local and uploads when the merged set differs from the cloud', async () => {
    localSeries.a = rec('a', '2026-03-01T00:00:00.000Z', 'local-newer');
    localSeries.b = rec('b', '2026-01-01T00:00:00.000Z', 'local-only');
    const cloud = {
      version: 1,
      series: {
        a: rec('a', '2026-02-01T00:00:00.000Z', 'cloud-older'),
        c: rec('c', '2026-02-01T00:00:00.000Z', 'cloud-only')
      }
    };
    const file = {
      provider: 'mega',
      fileId: 'sm',
      path: 'series-metadata.json'
    } as unknown as CloudFileMetadata;
    getCache.mockReturnValue({ get: (p: string) => (p === 'series-metadata.json' ? file : null) });
    const uploadFile = vi.fn(async () => 'id');
    const provider = {
      type: 'mega',
      downloadFile: vi.fn(async () => jsonBlob(cloud)),
      uploadFile
    } as unknown as SyncProvider;

    await svc.syncSeriesMetadata(provider);

    expect(localSeries.a.tag).toBe('local-newer');
    expect(localSeries.c.tag).toBe('cloud-only');
    expect(uploadFile).toHaveBeenCalledTimes(1);
    const [path, blob] = uploadFile.mock.calls[0];
    expect(path).toBe('series-metadata.json');
    const uploaded = JSON.parse(await (blob as Blob).text());
    expect(uploaded.version).toBe(1);
    expect(Object.keys(uploaded.series).sort()).toEqual(['a', 'b', 'c']);
  });

  it('uploads local records when the cloud has no file yet', async () => {
    localSeries.a = rec('a', '2026-03-01T00:00:00.000Z', 'x');
    getCache.mockReturnValue({ get: () => null });
    const uploadFile = vi.fn(async () => 'id');
    const provider = { type: 'mega', downloadFile: vi.fn(), uploadFile } as unknown as SyncProvider;
    await svc.syncSeriesMetadata(provider);
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(replaceAll).not.toHaveBeenCalled();
  });

  it('does nothing when both sides are empty', async () => {
    getCache.mockReturnValue({ get: () => null });
    const uploadFile = vi.fn();
    const provider = { type: 'mega', downloadFile: vi.fn(), uploadFile } as unknown as SyncProvider;
    await svc.syncSeriesMetadata(provider);
    expect(uploadFile).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/util/sync/syncable-file.test.ts src/lib/util/sync/unified-sync-service.test.ts`
Expected: FAIL — `series-metadata.json` not syncable; `svc.syncSeriesMetadata is not a function`.

- [ ] **Step 3: Implement**

`src/lib/util/sync/syncable-file.ts`:

```ts
 * - Root config files: volume-data.json (read progress), profiles.json
 *   (settings profiles), series-metadata.json (per-series AniList link,
 *   titles, tag, tracking)
```

```ts
const ROOT_CONFIG_FILENAMES = new Set([
  'volume-data.json',
  'profiles.json',
  'series-metadata.json'
]);
```

`src/lib/util/sync/unified-sync-service.ts` — imports:

```ts
import { getAllSeriesMetadata, replaceAllSeriesMetadata } from '$lib/metadata/store';
import { mergeSeriesMetadata } from '$lib/metadata/merge';
import type { SeriesMetadata } from '$lib/metadata/types';
```

In `syncProvider`, right after `console.log('✅ Volume data synced');`:

```ts
// Series metadata (AniList link / titles / tag / tracking). Non-fatal:
// a failure here must not fail progress sync.
try {
  await this.syncSeriesMetadata(provider);
  console.log('✅ Series metadata synced');
} catch (error) {
  console.warn('⚠️ Series metadata sync failed:', error);
}
```

New private methods (place after `syncProfiles`):

```ts
  private findSeriesMetadataFile(provider: SyncProvider): CloudFileMetadata | null {
    const cache = cacheManager.getCache(provider.type);
    return cache?.get('series-metadata.json') ?? null;
  }

  private async downloadSeriesMetadataFile(
    provider: SyncProvider
  ): Promise<Record<string, SeriesMetadata> | null> {
    const file = this.findSeriesMetadataFile(provider);
    if (!file) return null;
    try {
      const blob = await provider.downloadFile(file);
      const json = await this.blobToJson(blob);
      const series = json && typeof json === 'object' ? (json as { series?: unknown }).series : null;
      return series && typeof series === 'object' ? (series as Record<string, SeriesMetadata>) : {};
    } catch (error) {
      if (this.isFileNotFoundError(error)) return null;
      throw error;
    }
  }

  private async uploadSeriesMetadataFile(
    provider: SyncProvider,
    series: Record<string, SeriesMetadata>
  ): Promise<void> {
    await provider.uploadFile('series-metadata.json', this.jsonToBlob({ version: 1, series }));
  }

  /** Download → newest-wins merge → write table if changed → upload if changed. */
  private async syncSeriesMetadata(provider: SyncProvider): Promise<void> {
    const cloud = await this.downloadSeriesMetadataFile(provider);
    const local = await getAllSeriesMetadata();
    const merged = mergeSeriesMetadata(local, cloud ?? {});

    const localJson = JSON.stringify(local);
    const cloudJson = JSON.stringify(cloud ?? {});
    const mergedJson = JSON.stringify(merged);

    if (mergedJson !== localJson) {
      await replaceAllSeriesMetadata(merged);
    }
    if (Object.keys(merged).length > 0 && mergedJson !== cloudJson) {
      await this.uploadSeriesMetadataFile(provider, merged);
    }
  }
```

(`isFileNotFoundError` already exists at line ~402 of the service; reuse it.)

- [ ] **Step 4: Run tests + type check**

Run: `npx vitest run src/lib/util/sync && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/util/sync/syncable-file.ts src/lib/util/sync/syncable-file.test.ts src/lib/util/sync/unified-sync-service.ts src/lib/util/sync/unified-sync-service.test.ts
git commit -m "feat(sync): series-metadata.json root file, newest-wins merge on every provider"
```

---

### Task 9: `refreshVolumeSidecar` / `refreshSeriesSidecars` on the cloud manager

**Files:**

- Modify: `src/lib/util/sync/unified-cloud-manager.ts` (add two public methods after `renameSeries`)
- Modify: `src/lib/util/sync/unified-cloud-manager.test.ts` (new describe block)

**Interfaces:**

- Consumes: `generateVolumeSidecarsFromDb` (existing), `assertWritable`, `getManagedCloudFilesForVolume`, `uploadFile`, `deleteFileIdempotent`, `isMokuroSidecarPath`, `normalizeCloudPath` (all existing in the file).
- Produces: `refreshVolumeSidecar(seriesTitle: string, volumeTitle: string, volumeUuid: string): Promise<void>`; `refreshSeriesSidecars(seriesTitle: string, volumes: { volumeUuid: string; volumeTitle: string }[]): Promise<{ succeeded: number; failed: number; skipped: number }>`.

- [ ] **Step 1: Write the failing tests** — append to `unified-cloud-manager.test.ts`:

```ts
describe('UnifiedCloudManager sidecar refresh', () => {
  beforeEach(() => vi.clearAllMocks());

  it('re-uploads a regenerated .mokuro in place for backed-up volumes and skips un-backed-up ones', async () => {
    const cache = { removeById: vi.fn(), add: vi.fn() };
    const provider = makeRenameProvider();
    const files = oldSeriesFiles(); // Old Series/Volume 1.{cbz,mokuro,webp}
    getActiveProvider.mockReturnValue(provider);
    getBySeries.mockImplementation((s: string) => files.filter((f) => f.path.startsWith(`${s}/`)));
    getCache.mockReturnValue(cache);
    generateSidecars.mockResolvedValue({
      mokuro: { filename: 'Volume 1.mokuro', blob: new Blob(['{"series_metadata":{}}']) }
    });

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    const result = await unifiedCloudManager.refreshSeriesSidecars('Old Series', [
      { volumeUuid: 'uuid-1', volumeTitle: 'Volume 1' },
      { volumeUuid: 'uuid-2', volumeTitle: 'Volume 2' } // not in cloud
    ]);

    expect(generateSidecars).toHaveBeenCalledTimes(1);
    expect(generateSidecars).toHaveBeenCalledWith('uuid-1');
    expect(provider.uploadFile).toHaveBeenCalledWith(
      'Old Series/Volume 1.mokuro',
      expect.any(Blob),
      undefined,
      undefined
    );
    expect(provider.renameFile).not.toHaveBeenCalled();
    expect(provider.deleteFile).not.toHaveBeenCalled(); // same path → nothing stale
    expect(result).toEqual({ succeeded: 1, failed: 0, skipped: 1 });
  });

  it('replaces a legacy .mokuro.gz sidecar with the fresh .mokuro', async () => {
    const provider = makeRenameProvider();
    const files: CloudFileMetadata[] = [
      { provider: 'webdav', fileId: 'cbz', path: 'S/V.cbz', modifiedTime: 't', size: 1 },
      { provider: 'webdav', fileId: 'gz', path: 'S/V.mokuro.gz', modifiedTime: 't', size: 1 }
    ];
    getActiveProvider.mockReturnValue(provider);
    getBySeries.mockImplementation((s: string) => files.filter((f) => f.path.startsWith(`${s}/`)));
    getCache.mockReturnValue({ removeById: vi.fn(), add: vi.fn() });
    generateSidecars.mockResolvedValue({
      mokuro: { filename: 'V.mokuro', blob: new Blob(['{}']) }
    });

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await unifiedCloudManager.refreshVolumeSidecar('S', 'V', 'u');
    expect(provider.uploadFile).toHaveBeenCalledWith(
      'S/V.mokuro',
      expect.any(Blob),
      undefined,
      undefined
    );
    expect(provider.deleteFile).toHaveBeenCalledWith(files[1]);
  });

  it('throws READ_ONLY on a read-only provider before touching the cloud', async () => {
    const provider = makeRenameProvider({ getStatus: vi.fn(() => ({ isReadOnly: true })) });
    getActiveProvider.mockReturnValue(provider);
    getBySeries.mockReturnValue(oldSeriesFiles());
    getCache.mockReturnValue({ removeById: vi.fn(), add: vi.fn() });
    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await expect(
      unifiedCloudManager.refreshSeriesSidecars('Old Series', [
        { volumeUuid: 'uuid-1', volumeTitle: 'Volume 1' }
      ])
    ).rejects.toMatchObject({ code: 'READ_ONLY' });
    expect(provider.uploadFile).not.toHaveBeenCalled();
  });

  it('counts a per-volume failure and keeps going', async () => {
    const provider = makeRenameProvider();
    const files = oldSeriesFiles();
    getActiveProvider.mockReturnValue(provider);
    getBySeries.mockImplementation((s: string) => files.filter((f) => f.path.startsWith(`${s}/`)));
    getCache.mockReturnValue({ removeById: vi.fn(), add: vi.fn() });
    generateSidecars.mockResolvedValue({}); // no OCR → cannot regenerate
    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    const result = await unifiedCloudManager.refreshSeriesSidecars('Old Series', [
      { volumeUuid: 'uuid-1', volumeTitle: 'Volume 1' }
    ]);
    expect(result).toEqual({ succeeded: 0, failed: 1, skipped: 0 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/util/sync/unified-cloud-manager.test.ts`
Expected: FAIL — `refreshSeriesSidecars is not a function`.

- [ ] **Step 3: Implement** — add after `renameSeries(...)` in `unified-cloud-manager.ts`:

```ts
  /**
   * Regenerate ONE backed-up volume's .mokuro from the DB (embedding current
   * series metadata) and overwrite it in place. Assumes the caller refreshed
   * the cache and checked write access. Legacy `.mokuro.gz` sidecars are
   * replaced by the fresh `.mokuro` (upload first, delete stale last).
   */
  async refreshVolumeSidecar(
    seriesTitle: string,
    volumeTitle: string,
    volumeUuid: string
  ): Promise<void> {
    const provider = this.getActiveProvider();
    if (!provider) {
      throw new Error('No cloud provider authenticated');
    }
    this.assertWritable(provider);

    const sidecars = await generateVolumeSidecarsFromDb(volumeUuid);
    if (!sidecars.mokuro) {
      throw new ProviderError(
        'Cannot refresh sidecar: the OCR sidecar could not be regenerated (volume_ocr data missing)',
        provider.type,
        'SIDECAR_REGEN_FAILED'
      );
    }

    const targetPath = normalizeCloudPath(`${seriesTitle}/${volumeTitle}.mokuro`);
    await this.uploadFile(targetPath, sidecars.mokuro.blob);

    // Destructive last: drop stale sidecars at OTHER paths (e.g. `.mokuro.gz`).
    for (const file of this.getManagedCloudFilesForVolume(seriesTitle, volumeTitle)) {
      if (!isMokuroSidecarPath(file.path)) continue;
      if (normalizeCloudPath(file.path) === targetPath) continue;
      await this.deleteFileIdempotent(file);
    }
  }

  /**
   * Refresh the .mokuro of every BACKED-UP volume of a series (volumes with no
   * managed cloud files are skipped — nothing to refresh). Per-volume failures
   * are counted, not thrown; pre-flight gates (no provider / read-only) throw.
   */
  async refreshSeriesSidecars(
    seriesTitle: string,
    volumes: { volumeUuid: string; volumeTitle: string }[]
  ): Promise<{ succeeded: number; failed: number; skipped: number }> {
    const provider = this.getActiveProvider();
    if (!provider) {
      throw new Error('No cloud provider authenticated');
    }
    await this.fetchAllCloudVolumes();
    this.assertWritable(provider);

    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    for (const volume of volumes) {
      if (this.getManagedCloudFilesForVolume(seriesTitle, volume.volumeTitle).length === 0) {
        skipped++;
        continue;
      }
      try {
        await this.refreshVolumeSidecar(seriesTitle, volume.volumeTitle, volume.volumeUuid);
        succeeded++;
      } catch (error) {
        console.error(`Failed to refresh sidecar for ${seriesTitle}/${volume.volumeTitle}:`, error);
        failed++;
      }
    }
    return { succeeded, failed, skipped };
  }
```

If `assertWritable`'s message ("Cannot rename: …") reads wrong for this path, leave it — the UI maps `READ_ONLY` to its own copy.

- [ ] **Step 4: Run tests + type check**

Run: `npx vitest run src/lib/util/sync/unified-cloud-manager.test.ts && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/util/sync/unified-cloud-manager.ts src/lib/util/sync/unified-cloud-manager.test.ts
git commit -m "feat(sync): refresh backed-up .mokuro sidecars in place"
```

---

### Task 10: Rename migrates the metadata record

**Files:**

- Modify: `src/lib/util/series-rename.ts:169-249` (`executeRenameSeries`)
- Modify: `src/lib/util/series-rename.test.ts` (store mock + test)

**Interfaces:**

- Consumes: `moveSeriesMetadataKey` (Task 2).

- [ ] **Step 1: Write the failing test** — add mock after the existing `vi.mock('$lib/util/sync/unified-cloud-manager', …)`:

```ts
const moveSeriesMetadataKey = vi.fn();
vi.mock('$lib/metadata/store', () => ({
  moveSeriesMetadataKey: (...args: unknown[]) => moveSeriesMetadataKey(...args)
}));
```

and a test inside the existing describe (mirror the mocking style of the file's `executeRenameSeries` tests: `db.volumes.where(...).toArray()` returns one volume, `get` from `svelte/store` returns `{}` for the volumes store, `unifiedCloudManager.renameSeries` resolves `{ renamedVolumeUuids: ['vol-1'], failures: [] }`):

```ts
it('moves the series metadata record to the new title after a successful rename', async () => {
  const { db } = await import('$lib/catalog/db');
  const { get } = await import('svelte/store');
  const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
  vi.mocked(db.volumes.where).mockReturnValue({
    toArray: vi.fn().mockResolvedValue([
      {
        volume_uuid: 'vol-1',
        series_uuid: 'series-1',
        series_title: 'Old Series',
        volume_title: 'V1'
      }
    ])
  } as any);
  vi.mocked(get).mockReturnValue({});
  vi.mocked(unifiedCloudManager.renameSeries).mockResolvedValue({
    renamedVolumeUuids: ['vol-1'],
    failures: []
  } as any);

  await executeRenameSeries('Old Series', 'New Series');
  expect(moveSeriesMetadataKey).toHaveBeenCalledWith('Old Series', 'New Series');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/util/series-rename.test.ts`
Expected: FAIL — `moveSeriesMetadataKey` not called.

- [ ] **Step 3: Implement** — in `executeRenameSeries`, after the localStorage commit loop and before the `return { finalTitle, … }`:

```ts
// Carry the per-series metadata (AniList link, tag, …) to the new key.
// Non-fatal: the rename itself already succeeded.
if (renamedSet.size > 0) {
  try {
    const { moveSeriesMetadataKey } = await import('$lib/metadata/store');
    await moveSeriesMetadataKey(oldTitle, newTitle);
  } catch (error) {
    console.warn('Failed to move series metadata after rename:', error);
  }
}
```

- [ ] **Step 4: Run tests + type check**

Run: `npx vitest run src/lib/util/series-rename.test.ts && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/util/series-rename.ts src/lib/util/series-rename.test.ts
git commit -m "feat(metadata): series rename carries the metadata record to the new key"
```

---

### Task 11: Debounced link search controller + `SeriesLinkModal`

**Files:**

- Create: `src/lib/metadata/link-search.ts`
- Create: `src/lib/metadata/link-search.test.ts`
- Create: `src/lib/components/Series/SeriesLinkModal.svelte`

**Interfaces:**

- Consumes: `anilistProvider`, `AniListError`, `toSeriesMetadataPatch`, `parseAniListIdInput` (Task 7), `updateSeriesMetadata` (Task 2), `showSnackbar` (`$lib/util`).
- Produces: `createLinkSearch(opts: { provider: MetadataProvider; debounceMs?: number; onResults: (r: MetadataSearchResult[]) => void; onError: (message: string) => void; onLoading: (loading: boolean) => void }): { setQuery(q: string): void; cancel(): void }`; component `SeriesLinkModal` props `{ open: boolean (bindable); seriesTitle: string; onLinked?: () => void }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/metadata/link-search.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLinkSearch } from './link-search';
import type { MetadataProvider, MetadataSearchResult } from './provider-interface';
import { AniListError } from './providers/anilist';

const result = (id: number): MetadataSearchResult => ({
  provider: 'anilist',
  id,
  titles: { romaji: `R${id}` },
  synonyms: [],
  siteUrl: `https://anilist.co/manga/${id}`
});

describe('createLinkSearch', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function makeProvider(impl: MetadataProvider['search']): MetadataProvider {
    return { id: 'anilist', search: vi.fn(impl), getById: vi.fn(), siteUrl: (id) => `u${id}` };
  }

  it('debounces and only searches the latest query', async () => {
    const provider = makeProvider(async (q) => [result(q.length)]);
    const onResults = vi.fn();
    const search = createLinkSearch({
      provider,
      debounceMs: 300,
      onResults,
      onError: vi.fn(),
      onLoading: vi.fn()
    });
    search.setQuery('o');
    search.setQuery('on');
    search.setQuery('one');
    await vi.advanceTimersByTimeAsync(299);
    expect(provider.search).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.search).toHaveBeenCalledTimes(1);
    expect(provider.search).toHaveBeenCalledWith('one', expect.any(AbortSignal));
    expect(onResults).toHaveBeenCalledWith([result(3)]);
  });

  it('aborts the in-flight request when a newer query arrives and ignores its result', async () => {
    let firstSignal: AbortSignal | undefined;
    const provider = makeProvider(async (q, signal) => {
      if (q === 'first') {
        firstSignal = signal;
        return new Promise((resolve) => setTimeout(() => resolve([result(1)]), 1000));
      }
      return [result(2)];
    });
    const onResults = vi.fn();
    const search = createLinkSearch({
      provider,
      debounceMs: 0,
      onResults,
      onError: vi.fn(),
      onLoading: vi.fn()
    });
    search.setQuery('first');
    await vi.advanceTimersByTimeAsync(0);
    search.setQuery('second');
    await vi.advanceTimersByTimeAsync(0);
    expect(firstSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onResults).toHaveBeenCalledTimes(1);
    expect(onResults).toHaveBeenCalledWith([result(2)]);
  });

  it('reports rate-limit and network errors as messages, and clears results on blank query', async () => {
    const provider = makeProvider(async () => {
      throw new AniListError('RATE_LIMITED', 'AniList rate limit reached', 5000);
    });
    const onError = vi.fn();
    const onResults = vi.fn();
    const search = createLinkSearch({
      provider,
      debounceMs: 0,
      onResults,
      onError,
      onLoading: vi.fn()
    });
    search.setQuery('x');
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/rate limit/i));
    search.setQuery('   ');
    await vi.advanceTimersByTimeAsync(0);
    expect(onResults).toHaveBeenLastCalledWith([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/metadata/link-search.test.ts`
Expected: FAIL — cannot resolve `./link-search`.

- [ ] **Step 3: Implement the controller**

```ts
// src/lib/metadata/link-search.ts
import type { MetadataProvider, MetadataSearchResult } from './provider-interface';
import { AniListError } from './providers/anilist';

export interface LinkSearchOptions {
  provider: MetadataProvider;
  debounceMs?: number;
  onResults: (results: MetadataSearchResult[]) => void;
  onError: (message: string) => void;
  onLoading: (loading: boolean) => void;
}

export function describeSearchError(error: unknown): string {
  if (error instanceof AniListError) {
    switch (error.code) {
      case 'RATE_LIMITED': {
        const sec = Math.max(1, Math.ceil((error.retryAfterMs ?? 60000) / 1000));
        return `AniList rate limit reached — try again in ${sec}s`;
      }
      case 'NETWORK':
        return 'Could not reach AniList. Check your connection.';
      case 'UNAUTHORIZED':
        return 'AniList rejected the request.';
      default:
        return error.message;
    }
  }
  return 'Search failed.';
}

/** Debounced, abortable search: only the latest query's results are delivered. */
export function createLinkSearch(opts: LinkSearchOptions) {
  const debounceMs = opts.debounceMs ?? 300;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  let seq = 0;

  function cancel() {
    if (timer) clearTimeout(timer);
    timer = null;
    controller?.abort();
    controller = null;
  }

  async function run(query: string) {
    const mySeq = ++seq;
    controller?.abort();
    const myController = new AbortController();
    controller = myController;
    opts.onLoading(true);
    try {
      const results = await opts.provider.search(query, myController.signal);
      if (mySeq !== seq || myController.signal.aborted) return;
      opts.onResults(results);
    } catch (error) {
      if (mySeq !== seq || myController.signal.aborted) return;
      opts.onError(describeSearchError(error));
    } finally {
      if (mySeq === seq) opts.onLoading(false);
    }
  }

  function setQuery(query: string) {
    if (timer) clearTimeout(timer);
    const q = query.trim();
    if (!q) {
      seq++;
      controller?.abort();
      controller = null;
      opts.onLoading(false);
      opts.onResults([]);
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      void run(q);
    }, debounceMs);
  }

  return { setQuery, cancel };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/metadata/link-search.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the modal**

```svelte
<!-- src/lib/components/Series/SeriesLinkModal.svelte -->
<script lang="ts">
  import { Button, Modal, Input, Spinner } from 'flowbite-svelte';
  import { onDestroy } from 'svelte';
  import { showSnackbar } from '$lib/util';
  import {
    anilistProvider,
    parseAniListIdInput,
    toSeriesMetadataPatch
  } from '$lib/metadata/providers/anilist';
  import { createLinkSearch, describeSearchError } from '$lib/metadata/link-search';
  import { updateSeriesMetadata } from '$lib/metadata/store';
  import type { MetadataSearchResult } from '$lib/metadata/provider-interface';

  let {
    open = $bindable(false),
    seriesTitle,
    onLinked
  }: { open?: boolean; seriesTitle: string; onLinked?: () => void } = $props();

  let query = $state('');
  let idInput = $state('');
  let results = $state<MetadataSearchResult[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let linking = $state(false);

  const search = createLinkSearch({
    provider: anilistProvider,
    onResults: (r) => {
      results = r;
      error = null;
    },
    onError: (message) => {
      error = message;
      results = [];
    },
    onLoading: (l) => (loading = l)
  });
  onDestroy(() => search.cancel());

  // Prefill and search when the modal opens
  $effect(() => {
    if (open) {
      query = seriesTitle;
      idInput = '';
      error = null;
      search.setQuery(seriesTitle);
    } else {
      search.cancel();
      results = [];
    }
  });

  function onQueryInput(e: Event) {
    query = (e.currentTarget as HTMLInputElement).value;
    search.setQuery(query);
  }

  function primaryTitle(r: MetadataSearchResult): string {
    return r.titles.romaji ?? r.titles.english ?? r.titles.native ?? `#${r.id}`;
  }
  function secondaryTitles(r: MetadataSearchResult): string {
    const primary = primaryTitle(r);
    return [r.titles.native, r.titles.english]
      .filter((t): t is string => !!t && t !== primary)
      .join(' · ');
  }
  function detailLine(r: MetadataSearchResult): string {
    const parts = [r.format, r.year != null ? String(r.year) : null, r.status];
    if (r.volumes != null) parts.push(`${r.volumes} vols`);
    else if (r.chapters != null) parts.push(`${r.chapters} ch`);
    return parts.filter(Boolean).join(' · ');
  }

  async function link(result: MetadataSearchResult) {
    linking = true;
    try {
      await updateSeriesMetadata(seriesTitle, {
        ...toSeriesMetadataPatch(result),
        linked_at: new Date().toISOString()
      });
      showSnackbar(`Linked to AniList: ${primaryTitle(result)}`);
      onLinked?.();
      open = false;
    } catch (e) {
      console.error('Failed to save series link:', e);
      error = 'Could not save the link.';
    } finally {
      linking = false;
    }
  }

  async function linkById() {
    const id = parseAniListIdInput(idInput);
    if (id == null) {
      error = 'Enter an AniList manga ID or URL (e.g. https://anilist.co/manga/30013)';
      return;
    }
    loading = true;
    error = null;
    try {
      const result = await anilistProvider.getById(id);
      if (!result) {
        error = `No AniList manga with id ${id}`;
        return;
      }
      await link(result);
    } catch (e) {
      error = describeSearchError(e);
    } finally {
      loading = false;
    }
  }
</script>

<Modal bind:open size="md" title="Link to AniList" outsideclose>
  <div class="flex flex-col gap-3">
    <Input value={query} oninput={onQueryInput} placeholder="Search AniList…" autofocus />

    {#if loading}
      <div class="flex items-center gap-2 text-sm text-gray-500">
        <Spinner size="4" /> Searching…
      </div>
    {/if}
    {#if error}
      <p class="text-sm text-red-500">{error}</p>
    {/if}

    {#if results.length > 0}
      <ul
        class="max-h-80 divide-y divide-gray-200 overflow-y-auto rounded-lg border border-gray-200 dark:divide-gray-700 dark:border-gray-700"
      >
        {#each results as r (r.id)}
          <li>
            <button
              type="button"
              class="flex w-full items-center gap-3 p-2 text-left hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-gray-700"
              disabled={linking}
              onclick={() => link(r)}
            >
              {#if r.coverUrl}
                <img
                  src={r.coverUrl}
                  alt=""
                  class="h-16 w-11 flex-shrink-0 rounded object-cover"
                  loading="lazy"
                />
              {:else}
                <div class="h-16 w-11 flex-shrink-0 rounded bg-gray-200 dark:bg-gray-600"></div>
              {/if}
              <div class="min-w-0 flex-1">
                <div class="truncate font-medium">{primaryTitle(r)}</div>
                {#if secondaryTitles(r)}
                  <div class="truncate text-sm text-gray-500 dark:text-gray-400">
                    {secondaryTitles(r)}
                  </div>
                {/if}
                <div class="text-xs text-gray-400">{detailLine(r)}</div>
              </div>
            </button>
          </li>
        {/each}
      </ul>
    {:else if !loading && !error && query.trim()}
      <p class="text-sm text-gray-500">No results.</p>
    {/if}

    <div class="flex items-center gap-2 pt-2">
      <Input bind:value={idInput} placeholder="…or paste an AniList URL / ID" class="flex-1" />
      <Button size="sm" color="light" onclick={linkById} disabled={loading || linking}
        >Link by ID</Button
      >
    </div>
  </div>

  <!-- relative z-10: night-mode filter on <dialog> creates a stacking context -->
  <div class="relative z-10 flex justify-end gap-2 pt-2">
    <Button color="alternative" onclick={() => (open = false)} disabled={linking}>Cancel</Button>
  </div>
</Modal>
```

- [ ] **Step 6: Type check**

Run: `npm run check`
Expected: 0 errors. (Manual browser verification of the modal happens in Task 13.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/metadata/link-search.ts src/lib/metadata/link-search.test.ts src/lib/components/Series/SeriesLinkModal.svelte
git commit -m "feat(metadata): AniList link modal with debounced, abortable search"
```

---

### Task 12: `SeriesMetadataBar` + mount in `SeriesView`

**Files:**

- Create: `src/lib/components/Series/SeriesMetadataBar.svelte`
- Create: `src/lib/components/Series/__tests__/SeriesMetadataBar.test.ts`
- Modify: `src/lib/views/SeriesView.svelte` (imports; render under the header row)

**Interfaces:**

- Consumes: `seriesMetadataMap`, `updateSeriesMetadata`, `unlinkSeries` (Task 2), `getLinkTargets` (Task 7), `normalizeSeriesKey` (Task 1), `unifiedCloudManager.refreshSeriesSidecars` (Task 9), `SeriesLinkModal` (Task 11), `providerManager` (`$lib/util/sync`) for read-only state, `showSnackbar`.
- Produces: component `SeriesMetadataBar` props `{ seriesTitle: string; volumes: VolumeMetadata[] }`. Plans B/C add controls to this component (title-language select; tracking/read-count/restart).

- [ ] **Step 1: Write the failing render test**

```ts
// src/lib/components/Series/__tests__/SeriesMetadataBar.test.ts
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import { writable } from 'svelte/store';
import { createEmptySeriesMetadata } from '$lib/metadata/types';

const seriesMetadataMap = writable(new Map());
vi.mock('$lib/metadata/store', () => ({
  seriesMetadataMap,
  updateSeriesMetadata: vi.fn(),
  unlinkSeries: vi.fn()
}));
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: { refreshSeriesSidecars: vi.fn(), cloudFiles: writable(new Map()) }
}));
vi.mock('$lib/util/sync', () => ({
  providerManager: { getActiveProvider: () => null, activeProviderType: writable(null) }
}));
vi.mock('$lib/util', () => ({ showSnackbar: vi.fn() }));

import SeriesMetadataBar from '../SeriesMetadataBar.svelte';

describe('SeriesMetadataBar', () => {
  it('offers Link… when the series is not linked', () => {
    seriesMetadataMap.set(new Map());
    const { getByText, queryByText } = render(SeriesMetadataBar, {
      props: { seriesTitle: 'One Piece', volumes: [] }
    });
    expect(getByText('Link…')).toBeTruthy();
    expect(queryByText('AniList')).toBeNull();
  });

  it('shows alt titles and provider links when linked', () => {
    const meta = {
      ...createEmptySeriesMetadata('One Piece'),
      external_ids: { anilist: 30013, mal: 13 },
      titles: { native: 'ワンピース', romaji: 'ONE PIECE', english: 'One Piece' },
      tag: '[color]'
    };
    seriesMetadataMap.set(new Map([['one piece', meta]]));
    const { getByText, getByDisplayValue } = render(SeriesMetadataBar, {
      props: { seriesTitle: 'One Piece', volumes: [] }
    });
    const anilist = getByText('AniList') as HTMLAnchorElement;
    expect(anilist.closest('a')?.getAttribute('href')).toBe('https://anilist.co/manga/30013');
    expect(getByText('MyAnimeList').closest('a')?.getAttribute('href')).toBe(
      'https://myanimelist.net/manga/13'
    );
    expect(getByText(/ワンピース/)).toBeTruthy();
    expect(getByDisplayValue('[color]')).toBeTruthy();
    expect(getByText('Unlink')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/components/Series/__tests__/SeriesMetadataBar.test.ts`
Expected: FAIL — cannot resolve `../SeriesMetadataBar.svelte`.

- [ ] **Step 3: Write the component**

```svelte
<!-- src/lib/components/Series/SeriesMetadataBar.svelte -->
<script lang="ts">
  import { Button, Badge, Spinner } from 'flowbite-svelte';
  import { ArrowUpRightFromSquareOutline } from 'flowbite-svelte-icons';
  import { seriesMetadataMap, updateSeriesMetadata, unlinkSeries } from '$lib/metadata/store';
  import { normalizeSeriesKey } from '$lib/metadata/series-key';
  import { getLinkTargets } from '$lib/metadata/link-targets';
  import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
  import { providerManager } from '$lib/util/sync';
  import { showSnackbar } from '$lib/util';
  import { ProviderError } from '$lib/util/sync/provider-interface';
  import type { VolumeMetadata } from '$lib/types';
  import SeriesLinkModal from './SeriesLinkModal.svelte';

  let { seriesTitle, volumes }: { seriesTitle: string; volumes: VolumeMetadata[] } = $props();

  let meta = $derived($seriesMetadataMap.get(normalizeSeriesKey(seriesTitle)));
  let linked = $derived(!!meta && Object.values(meta.external_ids ?? {}).some((v) => v != null));
  let links = $derived(meta ? getLinkTargets(meta.external_ids) : []);
  let altTitles = $derived.by(() => {
    if (!meta) return [] as string[];
    const seen = new Set<string>([normalizeSeriesKey(seriesTitle)]);
    const out: string[] = [];
    for (const t of [meta.titles.native, meta.titles.romaji, meta.titles.english]) {
      if (t && !seen.has(normalizeSeriesKey(t))) {
        seen.add(normalizeSeriesKey(t));
        out.push(t);
      }
    }
    return out;
  });

  let linkOpen = $state(false);
  // Set after any link/tag/unlink change; cleared by a successful refresh. Drives the
  // "out of date" hint next to the Update button (spec: the offer to refresh).
  let sidecarsStale = $state(false);
  let tagDraft = $state('');
  let tagDirty = $state(false);
  let refreshing = $state(false);

  // Keep the tag field in step with the record unless the user is mid-edit
  $effect(() => {
    if (!tagDirty) tagDraft = meta?.tag ?? '';
  });

  async function saveTag() {
    const next = tagDraft.trim();
    if ((meta?.tag ?? '') === next) {
      tagDirty = false;
      return;
    }
    await updateSeriesMetadata(seriesTitle, { tag: next || undefined });
    tagDirty = false;
    sidecarsStale = true;
  }

  async function onUnlink() {
    await unlinkSeries(seriesTitle);
    showSnackbar('Unlinked from AniList');
    sidecarsStale = true;
  }

  let hasCloud = $derived(providerManager.getActiveProvider() !== null);

  async function refreshSidecars() {
    refreshing = true;
    try {
      const result = await unifiedCloudManager.refreshSeriesSidecars(
        seriesTitle,
        volumes
          .filter((v) => !v.isPlaceholder)
          .map((v) => ({ volumeUuid: v.volume_uuid, volumeTitle: v.volume_title }))
      );
      const total = result.succeeded + result.failed;
      if (result.failed === 0) sidecarsStale = false;
      if (total === 0) showSnackbar('No backed-up volumes to update');
      else if (result.failed === 0)
        showSnackbar(
          `Updated ${result.succeeded} cloud sidecar${result.succeeded === 1 ? '' : 's'}`
        );
      else
        showSnackbar(
          `Updated ${result.succeeded}/${total} cloud sidecars (${result.failed} failed)`
        );
    } catch (error) {
      if (error instanceof ProviderError && error.code === 'READ_ONLY') {
        showSnackbar('Your cloud provider is read-only — sidecars were not updated');
      } else {
        console.error('Sidecar refresh failed:', error);
        showSnackbar("Couldn't update cloud sidecars. Check your connection and try again.");
      }
    } finally {
      refreshing = false;
    }
  }
</script>

<div class="flex flex-col gap-2 px-2 text-sm">
  {#if altTitles.length > 0}
    <div class="text-gray-500 dark:text-gray-400">{altTitles.join(' · ')}</div>
  {/if}

  <div class="flex flex-wrap items-center gap-2">
    {#each links as l (l.provider)}
      <a href={l.url} target="_blank" rel="noopener noreferrer" class="inline-flex">
        <Badge color="blue" class="cursor-pointer">
          <ArrowUpRightFromSquareOutline class="me-1 h-3 w-3" />{l.label}
        </Badge>
      </a>
    {/each}

    {#if linked}
      <Button size="xs" color="light" onclick={() => (linkOpen = true)}>Change</Button>
      <Button size="xs" color="light" onclick={onUnlink}>Unlink</Button>
    {:else}
      <Button size="xs" color="light" onclick={() => (linkOpen = true)}>Link…</Button>
    {/if}

    <label class="ml-auto flex items-center gap-1">
      <span class="text-gray-500 dark:text-gray-400">Tag</span>
      <input
        type="text"
        value={tagDraft}
        oninput={(e) => {
          tagDirty = true;
          tagDraft = (e.currentTarget as HTMLInputElement).value;
        }}
        onblur={saveTag}
        onkeydown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
        placeholder="[color]"
        class="w-32 rounded border border-gray-300 bg-gray-50 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-700"
      />
    </label>

    {#if hasCloud}
      <Button
        size="xs"
        color="light"
        onclick={refreshSidecars}
        disabled={refreshing}
        title="Rewrite the .mokuro of every backed-up volume with the current link and tag"
      >
        {#if refreshing}<Spinner size="3" class="me-1" />{/if}
        Update cloud sidecars
      </Button>
      {#if sidecarsStale}
        <span class="text-xs text-amber-600 dark:text-amber-400"
          >Cloud .mokuro files are out of date</span
        >
      {/if}
    {/if}
  </div>
</div>

<SeriesLinkModal bind:open={linkOpen} {seriesTitle} onLinked={() => (sidecarsStale = true)} />
```

- [ ] **Step 4: Mount in `SeriesView.svelte`** — add the import next to the other component imports:

```ts
import SeriesMetadataBar from '$lib/components/Series/SeriesMetadataBar.svelte';
```

and render it directly after the header row `</div>` (the one closing `<!-- Header Row: Title on left, Stats on right -->`, just before `<!-- Actions Row: All buttons -->`):

```svelte
<SeriesMetadataBar seriesTitle={manga[0].series_title} volumes={manga} />
```

- [ ] **Step 5: Run tests + type check**

Run: `npx vitest run src/lib/components/Series && npm run check`
Expected: PASS, 0 errors. (`ArrowUpRightFromSquareOutline` is exported by the installed `flowbite-svelte-icons`.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/components/Series/SeriesMetadataBar.svelte src/lib/components/Series/__tests__/SeriesMetadataBar.test.ts src/lib/views/SeriesView.svelte
git commit -m "feat(series): metadata bar — alt titles, link-out chips, link/unlink, tag, sidecar refresh"
```

---

### Task 13: End-to-end verification + docs

**Files:**

- Modify: `CLAUDE.md` (Database Schema table + Mokuro File Format section)
- Modify: `CHANGELOG.md` (new `## [Unreleased]` block at top)

- [ ] **Step 1: Run the whole suite, lint and type check**

Run: `npx vitest run && npm run check && npm run lint`
Expected: all PASS; fix any Prettier complaints with `npm run format` on the touched files.

- [ ] **Step 2: Manual verification with the `verify` skill** (Playwright against a dedicated dev server, `E2E_PORT` set): import a synthetic OCR series (2 volumes), open the series page, click **Link…**, pick the first AniList result for "one piece", set tag `[color]`, then export the volume (ZIP) and assert the `.mokuro` inside contains `series_metadata` with `external_ids.anilist`, `titles`, `tag: "[color]"`. Re-import that ZIP into a fresh profile and confirm the series page shows the AniList chip and tag without linking again. Record the observed values in the commit message body.

- [ ] **Step 3: Docs**

`CLAUDE.md` — Database Schema table: add a row

```
| `series_metadata` | `series_key` | — | Per-series AniList link, titles, tag, tracking (key = normalized `series_title`) |
```

and in "Mokuro File Format" append:

```
Reader extension: the app writes an optional top-level `series_metadata`
object (`external_ids`, `titles`, `synonyms`, `tag`, `updated_at`) built by
`src/lib/util/mokuro-metadata.ts` and read back by `parseMokuroFile`. Never
put per-user preferences (tracking, title preference) in it.
```

`CHANGELOG.md` — insert above `## [1.8.2]`:

```
## [Unreleased]

### Added

- Link a series to AniList; alt titles, link-out chips, free-text tag
- Series facts + tag embedded in exported/backed-up `.mokuro` files
- `series-metadata.json` synced across devices; "Update cloud sidecars" action
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md CHANGELOG.md
git commit -m "docs: series metadata table, .mokuro series_metadata extension, changelog"
```

---

## Self-review (done while writing)

- **Spec coverage (Phase A):** types/key (T1), table + store (T2), merge (T3), embed (T4), shared writer + spine_width + 4 call sites (T5), parser read-back + upsert on import (T6), provider + rate guard + link targets + ID paste (T7), `series-metadata.json` (T8), sidecar refresh with read-only gate + per-volume counting (T9), rename key migration (T10), link modal (T11), metadata bar with alt titles / chips / Link-Change-Unlink / tag / refresh + mount (T12), docs + manual verification (T13). Not in scope by design: title-language preference (Plan B), tracking/re-reads/auth (Plan C).
- **Contract check:** all names match the shared contract; one addition beyond it — `refreshSeriesSidecars` returns `{ succeeded, failed, skipped }` (added `skipped` so the UI can say "no backed-up volumes"); Plans B/C do not consume this return type.
- **Type consistency:** `SeriesMetadataPatch` is exported from `store.ts` and imported by `anilist.ts`; `MokuroMetadata` lives in `mokuro-metadata.ts` and is re-exported from `compress-volume.ts`; `EmbeddedSeriesMetadata` flows `fromEmbedded → ParsedMokuro.seriesMetadata → ProcessedMetadata.seriesMetadata → upsertFromEmbedded`.
