# Sync tiers: slow, fast, ultrafast

Phase 5 of `2026-10-02-reading-history-event-log-design.md`. Status: draft for owner review.

## Why

Every sync-adjacent action today ends in the same place: one full listing of the cloud tree, held in
memory by the provider's `CloudCache`, and the only map anything has of the cloud. Typical figures
for a large bunko library (~1k series, ~12k volumes, anonymous WebDAV PROPFIND):

|                                                      | Full listing (`Depth: infinity`) |
| ---------------------------------------------------- | -------------------------------- |
| Entries                                              | ~52k (~51k files, ~1k folders)   |
| Wire                                                 | ~2 MB gzip, ~2 s                 |
| XML                                                  | 31.4 MB                          |
| Parse (`webdav` library's `parseXML`, Node, desktop) | 1.6 s, 265 MB heap               |

What the listing holds, and what already describes it:

| Files                        | Count | Already in `series.json`                               |
| ---------------------------- | ----- | ------------------------------------------------------ |
| primary `.mokuro`            | ~12k  | yes: `mokuro_size`, `mokuro_modified`, `mokuro_sha256` |
| layer `.mokuro` (one engine) | ~12k  | **no**                                                 |
| `.webp` covers               | ~12k  | yes: `cover_size`, `cover_modified`                    |
| `.cbz`                       | ~12k  | size only (`archive_size`)                             |
| `series.json`                | ~1k   | its own stamp is listed nowhere else                   |

The listing is not persisted: `CloudCache` lives in memory, so every app start pays the whole cost
before progress can sync. Google Drive's `uploadFile` also ends in a full paged refetch (13+
`files.list` calls on a ~12k-file library), so the slow path hides inside ordinary writes there too.

Meanwhile the data that changes often is small and single-writer: a heavy reader's month of page events
is ~15 KB, written only by its own device. After phase 2 and `timeReadInMinutes`' retirement,
`volume-data.json` changes on a handful of days a month (in the files sampled, the busiest changed on 11
days in 30, most on none).

## The tiers

| Tier          | Runs                                                                                                           | Reads                                                                                                                                            | Writes                                                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Ultrafast** | a few seconds after page turns settle; leaving the reader; `visibilitychange` → hidden                         | conditional read of `positions.json` (almost always `304`)                                                                                       | `positions.json` merged with this device's newest position; this device's current month segment, `history/<device>/<YYYY-MM>.events` |
| **Fast**      | app start; focus regained; **reader open**; leaving the reader; every few minutes while open                   | conditional reads of `positions.json`, the root config files and `catalog.json`; a listing of `history/` only; the changed series' `series.json` | merged root config files, only when they changed                                                                                     |
| **Slow**      | first connect; the Cloud screen; backup, rename, delete; explicit refresh; a daily safety net on plain storage | today's full listing                                                                                                                             | as today                                                                                                                             |

A tier is not a separate sync engine. It is a way to refresh part of the listing cache plus the merge
steps that depend on that part. Everything that reads the cache today keeps reading it.

### The position file

The position is still the newest page event (see "Position across devices"), and page events still ride
each device's own segment. But a segment has no fixed address: `history/<device>/` is named by device
ids another device only learns by listing `history/`. A device that has just been picked up needs one
answer, fast: where did I stop? That needs a file at a known path.

`positions.json`, at the root beside `volume-data.json`:

```json
{ "version": 1, "positions": { "<volume_uuid>": [1791688941862, 120, 12000, "<device>"] } }
```

- One entry per volume: time of the page view that set it (epoch ms), page, characters, device.
- **Window: 30 days.** Measured on sampled libraries: ≤ 802 B for all of them. An entry older than that
  leaves the file. The position it carried is still in the events, and in `volume-data.json` while
  history does not sync.
- **Merge:** per volume, newest view time wins. Read-merge-write: ultrafast does a conditional GET first
  (a `304` while only this device is reading) and writes only when its own entry changed. Two devices
  writing in the same second can drop one entry; the events still hold it, so the next fast tier
  restores it. A user reads on one device at a time, so this is rare and self-healing.
- **Not authoritative.** It is a fast index of the newest page events. Events win wherever both are
  known. `positions.json` exists so the question can be answered before any listing.

### The device swap

The reported failure: pick up the other device, open the book before sync has caught up, land on the old
page, and the act of opening stamps that old page as the newest position. Every device then follows it
back.

1. **Reader open checks first.** Opening a volume starts a conditional GET of `positions.json` (its ETag
   is known from the last read). The reader waits for it up to ~1 s (a `304` round trip is well
   under a second) before choosing the page.
2. **A newer remote position wins silently**: the reader opens there, with a toast naming the device
   ("Continued from Phone, p.120").
3. **An opened page never claims the position by itself.** The page the reader opens on — before the
   check answers or after a timeout — is recorded as a page view for stats, but it is not a position
   until the reader turns a page or the check has answered. A late answer with a newer remote position
   therefore still jumps, with the same toast, as long as no page has been turned.
4. **After a page turn, it is an offer.** If the late answer shows newer reading elsewhere and the
   reader has already turned a page, the existing phase 2c offer applies: "You also read to p.N on
   another device — Jump / Stay".
5. **Offline or provider down:** the timeout opens the local page; steps 3–4 apply when the answer
   arrives.

The same conditional GET runs on focus regained and app start, so the catalog's "continue" points at
the right page before a book is even opened.

### Look-up visits claim nothing

A user opens a book, pages around, and comes back to the page they started on: the last page of a
finished volume, page 1 of an unread one, or a mid page of a volume they were not there to read. The
pattern says they came to check something. Nothing they did is new progress, so nothing about it
may outrank another device, re-order the catalog, complete the volume, or count as characters read.

**A visit** is one device's run of page views of one volume, split where the gap between one view's end
and the next view's start exceeds `VISIT_GAP_MS` (10 min). It is defined on the reading-history events,
so every device draws the same visits; the live side uses the same definition on its own events.

**A visit is a look-up** when all three hold:

1. it has at least two views;
2. its last view shows a page of its first view (the same view, spread included: page ranges overlap);
3. it read at most `LOOKUP_MAX_READ_PAGES` (2) distinct pages outside the first view. A page is read
   by a view that lasted at least `READ_DWELL_MS` (3 s) and is not a skip (`SKIP_CPM`).

Rule 3 is the guard. Without it, reading a whole unread volume and then flipping back to the cover
would erase the read. A visit that reads properly and then returns home is ordinary reading.

What a look-up changes:

- **Position (live).** On the device, a visit remembers the record as it stood when it started (page,
  chars, `completed`, `completedAt`, `lastProgressUpdate`), taken after the reader-open check. When the
  reader comes back to the home view and the visit so far qualifies, the record is restored. The page
  the user sees is the same; only the claim goes.
  - Nothing of the visit left the device: the old stamp comes back exactly, and the push has nothing to
    send.
  - A stamp of the visit did leave (the 3 s `positions.json` push, the idle `volume-data.json` sync):
    restoring the old stamp would lose to that upload, so the home values are written with a stamp
    1 ms above the newest one uploaded. That beats only this device's own visit; a real turn elsewhere
    after it still wins.
  - Restore only while the record's stamp is one this visit set. If another device's position replaced
    it mid-visit, the visit has nothing to undo.
  - A late answer of the open check that moves the page (no page turned yet) re-homes the visit there,
    live only. History still sees the first view at the old page, so it rates such a visit ordinary
    reading: the error goes toward today's behaviour.
- **Completion.** Reaching the last page sets the record's flag as today, but the completion notice
  (AniList push) waits until the visit ends on the last-page window: the reader closes, moves to the
  next volume, or the tab is hidden. A look-up that came back has restored the flag, so no notice goes.
- **Offers (phase 2c).** `planPosition` ignores the views of look-up visits, so another device is never
  offered "laptop stopped at p.40" for a look-up.
- **Stats.** The views of pages outside the home view count as time viewed but are treated as skips:
  no characters read, no speed sample. Home views count as they do now.
- **Last read.** See below.

### Last read is not the merge key

`lastProgressUpdate` does two jobs: it is the merge key of `volume-data.json` (and of the local record
against `positions.json`), and it is read as "when was this last read" by the catalog's smart sort
(`Catalog.svelte`), the progress tracker's ordering (`progress-tracker-helpers.ts`), and the completion
date fallback of `reading-speed-history.ts`. Any write that must win a merge therefore re-orders the
catalog: the look-up re-assert above, and today already a cover toggle, a stat edit in the volume
editor, or a "Jump" answer.

"Last read" comes from reading history instead: a volume's newest page-view end, over legacy (converted)
views and native views outside look-up visits. A volume with events but no such view was never read
(0). A volume with no events at all (read before history, or history not loaded yet) falls back to
`lastProgressUpdate`. The completion date fallback uses `completedAt` before `lastProgressUpdate`.
After this, the merge key is bookkeeping only.

While a visit is still under way it counts as reading; it can only be rated a look-up once it has come
home. The series moves back when it does, on every device as the history arrives.

### Where history does not sync

`historySyncAllowed(status)` is false on bunko unless its identity reports a `version` whose numeric
core is at least 0.8.0 AND its `per_user_files` lists `history/` (0.8.0 is the first to do both; a
missing version means no). There, position also stays in
`volume-data.json`, and ultrafast falls back to today's throttled `volume-data.json` merge-and-upload.
The turns-only-convert-at-next-start gap is fixed in the same change.
`positions.json` is still written wherever the provider maps it per user (see bunko changes).

## How it fits the unified provider layer

Three layers today: `SyncProvider` (verbs — path-based `uploadFile`, fileId-based `downloadFile`, one
`listCloudVolumes`), `CloudCache` (the listing; refilled whole by `fetch()`, patched only by uploads'
`add`/`update`), and the unified services (`unified-sync-service.ts`, `unified-cloud-manager.ts`,
`history-sync.ts`) that merge. Every read locates its file through the cache, which is why everything
needs the full listing. The design keeps that shape and adds partial refreshes.

### 1. `SyncProvider`: optional verbs, capability-detected

Same pattern as `blindUploadFile`: optional, and `unifiedCloudManager` falls back to the full listing
when a provider lacks one.

```ts
/** List one subtree (e.g. `history/`) without walking the library. */
listFolder?(path: string): Promise<CloudFileMetadata[]>;

/** Download unless unchanged since `known` (ETag / version / size+mtime). */
downloadIfChanged?(
  file: CloudFileMetadata,
  known: { etag?: string; size?: number; modifiedTime?: string }
): Promise<{ changed: false } | { changed: true; blob: Blob; file: CloudFileMetadata }>;

/** Everything that changed anywhere since `token`; `null` token = start a feed. */
changesSince?(token: string | null): Promise<{
  token: string;
  upserts: CloudFileMetadata[];
  removedIds: string[];
  /** the provider dropped the token: run the slow tier */
  reset?: boolean;
}>;
```

Ultrafast writes use `blindUploadFile` (an upload that never refetches). It becomes the default write
for this device's own segments and for `positions.json` after its conditional read, not a Drive-only
escape hatch. Both are known paths whose fileId the cache already holds after the first write. A provider whose `uploadFile` is already a
single PUT needs no separate implementation.

| Provider       | `listFolder`                                  | `downloadIfChanged`                                          | `changesSince`                                                               |
| -------------- | --------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| WebDAV / bunko | `PROPFIND Depth: 1`/`infinity` on the subtree | `If-None-Match` (a bunko answers `304`, 0 bytes)             | —                                                                            |
| Google Drive   | `files.list` with `'<folderId>' in parents`   | `files.get` metadata (`version`/`md5Checksum`), then content | `changes.list` from a stored page token                                      |
| OneDrive       | `children` of the folder by path              | `If-None-Match` on the item's `eTag`                         | `delta` from a stored `deltaLink`                                            |
| MEGA           | from the in-memory tree (free)                | compare node `timestamp`/`size`                              | not needed: the `sc` long-poll already patches the cache (`storage.on(...)`) |
| Local Folder   | `getDirectoryHandle` + entries                | `getFile().lastModified` + `size`                            | —                                                                            |

### 2. `CloudCache`: persisted, and patched by scope

- **Persisted.** The listing is written to IndexedDB with its provider, account scope, the time of the
  slow listing that produced it, and the provider's change token if any. Its own small database
  (`mokuro_sync`), like `mokuro_history`, so the main `mokuro_v3` schema ladder is untouched. App start
  restores it and runs the fast tier instead of the slow one. A cache older than the safety-net age
  (one day) on a provider without a change feed starts with a slow listing.
- **`patch(prefix, entries)`.** Replaces every entry under a path prefix (`history/`, one series
  folder, one root file) and leaves the rest. The store emits once per patch, so the 13 modules that
  read the listing see an ordinary update.
- Each patch records its source (`slow`, `feed`, `series-file`, `probe`) so diagnostics can tell a
  synthesized entry from a listed one.

### 3. Unified layer: one tier argument, one scheduler

- `syncProvider(provider, { tier: 'ultrafast' | 'fast' | 'slow' })`. The merge code is unchanged; the
  tier decides which inputs are refreshed first and which steps run (ultrafast runs none of the merges).
- A new `sync-scheduler.ts` owns the triggers above and collapses overlapping requests to the highest
  tier asked for (single-flight, as `#299` does for sync today). The ad-hoc call sites that start a full
  listing now ask the scheduler for the tier they need.
- **The fast tier picks its strategy by capability:**
  1. `changesSince` (Drive, OneDrive): one feed call, patch the cache with whatever changed anywhere —
     deep or root, made by this app or by anything else. Then merge as usual.
  2. `serverCompilesMetadata` (bunko): the catalog cascade below.
  3. Neither (plain WebDAV, Local Folder): `downloadIfChanged` on the known root files and
     `listFolder('history/')`. Changes inside series folders made by other reader clients reach this
     device through `catalog.json` the same way as on bunko; files another tool drops in wait for the
     slow tier.

### The catalog cascade (bunko, and plain storage written only by reader clients)

1. `downloadIfChanged(catalog.json)`. Unchanged → done.
2. Compare each entry's `series_stamp` with the cached one; collect the series that moved.
3. Fetch those `series.json` files (median 3.5 KB) and synthesize their listing entries — `.cbz`,
   primary `.mokuro`, cover, layer files — from the volume index; `patch('<Series>/', entries)`.
4. The existing per-series passes (OCR upgrade, covers, placeholders, layer sync) run for those series
   only.

Synthesis needs fileIds derivable from the path, which holds for WebDAV (`fileId` = full path) and
Local Folder. Drive and OneDrive never synthesize; their feed is authoritative.

## mokuro-bunko changes

- **`catalog.json` entries** gain `series_stamp` (the `series.json` file's size and mtime, or its
  hash), `volume_count`, and a cover pointer (volume title + `cover_size`/`cover_modified`) — enough
  for catalog cards without the listing. About +100 KB raw on ~1k series.
- **`series.json` volume entries** gain `layers: [{ id, size, modified }]` (removes ~12k listing
  entries) and `archive_modified`.
- Both are additive and stay inside bunko's existing field-order contract
  (`orderVolumeEntryFields`).
- **`positions.json` joins `PathMapper.PER_USER_FILES`.** Anything else under `/mokuro-reader/`
  resolves into the shared library: without the mapping the file is one file for every account, each
  overwriting the others. The reader reads and writes it only when the server says it maps it:
  `positionsSync` is true when the identity's `per_user_files` contains `positions.json`, whatever the
  version (unlike `historySync`, which also needs 0.8.0). Until then bunko users keep position in
  `volume-data.json`.
- **Duplicate copies are kept, not trashed.** Positions sync merges every listed `positions.json`
  copy, like `volume-data.json` and `goals.json`, so the reader's folder dedup (and bunko's, on
  Drive/MEGA) moves both copies in and lets the next sync fold them.
- Conditional GET on the per-user root files and under `history/` must answer `304` like the library
  files do. To verify, not assumed.
- A root `Depth: 1` is on the order of 450 KB, sent uncompressed (~1k series folders sit beside the config files). The
  fast tier therefore never lists the root; it reads known paths and lists `history/`.

## `volume-data.json` after the split

Once history syncs, the file holds the slow-moving remainder: titles, `addedOn`, `completed` /
`completedAt`, per-volume `settings`, `deletedOn`, plus the `series` and `tracking` sections.
`lastProgressUpdate` stops being its merge key (that stamp moves with the position). Each record
gets its own `updatedAt`, moved by a change to any remaining field. Whole-record newest-wins stays,
on that stamp.

Titles on volumes that have no reading are dropped (~98 KB). Titles on
read volumes stay, since they are the only name a volume keeps after it is deleted from the cloud.

## Rollout (each step shippable)

1. **Position file + ultrafast.** `positions.json` (allowlist, merge, 30-day window), the
   reader-open check and the open-never-claims rule, segment push on the triggers above via
   `blindUploadFile`; the history-off fallback; `volume-data.json` per-record `updatedAt`. Drive's `uploadFile` stops refetching the whole
   listing after an upload of a single-writer file.
   1b. **Look-up visits and last read.** The visit rule in history (offers, stats, last read), the live
   restore with escape-aware stamps, completion notices at visit end, and smart sort / progress tracker
   reading last-read times. Stacked on step 1 (it uses the open check's home and the push bookkeeping).
2. **Persisted cache + scheduler + fast tier on plain probes.** `mokuro_sync`, `patch`,
   `sync-scheduler.ts`, `listFolder` / `downloadIfChanged` on every provider. App start no longer waits
   on a slow listing when a fresh cache exists.
3. **Catalog cascade.** The bunko changes, then the reader side. The slow tier leaves app start on
   bunko entirely.
4. **Change feeds.** Drive `changes.list`, OneDrive `delta`.

## To verify before building

- Drive `changes.list` under the `drive.file` scope returns changes to the app's own files (expected,
  not yet tried).
- OneDrive `delta` on a non-root folder: supported on personal accounts; restricted on
  OneDrive for Business. If restricted, use the drive-root `delta` and filter.
- Which listing consumers read a `.cbz` `modifiedTime` (synthesized entries have only what
  `series.json` gives).
- Parse cost on a real phone (desktop figure only so far).
- Server `304`s for per-user files on bunko.

## Testing

- Cache patch: a prefix patch replaces exactly that subtree; consumers see one emission; a slow
  listing after any sequence of patches yields the same cache as a slow listing alone.
- Scheduler: overlapping triggers collapse to the highest tier; a slow run in flight absorbs fast
  requests.
- Catalog cascade: unchanged catalog → no `series.json` read; one changed stamp → exactly that series
  refetched and patched; a removed series is pruned.
- Feed: `reset` falls back to a slow listing; a replayed token is idempotent.
- Device swap: device A reads to p.120 and pushes; device B, holding p.40, opens the volume. Check
  answers in time → B opens at p.120. Check times out → B opens at p.40, records no position; the late
  answer moves B to p.120. B turns a page first → the offer, never a silent move back to p.40 on A.
- `positions.json` merge: newest view time wins per volume; entries older than 30 days leave the file;
  a lost concurrent write is restored by the next fast tier from the events.
- History-off fallback: positions still converge across two devices through `volume-data.json`.
- Restored cache: app start with a fresh persisted cache issues no full listing (count requests in the
  WebDAV stub).
- Look-up visits: open at p.40, view p.41 and p.42 briefly, come back to p.40 → the record's stamp is
  the pre-visit one, no `positions.json` write, the series keeps its smart-sort place. The same with a
  4 s dwell on p.41 (the push went out) → the file ends at p.40 under a stamp just above that push.
  Read p.1→p.200 and flip back to p.1 → ordinary reading: completed, characters counted, series moved.
  Peek at the last page of an unread volume and come back → not completed, no AniList push.
