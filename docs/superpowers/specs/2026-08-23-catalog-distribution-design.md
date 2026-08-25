# Catalog & Series Metadata Distribution — Design

Date: 2026-08-23. Builds on `2026-08-16-series-metadata-linking-design.md` (series.json v2) and the metadata-only volume state (`2026-08-22-metadata-only-volumes` plan). Decisions below were made by the user 2026-08-23.

## Goal

Fast, incremental catalog browsing on large/slow backends (bunko: 1k+ series) with a defined load schedule:

- **Catalog open** → install/update **series names** (mapping + search data) from a root `catalog.json`.
- **Series open** → install/update **volume metadata + thumbnails** from that series' `series.json` + cover sidecars, materialized as metadata-only volume rows.
- **Bunko compiles** both files server-side; **clients compile them for non-bunko backends**.
- Metadata writes are **best-effort**: failure never flips the provider to read-only and never surfaces error UI.

## Files

### `catalog.json` (root)

At the root of the library folder. Name-related data ONLY — everything needed to map and search, nothing more. No counts, no covers, no volume lists (those live in `series.json`; we may revisit if this produces holes — see Hole patching).

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

### `series.json` (v2 + `archive_size` + freshness stamps)

Facts + volume index. Volume entries MAY carry `archive_size` (bytes of the `.cbz`; optional, 2026-08-23): a fact of the archive like `spine_width`, compiled by bunko and recorded by clients wherever known (backup upload, cloud download, listing). Readers ignore it when absent. Covers stay OUT of it — the existing per-volume cover sidecars (`<Series>/<Volume>.webp|jpg` next to the `.cbz`) remain the universal cover source; bunko generates missing ones.

Volume entries MAY also carry freshness stamps (optional, 2026-08-24): `mokuro_size`/`mokuro_modified` (the `.mokuro`/`.mokuro.gz` sidecar's stat) and `cover_size`/`cover_modified` (the cover sidecar's stat) — integer bytes and integer epoch SECONDS (`int(st_mtime)`, truncated; never sub-second, since a generic WebDAV client only ever sees second-precision `Last-Modified` dates). Absent, not `null`, when the sidecar doesn't exist or its stat is unknown. Staleness rule: a client rebuilds/re-fetches the referenced sidecar when the stamped size differs from what it has, or the stamped `_modified` is strictly newer than what it stored; an older-or-equal `_modified` at an equal size is fresh, and an entry it already has with no stamp at all is treated as stale exactly once, self-healing to a real stamp on the next compare. The contract's §2 (`2026-08-23-catalog-distribution-bunko.md`) is the byte-exact definition, including bunko's key ordering.

## Producers

- **Bunko**: sole producer of its `catalog.json` and `series.json` files, compiled from `.mokuro` archives + accepted user updates (below). Client-side production is disabled when the provider is bunko-backed.
- **Clients** (Drive/MEGA/WebDAV/Local Folder): produce `catalog.json` the same way they produce `series.json` — debounced after fact edits and backup completion, union-by-key with the existing cloud file (newest facts stamp wins per series), pruned against the listing (folders gone from the cloud drop out), never written when the listing is unavailable/stale. `catalog.json` joins the root-config allowlist.

## Consumption schedule (client)

1. **Catalog open / provider connect**: fetch `catalog.json` when its size/mtime changed (same versioning discipline as `series_index`). Cache in a new Dexie table `catalog_index` (PK `series_key`, source stamp). Merge each entry's facts into `series_metadata` by facts stamp (the factless-file rules apply: a factless entry never creates a record and never unlinks). **REVISED 2026-08-23 (user, exercising the revision clause):** the catalog view does NOT mint cards from `catalog.json` — a stale file produces ghost cards for deleted folders, which are dead ends. The file's facts merge into `series_metadata` for SEARCH/mapping enrichment of series that exist locally or in the listing; no catalog-only cards.
2. **Series open**: refresh that ONE series' `series.json` (size/mtime gated, event-driven — not waiting for a full listing pass), then **materialize** each cloud-only volume entry as a metadata-only `volumes` row: real uuid, counts, `mokuro_version`, `spine_width`, `metadata_only: true`. Fetch its cover sidecar lazily (bounded concurrency) and store it in the row's inlined `thumbnail`. Materialized rows shadow placeholders permanently; the placeholder fallback remains for entries without an index (bare shares) — the enrichment ladder is unchanged, materialization just promotes rung 2 into rung 1.
3. **Richer placeholders** (2026-08-23): a placeholder with index data renders with the same treatment as a metadata-only volume (progress, estimates, cover, download badge, `archive_size`); the minimal card remains only for bare-share entries with no index. `VolumeMetadata.archive_size?` is populated from the listing/index/upload/download and shown beside the download affordance.
4. **Hole patching**: synced progress referencing a series (by `series_title`/`series_uuid` on the progress record) that has no local rows and no cached index forces a pull of that series' `series.json` + materialization, so stats views never dangle.

## Write tolerance

All metadata writes (`series.json`, `catalog.json`) are best-effort: on failure, log at debug, keep the provider fully functional (NO read-only fallback, no snackbar), retry on the next natural trigger. A provider that rejects metadata writes but serves reads is a first-class configuration (bunko scoped users).

## Bunko contract (server updates required)

1. **Partitioning** (owed): `<Series>/series.json`, root `catalog.json`, root `series-metadata.json` are metadata files — never treated as user progress `.json`.
2. **Blocking**: permission-scoped users' write attempts on archives/covers/catalog.json are rejected.
3. **Intercepted PUT**: an authorized user's `series.json` PUT is accepted as an update REQUEST. (2026-08-24 ruling on who is authorized: `registered` never; `uploader` only for a series it owns outright; any modify/delete-tier role for any series; anonymous is 401 — see bunko's auth task.) Bunko validates the facts fields only (ids/titles/synonyms/tag/unit + facts stamp; volume index and unknown keys ignored), merges newest-stamp-wins into its authoritative store once the actor is authorized, then regenerates `series.json` and `catalog.json`. The client needs no bunko-specific code path.
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

## Amendment 2026-08-23: `series-metadata.json` retired; field redistribution (user decisions)

`series-metadata.json` is REMOVED — never shipped, no legacy support. Writer, reader, merge machinery, and its root-allowlist entry go; a stale file in an existing cloud is inert junk. The local `series_metadata` table remains as local storage; only the root sync file dies. Fields redistribute by their true nature:

- **Facts** (`external_ids`, `titles`, `synonyms`, `tag`, `unit`) — transported ONLY by `<Series>/series.json` (+ `catalog.json` compilation). Facts stamps unchanged.
- **Spine offsets are FILE FACTS** (same archives ⇒ same cover geometry): `spine_offset` becomes a top-level optional in `series.json`, per-volume offsets ride volume entries — index rules like `archive_size` (installed-override/fill, never stamped as facts). Bunko contract: accepted index fields. Bunko users inherit the uploader's shelf alignment.
- **Series-level reading state** (`read_count`, `reread_prompt_suppressed`, `tracking{}`) — moves to a `series` section of `volume-data.json`, gaining its per-key newest-wins sync semantics. Never in shared files.
- **AniList-derived display data** (`format`, `status`, `total_volumes`, `total_chapters`, `cover_url`) — NOT STORED. Shown transiently in the link picker from search results only. The tracker's COMPLETED logic fetches totals in the same AniList request the push already makes (`fetchRemoteEntry` query gains `media { volumes chapters }`); `detectTrackingUnit`'s overshoot rule applies only when totals are present in that context (marker-based detection otherwise).
- **`title_preference`** — deleted (globally ignored legacy field). Profile-level preferences live in `profiles.json`, which is upgraded to the same automatic read/merge/push treatment `volume-data.json` has (it is currently neglected).
