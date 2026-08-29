# Metadata-Only Volumes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Remove from device" keeps the volume's metadata row (thumbnail, real uuid, stats) and deletes only the bulky OCR + image data; the whole project handles the new metadata-only state.

**Architecture:** A `metadata_only?: true` field on `VolumeMetadata` marks the state (parallel to image-only volumes, which are `mokuro_version === ''`). No schema bump (non-indexed field; Dexie stays at v3). Retained rows shadow placeholders (placeholder generation already skips local uuids); placeholders remain only for never-installed volumes. All state checks go through two helpers — never raw flag reads.

**Tech Stack:** SvelteKit 5 runes, Dexie/fake-indexeddb, Vitest+jsdom.

**Spec:** `.superpowers/sdd/local-retention/brief.md` (Brief v2, supersedes v1 — no `volume_thumbnails` table, no Dexie v4, no series_index seeding) + `docs/superpowers/specs/2026-08-16-series-metadata-linking-design.md` for series.json semantics.

## Global Constraints

- Flag name is exactly `metadata_only?: true`; absent on installed volumes; never set on placeholders; cleared by `saveVolume` when files land.
- Helpers in `src/lib/catalog/volume-state.ts`: `isVolumeInstalled(v) = !v.isPlaceholder && !v.metadata_only`, `needsDownload(v) = !!(v.isPlaceholder || v.metadata_only)`.
- No cloud writes introduced; `series.json` building INCLUDES metadata-only rows (real index data).
- CLAUDE.md rules: `relative z-10` modal action rows; no heavy per-instance `$derived`; `{#key}` Migaku rules; port 5173 belongs to the user (verify on 5199).

## Tasks (single implementer dispatch — in flight)

### Task 1: State + deletion API

Files: `src/lib/types/index.ts`, `src/lib/catalog/volume-state.ts` (new), `src/lib/import/database.ts` (+tests)

- [ ] `metadata_only?: true` on `VolumeMetadata`; helpers module.
- [ ] `deleteVolume` → `removeVolumeFiles(uuid)`: tx deletes `volume_ocr`+`volume_files`, `db.volumes.update(uuid, { metadata_only: true })` (thumbnail kept).
- [ ] New `deleteVolumeCompletely(uuid)`: removes all three rows.
- [ ] `saveVolume` clears the flag and keeps an existing thumbnail when the incoming save lacks one.

### Task 2: UI flows

Files: `src/lib/components/VolumeItem.svelte`, `src/lib/views/SeriesView.svelte`, reader open guard, `src/lib/catalog/index.ts`

- [ ] Delete confirms: default = `removeVolumeFiles` (history kept); "delete stats" checkbox = `deleteVolumeCompletely` + stats tombstone; copy updated minimally.
- [ ] Catalog join decorates metadata-only rows with `cloudFileId`/provider (same matching placeholders use) so download works; read-vs-download buttons key off `needsDownload`.
- [ ] Opening a metadata-only volume gets the placeholder-style guard (no crash).

### Task 3: The sweep

- [ ] Inventory EVERY consumer of `isPlaceholder`, `volume_files.get`, `volume_ocr.get`, volumes iteration; per-site decision recorded in the report.
- [ ] Skip metadata-only rows: backup queue, ZIP/CBZ exports, `generateVolumeSidecarsFromDb`, cloud-rename sidecar regeneration, `processThumbnails` (no files → must not retry forever).
- [ ] Include metadata-only rows: `series.json` `localVolumes`, progress tracker (`computeLocalPassState`), stats views, spine showcase.
- [ ] Import dedupe: same-uuid import FILLS the retained row; download-queue replace path uses `deleteVolumeCompletely` then fresh save.
- [ ] `clearOrphanedVolumeData` and similar cleanups treat retained rows as live.

### Task 4: Tests + docs

- [ ] Behavioral tests per site (remove keeps row/thumb/flag; complete delete; reinstall clears flag; shadowed placeholder; skips; includes; reader guard; confirm routing). Update tests that assumed row deletion.
- [ ] CLAUDE.md schema note (metadata-only state; placeholders only for never-installed); CHANGELOG `[Unreleased]`: `- Removing a volume from device keeps thumbnails, stats and history`.

## Cleanup passes (after the implementer lands, in order)

1. **Task review + fix round(s):** standard diff review of the landed range; verified findings fixed and re-reviewed.
2. **Adversarial sweep verification:** a read-only agent independently greps every `volume_files`/`volume_ocr`/`isPlaceholder`/`db.volumes` consumer at HEAD and checks each against the intended semantics table above; any missed site becomes a fix.
3. **Consistency/dead-code pass:** no v1 remnants (`volume_thumbnails`, seeding, `files_removed`), docs/CHANGELOG match behavior, helper usage (no raw `metadata_only` checks outside `volume-state.ts` and the two APIs).
4. **In-app verification (port 5199, Playwright):** import 2-volume series → read pages → remove one from device → catalog/series keep thumbnail + read state; re-download fills the same row; complete-delete forgets; image-only volume removal behaves.
5. **Final gates:** `npx vitest run`, `npm run check`, `npx prettier --check src`, clean tree; ledger closed; memory updated.
