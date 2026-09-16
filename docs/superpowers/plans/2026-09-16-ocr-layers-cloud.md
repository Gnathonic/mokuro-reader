# OCR layers — cloud half — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Layers travel with the volume in the cloud as `<Volume Title>.<layer-id>.mokuro` files (bunko's engine sidecar shape): classified out of every listing, pulled, pushed, backed up, downloaded, renamed, deleted, imported and exported.

**Architecture:** One pure classifier (`classifyMokuroSidecar`) decides primary / layer / orphan per listing folder from the set of `.cbz` stems. A new `layer-sync.ts` rides the post-listing hook the series index uses: pull stale layer files into `volume_ocr_layers` (stamped with the listing's size/mtime), push rows newer than their stamp. The backup worker, download queue, rename/delete and the import pipeline each gain a small layer step reusing `layers.ts` helpers.

**Tech Stack:** SvelteKit 5, Dexie, Vitest (jsdom + fake-indexeddb), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-15-ocr-editor-layers-engines-design.md` — Sub-project B "Cloud sidecars" + Addendum 2026-09-16.

## Global Constraints

- Layer file name: `<Volume Title>.<layer-id>.mokuro[.gz]`, `layer-id` ∈ `[a-z0-9-]{1,32}`.
- Classification is by archive presence in the SAME listing (primary → layer → orphan).
- `.mokuro` content stays pure upstream (`buildMokuroMetadata`), no reader keys.
- Never a listing fetch from inside a sync run; every stamp comes from the listing.
- Read-only providers: pull only; pushes skip silently.
- Placeholders never get layer rows (only installed / metadata-only rows).

---

### Task 1: Classifier + naming migration

**Files:** Modify `src/lib/util/sync/syncable-file.ts`, `src/lib/util/sync/syncable-file.test.ts`, `src/lib/reader/edit/layers.ts` (`buildLayerExportFile`, add `layerKindForId`, `layerNameForId`, `KNOWN_ENGINE_IDS`), `src/lib/reader/edit/layers.test.ts`, `e2e/ocr-layers.spec.ts` (export filename).

**Produces:**

```ts
export const LAYER_ID_RE = /^[a-z0-9-]{1,32}$/;
export type MokuroSidecarClass =
  | { kind: 'primary'; stem: string; gz: boolean }
  | { kind: 'layer'; stem: string; layerId: string; gz: boolean }
  | { kind: 'orphan' };
/** `cbzStems` = lowercased basenames without `.cbz` of the archives in the SAME folder. */
export function classifyMokuroSidecar(
  basename: string,
  cbzStems: ReadonlySet<string>
): MokuroSidecarClass;
/** Pure split, no listing: `Vol 1.fix.mokuro` → { stem:'Vol 1', layerId:'fix', gz:false }; null when the last segment is not a valid id. */
export function splitLayerSidecarName(
  basename: string
): { stem: string; layerId: string; gz: boolean } | null;
export function layerSidecarName(volumeTitle: string, layerId: string): string; // `${title}.${id}.mokuro`
export function cbzStemsOf(basenames: Iterable<string>): Set<string>;
```

- [ ] Tests: primary wins when `<full>.cbz` listed; layer when `<stem>.cbz` listed; orphan otherwise; `.mokuro.gz`; `Vol 1.5.mokuro` both ways; invalid id (`Vol 1.Fix!.mokuro`) → orphan; `splitLayerSidecarName`; `layerKindForId` table; export file name `Vol 1.english.mokuro`.
- [ ] Implement; delete `.layer.` helpers; update e2e assertion.
- [ ] Commit.

### Task 2: `cloud` stamp + layer-sync pull

**Files:** Modify `src/lib/types/index.ts` (`cloud?: { provider; size?; modified?; synced_at: string }`), Create `src/lib/metadata/layer-sync.ts`, `src/lib/metadata/layer-sync.test.ts`. Modify `src/lib/util/sync/unified-cloud-manager.ts` (`refreshSeriesIndexesInBackground` calls `syncLayersFromListing`).

**Produces:**

```ts
export interface ListedLayerFile {
  folderTitle: string;
  stem: string;
  layerId: string;
  file: CloudFileMetadata;
}
export function collectLayerFiles(
  cloudFilesMap: Map<string, CloudFileMetadata[]>
): ListedLayerFile[];
export function layerNeedsPull(
  row: VolumeOcrLayer | undefined,
  file: CloudFileMetadata,
  provider: ProviderType
): boolean;
export function layerNeedsPush(row: VolumeOcrLayer, file: CloudFileMetadata | undefined): boolean;
export function syncLayersFromListing(cloudFilesMap, providerType): Promise<void>; // pull + push, never rejects
export async function pullLayersForVolume(
  volumeUuid: string,
  providerType: ProviderType
): Promise<number>; // from the cached listing
```

Matching a listed layer to a row: folder title → local rows whose `series_title` folds equal (`normalizeSeriesKey`) and `normalizeVolumeTitleKey(volume_title) === normalizeVolumeTitleKey(stem)`; only rows where `!isPlaceholder` (installed or metadata-only).

Pull rule: `!row` → pull; `row.cloud` absent → pull only if `row.updated_at <= file.modifiedTime` (newest wins); stamps differ and `row.updated_at <= row.cloud.synced_at` → pull; stamps differ and row edited since sync → newest wins by `file.modifiedTime` vs `row.updated_at`.
Push rule: writable non-server… no — bunko compiles metadata but still stores layer files, so push whenever the provider is writable AND the volume's archive is listed AND (`!row.cloud` or `row.updated_at > row.cloud.synced_at`). Skip `original`? No — push it too.

- [ ] Tests (fake-indexeddb): collectLayerFiles classification; pull creates a row with inferred kind/engine/name and stamp; unchanged stamp → no download; local newer → no clobber; push uploads `<title>.<id>.mokuro` and stamps; read-only → no upload; placeholder (no row) → nothing.
- [ ] Implement, wire into the post-listing hook (bound to provider, fire-and-forget).
- [ ] Commit.

### Task 3: Backup worker + export download

**Files:** Modify `src/lib/util/volume-sidecars.ts` (`buildLayerSidecarFilesFromDb(volumeUuid)`), `src/lib/workers/unified-file-worker.ts` (upload layers after mokuro; export branch returns `sidecars.layers`), `src/lib/util/backup-queue.ts` (main-thread upload of `data.sidecars.layers`; export download of layer files), tests in `backup-queue.test.ts`.

- [ ] Tests: export with sidecars not embedded downloads mokuro + layers; main-thread upload path uploads layers.
- [ ] Implement; after a worker layer upload the queue stamps the rows' `cloud` via the returned entries (worker returns `layers: [{filename, size, modifiedTime}]`) — simplest: main thread re-stamps from `uploadCacheEntry` results; if not available, leave unstamped (next listing adopts baseline).
- [ ] Commit.

### Task 4: Download pulls layers; listing sites tested with layer files

**Files:** Modify `src/lib/util/download-queue.ts` (`entriesToDecompressedVolume` routes layer-named entries into `layerFiles`; after save → `pullLayersForVolume`), `src/lib/import/types.ts` (`layerFiles?: File[]` on DecompressedVolume), `src/lib/catalog/placeholders.test.ts`, `src/lib/metadata/cloud-sidecar-stamps.test.ts`, `src/lib/util/sync/sidecar-backfill.test.ts` (layer file present → no gap, no phantom).

- [ ] Tests first, implement, commit.

### Task 5: Rename + delete cascade

**Files:** Modify `src/lib/util/sync/unified-cloud-manager.ts` (`getManagedCloudFilesForVolume` includes layer files via classifier; `renameVolumeFiles` moves them to `${newBasePath}.${id}.mokuro[.gz]`; `deleteManagedVolume` deletes them first), `unified-cloud-manager.test.ts`.

- [ ] Tests: managed files include `Vol 1.paddle-manga.mokuro` but not `Vol 1.5.mokuro` when `Vol 1.5.cbz` exists; rename moves the layer; delete removes it before the cbz.
- [ ] Implement, commit.

### Task 6: Manual import + ZIP entries

**Files:** Modify `src/lib/import/import-service.ts` (standalone layer files → `attachLayerFile`), `src/lib/import/archive-extraction.ts`/`processing.ts` (layer entries beside the volume), `src/lib/reader/edit/layers.ts` (`attachLayerFile(file, {seriesTitle?}): Promise<'attached'|'no-match'>`), tests.

- [ ] Tests: file with matching uuid attaches; uuid mismatch but title matches attaches; no match → reported via snackbar + returns 'no-match'.
- [ ] Implement, commit.

### Task 7: Series ZIP export includes layer files

**Files:** Modify `src/lib/util/zip.ts` (`createAndDownloadArchive` / `createArchiveBlob` add `<title>.<id>.mokuro` entries when `includeSidecars`), `zip.test.ts`.

- [ ] Test, implement, commit.

### Task 8: e2e + live check

- [ ] `e2e/ocr-layers-cloud.spec.ts` (E2E_PORT=5183): seeded installed volume + a stubbed listing pushed straight into the WebDAV cache via `page.evaluate` (bypassing PROPFIND), assert: no phantom, `paddle-manga` row (kind ocr, engine paddle-manga), local edit → push observed (mock `uploadFile`), rename/delete cascade via manager.
- [ ] Live: dev server 5184, Playwright connects WebDAV to http://localhost:8090 anonymously, downloads one Chained Soldier volume, asserts a `paddle-manga` row + picker entry.
- [ ] Full vitest / check / lint; commit.
