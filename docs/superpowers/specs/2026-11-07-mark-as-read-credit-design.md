# Mark as read: counting pages not read in the app (#224)

Status: design, not built. Mockup: `2026-11-07-mark-as-read-credit-mockup.html` (same folder).
Paths are under `src/lib/` unless shown otherwise. Verified against `origin/develop` @ `b905a92a`.

## Problem

"Mark as read" sets the record as finished. Since #160 it adds no time and no characters for
pages this app never saw read. Users want both outcomes:

- #224: a volume ended in ~40 pages of unrelated material. The reporter wanted it finished without
  those pages in the stats. They can have that today.
- Paper, another app, or reading done before installing: they want the reading counted.

Owner direction: ask when marking as read, with estimates from the user's own metrics.

## What the code does today (load-bearing facts)

- One mark surface: `components/VolumeItem.svelte` `onToggleStatusClicked` (list-row button and the
  grid card's menu). It calls `markVolumeAsComplete(uuid, page_count, totalChars)` in
  `settings/volume-data.ts`. That sets progress, the record's `chars`, `completed` and `completedAt`,
  and records one `position` event. It records no `page` or `adjust` event, so the stats get nothing.
- There is no bulk or series-wide mark. `views/SeriesView.svelte` has a `#series-menu` dropdown
  (Delete from cloud, Extract, View text) that can host one.
- `adjust` (the volume editor's event) adds to totals but stays out of `samples`, `paceTail`, and
  `firstReadAt`/`lastReadAt` (`reading-history/stats-engine.ts`, `prepareVolume`/`countVolume`).
  It does not take part in the per-pass page set (`credited`), carries no pages, and cannot be told
  apart from an editor edit.
- The per-volume speed on the reading-speed page is `figures.chars / figures.timeMs`
  (`util/reading-speed-history.ts`). It feeds `averageSpeed`, the trend and the badges. Anything
  that is added to a volume's figures moves it.
- The segment codec is strict (`reading-history/segment-codec.ts`). An unknown kind throws, and an
  unknown `format` is refused while the import keeps the old stamp, so an updated app retries. Its
  rule is: "A new event kind or field AFTER a release is a new `format`." For old app versions, the
  owner decided on 2026-10-02 that they are "not a concern" (event-log spec, Decided 3).
- The old decoder reads only cells 4–5 of an `adjust` row. An extra trailing cell would be dropped
  silently, and the stamp kept, so the extra data would be lost for good on that device.
- `settings/tracking-data.ts` holds reading-tracking settings that "belong to the user, not to a
  device or a profile" (`idle`, `pauses.ask`). They sync in `volume-data.json → tracking`, and the
  newest `lastUpdated` wins. The "Still reading?" toggle is in
  `components/Settings/Reader/ReadingTimerSetting.svelte`.
- Goals count volumes only, by `completedAt` (`goals/types.ts`: `targetVolumes`). They never read
  time or characters.
- `util/snackbar.ts` `showSnackbar(message, duration)` has no action button.
- No UI renders the device table (`deviceStats` has no Svelte consumer), but `deviceStatsFrom`
  keeps the sum of its rows equal to the total.

Two bugs on the #224 path. Both were found by reading the code, and each needs a failing test
before it is fixed:

1. **The editor deducts reading that never happened.** `updateVolumeStats` (`util/volume-editor.ts`)
   records `chars_delta = updates.chars − record.chars` on a progress edit. A mark sets `record.chars`
   to the volume's full count. So after a mark, lowering the page in the editor records a negative
   `adjust` for the pages that were never read, which lowers the characters really read.
2. **The volume item loses its checkmark.** `VolumeItem` derives `isComplete` from progress only
   (`isVolumeComplete`). Lowering the page in the editor clears its check, while the stored flag
   (which the editor never touches) and the catalog (`isVolumeFinished`) still say finished. The
   doc comment on `isVolumeFinished` says every surface must ask it.

## Recommended design

### 1. Flow, single volume

1. The user taps "Mark as read".
2. The app works out the pages **not read here**. These are the volume's pages that no counting view
   read, and that no live credit holds, in the current pass (see 5.3).
3. If those pages hold no characters (all read, or art only, or an image-only volume), the volume is
   marked at once, as today. There is no sheet.
4. Otherwise the user's setting decides what happens (section 7):
   - **Ask** (the default) opens the sheet.
   - **Count** credits the estimate with no sheet.
   - **Don't count** marks only, as today.
5. A snackbar confirms, with **Undo** for 8 s (section 6).

The mark itself is never changed. Progress, `completed`, `completedAt` and the `position` event are
exactly what `markVolumeAsComplete` writes today. A credit is written beside it.

### 2. The sheet (single)

It is a modal on wide screens and a bottom sheet under 640 px. There are two buttons, and each one
finishes the action. Cancel is the ×, Escape or the backdrop. Nothing needs a modifier key or an
arrow key. Tap targets are at least 44 px. The button row has `relative z-10` (night-mode rule).

```
Mark "Vol. 3" as read                                   [×]
42 of its 180 pages weren't read in this app.
Count them in your stats?
┌──────────────────────────────────────────────────────────┐
│ 42 pages · 9,412 characters · about 38 min                │
│ At your speed in this series, 248 chars/min.   Adjust ▾   │
└──────────────────────────────────────────────────────────┘
Either way it's marked read and counts for your goals.
[ ] Don't ask again
                         [ Don't count ]   [ Count them ]
```

- **Adjust ▾** opens two fields:
  - `Time [0] h [38] min`
  - `Count up to page [180]`, which limits the credit to pages not read here up to that page.
  The characters line updates live from the pages. Characters are an exact OCR count, not an
  estimate, so the user never types them. Time re-estimates when the page bound moves, unless the
  user has typed a time. Once they have, a "Use estimate" link appears.
- **Don't ask again.** When ticked, the button pressed becomes the setting (Count or Don't count).
  A helper line appears: "Change this in Settings → Reader → Reading timer."
- Initial focus is on **Don't count**, which is today's behaviour.
- The sheet appears only from the mark action. It never appears from reader completion, from sync,
  or from position adoption.

### 3. The estimate

- **Pages.** These are the pages not read here (5.3). For a volume with an unexplained pre-history
  baseline (`figures.baseline.chars > 0`) and no restart, pages 1..progress (before the mark) also
  count as read. Its old reading is a lump with no pages.
- **Characters per page.** Taken from the row's `page_char_counts` (cumulative, so the difference
  between neighbours). Failing that, from the OCR with the reader's own per-page count. Failing that
  (a placeholder or a materialized row), `character_count` spread evenly over the pages, with the sum
  kept exact.
- **Speed.**
  1. The series' own speed (`seriesReadingSpeed`, which needs 60 min of the series' recent counted
     reading). Label: "At your speed in this series".
  2. Otherwise `personalizedReadingSpeed`, if its confidence is not `none` (30 min or more). Label:
     "At your recent speed". At confidence `low` (under 4 h) the label adds "rough estimate".
  3. Otherwise there is no estimate.
- **Time** is `ceil(chars / cpm)` minutes.
- **Low data.** With no estimate, the sheet never shows the 100 chars/min default as if it were the
  user's speed. The box reads:
  "42 pages · 9,412 characters. Not enough reading here yet to estimate your time."
  The Time field is visible and empty, marked "optional". "Count them" with an empty time credits
  characters only (`time_ms: 0`). The setting "Count" in low data does the same, and the snackbar
  says "no time added".

### 4. Bulk: series and "up to here"

This is a new feature, because no bulk mark exists. There are two entry points, and both open one
sheet:

- Series page `#series-menu` → **Mark volumes as read…**. Every unfinished volume is pre-checked.
- Grid card menu → **Mark as read up to here**. The unfinished volumes up to and including this one
  are pre-checked.

```
Mark volumes as read                                    [×]
[✓] Vol. 1   182 pages not read here
[✓] Vol. 2   176 pages not read here
[✓] Vol. 3    42 of 180 pages not read here
[✓] Vol. 4   188 pages not read here
[✓] Vol. 5   180 pages not read here
──────────────────────────────────────────────────────────
5 volumes · 768 pages · 176,912 characters · about 11 h 55 min
At your speed in this series, 248 chars/min.   Adjust ▾ (total time)
Either way they're marked read and count for your goals.
                         [ Don't count ]   [ Count them ]
```

- Tapping a row toggles it. There is no Shift-range selection, because Shift is a dictionary key.
- The estimate is the sum of the per-volume estimates.
- Adjust sets one total time, which is split across volumes in proportion to their characters.
- The bulk sheet always asks. It is open anyway, so asking costs no extra tap. The setting only
  decides which button gets focus.
- Volumes with nothing to count are marked with no credit. If any volume lacks `page_count`, it is
  skipped and the snackbar says so.
- One credit event per volume, and one snackbar with one Undo for the batch.

### 5. Recording

#### 5.1 Two new history events

```ts
/** "Mark as read" counted pages the app never saw read: read in the current pass. */
export interface CreditPayload {
  kind: 'credit';
  volume: string;
  /** 1-based, ascending, and each one's characters (same count as a page view's). */
  pages: number[];
  page_chars: number[];
  /** The time the user accepted or typed for them; 0 = characters only. */
  time_ms: number;
}

/** Undo, un-read or the editor's "Remove": the target credit counts as never made. */
export interface RetractPayload {
  kind: 'retract';
  volume: string;
  target: [device: string, seq: number];
}
```

`recordEvent` returns the stored event, so whoever records a credit keeps its `[device, seq]` for a
later Undo.

#### 5.2 Codec: format 2, only where needed

- New row layouts:
  - `6 credit [6, dSeq, dT, vol, time_ms, runs[], page_chars[]]`. `runs` holds `[first, last, …]`
    pairs, so consecutive pages collapse into one pair.
  - `7 retract [7, dSeq, dT, vol, target device, target seq]`. The target device goes through the
    `targets` dictionary, as `resolve` does.
- **Writing.** A segment is written as `format: 2` only when it holds a kind 6 or 7 row. Every other
  segment stays at `format: 1`, byte for byte.
- **Reading.** Formats 1 and 2 are accepted. Kinds 6 and 7 inside a format-1 segment, or in a legacy
  segment, are malformed.
- **Old app versions.** An old app refuses a format-2 segment and keeps the old stamp. It picks the
  segment up after it updates. Until then it misses that one device-month (owner: old versions not a
  concern).

#### 5.3 Engine: credit fills the gaps, real reading always wins

This lives in `stats-engine.ts`.

- **`prepareVolume`**:
  - `retracted` = the targets of every live `retract`. Order does not matter, as with `resolve`
    answers, so it works under sync reordering and duplicates.
  - Credits that are not retracted are kept with their `pass` (restarts are counted in the same
    loop).
  - `forget` hides both kinds like everything else.
- **`countVolume`**, in this order:
  1. Views are counted exactly as today: time, `reads`, `readPages`.
  2. Credits are taken in time order (ties by device, then seq). A credit **claims** each of its
     pages that no counting view read in that pass and that no earlier credit claimed. Its chars are
     the claimed pages' chars. Its ms are `time_ms × claimed chars / its declared chars`.
  3. The views loop credits chars and skims as today, except that a page a credit claims is not
     skimmed.
  4. Adjusts are applied as today.
- **Consequences:**
  - **No double counting.** A later in-app read of a credited page takes that page from the credit.
    The view gets the chars, as a normal sample, and the credit shrinks along with its time. Total
    chars stay constant.
  - **Two devices** that credit the same volume before syncing claim each page once.
  - **Views are untouched.** Their time, samples, `paceTail`, pauses, `lastReadAt` and
    `firstReadAt` are identical with or without credits. Speed, pace, the idle cutoff and remaining
    time estimates cannot move.
- **New outputs:**
  - `VolumeTotals.creditMs` and `creditChars`. These are also included in `timeMs` and `readChars`.
  - `VolumeTotals.credits`: the live credits with their `[device, seq]`, pass, and effective ms,
    chars and pages.
  - `VolumeTotals.pass` (the latest pass) and `passRead` (the latest pass's pages read by views or
    claimed by credits). The sheet's "not read here" is pages 1..page_count minus `passRead`.
  - `DeviceTotals.creditMs` and `creditChars`, kept apart as `adjust` is. A credit never sets
    `firstReadAt` or `lastReadAt`. It does add a timeline entry, so the `totalsBefore` sums still
    hold.

#### 5.4 Where it shows

- **`figuresFor`** gains `credit: { timeMs, chars }`. Totals include it. That covers the volume card
  time, the series stats, the lifetime totals (`total-stats.ts`), the reader's Timer, and the
  editor's Time read field.
- **Reading-speed page** (`util/reading-speed-history.ts`, `views/ReadingSpeedView.svelte`):
  - The per-volume speed, `averageSpeed`, the trend, the badges and the "(N tracked)" count use
    **measured** figures (figures minus credit). A fully credited volume is not plotted.
  - Editor `adjust`s stay in, as today.
  - The Characters Read and Total Time tiles gain a sub-line, styled like the existing "skimmed (not
    counted)": "9,412 counted when marked read" and "38 min counted when marked read".
  - The "Collecting Reading Data" countdown uses measured time.
- **Device split** (`deviceStatsFrom`). A `marked-read` row, parallel to `edits`, keeps the rows
  summing to the total. No UI renders this today.
- **Volume editor.** A read-only line: "Counted when marked read: 38 min · 9,412 characters (42
  pages)", with a **Remove** button (section 6).

#### 5.5 Goals and sync

- **Goals.** No change. A mark stamps `completedAt` as today, whatever the answer, and the sheet
  says so. Closed snapshots are untouched.
- **Sync.** Credit and retract events ride the per-device month segments like every event, are
  permanent, and are keyed `[device, seq]`. Nothing new goes into `volume-data.json` apart from the
  setting.

### 6. Undo, un-read, edit later

- **Undo** comes from the snackbar.
  - It calls `restoreVolumePosition` with the pre-mark snapshot (progress, chars, completed and
    completedAt) under a fresh stamp, with announce on. So a volume that was at page 138 goes back to
    page 138, not to page 0.
  - It retracts each credit the action made.
  - While the Undo is on screen, the completion is held through `registerCompletionHold`, as look-up
    visits do. So an undone mark never reaches AniList.
  - Bulk undoes the whole batch.
- **Mark as unread** retracts the live credits of the current pass. The credit was part of the mark,
  and un-reading is the mark's inverse. Real reading time stays, as today. The snackbar reads:
  "Marked Vol. 3 as unread · removed 38 min counted" [Undo]. That Undo restores the record and
  re-records the same credit.
- **Volume editor**:
  - **Remove** retracts the current pass's credits.
  - **Count pages read elsewhere…** opens the same sheet without marking anything. Its title is
    "Count reading done elsewhere", and "up to page" defaults to the current page (the last page if
    finished). The button shows when there are pages not read here, with text, up to that page.
    This replaces the editor's progress-based char estimate (bug 1): a progress edit now moves the
    position only and records no chars `adjust`, and the "Characters Read" line shows the history
    figure (`figuresFor`), not `progress / pageCount × characterCount`.
  - The Time read field is unchanged. It shows the total, credit included, and records the
    difference as an `adjust`.
- **Checkmark.** `VolumeItem` asks `isVolumeFinished(volume, record)` (bug 2). The credit is never
  progress, so fixing stats never touches the check.

### 7. Setting and default

- `tracking.markRead = { unread: 'ask' | 'count' | 'skip', lastUpdated }` in `settings/tracking-data.ts`.
  - It works like `pauses`: parse, merge newest-wins, and the bogus-stamp forfeit.
  - The default when absent is `'ask'`.
  - It is a stats policy, so it belongs to the user like "Still reading?": switching profile must
    not change whether marks count.
- UI: Settings → Reader → Reading timer, beside "Still reading?":
  ```
  When I mark a volume as read, pages not read here:
    (•) Ask each time   ( ) Count them   ( ) Don't count them
  Counted pages add characters and estimated time to your stats. They never change your speed.
  ```
- With everything left on defaults, the sheet appears only when there is something to count, and
  one tap answers it.
- An old app drops the unknown `tracking` key on its next write (`parseTrackingSection` drops
  unknown keys). The setting then reads as Ask until it is chosen again (old versions not a
  concern).

### 8. Files

| File | Change |
| --- | --- |
| `reading-history/types.ts` | `CreditPayload`, `RetractPayload` |
| `reading-history/segment-codec.ts` | kinds 6/7, format 2 only when present, accept 1 and 2 |
| `reading-history/stats-engine.ts` | credits in `prepareVolume`/`countVolume`; new totals fields |
| `reading-history/stats-store.ts` | `figures.credit`; `pagesNotReadHere(stats, volume, pageCount, record)` |
| `reading-history/credit.ts` (new) | per-page chars, `estimateCredit`, `recordCredit`, `retractCredits` |
| `reading-history/device-stats.ts` | `marked-read` row |
| `settings/volume-data.ts` | `markVolumesRead` (snapshots, credits, undo handle); unread retracts |
| `settings/tracking-data.ts` | `markRead` entry |
| `util/snackbar.ts` + its component | optional `{ label, onClick }` action |
| `components/MarkReadSheet.svelte` (new) | single, bulk and editor modes |
| `components/VolumeItem.svelte` | open the sheet; `isVolumeFinished`; "Mark as read up to here" |
| `views/SeriesView.svelte` | series-menu item |
| `components/VolumeEditorModal.svelte`, `util/volume-editor.ts` | counted line, Remove, Count…; no chars delta from progress |
| `components/Settings/Reader/ReadingTimerSetting.svelte` | the setting |
| `util/reading-speed-history.ts`, `views/ReadingSpeedView.svelte` | measured-only speed; sub-lines |
| `docs/superpowers/specs/2026-10-02-reading-history-event-log-design.md` | the two kinds and format 2 |

### 9. Tests

- **Engine**:
  - A credit fills only pages no counting view read in its pass, whatever the order.
  - A later view takes a page from the credit: total chars stay the same, and credit chars and ms
    shrink by that page's share.
  - Two overlapping credits claim each page once.
  - A retract works before or after its target arrives, and twice.
  - A restart starts a fresh remainder. A `forget` hides credits.
  - Samples, `paceTail`, pauses, `lastReadAt` and `firstReadAt` are deep-equal with and without
    credits.
  - A claimed page is not skimmed.
- **Codec**:
  - Round trip of kinds 6 and 7.
  - Format 1 is written when a segment holds neither kind, format 2 when it holds one.
  - Kind 6 inside a format-1 segment is rejected.
  - Existing fixtures still decode.
- **Store and estimate**:
  - `figures.credit`.
  - The baseline rule in `pagesNotReadHere`.
  - The series speed beats the recent one. Confidence `none` gives no minutes. Minutes round up
    (`ceil`).
- **Volume data**:
  - Count and Don't count leave the same record and the same `completedAt`.
  - Unread retracts only the current pass's credits.
  - Undo restores the pre-mark page and holds the completion.
- **Editor**:
  - A progress edit records no chars `adjust`. Update the existing case in `stat-edit-events.test.ts`
    and add the failing case for bug 1 first.
  - Remove retracts.
- **Tracking**: `markRead` parse, merge and bogus forfeit.
- **Speed page**: a credited volume plots its measured part only, and a fully credited volume is not
  plotted.
- **Component**:
  - The sheet is skipped with nothing to count.
  - Low-data and rough states.
  - "Don't ask again" writes the setting.
  - Escape and the backdrop cancel with no write.
  - The bulk checklist and its split.
  - The snackbar's Undo.
- **Runtime** (the `verify` skill):
  - Import a synthetic volume, read a few pages, mark it read, and choose Count.
  - The stats page shows the sub-lines, and Recent Speed is unchanged.
  - Undo returns to the page.
  - Repeat at 390 px width for the bottom sheet.

## Alternatives considered

- **Quiet first (draft 2).** The mark stays silent and the snackbar offers "Count 42 pages · ~38
  min". It changes nothing by default, but the credit lives in an 8 s toast that phone users miss,
  and choosing Count by default needs a trip to Settings. It goes against the owner's "ask when
  marking". It is mocked beside the recommendation. The rest of this design (events, engine, undo,
  editor) is the same under either flow.
- **Radio choice plus a confirm button (draft 1).** This takes two taps to change the answer, and
  forces a preselection debate. Two finishing buttons take one tap either way.
- **Time and characters linked, both editable (draft 1).** Characters are an exact OCR count, so
  only time is an estimate. Narrowing by page ("up to page") is the honest way to count less.
- **Plain `adjust` with no format change.** It cannot be told apart from editor edits (the speed
  page, Remove, un-read), carries no pages (so a later read double counts), and leaves the editor
  unable to remove credited characters. Rejected.
- **`adjust` with a trailing reason cell (draft 1).** Old decoders drop the cell silently and keep
  the stamp, so the tag is lost for good on every device that imported it before updating. The
  codec rule requires a new format anyway.
- **A per-volume cap from volume totals (draft 2).** The engine has no volume totals. Page-exact
  claiming gives the same bound with no new input, and it is exact.
- **A profile setting (both drafts).** The `tracking` section is the codebase's home for the user's
  stats policy (`pauses.ask`). Kept as owner decision 5.
- **A synthetic `page` event.** It would feed the skip rule, samples, pace and the idle cutoff.
  Rejected.
- **An "Include credited" stats toggle (draft 2).** The tile sub-lines show the split without a new
  setting. Deferred.
- **Grid select mode with a floating bar (draft 1).** A checklist inside the bulk sheet needs no new
  page mode.
- **Back-dating the credit.** No view buckets time by day today, so its date only orders it within
  the pass. Not needed.

Non-goal: back-dating a completion. A backlog marked today counts toward this period's goals, as a
mark does now.

## Decisions for the owner

1. **Flow.**
   - Ask first: a sheet at mark time, with "Don't ask again" (recommended).
   - Quiet first: mark silently and offer Count in the snackbar.
2. **Default of the setting.**
   - Ask (recommended).
   - Don't count (today's behaviour, with no new prompt).
   - Count.
3. **Recording.**
   - New `credit` and `retract` kinds, with segment format 2 written only in segments that hold them
     (recommended).
   - Plain `adjust` with no format change, accepting double counting and no Remove.
4. **Mark as unread.**
   - Retracts the current pass's credit, with Undo (recommended).
   - Keeps it, and offers Remove in the snackbar.
5. **Where the setting lives.**
   - `tracking` in `volume-data.json`, like "Still reading?" (recommended).
   - A profile setting in `profiles.json`.
6. **Volume editor.**
   - Progress edits stop writing a chars `adjust` (fixes bug 1), and "Count pages read elsewhere…"
     replaces the estimate (recommended).
   - Keep today's linear chars delta and fix only its baseline.
7. **Bulk in the first release.**
   - The series menu plus "Mark as read up to here" (recommended).
   - Single volume only.
8. **No speed data yet.**
   - Count characters only, with the time left blank for the user (recommended).
   - Use the 100 chars/min default, labelled as a guess.
