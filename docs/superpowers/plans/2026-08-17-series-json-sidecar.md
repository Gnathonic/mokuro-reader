# Series JSON Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-volume `series_metadata` embed inside `.mokuro` files with one per-series sidecar `<Series Title>/series.json` that is (a) the shareable series metadata (AniList link, titles, synonyms, tag) and (b) an **unauthoritative index of the series' volumes** (uuid, title, page/char counts, per-page cumulative chars, mokuro version, spine width) — so other devices can show stats and attach synced progress to volumes they have not installed without downloading every `.mokuro`. The file is written automatically (debounced) when a cloud is connected, cached locally in Dexie, and refreshed only when its cloud `size`/`modifiedTime` changes.

**Architecture:** `src/lib/metadata/series-file.ts` owns the file shape (`buildSeriesFile` with union-by-uuid + prune, `parseSeriesFile`, `SERIES_FILE_NAME`). A new Dexie table `series_index` caches the last fetched file per series with its cloud `size`/`modifiedTime` (`series-index.ts`). The cloud layer treats `series.json` as a managed sidecar of the series folder (allowlist, upload/overwrite, rename move, series delete); `series-file-sync.ts` debounces writes after local edits/backups; `series-index-sync.ts` refreshes changed indexes after every cloud listing. `generatePlaceholders` consumes the index so cloud-only volumes carry real `volume_uuid`s and counts. Import/download/export learn the file. The `.mokuro` writer/parser lose the embed. The root `series-metadata.json` (per-account prefs/tracking) is unchanged.

**Tech Stack:** SvelteKit 5, Dexie (schema version bump), the `SyncProvider` abstraction (`unified-cloud-manager.ts`, `backup-queue.ts`, `download-queue.ts`, `syncable-file.ts`, cache-manager), zip.js, vitest (fake-indexeddb).

**Spec:** `docs/superpowers/specs/2026-08-16-series-metadata-linking-design.md` as amended by the user 2026-08-17: no `.mokuro` embed; per-series `series.json` (bunko will be patched to partition it from progress `.json`s); index fields = uuid, title, page_count, character_count, page_char_counts, mokuro_version, spine_width; placeholders adopt real uuids from the index; union-by-uuid on write + prune entries missing from the cloud listing; refresh on every cloud listing when size/mtime changed; auto-write debounced.

## Global Constraints

- **External dependency:** mokuro-bunko treats every `.json` as a progress file today; keep the name `series.json` and patch bunko to partition by path (root `.json` = progress/profiles; nested `<Series>/series.json` = static series sidecar) before using this against a bunko-backed library (bunko deploy recipe: memory `project_mokuro_bunko_deploy.md`).
- Worktree `/home/nathan/Projects/mokuro-reader-worktrees/feat/series-metadata`, branch `feat/series-metadata`.
- Path `<Series Title>/series.json`; the folder name IS the stored `series_title`, never derived. Content is **unauthoritative**: local IndexedDB always wins for installed volumes; the index only fills gaps for volumes not installed.
- File content: `{ version: 2, series_title, external_ids, titles, synonyms, tag?, updated_at, volumes: SeriesFileVolume[] }` — never `tracking`, `read_count`, `title_preference`, `reread_prompt_suppressed`, thumbnails, or page/OCR data.
- Newest `updated_at` wins for the metadata facts (`upsertFromSeriesFile` applies only strictly newer); timestamps normalised/clamped via `sanitize.ts`. Volume entries are merged by `volume_uuid` (local wins).
- Cloud writes via the generic `SyncProvider` interface; read-only providers skip silently; write failures are logged, never surfaced to a reading flow.
- Auto-write is debounced (2 s per series) and runs only when a writable provider is connected and the series has ≥1 backed-up volume; the backup path writes it after a series' uploads finish. No UI button.
- Index refresh is bounded (max 4 concurrent downloads, background, after `fetchAllCloudVolumes`), only for files whose (`size`, `modifiedTime`) differ from the cached copy.
- Tests `npx vitest run <path>`; `npm run check`; `npx prettier --check src README.md CHANGELOG.md docs CLAUDE.md`. Conventional commits, one per task.

---

### Task 1: `series-file.ts` (v2 shape, union/prune builder, parser) and remove the `.mokuro` embed

**Files:**

- Create: `src/lib/metadata/series-file.ts` (+ `series-file.test.ts`)
- Modify: `src/lib/metadata/types.ts` (add `SeriesFileVolume`, `SeriesFile`; remove `EmbeddedSeriesMetadata`), `src/lib/metadata/store.ts` (`upsertFromEmbedded` → `upsertFromSeriesFile(seriesTitle, file)`), `src/lib/util/mokuro-metadata.ts` (drop `series_metadata`), `src/lib/import/processing.ts` + `import/types.ts` (drop `seriesMetadata`), `src/lib/import/database.ts` + `src/lib/catalog/cloud-ocr-upgrade.ts` (drop the embed upserts), `src/lib/util/compress-volume.ts` (drop `loadSeriesMetadataForEmbed`), `src/lib/util/volume-sidecars.ts`, `src/lib/util/zip.ts` (writers stop looking up series metadata for the `.mokuro`)
- Delete: `src/lib/metadata/embed.ts` + test; update `mokuro-metadata.test.ts`, `import/__tests__/*`, `store.test.ts`, `cloud-ocr-upgrade.test.ts`

**Interfaces (Produces):**

```ts
export const SERIES_FILE_NAME = 'series.json';
export interface SeriesFileVolume {
  volume_uuid: string;
  volume_title: string;
  page_count: number;
  character_count: number;
  page_char_counts: number[];
  mokuro_version: string;
  spine_width?: number;
}
export interface SeriesFile {
  version: 2;
  series_title: string;
  external_ids: SeriesExternalIds;
  titles: SeriesTitles;
  synonyms: string[];
  tag?: string;
  updated_at: string;
  volumes: SeriesFileVolume[];
}
export function volumeToIndexEntry(v: VolumeMetadata): SeriesFileVolume;
export function buildSeriesFile(args: {
  seriesTitle: string;
  meta: SeriesMetadata | undefined;
  localVolumes: VolumeMetadata[];
  existing?: SeriesFile;
  cloudVolumeTitles?: Set<string>;
}): SeriesFile | undefined;
// facts from meta (else from existing); volumes = union by volume_uuid of existing.volumes and local (local wins),
// then if cloudVolumeTitles is given drop entries whose volume_title is not listed AND not local; sorted by sortVolumes;
// undefined when there are no facts AND no volumes
export function parseSeriesFile(value: unknown): SeriesFile | undefined; // accepts version 1 (no volumes → []) and 2; validates every field; drops bad entries
export function isSeriesFilePath(path: string): boolean; // basename === 'series.json' (case-insensitive)
// store.ts
export async function upsertFromSeriesFile(seriesTitle: string, file: SeriesFile): Promise<void>; // metadata facts only, strictly-newer wins, clears fetched facts when ids differ
```

- [ ] Steps: failing tests (builder union/prune/sort/undefined; parser v1/v2/junk; `volumeToIndexEntry`) → implement → remove the embed everywhere (grep `series_metadata|seriesMetadata|Embedded|upsertFromEmbedded` until only `sanitizeCloudSeriesMetadata`/root-sync references remain) → full suite + check + prettier → commit `refactor(metadata): series.json v2 shape with volume index; drop the .mokuro series_metadata embed`.

### Task 2: `series_index` Dexie table + cache store

**Files:**

- Modify: `src/lib/catalog/db-v3.ts` (`version(3)`: add `series_index: 'series_key'`; mirror in `compress-volume.ts`'s worker handle)
- Create: `src/lib/metadata/series-index.ts` (+ test on fake-indexeddb)

**Interfaces (Produces):**

```ts
export interface SeriesIndexRecord {
  series_key: string;
  series_title: string;
  file: SeriesFile;
  source: { provider: string; path: string; size: number; modifiedTime: string };
  fetched_at: string;
}
export async function getSeriesIndex(seriesKey: string): Promise<SeriesIndexRecord | undefined>;
export async function putSeriesIndex(rec: SeriesIndexRecord): Promise<void>;
export async function deleteSeriesIndex(seriesKey: string): Promise<void>;
export async function moveSeriesIndexKey(oldTitle: string, newTitle: string): Promise<void>;
export const seriesIndexMap: Readable<Map<string, SeriesIndexRecord>>; // liveQuery, empty Map before load
export function indexNeedsRefresh(
  rec: SeriesIndexRecord | undefined,
  cloud: { size: number; modifiedTime: string }
): boolean; // pure
```

- [ ] Steps: failing tests → implement → suite/check/prettier → commit `feat(metadata): series_index cache table`.

### Task 3: Cloud writer — allowlist, `writeSeriesFile`, backup/rename/delete hooks, debounced auto-write; remove sidecar refresh

**Files:**

- Modify: `src/lib/util/sync/syncable-file.ts` (`series.json` counts as a sidecar), `src/lib/util/sync/unified-cloud-manager.ts` (`async writeSeriesFile(seriesTitle): Promise<'written'|'skipped'|'read-only'>` — inputs: local volumes of the series from `db.volumes`, `getSeriesMetadataForTitle`, existing = `getSeriesIndex(...)?.file` (or a fresh download if the cloud copy is newer than the cache), `cloudVolumeTitles` from the cache listing of that folder; upload with overwrite; update cache; `putSeriesIndex` with the uploaded size/mtime; `renameSeries` writes at the new title + deletes the old file; `deleteSeriesFolder` deletes it; REMOVE `refreshVolumeSidecar`/`refreshSeriesSidecars` + tests), `src/lib/util/backup-queue.ts` (after a series' uploads complete → `writeSeriesFile`), `src/lib/components/Series/SeriesLinkControls.svelte` (remove the "Update cloud sidecars" button/stale hint; update tests)
- Create: `src/lib/metadata/series-file-sync.ts` — `scheduleSeriesFileWrite(seriesTitle)` (2 s per-series debounce; skip when no writable provider or the series has no backed-up volume); `initSeriesFileSync()` idempotent, mounted in `+layout.svelte`; wired from `store.ts` `updateSeriesMetadata`/`unlinkSeries` when a file-relevant field changed (`external_ids`, `titles`, `synonyms`, `tag`) — never from sync/import read-backs (no write loops)
- Tests: `unified-cloud-manager.test.ts` (write happy/overwrite/read-only, union with existing cloud copy, prune, rename moves, delete removes), `series-file-sync.test.ts` (debounce, gates), `syncable-file.test.ts`

- [ ] Steps: failing tests → implement → suite/check/prettier → commit `feat(sync): write series.json index on edit, backup, rename; drop sidecar refresh`.

### Task 4: Index refresh after cloud listing + placeholders adopt the index

**Files:**

- Create: `src/lib/metadata/series-index-sync.ts` — `refreshSeriesIndexes(cloudFilesMap)`: for each series folder with a `series.json` in the listing, `indexNeedsRefresh` → download (max 4 concurrent), `parseSeriesFile`, `putSeriesIndex` (+ `upsertFromSeriesFile` for the facts); called at the end of `unifiedCloudManager.fetchAllCloudVolumes()` (fire-and-forget, non-fatal)
- Modify: `src/lib/catalog/placeholders.ts` (`generatePlaceholders(cloudFilesMap, localVolumes, indexMap?)`: for a cloud-only volume whose series index has an entry with the same `volume_title` → use its `volume_uuid`, `page_count`, `character_count`, `page_char_counts`, `mokuro_version`, `spine_width`; else today's deterministic fallback; skip a placeholder when a LOCAL volume already has that uuid), `src/lib/catalog/index.ts` (`volumesWithPlaceholders` joins `seriesIndexMap`), `src/lib/util/download-queue.ts` (a queued placeholder keeps its uuid; after download the imported volume's real uuid must equal it — verify the import path uses the `.mokuro`'s uuid and dedupes; document any mismatch handling)
- Tests: `series-index-sync.test.ts` (refresh only when changed; concurrency cap; bad file dropped), `placeholders.test.ts` (adopts uuid/counts; fallback; no duplicate with a local uuid), `catalog-store.test.ts` (join)

- [ ] Steps: failing tests → implement → suite/check/prettier → commit `feat(catalog): refresh series.json indexes after cloud listing; placeholders adopt real uuids and counts`.

### Task 5: Import / export learn `series.json`

**Files:**

- Modify: import flow (`src/lib/import/*`, upload modal file handler): a `series.json` among the selected files / at the root of a series ZIP → after volumes save, `upsertFromSeriesFile(<final sanitized series_title>, file)` and `putSeriesIndex` (source = `{provider:'import', path, size: file.size, modifiedTime: file.lastModified}`); malformed → one `console.warn`
- Modify: `src/lib/util/zip.ts` (series ZIP export and single-volume ZIP/CBZ export include `series.json` built from local volumes at the archive root), `src/lib/util/volume-sidecars.ts` (local sidecar download offers `series.json`)
- Tests: import round-trip (build → ZIP → import → record + index), zip export includes the file

- [ ] Steps: failing tests → implement → suite/check/prettier → commit `feat(import,export): read and write series.json alongside volumes`.

### Task 6: Docs, spec, verification

- [ ] `CLAUDE.md`: replace the "Reader extension: series_metadata …" paragraph with a "Series sidecar `series.json`" section (shape v2, unauthoritative index, cache table `series_index`, refresh rule, bunko note); Database Schema table: add `series_index` row.
- [ ] `CHANGELOG.md` `[Unreleased]/Added`: replace the embed line with "`series.json` per series: link, titles, tag and a volume index (stats for not-installed volumes)"; drop "Update cloud sidecars".
- [ ] Spec: amend the "`.mokuro` embed" and sidecar-refresh sections → "Series file (`series.json`)" + index + refresh policy.
- [ ] Playwright (dedicated port): link + tag a 2-volume series, export the series ZIP → `series.json` v2 with two volume entries (uuid/pages/chars/page_char_counts) and NO `series_metadata` in the `.mokuro`; fresh profile: import the ZIP → record + index cached, catalog shows the linked titles/tag. Unit tests cover the cloud paths.
- [ ] Commit `docs: series.json index replaces the .mokuro embed`.
