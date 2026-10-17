# Sync tiers: slow, fast, ultrafast

Phase 5 of `2026-10-02-reading-history-event-log-design.md`. Status: draft for owner review.

## Why

Every sync-adjacent action today ends in the same place: one full listing of the cloud tree, held in
memory by the provider's `CloudCache`, and the only map anything has of the cloud. Measured 2026-10-11
on a production bunko library (1,074 series, 12.6k volumes, anonymous WebDAV PROPFIND):

| | Full listing (`Depth: infinity`) |
| --- | --- |
| Entries | 52,589 (51,510 files, 1,079 folders) |
| Wire | 1.84 MB gzip, 1.9 s (0.84 s to first byte, server-side cached) |
| XML | 31.4 MB |
| Parse (`webdav` library's `parseXML`, Node, desktop) | 1.6 s, 265 MB heap |

What the listing holds, and what already describes it:

| Files | Count | Already in `series.json` |
| --- | --- | --- |
| primary `.mokuro` | 12,624 | yes: `mokuro_size`, `mokuro_modified`, `mokuro_sha256` |
| layer `.mokuro` (one engine) | 12,508 | **no** |
| `.webp` covers | 12,622 | yes: `cover_size`, `cover_modified` |
| `.cbz` | 12,603 | size only (`archive_size`) |
| `series.json` | 1,074 | its own stamp is listed nowhere else |

The listing is not persisted: `CloudCache` lives in memory, so every app start pays the whole cost
before progress can sync. Google Drive's `uploadFile` also ends in a full paged refetch (13+
`files.list` calls on a 12.5k-file library), so the slow path hides inside ordinary writes there too.

Meanwhile the data that changes often is small and single-writer: a heavy reader's month of page events
is ~15 KB, written only by its own device. After phase 2 and `timeReadInMinutes`' retirement,
`volume-data.json` changes on a handful of days a month (17 real files: the busiest changed on 11 days in
30, most on none).

## The tiers

| Tier | Runs | Reads | Writes |
| --- | --- | --- | --- |
| **Ultrafast** | a few seconds after page turns settle; leaving the reader; `visibilitychange` → hidden | nothing | this device's current month segment, `history/<device>/<YYYY-MM>.events` |
| **Fast** | app start; focus regained; leaving the reader; every few minutes while open | conditional reads of the root config files and `catalog.json`; a listing of `history/` only; the changed series' `series.json` | merged root config files, only when they changed |
| **Slow** | first connect; the Cloud screen; backup, rename, delete; explicit refresh; a daily safety net on plain storage | today's full listing | as today |

A tier is not a separate sync engine. It is a way to refresh part of the listing cache plus the merge
steps that depend on that part. Everything that reads the cache today keeps reading it.

### No position file

The earlier sketch had a per-device position file. It is unnecessary: since 2026-10-04 the position IS
the newest page event (see "Position across devices"), and page events already ride the device's own
segment. Ultrafast pushes the segment; the fast tier imports the other devices' segments; the position
falls out.

Exception: where history does not sync (`historySyncAllowed(status)` is false — bunko before 0.7.1),
position stays in `volume-data.json`. There ultrafast degenerates to today's throttled
`volume-data.json` merge-and-upload, and the turns-only-convert-at-next-start gap (found 2026-10-11)
is fixed in the same change.

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
for single-writer files, not a Drive-only escape hatch. A provider whose `uploadFile` is already a
single PUT needs no separate implementation.

| Provider | `listFolder` | `downloadIfChanged` | `changesSince` |
| --- | --- | --- | --- |
| WebDAV / bunko | `PROPFIND Depth: 1`/`infinity` on the subtree | `If-None-Match` (live bunko answers `304`, 0 bytes) | — |
| Google Drive | `files.list` with `'<folderId>' in parents` | `files.get` metadata (`version`/`md5Checksum`), then content | `changes.list` from a stored page token |
| OneDrive | `children` of the folder by path | `If-None-Match` on the item's `eTag` | `delta` from a stored `deltaLink` |
| MEGA | from the in-memory tree (free) | compare node `timestamp`/`size` | not needed: the `sc` long-poll already patches the cache (`storage.on(...)`) |
| Local Folder | `getDirectoryHandle` + entries | `getFile().lastModified` + `size` | — |

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
  for catalog cards without the listing. About +100 KB raw on 1,074 series.
- **`series.json` volume entries** gain `layers: [{ id, size, modified }]` (removes 12.5k listing
  entries) and `archive_modified`.
- Both are additive and stay inside bunko's existing field-order contract
  (`orderVolumeEntryFields`).
- Conditional GET on the per-user root files and under `history/` must answer `304` like the library
  files do. To verify, not assumed.
- Root `Depth: 1` is 457 KB, sent uncompressed (1,074 series folders sit beside the config files). The
  fast tier therefore never lists the root; it reads known paths and lists `history/`.

## `volume-data.json` after the split

Once history syncs, the file holds the slow-moving remainder: titles, `addedOn`, `completed` /
`completedAt`, per-volume `settings`, `deletedOn`, plus the `series` and `tracking` sections.
`lastProgressUpdate` stops being its merge key (that stamp moves with the position). Each record
gets its own `updatedAt`, moved by a change to any remaining field. Whole-record newest-wins stays,
on that stamp.

Titles on volumes that have no reading are dropped (~98 KB on the largest file measured). Titles on
read volumes stay, since they are the only name a volume keeps after it is deleted from the cloud.

## Rollout (each step shippable)

1. **Ultrafast.** Segment push on the triggers above via `blindUploadFile`; the history-off
   fallback; `volume-data.json` per-record `updatedAt`. Drive's `uploadFile` stops refetching the whole
   listing after an upload of a single-writer file.
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
- History-off fallback: positions still converge across two devices through `volume-data.json`.
- Restored cache: app start with a fresh persisted cache issues no full listing (count requests in the
  WebDAV stub).
