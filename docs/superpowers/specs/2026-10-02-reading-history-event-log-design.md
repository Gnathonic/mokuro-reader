# Reading history as a per-device event log

**Date:** 2026-10-02
**Status:** design, not implemented. Branch `docs/reading-history-event-log` (off develop @ 6107b9a1).
**Deferred, separate:** provider write receipts + change feeds — issue #288. This design works with
today's full listings and gets cheaper when #288 lands.
Tags: **[V]** verified in code on develop · **[L]** likely · **[S]** speculative.

## Why

A user report: the same volume, synced correctly (page 58/200, 2h 39m on both devices), shows ~7h 14m
left on desktop and ~6h 20m on mobile. Investigating it turned up problems in both the speed maths and
the storage underneath it.

### Speed calculation

1. **Device-dependent results. [V]** The idle cutoff is `inactivityTimeoutMinutes`, a _profile_ setting
   (`settings.ts:321`), and the active profile is chosen per device (`settings.ts:581-582`, Mobile vs
   Desktop by platform). The same synced turns give different speeds on different devices.
2. **The 4 h window can drop all page-turn data. [V]** `calculateReadingSpeed` adds volumes newest-first
   and `break`s at the first one that would exceed 4 h (`reading-speed.ts:259`). Turns accumulate forever,
   so a long or re-read volume trips it and the estimate silently falls back to completed volumes only.
3. **Two clocks. [V]** `timeReadInMinutes` is a `setInterval` +1/min (`volume-data.ts:757`) that also runs
   while "paused" (#175); turn-derived time is the other; `getEffectiveReadingTime` takes the max
   (`reading-speed.ts:126`).
4. **No per-page skip handling. [V]** Skimmed pages count; the only guard drops a whole volume above
   1000 cpm. Related: #160, #224, #276, #202.
5. **The last page of a sitting has no end time. [V]** A turn records arrival only; the dwell on the page
   you closed on is unknown.

### Storage and sync

6. **History lost on merge. [V]** Volume entries merge whole-entry, newest wins
   (`unified-sync-service.ts:951`, `:1162`). Turns recorded on the losing device between syncs are gone.
7. **Whole file per page pause. [V]** Every page turn resets a 5 s sync timer (`activity-tracker.ts:75`);
   each sync downloads, parses, merges, stringifies and re-uploads the entire `volume-data.json`. On Drive
   each upload also walks the whole account listing (`google-drive-provider.ts:468`) — #288.
8. **localStorage ceiling. [V]** The whole map is rewritten to localStorage on every turn and every timer
   minute (`volume-data.ts:784`), with no try/catch. ~5 MB quota ≈ 900 read volumes.
9. **Size. [L]** Page turns are ~94% of `volume-data.json` (synthetic model, ≈5.4 KB per read volume; the
   largest real file seen is 873 KB). Delta-encoded columns + deflate are ~11× smaller than the JSON.

## Decisions already made (owner, 2026-10-02)

- Keep **raw events** indefinitely. Summarising old data is a later option, not part of this.
- Idle cutoff becomes **adaptive** (from the user's own measured speed), with an optional **manual override
  that syncs with the history**, not with profiles. Applied when stats are computed, never at recording.
- Providers can't append to an existing file (Drive, OneDrive, MEGA: no; WebDAV only through a SabreDAV
  extension). The design must not need append.
- `feat/reading-history-heatmap` is deleted; any heatmap returns as a rewrite on this storage.
- Device-level stats (which devices you read on, how speed compares) are a goal.

## Model

### Identity

- **Device ID**: random UUID created on first run, stored in IndexedDB. Clearing site data makes a new one.
- **Event ID**: `[device, seq]`, where `seq` increments per device. Permanent and globally unique; the merge
  key for everything below. Ordering _within_ a device is by `seq`, never by timestamp.

### Device record

The record splits by **who may write it**. A device's own folder is written only by that device, but a
user must be able to rename or merge any device from any other device.

```ts
// history/<device>/device.json — FACTS, written only by that device
interface DeviceFacts {
  device: string; // UUID
  class: 'phone' | 'tablet' | 'laptop' | 'desktop' | 'unknown'; // auto-detected
  os?: string; // coarse family: 'Android', 'iOS', 'Windows', 'macOS', 'Linux', 'ChromeOS'
  browser?: string; // coarse family: 'Chrome', 'Firefox', 'Safari', 'Edge', …
  first_seen: string; // ISO
  last_seen: string;
}

// volume-data.json → `tracking.devices[device]` — USER CHOICES, any device may edit,
// newest `updated_at` wins per device key (same merge + future-stamp clamp as the `series` section)
interface DeviceLabel {
  name?: string; // "Pixel 8", "Work laptop"
  class?: DeviceFacts['class']; // user correction of the detected class
  merged_into?: string; // alias: this device's events count as that device's
  updated_at: string;
}
```

Class, OS and browser come from coarse signals (pointer type, touch, screen size,
`navigator.userAgentData` where available, a minimal UA family match otherwise). No device model, no full
user agent.

#### Labels

The UUID is never shown. Every device always has a readable label:

- **Generated default**, used until the user names it: `<class> · <OS> · <browser>`, e.g.
  "Phone · Android · Chrome", "Desktop · Windows · Firefox". When two devices generate the same label,
  both get their first-seen month appended ("… (since Mar 2026)").
- **The current device is marked** ("This device") wherever devices are listed, so the user can tell which
  row to rename without reading anything technical.

Where the user labels a device (recommendation; one edit component, three entry points):

1. **Settings → Sync → Devices**: "This device" with an editable name at the top, then every other device
   with rename, class correction and merge. The full management screen.
2. **Inline in the device stats view**: click a device's name to rename it in place, where the label
   actually matters.
3. **One non-blocking prompt**, the first time the history holds events from a second device: a dismissible
   banner on the stats view, "You read on 2 devices — name this one?". Never a first-run modal. A
   single-device user never sees a device anywhere.

### Events

Each event carries `device`, `seq`, `t` (epoch ms, the recording device's clock) and one payload:

| Kind      | Payload                                                                                                                                                                                   | Replaces                                  |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `page`    | `volume`, `first_page`, `last_page`, `page_chars` (per page, first..last), `chars_before`, `dwell_ms` (raw, uncapped; `null` = unknown, legacy only), `layout`, `orientation`, `viewport` | `recentPageTurns`                         |
| `adjust`  | `volume`, `time_delta_ms?`, `chars_delta?`                                                                                                                                                | manual edits in the volume editor         |
| `restart` | `volume`                                                                                                                                                                                  | `archivedReads` marker                    |
| `forget`  | `volume`, `before`, `scope?` (`'time'` = time/speed only, "delete speed data")                                                                                                            | "delete stats" (`deleteVolumeCompletely`) |
| `resolve` | `target` (`[device, seq]` of a `page` event), `count`: `'full'` \| `'typical'` \| `'none'`                                                                                                | — (the user's answer about a long pause)  |

- A `page` event is written when the user **leaves** a view (turn, close, tab hidden, idle), so dwell is
  known, which fixes problem 5.
- **One event per view, not per page.** Whatever is on screen together (one page, a double-page spread,
  several pages of a continuous strip on an ultrawide) is one event. Its pages are the **whole pages in
  the layout**: every page with any part on screen counts in full, never a fraction, and a view is always
  at least one page (a zoomed-in corner of a page counts that whole page). `layout` is `single` |
  `double` | `continuous-v` | `continuous-h`.
- Two figures are **derived at analysis time**, not recorded, because they need every device's events:
  `chars_visible` = `sum(page_chars)`, which drives the idle cutoff; and `chars_new` = the chars of pages
  no earlier view of this read pass showed (on any device), which drives "characters read", so
  overlapping views in continuous mode, or the same pages read on two devices, never credit a page twice.
  Recording `page_chars` per page is what makes both possible.
- Nothing is ever edited or deleted. `forget` and `restart` are applied when stats are computed, so both
  are reversible in principle.
- `completed`, `progress`, `chars` (current position) and per-volume settings stay in `volume-data.json`.
  That file is **state**; the log is **history**.

## Storage

### Local (IndexedDB)

A **separate Dexie database, `mokuro_history`**, not new tables in `mokuro_v3`. History has its own
lifecycle (it outlives every catalog row), the export Worker never needs it, it stays off the
`MOKURO_DB_SCHEMA` ladder, and its small writes never queue behind the catalog's long blob
transactions.

| Table            | Key                                   | Purpose                                                                          |
| ---------------- | ------------------------------------- | -------------------------------------------------------------------------------- |
| `history_meta`   | `key`                                 | this device's ID and next `seq` (phase 1)                                        |
| `reading_events` | `[device+seq]`, indexes `volume`, `t` | every device's events, ours and imported                                         |
| `history_files`  | cloud path                            | per remote file: `size`, `modifiedTime`, provider, imported `last_seq` (phase 2) |
| `devices`        | `device`                              | device facts                                                                     |

- Recording writes one row per event. No more whole-map rewrite to localStorage on every turn. The slimmed
  `volumes` localStorage entry is still written, with a try/catch.
- Estimated size: ~250k events for 1000 read volumes, a few tens of MB. [S] If that's a problem on phones,
  closed months can stay as compressed blobs locally and decode only when a graph needs them.

### Cloud

```
history/<device>/device.json          DeviceFacts (labels live in volume-data.json → tracking.devices)
history/<device>/<YYYY-MM>.events     one month of that device's events
```

- **A device only ever writes files under its own `<device>/` folder.** No two devices write the same file,
  so there are no write conflicts.
- The current month's file is rebuilt from local events and uploaded **whole**. A heavy reader's month is
  ~15 KB encoded. Once a month is over, its file is written one last time and then never changes.
- Writes are batched: on leaving the reader, on `visibilitychange` → hidden, every few minutes while
  reading, and on manual sync. Not per page.
- File format: a small JSON header (`format`, `device`, `month`, `first_seq`, `last_seq`, `count`), then
  the events in delta-encoded columns, deflated with the built-in `CompressionStream`. Versioned via
  `format`. No new dependency.
- `history/` must join the syncable allowlist (`syncable-file.ts:61-67`) so every provider lists it.

### Import (how another device's events reach local records)

1. A listing shows a remote `history/<X>/<month>.events` whose (`size`, `modifiedTime`, provider) differs
   from `history_files`. Same staleness check as `series_index`.
2. Download, decode, validate the header against the path.
3. In **one transaction**, write every event keyed by `[device, seq]`. Writing an event that's already there
   changes nothing: re-imports, retries and duplicate downloads are no-ops. A longer version of the file just
   adds the new events.
4. Update `history_files`. If decoding fails, the transaction never runs and the old stamp stays, so it's
   retried next listing.

Every device therefore holds the union of all devices' events. Graphs and speed read `reading_events`.

**Integrity rules**

- Size or modified time only decides _whether to download_. It never decides what gets written locally.
- A header `last_seq` lower than what was already imported is logged as an anomaly (for example the other
  device rebuilt after losing data). Nothing is deleted.
- The same `[device, seq]` arriving with different content means two installs share an ID (a copied browser
  profile). The importer keeps both, and the local device re-keys itself to a new ID going forward. [S]
- A device never uploads events whose `device` isn't its own.

## Speed and stats

All computed from `reading_events` (after applying `forget`/`restart`/`merged_into`), the same way on every
device.

- **One clock.** Time read = sum of the counted dwell of `page` events plus `adjust` deltas. The
  `setInterval` minute counter is retired; the live timer shows the same derived figure.
- **Adaptive idle cutoff.** Based on the characters in the layout. A view's expected dwell is
  `chars_visible × pace`, where `pace` (seconds per character) is one global robust median over recent
  views. Because `chars_visible` already counts every whole page on screen, double-page spreads and long
  continuous strips scale on their own; there is no per-device or per-layout term. A view's cap =
  `clamp(k × expected, floor, ceiling)`; the floor covers art-only pages. With no data yet: today's 5 min
  default. `k` starts at a fixed default and is **widened by the user** (below).
  - **Manual override**: one value in a new `tracking` section of `volume-data.json`, newest-stamp-wins like
    the `series` section (with the same future-stamp clamp). When set, it replaces the adaptive cap
    everywhere. Profiles no longer hold it.
- **Long pauses: ask at the timeout.** When a view reaches its cap, the timer stops counting and a prompt
  appears **right then**, and stays up until answered. The app can't know whether the user is reading, so
  it asks instead of guessing:
  - **"Still reading"** (the user is there, reading slowly): the whole time so far counts, the timer
    resumes, and the cutoff is **widened** so it doesn't keep happening: `k` grows to fit this view with
    some headroom (bounded by the ceiling) and is saved in the `tracking` section, so it syncs. The prompt
    can say what changed ("Cutoff widened to ~9 min for pages like this").
  - **If they were away**, the same prompt is waiting when they return, showing how long it has been. They
    choose: count it all, count typical time (`expected`), or don't count it.
  - **No answer** (they turn the page without answering, the tab is hidden, or the app closes): the pause
    goes to a "long pauses to review" list on the stats page and counts as **typical** time, shown as
    provisional, until answered.
  - **Every answer is a `resolve` event**, so it syncs, every device applies it, and it can be changed later
    from the review list. ("Still reading" is a `resolve` with `count: 'full'` plus the `k` change.)
  - **Don't ask again:** offered only after the user has answered a few prompts (e.g. 3), not on the first
    ones. It stores a standing default (`'full'` | `'typical'` | `'none'`) in the `tracking` section; prompts
    stop and new pauses resolve to that default. Changeable in settings.
  - Legacy data converted from `recentPageTurns` is never prompted for; it counts as typical.
- **Skips.** A view read faster than an implausible rate (e.g. 1500 cpm) is a skip: its time and chars are
  excluded from speed, and its `chars_new` count as **skipped, not read**. "Characters read" totals exclude
  skips; the stats show a separate skipped figure (#160, #224). Existing totals drop slightly once history is
  computed this way; the release note should say so.
- **Recent speed** = the last N active hours across all volumes and devices, by time. No volume-granular
  window, so no cliff.
- **Time left** uses the series' own speed once it has enough data, else the recent speed.
- **Devices and layouts.** Per-device, per-class and per-layout totals, speed and share of reading time,
  shown as a section of the existing reading-speed page. Comparisons should prefer like-for-like material
  (the same series, or volumes read on several devices) and always show the sample size behind them.

## Migration and compatibility

- **Old data** (converted in **phase 2**, at the cut-over where page turns stop being written, never
  earlier: during phase 1 every device both writes turns and records native events, so converting then
  would count that reading twice). Only turns that no native `page` event of the same volume covers (on
  any device, which phase 2's sync makes visible) are converted. Each volume's `recentPageTurns` becomes
  `page` events under a deterministic
  legacy key, `device = 'legacy:' + volume_uuid` and `seq = turn timestamp`, so every device converting the
  same turns produces the same IDs and the union deduplicates. Dwell comes from the next turn, as today.
  `archivedReads` becomes `restart` events. `timeReadInMinutes` beyond what the turns explain becomes one
  `adjust` event per volume, so totals don't drop.
- **Old app versions are not a design concern.** Web-app updates are close to automatic and the app
  prompts for them, so two versions trading `volume-data.json` is a short window. New versions convert
  whatever `recentPageTurns` they find (local or in the cloud file) through the legacy path above and write
  `volume-data.json` without them. No compatibility mode, no dual writing.
- **mokuro-bunko** must treat `history/` as per-user progress, the same partition as root `.json`. Until a
  bunko release does, the client skips uploading history to bunko (provider capability flag) and keeps it
  local.

## Rollout (each phase shippable)

1. **Local event store + recording.** Separate `mokuro_history` IndexedDB, `page` events on leave,
   `adjust`/`restart`/`forget` from the existing stat edits, device facts. Nothing reads the events yet;
   page turns, sync and speed are unchanged.
2. **Segment sync + cut-over.** Upload own months, import others, add `history/` to the allowlist,
   convert legacy turns (coverage rule above), drop page turns from `volume-data.json`, batch the writes,
   stop syncing per page turn.
3. **Stats on events.** One clock, adaptive cutoff + synced override, long-pause prompts + review list,
   skip classification, recent speed by time, per-series time left. Retire `getEffectiveReadingTime` and
   the minute counter.
4. **Device views.** Generated labels, the three labelling entry points, class correction, merging devices, per-device stats.

## Testing

- Import is idempotent: same file twice, longer file after shorter, shuffled order → identical table.
- Two simulated devices recording concurrently, syncing in every interleaving → identical final tables and
  identical speed figures on both.
- Corrupt or truncated file → no partial import, retried next time.
- Legacy conversion on two devices from the same `volume-data.json` → same event IDs.
- Speed: no cliff when one volume exceeds any window; same result regardless of profile.
- Encoding round-trip, plus measured size on a real exported history.

## Decided (owner, 2026-10-02)

1. Long pauses: **prompt at the timeout itself**, staying up until answered; "Still reading" counts the
   time and widens the cutoff (synced) so it stops recurring; away → count all / typical / none on return;
   unanswered → review list, typical while provisional; "don't ask again" only after a few answers.
2. Skipped views **don't** count toward characters read; shown as skipped.
3. Old app versions: **not a concern** (fast web-app updates + update prompt). Convert old-format turns,
   stop writing them, no compatibility mode.
4. Idle cutoff: **characters in the layout** (whole pages only, at least one page) × one global pace. No
   per-device-class or per-layout term.
5. Device/layout stats: a section of the existing reading-speed page.
