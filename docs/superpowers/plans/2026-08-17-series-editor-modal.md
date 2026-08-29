# Series Editor Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every series-level control (folder rename, AniList link/tag/sidecar refresh, tracking, read count, restart) into one `SeriesEditorModal` (like `VolumeEditorModal`), make the title language a single global Catalog setting, and add a hover + `e` shortcut on catalog cards that opens the editor.

**Architecture:** A `seriesEditorModalStore` in `src/lib/util/modals.ts` (mirroring `volumeEditorModalStore`) drives a globally-mounted `SeriesEditorModal.svelte`. The modal composes the existing pieces — rename logic lifted out of `SeriesView`, the link/tag/sidecar controls lifted out of `SeriesMetadataBar`, and `SeriesTrackingPanel` — and adds a "Next unlinked series →" button. `SeriesMetadataBar` becomes a read-only summary with a pencil that opens the modal. `resolveDisplayTitle` stops honouring the per-series override; the global select moves to `CatalogSettings`.

**Tech Stack:** SvelteKit 5 runes, Flowbite Svelte `Modal`, Dexie liveQuery stores, vitest + @testing-library/svelte (jsdom dialog shims already in `src/test-setup.ts`).

**Spec:** `docs/superpowers/specs/2026-08-16-series-metadata-linking-design.md` (UI section) as amended by the user on 2026-08-17: controls live in a Series editor modal; title language is global-only (Catalog settings); shortcut hover + `e`; "next unlinked series" button in the editor.

## Global Constraints

- Worktree `/home/nathan/Projects/mokuro-reader-worktrees/feat/series-metadata`, branch `feat/series-metadata`. Never commit in the main checkout.
- The folder name (`series_title`) changes ONLY through `executeRenameSeries` (cloud-gated); nothing else derives or writes it.
- Modal action-button containers get `relative z-10`; modals opened from the series page need the capture-phase Escape guard (pattern: `SeriesLinkModal.svelte` / `VolumeEditorModal.svelte`).
- Display titles: `resolveDisplayTitle(seriesTitle, meta, globalPref)` keeps its signature but the per-series `title_preference` is no longer consulted (global-only). Do not remove the field from `SeriesMetadata` (synced data compat); the sanitizer may keep validating it.
- No per-card heavy `$derived`; the "next unlinked" list is computed in the modal only while it is open.
- Tests: `npx vitest run <path>`; `npm run check`; `npx prettier --check src`. Conventional commits, one per task, `git add` only the task's files.

---

### Task 1: `seriesEditorModalStore` + `SeriesEditorModal.svelte` (rename + link + tag + sidecars + tracking + next-unlinked)

**Files:**

- Modify: `src/lib/util/modals.ts` (after the volume editor block)
- Create: `src/lib/components/Series/SeriesEditorModal.svelte`
- Create: `src/lib/components/Series/SeriesLinkControls.svelte` (extracted from `SeriesMetadataBar.svelte`: Link…/Change/Unlink, tag field, "Update cloud sidecars" + stale hint, `SeriesLinkModal` mount)
- Create: `src/lib/components/Series/SeriesRenameField.svelte` (extracted from `SeriesView.svelte`: input + Save/Cancel + inline error; calls `executeRenameSeries`)
- Modify: `src/routes/+layout.svelte` (mount `<SeriesEditorModal />` next to `<VolumeEditorModal />`)
- Test: `src/lib/components/Series/__tests__/SeriesEditorModal.test.ts`, `src/lib/util/modals.test.ts` (extend if it exists, else create)

**Interfaces:**

- Consumes: `executeRenameSeries(oldTitle, newTitle, seriesUuid)` (`$lib/util/series-rename`), `seriesMetadataMap` / `updateSeriesMetadata` / `unlinkSeries` (`$lib/metadata/store`), `getLinkTargets`, `SeriesLinkModal` (props `{open, seriesTitle, onLinked?}`), `unifiedCloudManager.refreshSeriesSidecars`, `providerManager.status`, `SeriesTrackingPanel` (props `{seriesTitle, volumes}`), `catalog` store (`$lib/catalog`) for the series list, `nav.toSeries`, `routeParams`, `resolveDisplayTitle` + `preferredTitleLanguage`.
- Produces:
  ```ts
  // modals.ts
  type SeriesEditorModal = { open: boolean; seriesTitle: string; onClose?: () => void };
  export const seriesEditorModalStore = writable<SeriesEditorModal | undefined>(undefined);
  export function promptSeriesEditor(seriesTitle: string, options?: { onClose?: () => void }): void;
  export function closeSeriesEditor(): void;
  ```
  `SeriesEditorModal.svelte` (no props; reads the store). Sections, top to bottom: header = display title; **Folder name** (`SeriesRenameField`; on success updates the store's `seriesTitle` to `result.finalTitle`, shows the snackbar, and if the current route is that series page navigates with `nav.toSeries(finalTitle, {replaceState:true})`); **AniList** (`SeriesLinkControls`: alt titles + chips read-only, Link…/Change/Unlink, Tag, Update cloud sidecars); **Tracking & re-reads** (`SeriesTrackingPanel`); footer row (`relative z-10`): **Next unlinked series →** (visible only when at least one OTHER series in `$catalog` has no `external_ids.anilist` in `$seriesMetadataMap`; clicking sets the store's `seriesTitle` to the next such series in catalog order after the current one, wrapping) and **Close**.
  `SeriesLinkControls.svelte` props `{ seriesTitle: string; volumes: VolumeMetadata[] }`. `SeriesRenameField.svelte` props `{ seriesTitle: string; seriesUuid: string; onRenamed: (finalTitle: string) => void }`.
- Volumes for the modal: `$catalog.find(s => normalizeSeriesKey(s.title) === normalizeSeriesKey(seriesTitle))?.volumes ?? []` (includes placeholders; downstream components already filter).

- [ ] **Step 1: Failing tests** — `SeriesEditorModal.test.ts` (mock `$lib/util/series-rename`, `$lib/metadata/store` (with a hand-rolled `seriesMetadataMap`), `$lib/catalog` (`catalog` store with 3 series: A linked, B unlinked, C unlinked), `$lib/util/sync`, `$lib/settings/settings`, `$lib/settings/volume-data`, `$lib/metadata/progress-tracker`, `$lib/metadata/reread`, `$lib/metadata/anilist-auth`): opens for B when `promptSeriesEditor('B')`; shows the folder-name field prefilled `B`; **Next unlinked series →** visible and moves the store to `C` then wraps to `B`; hidden when every other series is linked; Close calls `closeSeriesEditor`. `modals.test.ts`: `promptSeriesEditor`/`closeSeriesEditor` set/clear the store.
- [ ] **Step 2: Run** — expect module-not-found failures.
- [ ] **Step 3: Implement** — extract `SeriesRenameField` from `SeriesView` (`startRename/saveRename/cancelRename` + `renameError`/`renameSaving` + partial-failure message verbatim), extract `SeriesLinkControls` from `SeriesMetadataBar` (keep the stale hint + skipped-count snackbar + READ_ONLY handling verbatim), build the modal with Flowbite `Modal` (`outsideclose`, capture-phase Escape guard, `bind:open` synced to the store; when the store becomes undefined the modal closes), mount it in `+layout.svelte`.
- [ ] **Step 4: Run tests + `npm run check` + `npx prettier --check src`.**
- [ ] **Step 5: Commit** — `feat(series): series editor modal with rename, AniList, tracking and next-unlinked`.

### Task 2: Series page → read-only summary + pencil opens the editor

**Files:**

- Modify: `src/lib/views/SeriesView.svelte` (remove `isRenaming/renameValue/renameError/renameSaving/renameInputEl`, `startRename/cancelRename/saveRename/handleRenameKeydown`, the rename `{#if isRenaming}` block; pencil `onclick={() => promptSeriesEditor(seriesTitle)}` with `title="Edit series"` — on BOTH header variants incl. the placeholder-only page)
- Modify: `src/lib/components/Series/SeriesMetadataBar.svelte` (read-only: alt titles subtitle, link-out chips, `Read N times` (`timesRead` from `computeLocalPassState` on non-placeholder volumes), a one-line tracking status: `Tracking on · last pushed vol. N · <date>` / `Tracking off` / nothing when unlinked; REMOVE tag input, Link/Change/Unlink, title-language select, sidecar button, and the `SeriesTrackingPanel` mount)
- Modify: `src/lib/components/Series/SeriesTrackingPanel.svelte` (no longer mounted from the bar — only from the modal; unchanged otherwise)
- Test: update `src/lib/components/Series/__tests__/SeriesMetadataBar.test.ts` (summary assertions; no controls), `src/lib/views/__tests__/SeriesView*.test.ts` if any reference rename

**Interfaces:** consumes `promptSeriesEditor` (Task 1). Produces nothing new.

- [ ] Steps: failing bar tests (asserts no `Tag` input, no `Sync now`, shows `Read 1 time` + status line) → run → implement → run + check + prettier → commit `refactor(series): series page shows a read-only summary; pencil opens the series editor`.

### Task 3: Title language global-only in Catalog settings

**Files:**

- Modify: `src/lib/metadata/display-title.ts` (`resolveDisplayBase`/`resolveDisplayTitle` ignore `meta.title_preference`; JSDoc updated; **tag rendering changes to parentheses**: `resolveDisplayTitle` appends `` ` (${tag})` `` — strip one pair of surrounding `()`/`[]` from the raw tag before wrapping so `[color]`, `(color)` and `color` all render as `Title (color)`; the STORED/embedded tag stays raw), `src/lib/metadata/display-title.test.ts` (per-series override tests → assert the override is ignored; tag tests → `Title (color)` for all three inputs; blank tag → no suffix)
- Modify: tag input placeholder/hint in `SeriesLinkControls.svelte` (`placeholder="color"`, helper "Shown as (tag) after the title") and any test asserting the old `[color]` display (`SeriesMetadataBar.test.ts`, catalog tests, verify scripts)
- Modify: spec `docs/superpowers/specs/2026-08-16-series-metadata-linking-design.md` display-title clause: `+ ' (' + tag + ')'`
- Modify: `src/lib/components/Settings/CatalogSettings.svelte` (add the "Preferred series title language" `Select` — same options/`updateCatalogSetting('preferredTitleLanguage', …)` as today)
- Modify: `src/lib/components/Settings/MetadataSettings.svelte` (remove the language select; accordion title → `AniList`; keep `AniListAccountSettings`)
- Modify: `src/lib/components/Settings/Settings.svelte` only if the accordion order/labels need it
- Modify: docs — `README.md` line about title language (still true), `CHANGELOG.md` `[Unreleased]/Added`: adjust "Preferred series title language (native/romaji/english), per-series override" → drop "per-series override"; add `- Series editor modal (pencil or hover + E) with rename, AniList, tracking`
- Test: `src/lib/components/Settings/__tests__/…` if MetadataSettings/CatalogSettings have tests — update; `catalog-store.test.ts` unaffected.

- [ ] Steps: failing display-title tests → run → implement → run + check + prettier → commit `feat(settings): title language is a global Catalog setting; per-series override removed`.

### Task 4: Catalog hover + `e` shortcut

**Files:**

- Modify: `src/lib/components/CatalogItem.svelte` (in the existing hovered `keydown` handling: if `e.key === 'e'` and not typing in an input → `e.preventDefault(); promptSeriesEditor(series.title)`; works for placeholder series too)
- Modify: `src/lib/components/CatalogListItem.svelte` (add `isHovered` + the same handler on the row)
- Test: `src/lib/components/__tests__/CatalogItem.shortcut.test.ts` (render, `mouseenter`, `keydown e` → `promptSeriesEditor` called with the raw title; not called when an `<input>` is focused; not called when not hovered) — mock `$lib/util/modals`; if rendering `CatalogItem` in jsdom is impractical, extract the key handling into a tiny pure helper `src/lib/util/series-editor-shortcut.ts` (`shouldOpenSeriesEditor(e: KeyboardEvent, hovered: boolean): boolean`) and unit-test that.

- [ ] Steps: failing test → run → implement → run + check + prettier → commit `feat(catalog): hover + E opens the series editor`.

### Task 6: Manual alt titles in the series editor (run before Task 5)

**Files:**

- Create: `src/lib/components/Series/SeriesTitlesEditor.svelte`
- Modify: `src/lib/components/Series/SeriesEditorModal.svelte` (mount it in the AniList/titles section, below the link controls; section title "Titles & AniList")
- Test: `src/lib/components/Series/__tests__/SeriesTitlesEditor.test.ts`

**Interfaces:**

- Consumes: `seriesMetadataMap`, `updateSeriesMetadata(seriesTitle, patch)` (`$lib/metadata/store`), `normalizeSeriesKey`.
- Produces: `SeriesTitlesEditor.svelte` props `{ seriesTitle: string }`. Renders three text inputs (Native / Romaji / English) prefilled from `meta.titles`, and a Synonyms input (comma- or newline-separated) prefilled from `meta.synonyms`. Save on blur / Enter: `updateSeriesMetadata(seriesTitle, { titles: { native?, romaji?, english? } (blank → key omitted), synonyms: string[] (trimmed, de-duplicated, blanks dropped) })`. Works for linked AND unlinked series; a helper line under the fields: "Linking to AniList replaces these." Uses the same draft/dirty pattern as the tag field so a liveQuery emission doesn't clobber mid-edit.
- Why: self-published/Kindle-only titles are in no database; manual titles feed the display overlay, catalog search and the `.mokuro` embed with zero extra plumbing.

- [ ] Steps: failing tests (prefill from meta; blur saves the patch with blank keys omitted; synonyms parsed/deduped; typing then an external meta emission does not clobber the draft) → run → implement → mount in the modal → run + `npm run check` + prettier → commit `feat(series): manual alt titles and synonyms in the series editor`.

### Task 7: Persist spine offsets per series (synced) and make the catalog card read/write them

**Files:**

- Modify: `src/lib/metadata/types.ts` (`SeriesMetadata.spine_offset?: number` — series horizontal-step adjust in percent, replaces the card's in-memory `hOffsetAdjust`; `SeriesMetadata.volume_offsets?: Record<string, number>` — per-volume horizontal nudge in px keyed by `volume_uuid`), `src/lib/metadata/sanitize.ts` + `merge.ts` (cloud boundary: finite numbers, clamp `spine_offset` to [-50, 50], `volume_offsets` values to [-500, 500], drop non-string keys)
- Create: `src/lib/metadata/spine-offsets.ts` (+ test): `getSpineOffsets(meta) → { spineOffset: number; volumeOffsets: Record<string, number> }`; `scheduleSpineOffsetWrite(seriesTitle, patch: { spineOffset?: number; volumeOffsets?: Record<string, number> })` — coalesces wheel ticks per series (300 ms trailing debounce) into ONE `updateSeriesMetadata` functional patch (`(existing) => ({ spine_offset, volume_offsets: {...existing.volume_offsets, ...} })`; a value of `0` deletes the volume key; a full reset passes `volume_offsets: {}`); `flushSpineOffsetWrites()` for tests/unmount
- Modify: `src/lib/components/CatalogItem.svelte`: replace the in-memory `hOffsetAdjust`/index-keyed `volumeOffsets` with values derived from `$seriesMetadataMap.get(seriesKey)` via `getSpineOffsets` (convert the uuid map to the index map the canvas expects for the current `stackedVolumes` order — one small `$derived`), and write back through `scheduleSpineOffsetWrite` on shift+wheel / alt+shift+wheel / the two right-click resets. Keep a local optimistic copy so the wheel feels instant while the debounced write lands (mirror the pattern already used for drafts: local `$state` seeded from the store, resynced when the store emits and no write is pending).
- Tests: `spine-offsets.test.ts` (debounce coalescing, zero deletes key, reset clears map, functional patch preserves other fields); `merge.test.ts` (sanitiser); `CatalogItem` test (shift+wheel → scheduled write with new spineOffset; alt+shift+wheel over volume index 1 → volume_offsets keyed by that volume's uuid).

**Interfaces (Produces):** the two `SeriesMetadata` fields above; `getSpineOffsets`, `scheduleSpineOffsetWrite`, `flushSpineOffsetWrites`; the index-map conversion `volumeOffsetsByIndex(volumes: VolumeMetadata[], byUuid: Record<string, number>): Map<number, number>` (pure, exported from `spine-offsets.ts`).

- [ ] Steps: failing tests → implement → full suite + `npm run check` + prettier → commit `feat(catalog): persist per-series spine offsets (series % and per-volume px) in synced metadata`.

### Task 8: `SeriesSpineShowcase` in the series editor

**Files:**

- Create: `src/lib/util/spine-stack-layout.ts` (+ test): extract from `CatalogItem.svelte` the PURE geometry it needs shared — `computeStackLayout({ count, baseWidth, horizontalStepPx, volumeOffsetsByIndex }) → { lefts: number[]; totalWidth: number }` and `hitTestStack(layout, x, baseWidth) → index | null` (front-to-back as today). Behaviour-preserving: `CatalogItem` switches its `handleMouseMove` hit test to `hitTestStack` with identical results (existing behaviour unchanged).
- Create: `src/lib/components/Series/SeriesSpineShowcase.svelte` (+ test): props `{ seriesTitle: string; volumes: VolumeMetadata[] }`. Renders ALL volumes (local + cloud placeholders, sorted with `sortVolumes`; placeholders enriched with `fetchCloudThumbnail` like the card, capped at 60 to bound memory) through `CompositeCanvas` in spine mode (vertical step 0, uniform height, `stackCount` ignored — all volumes), inside a horizontally scrollable strip — **side-to-side scrolling is a hard requirement** (long series will not fit the modal): `overflow-x-auto` with an always-visible horizontal scrollbar, fixed height, plain vertical wheel over the strip pans it horizontally (`scrollLeft += deltaY`, `preventDefault` only when the strip actually overflows) so mouse users can pan, plus click-drag (pointer capture) to pan; keyboard ←/→ pans when the strip is focused. Controls above the strip: series offset `Range` slider (−25 … 25 %, step 0.25) + numeric readout + "Reset"; "Reset all volume offsets" button; hint text "Shift+scroll: series offset · Alt+Shift+scroll over a volume: nudge that volume · Alt+Shift+right-click: reset it". Wheel handling on the strip (non-passive): shift+wheel → series offset ±0.25 % (`preventDefault`); alt+shift+wheel over a hovered volume → that volume ±1 px; plain wheel → pans the strip (see above). Alt+shift+right-click over a volume → reset that volume; shift+right-click → reset series offset. Hovered volume gets `highlightIndex` + a small caption "Vol N · +4 px". All writes via `scheduleSpineOffsetWrite`; local optimistic state as in Task 7.
- Modify: `src/lib/components/Series/SeriesEditorModal.svelte` (mount the showcase as its own section "Shelf" between "Titles & AniList" and "Tracking"; inside `{#key seriesTitle}`), `SeriesEditorModal.test.ts` (mock the showcase's heavy deps or assert it mounts).
- Tests: `spine-stack-layout.test.ts` (lefts/totalWidth with and without offsets; hit test edges; identical to the card's previous inline math for a fixture); `SeriesSpineShowcase.test.ts` (mock `CompositeCanvas`, `cloud-thumbnails`, `spine-offsets`; assert: slider change → `scheduleSpineOffsetWrite({spineOffset})`; shift+wheel → ±0.25; alt+shift+wheel over index 1 (stub hit test) → volume write; resets; plain wheel not prevented).

- [ ] Steps: failing tests → implement → full suite + `npm run check` + prettier → commit `feat(series): scrollable spine showcase with series/volume offset controls in the editor`.

### Task 9: Verification for Tasks 7–8

- [ ] Playwright (dedicated port, not 5173): import a 3-volume series; catalog card shift+scroll → reload → the offset persists (card and IndexedDB `series_metadata.spine_offset`); open the editor → "Shelf" shows 3 spines; slider to +5 → card updates live; alt+shift+wheel over volume 2 → `volume_offsets[uuid]` written; "Reset all volume offsets" clears; Escape/close keeps values; record observed values + screenshots under `scratchpad/verify-e/`. Suite/check/prettier tails.
- [ ] Commit any doc line: CHANGELOG `- Series editor: spine shelf with persistent series/volume offsets` (terse), `docs: spine showcase`.

### Task 12: Shelf rendering — no drop shadow, larger, zoom control (user amendment 2026-08-17)

**Files:**

- Modify: `src/lib/components/Series/SeriesSpineShowcase.svelte` (+ test)

**Requirements:**

- The showcase renders WITHOUT the drop shadow (`dropShadow={false}` to `CompositeCanvas`, regardless of the catalog setting).
- Default render scale = 1× card scale (spine width = the card's `BASE_WIDTH` = 250 px at zoom 1; today it is 0.556×), so nudges are easy to see; the strip height follows the zoom.
- A zoom control in the shelf controls row: `−` / `+` buttons (steps ×0.8 / ×1.25, clamped 0.5×–3×) + a readout (`100%`) + double-click/`Reset` to 1×; `Ctrl+wheel` over the strip zooms too (preventDefault). Zoom is component-local state (starts at 1× on every mount; NOT persisted — user decision).
- Offsets stay in card px (unchanged storage); only rendering scales — a +1 px nudge remains +1 px on the card. Caption/readout show stored values.
- Tests: no shadow prop passed; default scale 1 → spine width 250; `+` → 312.5 (1.25×), clamps at 3× / 0.5×; ctrl+wheel zooms and is prevented; offsets written unchanged by zoom.

- [ ] Steps: failing tests → implement → suite/check/prettier → commit `feat(series): shelf renders larger without shadow; zoom control`.

### Task 13: Shelf ↔ catalog card geometry parity (user amendment 2026-08-17)

**Problem:** the shelf reuses `CompositeCanvas` and the horizontal-step formula, but not the card's full geometry. In the catalog's spine mode (`stackCount === 0`) the card draws every spine at a **uniform height = average of the stack's contain-fitted thumbnail heights** (`getRenderedDimensions` with `min(BASE_WIDTH/w, BASE_HEIGHT/h, 1)`, averaged over `stackedVolumes`), width = `min(uniformHeight × aspect, BASE_WIDTH)`, over the card's volume subset (`hideReadVolumes ? unread : local`; cloud placeholders capped at 25); the shelf used a fixed 360 px height over all volumes → a step that shows no gap on the card shows a gap in the editor and vice-versa.

**Files:**

- Create: `src/lib/util/spine-stack-geometry.ts` (+ test) — pure: `getRenderedDimensions(naturalW, naturalH, baseW, baseH)`, `computeUniformHeight(volumeDims[], baseW, baseH)` (average of contain-fitted heights, `null` when not in uniform mode), `getSpineCanvasDimensions(dims, uniformHeight, baseW, baseH)`, `computeStepSizes({ stackCountSetting, horizontalStepPct, verticalStepPct, hOffsetAdjust, centerHorizontal, actualCount, innerWidth, baseW, baseH, uniformHeight })` (the card's `stepSizes` rule incl. `leftOffset`/spread), and `selectCardStackVolumes({ localVolumes, unreadVolumes, placeholders, hideRead, stackCount, compactCloud, maxCloudStack })` (the card's `stackedVolumes` rule).
- Modify: `src/lib/components/CatalogItem.svelte` — replace its inline `getRenderedDimensions`, `uniformHeight`, `getCanvasDimensions`, `stepSizes` and `stackedVolumes` bodies with calls to the shared module (behaviour-preserving; existing card tests green; add an oracle test comparing the module against the pre-refactor inline math for fixtures incl. mixed aspect ratios).
- Modify: `src/lib/components/Series/SeriesSpineShowcase.svelte` — compute the shelf EXACTLY as the card would in spine mode: same `uniformHeight`, same per-volume canvas dims, same step sizes (`hOffsetAdjust` = the persisted spine offset), all multiplied by `zoom` for rendering. **As shipped (user amendment during the task):** the shelf always draws EVERY volume (natural sort, capped at 60 for memory) — no "Show all volumes" toggle — while the uniform height is still measured over the card's own stack (`selectCardStackVolumes` with `stackCount = 0` semantics: `hideRead ? unread : local`, cloud cap 25), so the volumes the two have in common are drawn at identical sizes. Zoom is a two-state **1× / 2×** button group (no stepping, no clamps, no readout, no ctrl+wheel zoom — ctrl+wheel is left to the browser). Keep the strip's scrolling; keep the per-thumbnail border while dropping the shadow (new `border` prop on `CompositeCanvas`).
- **Zoom 100 % must equal the card's real on-screen pixel size**: the card never upscales (`scale = min(BASE_WIDTH/w, BASE_HEIGHT/h, 1)`) and uses the average fitted height as the uniform height, so small spine thumbnails render at natural size on the card; the shelf must do the same (user report: at 100 % the shelf renders bigger than the card).
- Tests: `spine-stack-geometry.test.ts` (fixtures: narrow spines, wide covers, mixed, thumbnails smaller than the box (no upscaling) → uniform height, widths, steps; oracle equality); showcase test: at zoom 1 with a fixture, the shelf's `getCanvasDimensions` and `stepSizes.horizontal` equal the card's values for the same volumes/settings (import the shared module for the expected values); all volumes render.

- [ ] Steps: failing tests → implement → full suite + `npm run check` + prettier → commit `fix(series): shelf uses the catalog card's exact spine geometry (uniform height, aspect widths, subset)`.

### Task 5: End-to-end verification + docs touch-up

- [ ] `npx vitest run && npm run check && npx prettier --check src README.md CHANGELOG.md docs` all green.
- [ ] Playwright (dev server on a dedicated port per `.claude/skills/verify/SKILL.md`; reuse `scratchpad/verify-*` scripts): import 2 synthetic series (`EditA`, `EditB`); catalog hover EditA + `e` → editor opens for EditA; **Next unlinked →** switches to EditB and wraps; rename EditA → `EditA2` via the modal (folder title changes; catalog + series page reflect it); link EditA2 to AniList "one piece" from the modal, set tag `[color]`; series page shows the read-only summary (chips, alt titles, `Read 0 times`) and the pencil reopens the editor; Settings → Catalog has the language select (Metadata accordion no longer has it, is titled "AniList"); tracking toggle + Read N times ± + Restart from the modal work. Record observed values.
- [ ] Commit any doc fixes: `docs: series editor modal + global title language`.
