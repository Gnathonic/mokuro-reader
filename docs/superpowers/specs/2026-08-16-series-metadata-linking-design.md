# Series Metadata Linking (AniList) — Design

**Date:** 2026-08-16
**Branch:** `feat/series-metadata` (off `develop`)
**Status:** Approved design, pending implementation plan

## Problem

A series in the reader is nothing more than a folder name. There is no way to say
"this folder is _One Piece_ on AniList", to show its title in the language the user
prefers, to reach the series' AniList/MAL page, to tell two libraries of the same work
apart (`[color]` vs `[bw]` scans, different compression, upscaled…), or to record and
push read progress / re-reads to a tracker.

## Decisions (locked with the user)

1. **AniList is the primary provider, behind a small provider abstraction.** External
   IDs are stored as an extensible map (`{ anilist, mal }` today). MAL and Anime-Planet are
   link-out only (their APIs are not browser-callable / do not exist).
2. **Storage = new `series_metadata` Dexie table, a `series-metadata.json` cloud root
   file, and a per-series sidecar.** _Amended 2026-08-17:_ the sidecar is one
   `<Series Title>/series.json` (facts + a volume index), not a `series_metadata` embed in
   every `.mokuro`. Linking never triggers a mass re-upload by itself.
3. **The folder name (`series_title`) is never derived from metadata.** Display name is an
   overlay: preferred-language title (or the imported title) plus an optional free-text
   **tag**. No "rename to canonical" shortcut; the existing manual rename is unchanged.
4. **Tag = a single free-text field per series**, appended to the display name. It is
   **exported in `series.json`** (mokuro-bunko needs it; amended from the `.mokuro`) and synced. Variants of the same
   work (`[color]`, `[bw]`, `webp`…) are independent series with their own link, tag,
   tracking and read count — **no cross-linking**.
5. **Progress: one-way push, per-series opt-in**, on volume completion. Never decreases
   within a read; no pull.
6. **Re-reads: explicit "restart series"** that archives the previous read (stats kept)
   and resets progress; the reader **detects a likely re-read and offers the restart**.
   Read count is pushed to AniList as `repeat` with `REPEATING` status during a re-read.

## Verified external facts

- `https://graphql.anilist.co` answers browser `POST`s with `access-control-allow-origin: *`;
  public reads (search, `Media`) need no auth. Rate limit header `x-ratelimit-limit: 30`
  (per minute, degraded from 90); `Retry-After` on 429.
- Auth: OAuth2 implicit grant
  `https://anilist.co/api/v2/oauth/authorize?client_id=…&response_type=token` → redirect
  to the client's single registered redirect URL with
  `#access_token=…&token_type=Bearer&expires_in=31536000` (1 year). One AniList API client
  per deploy origin (like the Drive client IDs).
- `SaveMediaListEntry(mediaId, status, progress, progressVolumes, repeat)`;
  `MediaListStatus` includes `CURRENT | COMPLETED | REPEATING`; `Media.mediaListEntry`
  returns the viewer's entry when authenticated; `Viewer { id name }`.
- MAL API v2 answers preflight with 405 and no CORS headers.

## Architecture

### Unit map

```
src/lib/metadata/
  types.ts                 SeriesMetadata (facts_updated_at split), DisplayTitleLanguage
  series-key.ts            normalizeSeriesKey(title)  (= catalog's normalizeSeriesTitle, exported once)
  provider-interface.ts    MetadataProvider, MetadataSearchResult
  providers/anilist.ts     AniList GraphQL provider (search, getById, siteUrl) + rate guard
  link-targets.ts          pure URL builders: anilist(id), mal(id)
  display-title.ts         resolveDisplayTitle(seriesTitle, meta, globalPref)
  volume-number.ts         extractVolumeNumber(volumeTitle, unit) + detectTrackingUnit(titles, totals)
  tracking-unit.ts         resolveTrackingUnit(meta, volumes) → { unit, source } (amended)
  store.ts                 series_metadata table access + liveQuery stores + upsert/merge helpers
  merge.ts                 mergeSeriesMetadata(local, cloud) — pure, newest-wins per key
  series-file.ts           series.json v2 shape: buildSeriesFile / parseSeriesFile (amended; replaced embed.ts)
  series-index.ts          series_index cache table (Dexie v3) + indexNeedsRefresh
  series-file-sync.ts      debounced auto-write of series.json after local fact edits
  series-index-sync.ts     refresh changed series.json files after a cloud listing
  anilist-auth.ts          token storage, authorize URL, hash-callback parsing, Viewer fetch
  progress-tracker.ts      onVolumeCompleted/onSeriesRestarted/onReadCountChanged/syncNow/syncAllSeriesNow + pending queue
  progress-plan.ts         planProgressPush(local, remote) — pure
  reread.ts                shouldOfferReread(...) — pure; restartSeries(...)
src/lib/components/Series/
  SeriesLinkModal.svelte   search + pick + paste-URL/ID (debounce/abort controller in metadata/link-search.ts)
  SeriesMetadataBar.svelte read-only summary: alt titles, link-out chips, Read N times, tracking status; pencil opens SeriesEditorModal
  SeriesEditorModal.svelte rename + SeriesLinkControls/SeriesTitlesEditor/SeriesTrackingPanel; "Next unlinked series →"; opened by the pencil or hover + `e` on a catalog card
  SeriesLinkControls.svelte Link…/Change/Unlink, tag field (amended: no "Update cloud sidecars" button)
  SeriesTrackingPanel.svelte  unit override (Auto/Volumes/Chapters) + push status, Read N times, Restart series
src/lib/components/Reader/RereadPromptModal.svelte
src/lib/components/Settings/CatalogSettings.svelte        preferred series title language (global)
src/lib/components/Settings/MetadataSettings.svelte       "AniList" accordion: account Connect/Disconnect + push switch
```

### Series identity

Records are keyed by **`series_key = normalizeSeriesKey(series_title)`** — the same
`trim / collapse whitespace / lowercase` the catalog already groups by. `series_uuid` is
not used as a key (it is fragmented across placeholders/merges). Consequences:

- Cloud placeholders (not yet downloaded) resolve metadata too — folder name is the key.
- `executeRenameSeries` moves the record from the old key to the new key after a
  successful rename (if a record already exists at the new key, the newer `updated_at`
  wins). Orphaned records are harmless and are not garbage-collected.

### Data model

```ts
// src/lib/metadata/types.ts
export type DisplayTitleLanguage = 'imported' | 'native' | 'romaji' | 'english';

export interface SeriesMetadata {
  series_key: string; // PK
  series_title: string; // folder title as last seen (backfill/debug only)
  external_ids: { anilist?: number; mal?: number };
  titles: { native?: string; romaji?: string; english?: string };
  synonyms: string[];
  tag?: string; // free text, appended to display name; exported
  format?: string; // AniList MediaFormat (MANGA, ONE_SHOT, NOVEL…)
  status?: string; // RELEASING, FINISHED, …
  total_volumes?: number;
  total_chapters?: number;
  cover_url?: string; // link dialog only; not used for thumbnails
  unit?: 'volumes' | 'chapters'; // FACT: what the archives are; absent = auto-detect (amended 2026-08-18)
  title_preference?: DisplayTitleLanguage; // legacy per-series override; no longer consulted (kept for synced-data compat)
  read_count: number; // ARCHIVED completed passes (bumped by a restart of a fully-read series); default 0
  // timesRead = read_count + (all volumes completed now ? 1 : 0)
  reread_prompt_suppressed?: boolean; // "Don't ask for this series"
  tracking?: {
    // amended 2026-08-18: `enabled`/`unit` removed — pushing is one global
    // setting, the unit is the top-level fact above
    number_overrides?: Record<string, number>; // volume_uuid -> n
    last_pushed?: { n: number; status: string; at: string };
  };
  updated_at: string; // ISO — newest-wins merge key
  linked_at?: string;
}
```

Dexie: `db-v3.ts` gains `this.version(2).stores({ …existing…, series_metadata: 'series_key' })`
and (amended) `this.version(3).stores({ …, series_index: 'series_key' })` — both additive, no
data migration. `facts_updated_at` stamps the shareable facts separately from the record's own
`updated_at`, so per-user edits do not make a stale sidecar look newer.

**Unlink** clears `external_ids/titles/synonyms/format/status/totals/cover_url/linked_at`
and bumps `updated_at`, so the unlink propagates through sync instead of the old link
resurrecting. `tag`, `unit`, `title_preference`, `read_count`, `tracking` survive an
unlink — the unit describes the archives in the folder, not the link.

### Tracking unit and the push switch (amended 2026-08-18, user directive)

> "Move the 'Push progress to AniList' and 'Sync now' buttons to the global settings, and
> change the chapters/volumes setting to be auto-detected but user-correctable when needed
> and saved to series.json. Whether the format is chapters or volumes isn't a user
> preference, it's an objective fact about the items."

- **No per-series opt-in.** A push happens when the series is linked to AniList and
  `catalogSettings.pushProgressToAniList` is on. `tracking.enabled` is gone.
- **Unit = a fact, not a preference.** `detectTrackingUnit(titles, totals)`
  (`volume-number.ts`) reads it off the archive names: explicit 巻/`vol` markers vote
  volumes, 話/`ch` markers vote chapters, majority wins; with no votes, a bare number
  above `total_volumes` but inside `total_chapters` means chapters; otherwise volumes.
  `resolveTrackingUnit(meta, volumes)` (`tracking-unit.ts`) lets a stored `unit` win and
  reports `'set' | 'detected'`. Detection runs ONCE per pass (the unit is a parameter of
  `computeLocalPassState`/`volumeNumberFor`) and over the installed volumes **union the
  cached `series.json` index**, so the page and the push always agree. The series panel offers `Auto (detected) / Volumes /
Chapters`; a correction is a FACT edit (`facts_updated_at`, published in `series.json`).
- **Settings → AniList** owns the master switch and **Sync all linked series now**
  (`syncAllSeriesNow()`, sequential, 500 ms apart, tallied by outcome).
- **Re-reads push** (amended 2026-08-18): a restart already went through the tracker; the
  manual **Read N times** ± now pushes too, as the `read_count` event —
  `{ repeat: desiredRepeat }` in BOTH directions (a deliberate correction, unlike the
  forward-only completion/sync paths), queued under its own intent so a decrease is never
  downgraded to a sync.

### Series file (`series.json`)

**Amended 2026-08-17** — the original design embedded a `series_metadata` object in every
`.mokuro`. Replaced by one sidecar per series at `<Series Title>/series.json`
(`src/lib/metadata/series-file.ts`); `.mokuro` files are written in pure upstream format
again. The file carries the series **facts** plus an **index of the series' volumes**, so
another device can show stats for — and attach synced progress to — volumes it has not
installed, without downloading every `.mokuro`:

```json
{
  "version": 2,
  "series_title": "ONE PIECE [color]",
  "external_ids": { "anilist": 30013, "mal": 13 },
  "titles": { "native": "ONE PIECE", "romaji": "ONE PIECE", "english": "One Piece" },
  "synonyms": ["ワンピース"],
  "tag": "[color]",
  "unit": "volumes",
  "updated_at": "2026-08-16T00:00:00.000Z",
  "volumes": [
    {
      "volume_uuid": "…",
      "volume_title": "ONE PIECE v01",
      "page_count": 192,
      "character_count": 8123,
      "mokuro_version": "0.2.1",
      "spine_width": 24
    }
  ]
}
```

No per-page arrays: `page_char_counts` was dropped from the index (2026-08-18) — it made the file huge and nothing needs it (a not-installed volume's chars read come from the synced `VolumeData.chars`). Readers ignore it if present in older files.

- **Unauthoritative.** Local IndexedDB always wins for installed volumes; the index only
  fills gaps. `generatePlaceholders` adopts an entry's `volume_uuid` and counts for a
  cloud-only volume, else falls back to today's deterministic placeholder.
- **No per-user state**: never `tracking`, `read_count`, `title_preference`,
  `reread_prompt_suppressed`, thumbnails or page/OCR data.
- **Merge.** `updated_at` is the **facts** stamp only (`SeriesMetadata.facts_updated_at`,
  split from the record's own `updated_at`); `upsertFromSeriesFile` applies strictly newer
  facts. Volume entries merge by `volume_uuid` (local wins) with the existing cloud copy,
  then entries absent from the cloud listing are pruned (`buildSeriesFile`).
- **Write policy** (no UI button): debounced 2 s per series after a local fact edit
  (`series-file-sync.ts`), after a series' backup uploads finish, at the new title on
  rename (old file deleted), and deleted with the series folder. Gated on a writable
  connected provider and ≥1 backed-up volume; read-only providers skip, failures are
  logged only. Facts arriving _from_ a sidecar never schedule a write (no ping-pong).
- **Cache + refresh.** `series_index` (Dexie v3, PK `series_key`) stores the last fetched
  file with its cloud `size`/`modifiedTime`/provider. After every `fetchAllCloudVolumes`,
  `series-index-sync.ts` re-downloads only the files whose stamp differs
  (`indexNeedsRefresh`), max 4 concurrent, fire-and-forget, and drops orphaned keys.
- **Import/export.** A `series.json` in a selection or at the root of a series ZIP is
  applied after the volumes save (keyed to the final sanitized series title, index merged,
  `source.provider = 'import'`); series ZIP and single-volume ZIP/CBZ exports include one
  built from the local volumes.
- **mokuro-bunko dependency.** Bunko treats every `.json` as a progress file; it must
  partition by path (root `.json` = progress/profiles, `<Series>/series.json` = static
  sidecar) before this runs against a bunko-backed library.

### Cloud sync of the table

Root file `series-metadata.json` beside `volume-data.json`:

- `syncable-file.ts`: add to `ROOT_CONFIG_FILENAMES`.
- `unified-sync-service.ts`: `syncSeriesMetadata(provider)` mirroring `syncVolumeData` —
  download → `mergeSeriesMetadata(local, cloud)` (pure, per-key newest `updated_at` wins;
  unknown keys pass through) → `bulkPut` → upload if changed. Called wherever
  `syncVolumeData` is (all providers get it for free).
- File shape: `{ version: 1, series: Record<series_key, SeriesMetadata> }`.

### Provider abstraction + AniList

```ts
export interface MetadataSearchResult {
  provider: 'anilist';
  id: number;
  idMal?: number;
  titles: SeriesMetadata['titles'];
  synonyms: string[];
  format?: string;
  status?: string;
  year?: number;
  volumes?: number;
  chapters?: number;
  coverUrl?: string;
  siteUrl: string;
}
export interface MetadataProvider {
  id: 'anilist';
  search(query: string, signal?: AbortSignal): Promise<MetadataSearchResult[]>;
  getById(id: number): Promise<MetadataSearchResult | null>;
  siteUrl(id: number): string;
}
```

`providers/anilist.ts`: plain `fetch` POST to `https://graphql.anilist.co`.
Search query: `Page(perPage: 10) { media(search: $q, type: MANGA, sort: SEARCH_MATCH)
{ id idMal title { romaji english native } synonyms format status chapters volumes
startDate { year } coverImage { medium } siteUrl } }`. A module-level rate guard reads
`X-RateLimit-Remaining` / `Retry-After` and delays or rejects with `RATE_LIMITED`; the
modal debounces input by 300 ms and aborts stale requests. `toSeriesMetadata(result)`
is the pure mapper. `link-targets.ts` builds `https://anilist.co/manga/{id}` and
`https://myanimelist.net/manga/{idMal}`.

### Display title overlay

- New synced setting `catalogSettings.preferredTitleLanguage: DisplayTitleLanguage`
  (default `'imported'`), added to `defaultSettings` and `migrateProfiles`.
- `resolveDisplayTitle(seriesTitle, meta, globalPref)`: title language is global-only —
  `meta.title_preference` is never consulted (kept on the type/sanitizer for synced-data
  compat only). `imported` → `seriesTitle`; otherwise the requested language, falling
  back `english → romaji → native → seriesTitle` when missing; then
  `+ ' (' + tag + ')'` if the tag is non-empty, stripping one surrounding pair of
  `()`/`[]`/`（）`/`【】` from the raw tag first so `[color]`, `(color)` and `color` all
  render as `Title (color)`. The tag is appended only when the base actually resolved
  to an alt title (i.e. it differs from `seriesTitle`) — when the base IS the folder
  name (`imported`, or the alt-title fallback for a series with no alt titles), the tag
  is withheld, since folder names already carry the tag to prevent collisions. Pure,
  unit-tested.
- Applied wherever a **series** title is displayed (Catalog card, SeriesView header,
  reader/volume headers found by grep). Grouping, routes, cloud paths keep `series_title`.
  Catalog sort uses the display title; catalog search matches `series_title`, all `titles`,
  `synonyms` and `tag`.
- The catalog derives display titles once per catalog recompute (a `Map<series_key,
SeriesMetadata>` from `liveQuery(db.series_metadata)`), never per card in `$derived`.

### UI

- **SeriesView → `SeriesMetadataBar`** under the title: read-only summary — alt-title
  subtitle (the two non-displayed languages), provider chips (AniList / MAL link-out),
  **Read N times** (`timesRead`), one-line tracking status. A pencil opens
  **`SeriesEditorModal`** (also reachable via hover + `e` on a catalog card), which hosts
  every editing control: rename, **Link… / Change / Unlink**, tag text field, manual
  titles/synonyms, the **tracking unit** override + push status + "last pushed vN · date"
  (amended 2026-08-18: no per-series toggle, no per-series Sync now),
  **Read N times** +/-, **Restart series…** (confirm), and a
  "Next unlinked series →" button. Title language has no per-series control — it is the
  global Catalog setting below.
- **`SeriesLinkModal`**: query prefilled with `series_title`; results show cover, titles,
  format, year, volume/chapter counts; click → link. "Paste AniList URL or ID" fallback.
  Action buttons get `relative z-10` (night-mode rule).
- **Settings drawer → `CatalogSettings`** accordion: preferred series title language
  (global — native/romaji/english/imported; no per-series override).
- **Settings drawer → `MetadataSettings`** accordion (labeled "AniList"): account
  **Connect / Disconnect** (shows username); global "Push progress to AniList on
  completion" master switch (default on — amended 2026-08-18: it is the ONLY switch) and
  **Sync all linked series now**.
  Account section hidden when `VITE_ANILIST_CLIENT_ID` is unset.
- **`RereadPromptModal`** in the reader (see Re-reads).
- Out of scope: bulk "find matches for all unlinked series"; sibling/variant navigation;
  cover art from AniList as thumbnails.

### AniList auth

- Env `VITE_ANILIST_CLIENT_ID` (`.env.example`, README env table). Only progress push
  needs it; search/link work without it.
- Redirect flow (like OneDrive; no popup). `startAniListLogin()` saves the current hash to
  `sessionStorage['anilist_return']` and navigates to the authorize URL. `initRouter()`
  gains one check before parsing: if `location.hash` starts with `#access_token=`, hand it
  to `handleAniListCallback(hash)` (stores `anilist_token`, `anilist_token_expires_at`,
  fetches `Viewer` into `anilist_user`), restore the saved hash via `history.replaceState`,
  and continue normally. Disconnect clears the three `anilist_*` keys; cloud-provider logout
  (`provider-manager`) does not touch them.
- 401 from AniList → clear token, snackbar "AniList session expired — reconnect in
  Settings", pending pushes stay queued.

### Progress push

- **Trigger.** `updateProgress`/`markVolumeAsComplete` detect a `completed` false→true
  transition and call `progressTracker.onVolumeCompleted(volumeUuid)` (fire-and-forget,
  browser-only). `restartSeries` calls `onSeriesRestarted(seriesKey)`.
- **Volume number.** `n = tracking.number_overrides[uuid] ?? extractVolumeNumber(volume_title,
resolveTrackingUnit(meta, volumes).unit) ?? (1-based index in `sortVolumes` order)`. `extractVolumeNumber` reuses
  `series-extraction`'s `VOLUME_PATTERNS`/`BARE_VOLUME_PATTERNS` and adds `第N話` / `ch.N`
  / `chapter N` for the chapter unit.
- **Local pass state** for a series: `passProgress = max n over volumes with completed
=== true` (completed flags are per pass — restart resets them), `allCompleted = every
local volume completed`, `passComplete = total known && passProgress >= total`,
  `timesRead = read_count + (allCompleted ? 1 : 0)`, `rereading = read_count >= 1 &&
!allCompleted`.
- **Remote state**: `Media(id) { mediaListEntry { status progress progressVolumes repeat } }`.
- **`planProgressPush(local, remote, unit) → SaveMediaListEntry vars | null`** (pure):
  - restart event → `{ status: REPEATING, [progressField]: 0 }` (the one explicit decrease);
  - else `[progressField] = local.passProgress` only if it exceeds remote's, with
    `status = passComplete ? COMPLETED : (local.rereading ? REPEATING : CURRENT)`;
    also emits `status` alone when the desired status is an upgrade of the remote one
    (COMPLETED when the pass is complete; REPEATING when re-reading);
  - `repeat = max(remote.repeat, local.timesRead - 1)` whenever it would increase;
  - `null` when nothing would change.
- **Sync now** = same plan against the current local state.
- **Queue.** Failed/offline pushes are stored in localStorage `anilist_pending_pushes` as
  _intents_ (`restart` | `read_count` | `sync`, one per series; a pending restart or
  read-count correction is replayed before the follow-up sync, and a restart carries
  `alsoReadCount` when a correction is waiting behind it) and re-planned against the live remote entry when flushed — on load, `online`,
  and successful login. 429 honors `Retry-After`.

### Re-reads

- **`VolumeData.archivedReads?: { at: number; pages: number; chars: number; completed: boolean }[]`**
  — appended by a restart; `toJSON` omits it when empty. Existing sync merge (newest
  wins per volume) needs no change.
- **`restartSeries(seriesKey)`**: for every volume of the series with `progress > 0`
  push `{ now, progress, chars, completed }` to `archivedReads`, then set `progress = 0,
chars = 0, completed = false` and `lastProgressUpdate = now`. `recentPageTurns`,
  `sessions`, `timeReadInMinutes` are untouched. If every volume was completed before the
  reset, `read_count += 1` on the series record (so `timesRead` is unchanged by the
  restart itself and grows again when the new pass completes). Clears
  `reread_prompt_suppressed`. Then `onSeriesRestarted`.
- **`totalStats`** adds `Σ archivedReads.chars` / `.pages` to `charsRead` / `pagesRead`
  so lifetime totals never drop after a restart. (Note for the heatmap branch on merge:
  `archivedReads[].at` marks pass boundaries; its per-volume `credited` set should reset
  at each boundary so re-read days credit chars.)
- **Detection** — `shouldOfferReread(volume, seriesVolumes, volumesStore, meta, session)`:
  true when the opened volume is the **first** in `sortVolumes` order, **every** volume in
  the series is `completed`, `meta.reread_prompt_suppressed !== true`, and
  `sessionStorage['reread_dismissed:' + seriesKey]` is unset. Reader shows
  `RereadPromptModal` on mount: **Restart series** (runs `restartSeries`, reader shows
  page 1) / **Not now** (sessionStorage) / **Don't ask for this series** (sets
  `reread_prompt_suppressed`; cleared only by a restart). Opening a non-first volume never
  prompts.
- **Read N times** on the series page shows `timesRead`; +/- edit `read_count` directly
  (covers cross-variant re-reads by hand). Worked example: finish once → `read_count 0`,
  timesRead 1, AniList COMPLETED/repeat 0; restart → `read_count 1`, timesRead 1,
  REPEATING/progress 0; finish again → timesRead 2, COMPLETED/repeat 1.

## Error handling

- AniList unreachable / rate-limited: modal shows inline error with retry; pushes queue.
- `series.json` write (amended): automatic and silent — try/catch per series, logged, never
  surfaced in a reading flow; read-only or disconnected provider skips; the next edit or
  backup rewrites the file.
- `series.json` malformed (import or refresh): `parseSeriesFile` returns `undefined`, one
  `console.warn`, the volume import / listing proceeds.
- Rename to a title whose key already has a record: newer `updated_at` wins, other discarded.

## Testing

Unit (Vitest): `toSeriesMetadata` mapping from a fixture GraphQL response;
`resolveDisplayTitle` (all prefs, fallbacks, tag); `extractVolumeNumber` (volumes and
chapters, JP/EN patterns, none → undefined); `mergeSeriesMetadata`; `buildSeriesFile` /
`parseSeriesFile` round-trip (union, prune, sort) and `indexNeedsRefresh`; `planProgressPush` matrix
(first read, re-read, restart, no-op, repeat bump); `handleAniListCallback` hash parsing;
`restartSeries` + `totalStats` invariance; `shouldOfferReread`; rename key migration.
Component: `SeriesLinkModal` with a mocked provider. Manual/E2E: `verify` skill —
import a synthetic series, link, set tag, export and inspect the `.mokuro`; live AniList
push against a test account.

## Phasing

- **A. Link + `series.json` + sync** — types, tables, provider, link modal, link-out chips,
  tag field, `series.json` write/refresh/import/export, `series-metadata.json`.
- **B. Titles overlay** — setting + migration, `resolveDisplayTitle`, catalog/series/reader
  display, search/sort.
- **C. Tracking + re-reads** — auth, tracker, plan, queue, `archivedReads`, restart,
  reread prompt, settings UI.

Each phase is independently shippable.
