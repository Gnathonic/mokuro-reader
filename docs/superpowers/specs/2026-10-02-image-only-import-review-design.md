# Image-only import review: one series at a time (#285)

Status: approved design, 2026-10-02. Builds on `feat/285-folder-name-titles`
(f9e75433): `planImageOnlyNames`, `importNames`, literal-location uuids.

## Goal

Every image-only import (no `.mokuro`) ends in a step-through review where the
owner sees and controls the names of ONE series at a time before anything is
saved — series folders and loose volumes alike. Volumes that carry a `.mokuro`
keep importing silently, named by their `.mokuro`.

Today's problems this fixes:

- Loose archives (`.cbz` dropped alone, or several at once) are only found to
  be image-only inside `processArchiveContents`, so each archive raises its own
  prompt from inside the queue and stalls it (`import-service.ts` ~573).
- A loose volume has no parent folder, so its series is a guess and generated
  numbering starts at 01 even for volume 5.
- One global prompt store: a second concurrent prompt overwrites the first.
- One approval covers the whole drop.

## Owner decisions

- Pre-scan archives and group loose volumes into series BEFORE any prompt.
- Per series step: editable series name with an existing-series picker;
  naming mode per series (Cleaned up / Folder names); start number; per-volume
  rename.
- A series starts importing as soon as it is approved, while the next one is
  reviewed.
- `.mokuro` volumes: silent, as today.
- Naming modes (unchanged from f9e75433): Cleaned up = series name + generated
  number in natural source order, padded to max(2, digits); Folder names = the
  volume's literal folder/archive name. No number is ever parsed out of a name.

## 1. Pre-scan

`runImportFiles`, after pairing and before routing, LISTS every archive
pairing's entry names — zip.js central directory only, the existing `listOnly`
mode of `decompressArchiveRaw` (worker `decompressCbz`), no entry bytes, not
even `.mokuro`. From the names alone it tells:

- the archive holds a `.mokuro` for every volume → unchanged path (silent);
- some or all volumes have no `.mokuro` → one volume candidate per inner
  image-only folder (or the archive itself when its images are at the root).

Archives are listed ONE AT A TIME. Nothing from the listing is kept except
names and flags; the queue still runs today's PASS 1 (list + `.mokuro` bytes)
and single-pass image streaming when it reaches the archive. A listing failure
leaves that archive on today's path, which raises the review dialog (one group)
when the queue reaches it. Archives nested inside archives cannot be listed
without extracting the outer one; they keep that in-queue path too.

### Mobile constraints (must hold)

The import was tuned for Android and iOS (37cc8559 and earlier): one archive's
images in memory at a time, single-pass streaming per archive, a strictly
sequential queue, a worker pool sized from `deviceRamGB`, MIME types in the
picker's `accept` for iOS. Phones import mostly by picking loose `.cbz` files —
the pre-scan path — so:

- The pre-scan adds one central-directory read per archive (a few KB from the
  end of the file) and retains no bytes; peak memory during an import must not
  rise. Measured, not assumed: JS heap + worker memory peaks for a 20-archive
  pick, before vs after, in Chromium (CDP `Performance.getMetrics` /
  `performance.measureUserAgentSpecificMemory`).
- Extraction, the queue's one-at-a-time order and the worker pool are not
  changed.
- The dialog must work at phone width (one column, the volume list scrolls,
  buttons stay reachable above the on-screen keyboard while a name is edited).
- Files are read only after the user picked them, as today; the review adds
  user think-time between the pre-scan and extraction exactly as today's
  in-queue prompt already does. Not verifiable here: whether iOS can expire a
  picked File while the app is backgrounded mid-review — an extraction that
  fails to read its file must surface as a normal per-volume import error, not
  a hang.
- Verification includes a Playwright WebKit run of the import path (API
  compatibility only — not iOS memory) and an owner check on a real Android and
  iOS device before merge.

## 2. Candidates and grouping

A candidate is one image-only volume: `{ pairing, source label, literal
location }`. Sources: image-folder pairings (pairing PASS 7) and pre-scanned
archive inner pairings.

Grouping (pure, `image-only-review.ts`):

- Has a parent (`extractFolderTitlesFromPath(...).hasParent`): group by that
  parent's literal name — a series folder, or the archive holding volume
  folders.
- Loose (no parent: a bare archive or a folder holding images directly): group
  by `extractSeriesName(name)`, so `Killing Bites v01.cbz` … `v10.cbz` dropped
  together form one group.

Groups are ordered by series name; candidates within a group in natural order
of their literal names.

## 3. Review session and dialog

A review SESSION store replaces `imageOnlyImportModalStore`. `importFiles`
calls append groups; the dialog steps through pending groups. Concurrent drops
append to the same session instead of overwriting.

Per group, the dialog shows "Series k of n" and:

- **Series name** — text field, prefilled with the group's series. Autocomplete
  from existing library series (distinct `series_title` with volume counts —
  `db.volumes.orderBy('series_title').uniqueKeys()` + counts, keys only).
  Choosing an existing series sets the start number after its volumes.
- **Naming mode** — Cleaned up / Folder names for THIS series; initial value =
  the last mode used (`miscSettings.keepFolderNamesAsTitles`), saved on Import.
- **Start number** — Cleaned up only; prefilled with existing volumes of that
  series (excluding this group's own uuids) + 1; recomputed when the series
  name changes unless the user edited it.
- **Volume list** — each row: editable name (prefilled from the mode) and its
  source file/folder in grey. A user-edited name sticks across mode/series/start
  changes; others follow them.
- **Buttons** — Import, Skip, Skip all remaining. All buttons in a
  `relative z-10` container (night-mode rule).

Closing the dialog = Skip all remaining.

## 4. Naming and identity

`planImageOnlyNames` becomes per group: `nameGroup(group, { series, mode,
start, overrides }) → Map<candidateId, ImportNames>`. Identity (uuid source)
stays the candidate's literal location and never depends on the series field,
mode, start or a rename. Names are stored via `storedTitleSegment` as today;
the dialog shows the stored (sanitized) form.

## 5. Approval → import

Approving a group stamps `importNames` on its pairings (archive inner pairings
keyed by inner basePath) and enqueues them: image folders as today's queue
items; archives as queue items that carry their per-inner-volume names and an
`approved` flag, so `processArchiveContents` runs its normal PASS 1 but never
prompts. `processQueue` is kicked; the dialog advances immediately.

Mixed archives: their `.mokuro` volumes import regardless of the review; the
image-only part follows its group's decision. A skipped group's archive with no
`.mokuro` volumes is not enqueued at all.

`importFiles` resolves once routing is done and every group has been offered
(it does not wait for the user to finish reviewing); the drop zone's
"preparing" modal closes when the review opens.

Direct (single-pairing) routing applies only to `.mokuro` pairings; approved
image-only volumes always go through the queue so approval order is the import
order.

## 6. Unchanged

Cloud downloads (`download-queue.ts`), deep links (they reach
`processArchiveContents`, which now raises the review with one group),
`.mokuro` naming, `processVolume`'s use of `importNames`.

## 7. Testing

- Unit: grouping (parent / loose / mixed), `nameGroup` (modes, start, overrides,
  sanitizing, identity stability), start-number defaults from existing counts.
- Import service (fake-indexeddb, zip fixtures): loose cbz batch → ONE group,
  no in-queue prompt; series archive of folders → one group; mixed archive;
  approving group 1 enqueues and imports while group 2 is pending; skip;
  skip-all; concurrent `importFiles` append; nested archive fallback.
- Component: dialog stepping, mode switch, rename sticks, existing-series pick
  sets start, buttons.
- Browser (Playwright, own port): drop the owner's two layouts plus a handful of
  loose `.cbz` files; check saved titles and that series 1 imports while series
  2 is on screen.
