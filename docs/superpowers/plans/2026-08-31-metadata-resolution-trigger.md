# Move metadata resolution out of the views and into sync

## The measurement

With 30 series in the listing and synced progress for all 30, one
`patchProgressHoles()` run:

| `series_index` cache | rows materialized |
| -------------------- | ----------------- |
| cold (0 indexes)     | **5** of 30       |
| warm (30 indexes)    | **30** of 30      |

Five is `MAX_HOLE_PATCHES_PER_RUN`. Cold is what a network provider looks like
at the moment the startup sweep fires.

## Why it is cold

The provider LISTING is loaded and awaited — measured at startup: cache
populated 401ms, `syncProgress` 408ms, sweep immediately after. That is not the
problem.

`fetchAllCloudVolumes()` also fires `refreshSeriesIndexesInBackground()`, which
downloads the `series.json` sidecars, **fire-and-forget**. The sweep's cheap
phase resolves rows by `volume_uuid` against those cached indexes. On a local
provider they land in <50ms and the sweep works; over a network they do not, so
the sweep falls through to the capped network phase and patches five series.

Coverage is then made up by re-running the sweep from view mounts
(`CatalogView`, `ReadingSpeedView`, and — until this branch — not
`ProgressTrackerView`, which is the bug that started this). Convergence is
driven by how the user navigates.

## The change

### 1. One trigger, in the orchestrator

Remove:

- `void patchProgressHoles()` from `init-providers.ts`
- `patchProgressHolesWhenListingReady()` from all three views, and the function
  itself, along with its `cloudFiles` retry subscription and the
  `attemptedThisSession` memo — all three exist only to make view-driven
  polling converge, and the memo can poison a series it attempted before that
  series' index had landed.

Add one call in `unifiedCloudManager.syncProgress()`, after the providers
return.

NOT in `unified-sync-service`: that is the file-sync engine and should stay a
dumb byte-mover. The manager already owns the listing and the index refresh, so
the sequencing belongs there.

### 2. Await the index refresh

`refreshSeriesIndexesInBackground()` keeps its fire-and-forget entry point for
callers that only want the listing. The manager also retains the in-flight
promise so the resolve step can await THAT one rather than starting a second
run. After it settles, resolution is in-memory plus one bulk read.

### 3. Remove the coverage caps

| Constant                         | Now  | After    |
| -------------------------------- | ---- | -------- |
| `MAX_HOLE_PATCHES_PER_RUN`       | 5    | removed  |
| `MAX_HISTORY_ROWS_PER_RUN`       | 1000 | removed  |
| `MAX_HISTORY_SERIES_PER_RUN`     | 200  | removed  |
| `MAX_CONCURRENT_INDEX_DOWNLOADS` | 4    | **kept** |
| `MAX_CONCURRENT_COVER_INSTALLS`  | 8    | **kept** |

The last two bound CONCURRENCY, not coverage — they say how fast, not how much.
Everything that limits how much gets done goes.

### 4. No delta tracking

Each run rebuilds the missing set in memory from the merged volume map, the
in-memory listing and the cached indexes. Nothing diffs `volume-data.json`
against its previous copy. When the set is empty the run does no DB work and no
network at all, which is what makes running it on every sync cheap.

### 5. Database discipline

- One `db.volumes.toCollection().primaryKeys()` — keys only, never `toArray()`,
  which would deserialize every installed volume's thumbnail blob.
- One `rw` transaction for the whole materialization. Removing the caps must not
  split it into batches.
- No per-volume `get`. Bulk or nothing.

### 6. Thumbnails

After the rows land, install covers for the series that gained them, through the
existing `installCoversForSeries` and its 8-way pool.

## Verification

- The cold/warm harness above, asserting cold now materializes all N.
- A sync with nothing missing performs zero DB reads and zero requests.
- Existing hole-patch and history-rows tests, retargeted at the new entry point.
- A first-connect run against a seeded multi-series library, asserting every
  volume with history ends up with a row and a cover.

## Open questions

1. **Covers.** On a first connect this is one image download per volume with
   history — hundreds. It is the only genuinely new network volume here.
   Everything, or only volumes that are in progress / on device?
2. **Blocking.** Should the sync's completion snackbar wait for resolution, or
   should sync report success and resolution continue behind it?
3. **Concurrency limits.** Confirm keeping the two above.
