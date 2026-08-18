# Series JSON Sidecar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-volume `series_metadata` embed inside `.mokuro` files with one per-series sidecar `<Series Title>/series.json` (facts + tag), written to the cloud automatically (debounced) and included in exports; `.mokuro` returns to the pure upstream format.

**Architecture:** `src/lib/metadata/series-file.ts` owns the file shape (`buildSeriesFile`/`parseSeriesFile`, `SERIES_FILE_NAME`). The cloud layer treats `series.json` as a managed sidecar of the series folder (allowlist, upload/overwrite, rename move, series delete). A small debounced writer (`series-file-sync.ts`) is triggered by the store whenever the file's fields change and a writable provider is connected. Import (upload modal / ZIP), cloud download, and export learn the file. The `.mokuro` writer/parser lose the embed. The root `series-metadata.json` (per-account prefs/tracking) is unchanged.

**Tech Stack:** SvelteKit 5, Dexie, the `SyncProvider` abstraction (`unified-cloud-manager.ts`, `backup-queue.ts`, `download-queue.ts`, `syncable-file.ts`), zip.js, vitest.

**Spec:** `docs/superpowers/specs/2026-08-16-series-metadata-linking-design.md` — user amendment 2026-08-17: "don't bake this into the mokuro file; a series-level metadata file"; decisions: series.json only (drop the embed); auto-write on change, debounced.

## Global Constraints

- **External dependency (user decision 2026-08-17):** mokuro-bunko currently treats every `.json` as a user progress file. Keep the name `series.json`; bunko must be patched to partition by path (root-level `.json` = progress/profiles; nested `<Series>/series.json` = series metadata, served as a static sidecar) BEFORE this feature is used against a bunko-backed WebDAV library. Track it as a follow-up in the mokuro-bunko repo (deploy recipe in memory `project_mokuro_bunko_deploy.md`).

- Worktree `/home/nathan/Projects/mokuro-reader-worktrees/feat/series-metadata`, branch `feat/series-metadata`.
- File name exactly `series.json`, path `<Series Title>/series.json` (same folder as the volumes; the folder name IS the stored `series_title`, never derived).
- File content = shareable facts + tag ONLY: `{ version: 1, series_title, external_ids, titles, synonyms, tag?, updated_at }` — never `tracking`, `read_count`, `title_preference`, `reread_prompt_suppressed`.
- Newest `updated_at` wins on read (`upsertFromSeriesFile` only applies a strictly newer file); the same timestamp normalisation/clamping as the old embed applies (reuse `sanitize.ts`).
- Cloud writes go through the generic `SyncProvider` interface; read-only providers skip silently; a failed write is logged, never surfaced as an error to the reading flow.
- Auto-write is debounced (2 s per series), only when a writable provider is connected AND the series has at least one backed-up volume (otherwise the backup path writes it later). No UI button.
- Tests `npx vitest run <path>`; `npm run check`; `npx prettier --check src README.md CHANGELOG.md docs CLAUDE.md`. Conventional commits, one per task.

---

### Task 1: `series-file.ts` (shape + parse) and remove the `.mokuro` embed

**Files:**

- Create: `src/lib/metadata/series-file.ts` (+ `series-file.test.ts`) — move/rename the logic of `embed.ts` (`toEmbedded`→`buildSeriesFile(meta) → SeriesFile | undefined` adding `version: 1` and `series_title`; `fromEmbedded`→`parseSeriesFile(value: unknown) → SeriesFile | undefined` accepting only `version === 1`; `SERIES_FILE_NAME = 'series.json'`; `isSeriesFilePath(path)`). Type `SeriesFile` replaces `EmbeddedSeriesMetadata` in `types.ts` (keep a type alias for one release if anything external imports it — nothing does; just rename).
- Modify: `src/lib/util/mokuro-metadata.ts` (drop `series_metadata` from `MokuroMetadata` and `buildMokuroMetadata`; keep `spine_width`), `src/lib/import/processing.ts` (`parseMokuroFile` no longer extracts it; `ParsedMokuro.seriesMetadata` removed), `src/lib/import/types.ts` (`ProcessedMetadata.seriesMetadata` removed), `src/lib/import/database.ts` and `src/lib/catalog/cloud-ocr-upgrade.ts` (remove the `upsertFromEmbedded` calls), `src/lib/metadata/store.ts` (`upsertFromEmbedded` → `upsertFromSeriesFile(seriesTitle, file)`), `src/lib/util/compress-volume.ts` (drop `loadSeriesMetadataForEmbed` and the worker-side series_metadata read), `volume-sidecars.ts`, `zip.ts` (writers no longer look up series metadata for the `.mokuro`).
- Delete: `src/lib/metadata/embed.ts` (+ test) once nothing imports it.
- Tests: update `mokuro-metadata.test.ts`, `import/__tests__/*` (remove the round-trip test or convert it to a series.json round-trip in Task 3), `store.test.ts`, `cloud-ocr-upgrade.test.ts`.

**Interfaces (Produces):**

```ts
export const SERIES_FILE_NAME = 'series.json';
export interface SeriesFile {
  version: 1;
  series_title: string;
  external_ids: SeriesExternalIds;
  titles: SeriesTitles;
  synonyms: string[];
  tag?: string;
  updated_at: string;
}
export function buildSeriesFile(meta: SeriesMetadata | undefined | null): SeriesFile | undefined; // undefined when no ids, no titles, no tag
export function parseSeriesFile(value: unknown): SeriesFile | undefined;
export function isSeriesFilePath(path: string): boolean; // basename === 'series.json' (case-insensitive)
// store.ts
export async function upsertFromSeriesFile(seriesTitle: string, file: SeriesFile): Promise<void>; // strictly-newer wins; clears fetched facts when ids differ (same as before)
```

- [ ] Steps: failing tests for `buildSeriesFile`/`parseSeriesFile` (version gate, shape, undefined cases) → implement → remove the embed everywhere (grep `series_metadata|seriesMetadata|Embedded|upsertFromEmbedded` until only the root sync file's `sanitizeCloudSeriesMetadata` remains) → full suite + check + prettier → commit `refactor(metadata): series.json file shape; drop the .mokuro series_metadata embed`.

### Task 2: Cloud layer — allowlist, write/overwrite, rename, delete; debounced auto-write; remove sidecar refresh

**Files:**

- Modify: `src/lib/util/sync/syncable-file.ts` (`isSidecarFile` also true for `series.json`; doc comment), `src/lib/util/sync/unified-cloud-manager.ts` (new `async writeSeriesFile(seriesTitle: string): Promise<'written' | 'skipped' | 'read-only'>` — builds the file from the store, uploads `<Series>/series.json` with overwrite via `uploadFile`, updates the cache; `renameSeries` writes the file at the new title and deletes the old one (after volumes moved); `deleteSeriesFolder` deletes it; REMOVE `refreshVolumeSidecar`/`refreshSeriesSidecars` and their tests), `src/lib/util/backup-queue.ts` (after a series' first volume backup completes, call `writeSeriesFile(seriesTitle)` if metadata exists), `src/lib/util/series-rename.ts` (no change if `renameSeries` handles it — verify).
- Create: `src/lib/metadata/series-file-sync.ts` — `scheduleSeriesFileWrite(seriesTitle)` (2 s debounce per series; checks `providerManager.status` for a writable connected provider and that `getManagedCloudFilesForVolume` shows at least one backed-up volume for the series; calls `unifiedCloudManager.writeSeriesFile`); `initSeriesFileSync()` idempotent, mounted in `+layout.svelte` after `initProgressTracker()`; wired from `store.ts` `updateSeriesMetadata`/`unlinkSeries`/`upsertFromSeriesFile`?? — NO: only from local user edits (updateSeriesMetadata/unlinkSeries) when a file-relevant field changed (`external_ids`, `titles`, `synonyms`, `tag`), never from sync/import read-backs (avoid write loops).
- Modify: `src/lib/components/Series/SeriesLinkControls.svelte` (remove the "Update cloud sidecars" button, `sidecarsStale` hint, `refreshSeriesSidecars` import; the link modal's `onLinked` no longer needs the stale flag), `SeriesEditorModal.test.ts` / `SeriesLinkControls` tests updated.
- Tests: `unified-cloud-manager.test.ts` (writeSeriesFile happy/overwrite/read-only; rename moves the file; delete removes it), `series-file-sync.test.ts` (debounce coalesces, skips when no provider / not backed up / read-only, fires after edits), `syncable-file.test.ts`.

- [ ] Steps: failing tests → implement → full suite + check + prettier → commit `feat(sync): series.json sidecar written on change, backup, rename; drop sidecar refresh`.

### Task 3: Import / download / export learn `series.json`

**Files:**

- Modify: `src/lib/import/*` — when the selected files or the ZIP/CBZ contain a `series.json` at the series level (root of a series ZIP, or sibling of the `.cbz/.mokuro` for folder/multi-file uploads), parse it with `parseSeriesFile` and, AFTER the volumes are saved, `upsertFromSeriesFile(<final sanitized series_title>, file)`; malformed → dropped with one `console.warn`. Locate the exact hook points by reading `src/lib/import/processing.ts` / `import/database.ts` / the upload flow (`UploadModal`/`file-handler`).
- Modify: `src/lib/util/download-queue.ts` (or wherever a cloud volume download completes / placeholders are built): if the cloud cache lists `<Series>/series.json`, download it once per series and `upsertFromSeriesFile`; `src/lib/catalog/placeholders.ts` may use its titles for placeholder display (optional; skip if noisy).
- Modify: `src/lib/util/zip.ts` (series ZIP export and single-volume ZIP/CBZ export include `series.json` at the archive root when metadata exists), `src/lib/util/volume-sidecars.ts` (local sidecar download offers `series.json` alongside).
- Tests: `import` round-trip: `buildSeriesFile` → ZIP with `series.json` + volume → import → record upserted; download-queue test with a mocked cache/provider; zip export includes the file.

- [ ] Steps: failing tests → implement → full suite + check + prettier → commit `feat(import,export): read and write series.json alongside volumes`.

### Task 4: Docs + spec + verification

- [ ] `CLAUDE.md`: replace the "Reader extension: series_metadata …" paragraph with a "Series metadata sidecar" note (`<Series>/series.json`, shape, written by `series-file.ts`, per-user prefs never in it); Database Schema table row unchanged.
- [ ] `CHANGELOG.md` `[Unreleased]/Added`: replace "Series facts + tag embedded in exported/backed-up `.mokuro` files" with "`series.json` sidecar per series: AniList link, titles, tag (synced, exported)"; drop the "Update cloud sidecars" mention.
- [ ] Spec: amend the "`.mokuro` embed" section → "Series file (`series.json`)" and the sidecar-refresh paragraph → auto-write policy.
- [ ] Playwright (dedicated port; reuse `scratchpad/verify-*` scripts): link + tag a series, export the series ZIP → contains `series.json` with the expected shape and NO `series_metadata` inside the `.mokuro`; fresh profile import of that ZIP restores chips/titles/tag; unit tests cover the cloud paths (no live cloud in CI). Record observed values.
- [ ] Commit `docs: series.json sidecar replaces the .mokuro embed`.
