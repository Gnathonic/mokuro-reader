# Catalog Cover Ingest — Design

**Date:** 2026-08-26
**Status:** approved (scope chosen by the user in session)
**Supersedes nothing.** Follows on from `2026-08-25-cloud-metadata-cache-design.md`, and fixes a
defect that design introduced.

## The problem, measured

On a 12,520-file WebDAV library (1,027 series) with a cold local database, startup fetches and
writes **4,347 cover blobs — 134 MB — in a 12.2-second burst (357 writes/second)**. During it:

| Metric                             | Value                                                  |
| ---------------------------------- | ------------------------------------------------------ |
| Worst long task                    | **1,784 ms**                                           |
| Worst frame gap                    | **1,972 ms**                                           |
| `cloud_covers` full-table re-reads | 23 in 59 s                                             |
| Rows deserialized                  | 109,126                                                |
| Blob bytes deserialized            | **3,886 MB**                                           |
| Time inside those reads            | 14,887 ms                                              |
| Series cards in DOM                | 1,027 (not virtualised), 12,406 nodes, 161,961 px tall |

The user sees the catalog freeze: scrolling shows no volume names, no placeholders, sometimes no
title bar, and covers arrive in halting lurches.

### Attribution — measured, not assumed

The obvious suspect is the blob volume. **It is not the cause.** Freezing `coverSignature` so that
an arriving cover no longer regenerates placeholders, and re-running the identical cold start with
the same ~4,000 writes and the same ~3.9 GB of full-table re-reads still occurring:

|                 | Before   | Re-derive disabled |
| --------------- | -------- | ------------------ |
| Worst long task | 1,784 ms | **122 ms**         |
| Worst frame gap | 1,972 ms | **135 ms**         |

The freeze is the **Svelte re-derive and re-render chain**, ~15× the next contributor. The blob
re-reads are real waste — 3.9 GB and 14.9 s — but they do not block paint. Recording this because
the intuitive diagnosis was wrong, and fixing only the blobs would have left the freeze intact.

### Mechanism

1. `cloudCoverMap` (`cloud-covers-store.ts`) is a `liveQuery` calling `getCloudCovers(scope, paths)`
   with **every listed `.cbz` path** (~4,347 tuples via `anyOf`). Dexie re-runs a liveQuery querier
   on every commit to the table, so each flush re-materialises **every cover row, blobs included**.
2. That new Map is an input to `volumesWithPlaceholders` (`index.ts`). Its `cloudCoverSignature`
   guard cannot help during ingest: it hashes `path\0size` per entry — an O(N) build plus O(N log N)
   sort — and during ingest every emission genuinely differs, so it pays that cost and recomputes
   anyway.
3. `generatePlaceholders` re-walks all **12,520** listed files and mints ~4,347 **fresh** placeholder
   objects.
4. Fresh objects mean all **1,027** mounted `CatalogItem`s get new props, so every `$derived`
   re-runs and every `CompositeCanvas` repaints — for a change that cannot alter grouping or order.

### Two aggravating findings

- **Cover fetching is not viewport-driven.** `Catalog.svelte` renders all 1,027 series with plain
  `{#each}` — no virtualisation, no `IntersectionObserver`. Each `CatalogItem` requests covers for
  its top ~4 stacked volumes on mount. 1,027 × ~4 ≈ 4,347, including series thousands of pixels
  below the fold.
- **`cover-persist`'s backoff makes batches grow as the burst intensifies.** The delay doubles from
  750 ms up to 8,000 ms whenever a batch starts within 750 ms of the last flush, producing roughly
  four flushes carrying ~270 / 535 / 1,070 / 2,140 covers. Each flush does a **sequential
  `db.volumes.get()` per entry** — ~2,140 serialized round-trips against a ~14-row table — then one
  `bulkPut` of up to ~66 MB in a single transaction.

## Design

The theme is **decoupling, not batching**. Cover arrival should not be able to reach the catalog
derivation at all.

### 1. The cover map carries keys, not blobs

`cloudCoverMap` becomes a set of normalized cached paths, read with `primaryKeys()` over the
`[account_scope+path]` index. This codebase already proves that primitive is genuinely keys-only:
`cachedCoverPaths()` in `cloud-covers.ts`, verified against Dexie 4.2.1 — `anyOf` sets an algorithm
reading only `cursor.key`, so `primaryKeys()` takes the `keysOnly` branch and values are never
deserialized. This removes the 3.9 GB.

### 2. Each card resolves its own cover

A card fetches its cover blob by key (`[account_scope+path]`) on demand and owns the resulting
object URL, revoking it on unmount. Inserting one cover then costs **one keyed write plus one card
update** — the user's stated requirement — instead of a full-table read plus a whole-catalog
re-derive.

### 3. `volumesWithPlaceholders` stops depending on cover data entirely

This is the decisive structural change and it falls out of (1) and (2): once placeholders no longer
carry cover blobs, `cloudCoverMap` is removed from the derived's inputs, and `cloudCoverSignature`
is deleted rather than optimised. A cover landing then **cannot** trigger `generatePlaceholders`,
cannot mint fresh placeholder objects, and cannot re-render 1,027 components. The 1,784 ms task has
no path to exist.

### 4. Cover requests are gated to visible cards

`CatalogItem` requests covers only when near the viewport (`IntersectionObserver` with a
`rootMargin` prefetch margin). The existing `settled` bookkeeping in `cover-service.ts` already
prevents re-requesting, so cards re-entering the viewport must not re-fetch.

### 5. Bounded write batches, no sequential reads

Replace the growing-delay backoff with a **fixed short delay plus a hard maximum batch size**,
flushing whenever the cap is reached; and replace the per-entry sequential `db.volumes.get()` loop
with a single `bulkGet`. Batches should get _smaller_ under pressure, not larger.

## Non-goals

- **Virtualising the 1,027-card grid.** Explicitly deferred by the user. The DOM stays at 1,027
  cards and a 161,961 px page, so scroll repaint cost is unchanged by this work. Revisit if
  scrolling remains unsatisfactory once ingest is fixed.
- Changing the cover _format_ or thumbnail generation.
- The `series-open.ts` row-growth non-goal inherited from the previous design.

## Regression tests must measure bytes, not counts

The existing `perf-contracts.test.ts` suite bounds operation **counts**, and counts would not have
caught this: 23 reads is unremarkable; 437 MB per read is the defect. The contracts this work adds
must bound **bytes deserialized per cover insert** and **placeholder regenerations per cover
insert**. Both must be O(1) with respect to library size.
