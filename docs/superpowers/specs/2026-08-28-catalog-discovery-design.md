# Catalog Discovery — sorting, ratings, tags, difficulty (design draft)

**Date:** 2026-08-28
**Status:** DRAFT — decisions 1–3 below await the user; the title-progression work
that preceded this is done and not part of this plan.
**Scope:** both catalogs — bunko's public catalog page and the reader's catalog view.

## What exists already

- Both catalogs sort A–Z by display title (progression-resolved). The reader
  additionally has `gallerySorting`: SMART (activity) / ASC / DESC.
- Data on hand today: per-volume `page_count` + `character_count` (in
  `series.json` and bunko's `series_entry_cache`); archive mtimes; AniList/MAL
  ids in `external_ids` for linked series; and — on bunko — the full mokuro
  text corpus, parsed by the compiler anyway.
- Not on hand: community ratings, tags/genres (must be fetched), kanji-level
  reference lists (must be bundled).

## Phase 1 — sorts from data we already have

Bunko toolbar gains a sort select; the reader's gallery sort gains the same
modes. No new data sources.

- **A–Z** — current behavior, stays the default.
- **Newest** — max archive mtime across a series' volumes. Bunko adds a
  `latest_volume_modified` field per series to `/catalog/api/library` (from
  the library index's stat data). Reader derives the same from local volumes
  - `series.json` entries (`mokuro_modified`/archive stamps).
- **Densest** — `sum(character_count) / sum(page_count)`. Bunko joins its
  `series_entry_cache` (same one-read join as titles); reader computes from
  the same fields it already holds.

## Phase 2 — AniList/MAL enrichment (ratings, tags, genres)

**Shared schema** (additive to `series.json` v2 / `catalog.json` / bunko's
`series_facts`):

```
community: {
  score: number,        // normalized 0–100 (AniList meanScore, MAL score*10)
  tags: string[],       // e.g. AniList tags above a relevance floor
  genres: string[],
  source: 'anilist' | 'mal',
  fetched_at: ISO-8601
}
```

**Fetcher (decision 1):** recommended — bunko fetches server-side for every
series with an `external_ids` link (AniList GraphQL, batched; Jikan for
MAL-only series), refreshed ~weekly, cached in `series_facts`. One fetch
serves every user, works for anonymous catalog browsers, and no client ever
talks to AniList. The reader receives it through `catalog.json`/`series.json`
like every other fact. A later reader-side fetch (for bunko-less users) can
write the same fields under the same facts clock.

**UI:** "Rating" sort in both catalogs; tag/genre filter chips (bunko
toolbar; reader catalog filter panel). AniList-primary for tags (richer,
relevance-scored), MAL fallback.

## Phase 3 — kanji difficulty

Bunko's compiler already parses every `.mokuro`; while there, build a
per-volume **kanji histogram** (cached in `series_entry_cache`, invalidated
by the existing size/mtime key). Aggregate per series and score against
**bundled JLPT N5–N1 kanji lists** (decision 2):

```
difficulty: {
  jlpt_estimate: 'N5'..'N1' | 'N1+',  // lowest level covering ~90% of kanji occurrences
  score: number,                       // 0–100, occurrence-weighted
  kanji_total: number,
  coverage: { n5: %, n4: %, n3: %, n2: %, n1: % }
}
```

Shipped in `catalog.json`; sortable and filterable in both catalogs.
**WaniKani** becomes a later, reader-side _personal_ overlay (user's WK API
token → "you know N% of this series' kanji") — per-user data, so it never
enters the shared files, and WK's level data stays behind the user's own key.

## Open decisions (batched)

1. **Who fetches ratings/tags** — bunko server-side (recommended) / reader /
   both.
2. **Difficulty basis** — bundled JLPT lists (recommended: no accounts, no
   licensing tangle) vs WaniKani levels (needs each user's token; proprietary
   mapping). WK as personal overlay later either way.
3. **Phasing** — Phase 1 can land immediately; 2 and 3 are independent of
   each other and can go in either order.
