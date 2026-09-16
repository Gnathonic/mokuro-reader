# In-reader OCR editor, OCR layers, and OCR/translation engines — Design

**Date:** 2026-09-15
**Status:** approved in session; implemented in three PRs off `develop` (A, B, C below).
**Supersedes:** PR #149 `feature/text-box-editor-with-ocr` (separate edit page, unreviewed
OCR port) and the `textEditable` reader setting, which set `contenteditable` on the text
boxes and never read the edits back.
**Motivation:** the reader has no way to fix bad OCR. The old attempt lived on its own
route with its own state model; this design puts editing inside the reader, persists it
through the existing OCR row so backups carry it for free, and generalises the storage
into named OCR layers so alternate OCR engines and translations can sit beside the
original without ever corrupting it.

## Decisions (user, 2026-09-15)

1. **Scope of edit mode:** per-line text editing, box move/resize/add/delete, merge and
   split, undo/redo. Plus alternate OCR layers, Google Cloud Vision OCR, and LLM
   translation as an **experimental** feature that may be pulled if results disappoint.
2. **Persistence:** autosave to the primary OCR row, with the pre-edit pages kept as an
   immutable `original` layer so "revert page" works forever.
3. **Entry point:** an Edit button in the reader's quick actions. Paged mode only in this
   cut; scroll modes show it disabled. The settings toggle `textEditable` is removed.
4. **Cloud push:** no dedicated push. The existing backup path re-serialises the `.mokuro`
   sidecar from the OCR row, so edits reach the cloud on the next backup. Sub-project A
   verifies that path actually re-uploads an edited sidecar.
5. **Layers sync to the cloud** as extra sidecars, one file per layer.
6. **Engines:** Google Cloud Vision by API key stored in settings; runs per page or per
   volume. Translation is manual plus machine translation through LLM adapters, Gemini as
   the default engine.
7. **Layer sidecar naming** `<Volume Title>.layer.<layer-id>.mokuro` and Gemini as the
   default translation engine — confirmed.

## Decomposition

Three sub-projects, three PRs, built in order. Each depends on the one before it.

| Sub-project | Delivers                                                                  | Branch             |
| ----------- | ------------------------------------------------------------------------- | ------------------ |
| A           | In-reader edit mode, autosave to primary, `original` layer, revert page   | `feat/ocr-editor`  |
| B           | Layer table UI, layer picker, promote/export, cloud layer sidecars, bunko | `feat/ocr-layers`  |
| C           | Cloud Vision OCR → layer, LLM translation → layer, engine settings card   | `feat/ocr-engines` |

A ships the layer table (schema) because `original` is a layer. B ships everything that
makes layers visible and synced. C ships the producers.

---

## Sub-project A — In-reader edit mode

### Entry and exit

- `QuickActions.svelte` gains an **Edit** item. It is enabled only when the active surface
  is `PagedViewport` (scroll modes: rendered disabled with a "paged mode only" title).
- Entering edit mode sets a reader-level `editSession` (see State). Leaving it (Escape,
  the toolbar's Exit, page navigation away from the volume, or the reader unmounting)
  flushes any pending save first.
- Page turns while editing are allowed: the session is per volume, and the current page's
  edit state swaps to the new page. The undo stack is per page (see State).
- The `textEditable` setting is deleted from `Settings`, `defaultSettings`,
  `ReaderToggles.svelte`, and `TextBoxes.svelte`. Existing persisted profiles that still
  carry the key are ignored (no migration needed; unknown keys are already tolerated).

### What the page looks like in edit mode

`TextBoxes.svelte` stays the read-mode renderer. Edit mode mounts a sibling overlay,
`EditOverlay.svelte`, inside `MangaPage.svelte` (same coordinate space as the page image)
and hides the read-mode boxes while active. The overlay renders **every raw block** of the
page (no `dedupeBlocks`; duplicates are exactly the thing a user may want to delete), each
as an `EditableBlock.svelte`:

- outline always visible; selected block gets a stronger outline and handles;
- **drag on the body** moves the box; **8 handles** (4 corners, 4 edges) resize it;
- **single click** selects; **double click** opens the text editor for the block: one
  `contenteditable` line element per `lines[i]`, Enter inserts a line after the current
  one, Backspace on an empty line removes it, Escape closes the editor, clicking outside
  commits;
- text is shown in the block's writing mode (vertical-rl for `vertical: true`) using the
  same font sizing path as read mode so the user sees what a reader will see.

A floating `EditToolbar.svelte` (fixed to the viewport, not the page) carries:
draw new box · delete · merge · split · flip writing mode · undo · redo · revert page ·
exit. Buttons are disabled when their precondition does not hold (merge needs ≥ 2
selected; split needs a block with ≥ 2 lines and a chosen line; undo/redo need history).

Keyboard while in edit mode (only when focus is not inside a contenteditable line):
`Ctrl+Z` undo, `Ctrl+Shift+Z` / `Ctrl+Y` redo, `Delete`/`Backspace` delete selected,
`Escape` clears selection then exits, `Shift+click` adds to the selection. Reader page-flip
shortcuts (arrows, space) keep working when nothing is selected and no line editor is
open; `keyboardShouldIgnore` already returns true inside contenteditable.

### Gesture contract

The overlay's blocks carry the class `editBlock`, **not** `.textBox`. `gestureTargetRole`
gains a fourth role, `'editor'`, matched first:

- pointer downs on an `editBlock` or a handle are owned by the overlay (it calls
  `setPointerCapture` and stops propagation) — no pan, no tap, no Anki double-tap, no
  Yomitan drag-select;
- pointer downs on the page background behave exactly as in read mode (pan, pinch, tap,
  double-tap zoom), so the user can still navigate while editing;
- "draw new box" arms the overlay: the next drag on the page background draws a rectangle
  instead of panning. The overlay owns that drag; the surface never sees it.

`PagedViewport`'s tracker config filters the `'editor'` role out of tap/swipe detection
the same way it filters `'textbox'`. Two-pointer pinch still wins everywhere (contract
unchanged). `docs/INPUT-CONTRACTS.md` gets a short "Edit overlay" section recording this.

### State

New module `src/lib/reader/edit/`:

| File                     | Purpose                                                                                                                                                                                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `edit-ops.ts`            | Pure functions `Page → Page`: `moveBlock`, `resizeBlock`, `setBlockLines`, `addBlock`, `removeBlocks`, `mergeBlocks`, `splitBlock`, `flipBlock`. Never mutate; always return a new page with new block objects only where changed.                                                              |
| `edit-history.ts`        | `EditHistory` — an undo/redo stack over `Page` snapshots with a `coalesceKey` so a continuous drag produces one history entry (pushes with the same key within 400 ms replace the last entry).                                                                                                  |
| `edit-session.svelte.ts` | `EditSession` (runes class): `volumeUuid`, `pageIndex`, `page` (working copy), `selection: Set<number>`, `tool: 'select' \| 'draw'`, `history`, `dirty`. Applies ops, drives the debounced save, and swaps page on navigation.                                                                  |
| `edit-persist.ts`        | `persistPageEdit(volumeUuid, pageIndex, page)`: single Dexie transaction updating `volume_ocr.pages[pageIndex]` and recomputing `page_char_counts` / `character_count` on the `volumes` row via `buildPageCharCounts` (`cloud-ocr-upgrade.ts`). Also `ensureOriginalLayer(volumeUuid)` (below). |
| `block-geometry.ts`      | `translateQuads`, `scaleQuads`, `unionBox`, `splitBoxAtLine`, `estimateFontSize` — the geometry helpers the ops share.                                                                                                                                                                          |

Op semantics that matter:

- **Move/resize** also transform `lines_coords` (translate; or scale about the old box so
  quads keep their relative placement). `font_size` is untouched by move; resize rescales
  it by the axis that matters for the writing mode (height for horizontal, width for
  vertical). Boxes are clamped to the image bounds.
- **setBlockLines** replaces `lines`. If the line count changes, `lines_coords` is dropped
  for that block (per-line layout falls back to the legacy hover-fit path, which is what
  the reader already does for blocks without quads). If the count is unchanged, quads are
  kept.
- **addBlock** creates `{ box, vertical: <inherit page majority>, font_size: estimated from
box dims, lines: [''] }`, no `lines_coords`, and opens its text editor immediately.
- **mergeBlocks** produces one block at the union box, `lines` concatenated in reading
  order of the source blocks (vertical: right-to-left by `xmax`; horizontal: top-to-bottom
  by `ymin`), writing mode from the largest source, quads concatenated in the same order,
  `font_size` from the largest source. The merged block takes the lowest source index.
- **splitBlock(index, atLine)** produces two blocks: lines `[0, atLine)` and
  `[atLine, n)`. The box is divided along the writing axis proportionally to line count
  when there are no quads, or at the boundary between the two quad groups when there are.
- **flipBlock** toggles `vertical` and swaps the box's aspect about its centre only if the
  user confirms (a flip on a real bubble is usually a correction of the flag, not of the
  geometry, so the default is to leave the box alone).

Saving: `EditSession` debounces 500 ms after the last op and calls `persistPageEdit`.
Exit/navigation flushes synchronously. Saves are per page, so a long session never
rewrites the whole volume.

### Original layer and revert

The first successful save for a volume calls `ensureOriginalLayer(volumeUuid)`, which
copies the OCR row's pages into the layer table as `{ layer_id: 'original', kind:
'original' }` if no such row exists. It runs inside the same transaction as the first save
so a crash cannot leave an edited primary without its original.

"Revert page" replaces the working page with `original.pages[pageIndex]` (a normal op, so
it is undoable) and saves. When there is no original layer (never edited) the button is
disabled.

### Schema

`db-schema.ts` gains **version 3**, additive:

```
volume_ocr_layers: '[volume_uuid+layer_id], volume_uuid'
```

Row shape (`VolumeOcrLayer`, `src/lib/types`):

```ts
{
  volume_uuid: string;
  layer_id: string;          // slug [a-z0-9-]{1,32}; 'original' is reserved
  name: string;              // display name
  kind: 'original' | 'edit' | 'ocr' | 'translation';
  engine?: string;           // 'gcv', 'gemini:…', 'anthropic:…', 'openai:…'
  created_at: string;        // ISO
  updated_at: string;        // ISO — bumped on every local write
  pages: Page[];             // full page array, DB-shaped (no cumulativeChars)
  cloud?: { provider: string; size?: number; modified?: number };  // B
}
```

Anything that deletes a volume completely (`deleteVolumeCompletely`, the catalog "clear"
paths) deletes its layer rows too. "Remove from device" (`removeVolumeFiles`) leaves them:
layers are OCR, not pages, and cost little.

### Cloud (verification only)

A edits the primary row, so the existing backup serialiser
(`buildVolumeSidecarsFromData`) already yields the edited `.mokuro`. A must prove, with a
test on `backup-queue`/`sidecar-backfill`, that a volume whose OCR row changed after its
last backup is re-uploaded (its serialised size differs from the listed stamp, so
`isSidecarStale` should fire). If the backup path skips already-backed-up volumes before
reaching that check, A adds the minimal hook: `persistPageEdit` clears the volume's
backed-up marker the same way a re-import does. Whichever it is, the spec's promise is
"edits reach the cloud on the next backup" and A ends with that demonstrated.

### Testing

- Unit: every op in `edit-ops.ts` (including quad transforms and clamping), `EditHistory`
  coalescing, `persistPageEdit` char recount, `ensureOriginalLayer` idempotence and
  transaction atomicity, `gestureTargetRole('editor')`.
- Component: `EditOverlay` renders raw blocks (duplicates included); double click opens
  the line editor; Enter/Backspace line behaviour; toolbar button enablement.
- E2E (Playwright, `e2e/ocr-editor.spec.ts`): import a small fixture volume, enter edit
  mode, move a box, resize it, change a line's text, reload, assert the persisted page
  reflects all three. Second case: revert page restores the original.
- Manual: with Yomitan installed, confirm read mode scanning is unchanged and edit mode
  drags do not select text.

---

## Sub-project B — OCR layers

### Model

The **primary** OCR is the `volume_ocr` row. It is what the reader shows by default, what
every existing consumer reads (stats, exports, backups, cloud OCR upgrade), and what
`series.json`/bunko see. Nothing about it changes.

**Alternate layers** are rows in `volume_ocr_layers`. `original` (from A) is one; B adds
user-created (`edit`), engine-produced (`ocr`, `translation`) layers.

The reader shows one layer at a time. The choice is per volume and per device, stored in
`VolumeSettings` as `ocrLayer?: string` (absent = primary). It rides `volume-data.json`
like `rightToLeft` does. A missing layer id on another device silently falls back to
primary.

### UI

- **Layer picker** in the quick actions menu (only when the volume has ≥ 1 alternate
  layer, or always in edit mode): lists Primary and every layer with its kind badge.
- **Edit mode edits the displayed layer.** Editing an alternate layer writes to its row
  (bumping `updated_at`); editing primary behaves as in A. Revert page reverts from
  `original` in both cases.
- **Layer actions** (in the picker's overflow, and in the volume settings modal):
  - _New layer_: copy of the displayed layer or empty (all blocks removed), named by the
    user.
  - _Rename_ (`original` cannot be renamed or deleted).
  - _Promote to primary_: copies the layer's pages into `volume_ocr`, recounts chars. The
    previous primary is preserved as a new layer `replaced-<yyyymmdd-hhmm>` unless it is
    byte-equal to `original`.
  - _Export_: downloads `<Volume Title>.layer.<id>.mokuro` — the standard mokuro JSON built
    by `buildMokuroMetadata` from the layer's pages.
  - _Delete_.
- Volume export/series ZIP export include layer files beside the `.mokuro` (opt-in
  checkbox in the export modal, default on).

### Cloud sidecars

File per layer: `<Volume Title>.layer.<layer-id>.mokuro`, same folder as the volume's
`.cbz`. Plain JSON, same content as the export. The `.layer.` token is reserved:
`layer_id` is restricted to `[a-z0-9-]` so the pattern
`^(?<title>.+)\.layer\.(?<id>[a-z0-9-]+)\.mokuro(\.gz)?$` is unambiguous.

Reader side:

- `syncable-file.ts`: `isLayerSidecar(basename)`; `isSidecarFile` stays true for it (it is
  syncable) but every place that pairs a `.mokuro` with a volume (`unified-cloud-manager`'s
  `stripManagedFileExtension`, the OCR-upgrade matcher, `cloud-sidecar-stamps`, the
  download queue's archive-entry scan, `series-backfill`) must call the layer parser first
  and route layer files to the layer sync rather than treating them as the volume's OCR.
  Test each site with a layer file present.
- **Upload**: the backup worker's sidecar phase adds every layer of the volume (including
  `original`) to the sidecar list. Layer files upload after the `.mokuro`, before the
  `.cbz`, and follow the same idempotent-overwrite rule.
- **Staleness**: each layer row stores the cloud stamp it last synced with. After every
  listing, `layer-sync.ts` (new, modelled on `series-index-sync.ts`) compares stamps: a
  listed layer file with a different size/newer mtime than the local row's stamp is
  pulled (max 4 concurrent); a local row newer than its stamp (local `updated_at` after
  the last sync) is pushed when the provider is writable. A layer listed in the cloud with
  no local row is pulled only for **installed or metadata-only** volumes (never for
  placeholders — same rule as covers).
- **Conflict**: newest wins, no merge (a layer is one author's document). The file never
  embeds a stamp — `.mokuro` stays pure upstream — so the cloud mtime is the stamp, exactly
  as `series_index` does; local `updated_at` is compared against it.
- **Rename** (`renameVolume`, series rename) moves layer files with the other sidecars;
  **delete** (`deleteVolume` and the series folder delete) removes them. Both already
  enumerate sidecars by extension; they gain the layer pattern.
- Read-only providers: pull only; pushes skip silently (same as `series.json`).

### mokuro-bunko

Bunko matches sidecars by suffix in five places (`database.py` path→cbz mapping,
`metadata/compiler.py::_sidecar_for`, `ocr/watcher.py`, `middleware/fs_watcher.py`,
`webdav/resources.py::_VOLUME_SIDECAR_SUFFIXES`) and would currently either mint a
phantom volume `Vol 1.layer.translation` or feed the layer to its OCR pipeline. Before B
merges, bunko gets a patch (separate repo, `mokuro-webdav-library`): recognise the
`.layer.<id>.mokuro` pattern, map it to its `.cbz` for ownership/permission purposes,
serve it as an opaque file, and **exclude it** from series compilation, OCR, and the
watcher's sidecar handling. The test instance at `:9090` is restarted from that patch for
the B verification.

### Testing

- Unit: layer parser/round-trip; every pairing site with a layer file in the listing;
  `layer-sync` pull/push/stale decisions; promote (including the `replaced-…` snapshot).
- E2E against the local bunko: create a layer, back up, confirm the file appears with the
  right name and bunko's `series.json` still lists exactly one volume; delete the volume
  from cloud and confirm the layer file is gone; pull the layer on a second (fresh) profile.

---

## Sub-project C — Engines (experimental)

### Settings

New settings card **"OCR & translation engines (experimental)"** under Settings:

| Field                                  | Storage                               |
| -------------------------------------- | ------------------------------------- |
| Google API key (Cloud Vision + Gemini) | `localStorage` `engine_google_key`    |
| Anthropic API key                      | `localStorage` `engine_anthropic_key` |
| OpenAI-compatible base URL, key, model | `localStorage` `engine_openai_*`      |
| Default translation engine + model     | `miscSettings.translationEngine`      |
| Target language (default `en`)         | `miscSettings.translationLanguage`    |

Keys are never placed in `profiles.json` or any synced store. Engine features are hidden
from the toolbar until the relevant key exists. The card carries a short cost note per
engine and the experimental label.

### Cloud Vision OCR

`src/lib/engines/gcv.ts`:

- `POST https://vision.googleapis.com/v1/images:annotate?key=…` with
  `DOCUMENT_TEXT_DETECTION`, `languageHints: ['ja']`, image as base64 from `volume_files`.
  Images over 4 MP are downscaled on a canvas first (Vision's accuracy does not improve
  past that and the payload shrinks); coordinates are scaled back to image space.
- `gcvToPage(response, page)` converts `fullTextAnnotation.pages[].blocks[]` to mokuro
  blocks: `box` from the block's bounding poly; each paragraph's words joined into lines
  by `detectedBreak` (`LINE_BREAK`, `EOL_SURE_SPACE`); `vertical` from the block's symbol
  flow (symbol centres advancing mostly in y with lines advancing in −x); `font_size` from
  the median symbol extent along the cross-writing axis; `lines_coords` from each line's
  symbol-box union as a 4-point quad. Furigana-sized lines (median symbol extent < 55 % of
  the block median, positioned beside a larger line) are dropped, matching what mokuro
  itself emits.
- Results land in layer `gcv` (kind `ocr`, engine `gcv`), creating it on first use and
  overwriting only the pages that were run.
- Entry points: **OCR this page** (edit toolbar) and **OCR whole volume** (volume settings
  modal and the picker's overflow). Whole volume shows page count and the cost note
  ("about $1.50 per 1000 pages after the free monthly 1000") before starting, runs through
  a small queue (concurrency 2, retries on 429/5xx with backoff, cancel button, progress
  in the existing progress tracker store), and switches the displayed layer to `gcv` when
  done.

### LLM translation

`src/lib/engines/translate/` with one interface and three adapters:

```ts
interface TranslationAdapter {
  id: 'gemini' | 'anthropic' | 'openai';
  translatePage(
    input: {
      seriesTitle: string;
      volumeTitle: string;
      target: string;
      blocks: { index: number; text: string }[];
    },
    signal: AbortSignal
  ): Promise<{ index: number; text: string }[]>;
}
```

- **gemini**: `generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`
  with the Google key; default model `gemini-2.5-flash`, JSON response mode.
- **anthropic**: Messages API with the browser-access header; default `claude-haiku-4-5`.
- **openai**: chat completions at the configured base URL; covers OpenAI, DeepSeek,
  OpenRouter, local servers.

Prompt: system text fixes the role (manga translator, keep honorifics, match register,
one output per input index, JSON only). User content lists the page's blocks in reading
order — RTL pages sorted by `xmax` descending then `ymin` ascending, LTR by `ymin` then
`xmin` — with the series and volume titles for context. The parser validates the
index-aligned JSON, retries once on malformed output, and fails the page (not the run) on
a second failure.

Output layer: kind `translation`, engine `<adapter>:<model>`, id
`tr-<lang>` (one translation layer per target language; re-running overwrites those pages).
Translated blocks keep the source `box`, drop `lines_coords`, set `vertical: false`, and
wrap the text into lines by a width heuristic (`box width / (font_size × 0.55)` characters
per line, `font_size` reduced until ≥ 3 lines fit if needed) so the reader's existing
sizing path renders them legibly.

Entry points mirror OCR: **Translate this page** and **Translate whole volume**, same
queue, same progress, translation source = the displayed layer.

### Testing

- Unit: `gcvToPage` on two recorded fixtures (a vertical bubble page, a horizontal SFX
  page) asserting block count, lines, `vertical`, and quad shape; downscale/rescale
  round-trip; reading-order sort; prompt builder; parser with valid, malformed, and
  index-mismatched replies; each adapter's request shape with a mocked `fetch`.
- Component: settings card hides/shows features by key presence; keys never appear in
  the profiles export.
- Manual: one real page through Vision and through each adapter; compare against the
  primary OCR in the layer picker.

---

## Out of scope (recorded so they are not re-litigated)

- Scroll-mode editing (paged only in this cut).
- Merging concurrent edits to one layer from two devices (newest wins).
- Machine translation quality evaluation beyond "does it read"; the feature is experimental
  and may be removed.
- DeepL and other non-LLM MT.
- OCR through bunko's own OCR pipeline (bunko already owns that for uploads).

---

## Addendum 2026-09-16 — layer file naming follows bunko engine sidecars

**Supersedes** the `<Volume Title>.layer.<layer-id>.mokuro` naming in Sub-project B
and decision 7. mokuro-bunko's multi-engine OCR already writes one sidecar per engine as
`<Volume Title>.<engine>.mokuro` (gzip tolerated) beside the archive — e.g.
`Volume 01.paddle-manga.mokuro` next to `Volume 01.cbz` and `Volume 01.mokuro`, carrying
the volume's `volume_uuid`. The reader adopts exactly that shape, so bunko's engine output
and the reader's layers are one thing.

### Convention

- A layer file is `<Volume Title>.<layer-id>.mokuro` or `.mokuro.gz`, in the volume's
  series folder. `layer-id` matches `[a-z0-9-]{1,32}` and IS the `layer_id`.
- **Disambiguation is by archive presence in the same listing**, one pure function
  (`classifyMokuroSidecar` in `syncable-file.ts`) used by every site:
  1. `<full base>.cbz` listed → the file is that volume's **primary** `.mokuro`;
  2. else the base splits as `<stem>.<id>` with `<stem>.cbz` listed and `<id>` matching the
     regex → **layer** `<id>` of `<stem>`;
  3. else **orphan** — ignored, exactly as an unmatched `.mokuro` is today.
     So `Vol 1.5.mokuro` is the primary of `Vol 1.5.cbz` when that archive exists, and layer
     `5` of `Vol 1.cbz` only when it does not.
- Kind/name inference for a pulled file with no local row: `original` → kind `original`
  (adopted as the local original only when none exists); `tr-<lang>` → `translation`;
  a known engine id (`gcv`, `hayai`, `paddle-manga`, `mokuro-fp16`, `mokuro`) → `ocr`
  with `engine = id`; anything else → `edit`. Name = the id prettified
  (`paddle-manga` → "Paddle Manga"). Attachment is by filename; a differing
  `volume_uuid` inside the file is tolerated.
- Export and manual import use the same name. An imported `<stem>.<id>.mokuro` attaches
  to the local volume whose `volume_uuid` matches the file's, else whose volume title
  matches `<stem>` (series from the folder or the file's `title`).

### Sync rules (unchanged in substance)

Pull after every listing for installed and metadata-only volumes when the listed file's
(size, modified, provider) differs from the row's `cloud` stamp and the row has not been
edited since its last sync; push (writable providers) when the row is newer than its
stamp; both moved → newest wins by cloud mtime vs local `updated_at`. Layers ride every
backup after the `.mokuro`; volume download pulls them; rename moves them; delete removes
them.

### mokuro-bunko requirements (not implemented here — bunko is a separate repo)

- (a) `database.py`'s path→archive mapping and PUT ownership must map
  `<stem>.<id>.mokuro[.gz]` to `<stem>.cbz` for ANY `<id>` matching `[a-z0-9-]{1,32}`
  when `<stem>.<id>.cbz` does not exist — not only registered engines — or reader-uploaded
  layers (`gcv`, `tr-en`, `fix`, `original`) are rejected or orphaned.
- (b) the WebDAV delete cascade (`resources.py`, currently `all_sidecar_suffixes()`) must
  also remove such files.
- (c) the library index, compiler, watcher and corrupt-sidecar scrub must never treat them
  as the primary or mint a phantom volume — verify for unknown ids; the current test
  covers registered engines only.
