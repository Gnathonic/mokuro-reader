# Unified cover requests + sync-time metadata resolution — Design

**Date:** 2026-09-02
**Status:** implemented on `feat/unified-cover-requests` (parts A, B) — part C lands on `feat/progress-tracker`. Four decisions taken by the user in session, recorded below.
**Follows:** `2026-08-26-catalog-cover-ingest-design.md` (covers out of catalog derivation,
per-card keyed resolution, `cloud_covers` cache) and the unimplemented plan
`docs/superpowers/plans/2026-08-31-metadata-resolution-trigger.md` on `feat/progress-tracker`.
**Motivation:** PR #270 (progress tracker) was written before metadata-only rows, the
`series.json` index cache and the `cloud_covers` cache existed. It reads covers as
`row.thumbnail` and never asks for one, and it re-runs the capped hole-patch sweep from its
own mount to get rows. Both are symptoms of two structural gaps this design closes.

## Decisions (user, 2026-09-02)

1. **Two branches, two PRs.** The shared changes (parts A and B) land on
   `feat/unified-cover-requests` off `develop`; that branch is then merged into
   `feat/progress-tracker`, where the tracker is refitted (part C).
2. **Covers on demand only.** Rows minted by sync-time resolution carry no cover. Every
   surface that draws a cover asks for it when near the viewport; a first connect costs zero
   cover downloads.
3. **Implement the 2026-08-31 resolution plan**: one trigger after each progress sync,
   awaiting the index refresh, coverage caps removed, view-mount triggers deleted. Sync
   reports success immediately; resolution continues behind it.
4. **Bunko ships first**: the `goals.json` per-user fix is rebased onto the deployed 0.3.5
   line as 0.3.6 and deployed (separate repo; tracked outside this spec).

## The two gaps

### Gap 1 — three cover installers, and a cache nothing installs from

Cover installation has three independent fetch-and-install flows that share only the write
queue (`cover-persist.ts`):

| Flow                     | Caller                      | Picks candidates from      | Consults cache?          |
| ------------------------ | --------------------------- | -------------------------- | ------------------------ |
| `requestCover`           | every card (`cover-claims`) | the rendered volume        | yes — and STOPS on a hit |
| `installCoversForSeries` | series open, backfill       | the series' rows + listing | yes — skips cached       |
| `refreshStaleCover`      | backfill                    | stale stamps it computed   | no                       |

Each decides on its own which rows need a cover and fetches on its own. And the cache is
read-only to all of them: a cover that reached `cloud_covers` while the volume was browsed as
a placeholder is never copied onto the row the volume later earns by being read. So a
surface that renders `row.thumbnail` (the tracker) stays blank for exactly the volumes the
user cares about.

### Gap 2 — metadata resolution is driven by navigation

`patchProgressHoles` runs from three view mounts and from startup, capped at five network
pulls per run, with a session memo that can poison a series attempted before its index was
cached. Its cheap phase (`materializeHistoryRows`) resolves rows against the cached
`series.json` indexes — but the index refresh is fire-and-forget behind the listing, so on a
network provider the startup sweep runs against a cold cache and materializes five series.
Measured (2026-08-31): cold cache 5 of 30, warm cache 30 of 30. Convergence depends on how
the user navigates.

## Part A — one cover request, one resolution ladder

### A1. The entry point

`requestCover(vol, options?)` in `cover-service.ts` is the only way anything asks for a
cover. It keeps its current contract for surfaces (idempotent, safe on every re-render,
viewport-gated by the caller) and gains two things: a **return value** and an **option**.

```ts
type CoverOutcome = 'row' | 'cache' | 'none' | 'skipped' | 'unresolved';
function requestCover(
  vol: VolumeMetadata,
  options?: { stillNear?: () => boolean; refresh?: boolean }
): Promise<CoverOutcome>;
```

- `'row'` — the cover is on (or queued for) the volume's `volumes` row.
- `'cache'` — the cover is in (or queued for) `cloud_covers`; surfaces resolve it by path.
- `'none'` — positively no cover exists for this volume (no sidecar in the listing).
- `'skipped'` — the dedupe ledger says nothing is left to do (see A4).
- `'unresolved'` — every retry produced nothing (transient failure; not blacklisted).

`stillNear` moves from a positional argument into `options` (one call site changes:
`cover-claims.svelte.ts`). Surfaces keep calling it fire-and-forget; batch callers await it.

### A2. The ladder

`resolveAndDeliver` becomes this sequence. Steps 1 and 2 are new; 3–5 are today's cases 1–4
unchanged.

1. **Not a target** — `isCoverFetchTarget(vol)` is false (a fresh thumbnail, or a real row
   the listing shows no sidecar for). Return `'skipped'` (unless `refresh`).
2. **Cached** — `!vol.thumbnail` and the listing path's cover is in `cloud_covers` for the
   active account (one keyed presence read, as today):
   - if `coverBelongsOnRow(vol)` (A3): read the cached row (one keyed `get`, the only place
     the blob is deliberately read outside the resolver), compare its stored stamp against
     the listing's current sidecar stamp with `isSidecarStale`; if fresh or stampless, hand it
     to `installCover(row, cached, cachedStamp, 'fill')` and return `'row'` — **promotion,
     no network**; if stale, fall through to step 3 (a fetch, which the write queue then
     routes onto the row).
   - otherwise return `'cache'`.
3. **Row exists** — fetch, `installCover` (mode `'overwrite'` iff `vol.thumbnail`), return
   `'row'` or `'cache'` by `coverBelongsOnRow`.
4. **Indexed placeholder** — fetch, `installCover`, return `'cache'` (no row is minted; the
   write queue lands it on a row only if one exists by flush time).
5. **Bare placeholder** — pull/materialize (batched, as today), fetch, `installCover`,
   return `'cache'` or `'none'`.

`refresh: true` (the backfill's stale-cover path) skips step 1's target test and step 2's
cache short-circuit and the ledger: the caller has already decided the cover in hand is stale
from stamps it computed. Mode is `'overwrite'` when the row carries a thumbnail; a
cache-resident cover is simply re-fetched and re-put at the same key.

### A3. Where a cover belongs — one predicate

`cover-persist.ts` decides at flush time whether a cover lands on the row or in the cache:
today's inline rule is "row exists AND (installed OR reading activity) AND `needsDownload`",
which reduces to _metadata-only row with reading activity_. That rule is extracted as

```ts
export function coverBelongsOnRow(
  row: VolumeMetadata | undefined,
  history: ReadingHistoryEntry | undefined
): boolean;
```

in `cover-persist.ts`, used both at flush time (as now) and at request time (step 2's
promotion decision, and the outcome reported by steps 3–5). One definition, so the promise
`requestCover` makes and the write the queue performs cannot disagree. `hasReadingActivity`
(`reading-activity.ts`) stays the sole definition of "read".

### A4. Dedupe records what was delivered

Today's ledger is a `Set` of settled `<scope>\0<uuid>` keys: once a uuid settles it is never
asked again this session. That is what would make promotion unreachable (settled as `'cache'`
while browsed, refused when the tracker asks after the volume is read) and what makes the
backfill's stale refresh a silent no-op for a uuid a card already settled.

The ledger becomes `Map<key, { target: 'row' | 'cache' | 'none'; stamp: string }>` where
`stamp` is the listing's cover-sidecar stamp the request was made against
(`cloudThumbnailSize:cloudThumbnailModifiedTime`, empty when unknown). A request is
redundant — returns `'skipped'` — only when an entry exists for the key, its stamp equals the
current one, and either its target is `'row'` or `'none'`, or the volume does not
`coverBelongsOnRow` now. So:

- a re-render of the same card is free (same stamp, same target);
- a volume settled `'cache'` while browsed is asked again the first time it is rendered as a
  read volume, and promotes;
- a changed sidecar (new stamp) is a fresh request, whoever asks;
- `'unresolved'` never writes the ledger, so the next render retries (today's rule).

In-flight dedupe is unchanged: a second request for a key in flight joins the first run and
receives its outcome.

### A5. `cloud_covers` rows carry their stamp

`CloudCover` gains optional `cover_size?: number` / `cover_modified?: number` — the same two
fields, same semantics and guards, as `VolumeMetadata.cover_size/cover_modified` and the
`series.json` entry stamps. `cover-persist.ts` already holds the stamp at flush time and
writes it on the cache row too. Promotion (A2 step 2) carries the cached stamp onto the row
rather than the listing's current one, so a row never claims a freshness it did not fetch.
Rows cached before this change are stampless, which the staleness rule treats as
never-stale — the same migration-safety inversion as everywhere else. Non-indexed fields;
no Dexie schema version bump.

### A6. The series pass becomes a candidate builder

`installCoversForSeries(seriesTitle)` keeps its name, its per-series in-flight dedupe and
its "dirty re-scan when a joiner arrives" behaviour, and loses its fetching. It:

1. reads the series' rows that `needsDownload` and lack a thumbnail (indexed read, as now);
2. joins them against the listing's cover sidecars and archive paths (the existing folded
   `coverKey` join);
3. decorates each match on a COPY (`cloudProvider`, `cloudPath`, the four `cloudThumbnail*`
   fields — never stored);
4. calls `requestCover(decorated)` for each and awaits them all;
5. returns how many resolved to `'row'` or `'cache'`.

`withoutCachedCovers` is deleted: the ladder's step 2 is the same presence check, and now
promotes where the pass used to skip. `MAX_CONCURRENT_COVER_INSTALLS` is deleted with the
worker pool; `cloud-thumbnails.ts`'s 8-slot fetch pool is the only network bound, as it
already was in practice. The post-fetch "did a download finish meanwhile" re-check moves
with the fetch into the ladder, where it already exists in the write queue's transactional
re-read.

### A7. The backfill's stale refresh becomes a request

`refreshStaleCover` in `series-backfill.ts` builds the same decorated copy (with the stale
sidecar's `size`/`modifiedTime` as the `cloudThumbnail*` stamp and the archive path as
`cloudPath`), calls `requestCover(copy, { refresh: true })`, awaits it, then
`flushPendingCoverPersists()` as today. `fetchCloudThumbnail` and `installCover` stop being
imported there; the module keeps `installCoversForSeries` for its post-write flesh-out.

### A8. Surfaces

`createCoverClaims` (`cover-claims.svelte.ts`) is unchanged apart from the `stillNear`
argument shape. The five existing surfaces are untouched. The tracker's card adopts it in
part C.

### A9. What does not change

- `cover-persist.ts`'s queue, batching, overflow policy, transactional re-check and routing
  (only the predicate is named and the cache stamp is written).
- `cloud-thumbnails.ts` (fetch pool, timeout, LIFO visible-first grant).
- `cover-resolver.ts`, `cloud-covers-store.ts`, `cover-viewport.ts`.
- Cases 3–5's materialization batching and `series.json` publish threading.
- No row is minted by a cover request that did not mint one before.
- A promoted cover's `cloud_covers` row is left in place; the 14-day TTL prunes it.

## Part B — resolution runs after every progress sync

### B1. One trigger

`unifiedCloudManager.syncProgress()` — the single funnel every sync caller already goes
through (startup, the sync button, the reader-exit auto-sync, Drive's post-login and re-auth
syncs, the cloud view) — starts resolution after `unifiedSyncService.syncProvider` returns
successfully, and returns its own result without waiting. The resolution promise is retained
on the manager (`unifiedCloudManager.progressResolution`) so tests and any caller that needs
the rows can await it.

The call is a **dynamic import** of `hole-patch.ts`: that module already imports the
manager, and the same one-way graph discipline that `cover-resolver.ts` uses for its key
watch applies here. A failure to import or run is logged and never reaches the sync result.

`unified-sync-service.ts` stays a byte mover and is not touched.

### B2. Resolution awaits the index refresh

`refreshSeriesIndexesInBackground()` keeps its fire-and-forget entry point and additionally
retains the `refreshSeriesIndexes(...)` promise it started; `whenSeriesIndexesSettled()`
returns it (resolved immediately when none is running). `resolveSyncedProgress()` in
`hole-patch.ts` is:

```
if (!listingIsLoaded()) return;          // same guard as today; the next sync catches up
await unifiedCloudManager.whenSeriesIndexesSettled();
await patchProgressHolesAndEnrich();     // enrich → sweep → enrich, unchanged ordering
```

Nothing here fetches a listing: resolution reacts to a sync, it never starts I/O the sync
did not already imply. (`fetchAllCloudVolumes` on Drive can itself trigger a sync after
login; a resolution that fetched would close that loop.)

### B3. Caps and memos

| Symbol                              | Today | After                                  |
| ----------------------------------- | ----- | -------------------------------------- |
| `MAX_HOLE_PATCHES_PER_RUN`          | 5     | removed, with the `limit` option       |
| `MAX_HISTORY_ROWS_PER_RUN`          | 1000  | removed, with the `limit` option       |
| `MAX_HISTORY_SERIES_PER_RUN`        | 200   | removed, with the `seriesLimit` option |
| `attemptedThisSession` (hole-patch) | kept  | removed                                |
| `unmaterializableThisSession`       | kept  | **kept**                               |
| `MAX_CONCURRENT_INDEX_DOWNLOADS`    | 4     | kept — bounds speed, not coverage      |
| `MAX_CONCURRENT_FETCHES` (covers)   | 8     | kept — bounds speed, not coverage      |

`attemptedThisSession` existed to stop a per-mount sweep re-pulling a series absent from the
cloud. With the trigger per sync and the index refresh awaited, phase 2 only downloads when a
`series.json` the listing shows is still uncached (a refresh failure) — a series absent from
the cloud costs `openSeries` zero I/O — so the memo has nothing left to save and its
poisoning hazard goes with it. `unmaterializableThisSession` is different in kind: it
records uuids the cached index proved cannot become rows (owned by another series, title
already taken, no listing for the series), is only ever written after the index was
consulted, and bounds retries, not coverage. It stays.

Phase 2 still goes through `openSeries`, which installs covers for the series it pulls.
That is the rare path (an index the listing-wide refresh failed to cache), bounded by the
same fetch pool; decision 2 is about the common path and is honoured there.

### B4. Database discipline (unchanged, restated)

One `primaryKeys()` on `volumes`, one `series_index` read shared by both phases, one `rw`
transaction for the whole materialization, no per-volume `get`. Removing the caps must not
split the transaction into batches. A run with nothing missing performs no DB writes and no
network.

### B5. View mounts

`patchProgressHolesWhenListingReady` and its `cloudFiles` retry subscription are deleted,
along with the `onMount` calls in `CatalogView`, `ReadingSpeedView` and (part C) the tracker.
`init-providers.ts` drops its `void patchProgressHoles()` — the startup sync now does it.

`enrichAllOrphanedVolumes` is not a cloud concern: it copies titles off rows this device
already has onto reading records that lack them, reads IndexedDB only when the store holds an
orphan, and is the only path by which a device with no provider ever fixes a legacy record.
It keeps running on mount in the two views that render per-series groupings from the reading
record — `ReadingSpeedView` and the tracker — called directly.

## Part C — the tracker on `feat/progress-tracker`

After merging `feat/unified-cover-requests` into `feat/progress-tracker`:

- **`VolumeCard.svelte`** drops its `thumbnail: Blob` prop and adopts
  `createCoverClaims({ claims: () => [volume], targets: () => [volume] })` with `use:gate` on
  the image box, exactly as `PlaceholderThumbnail` does. Display is the row's own thumbnail
  (object URL keyed on content, as now) first, the resolved cache cover second. Every volume
  the tracker lists has reading activity, so a request from a tracker card resolves to
  `'row'` — promoted from the cache or fetched — and the card repaints from the row when the
  write lands; the claim path shows the cached cover in the meantime.
- **`ProgressTrackerView.svelte`** passes `volume` only (already does) and replaces its
  hole-patch `onMount` with a direct `enrichAllOrphanedVolumes()`.
- The 2026-08-31 plan document is superseded by this spec and deleted.
- Everything else on the branch (goals sync, `completedAt`, the counting rules, the e2e
  spec) is unchanged. The e2e case "synced progress with no catalog row does not become a
  wall of empty cards" runs with no provider and stays valid.

## Error handling

Unchanged posture, restated: every path in A and B is best-effort and never rejects into a
view or a sync result. A cover request that fails transiently retries on the existing
backoff and reports `'unresolved'`; a promotion whose cache read fails falls through to a
fetch; a resolution run that throws is logged and the next sync tries again.

## Testing

Unit (Vitest, TDD per task):

- `cover-service`: the ledger (skip / re-ask on target upgrade / re-ask on stamp change /
  `refresh` bypass), promotion (cache hit + relationship → `installCover` with the cached
  blob and stamp, no fetch; stale cached stamp → fetch), outcomes per case, `stillNear` in
  options.
- `cover-persist`: `coverBelongsOnRow` cases; cache rows written with stamps.
- `cover-install`: retargeted — same observable behaviours (cached never re-downloaded, read
  metadata-only row gets the cover on the row, relationship-less row's cover cached,
  joiner re-scan) expressed through `requestCover`; the concurrency-pinning test deleted.
- `series-backfill`: stale refresh issues a `refresh: true` request and flushes.
- `hole-patch` / `history-rows`: cap and session-memo tests deleted; new tests for
  `resolveSyncedProgress` (awaits the index refresh; no-op without a listing; cold-vs-warm
  harness asserting N of N), `syncProgress` starting resolution and returning without it.
- `perf-contracts`: unchanged and must stay green (bytes per cover insert, placeholder
  regenerations per cover insert).
- Tracker: `VolumeCard` renders the row thumbnail, then the resolved cover, and requests once
  gated; the progress-tracker helpers untouched.

Gates: `npm run check` 0 errors, full Vitest, `npm run lint` at the develop baseline,
`e2e/catalog-distribution.spec.ts` and `e2e/progress-tracker.spec.ts` green on a dedicated
port. Browser verification of the promote path against the local bunko test instance
(read a volume as a placeholder, sync, open the tracker, observe the row's cover land
without a network fetch) if the instance is available.

## Non-goals

- Virtualising the catalog grid; changing cover format or thumbnail generation.
- Storing cloud fields on rows (`cloudPath` stays a listing decoration).
- Any change to the sync file formats, `goals.json` included.
- The reading-history heatmap branch.
