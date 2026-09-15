# PR #270 — Progress tracker integration

Branch: `feat/progress-tracker` (PR #270 `feature/progress-tracker` merged with develop @ v1.9.1).
Baseline: merge clean, `npm run check` 0 errors, 2905 tests pass.

Survey: 87 agents, 74 findings raised, 59 confirmed, 15 refuted.

## Decisions (user, 2026-08-30)

1. **Goals sync via a new root `goals.json`** — its own root-config file beside
   `volume-data.json` / `profiles.json`, not a section in an existing file.
2. **`completedAt` stays in `volume-data.json`** as a first-class `VolumeData`
   field. Volume-keyed state split across two files with two merge rules is how
   sync bugs get made. `goals.json` carries goals/targets/custom goals/snapshots/
   per-volume deadlines.
3. **UI: correctness + conventions pass only.** Author's layout and interaction
   design stand. No redesign.
4. **Ignore `feat/reading-history-heatmap`** (49 commits, unmerged). Target
   `develop`.

## The four things that make this "a lot of work"

### A. `--spacing: 5px` escapes into the whole app (CRITICAL, app-wide)

`ProgressTrackerView.svelte:574`, `VolumeCard.svelte:97`, `VolumeProgressBar.svelte:21`
each declare `:root { --spacing: 5px; ... }` inside a component `<style>`. Svelte
does not scope `:root`, and Tailwind v4 compiles **every** numeric spacing utility
to `calc(var(--spacing) * N)`, declaring `--spacing: 0.25rem` inside
`@layer theme`. An unlayered `:root` beats a layered one.

So the moment the tracker's lazy chunk injects its stylesheet, every `p-*`,
`m-*`, `gap-*` and numeric `h-*`/`w-*` in the entire app grows 25% — NavBar icons
24px→30px — and navigating away does not undo it. This is not a tracker bug; it
is a whole-application layout regression triggered by visiting one page.

### B. `completedAt` never survives a single write

`completed-at.ts` read-modify-writes `localStorage['volumes']`, a key owned
exclusively by the `volumes` store's subscriber, which re-serializes through
`VolumeData.toJSON()` — a whitelist with no `completedAt`. `volume-data.ts` is
fully evaluated before `completed-at.ts` (static import, no cycle), so the
stripping write lands _before_ the reading load on every boot.
`loadCompletedAtMapFromVolumes()` therefore returns `{}` every time, and
`persistCompletedAtMapToVolumes` is write-only dead code. Nothing in `src/`
reads the field.

The map is instead rebuilt each session from `lastProgressUpdate`, which
`updateProgress` bumps on **every page turn**. Consequences:

- Re-open a volume finished in 2024, turn one page → after the next reload it
  counts as completed _today_, inflating the current year's total.
- Turning back from the last page, the reader-settings page input,
  `toggleHasCover`, "mark as unread" and "restart series" all write
  `completed: false`; `shouldPreserveCompletedAt` then returns false whenever
  `totalPages > 0`, so the date is erased. Restart-series wipes a whole year of
  completions from the annual goal in one click — while `archivedReads` still
  holds `completed: true` for each archived pass, unread by the goals module.
- Nothing syncs. The field never reaches `volume-data.json`.

### C. Goals data has no sync shape at all

`targets` and `customGoals` are **arrays**; `volumeDeadlines` values are bare ISO
strings. None of the four sections carries a `lastUpdated`, and
`removeGoalTarget` / `removeCustomGoal` / `removeVolumeDeadline` **hard-delete**.
Arrays cannot merge per key, and without tombstones a goal deleted on the phone
resurrects from the laptop on the next sync, forever.

### D. bunko would share one `goals.json` between all users (BLOCKER)

`mokuro-webdav-library/src/mokuro_bunko/webdav/resources.py:127`:

```py
PER_USER_FILES = frozenset({"volume-data.json", "profiles.json"})
```

`virtual_to_physical` (`:211-221`) routes anything else under `/mokuro-reader/`
to `safe_resolve_under(self.library_path, relative)` — the **shared** library.
A root `goals.json` on bunko would therefore be one file shared by every user,
each clobbering the others, and rejected outright for accounts without
library-write permission (`middleware/auth.py:131`) — which, since `goals.json`
is correctly a hard-failure root config and not a best-effort metadata file,
demotes the provider to read-only and breaks progress sync for that user.

**A bunko-side change is required before this can ship.** The survey's design
scout claimed otherwise; it reasoned from the contract doc, not the server code.

## Phases

### Phase 0 — Stop the bleeding

- Delete the three `:root` blocks; move the custom properties onto the component
  root via `style:--box-width={...}` (the pattern `VolumeCard.svelte:81` already
  uses for `--progress`). Never name a custom property `--spacing`.
- `misc.ts`: merge stored settings over defaults, so the five new keys are not
  `undefined` for every existing user.
- Delete the redundant `src/lib/goals.ts` shim next to `src/lib/goals/index.ts`.

### Phase 1 — `completedAt` as a real field

- `VolumeDataJSON` + class field + constructor parse + `toJSON` (omit-when-absent).
- Stamp in `updateProgress` at the false→true edge, `?? nowIso` so scrolling
  across the end does not move it. **Never clear on `completed: false`** —
  `toggleHasCover` and the reader-settings page input pass two args and mean
  nothing by the default.
- Clear only on the genuine un-read paths: `markVolumeAsUnread`,
  `archiveAndResetVolumes`, `updateVolumeStats(completed=false)`.
  Leave `resetVolumeProgress` alone — it lowers `lastProgressUpdate` to epoch,
  so a clear there would lose the merge and resurrect the completion.
- `ArchivedRead` gains `completedAt?`, captured at archive time. `at` is when
  _restart_ was pressed, not when the pass finished — dating a goal period from
  it credits the restart month. Completion events become
  `[completedAt] ∪ archivedReads.filter(r => r.completed && r.completedAt)`.
- One-time backfill: scan `recentPageTurns` backwards for the last turn where
  `isVolumeComplete(page, page_count)`; else `lastProgressUpdate` if not epoch;
  else leave absent. Never guess `now`. Runs from the goals lifecycle with a
  loaded catalog, not at module scope. Does not bump `lastProgressUpdate`.
- Read-side future clamp: a `completedAt` more than `FUTURE_TOLERANCE_MS` ahead
  of now is treated as absent (a fast-clock device would otherwise park a volume
  in a future goal period permanently, since nothing rewrites it).
- Delete `loadCompletedAtMapFromVolumes` / `persistCompletedAtMapToVolumes`;
  derive `completedAtMap` from the store.
- Do **not** add `completedAt` to the `deleteVolume` tombstone — the tombstone is
  "forget the stats", and past periods are already frozen in snapshots. Comment
  it so nobody "fixes" it later.

### Phase 2 — `goals.json`

- Reshape: `targets` keyed `${goalType}:${periodKey}`, `customGoals` keyed `id`,
  `snapshots` keyed `buildGoalSnapshotKey`, `volumeDeadlines` keyed volume uuid.
  Every entry gains `lastUpdated`; targets/customGoals/deadlines gain `deletedOn`
  tombstones + a `*WithTrash` / public split, mirroring `volumesWithTrash`.
- New **pure** module `src/lib/goals/goals-file.ts` — `GOALS_FILE_NAME`, types,
  parse, `detectBogusGoalKeys`, `mergeGoalSection`, purge. Depends only on
  `$lib/metadata/sanitize`. The sync layer must not import the `$lib/goals`
  barrel, which drags Dexie in.
- `syncable-file.ts`: add to `ROOT_CONFIG_FILENAMES`. **Not** to
  `isBestEffortMetadataPath` — this is the user's own state; a silent write
  failure is data loss they never learn about.
- Fix `drive-files-cache.ts:710` `add()`, which drops root paths
  (`parts.length >= 2`), so a first-ever root upload is invisible to
  `cache.get()` and re-uploads every sync. Pre-existing; bites `goals.json` too.
- `unified-sync-service.ts`: `findGoalsFiles` (getAll, not get — Drive mints
  duplicates), `downloadGoalsFile` (ghost tolerance, per-copy bogus detection,
  union across copies), `composeGoalsFile` (omit empty sections),
  `uploadGoalsFile`, `syncGoals`, `purgeGoalTombstones`. Wire into `syncProvider`
  **after** `syncVolumeData`, then `finalizeClosedGoalSnapshots()`.
- Merge: newest-wins on `max(lastUpdated, deletedOn)`, tie → active beats
  deleted. Parse-time `FUTURE_TOLERANCE_MS` clamp, FORFEIT-ON-BOGUS on the raw
  pre-clamp stamps in all three places. Upload comparison against **raw** cloud
  sections, never parsed.
- **Snapshots merge by union, not replace** — `completed` unioned (earlier ISO
  wins a collision), `partialProgress` per-volume `max`, `closedAt` the earlier.
  Plain newest-wins loses: a laptop that last synced in November finalizes
  `year:2026` from 8 completions on Jan 2 and that poorer snapshot wins forever.
- `activeSelection` and the five `miscSettings` keys stay device-local.
- Migrate the three localStorage keys (`goalsData`, `goalSettings`,
  `goalSnapshots`) inside their existing `try` blocks, stamping from `createdAt`
  / `closedAt` / epoch — never `now`, which would make the last device to
  upgrade win everything.
- **bunko**: add `"goals.json"` to `PER_USER_FILES` + tests.

### Phase 3 — Goals-module correctness

- Snapshots finalized at boot against an empty catalog permanently zero
  `partialProgress`; gate finalization on a loaded catalog.
- Live and snapshot branches disagree about partial progress and
  `totalRemainingPages`; unify.
- Catalog loading state must not collapse to "empty" (`$catalogVolumes ?? {}`).
- Volume-state awareness: use `isVolumeInstalled`/`needsDownload`; count
  cloud-only volumes in goals (they are volumes) while not offering their pages.
- Date math: DST-safe day arithmetic, `parseMonthKey` NaN guard, period start /
  reset countdown must advance with the clock rather than freeze at mount.
- Sorting comparators: NaN/undefined handling, overdue tie-break.
- Group completed-by-series on `normalizeSeriesKey`, not `series_uuid`.
- Deadline cleanup for deleted volumes (unbounded, and now syncs forever).
- Extract bucketing/sorting out of `ProgressTrackerView.svelte` into
  `progress-tracker-helpers.ts` so it is testable.

### Phase 4 — Conventions

D2 raw `<select>` → Flowbite `Select`; D3 hex → theme tokens; D4 modal
`outsideclose` + `relative z-10` footer; D6 `PlaceholderThumbnail` fallback;
D7 `promptConfirmation` + `color="red"` on destructive actions; D8 keyed
`{#each}`; D9 back-button icon; D11 undefined `seriesId` href; D12 dead
`--border-style`; README accuracy; a11y names on selects.

### Phase 5 — Tests + verification

`goals-file.test.ts` (merge/clamp/forfeit), `date-utils`/`periods`/`goal-math`/
`progress-targets` boundary tests, `progress-tracker-helpers` sort/group,
`completedAt` round-trip through `toJSON` + merge, restart-series preserves past
completions, hash-router routes, `unified-sync-service` goals describe block,
`syncable-file` root/nested cases. Then `npm run check`, full vitest, lint, and
browser verification of the tracker on a real library.
