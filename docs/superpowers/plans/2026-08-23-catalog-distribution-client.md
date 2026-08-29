# Catalog & Series Metadata Distribution (Client) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make catalog browsing fast on large/slow backends by installing series _names_ from a root `catalog.json` on catalog open and installing volume metadata + covers from that series' `series.json` on series open, materialized as metadata-only volume rows.

**Architecture:** Two new modules mirror the existing `series.json` machinery one-for-one: `catalog-file.ts` is to `series-file.ts` what `catalog-index.ts`/`catalog-index-sync.ts`/`catalog-file-sync.ts` are to `series-index.ts`/`series-index-sync.ts`/`series-file-sync.ts`. A new Dexie table `catalog_index` (PK `series_key`) caches the parsed entries with the cloud file's size/mtime stamp and feeds a liveQuery the catalog joins as name-only cards. Series open drives an event-based single-series `series.json` refresh followed by materialization of its index entries into real `volumes` rows (`metadata_only: true`), with covers installed lazily from the existing per-volume sidecars. Every metadata write is best-effort and can never demote a provider to read-only.

**Tech Stack:** SvelteKit 5 runes, Dexie 4 + fake-indexeddb, Vitest + jsdom, Playwright (e2e), TypeScript.

**Spec:** `docs/superpowers/specs/2026-08-23-catalog-distribution-design.md` (authoritative). Companion server-side plan: `docs/superpowers/plans/2026-08-23-catalog-distribution-bunko.md` (separate repo, do NOT implement here).

## Global Constraints

Copied verbatim from the spec; every task's requirements implicitly include these.

- **`catalog.json` shape** — root file:
  `{"version": 1, "updated_at": "<ISO>", "series": [{"series_title", "titles", "synonyms", "tag"?, "unit"?, "external_ids"?, "updated_at"}]}`.
- **Name-related data ONLY** — "everything needed to map and search, nothing more. No counts, no covers, no volume lists (those live in `series.json`)".
- **Entry = the FACTS subset of that series' `series.json`** — "same keys, same meaning, same facts stamp".
- **Factless series still get an entry** — "carrying just `series_title` + stamp — the catalog must list them by folder name."
- **Factless-entry rules on read** — "the factless-file rules apply: a factless entry never creates a record and never unlinks." (`upsertFromSeriesFile` already enforces both; route every entry through it rather than reimplementing.)
- **`FACTLESS_UPDATED_AT`** is exactly `'1970-01-01T00:00:00.000Z'` and must never be `new Date()`.
- **Compact JSON** — "Compact JSON" for `catalog.json`, serialized through a single `stringifySeriesFile`-style serializer (`stringifyCatalogFile`), never pretty-printed.
- **Best-effort writes** — "All metadata writes (`series.json`, `catalog.json`) are best-effort: on failure, log at debug, keep the provider fully functional (NO read-only fallback, no snackbar), retry on the next natural trigger. A provider that rejects metadata writes but serves reads is a first-class configuration (bunko scoped users)."
- **Client production is disabled on bunko** — "Bunko: sole producer of its `catalog.json` and `series.json` files… Client-side production is disabled when the provider is bunko-backed." / "Client catalog.json production and bunko production never race: bunko providers are read-only for that file by contract."
- **Client production shape** — "debounced after fact edits and backup completion, union-by-key with the existing cloud file (newest facts stamp wins per series), pruned against the listing (folders gone from the cloud drop out), never written when the listing is unavailable/stale. `catalog.json` joins the root-config allowlist."
- **Size/mtime gating** — "fetch `catalog.json` when its size/mtime changed (same versioning discipline as `series_index`)"; series open refreshes ONE `series.json`, "size/mtime gated, event-driven — not waiting for a full listing pass".
- **Materialization** — "materialize each cloud-only volume entry as a metadata-only `volumes` row: real uuid, counts, `mokuro_version`, `spine_width`, `metadata_only: true`."
- **Local wins** — "Materialization never overwrites an installed row and never downgrades counts on an existing metadata-only row that has newer local data (local wins — the index stays unauthoritative)."
- **Shadow rules** — "Materialized rows shadow placeholders permanently; the placeholder fallback remains for entries without an index (bare shares)."
- **Lifecycle** — "Materialized rows follow the metadata-only lifecycle exactly: forget path removes them; a series deleted from the cloud leaves them as history; stranded-row cleanup applies on refill."
- **Provider-bound cache cleanup** — "`catalog_index` cleanup mirrors `series_index`: provider-bound, listing-gated, never against an empty/failed listing."
- **Hole patching** — "synced progress referencing a series (by `series_title`/`series_uuid` on the progress record) that has no local rows and no cached index forces a pull of that series' `series.json` + materialization, so stats views never dangle."
- **Covers** — "Covers come from existing per-volume sidecars, not from new fields in the metadata files." Fetch lazily with bounded concurrency, reusing `fetchCloudThumbnail`.
- **CLAUDE.md Svelte rules** (binding):
  - `$derived`/`$derived.by()` run for EVERY component instance — no expensive work or logging in per-card derived.
  - Modal action-button containers get `relative z-10`.
  - `{#key}` blocks around dynamic text extensions mutate (Migaku/Yomitan).
  - Always use the Dexie instance from `src/lib/catalog/db.ts`.
  - Worktree-based development; the coordinator commits — implementers commit inside the worktree only.
- **Verification port is 5199** — port 5173 belongs to the user. Playwright runs with `E2E_PORT=5199` (and `E2E_CHROMIUM` when a browser binary is already cached).
- **Superseded in part** — the spec's `series-metadata.json` references are superseded by its own 2026-08-23 amendment; see `docs/superpowers/plans/2026-08-23-series-metadata-retirement.md`.

## File Structure

| File                                                                                                            | Responsibility                                                                                                            |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/metadata/catalog-file.ts` (new)                                                                        | `catalog.json` types, build (union+prune), parse/sanitize, compact serializer, path test, entry↔`SeriesFile` conversions |
| `src/lib/metadata/catalog-index.ts` (new)                                                                       | `catalog_index` Dexie accessors, liveQuery store, `catalogNeedsRefresh`                                                   |
| `src/lib/metadata/catalog-index-sync.ts` (new)                                                                  | Read half: listing-driven fetch/merge/prune of `catalog.json`, coalesced + provider-bound                                 |
| `src/lib/metadata/catalog-file-sync.ts` (new)                                                                   | Write half: debounced client production, gated on writable + non-bunko + fresh listing                                    |
| `src/lib/metadata/series-open.ts` (new)                                                                         | `openSeries()` — single-series refresh → materialize → install covers                                                     |
| `src/lib/metadata/hole-patch.ts` (new)                                                                          | Progress records referencing unknown series → `openSeries()`                                                              |
| `src/lib/catalog/materialize.ts` (new)                                                                          | Index entries → metadata-only `volumes` rows (local wins, shadow rules)                                                   |
| `src/lib/catalog/cover-install.ts` (new)                                                                        | Lazy per-volume cover sidecar → inlined `thumbnail` on the row                                                            |
| `src/lib/components/CatalogNameCard.svelte` (new)                                                               | Name-only catalog card (no volumes, no cover)                                                                             |
| `src/lib/metadata/series-index.ts`                                                                              | + `sourceStampChanged()` extracted from `indexNeedsRefresh` (shared stamp comparison)                                     |
| `src/lib/metadata/series-file-sync.ts`                                                                          | Export the coalesced listing refresh; debug-level failure logs                                                            |
| `src/lib/util/sync/syncable-file.ts`                                                                            | `catalog.json` in the root-config allowlist; `isBestEffortMetadataPath()`                                                 |
| `src/lib/util/sync/unified-cloud-manager.ts`                                                                    | `writeCatalogFile()`, `refreshSeriesIndexForSeries()`, catalog-index key move/delete                                      |
| `src/lib/util/sync/provider-interface.ts` / `unified-provider-state.ts` / `providers/webdav/webdav-provider.ts` | `serverCompilesMetadata` flag; no read-only demotion on metadata writes                                                   |
| `src/lib/catalog/db-v3.ts`                                                                                      | Dexie version 4: `catalog_index: 'series_key'`                                                                            |
| `src/lib/catalog/catalog.ts` / `src/lib/catalog/index.ts` / `src/lib/components/Catalog.svelte`                 | Name-only series in the join, search and rendering                                                                        |
| `src/lib/views/SeriesView.svelte`                                                                               | Series-open hook + pending state                                                                                          |

---

### Task 1: `catalog.json` build / parse / serialize

**Files:**

- Create: `src/lib/metadata/catalog-file.ts`
- Test: `src/lib/metadata/catalog-file.test.ts`

**Interfaces:**

- Consumes (existing, unchanged): from `src/lib/metadata/series-file.ts` — `FACTLESS_UPDATED_AT: string`, `hasSeriesFacts(facts: { external_ids?: SeriesExternalIds; titles?: SeriesTitles; synonyms?: string[]; tag?: string; unit?: TrackingUnit; updated_at?: string }): boolean`, `seriesFactsStamp(meta: SeriesMetadata): string | undefined`, `interface SeriesFile`; from `src/lib/metadata/sanitize.ts` — `ID_KEYS`, `TITLE_KEYS`, `isRecord`, `normalizeUpdatedAt`, `sanitizeExternalIds`, `sanitizeSynonyms`, `sanitizeTag`, `sanitizeTitles`, `sanitizeTrackingUnit`; from `src/lib/metadata/series-key.ts` — `normalizeSeriesKey(title: string): string`.
- Produces:
  - `export const CATALOG_FILE_NAME = 'catalog.json'`
  - `export interface CatalogFileEntry { series_title: string; external_ids: SeriesExternalIds; titles: SeriesTitles; synonyms: string[]; tag?: string; unit?: TrackingUnit; updated_at: string }`
  - `export interface CatalogFile { version: 1; updated_at: string; series: CatalogFileEntry[] }`
  - `export function catalogEntryFromMeta(seriesTitle: string, meta: SeriesMetadata | undefined): CatalogFileEntry`
  - `export function catalogEntryFromSeriesFile(file: SeriesFile): CatalogFileEntry`
  - `export function catalogEntryToSeriesFile(entry: CatalogFileEntry): SeriesFile`
  - `export function buildCatalogFile(args: { entries: CatalogFileEntry[]; existing?: CatalogFile; cloudSeriesTitles?: Set<string>; now?: string }): CatalogFile | undefined`
  - `export function parseCatalogFile(value: unknown): CatalogFile | undefined`
  - `export function stringifyCatalogFile(file: CatalogFile): string`
  - `export function isCatalogFilePath(path: string): boolean`

- [ ] **Step 1: Write the failing test**

Create `src/lib/metadata/catalog-file.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FACTLESS_UPDATED_AT, type SeriesFile } from './series-file';
import type { SeriesMetadata } from './types';
import {
  buildCatalogFile,
  catalogEntryFromMeta,
  catalogEntryFromSeriesFile,
  catalogEntryToSeriesFile,
  isCatalogFilePath,
  parseCatalogFile,
  stringifyCatalogFile,
  type CatalogFile,
  type CatalogFileEntry
} from './catalog-file';

function meta(overrides: Partial<SeriesMetadata> = {}): SeriesMetadata {
  return {
    series_key: 'dr stone (hd scan)',
    series_title: 'Dr Stone (HD Scan)',
    external_ids: { anilist: 98416 },
    titles: { native: 'Dr.STONE', romaji: 'Dr. STONE', english: 'Dr. STONE' },
    synonyms: [],
    tag: 'HD Scan',
    read_count: 0,
    updated_at: '2026-08-18T19:36:24.324Z',
    facts_updated_at: '2026-08-18T19:36:24.324Z',
    ...overrides
  };
}

function entry(overrides: Partial<CatalogFileEntry> = {}): CatalogFileEntry {
  return {
    series_title: 'Dr Stone (HD Scan)',
    external_ids: { anilist: 98416 },
    titles: { native: 'Dr.STONE' },
    synonyms: [],
    tag: 'HD Scan',
    updated_at: '2026-08-18T19:36:24.324Z',
    ...overrides
  };
}

describe('catalogEntryFromMeta', () => {
  it('projects the facts subset stamped with the facts clock', () => {
    expect(catalogEntryFromMeta('Dr Stone (HD Scan)', meta())).toEqual({
      series_title: 'Dr Stone (HD Scan)',
      external_ids: { anilist: 98416 },
      titles: { native: 'Dr.STONE', romaji: 'Dr. STONE', english: 'Dr. STONE' },
      synonyms: [],
      tag: 'HD Scan',
      updated_at: '2026-08-18T19:36:24.324Z'
    });
  });

  it('stamps a series with no record at the epoch and keeps only its title', () => {
    expect(catalogEntryFromMeta('Bare Folder', undefined)).toEqual({
      series_title: 'Bare Folder',
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: FACTLESS_UPDATED_AT
    });
  });

  it('publishes a deliberate unlink: factless facts with a real stamp', () => {
    const unlinked = meta({
      external_ids: {},
      titles: {},
      synonyms: [],
      tag: undefined,
      facts_updated_at: '2026-08-20T00:00:00.000Z'
    });
    expect(catalogEntryFromMeta('Dr Stone (HD Scan)', unlinked).updated_at).toBe(
      '2026-08-20T00:00:00.000Z'
    );
  });
});

describe('catalogEntryFromSeriesFile / catalogEntryToSeriesFile', () => {
  it('round-trips the facts subset of a series.json', () => {
    const file: SeriesFile = {
      version: 2,
      series_title: 'Dr Stone (HD Scan)',
      external_ids: { anilist: 98416 },
      titles: { native: 'Dr.STONE' },
      synonyms: ['Doctor Stone'],
      tag: 'HD Scan',
      unit: 'volumes',
      updated_at: '2026-08-18T19:36:24.324Z',
      volumes: [
        {
          volume_uuid: 'uuid-1',
          volume_title: 'Volume 1',
          page_count: 200,
          character_count: 5000,
          mokuro_version: '0.4.11'
        }
      ]
    };
    const projected = catalogEntryFromSeriesFile(file);
    expect(projected).toEqual({
      series_title: 'Dr Stone (HD Scan)',
      external_ids: { anilist: 98416 },
      titles: { native: 'Dr.STONE' },
      synonyms: ['Doctor Stone'],
      tag: 'HD Scan',
      unit: 'volumes',
      updated_at: '2026-08-18T19:36:24.324Z'
    });
    expect(catalogEntryToSeriesFile(projected)).toEqual({
      version: 2,
      series_title: 'Dr Stone (HD Scan)',
      external_ids: { anilist: 98416 },
      titles: { native: 'Dr.STONE' },
      synonyms: ['Doctor Stone'],
      tag: 'HD Scan',
      unit: 'volumes',
      updated_at: '2026-08-18T19:36:24.324Z',
      volumes: []
    });
  });
});

describe('buildCatalogFile', () => {
  it('unions with the cloud copy, newest facts stamp winning per series', () => {
    const existing: CatalogFile = {
      version: 1,
      updated_at: '2026-08-19T00:00:00.000Z',
      series: [
        entry({ titles: { native: 'OLD' }, updated_at: '2026-08-19T00:00:00.000Z' }),
        entry({ series_title: 'Other Device Only', updated_at: '2026-08-10T00:00:00.000Z' })
      ]
    };
    const built = buildCatalogFile({
      entries: [entry({ titles: { native: 'NEW' }, updated_at: '2026-08-20T00:00:00.000Z' })],
      existing,
      cloudSeriesTitles: new Set(['Dr Stone (HD Scan)', 'Other Device Only']),
      now: '2026-08-23T00:00:00.000Z'
    });
    expect(built?.series.map((s) => s.series_title)).toEqual([
      'Dr Stone (HD Scan)',
      'Other Device Only'
    ]);
    expect(built?.series[0].titles).toEqual({ native: 'NEW' });
    expect(built?.updated_at).toBe('2026-08-23T00:00:00.000Z');
  });

  it('keeps the cloud facts when the local entry is older', () => {
    const existing: CatalogFile = {
      version: 1,
      updated_at: '2026-08-21T00:00:00.000Z',
      series: [entry({ titles: { native: 'CLOUD' }, updated_at: '2026-08-21T00:00:00.000Z' })]
    };
    const built = buildCatalogFile({
      entries: [entry({ titles: { native: 'LOCAL' }, updated_at: '2026-08-20T00:00:00.000Z' })],
      existing,
      cloudSeriesTitles: new Set(['Dr Stone (HD Scan)'])
    });
    expect(built?.series[0].titles).toEqual({ native: 'CLOUD' });
  });

  it('never lets a factless epoch entry outrank published facts', () => {
    const existing: CatalogFile = {
      version: 1,
      updated_at: '2026-08-21T00:00:00.000Z',
      series: [entry({ updated_at: '2026-08-21T00:00:00.000Z' })]
    };
    const built = buildCatalogFile({
      entries: [
        {
          series_title: 'Dr Stone (HD Scan)',
          external_ids: {},
          titles: {},
          synonyms: [],
          updated_at: FACTLESS_UPDATED_AT
        }
      ],
      existing,
      cloudSeriesTitles: new Set(['Dr Stone (HD Scan)'])
    });
    expect(built?.series[0].external_ids).toEqual({ anilist: 98416 });
  });

  it('needs a STRICTLY newer stamp to publish an unlink', () => {
    const existing: CatalogFile = {
      version: 1,
      updated_at: '2026-08-21T00:00:00.000Z',
      series: [entry({ updated_at: '2026-08-21T00:00:00.000Z' })]
    };
    const built = buildCatalogFile({
      entries: [
        {
          series_title: 'Dr Stone (HD Scan)',
          external_ids: {},
          titles: {},
          synonyms: [],
          updated_at: '2026-08-21T00:00:00.000Z'
        }
      ],
      existing,
      cloudSeriesTitles: new Set(['Dr Stone (HD Scan)'])
    });
    expect(built?.series[0].external_ids).toEqual({ anilist: 98416 });
  });

  it('prunes series whose folder is gone from the listing', () => {
    const built = buildCatalogFile({
      entries: [entry(), entry({ series_title: 'Deleted Series' })],
      cloudSeriesTitles: new Set(['dr stone (hd scan)']),
      now: '2026-08-23T00:00:00.000Z'
    });
    expect(built?.series.map((s) => s.series_title)).toEqual(['Dr Stone (HD Scan)']);
  });

  it('keeps a factless folder listed by name', () => {
    const built = buildCatalogFile({
      entries: [
        {
          series_title: 'Bare Folder',
          external_ids: {},
          titles: {},
          synonyms: [],
          updated_at: FACTLESS_UPDATED_AT
        }
      ],
      cloudSeriesTitles: new Set(['Bare Folder'])
    });
    expect(built?.series).toEqual([
      {
        series_title: 'Bare Folder',
        external_ids: {},
        titles: {},
        synonyms: [],
        updated_at: FACTLESS_UPDATED_AT
      }
    ]);
  });

  it('returns undefined when nothing survives', () => {
    expect(
      buildCatalogFile({ entries: [entry()], cloudSeriesTitles: new Set<string>() })
    ).toBeUndefined();
  });
});

describe('parseCatalogFile', () => {
  it('accepts a well-formed file and drops unknown keys', () => {
    const parsed = parseCatalogFile({
      version: 1,
      updated_at: '2026-08-23T00:00:00.000Z',
      evil: 'ignored',
      series: [
        {
          series_title: 'Dr Stone (HD Scan)',
          titles: { native: 'Dr.STONE', klingon: 'nope' },
          synonyms: ['Doctor Stone', ''],
          tag: ' HD Scan ',
          unit: 'volumes',
          external_ids: { anilist: 98416, mal: 0 },
          updated_at: '2026-08-18T19:36:24.324Z',
          volumes: [{ volume_uuid: 'uuid-1' }]
        }
      ]
    });
    expect(parsed).toEqual({
      version: 1,
      updated_at: '2026-08-23T00:00:00.000Z',
      series: [
        {
          series_title: 'Dr Stone (HD Scan)',
          external_ids: { anilist: 98416 },
          titles: { native: 'Dr.STONE' },
          synonyms: ['Doctor Stone'],
          tag: 'HD Scan',
          unit: 'volumes',
          updated_at: '2026-08-18T19:36:24.324Z'
        }
      ]
    });
  });

  it('rejects a wrong version and junk', () => {
    expect(
      parseCatalogFile({ version: 2, updated_at: '2026-08-23T00:00:00.000Z' })
    ).toBeUndefined();
    expect(parseCatalogFile('nope')).toBeUndefined();
    expect(parseCatalogFile({ version: 1, updated_at: 'not a date' })).toBeUndefined();
  });

  it('drops bad entries individually and de-duplicates by series key', () => {
    const parsed = parseCatalogFile({
      version: 1,
      updated_at: '2026-08-23T00:00:00.000Z',
      series: [
        { series_title: '  ', updated_at: '2026-08-18T19:36:24.324Z' },
        { series_title: 'Good', updated_at: 'garbage' },
        { series_title: 'Good', updated_at: '2026-08-18T19:36:24.324Z' },
        { series_title: 'GOOD', updated_at: '2026-08-19T19:36:24.324Z' }
      ]
    });
    expect(parsed?.series).toHaveLength(1);
    expect(parsed?.series[0].series_title).toBe('Good');
  });

  it('clamps a far-future stamp so it cannot win forever', () => {
    const far = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000).toISOString();
    const parsed = parseCatalogFile({
      version: 1,
      updated_at: far,
      series: [{ series_title: 'Good', updated_at: far }]
    });
    expect(Date.parse(parsed!.series[0].updated_at)).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe('stringifyCatalogFile / isCatalogFilePath', () => {
  it('serializes compactly', () => {
    const json = stringifyCatalogFile({
      version: 1,
      updated_at: '2026-08-23T00:00:00.000Z',
      series: []
    });
    expect(json).toBe('{"version":1,"updated_at":"2026-08-23T00:00:00.000Z","series":[]}');
  });

  it('matches only the ROOT catalog.json', () => {
    expect(isCatalogFilePath('catalog.json')).toBe(true);
    expect(isCatalogFilePath('/catalog.json')).toBe(true);
    expect(isCatalogFilePath('CATALOG.JSON')).toBe(true);
    expect(isCatalogFilePath('Dr Stone/catalog.json')).toBe(false);
    expect(isCatalogFilePath('my-catalog.json')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/metadata/catalog-file.test.ts`
Expected: FAIL — `Failed to resolve import "./catalog-file"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/metadata/catalog-file.ts`:

```ts
import {
  FACTLESS_UPDATED_AT,
  hasSeriesFacts,
  seriesFactsStamp,
  type SeriesFile
} from './series-file';
import { normalizeSeriesKey } from './series-key';
import {
  ID_KEYS,
  TITLE_KEYS,
  isRecord,
  normalizeUpdatedAt,
  sanitizeExternalIds,
  sanitizeSynonyms,
  sanitizeTag,
  sanitizeTitles,
  sanitizeTrackingUnit
} from './sanitize';
import type { SeriesExternalIds, SeriesMetadata, SeriesTitles, TrackingUnit } from './types';

/** Basename of the root catalog file, stored next to `series-metadata.json`. */
export const CATALOG_FILE_NAME = 'catalog.json';

/**
 * One series in the root catalog: the FACTS subset of that series' `series.json`
 * — same keys, same meaning, same facts stamp — and nothing else. No counts, no
 * covers, no volume list: those live in `series.json`, which is fetched when the
 * series is opened.
 *
 * A series this library knows no facts about still gets an entry, carrying just
 * its `series_title` and `FACTLESS_UPDATED_AT`: the catalog must be able to list
 * every folder by name, and an epoch stamp loses every merge comparison, so it
 * can never unlink a series someone else linked.
 */
export interface CatalogFileEntry {
  series_title: string;
  external_ids: SeriesExternalIds;
  titles: SeriesTitles;
  synonyms: string[];
  tag?: string;
  unit?: TrackingUnit;
  updated_at: string;
}

/**
 * The root `catalog.json`: name/mapping/search data for the whole library.
 *
 * `updated_at` is the file's own build stamp (informational). The MERGE key is
 * per entry — `CatalogFileEntry.updated_at`, the same facts clock `series.json`
 * uses — so a catalog rebuilt for an unrelated series can never outrank another
 * device's facts.
 */
export interface CatalogFile {
  version: 1;
  updated_at: string;
  series: CatalogFileEntry[];
}

/** Facts only, in canonical key order, with empties omitted. */
function factsOf(source: {
  external_ids?: SeriesExternalIds;
  titles?: SeriesTitles;
  synonyms?: string[];
  tag?: string;
  unit?: TrackingUnit;
}): Omit<CatalogFileEntry, 'series_title' | 'updated_at'> {
  const external_ids: SeriesExternalIds = {};
  for (const k of ID_KEYS)
    if (source.external_ids?.[k] != null) external_ids[k] = source.external_ids[k];

  const titles: SeriesTitles = {};
  for (const k of TITLE_KEYS) if (source.titles?.[k]) titles[k] = source.titles[k];

  const facts: Omit<CatalogFileEntry, 'series_title' | 'updated_at'> = {
    external_ids,
    titles,
    synonyms: [...(source.synonyms ?? [])]
  };
  const tag = source.tag?.trim();
  if (tag) facts.tag = tag;
  const unit = sanitizeTrackingUnit(source.unit);
  if (unit) facts.unit = unit;
  return facts;
}

/**
 * Project a local `series_metadata` record onto its catalog entry.
 *
 * Stamped with the record's FACTS clock — never `updated_at`, which every
 * per-user write bumps — exactly like `buildSeriesFile`. A record that has never
 * had an opinion (or no record at all) yields a factless entry at the epoch.
 */
export function catalogEntryFromMeta(
  seriesTitle: string,
  meta: SeriesMetadata | undefined
): CatalogFileEntry {
  if (!meta) {
    return {
      series_title: seriesTitle,
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: FACTLESS_UPDATED_AT
    };
  }
  const stamp = seriesFactsStamp(meta);
  return {
    series_title: seriesTitle,
    ...factsOf(meta),
    updated_at:
      stamp === undefined ? FACTLESS_UPDATED_AT : (normalizeUpdatedAt(stamp) ?? FACTLESS_UPDATED_AT)
  };
}

/** Project a `series.json` onto its catalog entry (facts subset, same stamp). */
export function catalogEntryFromSeriesFile(file: SeriesFile): CatalogFileEntry {
  return {
    series_title: file.series_title,
    ...factsOf(file),
    updated_at: file.updated_at
  };
}

/**
 * Lift a catalog entry into a facts-only `SeriesFile` so it can be applied
 * through `upsertFromSeriesFile` unchanged. That is the whole point: the
 * factless rules (never create a record from a factless file, never unlink
 * without a strictly newer stamp) are implemented once, in `store.ts`, and the
 * catalog gets them for free instead of re-deriving them.
 */
export function catalogEntryToSeriesFile(entry: CatalogFileEntry): SeriesFile {
  const file: SeriesFile = {
    version: 2,
    series_title: entry.series_title,
    external_ids: { ...entry.external_ids },
    titles: { ...entry.titles },
    synonyms: [...entry.synonyms],
    updated_at: entry.updated_at,
    volumes: []
  };
  if (entry.tag) file.tag = entry.tag;
  if (entry.unit) file.unit = entry.unit;
  return file;
}

/**
 * Which of the two copies of a series wins.
 *
 * Byte-for-byte the rule `buildSeriesFile` uses for facts: a cloud entry with no
 * facts says nothing, so local replaces it; a local entry WITH facts wins ties
 * (that is the same link round-tripping back); a local entry WITHOUT facts is an
 * unlink and needs a strictly newer stamp.
 */
function pickEntry(local: CatalogFileEntry, existing: CatalogFileEntry | undefined) {
  if (!existing) return local;
  if (!hasSeriesFacts(existing)) return local;
  if (hasSeriesFacts(local)) return local.updated_at >= existing.updated_at ? local : existing;
  return local.updated_at > existing.updated_at ? local : existing;
}

/**
 * Build the root `catalog.json` to upload.
 *
 * Union-by-key with the copy already in the cloud (newest facts stamp wins per
 * series) so a device that only knows half the library cannot delete the other
 * half, then pruned against `cloudSeriesTitles` — the folders the current cloud
 * listing actually shows — so a deleted series eventually drops out. Entries are
 * sorted by normalized key so a rebuild that changed nothing produces the same
 * bytes and therefore the same size/mtime, which is what stops every other
 * device re-downloading it.
 *
 * Returns `undefined` when nothing survives: an empty catalog is never worth
 * publishing (and would blank the view for every other device).
 */
export function buildCatalogFile(args: {
  entries: CatalogFileEntry[];
  existing?: CatalogFile;
  cloudSeriesTitles?: Set<string>;
  now?: string;
}): CatalogFile | undefined {
  const { entries, existing, cloudSeriesTitles, now } = args;

  const byKey = new Map<string, CatalogFileEntry>();
  for (const entry of existing?.series ?? []) {
    const key = normalizeSeriesKey(entry.series_title);
    if (key) byKey.set(key, entry);
  }
  for (const entry of entries) {
    const key = normalizeSeriesKey(entry.series_title);
    if (!key) continue;
    byKey.set(key, pickEntry(entry, byKey.get(key)));
  }

  let keys = [...byKey.keys()];
  if (cloudSeriesTitles) {
    const allowed = new Set<string>();
    for (const title of cloudSeriesTitles) {
      const key = normalizeSeriesKey(title);
      if (key) allowed.add(key);
    }
    keys = keys.filter((key) => allowed.has(key));
  }
  keys.sort();

  if (keys.length === 0) return undefined;
  return {
    version: 1,
    updated_at: now ?? new Date().toISOString(),
    series: keys.map((key) => byKey.get(key)!)
  };
}

function parseEntry(value: unknown): CatalogFileEntry | undefined {
  if (!isRecord(value)) return undefined;
  const series_title = value.series_title;
  if (typeof series_title !== 'string' || !series_title.trim()) return undefined;

  const updated_at = normalizeUpdatedAt(value.updated_at);
  if (!updated_at) return undefined;

  const entry: CatalogFileEntry = {
    series_title,
    external_ids: sanitizeExternalIds(value.external_ids),
    titles: sanitizeTitles(value.titles),
    synonyms: sanitizeSynonyms(value.synonyms),
    updated_at
  };
  const tag = sanitizeTag(value.tag);
  if (tag) entry.tag = tag;
  const unit = sanitizeTrackingUnit(value.unit);
  if (unit) entry.unit = unit;
  return entry;
}

/**
 * Validate an untrusted `catalog.json`.
 *
 * Everything here is foreign data — anyone with write access to the folder can
 * change it — so every field goes through the same sanitizers `series.json` and
 * `series-metadata.json` use, bad entries are dropped individually rather than
 * failing the file, unknown keys never survive (they would let per-user state
 * ride along), and every stamp is normalized/clamped because it decides merges
 * by lexicographic comparison.
 */
export function parseCatalogFile(value: unknown): CatalogFile | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version !== 1) return undefined;

  const updated_at = normalizeUpdatedAt(value.updated_at);
  if (!updated_at) return undefined;

  const series: CatalogFileEntry[] = [];
  if (Array.isArray(value.series)) {
    const seen = new Set<string>();
    for (const raw of value.series) {
      const entry = parseEntry(raw);
      if (!entry) continue;
      const key = normalizeSeriesKey(entry.series_title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      series.push(entry);
    }
  }

  return { version: 1, updated_at, series };
}

/**
 * The one serializer every writer uses. Compact on purpose, same as
 * `stringifySeriesFile`: the file is read by machines (this app, mokuro-bunko)
 * and pretty-printing costs bytes on a file that can list thousands of series.
 */
export function stringifyCatalogFile(file: CatalogFile): string {
  return JSON.stringify(file);
}

/**
 * True when `path` is the ROOT `catalog.json`. A nested
 * `<Series>/catalog.json` is somebody else's file, never ours.
 */
export function isCatalogFilePath(path: string): boolean {
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  if (trimmed.includes('/')) return false;
  return trimmed.toLowerCase() === CATALOG_FILE_NAME;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/metadata/catalog-file.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Type-check and format**

Run: `npm run check && npx prettier --write src/lib/metadata/catalog-file.ts src/lib/metadata/catalog-file.test.ts`
Expected: no svelte-check errors introduced.

- [ ] **Step 6: Commit**

```bash
git add src/lib/metadata/catalog-file.ts src/lib/metadata/catalog-file.test.ts
git commit -m "feat(metadata): catalog.json build/parse/serialize"
```

---

### Task 2: `catalog_index` Dexie table + shared stamp comparison

**Files:**

- Create: `src/lib/metadata/catalog-index.ts`
- Test: `src/lib/metadata/catalog-index.test.ts`
- Modify: `src/lib/catalog/db-v3.ts` (add `catalog_index` table + Dexie `version(4)`), `src/lib/metadata/series-index.ts` (extract `sourceStampChanged`), `src/lib/metadata/series-index.test.ts` (cover the extracted helper)

**Interfaces:**

- Consumes: `CatalogFileEntry` from Task 1 (`{ series_title: string; external_ids: SeriesExternalIds; titles: SeriesTitles; synonyms: string[]; tag?: string; unit?: TrackingUnit; updated_at: string }`); `normalizeSeriesKey(title: string): string`; `db` from `$lib/catalog/db`.
- Produces:
  - in `src/lib/metadata/series-index.ts`: `export function sourceStampChanged(source: { provider: string; size: number; modifiedTime: string } | undefined, cloud: { size: number; modifiedTime: string }, provider?: string): boolean` (and `indexNeedsRefresh` now delegates to it — its own signature is unchanged: `indexNeedsRefresh(rec: SeriesIndexRecord | undefined, cloud: { size: number; modifiedTime: string }, provider?: string): boolean`)
  - in `src/lib/metadata/catalog-index.ts`:
    - `export interface CatalogIndexRecord { series_key: string; series_title: string; entry: CatalogFileEntry; source: { provider: string; path: string; size: number; modifiedTime: string }; fetched_at: string }`
    - `export async function listCatalogIndexes(): Promise<CatalogIndexRecord[]>`
    - `export async function putCatalogIndexes(records: CatalogIndexRecord[]): Promise<void>`
    - `export async function deleteCatalogIndexes(seriesKeys: string[]): Promise<void>`
    - `export async function moveCatalogIndexKey(oldTitle: string, newTitle: string): Promise<void>`
    - `export const catalogIndexMap: Readable<Map<string, CatalogIndexRecord>>`
    - `export function catalogNeedsRefresh(rows: CatalogIndexRecord[], cloud: { size: number; modifiedTime: string }, provider?: string): boolean`
  - in `src/lib/catalog/db-v3.ts`: `catalog_index!: Table<CatalogIndexRecord>` on `CatalogDexieV3`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/metadata/catalog-index.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';

vi.mock('$lib/catalog/thumbnails', () => ({ generateThumbnail: vi.fn() }));
vi.mock('$lib/util/progress-tracker', () => ({
  progressTrackerStore: { addProcess: vi.fn(), updateProcess: vi.fn(), removeProcess: vi.fn() }
}));

import { CatalogDexieV3 } from '$lib/catalog/db-v3';
import type { CatalogIndexRecord } from './catalog-index';
import { catalogNeedsRefresh } from './catalog-index';

const DB_NAME = 'mokuro_v3_catalog_index_test';
let db: CatalogDexieV3 | null = null;

afterEach(async () => {
  db?.close();
  db = null;
  await Dexie.delete(DB_NAME);
});

function record(overrides: Partial<CatalogIndexRecord> = {}): CatalogIndexRecord {
  return {
    series_key: 'dr stone (hd scan)',
    series_title: 'Dr Stone (HD Scan)',
    entry: {
      series_title: 'Dr Stone (HD Scan)',
      external_ids: { anilist: 98416 },
      titles: {},
      synonyms: [],
      updated_at: '2026-08-18T19:36:24.324Z'
    },
    source: {
      provider: 'webdav',
      path: 'catalog.json',
      size: 1234,
      modifiedTime: '2026-08-23T00:00:00.000Z'
    },
    fetched_at: '2026-08-23T00:00:01.000Z',
    ...overrides
  };
}

describe('catalog_index table', () => {
  it('stores and reads back a record keyed by series_key', async () => {
    db = new CatalogDexieV3(DB_NAME);
    await db.open();
    await db.catalog_index.put(record());
    expect(await db.catalog_index.get('dr stone (hd scan)')).toMatchObject({
      series_title: 'Dr Stone (HD Scan)'
    });
  });
});

describe('catalogNeedsRefresh', () => {
  const cloud = { size: 1234, modifiedTime: '2026-08-23T00:00:00.000Z' };

  it('is true when nothing is cached', () => {
    expect(catalogNeedsRefresh([], cloud, 'webdav')).toBe(true);
  });

  it('is false when the newest cached stamp matches', () => {
    expect(catalogNeedsRefresh([record()], cloud, 'webdav')).toBe(false);
  });

  it('is true when the size differs', () => {
    expect(catalogNeedsRefresh([record()], { ...cloud, size: 9999 }, 'webdav')).toBe(true);
  });

  it('is true when the cache came from another provider', () => {
    expect(catalogNeedsRefresh([record()], cloud, 'mega')).toBe(true);
  });

  it('treats equivalent ISO representations of one instant as unchanged', () => {
    expect(
      catalogNeedsRefresh(
        [record()],
        { size: 1234, modifiedTime: '2026-08-23T00:00:00+00:00' },
        'webdav'
      )
    ).toBe(false);
  });

  it('uses the newest row when rows disagree', () => {
    const stale = record({
      series_key: 'other',
      source: {
        provider: 'webdav',
        path: 'catalog.json',
        size: 1,
        modifiedTime: '2026-01-01T00:00:00.000Z'
      },
      fetched_at: '2026-01-01T00:00:00.000Z'
    });
    expect(catalogNeedsRefresh([stale, record()], cloud, 'webdav')).toBe(false);
  });
});
```

Add to `src/lib/metadata/series-index.test.ts`:

```ts
describe('sourceStampChanged', () => {
  const cloud = { size: 10, modifiedTime: '2026-08-17T00:00:00.000Z' };

  it('is true with no cached source at all', () => {
    expect(sourceStampChanged(undefined, cloud, 'webdav')).toBe(true);
  });

  it('is false when provider, size and instant all match', () => {
    expect(
      sourceStampChanged(
        { provider: 'webdav', size: 10, modifiedTime: '2026-08-17T00:00:00.000Z' },
        cloud,
        'webdav'
      )
    ).toBe(false);
  });

  it('is true when the cloud modifiedTime does not parse', () => {
    expect(
      sourceStampChanged(
        { provider: 'webdav', size: 10, modifiedTime: '2026-08-17T00:00:00.000Z' },
        { size: 10, modifiedTime: 'whenever' },
        'webdav'
      )
    ).toBe(true);
  });
});
```

(Extend the existing import at the top of `series-index.test.ts` to include `sourceStampChanged`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/metadata/catalog-index.test.ts src/lib/metadata/series-index.test.ts`
Expected: FAIL — `Failed to resolve import "./catalog-index"` and `sourceStampChanged is not a function`.

- [ ] **Step 3: Extract the stamp comparison in `series-index.ts`**

Replace the body of `indexNeedsRefresh` (currently lines 117–134) with a delegating version and add the extracted helper immediately above it:

```ts
/**
 * Has the cloud file changed since a cache record was fetched from `source`?
 *
 * Shared by every stamp-versioned download cache (`series_index`,
 * `catalog_index`) so the comparison rules live in exactly one place:
 *
 * - no cached source → changed (nothing to compare against);
 * - a source from ANOTHER provider says nothing about THIS provider's copy,
 *   whose size/mtime it never saw → changed;
 * - size differs → changed;
 * - `modifiedTime` is compared as parsed instants (epoch ms), not strings, so
 *   `2026-08-17T00:00:00.000Z` and `2026-08-17T00:00:00+00:00` — the same
 *   instant in the different ISO forms providers report — count as unchanged;
 * - an unparseable stamp on either side fails open (treated as changed) rather
 *   than pinning a stale cache forever.
 */
export function sourceStampChanged(
  source: { provider: string; size: number; modifiedTime: string } | undefined,
  cloud: { size: number; modifiedTime: string },
  provider?: string
): boolean {
  if (!source) return true;
  if (provider !== undefined && source.provider !== provider) return true;
  if (source.size !== cloud.size) return true;

  const cachedEpoch = toEpoch(source.modifiedTime);
  const cloudEpoch = toEpoch(cloud.modifiedTime);
  if (cloudEpoch === undefined) return true;
  if (cachedEpoch === undefined) return true;
  return cachedEpoch !== cloudEpoch;
}

/**
 * Should this series' `series.json` be re-downloaded? See `sourceStampChanged`
 * for the rules. Pure — no I/O, so it is cheap to call for every series on every
 * cloud listing.
 */
export function indexNeedsRefresh(
  rec: SeriesIndexRecord | undefined,
  cloud: { size: number; modifiedTime: string },
  provider?: string
): boolean {
  return sourceStampChanged(rec?.source, cloud, provider);
}
```

- [ ] **Step 4: Add the table to the Dexie schema**

In `src/lib/catalog/db-v3.ts`, add the import and field, then a `version(4)` block after the existing `version(3)` block:

```ts
import type { CatalogIndexRecord } from '$lib/metadata/catalog-index';
```

```ts
  series_index!: Table<SeriesIndexRecord>;
  catalog_index!: Table<CatalogIndexRecord>;
```

```ts
// v3.4: cached root catalog.json entries (name/mapping/search data per
// series, plus the cloud file stamp they were fetched at). Keyed the same as
// series_metadata/series_index. Additive — no data migration.
this.version(4).stores({
  volumes: 'volume_uuid, series_uuid, series_title',
  volume_ocr: 'volume_uuid',
  volume_files: 'volume_uuid',
  series_metadata: 'series_key',
  series_index: 'series_key',
  catalog_index: 'series_key'
});
```

- [ ] **Step 5: Write `catalog-index.ts`**

Create `src/lib/metadata/catalog-index.ts`:

```ts
import { db } from '$lib/catalog/db';
import { liveQuery } from 'dexie';
import { readable, type Readable } from 'svelte/store';
import type { CatalogFileEntry } from './catalog-file';
import { normalizeSeriesKey } from './series-key';
import { sourceStampChanged } from './series-index';

/**
 * One series' entry from the root `catalog.json`, plus the cloud file stamp
 * (`size`/`modifiedTime`) the whole file was fetched at. PK =
 * `normalizeSeriesKey(series_title)`, the same key space as `series_metadata`
 * and `series_index`.
 *
 * Purely a download cache and a name source: the facts inside `entry` still flow
 * through `upsertFromSeriesFile` in `store.ts` (which is what applies the
 * factless rules), and nothing here is authoritative over local data. Rows exist
 * so the catalog can list a series by name before anything about its volumes is
 * known — opening it is what fetches `series.json`.
 */
export interface CatalogIndexRecord {
  series_key: string;
  series_title: string;
  entry: CatalogFileEntry;
  source: { provider: string; path: string; size: number; modifiedTime: string };
  fetched_at: string;
}

export async function listCatalogIndexes(): Promise<CatalogIndexRecord[]> {
  return db.catalog_index.toArray();
}

/**
 * Cache several rows at once. The table backs a liveQuery the catalog joins, so
 * a refresh that touched N series must emit ONE change, not N — each emission
 * re-derives the name-only card set for the whole library.
 */
export async function putCatalogIndexes(records: CatalogIndexRecord[]): Promise<void> {
  if (records.length === 0) return;
  await db.catalog_index.bulkPut(records);
}

/** Drop rows in one write, for the same reason `putCatalogIndexes` batches. */
export async function deleteCatalogIndexes(seriesKeys: string[]): Promise<void> {
  if (seriesKeys.length === 0) return;
  await db.catalog_index.bulkDelete(seriesKeys);
}

/**
 * After a series rename: carry the cached entry to the new key. Mirrors
 * `moveSeriesIndexKey` — on a collision the newer `fetched_at` wins rather than
 * the rows being merged, since this is a disposable cache: the loser is simply
 * re-fetched on the next catalog refresh.
 */
export async function moveCatalogIndexKey(oldTitle: string, newTitle: string): Promise<void> {
  const oldKey = normalizeSeriesKey(oldTitle);
  const newKey = normalizeSeriesKey(newTitle);

  await db.transaction('rw', db.catalog_index, async () => {
    const oldRec = await db.catalog_index.get(oldKey);
    if (!oldRec) return;

    if (oldKey === newKey) {
      await db.catalog_index.put({ ...oldRec, series_title: newTitle });
      return;
    }

    const newRec = await db.catalog_index.get(newKey);
    const winner: CatalogIndexRecord =
      newRec && newRec.fetched_at > oldRec.fetched_at
        ? newRec
        : { ...oldRec, series_key: newKey, series_title: newTitle };
    await db.catalog_index.put(winner);
    await db.catalog_index.delete(oldKey);
  });
}

/** Reactive view of the whole table, keyed by series_key. Empty Map before first emission. */
export const catalogIndexMap: Readable<Map<string, CatalogIndexRecord>> = readable(
  new Map<string, CatalogIndexRecord>(),
  (set) => {
    const subscription = liveQuery(() => db.catalog_index.toArray()).subscribe({
      next: (rows) => set(new Map(rows.map((r) => [r.series_key, r]))),
      error: (err) => console.error('catalog_index liveQuery failed:', err)
    });
    return () => subscription.unsubscribe();
  }
);

/**
 * Should the root `catalog.json` be re-downloaded?
 *
 * Every row of a fetch carries that fetch's file stamp, so comparing the NEWEST
 * row is comparing the file. An empty table means "never fetched" (or a catalog
 * that legitimately listed nothing), which is cheap to retry.
 *
 * Pure — no I/O, so it is cheap to call on every cloud listing.
 */
export function catalogNeedsRefresh(
  rows: CatalogIndexRecord[],
  cloud: { size: number; modifiedTime: string },
  provider?: string
): boolean {
  if (rows.length === 0) return true;
  const newest = rows.reduce((a, b) => (a.fetched_at >= b.fetched_at ? a : b));
  return sourceStampChanged(newest.source, cloud, provider);
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/lib/metadata/catalog-index.test.ts src/lib/metadata/series-index.test.ts src/lib/catalog/db-v3.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the whole suite (schema bump touches every DB test)**

Run: `npx vitest run && npm run check`
Expected: PASS, no new type errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/metadata/catalog-index.ts src/lib/metadata/catalog-index.test.ts \
  src/lib/metadata/series-index.ts src/lib/metadata/series-index.test.ts src/lib/catalog/db-v3.ts
git commit -m "feat(catalog): catalog_index table (Dexie v4) + shared stamp comparison"
```

---

### Task 3: Write tolerance — metadata writes never demote a provider

The spec's hardest guarantee: "A provider that rejects metadata writes but serves reads is a first-class configuration (bunko scoped users)." Today a 403/405 on ANY upload runs `WebDAVProvider.handleWriteFailure`, which calls `markAsReadOnly()` and flips the whole provider read-only (hiding backup/upload UI everywhere), and a 401 on a password session calls `markAuthFailed()`, which deletes the stored password and raises `needsAttention`. A bunko scoped user's `series.json` PUT (accepted as an update request) or `catalog.json` PUT (rejected by contract) must do neither.

The failure paths, located at HEAD:

1. `src/lib/util/sync/providers/webdav/webdav-provider.ts:790-793` — `uploadFile` → `classifyWriteError` → `handleWriteFailure` → `markAsReadOnly()` / `markAuthFailed()`. **The only read-only demotion in the codebase** (`grep -rn markAsReadOnly src/` returns just this provider). Drive/MEGA/OneDrive/filesystem have no demotion path — nothing to change there.
2. `src/lib/metadata/series-file-sync.ts:147` — `console.warn` on a failed `series.json` write (spec: log at debug).
3. `src/lib/util/backup-queue.ts:327` — `console.warn` on a failed per-run `series.json` write (spec: log at debug).
4. `src/lib/util/sync/unified-cloud-manager.ts:989` — `console.warn` when the cloud `series.json` cannot be read (a read, kept as-is: it is not a write failure and it gates a clobber).
5. No snackbar exists on any `series.json` path (`grep -n showSnackbar src/lib/metadata/*.ts src/lib/util/backup-queue.ts` → no hits) — keep it that way; `catalog.json` must never add one.

**Files:**

- Modify: `src/lib/util/sync/syncable-file.ts`, `src/lib/util/sync/providers/webdav/webdav-provider.ts`, `src/lib/metadata/series-file-sync.ts`, `src/lib/util/backup-queue.ts`
- Test: `src/lib/util/sync/syncable-file.test.ts` (existing), `src/lib/util/sync/providers/webdav/webdav-write-tolerance.test.ts` (new)

**Interfaces:**

- Consumes: `SERIES_FILE_NAME = 'series.json'` from `$lib/metadata/series-file`; `CATALOG_FILE_NAME = 'catalog.json'` from `$lib/metadata/catalog-file` (Task 1); `classifyWriteError(message: string): WriteErrorKind` from `./webdav-errors`.
- Produces: `export function isBestEffortMetadataPath(path: string): boolean` in `src/lib/util/sync/syncable-file.ts`; `catalog.json` added to `ROOT_CONFIG_FILENAMES` so all five providers list and cache it.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/util/sync/syncable-file.test.ts`:

```ts
import { isBestEffortMetadataPath, isRootConfigFile, isSyncableFile } from './syncable-file';

describe('catalog.json', () => {
  it('is a root config file so every provider lists it', () => {
    expect(isRootConfigFile('catalog.json')).toBe(true);
    expect(isRootConfigFile('CATALOG.JSON')).toBe(true);
    expect(isSyncableFile('catalog.json')).toBe(true);
  });
});

describe('isBestEffortMetadataPath', () => {
  it('covers the two compiled metadata files', () => {
    expect(isBestEffortMetadataPath('catalog.json')).toBe(true);
    expect(isBestEffortMetadataPath('/catalog.json')).toBe(true);
    expect(isBestEffortMetadataPath('Dr Stone/series.json')).toBe(true);
    expect(isBestEffortMetadataPath('series.json')).toBe(true);
  });

  it('does NOT cover progress, profiles or archives', () => {
    expect(isBestEffortMetadataPath('volume-data.json')).toBe(false);
    expect(isBestEffortMetadataPath('profiles.json')).toBe(false);
    expect(isBestEffortMetadataPath('series-metadata.json')).toBe(false);
    expect(isBestEffortMetadataPath('Dr Stone/Volume 1.cbz')).toBe(false);
    expect(isBestEffortMetadataPath('Dr Stone/catalog.json')).toBe(false);
  });
});
```

Create `src/lib/util/sync/providers/webdav/webdav-write-tolerance.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('../../provider-detection', () => ({
  setActiveProviderKey: vi.fn(),
  clearActiveProviderKey: vi.fn()
}));

const uploadFile = vi.fn();
vi.mock('../../core/cloud-provider-core-registry', () => ({
  getCloudProviderCore: () => ({ uploadFile: (...args: unknown[]) => uploadFile(...args) })
}));
vi.mock('../../provider-manager', () => ({ providerManager: { updateStatus: vi.fn() } }));

import { WebDAVProvider } from './webdav-provider';

/** A provider wired past login: a client, a password session, unknown capabilities. */
function connectedProvider(): WebDAVProvider {
  const provider = new WebDAVProvider();
  const internals = provider as unknown as {
    client: unknown;
    _hasPassword: boolean;
    ensureMokuroFolder: () => Promise<void>;
    getWorkerUploadCredentials: () => Promise<unknown>;
  };
  internals.client = {};
  internals._hasPassword = true;
  internals.ensureMokuroFolder = async () => {};
  internals.getWorkerUploadCredentials = async () => ({});
  return provider;
}

beforeEach(() => {
  uploadFile.mockReset();
  localStorage.clear();
  localStorage.setItem('webdav_server_url', 'https://mokuro.moe');
});

describe('best-effort metadata writes', () => {
  it('a rejected catalog.json PUT leaves the provider read-write', async () => {
    const provider = connectedProvider();
    uploadFile.mockRejectedValue(new Error('Request failed with status code 403'));

    await expect(provider.uploadFile('catalog.json', new Blob(['{}']))).rejects.toThrow();
    expect(provider.getStatus().isReadOnly).toBe(false);
    expect(provider.getStatus().needsAttention).toBe(false);
  });

  it('a rejected series.json PUT leaves the provider read-write and keeps the password', async () => {
    const provider = connectedProvider();
    localStorage.setItem('webdav_password', 'hunter2');
    uploadFile.mockRejectedValue(new Error('Request failed with status code 401'));

    await expect(provider.uploadFile('Dr Stone/series.json', new Blob(['{}']))).rejects.toThrow();
    expect(provider.getStatus().isReadOnly).toBe(false);
    expect(provider.getStatus().needsAttention).toBe(false);
    expect(localStorage.getItem('webdav_password')).toBe('hunter2');
  });

  it('still demotes on a rejected ARCHIVE upload (unchanged behaviour)', async () => {
    const provider = connectedProvider();
    uploadFile.mockRejectedValue(new Error('Request failed with status code 403'));

    await expect(provider.uploadFile('Dr Stone/Volume 1.cbz', new Blob(['zip']))).rejects.toThrow();
    expect(provider.getStatus().isReadOnly).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/util/sync/syncable-file.test.ts src/lib/util/sync/providers/webdav/webdav-write-tolerance.test.ts`
Expected: FAIL — `isBestEffortMetadataPath is not a function`; the catalog.json case reports `isReadOnly: true`.

- [ ] **Step 3: Extend the allowlist and add the classifier**

In `src/lib/util/sync/syncable-file.ts`, add the import, extend the set, and append the new predicate:

```ts
import { CATALOG_FILE_NAME } from '$lib/metadata/catalog-file';
import { SERIES_FILE_NAME } from '$lib/metadata/series-file';

const ROOT_CONFIG_FILENAMES = new Set([
  'volume-data.json',
  'profiles.json',
  'series-metadata.json',
  CATALOG_FILE_NAME
]);
```

```ts
/**
 * Is this path one of the COMPILED metadata files — `<Series>/series.json` or
 * the root `catalog.json`?
 *
 * Writing them is best-effort by contract: on a bunko-backed library the server
 * compiles both, a scoped user's `catalog.json` PUT is rejected outright and a
 * `series.json` PUT is an update *request*. A rejection there says nothing about
 * whether the account can write progress or upload archives, so it must never
 * demote the provider to read-only, never clear stored credentials and never
 * surface UI. Progress (`volume-data.json`), profiles and `series-metadata.json`
 * are deliberately NOT in this set: those are the user's own state, and a
 * silent failure there really is a problem worth surfacing.
 */
export function isBestEffortMetadataPath(path: string): boolean {
  const basename = basenameOf(path).toLowerCase();
  if (basename === SERIES_FILE_NAME) return true;
  // catalog.json only counts at the ROOT — a nested one is somebody else's file.
  return basename === CATALOG_FILE_NAME && !path.replace(/^\/+|\/+$/g, '').includes('/');
}
```

- [ ] **Step 4: Stop the WebDAV demotion for those paths**

In `src/lib/util/sync/providers/webdav/webdav-provider.ts`, add the import and guard the classifier call inside `uploadFile` (currently lines 787–793):

```ts
import { isBestEffortMetadataPath, isSyncableFile } from '../../syncable-file';
```

```ts
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Compiled metadata files are best-effort: a server that compiles them
      // itself (mokuro-bunko) rejects the write by design, and that says
      // nothing about progress sync or archive uploads. Demoting the provider
      // here would hide backup and upload for a perfectly writable account.
      if (!isBestEffortMetadataPath(path)) {
        const kind = classifyWriteError(errorMessage);
        if (kind !== 'other') {
          this.handleWriteFailure(kind, 'Write permission denied - server is read-only');
        }
      }

      throw new ProviderError(
        `Failed to upload file: ${errorMessage}`,
        'webdav',
        'UPLOAD_FAILED',
        false,
        true,
        'unknown'
      );
    }
```

- [ ] **Step 5: Drop the failure logs to debug**

In `src/lib/metadata/series-file-sync.ts`, `runWrite`'s catch (line 147):

```ts
  } catch (error) {
    // Best-effort by contract: the next fact edit or backup rewrites the file.
    console.debug(`[series-file-sync] could not write series.json for '${seriesTitle}':`, error);
  }
```

In `src/lib/util/backup-queue.ts`, `writeSeriesIndexesForRun`'s catch (line 327):

```ts
    } catch (error) {
      // Best-effort by contract: never fails a backup that succeeded.
      console.debug(`[Backup Queue] could not write series.json for '${seriesTitle}':`, error);
    }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/lib/util/sync/syncable-file.test.ts src/lib/util/sync/providers/webdav/webdav-write-tolerance.test.ts src/lib/metadata/series-file-sync.test.ts`
Expected: PASS.

- [ ] **Step 7: Confirm no other demotion or snackbar path exists**

Run:

```bash
grep -rn "markAsReadOnly\|markAuthFailed" src/ | grep -v ".test.ts"
grep -rn "showSnackbar" src/lib/metadata/ src/lib/util/backup-queue.ts
```

Expected: `markAsReadOnly`/`markAuthFailed` appear ONLY in `webdav-provider.ts` (definition + the two guarded call sites); zero `showSnackbar` hits in `src/lib/metadata/` and `backup-queue.ts`. Record the output in the task report.

- [ ] **Step 8: Commit**

```bash
git add src/lib/util/sync/syncable-file.ts src/lib/util/sync/syncable-file.test.ts \
  src/lib/util/sync/providers/webdav/webdav-provider.ts \
  src/lib/util/sync/providers/webdav/webdav-write-tolerance.test.ts \
  src/lib/metadata/series-file-sync.ts src/lib/util/backup-queue.ts
git commit -m "fix(sync): metadata writes are best-effort and never demote a provider"
```

---

### Task 4: `serverCompilesMetadata` flag + `writeCatalogFile()`

**Files:**

- Modify: `src/lib/util/sync/provider-interface.ts`, `src/lib/util/sync/unified-provider-state.ts`, `src/lib/util/sync/providers/webdav/webdav-provider.ts`, `src/lib/util/sync/unified-cloud-manager.ts`
- Test: `src/lib/util/sync/unified-cloud-manager.test.ts` (existing file, new describe block)

**Interfaces:**

- Consumes (Task 1): `CATALOG_FILE_NAME`, `buildCatalogFile(args: { entries: CatalogFileEntry[]; existing?: CatalogFile; cloudSeriesTitles?: Set<string>; now?: string }): CatalogFile | undefined`, `catalogEntryFromMeta(seriesTitle: string, meta: SeriesMetadata | undefined): CatalogFileEntry`, `parseCatalogFile(value: unknown): CatalogFile | undefined`, `stringifyCatalogFile(file: CatalogFile): string`, `isCatalogFilePath(path: string): boolean`.
- Consumes (Task 2): `CatalogIndexRecord`, `listCatalogIndexes()`, `putCatalogIndexes(records: CatalogIndexRecord[]): Promise<void>`, `catalogNeedsRefresh(rows, cloud, provider?)`, `deleteCatalogIndexes(seriesKeys: string[]): Promise<void>`, `moveCatalogIndexKey(oldTitle, newTitle)`.
- Produces:
  - `ProviderStatus.serverCompilesMetadata?: boolean` (optional; absent/false = the client may produce the files)
  - `UnifiedProviderState.serverCompilesMetadata: boolean`
  - `unifiedCloudManager.writeCatalogFile(): Promise<'written' | 'skipped' | 'read-only' | 'server-compiled'>`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/util/sync/unified-cloud-manager.test.ts`. The file already mocks
`cache-manager` (`getAllFiles`, `getBySeries`, `getCache`), `provider-manager`
(`getActiveProvider`), `$lib/catalog/db` and `$lib/metadata/store`. Extend the two
existing mock factories in place — add `getAllSeriesMetadata` to the
`$lib/metadata/store` factory, and add a new `$lib/metadata/catalog-index` factory —
then append the describe block:

```ts
// --- extend the existing $lib/metadata/store mock factory with: ---
const getAllSeriesMetadata = vi.fn(async (): Promise<Record<string, unknown>> => ({}));
// inside the existing vi.mock('$lib/metadata/store', () => ({ … })) object:
//   getAllSeriesMetadata: () => getAllSeriesMetadata(),

// --- new mock, next to the series-index one: ---
const catalogRows = vi.fn(async (): Promise<unknown[]> => []);
const putCatalogIndexes = vi.fn(async (_recs: unknown[]) => {});
const deleteCatalogIndexes = vi.fn(async (_keys: string[]) => {});
vi.mock('$lib/metadata/catalog-index', async () => {
  const actual = await vi.importActual<typeof import('$lib/metadata/catalog-index')>(
    '$lib/metadata/catalog-index'
  );
  return {
    // The real size/mtime comparison decides whether the write re-reads first.
    catalogNeedsRefresh: actual.catalogNeedsRefresh,
    listCatalogIndexes: () => catalogRows(),
    putCatalogIndexes: (recs: unknown[]) => putCatalogIndexes(recs),
    deleteCatalogIndexes: (keys: string[]) => deleteCatalogIndexes(keys),
    moveCatalogIndexKey: vi.fn(async () => {})
  };
});
```

```ts
describe('writeCatalogFile', () => {
  const listing: CloudFileMetadata[] = [
    {
      provider: 'webdav',
      fileId: 'f1',
      path: 'Dr Stone/Volume 1.cbz',
      size: 10,
      modifiedTime: '2026-08-23T00:00:00.000Z'
    },
    {
      provider: 'webdav',
      fileId: 'f2',
      path: 'Other/Volume 1.cbz',
      size: 10,
      modifiedTime: '2026-08-23T00:00:00.000Z'
    },
    {
      provider: 'webdav',
      fileId: 'cat',
      path: 'catalog.json',
      size: 5,
      modifiedTime: '2026-08-22T00:00:00.000Z'
    }
  ];

  const CLOUD_CATALOG = {
    version: 1,
    updated_at: '2026-08-22T00:00:00.000Z',
    series: [
      {
        series_title: 'Other',
        external_ids: { anilist: 1 },
        titles: {},
        synonyms: [],
        updated_at: '2026-08-22T00:00:00.000Z'
      },
      {
        series_title: 'Gone',
        external_ids: {},
        titles: {},
        synonyms: [],
        updated_at: '2026-08-22T00:00:00.000Z'
      }
    ]
  };

  let uploadFile: ReturnType<typeof vi.fn>;

  function provider(statusOverrides: Record<string, unknown> = {}) {
    uploadFile = vi.fn(async () => 'uploaded-fileid');
    return {
      type: 'webdav',
      getStatus: vi.fn(() => ({
        isAuthenticated: true,
        hasStoredCredentials: true,
        needsAttention: false,
        statusMessage: 'Connected',
        isReadOnly: false,
        serverCompilesMetadata: false,
        ...statusOverrides
      })),
      uploadFile,
      downloadFile: vi.fn(async () => new Blob([JSON.stringify(CLOUD_CATALOG)]))
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    catalogRows.mockResolvedValue([]);
    getAllSeriesMetadata.mockResolvedValue({});
    getAllFiles.mockReturnValue(listing);
    getCache.mockReturnValue(null);
  });

  it('skips entirely on a server-compiled provider', async () => {
    getActiveProvider.mockReturnValue(provider({ serverCompilesMetadata: true }));
    await expect(unifiedCloudManager.writeCatalogFile()).resolves.toBe('server-compiled');
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('skips on a read-only provider', async () => {
    getActiveProvider.mockReturnValue(provider({ isReadOnly: true }));
    await expect(unifiedCloudManager.writeCatalogFile()).resolves.toBe('read-only');
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('skips when the listing shows no series folders', async () => {
    getActiveProvider.mockReturnValue(provider());
    getAllFiles.mockReturnValue([]);
    await expect(unifiedCloudManager.writeCatalogFile()).resolves.toBe('skipped');
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('publishes compact JSON unioned with the cloud copy and pruned to the listing', async () => {
    getActiveProvider.mockReturnValue(provider());
    getAllSeriesMetadata.mockResolvedValue({
      'dr stone': {
        series_key: 'dr stone',
        series_title: 'Dr Stone',
        external_ids: { anilist: 98416 },
        titles: {},
        synonyms: [],
        read_count: 0,
        updated_at: '2026-08-23T00:00:00.000Z',
        facts_updated_at: '2026-08-23T00:00:00.000Z'
      }
    });

    await expect(unifiedCloudManager.writeCatalogFile()).resolves.toBe('written');

    const [path, blob] = uploadFile.mock.calls.at(-1)!;
    expect(path).toBe('catalog.json');
    const text = await (blob as Blob).text();
    expect(text).not.toContain('\n'); // compact, never pretty-printed
    const written = JSON.parse(text);
    expect(written.version).toBe(1);
    // 'Dr Stone' from this device, 'Other' carried through from the cloud copy,
    // 'Gone' pruned because the listing has no such folder.
    expect(written.series.map((s: { series_title: string }) => s.series_title)).toEqual([
      'Dr Stone',
      'Other'
    ]);
    expect(written.series[0].external_ids).toEqual({ anilist: 98416 });

    // The cache is stamped so the very next listing does not re-download our own write.
    const cached = putCatalogIndexes.mock.calls.at(-1)![0] as Array<{ series_key: string }>;
    expect(cached.map((r) => r.series_key)).toEqual(['dr stone', 'other']);
  });

  it('drops cached rows of THIS provider whose series left the catalog', async () => {
    getActiveProvider.mockReturnValue(provider());
    catalogRows.mockResolvedValue([
      {
        series_key: 'gone',
        series_title: 'Gone',
        entry: {
          series_title: 'Gone',
          external_ids: {},
          titles: {},
          synonyms: [],
          updated_at: '1970-01-01T00:00:00.000Z'
        },
        source: {
          provider: 'webdav',
          path: 'catalog.json',
          size: 5,
          modifiedTime: '2026-08-22T00:00:00.000Z'
        },
        fetched_at: '2026-08-22T00:00:00.000Z'
      }
    ]);
    await unifiedCloudManager.writeCatalogFile();
    expect(deleteCatalogIndexes).toHaveBeenCalledWith(['gone']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/util/sync/unified-cloud-manager.test.ts -t writeCatalogFile`
Expected: FAIL — `unifiedCloudManager.writeCatalogFile is not a function`.

- [ ] **Step 3: Add the provider flag**

`src/lib/util/sync/provider-interface.ts` — extend `ProviderStatus`:

```ts
export interface ProviderStatus {
  isAuthenticated: boolean;
  /** Whether credentials are configured (even if not currently connected) */
  hasStoredCredentials: boolean;
  needsAttention: boolean;
  statusMessage: string;
  /** Whether the provider is in read-only mode (e.g., WebDAV without write permissions) */
  isReadOnly?: boolean;
  /**
   * The server compiles `series.json` and `catalog.json` itself (mokuro-bunko).
   * Clients must not produce those files for it: bunko is the sole producer, and
   * a client write would race its regeneration. Absent/false = a plain storage
   * backend, where the client is the producer.
   */
  serverCompilesMetadata?: boolean;
}
```

`src/lib/util/sync/providers/webdav/webdav-provider.ts` — record it at login and report it:

```ts
  /** The server answered the mokuro-bunko identity endpoint: it compiles the metadata files. */
  private _serverCompilesMetadata = false;
```

In `login()`, inside the identity `switch`: set `this._serverCompilesMetadata = true;` in BOTH the `'authenticated'` and `'anonymous'` cases (both prove the endpoint answered in bunko's contract shape), and `this._serverCompilesMetadata = false;` in the `'unsupported'`/default case. In `logout()`, next to `this._capabilities = null;`, add `this._serverCompilesMetadata = false;`. In `getStatus()`, add `serverCompilesMetadata: this._serverCompilesMetadata` to the returned object.

`src/lib/util/sync/unified-provider-state.ts` — add `serverCompilesMetadata: boolean` to `UnifiedProviderState`, `serverCompilesMetadata: false` to both early-return objects, and `serverCompilesMetadata: status.serverCompilesMetadata ?? false` to the final object.

- [ ] **Step 4: Implement `writeCatalogFile`**

In `src/lib/util/sync/unified-cloud-manager.ts`, add the imports:

```ts
import {
  CATALOG_FILE_NAME,
  buildCatalogFile,
  catalogEntryFromMeta,
  isCatalogFilePath,
  parseCatalogFile,
  stringifyCatalogFile,
  type CatalogFile
} from '$lib/metadata/catalog-file';
import {
  catalogNeedsRefresh,
  deleteCatalogIndexes,
  listCatalogIndexes,
  moveCatalogIndexKey,
  putCatalogIndexes,
  type CatalogIndexRecord
} from '$lib/metadata/catalog-index';
import { getAllSeriesMetadata } from '$lib/metadata/store';
```

Add these members after `writeSeriesFile`:

```ts
  /** The root `catalog.json` entry of the current listing, if any. */
  private getCloudCatalogFile(): CloudFileMetadata | undefined {
    const candidates = this.getAllCloudVolumes().filter((file) => isCatalogFilePath(file.path));
    return candidates.reduce<CloudFileMetadata | undefined>(
      (newest, file) =>
        !newest || (file.modifiedTime ?? '') > (newest.modifiedTime ?? '') ? file : newest,
      undefined
    );
  }

  /** Every series FOLDER the current listing shows (folder name, never derived). */
  private cloudSeriesTitles(): Set<string> {
    const titles = new Set<string>();
    for (const file of this.getAllCloudVolumes()) {
      const parts = normalizeCloudPath(file.path).split('/');
      if (parts.length !== 2) continue;
      if (!parts[1].toLowerCase().endsWith('.cbz')) continue;
      titles.add(parts[0]);
    }
    return titles;
  }

  /**
   * The catalog copy to merge on top of: the cached rows, unless the listing
   * shows a different (size, modifiedTime) — then another device wrote it after
   * our last fetch, so we re-read it first and the union keeps that device's
   * series. Throws when the re-read fails: writing on top of a copy we could not
   * read would silently clobber it.
   */
  private async resolveExistingCatalogFile(
    providerType: ProviderType
  ): Promise<CatalogFile | undefined> {
    const rows = await listCatalogIndexes();
    const cachedFile = (): CatalogFile | undefined =>
      rows.length === 0
        ? undefined
        : { version: 1, updated_at: new Date(0).toISOString(), series: rows.map((r) => r.entry) };

    const cloudFile = this.getCloudCatalogFile();
    if (!cloudFile) return cachedFile();

    const stamp = { size: cloudFile.size ?? 0, modifiedTime: cloudFile.modifiedTime ?? '' };
    if (!catalogNeedsRefresh(rows, stamp, providerType)) return cachedFile();

    const blob = await this.downloadFile(cloudFile);
    let fresh: CatalogFile | undefined;
    try {
      fresh = parseCatalogFile(JSON.parse(await blob.text()));
    } catch {
      fresh = undefined;
    }
    // Junk in the cloud (hand-edited, truncated, a proxy error page): this write
    // replaces it, but the series other devices published are still known from
    // the last good fetch, so merge on top of the CACHE rather than nothing.
    return fresh ?? cachedFile();
  }

  /**
   * Write the root `catalog.json` — the name/mapping/search data for every
   * series folder the cloud holds.
   *
   * Union-by-key with the copy already in the cloud (newest facts stamp wins per
   * series, `buildCatalogFile`) so a device that only holds part of the library
   * cannot delete the rest, then pruned against the listing so a deleted folder
   * drops out. Never written when the listing is empty: that means "not fetched"
   * as often as "empty cloud", and publishing an empty catalog would blank every
   * other device's view.
   *
   * `'server-compiled'` on a bunko-backed provider: bunko is the sole producer of
   * this file, and a client write would race its regeneration.
   */
  async writeCatalogFile(): Promise<'written' | 'skipped' | 'read-only' | 'server-compiled'> {
    const provider = this.getActiveProvider();
    if (!provider) return 'skipped';
    const status = provider.getStatus();
    if (status.serverCompilesMetadata) return 'server-compiled';
    if (status.isReadOnly) return 'read-only';

    const cloudTitles = this.cloudSeriesTitles();
    if (cloudTitles.size === 0) return 'skipped';

    let existing: CatalogFile | undefined;
    try {
      existing = await this.resolveExistingCatalogFile(provider.type);
    } catch (error) {
      console.debug('Could not read the cloud catalog.json:', error);
      return 'skipped';
    }

    const metaByKey = await getAllSeriesMetadata();
    const entries = [...cloudTitles].map((title) =>
      catalogEntryFromMeta(title, metaByKey[normalizeSeriesKey(title)])
    );

    const file = buildCatalogFile({ entries, existing, cloudSeriesTitles: cloudTitles });
    if (!file) return 'skipped';

    const blob = new Blob([stringifyCatalogFile(file)], { type: 'application/json' });
    await this.uploadFile(CATALOG_FILE_NAME, blob);

    // Stamp the cache with EXACTLY what the file cache now holds for this path
    // (read back rather than re-derived), same reason as `writeSeriesFile`: a
    // second `new Date()` here would differ from the entry `uploadFile` just
    // added and make the very next listing re-download our own write.
    const uploaded = this.getCloudCatalogFile();
    const now = new Date().toISOString();
    const source = {
      provider: provider.type,
      path: CATALOG_FILE_NAME,
      size: uploaded?.size ?? blob.size,
      modifiedTime: uploaded?.modifiedTime ?? now
    };
    const records: CatalogIndexRecord[] = file.series.map((entry) => ({
      series_key: normalizeSeriesKey(entry.series_title),
      series_title: entry.series_title,
      entry,
      source,
      fetched_at: now
    }));
    const keep = new Set(records.map((r) => r.series_key));
    const stale = (await listCatalogIndexes())
      .filter((row) => row.source.provider === provider.type && !keep.has(row.series_key))
      .map((row) => row.series_key);
    await deleteCatalogIndexes(stale);
    await putCatalogIndexes(records);
    return 'written';
  }
```

- [ ] **Step 5: Keep the catalog cache in step with renames and deletes**

In `deleteSeriesFolder` (next to the existing `deleteSeriesIndex` call, around line 1071):

```ts
try {
  await deleteCatalogIndexes([normalizeSeriesKey(seriesTitle)]);
} catch (error) {
  console.debug(`Could not drop the cached catalog entry for '${seriesTitle}':`, error);
}
```

In `moveSeriesFileAfterRename` (next to the existing `moveSeriesIndexKey` call, around line 1043) and in the other rename path at line 826:

```ts
await moveCatalogIndexKey(oldSeriesTitle, newSeriesTitle);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/lib/util/sync/unified-cloud-manager.test.ts && npm run check`
Expected: PASS, no new type errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/util/sync/provider-interface.ts src/lib/util/sync/unified-provider-state.ts \
  src/lib/util/sync/providers/webdav/webdav-provider.ts \
  src/lib/util/sync/unified-cloud-manager.ts src/lib/util/sync/unified-cloud-manager.test.ts
git commit -m "feat(sync): writeCatalogFile + serverCompilesMetadata provider flag"
```

---

### Task 5: Debounced client production of `catalog.json`

**Files:**

- Create: `src/lib/metadata/catalog-file-sync.ts`
- Test: `src/lib/metadata/catalog-file-sync.test.ts`
- Modify: `src/lib/metadata/series-file-sync.ts` (export the coalesced listing refresh), `src/lib/util/backup-queue.ts` (write the catalog once per run), `src/routes/+layout.svelte` (mount)

**Interfaces:**

- Consumes: `unifiedCloudManager.writeCatalogFile(): Promise<'written' | 'skipped' | 'read-only' | 'server-compiled'>` (Task 4); `registerFactsChangeListener(fn: (seriesTitle: string) => void): () => void` from `$lib/metadata/store`; `providerManager.status` (a `Readable<{ hasAnyAuthenticated: boolean; currentProviderType: ProviderType | null; providers: Record<ProviderType, ProviderStatus | null> }>`).
- Produces:
  - in `src/lib/metadata/series-file-sync.ts`: `export function ensureFreshCloudListing(): Promise<boolean>` (the existing private `refreshCloudListing`, renamed and exported — same coalescing, `LISTING_TTL_MS = 30_000`, `LISTING_TIMEOUT_MS = 60_000`, same `_resetListingRefreshForTests()` hook)
  - in `src/lib/metadata/catalog-file-sync.ts`: `export const CATALOG_FILE_WRITE_DEBOUNCE_MS = 5000`, `export function scheduleCatalogFileWrite(): void`, `export async function flushCatalogFileWrites(): Promise<void>`, `export function initCatalogFileSync(): () => void`

- [ ] **Step 1: Write the failing test**

Create `src/lib/metadata/catalog-file-sync.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';

vi.mock('$app/environment', () => ({ browser: true }));

let status = {
  hasAnyAuthenticated: true,
  currentProviderType: 'webdav' as string | null,
  providers: { webdav: { isReadOnly: false, serverCompilesMetadata: false } } as Record<
    string,
    { isReadOnly?: boolean; serverCompilesMetadata?: boolean } | null
  >
};
vi.mock('$lib/util/sync/provider-manager', () => ({
  providerManager: {
    get status() {
      return readable(status);
    }
  }
}));

const writeCatalogFile = vi.fn(async () => 'written' as const);
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: { writeCatalogFile: () => writeCatalogFile() }
}));

const ensureFreshCloudListing = vi.fn(async () => true);
vi.mock('$lib/metadata/series-file-sync', () => ({
  ensureFreshCloudListing: () => ensureFreshCloudListing()
}));

const listeners: Array<(title: string) => void> = [];
vi.mock('$lib/metadata/store', () => ({
  registerFactsChangeListener: (fn: (title: string) => void) => {
    listeners.push(fn);
    return () => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }
}));

import {
  CATALOG_FILE_WRITE_DEBOUNCE_MS,
  flushCatalogFileWrites,
  initCatalogFileSync,
  scheduleCatalogFileWrite
} from './catalog-file-sync';

beforeEach(() => {
  writeCatalogFile.mockClear();
  ensureFreshCloudListing.mockClear();
  listeners.length = 0;
  status = {
    hasAnyAuthenticated: true,
    currentProviderType: 'webdav',
    providers: { webdav: { isReadOnly: false, serverCompilesMetadata: false } }
  };
});

describe('scheduleCatalogFileWrite', () => {
  it('coalesces a burst of edits into ONE write', async () => {
    vi.useFakeTimers();
    scheduleCatalogFileWrite();
    scheduleCatalogFileWrite();
    scheduleCatalogFileWrite();
    await vi.advanceTimersByTimeAsync(CATALOG_FILE_WRITE_DEBOUNCE_MS + 10);
    vi.useRealTimers();
    expect(writeCatalogFile).toHaveBeenCalledTimes(1);
  });

  it('skips when the provider is read-only', async () => {
    status.providers.webdav = { isReadOnly: true };
    scheduleCatalogFileWrite();
    await flushCatalogFileWrites();
    expect(writeCatalogFile).not.toHaveBeenCalled();
  });

  it('skips when the server compiles the file itself', async () => {
    status.providers.webdav = { isReadOnly: false, serverCompilesMetadata: true };
    scheduleCatalogFileWrite();
    await flushCatalogFileWrites();
    expect(writeCatalogFile).not.toHaveBeenCalled();
  });

  it('skips when no provider is connected', async () => {
    status = { hasAnyAuthenticated: false, currentProviderType: null, providers: {} };
    scheduleCatalogFileWrite();
    await flushCatalogFileWrites();
    expect(writeCatalogFile).not.toHaveBeenCalled();
  });

  it('skips when the cloud listing could not be refreshed', async () => {
    ensureFreshCloudListing.mockResolvedValueOnce(false);
    scheduleCatalogFileWrite();
    await flushCatalogFileWrites();
    expect(writeCatalogFile).not.toHaveBeenCalled();
  });

  it('never rejects when the write throws', async () => {
    writeCatalogFile.mockRejectedValueOnce(new Error('403 Forbidden'));
    scheduleCatalogFileWrite();
    await expect(flushCatalogFileWrites()).resolves.toBeUndefined();
  });
});

describe('initCatalogFileSync', () => {
  it('schedules a write on a local fact edit and is idempotent', async () => {
    const dispose = initCatalogFileSync();
    expect(initCatalogFileSync()).toBe(dispose);
    expect(listeners).toHaveLength(1);

    listeners[0]('Dr Stone');
    await flushCatalogFileWrites();
    expect(writeCatalogFile).toHaveBeenCalledTimes(1);

    dispose();
    expect(listeners).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/metadata/catalog-file-sync.test.ts`
Expected: FAIL — `Failed to resolve import "./catalog-file-sync"`.

- [ ] **Step 3: Export the listing refresh from `series-file-sync.ts`**

Rename the private `refreshCloudListing` to an exported `ensureFreshCloudListing` (body unchanged; update the two internal call sites in `runWrite` and the doc comment), so the catalog writer shares the SAME coalesced, TTL-cached listing instead of starting a second whole-account fetch:

```ts
/**
 * Refresh the cloud listing (coalesced, TTL-cached). `false` = the view is still
 * stale. Shared by both metadata writers (`series.json` and `catalog.json`):
 * both merge and prune against the listing, and a burst of edits must cost at
 * most one whole-account fetch.
 */
export function ensureFreshCloudListing(): Promise<boolean> {
```

- [ ] **Step 4: Write `catalog-file-sync.ts`**

Create `src/lib/metadata/catalog-file-sync.ts`:

```ts
import { browser } from '$app/environment';
import { get } from 'svelte/store';
import { providerManager } from '$lib/util/sync/provider-manager';
import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
import { ensureFreshCloudListing } from './series-file-sync';
import { registerFactsChangeListener } from './store';

/**
 * The automatic producer of the root `catalog.json` for backends that do not
 * compile it themselves (Drive / MEGA / WebDAV / OneDrive / Local Folder).
 *
 * Same three rules as `series-file-sync.ts`, one file instead of N:
 *
 * - Debounced globally — the file lists every series, so a tagging spree or an
 *   import batch must write it ONCE, not per series. Longer than the per-series
 *   debounce for exactly that reason.
 * - Gated on a writable connected provider that is NOT server-compiled: bunko is
 *   the sole producer of its own catalog, and a client write would race its
 *   regeneration (and be rejected for scoped users anyway).
 * - Preceded by the shared listing refresh, because the write merges and prunes
 *   against that listing — and skipped outright when the refresh fails, rather
 *   than publishing a catalog built from a view we know may be hours old.
 *
 * Failures are logged at debug and dropped: the next fact edit or backup run
 * rewrites the file. Nothing here ever surfaces UI.
 */

/** Long enough to swallow a whole tagging spree or import batch. */
export const CATALOG_FILE_WRITE_DEBOUNCE_MS = 5000;

let timer: ReturnType<typeof setTimeout> | null = null;

/** A connected provider that can be written to AND does not compile the file itself. */
function canProduceCatalog(): boolean {
  const status = get(providerManager.status);
  if (!status.hasAnyAuthenticated) return false;
  const type = status.currentProviderType;
  if (!type) return false;
  const provider = status.providers[type];
  if (!provider) return false;
  if (provider.isReadOnly === true) return false;
  return provider.serverCompilesMetadata !== true;
}

async function runWrite(): Promise<void> {
  timer = null;
  try {
    if (!canProduceCatalog()) return;
    if (!(await ensureFreshCloudListing())) return;
    await unifiedCloudManager.writeCatalogFile();
  } catch (error) {
    // Best-effort by contract: never a snackbar, never a read-only fallback.
    console.debug('[catalog-file-sync] could not write catalog.json:', error);
  }
}

/**
 * Queue a `catalog.json` write, coalescing anything already queued. Safe to call
 * from any edit path — the gates are evaluated when the timer fires, not now.
 */
export function scheduleCatalogFileWrite(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void runWrite(), CATALOG_FILE_WRITE_DEBOUNCE_MS);
}

/** Run a queued write now (cancelling its timer). For tests, teardown and backup runs. */
export async function flushCatalogFileWrites(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await runWrite();
}

let teardown: (() => void) | null = null;

/**
 * Subscribe the debounced writer to local fact edits. Idempotent — a second call
 * while one is live returns the same disposer instead of registering the
 * listener twice. Mounted once in `+layout.svelte`.
 */
export function initCatalogFileSync(): () => void {
  if (!browser) return () => {};
  if (teardown) return teardown;

  // The series title is irrelevant here: the catalog lists them all, so ANY
  // fact edit means the file is stale.
  const unregister = registerFactsChangeListener(() => scheduleCatalogFileWrite());

  const dispose = () => {
    if (teardown !== dispose) return;
    teardown = null;
    unregister();
    if (timer) clearTimeout(timer);
    timer = null;
  };

  teardown = dispose;
  return dispose;
}
```

- [ ] **Step 5: Write the catalog once per backup run**

In `src/lib/util/backup-queue.ts`, import `flushCatalogFileWrites` and call it at the end of `finishBackupRun`, after the per-series files are published (a run that added a new series folder changes the catalog):

```ts
import { flushCatalogFileWrites } from '$lib/metadata/catalog-file-sync';
```

```ts
export async function finishBackupRun(): Promise<void> {
  await unifiedCloudManager.fetchAllCloudVolumes({ refreshIndexes: false });
  await writeSeriesIndexesForRun();
  // The run may have created or removed whole series folders, which is exactly
  // what the root catalog lists. One write for the whole run.
  await flushCatalogFileWrites();
  unifiedCloudManager.refreshSeriesIndexesInBackground();
}
```

- [ ] **Step 6: Mount it**

In `src/routes/+layout.svelte`, next to the existing `initSeriesFileSync()` call (line 102):

```ts
import { initCatalogFileSync } from '$lib/metadata/catalog-file-sync';
```

```ts
initSeriesFileSync();
initCatalogFileSync();
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run src/lib/metadata/catalog-file-sync.test.ts src/lib/metadata/series-file-sync.test.ts && npm run check`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/metadata/catalog-file-sync.ts src/lib/metadata/catalog-file-sync.test.ts \
  src/lib/metadata/series-file-sync.ts src/lib/util/backup-queue.ts src/routes/+layout.svelte
git commit -m "feat(metadata): debounced client production of catalog.json"
```

---

### Task 6: Catalog-open fetch / merge / prune of `catalog.json`

**Files:**

- Create: `src/lib/metadata/catalog-index-sync.ts`
- Test: `src/lib/metadata/catalog-index-sync.test.ts`
- Modify: `src/lib/util/sync/unified-cloud-manager.ts` (`refreshSeriesIndexesInBackground` also kicks the catalog refresh)

**Interfaces:**

- Consumes (Task 1): `isCatalogFilePath(path: string): boolean`, `parseCatalogFile(value: unknown): CatalogFile | undefined`, `catalogEntryToSeriesFile(entry: CatalogFileEntry): SeriesFile`.
- Consumes (Task 2): `CatalogIndexRecord`, `listCatalogIndexes()`, `putCatalogIndexes(records: CatalogIndexRecord[]): Promise<void>`, `deleteCatalogIndexes(seriesKeys: string[]): Promise<void>`, `catalogNeedsRefresh(rows, cloud, provider?)`.
- Consumes (existing): `upsertFromSeriesFile(seriesTitle: string, file: SeriesFile): Promise<boolean>`; `providerManager.getActiveProvider(): SyncProvider | null`; `provider.downloadFile(file: CloudFileMetadata): Promise<Blob>`.
- Produces: `export function refreshCatalogIndex(cloudFilesMap: Map<string, CloudFileMetadata[]>, providerType: ProviderType): Promise<void>` — never rejects; coalesced (one in-flight run, newest request queued), provider-bound, listing-gated.

- [ ] **Step 1: Write the failing test**

Create `src/lib/metadata/catalog-index-sync.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudFileMetadata } from '$lib/util/sync/provider-interface';
import type { CatalogIndexRecord } from './catalog-index';

const getActiveProvider = vi.fn();
vi.mock('$lib/util/sync/provider-manager', () => ({ providerManager: { getActiveProvider } }));
vi.mock('$lib/catalog/db', () => ({ db: {} }));

const listCatalogIndexes = vi.fn(async (): Promise<CatalogIndexRecord[]> => []);
const putCatalogIndexes = vi.fn(async (_recs: CatalogIndexRecord[]) => {});
const deleteCatalogIndexes = vi.fn(async (_keys: string[]) => {});
vi.mock('$lib/metadata/catalog-index', async () => {
  const actual = await vi.importActual<typeof import('$lib/metadata/catalog-index')>(
    '$lib/metadata/catalog-index'
  );
  return {
    catalogNeedsRefresh: actual.catalogNeedsRefresh,
    listCatalogIndexes: () => listCatalogIndexes(),
    putCatalogIndexes: (recs: CatalogIndexRecord[]) => putCatalogIndexes(recs),
    deleteCatalogIndexes: (keys: string[]) => deleteCatalogIndexes(keys)
  };
});

const upsertFromSeriesFile = vi.fn(async (_title: string, _file: unknown) => true);
vi.mock('$lib/metadata/store', () => ({
  upsertFromSeriesFile: (title: string, file: unknown) => upsertFromSeriesFile(title, file)
}));

import { refreshCatalogIndex } from './catalog-index-sync';

function file(path: string, overrides: Partial<CloudFileMetadata> = {}): CloudFileMetadata {
  return {
    provider: 'webdav',
    fileId: path,
    path,
    modifiedTime: '2026-08-23T00:00:00.000Z',
    size: 100,
    ...overrides
  } as CloudFileMetadata;
}

function listing(...files: CloudFileMetadata[]): Map<string, CloudFileMetadata[]> {
  const map = new Map<string, CloudFileMetadata[]>();
  for (const f of files) {
    const folder = f.path.split('/')[0];
    const existing = map.get(folder);
    if (existing) existing.push(f);
    else map.set(folder, [f]);
  }
  return map;
}

const CATALOG_JSON = JSON.stringify({
  version: 1,
  updated_at: '2026-08-23T00:00:00.000Z',
  series: [
    {
      series_title: 'Dr Stone (HD Scan)',
      external_ids: { anilist: 98416 },
      titles: { native: 'Dr.STONE' },
      synonyms: [],
      tag: 'HD Scan',
      updated_at: '2026-08-18T19:36:24.324Z'
    },
    {
      series_title: 'Bare Folder',
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: '1970-01-01T00:00:00.000Z'
    }
  ]
});

const downloadFile = vi.fn(async () => new Blob([CATALOG_JSON]));

beforeEach(() => {
  vi.clearAllMocks();
  listCatalogIndexes.mockResolvedValue([]);
  downloadFile.mockResolvedValue(new Blob([CATALOG_JSON]));
  getActiveProvider.mockReturnValue({ type: 'webdav', downloadFile });
});

describe('refreshCatalogIndex', () => {
  it('caches every entry in ONE write and applies the facts', async () => {
    await refreshCatalogIndex(listing(file('catalog.json')), 'webdav');

    expect(putCatalogIndexes).toHaveBeenCalledTimes(1);
    const rows = putCatalogIndexes.mock.calls[0][0];
    expect(rows.map((r) => r.series_key)).toEqual(['dr stone (hd scan)', 'bare folder']);
    expect(rows[0].source).toEqual({
      provider: 'webdav',
      path: 'catalog.json',
      size: 100,
      modifiedTime: '2026-08-23T00:00:00.000Z'
    });
    expect(upsertFromSeriesFile).toHaveBeenCalledTimes(2);
    // Applied as a facts-only SeriesFile, so store.ts owns the factless rules.
    expect(upsertFromSeriesFile).toHaveBeenCalledWith(
      'Dr Stone (HD Scan)',
      expect.objectContaining({ version: 2, volumes: [], updated_at: '2026-08-18T19:36:24.324Z' })
    );
  });

  it('does nothing when the cached stamp already matches', async () => {
    listCatalogIndexes.mockResolvedValue([
      {
        series_key: 'dr stone (hd scan)',
        series_title: 'Dr Stone (HD Scan)',
        entry: {
          series_title: 'Dr Stone (HD Scan)',
          external_ids: {},
          titles: {},
          synonyms: [],
          updated_at: '2026-08-18T19:36:24.324Z'
        },
        source: {
          provider: 'webdav',
          path: 'catalog.json',
          size: 100,
          modifiedTime: '2026-08-23T00:00:00.000Z'
        },
        fetched_at: '2026-08-23T00:00:01.000Z'
      }
    ]);
    await refreshCatalogIndex(listing(file('catalog.json')), 'webdav');
    expect(downloadFile).not.toHaveBeenCalled();
    expect(putCatalogIndexes).not.toHaveBeenCalled();
  });

  it('drops rows of THIS provider whose series left the catalog', async () => {
    listCatalogIndexes.mockResolvedValue([
      {
        series_key: 'deleted series',
        series_title: 'Deleted Series',
        entry: {
          series_title: 'Deleted Series',
          external_ids: {},
          titles: {},
          synonyms: [],
          updated_at: '1970-01-01T00:00:00.000Z'
        },
        source: { provider: 'webdav', path: 'catalog.json', size: 9, modifiedTime: 'old' },
        fetched_at: '2026-08-01T00:00:00.000Z'
      },
      {
        series_key: 'other account',
        series_title: 'Other Account',
        entry: {
          series_title: 'Other Account',
          external_ids: {},
          titles: {},
          synonyms: [],
          updated_at: '1970-01-01T00:00:00.000Z'
        },
        source: { provider: 'mega', path: 'catalog.json', size: 9, modifiedTime: 'old' },
        fetched_at: '2026-08-01T00:00:00.000Z'
      }
    ]);
    await refreshCatalogIndex(listing(file('catalog.json')), 'webdav');
    expect(deleteCatalogIndexes).toHaveBeenCalledWith(['deleted series']);
  });

  it('never cleans up against an empty listing', async () => {
    listCatalogIndexes.mockResolvedValue([
      {
        series_key: 'anything',
        series_title: 'Anything',
        entry: {
          series_title: 'Anything',
          external_ids: {},
          titles: {},
          synonyms: [],
          updated_at: '1970-01-01T00:00:00.000Z'
        },
        source: { provider: 'webdav', path: 'catalog.json', size: 9, modifiedTime: 'old' },
        fetched_at: '2026-08-01T00:00:00.000Z'
      }
    ]);
    await refreshCatalogIndex(new Map(), 'webdav');
    expect(deleteCatalogIndexes).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('does nothing when the listing has no catalog.json (a bare share)', async () => {
    await refreshCatalogIndex(listing(file('Dr Stone/Volume 1.cbz')), 'webdav');
    expect(downloadFile).not.toHaveBeenCalled();
    expect(deleteCatalogIndexes).not.toHaveBeenCalled();
  });

  it('is dropped when the provider changed since the listing', async () => {
    getActiveProvider.mockReturnValue({ type: 'mega', downloadFile });
    await refreshCatalogIndex(listing(file('catalog.json')), 'webdav');
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('never rejects on a junk or failed download', async () => {
    downloadFile.mockResolvedValueOnce(new Blob(['<html>proxy error</html>']));
    await expect(
      refreshCatalogIndex(listing(file('catalog.json')), 'webdav')
    ).resolves.toBeUndefined();
    expect(putCatalogIndexes).not.toHaveBeenCalled();

    downloadFile.mockRejectedValueOnce(new Error('network down'));
    await expect(
      refreshCatalogIndex(listing(file('catalog.json')), 'webdav')
    ).resolves.toBeUndefined();
  });

  it('coalesces a burst of listings into at most one extra pass', async () => {
    const first = refreshCatalogIndex(listing(file('catalog.json')), 'webdav');
    void refreshCatalogIndex(listing(file('catalog.json')), 'webdav');
    void refreshCatalogIndex(listing(file('catalog.json')), 'webdav');
    await first;
    expect(downloadFile.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/metadata/catalog-index-sync.test.ts`
Expected: FAIL — `Failed to resolve import "./catalog-index-sync"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/metadata/catalog-index-sync.ts`:

```ts
import type {
  CloudFileMetadata,
  ProviderType,
  SyncProvider
} from '$lib/util/sync/provider-interface';
import { providerManager } from '$lib/util/sync/provider-manager';
import {
  catalogNeedsRefresh,
  deleteCatalogIndexes,
  listCatalogIndexes,
  putCatalogIndexes,
  type CatalogIndexRecord
} from './catalog-index';
import {
  catalogEntryToSeriesFile,
  isCatalogFilePath,
  parseCatalogFile,
  type CatalogFile
} from './catalog-file';
import { normalizeSeriesKey } from './series-key';
import { upsertFromSeriesFile } from './store';

/**
 * The read half of the root `catalog.json`: after every cloud listing (catalog
 * open, provider connect, backup run), re-read the file if and only if its
 * size/mtime changed, cache every entry and apply its facts.
 *
 * Deliberately timid, exactly like `series-index-sync.ts`:
 *
 * - ONE download for the whole library, and none at all when the stamp matches,
 *   so a 1k-series library costs one listing and zero downloads on a normal
 *   launch.
 * - Facts go through `upsertFromSeriesFile`, which applies only strictly newer
 *   facts, never creates a record from a factless entry, and never schedules a
 *   write — so a refresh can never ping-pong into an upload.
 * - Everything is best-effort: junk content is dropped with one warning, a
 *   failed download is skipped, and the run never rejects.
 * - A run is BOUND to the provider whose listing produced it: between the fetch
 *   and the (background, possibly queued) run the user can switch accounts.
 * - Cleanup only against a non-empty listing, and only for rows fetched from
 *   THIS provider — an empty listing means "not fetched" as often as it means
 *   "empty cloud".
 * - All rows are written in ONE `putCatalogIndexes`: the table feeds a liveQuery
 *   the catalog joins, so a write per series would rebuild the card set N times.
 */

function normalizeCloudPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

/** The root `catalog.json` of a listing (newest, when a provider's overwrite left two). */
function findCatalogFile(
  cloudFilesMap: Map<string, CloudFileMetadata[]>
): CloudFileMetadata | undefined {
  let newest: CloudFileMetadata | undefined;
  for (const files of cloudFilesMap.values()) {
    for (const file of files) {
      if (!isCatalogFilePath(file.path)) continue;
      if (!newest || (file.modifiedTime ?? '') > (newest.modifiedTime ?? '')) newest = file;
    }
  }
  return newest;
}

async function downloadCatalog(
  provider: SyncProvider,
  file: CloudFileMetadata
): Promise<CatalogFile | undefined> {
  try {
    const blob = await provider.downloadFile(file);
    const parsed = parseCatalogFile(JSON.parse(await blob.text()));
    if (!parsed) {
      // Hand-edited, truncated, a future version, or a proxy error page.
      // Dropping it leaves the previous cached rows in place, which is still the
      // best thing this device knows.
      console.warn(`[catalog-index-sync] ignoring an invalid catalog.json at '${file.path}'`);
    }
    return parsed;
  } catch (error) {
    console.warn(`[catalog-index-sync] could not read '${file.path}':`, error);
    return undefined;
  }
}

async function runRefresh(
  cloudFilesMap: Map<string, CloudFileMetadata[]>,
  providerType: ProviderType
): Promise<void> {
  if (cloudFilesMap.size === 0) return;

  const provider = providerManager.getActiveProvider();
  if (!provider || provider.type !== providerType) return;

  const cloudFile = findCatalogFile(cloudFilesMap);
  // No catalog.json at all: a bare share, or a backend that does not publish one.
  // The cached rows (if any) are left alone — this listing says nothing about them.
  if (!cloudFile) return;

  const stamp = { size: cloudFile.size ?? 0, modifiedTime: cloudFile.modifiedTime ?? '' };
  const cached = await listCatalogIndexes();
  if (!catalogNeedsRefresh(cached, stamp, provider.type)) return;

  const parsed = await downloadCatalog(provider, cloudFile);
  if (!parsed) return;

  const now = new Date().toISOString();
  const source = {
    provider: provider.type,
    path: normalizeCloudPath(cloudFile.path),
    size: stamp.size,
    modifiedTime: stamp.modifiedTime
  };

  const records: CatalogIndexRecord[] = [];
  for (const entry of parsed.series) {
    const key = normalizeSeriesKey(entry.series_title);
    if (!key) continue;
    records.push({
      series_key: key,
      series_title: entry.series_title,
      entry,
      source,
      fetched_at: now
    });
    try {
      // Facts only, strictly-newer, factless entries never create or unlink.
      await upsertFromSeriesFile(entry.series_title, catalogEntryToSeriesFile(entry));
    } catch (error) {
      console.warn(
        `[catalog-index-sync] could not apply the facts for '${entry.series_title}':`,
        error
      );
    }
  }

  const keep = new Set(records.map((r) => r.series_key));
  const stale = cached
    .filter((row) => row.source.provider === provider.type && !keep.has(row.series_key))
    .map((row) => row.series_key);

  try {
    await deleteCatalogIndexes(stale);
    await putCatalogIndexes(records);
  } catch (error) {
    console.warn('[catalog-index-sync] could not store the refreshed catalog:', error);
  }
}

interface RefreshRequest {
  cloudFilesMap: Map<string, CloudFileMetadata[]>;
  providerType: ProviderType;
}

let inFlight: Promise<void> | null = null;
let queued: RefreshRequest | null = null;

/**
 * Refresh the cached root catalog for a cloud listing.
 *
 * Never rejects. Calls that arrive while a run is in flight do not start a
 * second one: the newest request is queued and replayed once when the current
 * run finishes, so a burst of listings costs at most one extra pass.
 */
export function refreshCatalogIndex(
  cloudFilesMap: Map<string, CloudFileMetadata[]>,
  providerType: ProviderType
): Promise<void> {
  if (inFlight) {
    queued = { cloudFilesMap, providerType };
    return inFlight;
  }

  inFlight = (async () => {
    try {
      let current: RefreshRequest | null = { cloudFilesMap, providerType };
      while (current) {
        try {
          await runRefresh(current.cloudFilesMap, current.providerType);
        } catch (error) {
          console.warn('[catalog-index-sync] refresh failed:', error);
        }
        current = queued;
        queued = null;
      }
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
```

- [ ] **Step 4: Hook it to the listing**

In `src/lib/util/sync/unified-cloud-manager.ts`, import `refreshCatalogIndex` and start it from `refreshSeriesIndexesInBackground` (which already runs after every `fetchAllCloudVolumes` that did not opt out — i.e. catalog open, provider connect, cloud screen, end of backup run), immediately after the `refreshSeriesIndexes` call:

```ts
import { refreshCatalogIndex } from '$lib/metadata/catalog-index-sync';
```

```ts
void Promise.resolve(refreshSeriesIndexes(listing, provider.type)).catch((error) =>
  console.warn('Series index refresh failed:', error)
);
// The root catalog rides the same listing: one download for the whole
// library, skipped entirely when its size/mtime has not moved.
void Promise.resolve(refreshCatalogIndex(listing, provider.type)).catch((error) =>
  console.warn('Catalog index refresh failed:', error)
);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/metadata/catalog-index-sync.test.ts src/lib/util/sync/unified-cloud-manager.test.ts && npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/metadata/catalog-index-sync.ts src/lib/metadata/catalog-index-sync.test.ts \
  src/lib/util/sync/unified-cloud-manager.ts
git commit -m "feat(catalog): fetch and merge catalog.json on every cloud listing"
```

---

### Task 7: Name-only cards in the catalog + search

**Files:**

- Modify: `src/lib/catalog/catalog.ts`, `src/lib/catalog/index.ts`, `src/lib/components/Catalog.svelte`
- Create: `src/lib/components/CatalogNameCard.svelte`
- Test: `src/lib/catalog/catalog.test.ts` (existing file, new describe block)

**Interfaces:**

- Consumes (Task 2): `catalogIndexMap: Readable<Map<string, CatalogIndexRecord>>`, `interface CatalogIndexRecord { series_key: string; series_title: string; entry: CatalogFileEntry; source: {...}; fetched_at: string }`.
- Consumes (existing): `resolveDisplayTitle(seriesTitle: string, meta: SeriesMetadata | undefined, globalPref: DisplayTitleLanguage): string`, `seriesSearchTerms(seriesTitle: string, meta: SeriesMetadata | undefined): string[]`, `normalizeSeriesKey(title: string): string`, `generateDeterministicUUID(input: string): string` from `$lib/util/series-extraction`, `nav.toSeries(seriesId: string): void`.
- Produces:
  - `Series.nameOnly?: true` on the existing `export interface Series` in `src/lib/catalog/catalog.ts`
  - `export function deriveNameOnlySeries(rows: CatalogIndexRecord[], knownKeys: Set<string>, metaMap: Map<string, SeriesMetadata> | undefined, pref: DisplayTitleLanguage): Series[]`
  - `src/lib/components/CatalogNameCard.svelte` with props `{ title: string; displayTitle: string; variant?: 'grid' | 'list' }`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/catalog/catalog.test.ts`:

```ts
import { deriveNameOnlySeries } from './catalog';
import type { CatalogIndexRecord } from '$lib/metadata/catalog-index';
import type { SeriesMetadata } from '$lib/metadata/types';

function catalogRow(
  title: string,
  entry: Partial<CatalogIndexRecord['entry']> = {}
): CatalogIndexRecord {
  return {
    series_key: title.trim().toLowerCase(),
    series_title: title,
    entry: {
      series_title: title,
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: '1970-01-01T00:00:00.000Z',
      ...entry
    },
    source: { provider: 'webdav', path: 'catalog.json', size: 1, modifiedTime: 'now' },
    fetched_at: '2026-08-23T00:00:00.000Z'
  };
}

describe('deriveNameOnlySeries', () => {
  it('emits a card for a catalog-only series, with no volumes', () => {
    const [series] = deriveNameOnlySeries(
      [catalogRow('Dr Stone')],
      new Set(),
      undefined,
      'imported'
    );
    expect(series).toMatchObject({
      title: 'Dr Stone',
      displayTitle: 'Dr Stone',
      nameOnly: true,
      volumes: []
    });
    expect(series.series_uuid).toBeTruthy();
  });

  it('skips series that already have rows or placeholders locally', () => {
    expect(
      deriveNameOnlySeries([catalogRow('Dr Stone')], new Set(['dr stone']), undefined, 'imported')
    ).toEqual([]);
  });

  it('lists a factless folder by its folder name', () => {
    const [series] = deriveNameOnlySeries(
      [catalogRow('Bare Folder')],
      new Set(),
      undefined,
      'imported'
    );
    expect(series.displayTitle).toBe('Bare Folder');
  });

  it('is searchable by every alt title, synonym and tag', () => {
    const meta = new Map<string, SeriesMetadata>([
      [
        'dr stone',
        {
          series_key: 'dr stone',
          series_title: 'Dr Stone',
          external_ids: { anilist: 98416 },
          titles: { native: 'Dr.STONE', english: 'Dr. STONE' },
          synonyms: ['Doctor Stone'],
          tag: 'HD Scan',
          read_count: 0,
          updated_at: '2026-08-18T19:36:24.324Z'
        }
      ]
    ]);
    const [series] = deriveNameOnlySeries([catalogRow('Dr Stone')], new Set(), meta, 'english');
    expect(series.searchTerms).toEqual(
      expect.arrayContaining(['dr stone', 'dr.stone', 'doctor stone', 'hd scan'])
    );
    expect(series.displayTitle).toBe('Dr. STONE (HD Scan)');
  });

  it('sorts by display title', () => {
    const out = deriveNameOnlySeries(
      [catalogRow('Zeta'), catalogRow('Alpha')],
      new Set(),
      undefined,
      'imported'
    );
    expect(out.map((s) => s.title)).toEqual(['Alpha', 'Zeta']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/catalog/catalog.test.ts`
Expected: FAIL — `deriveNameOnlySeries is not a function`.

- [ ] **Step 3: Extend `catalog.ts`**

In `src/lib/catalog/catalog.ts`, add `nameOnly` to the interface and append the new function:

```ts
export interface Series {
  /** Raw `series_title` — grouping key, route key and cloud folder name. Never derived. */
  title: string;
  /** Human-facing title: preferred-language title (or folder title) + tag. */
  displayTitle: string;
  /** Lowercased search terms: folder title, language titles, synonyms, tag, displayTitle. */
  searchTerms: string[];
  series_uuid: string;
  volumes: VolumeMetadata[];
  /**
   * The series exists only in the root `catalog.json` — this device knows its
   * name and its facts and nothing else. Opening it fetches its `series.json`
   * and materializes its volumes, at which point it becomes a normal series.
   */
  nameOnly?: true;
}
```

```ts
/**
 * Series that exist in the root catalog but have nothing local yet — no rows and
 * no placeholders — as name-only cards.
 *
 * Deliberately volume-free: the whole point of `catalog.json` is that the
 * catalog can be browsed and searched on a 1k-series backend without fetching
 * anything per series. Display titles and search terms are computed HERE, once
 * per recompute, exactly like `deriveSeriesFromVolumes` — never in per-card
 * `$derived` (see CLAUDE.md "Svelte 5 Reactive Performance").
 *
 * `knownKeys` is the set of normalized series keys the volume-backed catalog
 * already covers; a series in both is NOT name-only, so the real card wins.
 */
export function deriveNameOnlySeries(
  rows: CatalogIndexRecord[],
  knownKeys: Set<string>,
  metaMap: Map<string, SeriesMetadata> | undefined,
  pref: DisplayTitleLanguage = 'imported'
): Series[] {
  const out: Series[] = [];
  for (const row of rows) {
    if (knownKeys.has(row.series_key)) continue;

    const meta = metaMap?.get(row.series_key);
    const displayTitle = resolveDisplayTitle(row.series_title, meta, pref);
    const searchTerms = seriesSearchTerms(row.series_title, meta);
    const displayLower = displayTitle.toLowerCase();
    if (!searchTerms.includes(displayLower)) searchTerms.push(displayLower);

    out.push({
      title: row.series_title,
      displayTitle,
      searchTerms,
      // Deterministic from the folder name, like a placeholder's: the real uuid
      // arrives with the volumes when the series is opened.
      series_uuid: generateDeterministicUUID(row.series_title),
      volumes: [],
      nameOnly: true
    });
  }
  out.sort(sortByDisplayTitle);
  return out;
}
```

Add the imports it needs at the top of the file:

```ts
import type { CatalogIndexRecord } from '$lib/metadata/catalog-index';
import { generateDeterministicUUID } from '$lib/util/series-extraction';
```

- [ ] **Step 4: Join the table in the catalog store**

In `src/lib/catalog/index.ts`, add the import and extend the `catalog` derived store:

```ts
import { catalogIndexMap } from '$lib/metadata/catalog-index';
```

and EXTEND the existing `deriveSeriesFromVolumes` import (line 5 at HEAD:
`import { deriveSeriesFromVolumes } from '$lib/catalog/catalog';`) rather than adding a
second import of the same module:

```ts
import { deriveNameOnlySeries, deriveSeriesFromVolumes } from '$lib/catalog/catalog';
```

`normalizeSeriesKey` is already imported in this file (line 17 at HEAD) — do not add it again.

```ts
export const catalog = derived(
  [volumesWithPlaceholders, seriesMetadataMap, preferredTitleLanguage, catalogIndexMap],
  ([$volumesWithPlaceholders, $seriesMetadataMap, $preferredTitleLanguage, $catalogIndexMap]) => {
    // Return null while loading (before first data emission)
    if ($volumesWithPlaceholders === undefined) {
      return null;
    }
    const withVolumes = deriveSeriesFromVolumes(
      Object.values($volumesWithPlaceholders),
      $seriesMetadataMap,
      $preferredTitleLanguage
    );
    if ($catalogIndexMap.size === 0) return withVolumes;

    // Catalog-only series: known by name from the root catalog.json, with
    // nothing local yet. Opening one fetches its series.json (see series-open.ts).
    const knownKeys = new Set(withVolumes.map((series) => normalizeSeriesKey(series.title)));
    return [
      ...withVolumes,
      ...deriveNameOnlySeries(
        [...$catalogIndexMap.values()],
        knownKeys,
        $seriesMetadataMap,
        $preferredTitleLanguage
      )
    ];
  }
);
```

- [ ] **Step 5: Create the card**

Create `src/lib/components/CatalogNameCard.svelte`:

```svelte
<script lang="ts">
  import { nav } from '$lib/util/hash-router';
  import { CloudArrowUpOutline } from 'flowbite-svelte-icons';

  interface Props {
    /** Raw folder title — the route key. */
    title: string;
    /** Pre-resolved by the catalog store; never computed per card. */
    displayTitle: string;
    variant?: 'grid' | 'list';
  }

  let { title, displayTitle, variant = 'grid' }: Props = $props();
</script>

{#if variant === 'list'}
  <button
    type="button"
    class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-gray-100 dark:hover:bg-gray-700"
    onclick={() => nav.toSeries(title)}
  >
    <CloudArrowUpOutline class="h-5 w-5 flex-shrink-0 text-gray-400" />
    {#key displayTitle}
      <span class="truncate">{displayTitle}</span>
    {/key}
  </button>
{:else}
  <button
    type="button"
    class="flex h-[297px] w-[210px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-gray-300 p-3 text-center hover:border-gray-400 hover:bg-gray-50 dark:border-gray-600 dark:hover:border-gray-500 dark:hover:bg-gray-800"
    onclick={() => nav.toSeries(title)}
  >
    <CloudArrowUpOutline class="h-8 w-8 text-gray-400" />
    {#key displayTitle}
      <span class="line-clamp-4 text-sm font-medium">{displayTitle}</span>
    {/key}
    <span class="text-xs text-gray-500">Open to load volumes</span>
  </button>
{/if}
```

(The `{#key displayTitle}` blocks follow the CLAUDE.md rule for dynamic text that Migaku mutates.)

- [ ] **Step 6: Render and partition in `Catalog.svelte`**

`sortedCatalog` already sorts and search-filters the whole list, name-only cards included, because they carry `searchTerms` — no change there. But `[].every(...)` is `true`, so a name-only series would fall into `placeholderSeries` and crash `CatalogItem` on `volumes[0]`. Partition explicitly:

```ts
import CatalogNameCard from './CatalogNameCard.svelte';

// Catalog-only series (name known, nothing local). Split out FIRST: with no
// volumes at all they would satisfy `every(isPlaceholder)` and reach
// CatalogItem, which reads volumes[0].
let nameOnlySeries = $derived(sortedCatalog.filter((series) => series.nameOnly));

let localSeries = $derived(
  sortedCatalog.filter(
    (series) => !series.nameOnly && series.volumes.some((vol) => !vol.isPlaceholder)
  )
);

let placeholderSeries = $derived(
  sortedCatalog.filter(
    (series) =>
      !series.nameOnly &&
      series.volumes.length > 0 &&
      series.volumes.every((vol) => vol.isPlaceholder)
  )
);

let allPlaceholderVolumes = $derived(
  sortedCatalog.flatMap((series) => series.volumes.filter((vol) => vol.isPlaceholder))
);
```

Then render them in their own section, after the placeholder section, inside the `{:else}` branch of the search-empty check:

```svelte
<!-- Catalog-only series (names from catalog.json) -->
{#if nameOnlySeries.length > 0}
  <div class="mt-8">
    <div class="mb-4 flex items-center justify-between px-4">
      <h4 class="text-lg font-semibold text-gray-400">
        In {providerDisplayName} ({nameOnlySeries.length} series)
      </h4>
    </div>
    <div class="flex flex-col flex-wrap justify-center gap-[3px] sm:flex-row sm:justify-start">
      {#if $miscSettings.galleryLayout === 'grid'}
        {#each nameOnlySeries as { title, displayTitle } (title)}
          <CatalogNameCard {title} {displayTitle} variant="grid" />
        {/each}
      {:else}
        <Listgroup active class="w-full">
          {#each nameOnlySeries as { title, displayTitle } (title)}
            <CatalogNameCard {title} {displayTitle} variant="list" />
          {/each}
        </Listgroup>
      {/if}
    </div>
  </div>
{/if}
```

Finally, the empty-catalog branch (`{:else}` on `$catalog.length > 0`) already handles a truly empty library — name-only series make `$catalog.length > 0`, so a library that is only a remote catalog renders the cards instead of "Your catalog is currently empty."

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run src/lib/catalog/catalog.test.ts src/lib/catalog/catalog-store.test.ts && npm run check`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/catalog/catalog.ts src/lib/catalog/catalog.test.ts src/lib/catalog/index.ts \
  src/lib/components/Catalog.svelte src/lib/components/CatalogNameCard.svelte
git commit -m "feat(catalog): name-only cards for catalog.json series"
```

---

### Task 8: Series open — single-series refresh + materialization

**Files:**

- Create: `src/lib/catalog/materialize.ts`, `src/lib/catalog/materialize.test.ts`, `src/lib/metadata/series-open.ts`, `src/lib/metadata/series-open.test.ts`
- Modify: `src/lib/util/sync/unified-cloud-manager.ts` (`refreshSeriesIndexForSeries`), `src/lib/views/SeriesView.svelte` (open hook + pending state)

**Interfaces:**

- Consumes (existing): `interface SeriesFileVolume { volume_uuid: string; volume_title: string; page_count: number; character_count: number; mokuro_version: string; spine_width?: number }`; `parseSeriesFile(value: unknown): SeriesFile | undefined`; `getSeriesIndex(seriesKey: string): Promise<SeriesIndexRecord | undefined>`; `putSeriesIndex(rec: SeriesIndexRecord): Promise<void>`; `indexNeedsRefresh(rec, cloud, provider?)`; `upsertFromSeriesFile(seriesTitle: string, file: SeriesFile): Promise<boolean>`; `isVolumeInstalled(v: VolumeMetadata): boolean`; `generateDeterministicUUID(input: string): string`; `db` from `$lib/catalog/db`.
- Produces:
  - `unifiedCloudManager.refreshSeriesIndexForSeries(seriesTitle: string): Promise<SeriesFile | undefined>` — size/mtime-gated single-file refresh; returns the freshest known file (cached when unchanged, `undefined` when there is none). Never rejects.
  - `unifiedCloudManager.cloudVolumeTitlesFor(seriesTitle: string): Set<string>` — public wrapper over the existing private `cloudVolumeTitles`.
  - `export async function materializeSeriesVolumes(args: { seriesTitle: string; entries: SeriesFileVolume[]; cloudVolumeTitles: Set<string> }): Promise<number>` in `src/lib/catalog/materialize.ts` (returns rows created or filled).
  - `export function openSeries(seriesTitle: string): Promise<void>` in `src/lib/metadata/series-open.ts` — deduped per normalized series key, never rejects.

- [ ] **Step 1: Write the failing materialization test**

Create `src/lib/catalog/materialize.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import type { SeriesFileVolume } from '$lib/metadata/series-file';

vi.mock('$lib/catalog/thumbnails', () => ({ generateThumbnail: vi.fn() }));
vi.mock('$lib/util/progress-tracker', () => ({
  progressTrackerStore: { addProcess: vi.fn(), updateProcess: vi.fn(), removeProcess: vi.fn() }
}));

const DB_NAME = 'mokuro_v3_materialize_test';
vi.mock('$lib/catalog/db', async () => {
  const { CatalogDexieV3 } =
    await vi.importActual<typeof import('$lib/catalog/db-v3')>('$lib/catalog/db-v3');
  return { db: new CatalogDexieV3('mokuro_v3_materialize_test') };
});

import { db } from '$lib/catalog/db';
import { materializeSeriesVolumes } from './materialize';

afterEach(async () => {
  await db.volumes.clear();
  await db.volume_ocr.clear();
  await db.volume_files.clear();
});

function entry(overrides: Partial<SeriesFileVolume> = {}): SeriesFileVolume {
  return {
    volume_uuid: 'uuid-1',
    volume_title: 'Volume 1',
    page_count: 200,
    character_count: 5000,
    mokuro_version: '0.4.11',
    spine_width: 12,
    ...overrides
  };
}

const CLOUD = new Set(['Volume 1', 'Volume 2']);

describe('materializeSeriesVolumes', () => {
  it('creates a metadata-only row carrying the real uuid and counts', async () => {
    const created = await materializeSeriesVolumes({
      seriesTitle: 'Dr Stone',
      entries: [entry()],
      cloudVolumeTitles: CLOUD
    });
    expect(created).toBe(1);

    const row = await db.volumes.get('uuid-1');
    expect(row).toMatchObject({
      volume_uuid: 'uuid-1',
      series_title: 'Dr Stone',
      volume_title: 'Volume 1',
      page_count: 200,
      character_count: 5000,
      mokuro_version: '0.4.11',
      spine_width: 12,
      metadata_only: true,
      page_char_counts: []
    });
    expect(row?.isPlaceholder).toBeUndefined();
  });

  it('reuses the series_uuid of a row already in the series', async () => {
    await db.volumes.add({
      volume_uuid: 'installed',
      series_uuid: 'series-real',
      series_title: 'Dr Stone',
      volume_title: 'Volume 2',
      mokuro_version: '0.4.11',
      page_count: 1,
      character_count: 1,
      page_char_counts: []
    } as never);

    await materializeSeriesVolumes({
      seriesTitle: 'Dr Stone',
      entries: [entry()],
      cloudVolumeTitles: CLOUD
    });
    expect((await db.volumes.get('uuid-1'))?.series_uuid).toBe('series-real');
  });

  it('never overwrites an installed row with the same uuid', async () => {
    await db.volumes.add({
      volume_uuid: 'uuid-1',
      series_uuid: 's',
      series_title: 'Dr Stone',
      volume_title: 'Volume 1',
      mokuro_version: '0.4.11',
      page_count: 999,
      character_count: 999,
      page_char_counts: [1, 2, 3]
    } as never);

    expect(
      await materializeSeriesVolumes({
        seriesTitle: 'Dr Stone',
        entries: [entry()],
        cloudVolumeTitles: CLOUD
      })
    ).toBe(0);
    const row = await db.volumes.get('uuid-1');
    expect(row?.page_count).toBe(999);
    expect(row?.metadata_only).toBeUndefined();
  });

  it('never creates a second row for a volume title a local row already owns', async () => {
    await db.volumes.add({
      volume_uuid: 'other-uuid',
      series_uuid: 's',
      series_title: 'Dr Stone',
      volume_title: 'volume 1',
      mokuro_version: '',
      page_count: 10,
      character_count: 10,
      page_char_counts: [],
      metadata_only: true
    } as never);

    expect(
      await materializeSeriesVolumes({
        seriesTitle: 'Dr Stone',
        entries: [entry()],
        cloudVolumeTitles: CLOUD
      })
    ).toBe(0);
    expect(await db.volumes.get('uuid-1')).toBeUndefined();
  });

  it('fills only the gaps of an existing metadata-only row — local wins', async () => {
    await db.volumes.add({
      volume_uuid: 'uuid-1',
      series_uuid: 's',
      series_title: 'Dr Stone',
      volume_title: 'Volume 1',
      mokuro_version: 'unknown',
      page_count: 0,
      character_count: 4242,
      page_char_counts: [],
      metadata_only: true
    } as never);

    await materializeSeriesVolumes({
      seriesTitle: 'Dr Stone',
      entries: [entry()],
      cloudVolumeTitles: CLOUD
    });
    const row = await db.volumes.get('uuid-1');
    expect(row?.page_count).toBe(200); // was 0 = unknown, filled
    expect(row?.character_count).toBe(4242); // local value kept, never downgraded
    expect(row?.mokuro_version).toBe('0.4.11'); // 'unknown' is the placeholder default
    expect(row?.spine_width).toBe(12);
  });

  it('keeps an image-only mokuro_version of "" instead of overwriting it', async () => {
    await db.volumes.add({
      volume_uuid: 'uuid-1',
      series_uuid: 's',
      series_title: 'Dr Stone',
      volume_title: 'Volume 1',
      mokuro_version: '',
      page_count: 200,
      character_count: 5000,
      page_char_counts: [],
      metadata_only: true
    } as never);

    await materializeSeriesVolumes({
      seriesTitle: 'Dr Stone',
      entries: [entry()],
      cloudVolumeTitles: CLOUD
    });
    expect((await db.volumes.get('uuid-1'))?.mokuro_version).toBe('');
  });

  it('skips entries whose archive the cloud listing does not show', async () => {
    expect(
      await materializeSeriesVolumes({
        seriesTitle: 'Dr Stone',
        entries: [entry({ volume_uuid: 'ghost', volume_title: 'Volume 99' })],
        cloudVolumeTitles: CLOUD
      })
    ).toBe(0);
    expect(await db.volumes.get('ghost')).toBeUndefined();
  });

  it('does nothing at all when the listing is empty (unfetched, not empty cloud)', async () => {
    expect(
      await materializeSeriesVolumes({
        seriesTitle: 'Dr Stone',
        entries: [entry()],
        cloudVolumeTitles: new Set()
      })
    ).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/catalog/materialize.test.ts`
Expected: FAIL — `Failed to resolve import "./materialize"`.

- [ ] **Step 3: Write `materialize.ts`**

Create `src/lib/catalog/materialize.ts`:

```ts
import { db } from '$lib/catalog/db';
import type { VolumeMetadata } from '$lib/types';
import type { SeriesFileVolume } from '$lib/metadata/series-file';
import { normalizeSeriesKey } from '$lib/metadata/series-key';
import { generateDeterministicUUID } from '$lib/util/series-extraction';
import { isVolumeInstalled } from '$lib/catalog/volume-state';

/**
 * Promote a series' index entries into real `volumes` rows in the
 * metadata-only state — the same state "remove from device" leaves behind.
 *
 * This is what makes a cloud-only series a first-class citizen: the row carries
 * the volume's REAL uuid (so synced progress attaches to it), its counts, its
 * `mokuro_version` and its `spine_width`, so the catalog, the stats views and
 * the tracker all work before a single archive is downloaded. It replaces the
 * transient placeholder for that volume permanently — `generatePlaceholders`
 * already skips any path or uuid that has a local row.
 *
 * The index stays UNAUTHORITATIVE, so three rules are absolute:
 *
 * 1. An INSTALLED row is never touched. Its data was measured, the index's was
 *    copied.
 * 2. A volume title a local row already owns is never given a second row, even
 *    when the index lists a different uuid for it (a volume re-OCR'd elsewhere,
 *    or a row created from a path-derived placeholder uuid). That second row
 *    could never be downloaded and would sit in the catalog forever — exactly
 *    the duplicate `stranded-rows.ts` exists to clean up after a download.
 * 3. An existing metadata-only row is only ever FILLED, never downgraded: a
 *    zero count or the `'unknown'` placeholder version is a gap, any other
 *    local value wins.
 *
 * Gated on `cloudVolumeTitles` — the `.cbz` titles the current listing shows in
 * the folder — so a stale index cannot resurrect a deleted volume. An empty set
 * means the listing is unavailable as often as it means the folder is empty, so
 * nothing is materialized.
 *
 * Returns how many rows were created or filled.
 */
export async function materializeSeriesVolumes(args: {
  seriesTitle: string;
  entries: SeriesFileVolume[];
  cloudVolumeTitles: Set<string>;
}): Promise<number> {
  const { seriesTitle, entries, cloudVolumeTitles } = args;
  if (entries.length === 0 || cloudVolumeTitles.size === 0) return 0;

  const seriesKey = normalizeSeriesKey(seriesTitle);
  if (!seriesKey) return 0;

  const cloudTitleKeys = new Set([...cloudVolumeTitles].map((t) => normalizeSeriesKey(t)));

  return db.transaction('rw', db.volumes, async () => {
    const siblings = (await db.volumes
      .where('series_title')
      .equalsIgnoreCase(seriesTitle)
      .toArray()) as VolumeMetadata[];

    const byUuid = new Map(siblings.map((row) => [row.volume_uuid, row]));
    const titlesTaken = new Map(siblings.map((row) => [normalizeSeriesKey(row.volume_title), row]));
    const seriesUuid = siblings[0]?.series_uuid ?? generateDeterministicUUID(seriesTitle);

    let changed = 0;
    for (const entry of entries) {
      const titleKey = normalizeSeriesKey(entry.volume_title);
      if (!titleKey || !cloudTitleKeys.has(titleKey)) continue;

      const existing = byUuid.get(entry.volume_uuid);
      if (existing) {
        // Rule 1: an installed row was measured; the index was copied.
        if (isVolumeInstalled(existing)) continue;
        // Rule 3: fill gaps only.
        const patch: Partial<VolumeMetadata> = {};
        if (!existing.page_count && entry.page_count) patch.page_count = entry.page_count;
        if (!existing.character_count && entry.character_count) {
          patch.character_count = entry.character_count;
        }
        // `''` is a real value (image-only volume); `'unknown'` is the
        // placeholder default, i.e. "nobody has told us yet".
        if (existing.mokuro_version === 'unknown' && entry.mokuro_version !== 'unknown') {
          patch.mokuro_version = entry.mokuro_version;
        }
        if (existing.spine_width === undefined && entry.spine_width !== undefined) {
          patch.spine_width = entry.spine_width;
        }
        if (Object.keys(patch).length === 0) continue;
        await db.volumes.update(entry.volume_uuid, patch);
        changed += 1;
        continue;
      }

      // Rule 2: a local row already owns this title under another uuid.
      if (titlesTaken.has(titleKey)) continue;

      const row: VolumeMetadata = {
        volume_uuid: entry.volume_uuid,
        series_uuid: seriesUuid,
        series_title: seriesTitle,
        volume_title: entry.volume_title,
        mokuro_version: entry.mokuro_version,
        page_count: entry.page_count,
        character_count: entry.character_count,
        // Totals only — the index deliberately carries no per-page array.
        page_char_counts: [],
        metadata_only: true
      };
      if (entry.spine_width !== undefined) row.spine_width = entry.spine_width;

      await db.volumes.put(row);
      byUuid.set(row.volume_uuid, row);
      titlesTaken.set(titleKey, row);
      changed += 1;
    }
    return changed;
  });
}
```

- [ ] **Step 4: Add the single-series refresh to the cloud manager**

In `src/lib/util/sync/unified-cloud-manager.ts`, add these members next to `writeSeriesFile`:

```ts
  /** Volume titles the cloud listing shows as `.cbz` archives in a series folder. */
  cloudVolumeTitlesFor(seriesTitle: string): Set<string> {
    return this.cloudVolumeTitles(seriesTitle);
  }

  /**
   * Re-read ONE series' `series.json`, event-driven.
   *
   * The listing-wide pass (`series-index-sync.ts`) is a background warm-up that
   * may be minutes behind; opening a series must not wait for it. Same gate
   * though — size/mtime against the cached record — so re-opening a series
   * costs nothing, and same best-effort contract: never rejects, and returns the
   * freshest copy this device has (the cached one when the cloud has not moved,
   * `undefined` when there is no readable file at all).
   */
  async refreshSeriesIndexForSeries(seriesTitle: string): Promise<SeriesFile | undefined> {
    const seriesKey = normalizeSeriesKey(seriesTitle);
    if (!seriesKey) return undefined;

    const cached = await getSeriesIndex(seriesKey);
    try {
      const provider = this.getActiveProvider();
      if (!provider) return cached?.file;

      const cloudFile = this.getCloudSeriesFile(seriesTitle);
      if (!cloudFile) return cached?.file;

      const stamp = { size: cloudFile.size ?? 0, modifiedTime: cloudFile.modifiedTime ?? '' };
      if (!indexNeedsRefresh(cached, stamp, provider.type)) return cached?.file;

      const fresh = await this.readCloudSeriesFile(cloudFile);
      if (!fresh) return cached?.file;

      await putSeriesIndex({
        series_key: seriesKey,
        series_title: seriesTitle,
        file: fresh,
        source: {
          provider: provider.type,
          path: normalizeCloudPath(cloudFile.path),
          size: stamp.size,
          modifiedTime: stamp.modifiedTime
        },
        fetched_at: new Date().toISOString()
      });
      // Facts only, strictly-newer, and never a write trigger.
      await upsertFromSeriesFile(seriesTitle, fresh);
      return fresh;
    } catch (error) {
      console.debug(`Could not refresh series.json for '${seriesTitle}':`, error);
      return cached?.file;
    }
  }
```

Add `upsertFromSeriesFile` to the existing `$lib/metadata/store` import.

- [ ] **Step 5: Write the failing `openSeries` test**

Create `src/lib/metadata/series-open.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SeriesFile } from './series-file';

const refreshSeriesIndexForSeries = vi.fn(
  async (_title: string): Promise<SeriesFile | undefined> => file
);
const cloudVolumeTitlesFor = vi.fn((_title: string) => new Set(['Volume 1']));
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    refreshSeriesIndexForSeries: (t: string) => refreshSeriesIndexForSeries(t),
    cloudVolumeTitlesFor: (t: string) => cloudVolumeTitlesFor(t)
  }
}));

const materializeSeriesVolumes = vi.fn(async () => 1);
vi.mock('$lib/catalog/materialize', () => ({
  materializeSeriesVolumes: (args: unknown) => materializeSeriesVolumes(args as never)
}));

const installCoversForSeries = vi.fn(async () => 1);
vi.mock('$lib/catalog/cover-install', () => ({
  installCoversForSeries: (t: string) => installCoversForSeries(t)
}));

import { openSeries } from './series-open';

const file: SeriesFile = {
  version: 2,
  series_title: 'Dr Stone',
  external_ids: {},
  titles: {},
  synonyms: [],
  updated_at: '2026-08-18T19:36:24.324Z',
  volumes: [
    {
      volume_uuid: 'uuid-1',
      volume_title: 'Volume 1',
      page_count: 200,
      character_count: 5000,
      mokuro_version: '0.4.11'
    }
  ]
};

beforeEach(() => {
  vi.clearAllMocks();
  refreshSeriesIndexForSeries.mockResolvedValue(file);
  cloudVolumeTitlesFor.mockReturnValue(new Set(['Volume 1']));
  materializeSeriesVolumes.mockResolvedValue(1);
});

describe('openSeries', () => {
  it('refreshes, materializes, then installs covers', async () => {
    await openSeries('Dr Stone');
    expect(refreshSeriesIndexForSeries).toHaveBeenCalledWith('Dr Stone');
    expect(materializeSeriesVolumes).toHaveBeenCalledWith({
      seriesTitle: 'Dr Stone',
      entries: file.volumes,
      cloudVolumeTitles: new Set(['Volume 1'])
    });
    expect(installCoversForSeries).toHaveBeenCalledWith('Dr Stone');
  });

  it('still installs covers when there was nothing new to materialize', async () => {
    materializeSeriesVolumes.mockResolvedValue(0);
    await openSeries('Dr Stone');
    expect(installCoversForSeries).toHaveBeenCalledWith('Dr Stone');
  });

  it('does nothing when there is no index for the series', async () => {
    refreshSeriesIndexForSeries.mockResolvedValue(undefined);
    await openSeries('Bare Share');
    expect(materializeSeriesVolumes).not.toHaveBeenCalled();
    expect(installCoversForSeries).not.toHaveBeenCalled();
  });

  it('de-duplicates concurrent opens of the same series', async () => {
    const a = openSeries('Dr Stone');
    const b = openSeries('dr  stone');
    await Promise.all([a, b]);
    expect(refreshSeriesIndexForSeries).toHaveBeenCalledTimes(1);
  });

  it('never rejects', async () => {
    refreshSeriesIndexForSeries.mockRejectedValueOnce(new Error('offline'));
    await expect(openSeries('Dr Stone')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 6: Write `series-open.ts`**

Create `src/lib/metadata/series-open.ts`:

```ts
import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
import { materializeSeriesVolumes } from '$lib/catalog/materialize';
import { installCoversForSeries } from '$lib/catalog/cover-install';
import { normalizeSeriesKey } from './series-key';

/**
 * The series-open load step: refresh THIS series' `series.json` (size/mtime
 * gated, not waiting for the listing-wide pass), materialize its index entries
 * as metadata-only rows, then install their covers from the per-volume sidecars.
 *
 * Deduped per normalized series key, so the view mounting, a route change and a
 * hole patch arriving together cost one pass. Best-effort throughout: never
 * rejects, never surfaces UI — a series that fails to load simply shows what the
 * device already had.
 */
const inFlight = new Map<string, Promise<void>>();

export function openSeries(seriesTitle: string): Promise<void> {
  const key = normalizeSeriesKey(seriesTitle);
  if (!key) return Promise.resolve();

  const running = inFlight.get(key);
  if (running) return running;

  const run = (async () => {
    try {
      const file = await unifiedCloudManager.refreshSeriesIndexForSeries(seriesTitle);
      if (!file) return;

      await materializeSeriesVolumes({
        seriesTitle,
        entries: file.volumes,
        cloudVolumeTitles: unifiedCloudManager.cloudVolumeTitlesFor(seriesTitle)
      });
      // Covers are installed even when nothing was materialized: rows from an
      // earlier open may still be missing theirs.
      await installCoversForSeries(seriesTitle);
    } catch (error) {
      console.debug(`[series-open] could not load '${seriesTitle}':`, error);
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, run);
  return run;
}
```

- [ ] **Step 7: Hook `SeriesView.svelte`**

Add the import, a pending flag, and an effect keyed on the route param, plus a loading branch so a name-only series does not flash "Series not found":

```ts
import { openSeries } from '$lib/metadata/series-open';
```

```ts
// Series open is a load step: refresh this series' series.json, materialize
// its volumes, install covers. Keyed on the route param so navigating between
// series re-runs it; `openSeries` itself dedupes and never rejects.
let seriesOpenPending = $state(false);

$effect(() => {
  const title = $routeParams.manga;
  if (!browser || !title) return;
  seriesOpenPending = true;
  openSeries(title).finally(() => {
    seriesOpenPending = false;
  });
});
```

In the markup, change the final `{:else}` ("Series not found") so a pending open shows the spinner instead:

```svelte
{:else if seriesOpenPending}
  <div class="flex items-center justify-center p-16">
    <Spinner size="12" />
  </div>
{:else}
  <div class="flex flex-col items-center justify-center gap-4 p-16">
    <p class="text-lg text-gray-400">Series not found</p>
    <Button color="primary" onclick={() => nav.toCatalog()}>Go to Catalog</Button>
  </div>
{/if}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run src/lib/catalog/materialize.test.ts src/lib/metadata/series-open.test.ts src/lib/util/sync/unified-cloud-manager.test.ts && npm run check`
Expected: PASS. (`series-open.test.ts` needs Task 9's `cover-install` module to exist for the import to resolve — if Task 9 has not landed yet, create the module with the signature `export async function installCoversForSeries(seriesTitle: string): Promise<number> { return 0; }` in THIS task and fill it in Task 9.)

- [ ] **Step 9: Commit**

```bash
git add src/lib/catalog/materialize.ts src/lib/catalog/materialize.test.ts \
  src/lib/metadata/series-open.ts src/lib/metadata/series-open.test.ts \
  src/lib/catalog/cover-install.ts src/lib/util/sync/unified-cloud-manager.ts \
  src/lib/views/SeriesView.svelte
git commit -m "feat(catalog): series open refreshes series.json and materializes its volumes"
```

---

### Task 9: Lazy cover install onto materialized rows

**Files:**

- Modify: `src/lib/catalog/placeholders.ts` (extract the cover-sidecar indexer, lowercase its keys), `src/lib/catalog/cover-install.ts` (fill in the stub from Task 8)
- Test: `src/lib/catalog/cover-install.test.ts` (new), `src/lib/catalog/placeholders.test.ts` (existing, new describe block)

**Interfaces:**

- Consumes (existing): `fetchCloudThumbnail(volume: VolumeMetadata): Promise<{ file: File; width: number; height: number } | null>` from `$lib/catalog/cloud-thumbnails` (already session-cached, request-coalesced and capped at 4 concurrent downloads with a 15 s timeout); `needsDownload(v: VolumeMetadata): boolean`; `unifiedCloudManager.getAllCloudVolumes(): CloudFileMetadata[]`, `unifiedCloudManager.getActiveProvider(): SyncProvider | null`.
- Produces:
  - `export function indexCoverSidecarsByBasePath(files: Iterable<CloudFileMetadata>): Map<string, { fileId: string; path: string }>` in `src/lib/catalog/placeholders.ts` — keys are LOWERCASED `<Series>/<Volume>` base paths, `.webp` preferred over `.jpg`/`.jpeg`
  - `export async function installCoversForSeries(seriesTitle: string): Promise<number>` in `src/lib/catalog/cover-install.ts` — returns covers installed

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/catalog/placeholders.test.ts`:

```ts
import { indexCoverSidecarsByBasePath } from './placeholders';

describe('indexCoverSidecarsByBasePath', () => {
  const f = (path: string, fileId: string) =>
    ({ provider: 'webdav', fileId, path, modifiedTime: '', size: 1 }) as never;

  it('keys covers by lowercased base path', () => {
    const index = indexCoverSidecarsByBasePath([f('Dr Stone/Volume 1.webp', 'c1')]);
    expect(index.get('dr stone/volume 1')).toEqual({
      fileId: 'c1',
      path: 'Dr Stone/Volume 1.webp'
    });
  });

  it('prefers .webp over .jpg for the same volume', () => {
    const index = indexCoverSidecarsByBasePath([
      f('Dr Stone/Volume 1.jpg', 'jpg'),
      f('Dr Stone/Volume 1.webp', 'webp')
    ]);
    expect(index.get('dr stone/volume 1')?.fileId).toBe('webp');

    const reversed = indexCoverSidecarsByBasePath([
      f('Dr Stone/Volume 1.webp', 'webp'),
      f('Dr Stone/Volume 1.jpg', 'jpg')
    ]);
    expect(reversed.get('dr stone/volume 1')?.fileId).toBe('webp');
  });

  it('ignores archives and the series sidecar', () => {
    const index = indexCoverSidecarsByBasePath([
      f('Dr Stone/Volume 1.cbz', 'a'),
      f('Dr Stone/series.json', 'b')
    ]);
    expect(index.size).toBe(0);
  });
});
```

Create `src/lib/catalog/cover-install.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('$lib/catalog/thumbnails', () => ({ generateThumbnail: vi.fn() }));
vi.mock('$lib/util/progress-tracker', () => ({
  progressTrackerStore: { addProcess: vi.fn(), updateProcess: vi.fn(), removeProcess: vi.fn() }
}));
vi.mock('$lib/catalog/db', async () => {
  const { CatalogDexieV3 } =
    await vi.importActual<typeof import('$lib/catalog/db-v3')>('$lib/catalog/db-v3');
  return { db: new CatalogDexieV3('mokuro_v3_cover_install_test') };
});

const getAllCloudVolumes = vi.fn(() => [
  {
    provider: 'webdav',
    fileId: 'cover-1',
    path: 'Dr Stone/Volume 1.webp',
    modifiedTime: '',
    size: 1
  },
  { provider: 'webdav', fileId: 'cbz-1', path: 'Dr Stone/Volume 1.cbz', modifiedTime: '', size: 1 }
]);
const getActiveProvider = vi.fn(() => ({ type: 'webdav' }));
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    getAllCloudVolumes: () => getAllCloudVolumes(),
    getActiveProvider: () => getActiveProvider()
  }
}));

const fetchCloudThumbnail = vi.fn(async () => ({
  file: new File(['img'], 'Volume 1.webp', { type: 'image/webp' }),
  width: 210,
  height: 297
}));
vi.mock('$lib/catalog/cloud-thumbnails', () => ({
  fetchCloudThumbnail: (v: unknown) => fetchCloudThumbnail(v as never)
}));

import { db } from '$lib/catalog/db';
import { installCoversForSeries } from './cover-install';

beforeEach(() => {
  vi.clearAllMocks();
  getActiveProvider.mockReturnValue({ type: 'webdav' });
});

afterEach(async () => {
  await db.volumes.clear();
});

async function addRow(overrides: Record<string, unknown> = {}) {
  await db.volumes.put({
    volume_uuid: 'uuid-1',
    series_uuid: 's',
    series_title: 'Dr Stone',
    volume_title: 'Volume 1',
    mokuro_version: '0.4.11',
    page_count: 200,
    character_count: 5000,
    page_char_counts: [],
    metadata_only: true,
    ...overrides
  } as never);
}

describe('installCoversForSeries', () => {
  it('inlines the cover sidecar on a metadata-only row', async () => {
    await addRow();
    expect(await installCoversForSeries('Dr Stone')).toBe(1);

    const row = await db.volumes.get('uuid-1');
    expect(row?.thumbnail).toBeInstanceOf(File);
    expect(row?.thumbnail_width).toBe(210);
    expect(row?.thumbnail_height).toBe(297);

    // Decorated with the listing's cloud fields, which are NEVER stored on the row.
    expect(fetchCloudThumbnail).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudProvider: 'webdav',
        cloudThumbnailFileId: 'cover-1',
        cloudThumbnailPath: 'Dr Stone/Volume 1.webp'
      })
    );
    expect(row?.cloudThumbnailFileId).toBeUndefined();
  });

  it('skips rows that already have a cover', async () => {
    await addRow({
      thumbnail: new File(['old'], 'old.webp'),
      thumbnail_width: 1,
      thumbnail_height: 1
    });
    expect(await installCoversForSeries('Dr Stone')).toBe(0);
    expect(fetchCloudThumbnail).not.toHaveBeenCalled();
  });

  it('skips installed rows (their cover comes from their own pages)', async () => {
    await addRow({ metadata_only: undefined });
    expect(await installCoversForSeries('Dr Stone')).toBe(0);
    expect(fetchCloudThumbnail).not.toHaveBeenCalled();
  });

  it('matches the sidecar case-insensitively', async () => {
    await addRow({ series_title: 'dr stone', volume_title: 'volume 1' });
    expect(await installCoversForSeries('dr stone')).toBe(1);
  });

  it('does nothing without a cover sidecar or a provider', async () => {
    await addRow();
    getAllCloudVolumes.mockReturnValueOnce([]);
    expect(await installCoversForSeries('Dr Stone')).toBe(0);

    getActiveProvider.mockReturnValueOnce(null as never);
    expect(await installCoversForSeries('Dr Stone')).toBe(0);
  });

  it('never rejects when a download fails', async () => {
    await addRow();
    fetchCloudThumbnail.mockRejectedValueOnce(new Error('timeout'));
    await expect(installCoversForSeries('Dr Stone')).resolves.toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/catalog/cover-install.test.ts src/lib/catalog/placeholders.test.ts`
Expected: FAIL — `indexCoverSidecarsByBasePath is not a function`; `installCoversForSeries` returns `0` from the Task 8 stub.

- [ ] **Step 3: Extract the cover indexer in `placeholders.ts`**

Add the helper and use it inside `generatePlaceholders`, replacing the cover branch of the split loop:

```ts
/** Every file of a listing, flattened. */
function* allListedFiles(
  cloudFilesMap: Map<string, CloudVolumeWithProvider[]>
): Generator<CloudVolumeWithProvider> {
  for (const files of cloudFilesMap.values()) yield* files;
}

/**
 * Index the per-volume cover sidecars of a listing by their base path
 * (`<Series>/<Volume>`), LOWERCASED so a casing difference between a stored
 * title and the cloud filename still matches — the same rule every other cloud
 * lookup here uses. `.webp` wins over `.jpg`/`.jpeg` for the same volume.
 *
 * The universal cover source: placeholders read it to decorate a cloud-only
 * volume, and `cover-install.ts` reads it to inline a cover onto a materialized
 * row. One definition, so the two can never disagree about which file is a
 * volume's cover.
 */
export function indexCoverSidecarsByBasePath(
  files: Iterable<CloudFileMetadata>
): Map<string, { fileId: string; path: string }> {
  const index = new Map<string, { fileId: string; path: string }>();
  const coverExtRegex = /\.(webp|jpe?g)$/i;
  for (const file of files) {
    if (isSeriesFilePath(file.path)) continue;
    const match = file.path.match(coverExtRegex);
    if (!match) continue;
    const key = file.path.slice(0, -match[0].length).toLowerCase();
    const isWebp = match[1].toLowerCase() === 'webp';
    if (!index.has(key) || isWebp) index.set(key, { fileId: file.fileId, path: file.path });
  }
  return index;
}
```

In `generatePlaceholders`, replace the local `thumbnailMap` construction: build it once before the split loop with `const thumbnailMap = indexCoverSidecarsByBasePath(allListedFiles(cloudFilesMap));`, delete the `if (coverMatch) { … }` branch from the loop (keep `else if (.mokuro.gz)` / `else if (.mokuro)` / `else cloudFiles.push(file)` — but skip cover files there with `if (coverExtRegex.test(file.path)) continue;` so they still do not reach the cbz bucket), and change the lookup to the lowercased key:

```ts
const basePath = cloudFile.path.replace(/\.cbz$/i, '').toLowerCase();
const thumbnailInfo = thumbnailMap.get(basePath);
```

Add `import type { CloudFileMetadata } from '$lib/util/sync/provider-interface';` at the top.

- [ ] **Step 4: Write `cover-install.ts`**

Replace the Task 8 stub in `src/lib/catalog/cover-install.ts`:

```ts
import { db } from '$lib/catalog/db';
import type { VolumeMetadata } from '$lib/types';
import { fetchCloudThumbnail } from '$lib/catalog/cloud-thumbnails';
import { indexCoverSidecarsByBasePath } from '$lib/catalog/placeholders';
import { needsDownload } from '$lib/catalog/volume-state';
import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';

/** Cover downloads started at once. `fetchCloudThumbnail` caps the network at 4 anyway. */
const MAX_CONCURRENT_COVER_INSTALLS = 4;

/**
 * Give this series' not-installed rows their covers, from the per-volume
 * sidecars that already exist next to each `.cbz`.
 *
 * A materialized row has everything except a picture, and a catalog full of
 * blank cards is worse than a slow one — but the covers are the only heavy part
 * of the series-open path, so they are fetched lazily, bounded, and only for
 * rows that actually lack one. `fetchCloudThumbnail` provides the session cache,
 * the request coalescing, the 4-way concurrency cap and the 15 s timeout; this
 * function only decides WHICH rows need one and writes the result.
 *
 * The cloud fields are put on a COPY for the fetch and never stored on the row:
 * a fileId belongs to the current listing, not to the volume (the same rule the
 * catalog join follows when it decorates metadata-only rows).
 *
 * Returns how many covers were installed. Never rejects.
 */
export async function installCoversForSeries(seriesTitle: string): Promise<number> {
  const provider = unifiedCloudManager.getActiveProvider();
  if (!provider) return 0;

  const covers = indexCoverSidecarsByBasePath(unifiedCloudManager.getAllCloudVolumes());
  if (covers.size === 0) return 0;

  const rows = (await db.volumes
    .where('series_title')
    .equalsIgnoreCase(seriesTitle)
    .toArray()) as VolumeMetadata[];

  const targets = rows.filter((row) => needsDownload(row) && !row.thumbnail);
  if (targets.length === 0) return 0;

  let installed = 0;
  let next = 0;
  const workers = Array.from(
    { length: Math.min(MAX_CONCURRENT_COVER_INSTALLS, targets.length) },
    async () => {
      while (next < targets.length) {
        const row = targets[next++];
        const info = covers.get(`${row.series_title}/${row.volume_title}`.toLowerCase());
        if (!info) continue;
        try {
          const result = await fetchCloudThumbnail({
            ...row,
            cloudProvider: provider.type,
            cloudThumbnailFileId: info.fileId,
            cloudThumbnailPath: info.path
          });
          if (!result) continue;
          await db.volumes.update(row.volume_uuid, {
            thumbnail: result.file,
            thumbnail_width: result.width,
            thumbnail_height: result.height
          });
          installed += 1;
        } catch (error) {
          console.debug(
            `[cover-install] could not install a cover for '${row.volume_title}':`,
            error
          );
        }
      }
    }
  );
  await Promise.all(workers);
  return installed;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/catalog/cover-install.test.ts src/lib/catalog/placeholders.test.ts src/lib/metadata/series-open.test.ts && npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/catalog/cover-install.ts src/lib/catalog/cover-install.test.ts \
  src/lib/catalog/placeholders.ts src/lib/catalog/placeholders.test.ts
git commit -m "feat(catalog): install covers from sidecars onto materialized rows"
```

---

### Task 10: Hole patcher — progress referencing an unknown series

**Files:**

- Create: `src/lib/metadata/hole-patch.ts`, `src/lib/metadata/hole-patch.test.ts`
- Modify: `src/lib/util/sync/init-providers.ts` (run after the startup sync), `src/lib/views/CatalogView.svelte` (run on catalog open)

**Interfaces:**

- Consumes (Task 8): `openSeries(seriesTitle: string): Promise<void>`.
- Consumes (Task 2): `listCatalogIndexes(): Promise<CatalogIndexRecord[]>` — not needed for the decision, but `series_index` is: `listSeriesIndexes(): Promise<SeriesIndexRecord[]>` from `$lib/metadata/series-index`.
- Consumes (existing): the `volumes` progress store from `$lib/settings` — `Readable<Record<string, VolumeData>>` where `VolumeData` carries `series_title?: string`, `series_uuid?: string`, `deletedOn?: string`; `db.volumes` for the local rows; `normalizeSeriesKey`.
- Produces: `export const MAX_HOLE_PATCHES_PER_RUN = 5`, `export async function patchProgressHoles(options?: { limit?: number }): Promise<string[]>` — returns the series titles it pulled. Never rejects.

- [ ] **Step 1: Write the failing test**

Create `src/lib/metadata/hole-patch.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';

let progress: Record<string, { series_title?: string; deletedOn?: string }> = {};
vi.mock('$lib/settings', () => ({
  get volumes() {
    return readable(progress);
  }
}));

let localRows: Array<{ volume_uuid: string; series_title: string }> = [];
vi.mock('$lib/catalog/db', () => ({
  db: { volumes: { toArray: async () => localRows } }
}));

let indexes: Array<{ series_key: string }> = [];
vi.mock('$lib/metadata/series-index', () => ({
  listSeriesIndexes: async () => indexes
}));

const openSeries = vi.fn(async (_title: string) => {});
vi.mock('$lib/metadata/series-open', () => ({ openSeries: (t: string) => openSeries(t) }));

import { patchProgressHoles } from './hole-patch';

beforeEach(() => {
  vi.clearAllMocks();
  progress = {};
  localRows = [];
  indexes = [];
});

describe('patchProgressHoles', () => {
  it('pulls a series that progress references but nothing local knows', async () => {
    progress = { 'uuid-1': { series_title: 'Dr Stone' } };
    await expect(patchProgressHoles()).resolves.toEqual(['Dr Stone']);
    expect(openSeries).toHaveBeenCalledWith('Dr Stone');
  });

  it('ignores a series that already has a local row', async () => {
    progress = { 'uuid-1': { series_title: 'Dr Stone' } };
    localRows = [{ volume_uuid: 'uuid-1', series_title: 'Dr Stone' }];
    await expect(patchProgressHoles()).resolves.toEqual([]);
  });

  it('ignores a series whose index is already cached', async () => {
    progress = { 'uuid-1': { series_title: 'Dr Stone' } };
    indexes = [{ series_key: 'dr stone' }];
    await expect(patchProgressHoles()).resolves.toEqual([]);
  });

  it('ignores tombstones and records with no series title', async () => {
    progress = {
      'uuid-1': { series_title: 'Deleted', deletedOn: '2026-08-01T00:00:00.000Z' },
      'uuid-2': {},
      'uuid-3': { series_title: '   ' }
    };
    await expect(patchProgressHoles()).resolves.toEqual([]);
    expect(openSeries).not.toHaveBeenCalled();
  });

  it('de-duplicates by series and caps the run', async () => {
    progress = {
      a: { series_title: 'One' },
      b: { series_title: 'one' },
      c: { series_title: 'Two' },
      d: { series_title: 'Three' }
    };
    const pulled = await patchProgressHoles({ limit: 2 });
    expect(pulled).toHaveLength(2);
    expect(openSeries).toHaveBeenCalledTimes(2);
  });

  it('never rejects when an open fails', async () => {
    progress = { 'uuid-1': { series_title: 'Dr Stone' } };
    openSeries.mockRejectedValueOnce(new Error('offline'));
    await expect(patchProgressHoles()).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/metadata/hole-patch.test.ts`
Expected: FAIL — `Failed to resolve import "./hole-patch"`.

- [ ] **Step 3: Write `hole-patch.ts`**

Create `src/lib/metadata/hole-patch.ts`:

```ts
import { get } from 'svelte/store';
import { db } from '$lib/catalog/db';
import { volumes as progressStore } from '$lib/settings';
import { listSeriesIndexes } from './series-index';
import { openSeries } from './series-open';
import { normalizeSeriesKey } from './series-key';

/**
 * Series pulled per run. Each pull is a `series.json` download, so a device
 * whose progress file references a hundred long-gone series must not turn a
 * catalog open into a hundred requests — the rest are patched on the next run.
 */
export const MAX_HOLE_PATCHES_PER_RUN = 5;

/**
 * Patch the holes synced progress leaves behind.
 *
 * `catalog.json` carries names only, so a device that has read a volume on
 * another machine can hold progress for a series it has no rows and no cached
 * index for — the stats views would show a dangling entry with no title, no
 * counts and no cover. Each such series gets its `series.json` pulled and its
 * volumes materialized (`openSeries`), which is exactly the state the series
 * would have been in had the user opened it.
 *
 * Cheap in the normal case: one pass over the progress records, one over the
 * local rows, one over the cached indexes, and zero network when nothing dangles.
 * Tombstones (`deletedOn`) are skipped — the user deleted those on purpose.
 *
 * Returns the series titles it actually pulled. Never rejects.
 */
export async function patchProgressHoles(options?: { limit?: number }): Promise<string[]> {
  const limit = options?.limit ?? MAX_HOLE_PATCHES_PER_RUN;
  const pulled: string[] = [];

  try {
    const progress = get(progressStore);
    const wanted = new Map<string, string>();
    for (const record of Object.values(progress ?? {})) {
      if (!record || record.deletedOn) continue;
      const title = record.series_title;
      if (typeof title !== 'string') continue;
      const key = normalizeSeriesKey(title);
      if (!key || wanted.has(key)) continue;
      wanted.set(key, title);
    }
    if (wanted.size === 0) return pulled;

    for (const row of await db.volumes.toArray()) {
      wanted.delete(normalizeSeriesKey(row.series_title));
    }
    for (const index of await listSeriesIndexes()) {
      wanted.delete(index.series_key);
    }
    if (wanted.size === 0) return pulled;

    for (const title of [...wanted.values()].slice(0, limit)) {
      try {
        await openSeries(title);
        pulled.push(title);
      } catch (error) {
        console.debug(`[hole-patch] could not pull '${title}':`, error);
      }
    }
  } catch (error) {
    console.debug('[hole-patch] pass failed:', error);
  }
  return pulled;
}
```

- [ ] **Step 4: Hook it up**

In `src/lib/util/sync/init-providers.ts`, after the startup sync completes (inside the `if (shouldFetch)` block, after `syncProgress`):

```ts
// Synced progress may reference series this device knows nothing about.
void patchProgressHoles();
```

with `import { patchProgressHoles } from '$lib/metadata/hole-patch';` at the top.

In `src/lib/views/CatalogView.svelte`, extend the existing `onMount`:

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import Catalog from '$lib/components/Catalog.svelte';
  import { enrichAllOrphanedVolumes } from '$lib/settings/volume-data';
  import { patchProgressHoles } from '$lib/metadata/hole-patch';

  onMount(() => {
    // Enrich orphaned volumes when catalog loads
    // This happens after users upload volumes
    enrichAllOrphanedVolumes();
    // …and pull any series the synced progress references but this device has
    // never seen, so the stats views never dangle.
    void patchProgressHoles();
  });
</script>
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/metadata/hole-patch.test.ts && npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/metadata/hole-patch.ts src/lib/metadata/hole-patch.test.ts \
  src/lib/util/sync/init-providers.ts src/lib/views/CatalogView.svelte
git commit -m "feat(metadata): pull series that synced progress references but this device lacks"
```

---

### Task 11: Documentation

**Files:**

- Modify: `CLAUDE.md` (schema table, a `catalog.json` section, the bunko note), `CHANGELOG.md` (`[Unreleased]`)

**Interfaces:**

- Consumes: everything Tasks 1–10 produced. No code changes.

- [ ] **Step 1: Update the schema table in `CLAUDE.md`**

Replace the intro sentence and add the row (the table is at lines 131–141 at HEAD):

```markdown
The application uses a V3 database (`mokuro_v3`) with Dexie, currently at Dexie schema **version 4** (`db-v3.ts`; version 2 added `series_metadata`, version 3 added `series_index`, version 4 added `catalog_index` — all additive, no data migration). Volume data is split across three tables for performance, alongside per-series metadata and index tables:

| Table             | Primary Key   | Indexed Fields                | Purpose                                                                           |
| ----------------- | ------------- | ----------------------------- | --------------------------------------------------------------------------------- |
| `volumes`         | `volume_uuid` | `series_uuid`, `series_title` | Metadata, thumbnails                                                              |
| `volume_ocr`      | `volume_uuid` | —                             | OCR page data (text blocks)                                                       |
| `volume_files`    | `volume_uuid` | —                             | Image files (File objects)                                                        |
| `series_metadata` | `series_key`  | —                             | Per-series AniList link, titles, tag, tracking (key = normalized `series_title`)  |
| `series_index`    | `series_key`  | —                             | Cached `series.json` sidecar + cloud file stamp (download cache, unauthoritative) |
| `catalog_index`   | `series_key`  | —                             | Cached root `catalog.json` entry per series (names/facts only, download cache)    |
```

- [ ] **Step 2: Add the `catalog.json` section to `CLAUDE.md`**

Immediately after the existing `series.json` "Rules" list (which ends with the mokuro-bunko
note around line 291), insert the following section into `CLAUDE.md` verbatim — it is markdown,
so paste it as-is, fences included (it is shown here unwrapped because it contains its own
fenced block):

<!-- BEGIN paste into CLAUDE.md -->

### Root `catalog.json`

The library's name/mapping/search data in one root file, next to
`series-metadata.json`:

```json
{
  "version": 1,
  "updated_at": "2026-08-23T00:00:00.000Z",
  "series": [
    {
      "series_title": "Dr Stone (HD Scan)",
      "titles": { "native": "Dr.STONE", "romaji": "Dr. STONE", "english": "Dr. STONE" },
      "synonyms": [],
      "tag": "HD Scan",
      "unit": "volumes",
      "external_ids": { "anilist": 98416 },
      "updated_at": "2026-08-18T19:36:24.324Z"
    }
  ]
}
```

Rules:

- **Names only.** Each entry is the FACTS subset of that series' `series.json` —
  same keys, same meaning, same facts stamp. No counts, no covers, no volume
  lists: those live in `series.json` and arrive when the series is opened. A
  series with no facts still gets an entry carrying just `series_title` and
  `FACTLESS_UPDATED_AT`, so the catalog can list every folder by name.
- **Load schedule.** Catalog open / provider connect → fetch `catalog.json` when
  its size/mtime changed (`catalog-index-sync.ts`), cache the entries in
  `catalog_index`, apply each entry's facts through `upsertFromSeriesFile` (so
  the factless rules apply unchanged). Series open → refresh that ONE
  `series.json` and materialize its volumes (`series-open.ts`).
- **Name-only cards.** A series in `catalog_index` with nothing local yet renders
  as a name-only catalog card, searchable through the same `seriesSearchTerms`.
  Opening it runs the series-open path.
- **Materialization.** Series open promotes each index entry into a real
  `volumes` row in the metadata-only state (real uuid, counts, `mokuro_version`,
  `spine_width`), so progress attaches and stats count before anything is
  downloaded. It never overwrites an installed row, never gives a volume title a
  second row, and only ever FILLS gaps on an existing metadata-only row — the
  index stays unauthoritative. Covers come from the existing per-volume sidecars
  (`cover-install.ts`), never from the metadata files.
- **Produced by the client** for plain storage backends (Drive/MEGA/WebDAV/
  OneDrive/Local Folder): debounced globally after a fact edit and once per
  backup run, union-by-key with the cloud copy (newest facts stamp wins), pruned
  against the listing, never written from a stale listing. Never produced when
  the provider reports `serverCompilesMetadata` (mokuro-bunko compiles both files
  itself and is their sole producer).
- **Best-effort writes.** A failed `series.json` or `catalog.json` write logs at
  debug and changes nothing else: no read-only fallback, no cleared credentials,
  no snackbar (`isBestEffortMetadataPath`). A server that rejects metadata writes
  while serving reads is a first-class configuration.
- **Hole patching.** Synced progress referencing a series with no local rows and
  no cached index pulls that series' `series.json` and materializes it
  (`hole-patch.ts`), so stats views never dangle.

<!-- END paste into CLAUDE.md -->

Then update the existing mokuro-bunko note under the `series.json` rules to point at the shipped contract:

```markdown
- **mokuro-bunko**: bunko compiles `series.json` and `catalog.json` itself and is
  their sole producer (see `docs/superpowers/plans/2026-08-23-catalog-distribution-bunko.md`);
  it must partition metadata files out of progress handling (root `.json` =
  progress/profiles, `<Series>/series.json` and root `catalog.json` = metadata).
  A scoped user's `series.json` PUT is accepted as an update REQUEST.
```

- [ ] **Step 3: Update `CHANGELOG.md`**

Under `## [Unreleased]` → `### Added`, append:

```markdown
- Browse a cloud library's whole series list before downloading
- Opening a series installs its volume list, stats and covers
```

Under `## [Unreleased]` → `### Changed`, append:

```markdown
- Metadata sync failures no longer switch a server to read-only
```

- [ ] **Step 4: Verify the docs match the code**

Run:

```bash
grep -n "version(4)" src/lib/catalog/db-v3.ts
grep -n "catalog_index" CLAUDE.md
grep -n "serverCompilesMetadata" src/lib/util/sync/provider-interface.ts CLAUDE.md
npx prettier --check CLAUDE.md CHANGELOG.md
```

Expected: each grep hits; prettier reports both files formatted.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md CHANGELOG.md
git commit -m "docs: catalog.json schema, load schedule and write tolerance"
```

---

### Task 12: In-app verification (Playwright, port 5199)

**Files:**

- Create: `e2e/catalog-distribution.spec.ts`

**Interfaces:**

- Consumes: `parseCatalogFile`, `buildCatalogFile`, `stringifyCatalogFile` from `/src/lib/metadata/catalog-file.ts`; `materializeSeriesVolumes` from `/src/lib/catalog/materialize.ts`; `isBestEffortMetadataPath` from `/src/lib/util/sync/syncable-file.ts`; the running app's Dexie database `mokuro_v3` (tables `catalog_index`, `volumes`).
- Produces: no app code. A spec that drives the REAL modules through the Vite dev server (the technique `e2e/zoom.spec.ts` already uses: `await import('/src/lib/…')` inside `page.evaluate`) plus real UI assertions on the catalog and series views.

- [ ] **Step 1: Write the spec**

Create `e2e/catalog-distribution.spec.ts`:

```ts
import { test, expect, type Page } from '@playwright/test';

/**
 * E2E for the catalog distribution client (spec:
 * docs/superpowers/specs/2026-08-23-catalog-distribution-design.md).
 *
 * No cloud account is involved: the spec seeds the REAL Dexie tables the cloud
 * layer would have filled and drives the REAL modules through the Vite dev
 * server, then asserts on the actual rendered catalog and series views.
 */

const CATALOG_JSON = {
  version: 1,
  updated_at: '2026-08-23T00:00:00.000Z',
  series: [
    {
      series_title: 'Dr Stone (HD Scan)',
      external_ids: { anilist: 98416 },
      titles: { native: 'Dr.STONE', english: 'Dr. STONE' },
      synonyms: ['Doctor Stone'],
      tag: 'HD Scan',
      updated_at: '2026-08-18T19:36:24.324Z'
    },
    {
      series_title: 'Bare Folder',
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: '1970-01-01T00:00:00.000Z'
    }
  ]
};

async function seedCatalogIndex(page: Page) {
  await page.goto('/');
  await page.waitForTimeout(1000); // let the app open the database
  await page.evaluate(async (catalog) => {
    const { parseCatalogFile } = await import('/src/lib/metadata/catalog-file.ts');
    const { db } = await import('/src/lib/catalog/db.ts');
    const parsed = parseCatalogFile(catalog)!;
    await db.catalog_index.clear();
    await db.catalog_index.bulkPut(
      parsed.series.map((entry: { series_title: string }) => ({
        series_key: entry.series_title.trim().toLowerCase(),
        series_title: entry.series_title,
        entry,
        source: {
          provider: 'webdav',
          path: 'catalog.json',
          size: 123,
          modifiedTime: '2026-08-23T00:00:00.000Z'
        },
        fetched_at: new Date().toISOString()
      }))
    );
  }, CATALOG_JSON);
}

test.describe('catalog.json', () => {
  test('lists catalog-only series as name-only cards, factless ones by folder name', async ({
    page
  }) => {
    await seedCatalogIndex(page);
    await page.goto('/#/catalog');
    await expect(page.getByText('Dr Stone (HD Scan)')).toBeVisible();
    await expect(page.getByText('Bare Folder')).toBeVisible();
    await expect(page.getByText('Open to load volumes').first()).toBeVisible();
  });

  test('name-only cards are searchable by synonym and alt title', async ({ page }) => {
    await seedCatalogIndex(page);
    await page.goto('/#/catalog');
    await page.getByRole('searchbox').fill('doctor stone');
    await expect(page.getByText('Dr Stone (HD Scan)')).toBeVisible();
    await expect(page.getByText('Bare Folder')).toBeHidden();
  });

  test('a factless entry never creates a series_metadata record', async ({ page }) => {
    await seedCatalogIndex(page);
    const record = await page.evaluate(async () => {
      const { catalogEntryToSeriesFile } = await import('/src/lib/metadata/catalog-file.ts');
      const { upsertFromSeriesFile } = await import('/src/lib/metadata/store.ts');
      const { db } = await import('/src/lib/catalog/db.ts');
      await db.series_metadata.delete('bare folder');
      await upsertFromSeriesFile(
        'Bare Folder',
        catalogEntryToSeriesFile({
          series_title: 'Bare Folder',
          external_ids: {},
          titles: {},
          synonyms: [],
          updated_at: '1970-01-01T00:00:00.000Z'
        })
      );
      return db.series_metadata.get('bare folder');
    });
    expect(record).toBeUndefined();
  });
});

test.describe('materialization', () => {
  test('index entries become metadata-only rows the series view lists as not installed', async ({
    page
  }) => {
    await seedCatalogIndex(page);
    const created = await page.evaluate(async () => {
      const { materializeSeriesVolumes } = await import('/src/lib/catalog/materialize.ts');
      const { db } = await import('/src/lib/catalog/db.ts');
      await db.volumes.clear();
      return materializeSeriesVolumes({
        seriesTitle: 'Dr Stone (HD Scan)',
        entries: [
          {
            volume_uuid: 'e2e-uuid-1',
            volume_title: 'Volume 1',
            page_count: 200,
            character_count: 5000,
            mokuro_version: '0.4.11'
          },
          {
            volume_uuid: 'e2e-uuid-2',
            volume_title: 'Volume 2',
            page_count: 190,
            character_count: 4800,
            mokuro_version: '0.4.11'
          }
        ],
        cloudVolumeTitles: new Set(['Volume 1', 'Volume 2'])
      });
    });
    expect(created).toBe(2);

    await page.goto('/#/series/' + encodeURIComponent('Dr Stone (HD Scan)'));
    await expect(page.getByText('Volume 1')).toBeVisible();
    await expect(page.getByText('Volume 2')).toBeVisible();
    // The series is no longer a name-only card in the catalog.
    await page.goto('/#/catalog');
    await expect(page.getByText('Open to load volumes')).toHaveCount(1); // only Bare Folder
  });

  test('a second materialization pass never duplicates or downgrades', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { materializeSeriesVolumes } = await import('/src/lib/catalog/materialize.ts');
      const { db } = await import('/src/lib/catalog/db.ts');
      const entries = [
        {
          volume_uuid: 'e2e-uuid-1',
          volume_title: 'Volume 1',
          page_count: 1,
          character_count: 1,
          mokuro_version: '0.4.11'
        }
      ];
      const args = {
        seriesTitle: 'Dr Stone (HD Scan)',
        entries,
        cloudVolumeTitles: new Set(['Volume 1'])
      };
      const second = await materializeSeriesVolumes(args);
      const rows = await db.volumes
        .where('series_title')
        .equalsIgnoreCase('Dr Stone (HD Scan)')
        .toArray();
      const row = rows.find((r: { volume_uuid: string }) => r.volume_uuid === 'e2e-uuid-1');
      return { second, count: rows.length, pageCount: row?.page_count };
    });
    expect(result.second).toBe(0);
    expect(result.count).toBe(2);
    expect(result.pageCount).toBe(200); // never downgraded to the index's 1
  });
});

test.describe('write tolerance', () => {
  test('the compiled metadata files are classified as best-effort', async ({ page }) => {
    await page.goto('/');
    const flags = await page.evaluate(async () => {
      const { isBestEffortMetadataPath, isRootConfigFile } = await import(
        '/src/lib/util/sync/syncable-file.ts'
      );
      return {
        catalog: isBestEffortMetadataPath('catalog.json'),
        series: isBestEffortMetadataPath('Dr Stone/series.json'),
        progress: isBestEffortMetadataPath('volume-data.json'),
        archive: isBestEffortMetadataPath('Dr Stone/Volume 1.cbz'),
        listed: isRootConfigFile('catalog.json')
      };
    });
    expect(flags).toEqual({
      catalog: true,
      series: true,
      progress: false,
      archive: false,
      listed: true
    });
  });
});
```

- [ ] **Step 2: Run it on port 5199**

Run:

```bash
E2E_PORT=5199 npx playwright test e2e/catalog-distribution.spec.ts
```

(Add `E2E_CHROMIUM=/path/to/chrome` when a browser build is already cached — see CLAUDE.md "E2E (Playwright)". Port 5173 belongs to the user; never use it.)
Expected: all specs pass. Paste the run output into the task report — no unverified success claims.

- [ ] **Step 3: Re-run the whole verification gate**

Run:

```bash
npx vitest run
npm run check
npx prettier --check src e2e docs/superpowers/plans/2026-08-23-catalog-distribution-client.md
git status --porcelain
```

Expected: all tests pass, no type errors, formatting clean, tree clean apart from the intended files.

- [ ] **Step 4: Commit**

```bash
git add e2e/catalog-distribution.spec.ts
git commit -m "test(e2e): catalog distribution — name-only cards, materialization, write tolerance"
```

---

## Manual verification checklist (after Task 12)

Drive these by hand at `http://localhost:5199` against a real WebDAV/bunko server before calling the feature done:

1. **Catalog open on a 1k-series backend** — the catalog lists every series by name within one listing round-trip; the network panel shows ONE `catalog.json` GET and zero `series.json` GETs.
2. **Second catalog open** — zero `catalog.json` GETs (size/mtime unchanged).
3. **Series open** — exactly one `series.json` GET plus the cover sidecars of that series; volumes appear as "Not on this device" with real page/character counts; covers fill in progressively.
4. **Re-open the same series** — zero `series.json` GETs.
5. **Download one volume** — it becomes installed; no duplicate row is left behind (stranded-row cleanup); its counts come from the archive, not the index.
6. **Scoped bunko user** — edit a series tag: no snackbar, no read-only banner, backup/upload buttons stay enabled, and the server's `series.json` reflects the edit after its regeneration.
7. **Non-bunko provider** — edit a tag, wait 5 s, confirm `catalog.json` appears/updates at the root and its content is compact JSON.
8. **Progress hole** — with progress synced from another device for a series this one has never opened, the reading-speed/stats views show it with a real title and counts after a catalog open.

## Self-Review

Run before declaring the plan done (already performed for this document — findings fixed inline):

**1. Spec coverage**

| Spec section                                                           | Task                                                                                |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `catalog.json` file shape + factless entries                           | 1                                                                                   |
| Compact serializer                                                     | 1 (`stringifyCatalogFile`), asserted in 4 and 12                                    |
| Client production (debounced, union+prune, listing-gated, allowlisted) | 3 (allowlist), 4 (`writeCatalogFile`), 5 (debounce + gates + backup hook)           |
| Bunko is sole producer; no race                                        | 4 (`serverCompilesMetadata`), 5 (gate)                                              |
| Catalog open / provider connect fetch, size/mtime gated                | 6                                                                                   |
| `catalog_index` Dexie table + cache stamp                              | 2                                                                                   |
| Facts merge by facts stamp, factless rules                             | 1 (`catalogEntryToSeriesFile`) + 6 (routes through `upsertFromSeriesFile`)          |
| Name-only cards + `seriesSearchTerms`                                  | 7                                                                                   |
| Series open → single `series.json` refresh, event-driven               | 8 (`refreshSeriesIndexForSeries`, `openSeries`, SeriesView hook)                    |
| Materialization (real uuid, counts, version, spine, `metadata_only`)   | 8                                                                                   |
| Local wins / never overwrite installed / no downgrade                  | 8                                                                                   |
| Shadow rules + placeholder fallback preserved                          | 8 (rule 2; `generatePlaceholders` untouched for bare shares)                        |
| Stranded-row interplay                                                 | 8 (rule 2 prevents the duplicate; `stranded-rows.ts` still cleans up post-download) |
| Lazy covers from per-volume sidecars, bounded                          | 9                                                                                   |
| Hole patching                                                          | 10                                                                                  |
| Write tolerance everywhere (no read-only fallback)                     | 3                                                                                   |
| `catalog_index` cleanup provider-bound + listing-gated                 | 6 (and 4 for the post-write prune)                                                  |
| Docs                                                                   | 11                                                                                  |
| Verification                                                           | 12 + manual checklist                                                               |

Not implemented here, by design: everything under the spec's "Bunko contract" — that is `2026-08-23-catalog-distribution-bunko.md`, a different repository.

**2. Placeholder scan** — no "TBD", no "similar to Task N", no "add appropriate error handling": every error path names its behaviour (debug log, skip, return `undefined`), every step carries the actual code or the actual command. The one forward reference (Task 8 importing `cover-install`) states the exact stub signature to create.

**3. Type consistency** — checked across tasks: `CatalogFileEntry` / `CatalogFile` (1) are used unchanged in 2, 4, 6, 7; `CatalogIndexRecord` (2) in 4, 6, 7; `sourceStampChanged` (2) in 2 only; `catalogNeedsRefresh(rows, cloud, provider?)` (2) in 4 and 6; `writeCatalogFile()` (4) in 5; `ensureFreshCloudListing()` (5) in 5; `refreshSeriesIndexForSeries(seriesTitle)` and `cloudVolumeTitlesFor(seriesTitle)` (8) in 8; `materializeSeriesVolumes({ seriesTitle, entries, cloudVolumeTitles })` (8) in 8, 12; `installCoversForSeries(seriesTitle)` (8 stub / 9 real) in 8, 9; `openSeries(seriesTitle)` (8) in 10; `indexCoverSidecarsByBasePath(files)` (9) in 9; `isBestEffortMetadataPath(path)` (3) in 3, 12. `metadata_only?: true`, `isVolumeInstalled`, `needsDownload` are the existing `volume-state.ts` helpers, never raw flag reads.
