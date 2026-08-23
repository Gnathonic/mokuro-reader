# Catalog & Series Metadata Distribution — Design

Date: 2026-08-23. Builds on `2026-08-16-series-metadata-linking-design.md` (series.json v2) and the metadata-only volume state (`2026-08-22-metadata-only-volumes` plan). Decisions below were made by the user 2026-08-23.

## Goal

Fast, incremental catalog browsing on large/slow backends (bunko: 1k+ series) with a defined load schedule:

- **Catalog open** → install/update **series names** (mapping + search data) from a root `catalog.json`.
- **Series open** → install/update **volume metadata + thumbnails** from that series' `series.json` + cover sidecars, materialized as metadata-only volume rows.
- **Bunko compiles** both files server-side; **clients compile them for non-bunko backends**.
- Metadata writes are **best-effort**: failure never flips the provider to read-only and never surfaces error UI.

## Files

### `catalog.json` (root, next to `series-metadata.json`)

Name-related data ONLY — everything needed to map and search, nothing more. No counts, no covers, no volume lists (those live in `series.json`; we may revisit if this produces holes — see Hole patching).

```json
{
  "version": 1,
  "updated_at": "2026-08-23T00:00:00.000Z",
  "series": [
    {
      "series_title": "Dr Stone (HD Scan)",
      "titles": { "native": "Dr.STONE", "romaji": "Dr. STONE", "english": "Dr. STONE" },
      "synonyms": [],
      "tag": "HD Scan",
      "unit": "volumes",
      "external_ids": { "anilist": 98416, "mal": 103897 },
      "updated_at": "2026-08-18T19:36:24.324Z"
    }
  ]
}
```

Entry = the FACTS subset of that series' `series.json` (same keys, same meaning, same facts stamp). Compact JSON. Factless series (no link/titles/tag) still get an entry carrying just `series_title` + stamp — the catalog must list them by folder name.

### `series.json` (unchanged v2)

Facts + volume index. Covers stay OUT of it — the existing per-volume cover sidecars (`<Series>/<Volume>.webp|jpg` next to the `.cbz`) remain the universal cover source; bunko generates missing ones.

## Producers

- **Bunko**: sole producer of its `catalog.json` and `series.json` files, compiled from `.mokuro` archives + accepted user updates (below). Client-side production is disabled when the provider is bunko-backed.
- **Clients** (Drive/MEGA/WebDAV/Local Folder): produce `catalog.json` the same way they produce `series.json` — debounced after fact edits and backup completion, union-by-key with the existing cloud file (newest facts stamp wins per series), pruned against the listing (folders gone from the cloud drop out), never written when the listing is unavailable/stale. `catalog.json` joins the root-config allowlist.

## Consumption schedule (client)

1. **Catalog open / provider connect**: fetch `catalog.json` when its size/mtime changed (same versioning discipline as `series_index`). Cache in a new Dexie table `catalog_index` (PK `series_key`, source stamp). Merge each entry's facts into `series_metadata` by facts stamp (the factless-file rules apply: a factless entry never creates a record and never unlinks). The catalog view lists catalog-only series as name-only cards (searchable via the same `seriesSearchTerms`); opening one triggers the series-open path.
2. **Series open**: refresh that ONE series' `series.json` (size/mtime gated, event-driven — not waiting for a full listing pass), then **materialize** each cloud-only volume entry as a metadata-only `volumes` row: real uuid, counts, `mokuro_version`, `spine_width`, `metadata_only: true`. Fetch its cover sidecar lazily (bounded concurrency) and store it in the row's inlined `thumbnail`. Materialized rows shadow placeholders permanently; the placeholder fallback remains for entries without an index (bare shares) — the enrichment ladder is unchanged, materialization just promotes rung 2 into rung 1.
3. **Hole patching**: synced progress referencing a series (by `series_title`/`series_uuid` on the progress record) that has no local rows and no cached index forces a pull of that series' `series.json` + materialization, so stats views never dangle.

## Write tolerance

All metadata writes (`series.json`, `catalog.json`) are best-effort: on failure, log at debug, keep the provider fully functional (NO read-only fallback, no snackbar), retry on the next natural trigger. A provider that rejects metadata writes but serves reads is a first-class configuration (bunko scoped users).

## Bunko contract (server updates required)

1. **Partitioning** (owed): `<Series>/series.json`, root `catalog.json`, root `series-metadata.json` are metadata files — never treated as user progress `.json`.
2. **Blocking**: permission-scoped users' write attempts on archives/covers/catalog.json are rejected.
3. **Intercepted PUT**: a scoped user's `series.json` PUT is accepted as an update REQUEST — bunko validates the facts fields only (ids/titles/synonyms/tag/unit + facts stamp; volume index and unknown keys ignored), merges newest-stamp-wins into its authoritative store scoped to that user's permissions, then regenerates `series.json` and `catalog.json`. The client needs no bunko-specific code path.
4. **Compilation**: bunko builds `series.json` (v2, compact) per series folder and root `catalog.json` from `.mokuro` data + accepted updates; regenerates on library change and on accepted updates; serves with accurate size/mtime.
5. **Covers**: bunko generates missing per-volume cover sidecars.

## Lifecycle & edge rules

- Materialized rows follow the metadata-only lifecycle exactly: forget path removes them; a series deleted from the cloud leaves them as history; stranded-row cleanup applies on refill.
- Materialization never overwrites an installed row and never downgrades counts on an existing metadata-only row that has newer local data (local wins — the index stays unauthoritative).
- `catalog_index` cleanup mirrors `series_index`: provider-bound, listing-gated, never against an empty/failed listing.
- Client catalog.json production and bunko production never race: bunko providers are read-only for that file by contract.

## Decisions (user, 2026-08-23)

1. Series open materializes metadata-only rows (placeholders become transient).
2. Bunko updates via intercepted `series.json` PUT — no dedicated endpoint.
3. `catalog.json` = name/mapping/search data only; volume metadata + thumbs in `series.json`; revisit if holes appear (e.g. force-pull on progress referencing an unknown series).
4. Covers come from existing per-volume sidecars, not from new fields in the metadata files.
