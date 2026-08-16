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
   file, and embed-on-write.** Series facts are embedded in every `.mokuro` the app writes
   and read back on import. Linking never triggers a mass re-upload by itself.
3. **The folder name (`series_title`) is never derived from metadata.** Display name is an
   overlay: preferred-language title (or the imported title) plus an optional free-text
   **tag**. No "rename to canonical" shortcut; the existing manual rename is unchanged.
4. **Tag = a single free-text field per series**, appended to the display name. It is
   **exported in the `.mokuro`** (mokuro-bunko needs it) and synced. Variants of the same
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
  types.ts                 SeriesMetadata, EmbeddedSeriesMetadata, DisplayTitleLanguage
  series-key.ts            normalizeSeriesKey(title)  (= catalog's normalizeSeriesTitle, exported once)
  provider-interface.ts    MetadataProvider, MetadataSearchResult
  providers/anilist.ts     AniList GraphQL provider (search, getById, siteUrl) + rate guard
  link-targets.ts          pure URL builders: anilist(id), mal(id)
  display-title.ts         resolveDisplayTitle(seriesTitle, meta, globalPref)
  volume-number.ts         extractVolumeNumber(volumeTitle, unit)  (reuses series-extraction patterns)
  store.ts                 series_metadata table access + liveQuery stores + upsert/merge helpers
  merge.ts                 mergeSeriesMetadata(local, cloud) — pure, newest-wins per key
  embed.ts                 toEmbedded(meta) / fromEmbedded(json) — .mokuro round-trip
  anilist-auth.ts          token storage, authorize URL, hash-callback parsing, Viewer fetch
  progress-tracker.ts      onVolumeCompleted/onSeriesRestarted/syncNow + pending queue
  progress-plan.ts         planProgressPush(local, remote) — pure
  reread.ts                shouldOfferReread(...) — pure; restartSeries(...)
src/lib/components/Series/
  SeriesLinkModal.svelte   search + pick + paste-URL/ID (debounce/abort controller in metadata/link-search.ts)
  SeriesMetadataBar.svelte alt titles, link-out chips, Link/Unlink, tag, title-language select, sidecar refresh
  SeriesTrackingPanel.svelte  mounted by the bar: tracking toggle/unit/Sync now, Read N times, Restart series
src/lib/components/Reader/RereadPromptModal.svelte
src/lib/components/Settings/MetadataSettings.svelte      preferred title language; mounts AniListAccountSettings.svelte
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
  title_preference?: DisplayTitleLanguage; // per-series override of the global setting
  read_count: number; // ARCHIVED completed passes (bumped by a restart of a fully-read series); default 0
  // timesRead = read_count + (all volumes completed now ? 1 : 0)
  reread_prompt_suppressed?: boolean; // "Don't ask for this series"
  tracking?: {
    enabled: boolean;
    unit: 'volumes' | 'chapters';
    number_overrides?: Record<string, number>; // volume_uuid -> n
    last_pushed?: { n: number; status: string; at: string };
  };
  updated_at: string; // ISO — newest-wins merge key
  linked_at?: string;
}
```

Dexie: `db-v3.ts` gains `this.version(2).stores({ …existing…, series_metadata: 'series_key' })`
(additive; no data migration).

**Unlink** clears `external_ids/titles/synonyms/format/status/totals/cover_url/linked_at`
and bumps `updated_at`, so the unlink propagates through sync instead of the old link
resurrecting. `tag`, `title_preference`, `read_count`, `tracking` survive an unlink.

### `.mokuro` embed (read + write)

Embedded object — series **facts** plus the tag, no per-user preferences/tracking:

```json
"series_metadata": {
  "external_ids": { "anilist": 30013, "mal": 13 },
  "titles": { "native": "ONE PIECE", "romaji": "ONE PIECE", "english": "One Piece" },
  "synonyms": ["ワンピース"],
  "tag": "[color]",
  "updated_at": "2026-08-16T00:00:00.000Z"
}
```

- **Write.** One shared `buildMokuroMetadata(volume, pages, { seriesTitle?, volumeTitle?,
seriesMetadata? })` in `src/lib/util/mokuro-metadata.ts` replaces the four duplicated
  object literals (`compress-volume.ts` ×2, `volume-sidecars.ts`, `zip.ts`). It emits
  `series_metadata` when a record exists for the volume's key and (targeted improvement)
  emits `spine_width` consistently when defined. Upstream mokuro ignores unknown keys;
  mokuro-bunko will read `series_metadata.tag`.
- **Read.** `parseMokuroFile` extracts and validates `series_metadata` (`fromEmbedded`);
  after the volume commit, `upsertFromEmbedded(seriesKey, embedded)` writes it only if
  the incoming `updated_at` is newer than the local record's. Covers local import, cloud
  download, HTML deep-link import and OCR upgrade because they all go through the parser.
- **Cloud sidecars are not auto-rewritten** on link/tag edits (a 20-volume series would
  mean 20 uploads). Instead the series page has an explicit **"Update cloud sidecars"**
  action; after any link/tag/unlink change (while a cloud provider is connected) the bar
  shows an "out of date" hint next to it. It regenerates and overwrites each volume's
  `.mokuro` in place (new
  `refreshVolumeSidecar(seriesTitle, volumeTitle, volumeUuid)` on `unifiedCloudManager`,
  built from the regen+upload core of `renameVolumeFiles`; read-only providers throw and
  the UI disables the action). Backups, renames and exports pick the embed up
  automatically because they already regenerate.

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
- `resolveDisplayTitle(seriesTitle, meta, globalPref)`:
  `pref = meta?.title_preference ?? globalPref`; `imported` → `seriesTitle`; otherwise the
  requested language, falling back `english → romaji → native → seriesTitle` when missing;
  then `+ ' ' + meta.tag` if the tag is non-empty. Pure, unit-tested.
- Applied wherever a **series** title is displayed (Catalog card, SeriesView header,
  reader/volume headers found by grep). Grouping, routes, cloud paths keep `series_title`.
  Catalog sort uses the display title; catalog search matches `series_title`, all `titles`,
  `synonyms` and `tag`.
- The catalog derives display titles once per catalog recompute (a `Map<series_key,
SeriesMetadata>` from `liveQuery(db.series_metadata)`), never per card in `$derived`.

### UI

- **SeriesView → `SeriesMetadataBar`** under the title: alt-title subtitle (the two
  non-displayed languages), provider chips (AniList / MAL link-out), **Link… / Change /
  Unlink**, tag text field, per-series title-language select (`Default` + 4), tracking
  toggle + unit + **Sync now** + "last pushed vN · date", **Read N times** (`timesRead`) with +/-,
  **Restart series…** (confirm), **Update cloud sidecars**.
- **`SeriesLinkModal`**: query prefilled with `series_title`; results show cover, titles,
  format, year, volume/chapter counts; click → link. "Paste AniList URL or ID" fallback.
  Action buttons get `relative z-10` (night-mode rule).
- **Settings drawer → `MetadataSettings`** accordion: preferred title language; AniList
  account **Connect / Disconnect** (shows username); global "Push progress to AniList on
  completion" master switch (default on; per-series `tracking.enabled` still required).
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
unit) ?? (1-based index in `sortVolumes` order)`. `extractVolumeNumber` reuses
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
  _intents_ (`restart` | `sync`, one per series; a pending restart is replayed before a
  sync) and re-planned against the live remote entry when flushed — on load, `online`,
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
- Sidecar refresh: per-volume try/catch, summary snackbar "Updated 18/20 sidecars"; read-only
  provider disables the action with a tooltip.
- Embedded metadata malformed: parser drops it (logs once), volume import proceeds.
- Rename to a title whose key already has a record: newer `updated_at` wins, other discarded.

## Testing

Unit (Vitest): `toSeriesMetadata` mapping from a fixture GraphQL response;
`resolveDisplayTitle` (all prefs, fallbacks, tag); `extractVolumeNumber` (volumes and
chapters, JP/EN patterns, none → undefined); `mergeSeriesMetadata`; `toEmbedded/fromEmbedded`
round-trip through `buildMokuroMetadata` + `parseMokuroFile`; `planProgressPush` matrix
(first read, re-read, restart, no-op, repeat bump); `handleAniListCallback` hash parsing;
`restartSeries` + `totalStats` invariance; `shouldOfferReread`; rename key migration.
Component: `SeriesLinkModal` with a mocked provider. Manual/E2E: `verify` skill —
import a synthetic series, link, set tag, export and inspect the `.mokuro`; live AniList
push against a test account.

## Phasing

- **A. Link + embed + sync** — types, table, provider, link modal, link-out chips, tag
  field, `buildMokuroMetadata` + parser read-back, `series-metadata.json`, sidecar refresh.
- **B. Titles overlay** — setting + migration, `resolveDisplayTitle`, catalog/series/reader
  display, search/sort.
- **C. Tracking + re-reads** — auth, tracker, plan, queue, `archivedReads`, restart,
  reread prompt, settings UI.

Each phase is independently shippable.
