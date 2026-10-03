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

`runImportFiles`, after pairing and before routing, lists every archive
pairing's entries (the existing PASS 1 of `processArchiveContents`: zip.js
central directory + `.mokuro` bytes only, via `decompressArchiveRaw(...,
{ extensions: ['mokuro'] }, false, true)`), and pairs the listing exactly as
`processArchiveContents` does today. Result per archive:

- has `.mokuro` volumes only → unchanged path (silent).
- image-only volumes (all or some) → one volume candidate per inner image-only
  pairing, carrying the scan so the queue does not list the archive again.

Scans run with bounded concurrency (4). A scan failure leaves that archive on
today's path (it will be scanned, and prompted with the review dialog, when the
queue reaches it). Archives nested inside archives cannot be listed without
extracting the outer one; they keep the in-queue path, which raises the same
review dialog (one group) when reached.

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
items; archives as queue items that carry their scan + per-inner-volume names
and an `approved` flag, so `processArchiveContents` skips PASS 1 and never
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
