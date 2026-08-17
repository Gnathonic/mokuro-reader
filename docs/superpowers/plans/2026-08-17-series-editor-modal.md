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

- Modify: `src/lib/metadata/display-title.ts` (`resolveDisplayBase`/`resolveDisplayTitle` ignore `meta.title_preference`; JSDoc updated), `src/lib/metadata/display-title.test.ts` (per-series override tests → assert the override is ignored)
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

### Task 5: End-to-end verification + docs touch-up

- [ ] `npx vitest run && npm run check && npx prettier --check src README.md CHANGELOG.md docs` all green.
- [ ] Playwright (dev server on a dedicated port per `.claude/skills/verify/SKILL.md`; reuse `scratchpad/verify-*` scripts): import 2 synthetic series (`EditA`, `EditB`); catalog hover EditA + `e` → editor opens for EditA; **Next unlinked →** switches to EditB and wraps; rename EditA → `EditA2` via the modal (folder title changes; catalog + series page reflect it); link EditA2 to AniList "one piece" from the modal, set tag `[color]`; series page shows the read-only summary (chips, alt titles, `Read 0 times`) and the pencil reopens the editor; Settings → Catalog has the language select (Metadata accordion no longer has it, is titled "AniList"); tracking toggle + Read N times ± + Restart from the modal work. Record observed values.
- [ ] Commit any doc fixes: `docs: series editor modal + global title language`.
