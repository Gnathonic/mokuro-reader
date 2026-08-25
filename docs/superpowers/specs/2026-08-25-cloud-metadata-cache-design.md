# Cloud Metadata Cache — Design

**Date:** 2026-08-25
**Status:** approved (decisions taken by the user in session, recorded here verbatim)

## The problem, measured

Render-demand materialization (shipped 2026-08-24) writes a `volumes` row for every
cloud volume the user's catalog renders. On a 1,032-series bunko catalog that took the
table from 434 rows to **11,354** — 361 installed volumes and ~11,000 cloud rows carrying
**417 MB of thumbnail `File` blobs**.

Measurements on the real database (app stopped, no other tabs):

| Operation                                      | Time           |
| ---------------------------------------------- | -------------- |
| `indexedDB.open`                               | 18 ms          |
| `getAllKeys` (11,354)                          | 27 ms          |
| `getAll` 1,000 / 4,000 rows                    | 35 ms / 150 ms |
| **`getAll` all 11,354 rows (417 MB of blobs)** | **501 ms**     |

The database is healthy and scales linearly. The failure is **how often the app scans it**:
in a 10-second window after load, the app performed **74 full scans** of `volumes`, whose
individual durations climbed 337 → 708 → 1189 → … → 7900 ms as they queued behind each
other — 100 seconds of cumulative database work inside a 10-second window. The main thread
showed **zero** long tasks throughout: the JavaScript is fine, the IndexedDB backend is
saturated.

Two sources feed the storm:

1. The catalog's `volumes` liveQuery (`src/lib/catalog/index.ts:73`) re-runs
   `db.volumes.toArray()` on **every write** to the table, and cover/materialize writes are
   frequent.
2. **16 direct `db.volumes.toArray()` call sites** answer narrow questions with a full scan.
   The hot ones fire per-series during convergence: `hasBackedUpVolume`
   (`series-file-sync.ts:151`), `locallyKnownSeriesKeys` (`series-file-sync.ts:540`), the
   backfill's expensive phase (`series-backfill.ts:455`), and `stranded-rows.ts:35`.

Root cause of both: **there is no way to distinguish a local entry from a cloud metadata
entry without deserializing the entire table and reading fields.** `metadata_only` is not
indexed and cannot be — booleans are not valid IndexedDB keys.

## The design

Split by _relationship_, not by data shape:

- **`volumes` (local table)** — volumes this device has a relationship with: **installed**
  volumes, plus **metadata-only rows for volumes with reading history** (needed by the stats
  and history pages). Sized from real data: 361 installed + ≤708 with reading activity ≈
  **700–1,070 rows**, so a full scan costs ~45 ms instead of 501 ms.
- **`cloud_covers` (new table)** — **thumbnail blobs only**, keyed `[account_scope+path]`.
  Nothing else: `series_index` already stores every other per-volume field this feature
  needs.

The decisive property is not just that scans get cheaper: once cloud enrichment lives in its
own table, **cover and materialize writes stop touching `volumes` at all**, so they no longer
fire the catalog's local liveQuery. The storm's fuel is removed rather than rationed.

### Why the new table is tiny (revised 2026-08-25 after review)

The first draft of this spec gave the new table fifteen fields. Seven of them —
`volume_uuid`, `volume_title`, `page_count`, `character_count`, `archive_size`,
`cover_size`, `cover_modified` — already exist in `series_index`, inside the cached
`series.json`'s `volumes[]`. Caching them a second time would be duplication with an extra
invalidation path to get wrong.

The only data no existing table holds is the **thumbnail blob** (plus its dimensions), the
**account scope** that owns it, and the **access timestamp** that expires it. So the new
table is exactly that and nothing more:

```
cloud_covers: [account_scope+path] -> { thumbnail: File, width, height, last_accessed }
```

Everything else a cloud card renders is read from `series_index`, which is already keyed by
series, already carries `fetched_at`, and is already refreshed by the existing sync path.

**Why blobs get their own table rather than living inside the `series_index` row.** A
`series_index` row covers a whole series, so its covers would be ~12 blobs (~450 KB) per
row — and `listSeriesIndexes()` reads that table whole during the refresh pass, which would
reintroduce precisely the blob-carrying full scan this work exists to eliminate. A separate
per-volume table also avoids read-modify-write: covers arrive one at a time from concurrent
fetches, while `series_index` rows are written wholesale by the sync path.

## Decisions (user, 2026-08-25)

1. **No migration code.** This feature never shipped, so no user's database contains
   `metadata_only` rows. The entire schema migration is _adding a new table_. No cleanup, no
   data movement. The developer's own oversized database is handled by wiping local web-app
   storage and letting it rebuild.

   **Corollary (verified 2026-08-25):** schema versions 2, 3 and 4 — `series_metadata`,
   `series_index`, `catalog_index` — are also unshipped. `main` and `develop` both declare
   `version(1)` alone, and the commits introducing the others (a3d41deb, 11a1f8de) are
   contained only in `feat/series-metadata`. There are no `.upgrade()` callbacks and no code
   reads `db.verno`. So the branch's four versions collapse to **one new `version(2)`**
   declaring the final table set; keeping them separate would encode upgrade steps no
   database has ever taken. Developer databases sitting at version 3 or 4 will refuse to
   open (`VersionError`) until site data is cleared — which this plan does anyway.

2. **Composite key: account scope + path.** Cloud volume UUIDs are not available from
   providers, so the key is the file's **path**, scoped by **provider + account**, so that
   switching accounts or providers cannot cross-contaminate the cache.
3. **Expiry: age-based only.** Entries expire **14 days** after last access. No size quotas,
   no LRU byte budgets, nothing to juggle.
4. **Local table keeps history rows.** A metadata-only row stays in `volumes` when the volume
   has reading history, because stats and history pages reference it. Everything else is cache.
5. **Emission coalescing is in scope**, alongside narrowing the direct scanners.

## Non-goals

- Migrating or preserving existing cloud rows (see decision 1).
- Size/quota-based eviction (see decision 3).
- The ~1,366 reading-history entries that carry no reading activity ("residue"). The user
  ruled this out of scope for now; revisit separately if it proves to matter.

## Open risk accepted

Wiping local storage during development discards the developer's installed volumes as well.
The user has accepted this; the library is re-downloadable from the cloud.
