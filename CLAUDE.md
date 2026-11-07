# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## NEVER NAME A DEPLOYMENT. EVER.

**This is the one rule with no exceptions and no judgement calls. No deployment
is ever named in this repository.** That means:

- nobody's public instance, and no community or third-party server;
- none of the maintainer's own servers, NAS boxes or containers;
- no test, staging or rehearsal host.

Never write a real instance's domain, hostname, URL, IP address (public or
LAN), machine name, container name, port mapping or admin path. Nowhere means
nowhere:

- code, comments, tests and fixtures;
- docs, plans, specs, the README and this file;
- the CHANGELOG, commit messages and branch names;
- PR titles and bodies, issue comments and release notes.

Use reserved names instead: `example.com`, `example.net`, `*.test`,
`localhost`.

- A user's bug report may quote their server. Leave it in their text, and never
  repeat it in ours.
- Before every commit and every push, check the diff, the commit messages and
  the PR body for hostnames and IP addresses.
- If a deployment's name turns up anywhere in the tree, removing it is the first
  job, before anything else.
- This rule itself names none. Keep it that way: never add a "for example" here.

The only real addresses the repo carries are the app's own origins, which the
code needs (`src/lib/consts/index.ts` switches on them), plus `localhost` and
reserved example names.

## Project Overview

Mokuro Reader is a web-based manga reader for [mokuro](https://github.com/kha-white/mokuro)-processed manga. It's a SvelteKit 5 application with offline support, stat tracking, and Google Drive sync capabilities.

## Development Commands

### Essential Commands

- `npm run dev` - Start development server (localhost only; `npm run dev -- --host` to reach it from the LAN)
- `npm run build` - Build for production (`@sveltejs/adapter-vercel`, lockfile-pinned, runtime `nodejs24.x`);
  fails when `scripts/check-no-test-hooks.mjs` finds a cloud test hook in the output
- `npm run preview` - Preview production build (localhost only; `npm run preview -- --host` to test it from a phone or another LAN device)
- `npm test` - Run tests with Vitest
- `npm run test:coverage` - Run tests with coverage
- `npm run test:e2e` - Run Playwright e2e tests (see Testing for port caveats)
- `npm run check` - Type-check with svelte-check
- `npm run check:watch` - Type-check in watch mode
- `npm run lint` - Lint code (Prettier + ESLint)
- `npm run format` - Format code with Prettier

## Architecture

### Core Data Flow

1. **Import/Upload**: Users upload ZIP/CBZ files containing manga images and a `.mokuro` JSON file
2. **Storage**: Data is stored in IndexedDB via Dexie:
   - `volumes` table: Metadata (title, UUID, page count, character count, thumbnail)
   - `volumes_data` table: Full page data and image files (File objects stored directly)
3. **Catalog**: Browseable library of all imported volumes
4. **Reader**: Renders manga pages with OCR text overlays and stat tracking
5. **Sync**: Google Drive integration for syncing read progress and profiles across devices

### Key Technologies

- **SvelteKit 5**: Framework (uses new Svelte 5 runes: `$state`, `$derived`, `$effect`)
- **Dexie**: IndexedDB wrapper for storing volumes and files
- **@zip.js/zip.js**: ZIP file extraction
- **Zoom architecture**: Shared ZoomController + measurement-based correction drives zoom in all reader modes (`src/lib/reader/zoom-*.ts`, `paged-*.ts`)
- **Flowbite Svelte**: UI component library
- **Tailwind CSS**: Styling
- **Vitest**: Testing framework

### Directory Structure

```
src/
├── lib/
│   ├── anki-connect/    # Anki integration for vocabulary mining
│   ├── assets/          # Static assets (icons, etc.)
│   ├── catalog/         # Volume library management (Dexie DB, thumbnails)
│   ├── components/      # Svelte components
│   ├── consts/          # Application constants
│   ├── import/          # File import pipeline and processing
│   ├── reader/          # Core reader logic
│   ├── settings/        # Settings stores and profiles
│   ├── styles/          # Shared CSS styles
│   ├── types/           # TypeScript type definitions
│   ├── upload/          # Legacy upload utilities
│   ├── util/            # Utilities
│   │   └── sync/        # Multi-provider cloud sync
│   │       └── providers/
│   │           ├── filesystem/
│   │           ├── google-drive/
│   │           ├── mega/
│   │           ├── onedrive/
│   │           └── webdav/
│   ├── views/           # Top-level view components
│   └── workers/         # Web Workers for background tasks
├── routes/
│   ├── +page.svelte           # Root page (hash router entry)
│   └── [...catchall]/         # SPA catchall for hash routing
└── app.d.ts                   # App-level type definitions
```

**Routing:** The app uses a hash-based router (`$lib/util/hash-router.ts`) with views loaded dynamically from `$lib/views/`. Routes like `#/series/uuid` or `#/reader/uuid` are handled client-side.

### State Management

- **Svelte Stores**: Primary state management (writable, derived, readable stores)
- **LocalStorage Sync**: Many stores use `syncStore` utility to persist to localStorage
- **Key Stores**:
  - `volumes` (settings/volume-data.ts): Read progress tracking per volume
  - `currentSettings` (settings/settings.ts): Reader settings per volume
  - `profiles` (settings/settings.ts): User profiles with different settings
  - `miscSettings` (settings/misc.ts): Global app settings

### Cloud Sync System

Located in `src/lib/util/sync/`, the app supports multiple cloud storage providers:

| Provider     | Auth Method                                                        | Status                |
| ------------ | ------------------------------------------------------------------ | --------------------- |
| Google Drive | OAuth2 implicit flow, or auth code + PKCE through the auth backend | Full support          |
| MEGA         | Email/password (+ optional 2FA)                                    | Full support          |
| WebDAV       | URL + credentials                                                  | Full support          |
| OneDrive     | MSAL (OAuth2 auth code + PKCE)                                     | Full support          |
| Local Folder | Directory picker (no account)                                      | Desktop Chromium only |

**Architecture:**

- **provider-interface.ts**: Common `SyncProvider` interface all providers implement
- **provider-manager.ts**: Manages provider instances and state
- **unified-sync-service.ts**: Provider-agnostic sync logic
- **providers/**: Provider-specific implementations

**Google Drive specifics** (`providers/google-drive/`):

- Uses OAuth2 implicit flow (access tokens only, ~1 hour expiry) — unless the build sets
  `VITE_GDRIVE_AUTH_BACKEND=true`: then ONE sign-in (PKCE, full-page redirect to the static
  `static/oauth/google-callback.html`) and silent renewals through
  `src/routes/api/gdrive/{session,refresh,logout}` (server logic in `src/lib/server/gdrive-auth/`;
  the refresh token lives sealed in an HttpOnly cookie, optionally bound to a device key). Read
  tokens through `tokenManager.getAccessToken(minValidityMs)`, never the store or localStorage;
  only `tokenManager.reconnect()` (a user's click) may start a sign-in; `getTimeUntilExpiry()`
  is null while the session can renew. A flag-set build whose server cannot serve the routes
  falls back to the implicit flow for that tab. Full design, env vars, error vocabulary and
  runbook: `docs/gdrive-auth-backend.md`.
- Sign-out is THIS DEVICE ONLY by default (Log out, provider switch, `providerManager.logout()`):
  no Google revoke, because Google revokes per Cloud project and would sign out every other
  device and any mokuro-bunko server sharing the grant. Backend mode clears the cookie and
  deletes the device key (a bound cookie's copy can no longer refresh). Only the confirmed
  "Sign out everywhere…" passes `logout({ everywhere: true })` and revokes; a provider switch
  never does. A device sign-out that cannot neutralise copies (unbound session, `GDRIVE_POP=off`)
  answers `invalidated: false`, and the cloud page's snackbar says a copy could still work.
- `escapeNameForDriveQuery()` must be used for file/folder names in API queries
- Broad queries + client-side filtering is the correct pattern (Google scopes by app permissions)
- Every Drive HTTP failure is classified by `core/providers/drive-http.ts` from the body's
  `error.errors[0].reason` — by NAME, never by domain (`sharingRateLimitExceeded` and the
  item-count/depth limits are domain `global`, not `usageLimits`; `DriveHttpError.domain` and
  `DriveFailure.domain` are kept for logs only). A 403 is a full account
  (`storageQuotaExceeded`, Drive's only storage-full reason, never retried), a rate limit
  (`userRateLimitExceeded`/`rateLimitExceeded`/`dailyLimitExceeded`/`sharingRateLimitExceeded`,
  and `quotaExceeded` — an API usage quota that resets, NOT storage — like any 429 whatever
  its reason), a `limit` nothing lifts (`activeItemCreationLimitExceeded`,
  `numChildrenInNonRootLimitExceeded`, `myDriveHierarchyDepthLimitExceeded`: fails at once
  with its message, no retry, no re-auth), or an auth failure that may re-authenticate — an
  ALLOW-list: no reason, `authError`, `insufficientPermissions`, `forbidden`; any other named
  403 reason is a refusal that fails without touching the token. `withDriveRetry` retries ONE
  request at a time (each gapi call, so a paged listing resumes at its page and never
  re-fetches the pages already in hand; each XHR/fetch) on the policy every cloud core shares
  (`core/http-retry.ts`: 5 tries, Retry-After capped 32 s, else backoff with jitter; a zero
  or already-past Retry-After is no advice and backs off too, for OneDrive as for Drive). Its
  `onWait` feeds the upload's `onRetry`, so the tray says "retrying" instead of sitting at
  0 %. 5xx are retried too, except on a request that CREATES a file or folder
  (`rateLimitOnly`): Drive can answer a 5xx after committing it, and a retry would make a
  duplicate. A resumable upload keeps ONE session (`google-drive-core.ts`): a retry after a
  rate-limited PUT asks the session where it stands (an empty PUT,
  `Content-Range: bytes */<size>`) and sends only the bytes it lacks — nothing when it
  answers 200/201, a fresh session only on 404/410; a 5xx on the PUT itself is still not retried (the error's
  `phase` says which step answered). A full account is thrown as the storage-full
  `QUOTA_EXCEEDED` ProviderError where the answer is read (`driveRefusal`), so a worker's
  message-only error already says it plainly; the provider passes it through. The worker
  also posts `kind: 'quota'` on its error message, which `backup-queue.ts` turns into the
  provider's "storage is full" wording (`core/storage-full.ts`; without a kind it reads the
  message: that wording, or a bracketed `[storageQuotaExceeded]` no 429 carried). Other
  messages still carry `[reason]`. OneDrive's equivalent is
  `providers/onedrive/graph-errors.ts`: 507 / a refusal naming `insufficientStorage` /
  `quotaLimitReached` → `oneDriveStorageFullError()`, excluded from the ≥ 500 retry.
- A 401 re-authenticates only when it refused the token held NOW: `handleAuthError` gets the
  token the request carried, and a refusal of one a re-auth has since replaced asks for no
  re-auth (a second sign-in popup for nothing, or a cleared token that works); the call is
  sent ONCE more with the held token instead (`retryStaleTokenRefusal` — a 401 created
  nothing, so even a create is safe). Every attempt, `withDriveRetry`'s included, reads the
  token when it goes out: a re-auth can land during a backoff.
- **An upload never re-lists the account** (#288). `uploadFile` is the upload plus its
  RECEIPT (id, `size`, `modifiedTime`, `version` as `revision`, `parentId`, `name`), and
  every caller records its own write in the cache from that receipt (`uploadCacheEntry`);
  there is no separate `blindUploadFile` — this one already is. It used to end with a
  whole-account `files.list` walk (13+ pages at ~12,500 files) per root-file write, and
  nothing may depend on an upload refreshing the listing again.
- **Other devices' writes arrive through the change feed**
  (`DriveFilesCacheManager.refreshFromChanges`, `drive-files-cache.ts`):
  `changes.getStartPageToken` is taken BEFORE each full walk, the folder map
  (`id → {name, parent}`) stays on the instance, and `changes.list` is applied with the full
  listing's placement rule (`placeFile`: series files, root config under the reader folder,
  history paths) — folder renames re-path their children, a removed folder takes the files
  whose parent is in the removed set closed AFTER the batch's own moves (a dedup that moves
  series out of a duplicate root and deletes it keeps them), unknown parents cost one
  `files.get`, not-owned and trashed files leave, a receipt newer than the feed is kept, our
  own write's echo changes nothing (same map identity → `'unchanged'`, no re-emit), and a
  same-name folder collision starts the dedup. No position (never listed / account switch /
  refused token), a failed feed read, more than `MAX_CHANGE_PAGES` (13) pages, a removed
  reader folder, or a full listing over `CHANGE_FEED_MAX_AGE_MS` (24 h) → `'reset'`: a full
  fetch. Only a 401 from `changes.*` is auth: rethrown, never followed by a full fetch
  (that would start the re-auth twice). Any other HTTP status — a 403 the general rule
  would call auth, a 5xx or rate limit past its retries — is "feed unavailable"
  (`feedUnavailable`, `handleFeedFailure` in `api-client.ts`): no re-auth, a full fetch, and
  no feed request (no position either) until the next login / cache clear; a 400 on
  `changes.list` is a refused POSITION only (the full fetch takes a fresh one). The feed
  never toggles `fetching`/`loaded`. It runs at the top of
  `runProviderSync` (Drive only, before volume data), and metadata writers'
  `ensureFreshCloudListing` takes it via `fetchAllCloudVolumes({ fromChangeFeed: true })`
  once the cache is loaded; the backup run's single post-run listing stays. Unverified
  without a real account: whether `drive.file` scope shows another device's writes and
  folder moves in the feed — the full-fetch fallback covers any feed failure.

**Provider status is published, never polled.** The navbar's reconnect banner, the cloud
screen and every read-only gate read `providerManager.status`, which moves only when
something calls `providerManager.updateStatus()`. A provider that changes its own
`needsAttention`/`isReadOnly`/session state must publish it (WebDAV's
`notifyStatusChanged`, OneDrive's `setNeedsAttention`, MEGA's `markSessionExpired`); the
interop rig's `providerStatus()` reads the store as published, so a flag kept to itself
fails the rig as the user would miss it.

**mokuro-bunko specifics** (the WebDAV provider against a bunko server):

- **Write access.** `/login/api/me` decides who may write; any answer from it
  (anonymous and rate limited included) settles it. Only when it gives none
  does `checkWritePermissions` guess, and a server known to be bunko —
  `PUT_VERIFIED` recorded for the base URL, or an OPTIONS answering
  `X-Mokuro-Put: verified` — skips even that: bunko decides each request
  itself and its `Allow` is advisory. A generic server's guess reads the
  library folder as a collection: DAV:write/write-content/all/bind/unbind in
  its privilege set (whole names: write-properties and write-acl upload
  nothing), else any of `COLLECTION_WRITE_METHODS` (PUT, MKCOL, DELETE, MOVE)
  in its `Allow` — a collection never lists PUT and lists MKCOL only while
  unmapped (RFC 4918), and PROPPATCH changes only properties, so it does not
  count. A real refusal still demotes through `handleWriteFailure`.
- **Case-variant series merge.** bunko folds `one piece/` into `One Piece/`. On
  a `serverCompilesMetadata` provider every listing runs
  `adoptCloudSeriesSpellings` (`util/sync/cloud-spelling-adoption.ts`): a local
  series title with NO folder of its own, EXACTLY ONE folder folding onto it
  (`normalizeVolumeTitleKey`), and at least one of its volumes listed there as a
  `.cbz` takes the folder's spelling as a LOCAL-ONLY rename
  (`commitLocalSeriesRename`, the local half of `executeRenameSeries`: rows,
  stats, `series_metadata`, series reading state). The write-side listing
  passes (`reconcileMissingMetadataFiles`, the sidecar backfill, layer sync)
  wait for it in `refreshSeriesIndexesInBackground`; the index/catalog refreshes
  do not. Backup enqueue (`resolveCloudFolderTitle`) and
  `existsInCloud`/`getCloudFile` (exact path, then the same folder-and-file
  picks as `getManagedCloudFilesForVolume`) resolve the cloud's spelling, so
  nothing uploads into the losing folder. `getCloudFile`/`existsInCloud` is
  THE "is it backed up" selector — the series page's status and "back up
  series", `BackupButton`, `VolumeItem` and the cloud screen all ask it; a
  byte-exact path test beside it reads an uploaded volume as missing and
  re-PUTs it on every click. Those backstops are NOT gated on bunko: like
  every other folder lookup (rename, delete, `series.json`) they run on every
  provider, so on plain storage too a title with no exact folder backs up into
  and counts as backed up in the ONE folder folding onto it, naturally first
  when several do. An exact folder always wins, and plain storage never
  ADOPTS: its rows keep their spelling. A DELETE is narrower
  (`cloudFolderOfSeries`, `catalog/series-delete.ts`): the removal dialog's
  "also delete" and `deleteSeriesFromCloudByTitle` take a folded folder only
  when the catalog would group it with the series (`normalizeSeriesKey` — a
  title differing only in unicode form folds alike but is ANOTHER catalog
  series) and it lists one of the series' own volumes. Adoption itself skips
  a series with a volume open in the reader (`isVolumeOpen`, `hash-router.ts`,
  the OCR upgrade's deferral) — the row write would reload the open volume —
  and the next listing retries. The folded lookups read `listingFolderIndex`,
  built once per cache revision (`CoalescedCacheStore.revision`, replaced by
  every add/remove/install) and holding the archive records themselves, so a
  per-volume caller — hit or miss — costs O(1), not a pass over the listing.

**Duplicate folders** (`folder-deduplicator.ts`, Drive and MEGA):

- **Write root.** Of several `mokuro-reader` folders, one directly in My Drive /
  the Cloud Drive first, then the oldest, then the smaller id (code-unit
  compare) — `pickReaderFolder` (`drive-files-cache.ts`), `findMokuroFolder`
  (MEGA). Every root is read; only same-parent roots merge, so a nested
  `Backup/mokuro-reader` is never merged into the top-level one. Drive learns
  which roots are top-level from a `'root' in parents` query, never
  `files.get('root')` (a 404 under the app's `drive.file` scope); dedup
  confirms a root as the write root only when it is the cache's same pick.
  Bunko's control files are read from EVERY live root too, nested ones
  included (Drive: the cache's listed reader folders,
  `getListedReaderFolderIds`, else one folder query with no parent clause;
  MEGA: any parent named `mokuro-reader`) — a nested write root holds the
  marker when there is no top-level one.
- **Groups** are an exact name under one parent, within the library only
  (`listFolders` keeps `mokuro-reader` folders and their descendants). The
  kept folder is the oldest, then the smaller id (`compareByAge`).
- **Same name on merge.** Folders, or a file beside a folder, move in and keep
  the name twice; so do `dedupKeepsEveryCopy` files (volume-data.json,
  goals.json, positions.json, and bunko's control files `.mokuro-bunko.json` /
  `.mokuro-queue.json`, exact names). Any other file: the strictly newer write
  wins, a tie keeps the canonical copy, the loser goes to the TRASH.
- **Folder removal.** `deleteFolder` asks the server whether the duplicate
  still holds anything (Drive: a one-child query, not a listing) and removes
  it (Drive: to the trash) only when empty, resolving whether it did so the
  count is of real removals; a folder still holding anything is kept for the
  next pass, and a second refusal throws, which gives up on that GROUP for
  the rest of the run while the other groups still merge.
  "Empty" on Drive means empty AS THE APP SEES IT: under `drive.file` the
  re-list misses files the app did not create (dropped in through the Drive
  web UI, written by another client), and those go to Drive's trash with the
  folder, where Drive keeps them for 30 days. Recoverable from the trash, but
  not a "never deletes files" promise. Bunko's merge (below) has the same
  blind spot and does the same; both sides document it (owner decision, 0.8).
- **Bunko merges, the reader steps aside.** Before each pass
  (`runDeduplication`, `mega-cache.ts` / `drive-files-cache.ts`) the cache
  re-reads the marker (`refreshCloudBunkoMarker`) and skips the pass while
  `cloudBunkoMergesDuplicates` — a fresh lease holder with `dedup: true`
  merges with the same rules, and two mergers would only race each other's
  moves. A stale or released holder hands the job back on the next fetch.
  Drive pins its write root for the session and only its OWN merge
  re-points it (`onRootFolderConfirmed`), so every listing also re-points a
  pinned root at the cache's pick (`adoptListedReaderFolder`): a root that
  Bunko or another device merged away and trashed is not written to again.

### Svelte 5 Reactive Performance

- `$derived` and `$derived.by()` run for EVERY component instance
- If a component appears N times, derived operations run N times
- Expensive operations or logging in derived causes severe performance issues
- Remove debug logging once the issue being debugged is resolved
- Continuous mode keeps a sized wrapper for every page but mounts a page's
  image and text boxes only near the viewport (`reader/page-window.ts`, 2
  viewports, 100 ms dwell so an animated jump mounts nothing in between).
  Mounting every page's text made open / layer swap / rotate one forced
  layout over the whole volume (7–9 s on a 236-page manga).
- Never read `document.fonts.ready` per element — the getter forces a layout;
  use `fontsReady()` (`reader/fonts-ready.ts`, once per frame).
- Noto Sans JP is registered through the FontFace API (`util/web-fonts.ts`),
  not a `<link>`: as a stylesheet, Chrome re-decoded its subsets on every
  media-query flip (each rotation / breakpoint). Faces arrive after an async
  fetch, so text may first lay out in the fallback — `fontLoadEpoch`
  (`loadingdone`) re-lays text boxes out and resets the canvas measurer memo.
- The open volume's data reloads only when its `volumes` row CONTENT changes
  (`volumeRowSignature`): the store re-emits identical rows on any write and on
  every catalog→reader resubscribe, and each reload swapped every page image.

### Worker Pool Pattern

The application uses Web Workers for parallel cloud downloads:

- **worker-pool.ts**: Manages multiple worker instances with memory limits
- **download-worker.ts**: Handles individual file downloads and ZIP extraction
- Memory management prevents overwhelming the browser during large batch downloads
- Configurable concurrency and throttling for low-memory devices

### Database Schema (V3)

The application uses a V3 database (`mokuro_v3`) with Dexie, declared once as
data in `db-schema.ts` (`MOKURO_DB_SCHEMA`) and applied identically by every
connection (main thread `db-v3.ts`, the export Worker, test fixtures) — see
that file for why a hand-written second `.version(n).stores({...})` ladder is
a data-loss hazard. It is currently at Dexie schema **version 4**: version 1
is the shipped three-table schema; version 2 added `series_metadata`,
`series_index`, `catalog_index` and `cloud_covers` in one step (collapsed from
several dev-only versions that no released build ever wrote); version 3 added
`volume_ocr_layers` and the `ocr_edited_at` index on `volumes` for the OCR
editor; version 4 added `volume_ocr_layer_pages` and is the ladder's only DATA
migration — its `upgrade()` (declared in `MOKURO_DB_SCHEMA` beside the stores,
so the Worker carries it too) moves `pages` out of every existing
`volume_ocr_layers` row, one row at a time. Versions 1–3 are additive. A schema
change to a version that real databases already sit at is a NEW version, never
an in-place edit. Volume data is split across three tables for performance,
alongside the two layer tables and per-series metadata, index and cover-cache
tables:

| Table                    | Primary Key              | Indexed Fields                                 | Purpose                                                                                                                            |
| ------------------------ | ------------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `volumes`                | `volume_uuid`            | `series_uuid`, `series_title`, `ocr_edited_at` | Metadata, thumbnails. `ocr_edited_at` is sparse — only rows with a local OCR edit carry it — so edited rows can be found keys-only |
| `volume_ocr`             | `volume_uuid`            | —                                              | Primary OCR page data (text blocks)                                                                                                |
| `volume_files`           | `volume_uuid`            | —                                              | Image files (File objects)                                                                                                         |
| `volume_ocr_layers`      | `[volume_uuid+layer_id]` | `volume_uuid`                                  | Alternate OCR layers per volume — METADATA only (name, kind, stamps, cloud sync state), incl. the read-only `original` snapshot    |
| `volume_ocr_layer_pages` | `[volume_uuid+layer_id]` | `volume_uuid`                                  | A layer's `pages`, and nothing else — same key as its metadata row                                                                 |
| `series_metadata`        | `series_key`             | —                                              | Per-series AniList link, titles, tag, tracking (key = normalized `series_title`)                                                   |
| `series_index`           | `series_key`             | —                                              | Cached `series.json` sidecar + cloud file stamp (download cache, unauthoritative)                                                  |
| `catalog_index`          | `id`                     | —                                              | Cached root `catalog.json` (one row, key `'catalog'`; download cache)                                                              |
| `cloud_covers`           | `[account_scope+path]`   | `cached_at`                                    | Thumbnail cache for cloud volumes not installed locally                                                                            |

**Key Types:**

```typescript
interface VolumeMetadata {
  volume_uuid: string;
  series_uuid: string;
  series_title: string;
  volume_title: string;
  mokuro_version: string; // '' for image-only volumes
  page_count: number;
  character_count: number;
  page_char_counts: number[]; // Cumulative per page
  thumbnail?: File;
  thumbnail_width?: number;
  thumbnail_height?: number;
  metadata_only?: true; // pages removed from this device — see below
  ocr_edited_at?: string; // last in-reader OCR edit (sparse index)
  mokuro_sha256?: string; // hash of the .mokuro bytes the installed primary came from — see "OCR upgrades"
  mokuro_sha256_cloud?: { provider: string; size: number; modified?: number }; // where that file is KNOWN to be stored
  updated_ocr_sha256?: string; // edited volumes: newest cloud OCR filed as the `updated-ocr` layer
  ocr_provenance?: (({ engine: object } | { edited: object }) & { digest: string })[]; // installed files' blocks — see "Provenance blocks"
}

interface VolumeOCR {
  volume_uuid: string;
  pages: Page[];
}

interface VolumeFiles {
  volume_uuid: string;
  files: Record<string, File>;
}
```

**Usage:**

```typescript
import { db } from '$lib/catalog/db';

// Query volumes
const volumes = await db.volumes.toArray();

// Get full volume data
const metadata = await db.volumes.get(volume_uuid);
const ocr = await db.volume_ocr.get(volume_uuid);
const files = await db.volume_files.get(volume_uuid);
```

**Layers are two rows, reached through one module.** IndexedDB only ever reads
whole rows, and a layer's pages are a whole volume of OCR, so a layer is a small
`volume_ocr_layers` row plus a `volume_ocr_layer_pages` row under the same key.
`src/lib/catalog/layer-store.ts` is the ONLY code that touches either table
(it takes the connection as an argument, so the export Worker uses it too;
`src/lib/reader/edit/layers.ts` is the main-thread layer API on top of it):

```typescript
import {
  getLayerMeta,
  listLayerMetas,
  getLayerPages,
  putLayerWithPages
} from '$lib/catalog/layer-store';

const layers = await listLayerMetas(db, volume_uuid); // metadata only — never reads pages
const pages = await getLayerPages(db, volume_uuid, layer_id); // one layer's pages
await putLayerWithPages(db, { ...meta, updated_at: now, pages }); // both rows, one transaction
```

Two rules keep the split worth having: anything that lists, compares or stamps
layers (the layer picker's liveQuery, `layer-sync.ts`'s per-listing plan, the
"is there an original yet?" check on every autosave) reads METADATA only —
op-count tests (`layer-store.test.ts`, `layer-summaries.test.ts`,
`layer-sync.test.ts`, `edit-persist.test.ts`) fail if one of them opens the
pages table; and every write of pages goes through `putLayerWithPages`, so
`updated_at` on the metadata row always moves with the pages it describes
(`passive_at === updated_at` and `updated_at > cloud.synced_at` depend on it).
A caller's own transaction over layers must list both tables (`layerTables(db)`).
Both rows go when the volume is deleted (`deleteVolumeCompletely`) and both stay
on "remove from device".

Thumbnails are generated automatically on app load via `startThumbnailProcessing()`.

**Volume states** (`$lib/catalog/volume-state.ts` — always test them through
`isVolumeInstalled(v)` / `needsDownload(v)`, never the raw flags):

| State         | Row? | `volume_ocr` / `volume_files` | Marked by             |
| ------------- | ---- | ----------------------------- | --------------------- |
| installed     | yes  | yes                           | —                     |
| metadata only | yes  | no                            | `metadata_only: true` |
| placeholder   | no   | no                            | `isPlaceholder: true` |

"Remove from device" (`removeVolumeFiles`) deletes only the OCR and image rows
and flags the `volumes` row `metadata_only`. The row keeps the thumbnail and,
crucially, the `volume_uuid` the read history is keyed by, so stats, progress
and the catalog cover survive; a re-download or re-import fills the same row
(`saveVolume` clears the flag). `deleteVolumeCompletely` is the real delete,
used when the user also asks to forget the stats. Placeholders therefore exist
only for volumes this device has NEVER installed — a metadata-only row shadows
the placeholder its cloud file would produce, and the catalog join decorates it
with that file's id/provider so it can be downloaded again.

Anything that reads a volume's pages (exports, backups, the reader, OCR
upgrades, thumbnail generation, the cloud rename's sidecar regeneration) must
skip volumes that are not installed; anything about the volume as a volume
(stats, progress, `series.json`, series metadata) keeps counting them.

A per-profile catalog setting, `notOnDeviceDisplay` (`'mixed' | 'cloud-section'`,
`catalogSettings` in `settings.ts`), controls how not-on-device volumes are
grouped in the catalog and series views — woven into natural reading order, or
collected into their own trailing section. Display only: it never touches the
rows above, downloads nothing, and every volume keeps its progress and actions
either way.

**Catalog card shortcuts**: hovering a card and pressing `E` opens the series
editor (`series-editor-shortcut.ts`); hovering and pressing `Delete` raises the
series removal dialog (`delete-shortcut.ts`). Both are document-level `keydown`
listeners gated on hover + no modal open + focus not on a typing target.

## Important Patterns

### Mokuro File Format

Mokuro generates a `.mokuro` JSON file with this structure:

```typescript
{
  version: string,
  title: string,
  title_uuid: string,
  volume: string,
  volume_uuid: string,
  pages: Page[],  // Array of page data with OCR boxes
  chars: number   // Total character count
}
```

Each `Page` contains `blocks` (text boxes) with bounding boxes, font size, and OCR text lines.

The app writes `.mokuro` files in this upstream format plus two reader
extensions (`chars`, `spine_width`) and at most ONE provenance block (below).
Series-level data lives beside them in `series.json`.

#### Provenance blocks (`ocr_engine` / `edited`)

A `.mokuro` says where its text came from with a top-level block — never both
(bunko's `docs/design/sidecar-provenance.md` is the normative description):

- **`ocr_engine`** (GENERATED): written by a server (mokuro-bunko) that ran an
  engine — `id`, an integer `revision` (absent = 1; same id, higher revision =
  newer output that replaces the old), `created`, recipe details, and `seal`.
  The reader NEVER mints one. Every primary install (`processVolume` — local
  import, cloud download, deep link — and the image-only upgrade) stores the
  file's block verbatim in `VolumeMetadata.ocr_provenance` together with a
  seal v1 digest of THAT FILE's pages (taken before the import remaps any
  `img_path`); a reinstall from a file without one clears the list. What is
  recorded follows bunko's precedence (`provenanceOfFile`): a file with an
  `edited` object records THAT block (any `ocr_engine` left in it is
  ignored), else its `ocr_engine`, else nothing (legacy OCR); any other block
  (a stray `preserved` from a 0.8 pre-release bunko) is ignored. A primary
  the reader regenerates — a rename's new main, a backup, the sidecar
  backfill, an export, an archive's embedded copy, an edited volume's cloud
  main from its `original` snapshot — carries the block exactly when the pages
  written reproduce an entry's digest (`buildPrimaryMokuroMetadata` →
  `carriedProvenance`, `catalog/ocr-provenance.ts`; the newest matching entry
  wins), so the block survives reader renames (names are outside the seal)
  and drops off the moment a page is edited. A layer file never carries one.
- **`edited`** (EDITED): `by` (`"mokuro-reader"`), `at`, `base_sha256` and
  `base_seal` — on every `edit`-kind layer file (`buildLayerMokuroMetadata`)
  and on a primary written from the EDITED primary row itself (exports, Local
  Folder, archives, a rename's fallback when the snapshot is missing) when no
  block can be carried. A primary installed from an EDITED main (another
  device's export or fallback rename) carries THAT file's `edited` block
  verbatim the same way an `ocr_engine` is carried — dropping it would turn a
  person's text into LEGACY OCR a bunko upgrade replaces. `base_sha256` is the
  row's `mokuro_sha256`; `base_seal` is the seal of the sealed main the edits
  sit on (`editBaseSeal`: the `original` snapshot's pages for an edited
  primary, else the primary's — and only when that seal checks over those
  pages, never a stale one),
  computed for layer-sync pushes, Publish of the shared `curated` layer
  (`publishCuratedLayer`) and the Worker's layer sidecars (backup, rename,
  Worker exports); null from the main-thread layer exports
  (`buildLayerExportFile`, `loadVolumeLayerFiles`), on an edited primary's own
  `edited` block, and for an unsealed base.

**Seal v1** = `"v1:"` + hex sha256 of the RFC 8785 (JCS) text of
`{"ocr_engine": <block minus seal and content_sha256>, "pages": <pages>}` —
keys sorted by UTF-16 code units, numbers as `JSON.stringify` spells them, no
whitespace; a non-finite number means no seal (`canonicalJson`,
`contentDigest`). Title, volume, uuids, `chars`, `spine_width`, `version`,
`edited` and key order are outside it. The cross-language vectors live in
bunko's `interop/contract/seal/*.json`, and `src/lib/interop/seal-vectors.test.ts`
runs every one of them, plus an install → rename round trip (`processVolume`,
`saveVolume`, `generateVolumeSidecarsFromDb`) whose regenerated main seals
exactly when the installed file did. `runner-output` is also hand-copied into
`catalog/__fixtures__/seal-vector.ts` for the unit tests that run without a
Bunko checkout; the contract suite checks the copy is still Bunko's.

### OCR editor and layers

The primary `volume_ocr` row is what every existing consumer reads — stats,
exports, backups, the reader by default, OCR upgrades. Alternate layers
(`volume_ocr_layers` + `volume_ocr_layer_pages`, see Database Schema) never
overwrite it implicitly; moving a layer's pages
into the primary row is an explicit **Promote** action. A `translation` layer
(by kind, or by a `tr-<lang>` id alone — `layer-kind.ts`) can never be
promoted: the primary is what character stats are counted from, and the count
only knows Japanese, so an English primary would zero them. The `original` layer
is the read-only pre-edit snapshot the first edit to a volume takes
automatically (`edit-persist.ts`), used by **Revert** — it only exists for the
primary, since reverting a page swaps in the primary's own pre-edit state. On a
provider that compiles its own metadata (mokuro-bunko, `serverCompilesMetadata`)
primary edits stay local, so the `original` never goes up there either — not
pushed by layer-sync, not uploaded beside a backup (`layerStaysLocal`,
`mokuro-hash.ts`); on a shared library it would publish a reserved, meaningless
layer to every user. Plain storage keeps syncing it.

**Corrections go up as the `edit` layer, never as the main sidecar** (bunko
design 0.8 D4: the main `<Volume>.mokuro` is model output). `persistPageEdit`
still writes the primary row — the local view every consumer reads — and, in
the same transaction, the page into the `edit` layer (`EDIT_LAYER_ID`,
"Your corrections"; created from the pre-edit primary on the first save, then
page by page, so pages edited in the layer itself survive). Before that first
save can happen, opening the editor on the primary of a volume with no `edit`
row pulls the account's own listed `<Volume>.edit.mokuro` (the same
`pullOwnEditLayerBeforeEdit` a fork uses): a row minted from the primary would
be newer and replace another device's corrections on the next push. A listed
overlay that could not be fetched (`'failed'`) opens nothing ("Couldn't fetch
your corrections…"), for a fork too. Layer-sync pushes
it as `<Volume>.edit.mokuro` (`scheduleLayerPush`, debounced, from the cached
listing). Every layer file of kind `edit` carries a top-level
`"edited": {"by": "mokuro-reader", "at": <layer updated_at>, "base_sha256":
<row mokuro_sha256 or null>, "base_seal": <seal or null>}` block
(`buildLayerMokuroMetadata`, the one serializer for pushes, backup layer
sidecars and exports); no layer file the app writes carries `ocr_engine` (see
"Provenance blocks"). An edit or a promotion NEVER re-uploads the main
sidecar: the backfill no longer re-uploads an edited volume's listed `.mokuro`,
and every cloud write of a main sidecar (a first backup, the backfill of a
missing one, a rename's regeneration) is built from the `original` snapshot
when the row is edited (`catalog/main-sidecar.ts`) — a missing snapshot means
no main sidecar (a rename falls back to the primary). Except where the cloud's
main moved on past that snapshot: an edited row with `updated_ocr_sha256` (the
upgrade filed a newer main as `updated-ocr`) is renamed with the LISTED main,
downloaded and given only the new `title`/`volume` (`retitledCloudMain`; pages
and provenance as the cloud has them, unreadable = no rename) — rebuilt from
`original` it would put the older OCR back for every account. Exports keep the primary.
A layer made by name never takes a RESERVED id (`isReservedLayerId`,
`layer-names.ts` — bunko's set: `original`, `gcv`, `updated-ocr`, `edit`,
`curated`, the `tr-` prefix, and `edit-<n>`/`curated-<n>`): `slugifyLayerId` turns such a slug (or one with no
letter) into `layer-<slug>` before de-duplicating with `-<n>` ("Edit" →
`layer-edit`, "2024" → `layer-2024`). Edits made before this change live
only in the primary: `migrateEditedPrimariesToEditLayers` (once per device,
rows stamped before `edit-layer:epoch`) copies such a primary into an `edit`
layer when it differs from every layer it has (not its `original`, nor a
layer it was promoted from). Three id families are
CORRECTIONS by id (`isCorrectionsLayerId`): an account's own `edit`/`edit-<n>`
("Your corrections [n]", `isPersonalLayerId` — bunko 0.8 keeps them per
account), the library's shared `curated` ("Shared corrections",
`isCuratedLayerId`, published by accounts with the rights), and bunko's one
keepsake — a case merge's `curated-<n>`, its copy of a second, different
`curated` (`isServerKeepsakeLayerId`, sidecar names rule v1 ServerKeepsake).
They are filed kind `edit` whatever `ocr_engine` stamp their file carries, and
a pull never re-files one as `ocr`. `pre-upgrade*` and `previous-ocr*` are
NOT special: bunko no longer writes or reserves them, so a layer under one of
those ids is an ordinary hand-made layer everywhere — named from its id,
filed by its stamp, pushed, uploaded beside a backup and deleted under the
same rights as any other library file.
Two capabilities say what this server does with them
(`ProviderStatus`): `editLayerSync` is `push` when bunko's identity lists
`edit` in `per_user_layers` (it keeps `edit`/`edit-<n>` per account), `local`
on any other bunko (0.7.x, or one known only by its verified PUTs — there the
file would land in the SHARED library and replace every account's
corrections), and absent on plain storage and cloud-direct (the user's own
file: push). `curatedPublish` is the identity's `permissions.curated.scope`
(`all` / `owned` / `none`), else `all` from a fresh cloud marker that keeps a
curated layer; `canPublishCurated(status, seriesTitle, volumeTitle)` reads it
PER VOLUME (`owned` = a series in `metadataPermissions.ownedSeries`, or — in a
SHARED folder — a volume this account uploaded, `curatedVolumes`; absent = no).
`curatedVolumes` is bunko 0.8's `permissions.curated.volumes` (only under
`owned`): `{ series, volume }` = the series folder as listed and the archive
stem, every listed archive the account controls in folders it does NOT own
(the folders it owns are `ownedSeries`). Both sides fold with
`normalizeVolumeTitleKey`, so a local `volume_title` matches its listed stem.
An older bunko sends no list: only owned series, exactly as before. bunko
stays the judge: a 403 on the publish is final.

**Series owners (bunko 0.8).** bunko records a series folder's owner (the
account whose MKCOL created it; existing folders adopt their only uploader).
Another account below editor may add nothing to it, and may write a file
named after a volume (its sidecars, cover, hand-made layers, nested archives)
only when it uploaded that volume; the owner controls everything in the
folder. `/me` reports it as `permissions.addFiles` (`all` / `open` with
`closedSeries` / `none`) → `ProviderStatus.addFilesPermissions`, whose
PRESENCE says the server enforces owners (older bunko: absent, nothing
closed); `ownedSeries` becomes the folders this account owns, which is who
bunko takes a `series.json` update request from. Three paths pre-check
`accountCanAddToSeries(status, folderTitle)` (folded like `ownedSeries`;
includes `accountCanAddFiles`) and stay quiet for a closed series: the backup
(it skips a closed series' volumes with ONE notice, never an "Upload failed"
per volume — also for a series that closed while queued), the cover sync and
the sidecar backfill. The backup queue words the request's one snackbar
itself (`queueSeriesVolumesForBackup` → "Added N … Skipped M …";
`queueVolumeForBackup` returns `'refused'` when it skipped and noticed): a
caller's own "Added" snackbar would erase the skip notice from the single slot.
Only `'added'` counts as added — `'already-queued'` (a second Backup press while
the first is still queued) is named as such, never re-announced as added.
Everything else (layer-sync's hand-made layer pushes, curated publish,
deletes) relies on the server: a 403 on a library file from such a server is
that file's refusal (`libraryFileRefusal`, `PERMISSION_DENIED` with the
server's verdict detail): never read-only, never a credential failure, and
it re-asks `/me` (throttled to once a minute, `OWNERSHIP_REFRESH_MAX_AGE_MS`,
the backup's 403 re-ask too) so a stale `closedSeries` catches up;
layer-sync remembers the refusal in `refusedPushes`. On a server WITHOUT
`addFiles` a refused cover still fails the cover change (it may mean the
server just went read-only). Personal `edit`
layers stay writable everywhere (they are the account's own files). bunko's
refusal texts never contain "401"/"Unauthorized": `classifyWriteError`
matches those first and would clear the password.

**What stays local** is one predicate, `layerStaysLocal(layer, target)`
(`mokuro-hash.ts`; `target` = `{ serverCompilesMetadata, editLayerSync }`,
threaded through layer-sync's plan, the backup's layer sidecars and the
worker message): an untouched upgrade layer everywhere; `curated` everywhere
(it goes up only by an explicit Publish — not by sync, backup or export);
`edit`/`edit-<n>` where `editLayerSync` is `local`; and on a server that
compiles its metadata `original` and bunko's keepsake `curated-<n>` (sidecar
names rule v1 `layer_class` ServerKeepsake, whose PUT it refuses) — plus the
server's own model output (`isCloudModelOutput`, kind `ocr` with an `engine`
and a `cloud` stamp) even once edited: an edit forks into
`edit` there, but one begun before the provider said it compiles its metadata
(signing in, offline, a cloud-direct marker not read yet) edits the row in
place, and that edit stays on the device rather than replace what the model
wrote for every account — nor does bunko's later rewrite of that layer replace
it (`keepsLocalEdits`, as for an `edit` held back from a 0.7.x). Both hold while
the status says bunko OR the row was pulled from THAT provider while it did
(`cloud.server_compiled`, unindexed, honoured only where the target's provider
type equals the row's `cloud.provider` — `pulledFromCompilingServer`), so a
status that reads plain storage again (a stale cloud-direct marker, a failed
identity probe) changes neither. An export, a file and any other provider get
the layer as usual; a second WebDAV server is the same provider type, so a
backup there leaves the layer out too — a known limit accepted for 0.8.0
(R8): the protection matches on provider TYPE, never on the server, so a
second WebDAV server counts as the same provider. The other limit: a row pulled while the status
ALREADY read plain storage carries no mark, and is treated as plain storage's
(newest wins, pushed when edited). Its id half,
`layerIdStaysLocal`, also decides deletes: a layer that stays local by what it
IS is somebody else's file, so neither a local delete, its tombstone nor the
`.gz`-sibling tidy ever removes its cloud copy (the delete reports
`'kept-shared'`, and the user is told the shared copy stays). Writability is per layer (`canPushLayer`): a personal
id on a `push` bunko needs only `isReadOnly !== true` (a `registered` account
writes its own overlay), anything else also needs `canAddFiles` (and, on bunko
0.8, control of the volume: its 403 is remembered in `refusedPushes`). A personal
row on a WebDAV bunko (`push` or `local` — a 0.8 whose identity probe fell back
reads `local`, and an overlay pulled then is still this account's) records the
provider's `accountScope` in `cloud.account` (`personalLayerAccount`; push,
pull, `stampLayersSynced`) — only there do two accounts read two files at one
path, and elsewhere a scope need not even be stable within one account (Drive's
is `default` until its reader folder resolves, and a cloud-direct marker
reports no `editLayerSync`), so no other provider stamps or compares one: a row of another account on this device is never
pushed — by sync or by a backup's layer sidecars (`account` in
`generateVolumeSidecarsFromDb`) — and is replaced by this account's listed file
only while it holds no unsynced edit. Its delete never touches the file at its
path (that is the ACTIVE account's overlay): the tombstone carries the row's
account (`PendingLayerDelete.account`), and only that account's listings
retry, hide or spend it. **Accepted limit (owner, 2026-11-02):** signing out
keeps the device's volumes and layers, and IndexedDB holds ONE `edit` row per
volume, so after one account signs out and another signs in, the new account
sees and edits the previous account's row. Those edits reach the previous
account's overlay when it signs back in, and Publish uploads that row as
`curated` (`publishCuratedLayer` checks permission, not whose row it is). Not
fixed: it needs two accounts in turn in one browser.
A 403 on a reserved layer file (`isReservedLayerSidecarPath`)
is that file's refusal (`PERMISSION_DENIED`, remembered by layer-sync), never
a read-only demotion of the WebDAV provider.

**Layer ids at a glance** (reserved: `isReservedLayerId`). "Local" is
`layerStaysLocal` — never pushed by layer-sync, never a backup sidecar, never
exported or embedded:

| Id                                | What it is                                                         | Written by         | Local?                                                                         |
| --------------------------------- | ------------------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------ |
| `original`                        | pre-edit snapshot, Revert's base (read-only)                       | the editor         | on bunko only                                                                  |
| `updated-ocr`, `previous-ocr[-n]` | OCR-upgrade keepsakes (device-local)                               | the OCR upgrade    | while untouched                                                                |
| `edit`, `edit-<n>`                | the account's own corrections ("Your corrections")                 | the editor         | where `editLayerSync` is `local`                                               |
| `curated`                         | the library's shared corrections ("Shared corrections", read-only) | Publish only       | always                                                                         |
| `curated-<n>`                     | bunko's copy of a second `curated` a case merge found              | bunko only         | on bunko                                                                       |
| `tr-*`, engine ids, hand-made ids | translations, server OCR, user layers                              | engines / the user | server OCR a cloud vouches for, on bunko (pulled from bunko: on that provider) |

So `edit` lives per account on a bunko that lists it in `per_user_layers`
(the server serves each account its own file at the same path), stays on the
device on any other bunko, and syncs as a normal layer file on plain storage
and in cloud-direct folders (the folder owner's file). Hand-made ids stay
shared library files. A backup sends an `edit` (or `curated`) file only AFTER
the volume's archive (`uploadVolumeFiles`, `volume-upload-order.ts`, Worker and
main thread alike): bunko refuses it with 409 `no-volume` while no `<Volume>.cbz`
is listed beside it. A refusal there fails nothing — the layer is left unstamped
and the next listing's layer sync pushes it. A PRIMARY whose title ends in such an
id (`Notes.edit.mokuro`, `X.curated.mokuro` — `primaryAnchoredOnArchive`) also
goes up right after the archive, since bunko reads that name as a layer until
the archive is listed; unlike a layer it is still required, so a failure there
fails the backup with the archive already on the server. Before the archive, a LAYER the
server refuses (403/409 or a non-auth `PERMISSION_DENIED`, `isLayerFileRefusal`)
fails nothing either: logged at debug, left unstamped for layer sync. A 401, a
5xx or a network failure there still fails the backup, as does any failure of
the primary sidecar or the cover.

**Shared layers are read-only; an edit forks into `edit`.**
`forksOnEdit(layer, status)` (`layer-kind.ts`) is true for `curated` always,
and on a server that compiles its metadata also for bunko's keepsake
(`curated-<n>`) and for server-stamped OCR rows (`isCloudModelOutput`) —
on a shared library those are the one copy everyone reads. Edit mode on such a
layer (`E`, quick actions, context menu) calls `forkIntoEditLayer`: it makes
`edit` from the displayed layer's pages when there is none (no cloud stamp, so
the push rule decides where it goes), switches the display to `edit` and
opens the editor there ("Editing your corrections — the shared layer stays as
it is"). An existing `edit` layer is never overwritten by a fork — nor one
only LISTED so far (pushed from another device, not pulled here yet): the
fork pulls that first (`pullOwnEditLayerBeforeEdit`), since a fresh copy
would be newer and replace it on the next sync. The layer
menu's **Copy to your corrections** (`copyIntoEditLayer`, after a confirm)
replaces its pages on purpose. A layer SWAP from inside the editor (L, the
toolbar strip) onto such a layer does not fork — the editor closes and says to
press E — or L could never cycle past it. `persistLayerPageEdit` and
`upsertLayerPages` refuse `curated` outright (`assertPagesWritable`); its name
stays renamable (a display name is local). Edits on the primary are unchanged
(primary + `edit`, above).

**Publish / Unpublish** (`layer-sync.ts`). Shown only when
`canPublishCurated(status, series, volume)` (per volume; the picker: Publish on `edit`, Unpublish
on `curated`; the badges read "Yours" and "Shared"). `publishCuratedLayer`
uploads the `edit` layer's own serialization (with its `edited` block) to
`<folder>/<stem>.curated.mokuro`, spelled as the LISTING spells the folder and
archive — the only code that writes `curated` — then writes the local
`curated` row with the same pages and the upload's stamp, so the next listing
neither pulls nor pushes it; a 403 is `'refused'` and writes nothing.
`unpublishCuratedLayer` deletes every listed copy — the `.gz` ones first, the
plain file (the one every reader takes while it is listed) last, the same
`deleteListedLayerCopies` its tombstone's retry uses — then the row. The
first copy that fails stops it, with the plain file still there: a 403 means
nothing anyone reads changed (`'refused'`: row kept, no tombstone; plain
first, a refused `.gz` would have become the shared layer); any other failure
removes the row and leaves a tombstone flagged `unpublish`, naming the provider the `curated` row was
synced with (else the active one; with neither, `'failed'` and nothing
changes — a provider-less tombstone would apply to every provider), the
only tombstone whose retry may delete a `curated` file (and only for an
account that may publish that volume). It carries the stamp of
the copy it meant (`file`): a listed `curated` that moved since is another
editor's newer publish — the tombstone is spent and that file pulled, never
deleted. Delete is never offered on
`curated` (it could only hide the shared file here); the settings panel hides it
too.

**Migration guard on shared servers.** The one-time
`migrateEditedPrimariesToEditLayers` stays local and additive and uploads
nothing itself: the `edit` row it makes goes where the push rule sends it —
nowhere on a 0.7.x bunko, the account's overlay on 0.8, the folder on plain
storage. It skips a primary equal to ANY of the volume's layers (read one at a
time through `layer-store.ts`, that volume only): `promoteLayer` stamps
`ocr_edited_at` like a hand edit and keeps its source, so a pre-epoch promotion
of `curated`, an engine layer or `updated-ocr` would otherwise go up as the
account's own corrections. And a personal row that stays local with
unsynced edits (`keepsLocalEdits`) is never pulled over: on a 0.7.x bunko the
listed `<Volume>.edit.mokuro` is the SHARED file, another account's work.

mokuro-bunko must, for all of this: list `edit` in `/login/api/me`'s
`per_user_layers` only when it keeps that file per account; report
`permissions.curated.scope` (`all` / `owned` / `none`) for the signed-in role,
with `volumes` (its uploads in folders it does not own) under `owned`;
answer a client PUT of `curated` without the right, or of `curated-<n>`, with
403 (`pre-upgrade*` and `previous-ocr*` are ordinary layer ids, governed like
any other hand-made layer); and (cloud-direct) write `curated: true` into the marker when the folder's
owner may publish.

Edit mode is paged-mode only (`Reader.svelte` bails out under continuous
scroll). It's entered by the `E` key, the quick actions menu, the settings
toggle, or "Edit text" in the text-box context menu — all funnel through the
same `editModeRequest` store. Edits autosave with a short debounce
(`edit-session.svelte.ts`); `L` cycles the displayed layer and announces the
switch through the reader's in-overlay notification, the same channel other
hotkeys use. Pure editing/layer operations (history, geometry, layer CRUD,
kind inference) live in `src/lib/reader/edit/`; the DOM lives in
`src/lib/components/Reader/Edit` (the edit overlay/toolbar) and
`src/lib/components/Reader/Layers` (the layer picker and rename/new-layer
modal).

Cloud layer sidecars are named `<Volume Title>.<layer-id>.mokuro[.gz]`
(`layer-id` matching `[a-z0-9-]{1,32}`) beside the volume's archive.
A backup sends a layer whose id mokuro-bunko 0.8 anchors on the archive
(`edit`, `edit-<n>`, `curated` — a layer named "Edit" slugs to one) only AFTER
the `.cbz` (`uploadVolumeFiles`, `volume-upload-order.ts`, Worker and main
thread alike): bunko refuses it with 409 `no-volume` while no `<Volume>.cbz` is
listed beside it. A refusal there fails nothing — the layer is left unstamped
and the next listing's layer sync pushes it. Before the archive, a LAYER the
server refuses (403/409 or a non-auth `PERMISSION_DENIED`, `isLayerFileRefusal`
— bunko 0.8 answers 403 for an edited `previous-ocr*`, `pre-upgrade*` or
`curated-<n>` whatever the order) fails nothing either: logged at debug, left
unstamped for layer sync, which remembers the refusal. A 401, a 5xx or a
network failure there still fails the backup, as does any failure of the
primary sidecar or the cover.
`classifyMokuroSidecar` (`src/lib/util/sync/syncable-file.ts`) tells a listed
`.mokuro` apart from a layer file the same way it always disambiguated dotted
volume titles — by checking which stems have a `.cbz` in the same folder
listing — under **sidecar names rule v1**, which mokuro-bunko shares
(`bunko_core::sidecar_names`; the rule is spelled out above `LAYER_ID_RE`):
suffixes in any ASCII case, only `.cbz` defines stems, stems fold NFC +
lowercase (`foldStem`), a primary wins over a layer reading, the id is matched
AS WRITTEN (`Vol 1.GCV.mokuro` is an orphan — never a layer, and never taken
for `Vol 1`'s primary inside an archive or an import, `miscasedLayerStem`;
all-digit ids are valid), a sweep takes the exactly-spelled archive's layers
first (measured against the volume's OWN archive as the listing spells it, so a
caller's DB spelling — composed, another case — still finds them), a leading UTF-8 BOM is
tolerated on read, and every id the reader mints contains a letter
(`slugifyLayerId`). The vectors both sides test against live in bunko's
`interop/contract/sidecar-names.json` — `src/lib/interop/sidecar-names.contract.test.ts`
runs its `classify` and `layer_class` vectors (every id Bunko classes curated,
server-keepsake or reserved must stay local on a bunko target, `layerIdStaysLocal`;
the reader's sweep is no pure
function, so `sweep` is Bunko's alone), and a hand copy in `syncable-file.test.ts`
runs without a checkout — and `src/lib/metadata/layer-sync.ts`
syncs layers for rows that already exist locally (installed or metadata-only), newest-wins, no merge. A
layer with no local record is filed by inferring its kind from the id alone:
`original` stays `original`, `tr-<lang>` is a `translation`, a known engine id
(`gcv`, `hayai`, `paddle-manga`, `ppocr-manga`, `mokuro-fp16`, `mokuro`) is
`ocr`, anything else is a manual `edit`.

A pulled file must plausibly be a layer OF THAT VOLUME: the volume's page
count, or FEWER pages that each name one of the volume's images in order — a
bunko engine run omits the pages its engine crashed on, and
`alignLayerPages` (`reader/edit/layer-page-align.ts`) puts such a file back in
step by `img_path`, blank pages in the gaps. That needs the volume's own pages,
so a metadata-only row takes an exact count only and the download takes the
second look. A refusal is remembered per file stamp in localStorage
(`layer-sync:rejected-files`) together with the RULE that reached it
(`REJECTION_RULE`) — bump it whenever the acceptance rule widens, or browsers
keep refusing files the new rule would take.

A layer can be listed as BOTH `.mokuro` and `.mokuro.gz` (an engine wrote the
`.gz`, a client pushed the plain name over it). The plain file wins every read;
everything that removes or moves a layer works from all listed copies
(`ListedLayerFile.copies`): a delete reports `'gone'` only when every copy went
(else the tombstone stays), and takes them in one order
(`deleteListedLayerCopies`: `.gz` first, the plain file last, stopping at the
first copy that fails — a 403 or any other error — so a failure never leaves
an older `.gz` read in the plain file's place), a push removes the `.gz` it superseded
(best-effort, retried by later listings), and the volume delete/rename sweeps
corroborate per layer id so both copies ride together.

A volume rename (`renameVolumeFiles`) writes in a fixed order: PUT the
regenerated main at the new name (no regenerated main — a legacy caller
without a uuid — MOVES the stale one in its place), move the layers, move the
cover, move the `.cbz` LAST, and only then delete the stale main. The order is
so that an INTERRUPTED rename leaves inert leftovers: a sidecar with no
archive beside it is inert — mokuro-bunko has no sweep for one — whereas an
archive without its main may be treated as owing OCR by a server that acts on
what it finds (a cloud library waits 120 s before acting on arrivals; a local
DAV library is not known to wait). The stale main is deleted last either way.

`.mokuro` files themselves stay upstream format regardless of which layer
produced them, plus the provenance blocks above. A layer that carries an
`ocr_engine` (`servedEngineOf`) is a server's OCR and is filed as `ocr` whatever
its id — including the `<Volume>.<primary generation>.mokuro` bunko writes beside
an EDITED main when the recipe beneath the edit is outdated (it never replaces
an edited main) — except the CORRECTIONS ids above, which stay `edit`. A `gcv`
or `tr-<lang>` layer from the removed
experimental client-side OCR/translation engines still lists, displays and
deletes like any other layer — `KNOWN_ENGINE_IDS` (`reader/edit/layers.ts`)
and `isTranslationLayerId` (`layer-kind.ts`) keep classifying those ids
correctly on purpose, for devices that still have them in IndexedDB.

### Cloud-direct mokuro-bunko (marker + queue file)

A Bunko that manages a library on Drive / OneDrive / MEGA / plain WebDAV
writes two control files at the library root, read by name through
`SyncProvider.readControlFile` (every same-name node; never listed —
`isBunkoControlFile` stays out of `isSyncableFile`):

- `.mokuro-bunko.json`, the marker/lease (`catalog/cloud-bunko-marker.ts`):
  per node, `changedAt` = when this device first saw its current version;
  fresh iff `state == active`, `compiles` lists the file and
  `now − changedAt < 2 × ttl_s` (cold start: `|now − heartbeat_at| < ttl_s + 5
min`); `released` at once; rank epoch desc, claimed_at asc, instance_id asc.
  Every provider's `getStatus()` folds it in (`withCloudBunkoStatus`):
  `serverCompilesMetadata = reported || anyMarkerFresh`, and the provider
  manager republishes on every verdict change and at expiry.
  Marker v2 (bunko 0.8) adds `per_user_files`, `curated` and `dedup` beside
  `bunko_version`, all optional (absent = '' / [] / false; a list with a
  non-string entry reads as []). They reach `cloudBunko.holder` from the
  top-ranked FRESH marker only; records stored before v2 load with those
  defaults. The fold also sets the per-user gates from the holder:
  `historySync` = `bunko_version` core ≥ 0.8.0 AND `per_user_files` has
  `history/` (`bunkoSupportsHistory`), `positionsSync` = `per_user_files` has
  `positions.json`. A gate the provider set itself (a bunko server's `/me`)
  wins; with no fresh holder both stay undefined, so the folder is judged as
  plain storage. A holder's `curated` makes `curatedPublish` `all` (the cloud
  folder's owner may publish the shared layer) — unless the provider reported
  its own, which wins the same way.
  `cloudBunkoMergesDuplicates(scope)` is the holder's `dedup`, and gates the
  reader's own folder dedup (see Duplicate folders). Read the marker through
  `refreshCloudBunkoMarker`:
  one If-None-Match etag per scope, shared by every caller, and one read in
  flight per scope that concurrent callers await. The etag moves only after
  its nodes are recorded (else a second caller is answered not-modified
  against records that are not there yet); a clear voids a read in flight.
  A read never forgets a live Bunko on the strength of one poll (else
  `serverCompilesMetadata` drops for an interval and the reader produces
  catalog/series files and dedups under it): nodes present but none a
  marker (a half-written rewrite) count as not-modified, an unreadable node
  beside readable ones keeps its last record, and a read with NO node keeps
  the still-fresh records UNSTAMPED, so they go stale at 2 × ttl — the scope
  is forgotten only once nothing kept is fresh.
- `.mokuro-queue.json` (`server-ocr-queue.ts`, `cloudSourceFor`): the server
  queue file plus `instance_id`, `truncated` and `done[]`. Trusted only when
  `instance_id` names the top-ranked fresh marker. The cloud poller keeps
  going while the tab is visible (per-provider floors; MEGA also on its live
  tree's events), completes a volume ONLY via `done[]` (absence from a
  truncated list is waiting), and then relists (the hook `+layout.svelte`
  sets), runs the OCR upgrade pass and pulls layers — never
  `pullCompletedVolume`. Cloud uploads are watched while a marker is fresh.
- Folder dedup keeps EVERY copy of both control files when duplicate roots
  merge (`dedupKeepsEveryCopy`, beside the merged root files): trashing the
  older one would pull a marker or queue out from under a running Bunko. A
  guard in front of both trash calls moves a control file instead, should
  that rule ever miss one.
- MEGA feeds control-file listeners from sc events AND from full tree loads
  (`refreshTree`, incl. the sc outage recovery): a load that changes a
  control file's handle set notifies that name. `endSession()` (logout and
  expiry alike) drops the cached bodies and any pending notify.

### OCR upgrades

When the cloud's `.mokuro` for an INSTALLED volume changes, the reader
re-fetches it and swaps the new OCR in — automatically, in the background
(`src/lib/catalog/ocr-upgrade-pass.ts`, writes in `cloud-ocr-upgrade.ts`).

- **The local record.** `VolumeMetadata.mokuro_sha256` is the hash of the
  `.mokuro` bytes the installed primary came from — its BASE revision.
  `processVolume` hashes whatever bytes it parses, so every install path sets
  it (local import, cloud download, deep link); the OCR upgrade and the
  image-only upgrade set it from the file they applied; this device's own
  uploads of the primary sidecar set it to the hash of exactly the bytes sent
  (backup — worker and main-thread —, the sidecar backfill, a rename's
  regenerated sidecar; `mokuro-upload-record.ts`).
  `mokuro_sha256_cloud` records where that file is KNOWN to be stored (a
  listed sidecar a download installed from, or an upload) — the certainty
  `buildSeriesFile` needs to publish the hash. A download takes the listed
  sidecar over a copy embedded in the archive, and `<Volume>.mokuro` over
  `<Volume>.mokuro.gz`; an archive-embedded primary records its own hash but
  vouches for no cloud file. A hand edit KEEPS the hash (the primary is still
  that revision plus local edits — `ocr_edited_at` says so); promoting the
  `updated-ocr` layer adopts its `source_sha256` (attestation cleared);
  promoting any other layer leaves it. A reinstall's `put` replaces it.
  Unindexed fields: no Dexie version.
- **Provenance learned.** `VolumeMetadata.ocr_provenance` (newest first, ≤ 4,
  deduplicated by digest — `addProvenance`) is set by every primary install and
  by the image-only upgrade, and the hash-driven pass APPENDS the downloaded
  file's block (`ocr_engine`, or `edited`) on `upgraded`, `recorded` (another device's rename: same
  pages, new bytes) and `layered` (so promoting `updated-ocr` later still
  finds its block). Nothing is learned on `kept`, `mismatch` or `skipped`. See
  "Provenance blocks".
- **When.** After a listing refreshed `series.json` copies (`series-index-sync.ts`,
  for the refreshed series) and on series open (`series-open.ts`, that
  series). Single-flight (a request mid-run merges into ONE follow-up),
  ≤ 4 downloads at once, failures logged at debug and retried by the next
  pass (a DOWNLOAD failure; downloaded bytes that cannot be decoded or parsed —
  `parseMokuroFile` throws on bad JSON or a missing required field — are
  remembered as unusable for that entry hash, `ocr-upgrade:verdicts`; bytes
  whose size disagrees with the listing's are never judged — a stale HTTP
  cache entry, retried next pass), ONE summary notice per run ("Updated OCR for 3 volumes"), and no work
  at all — not even a row read beyond the index — when no entry carries a hash.
- **Decision per installed volume** (`isVolumeInstalled`; metadata-only rows
  and placeholders are never touched). The index entry is matched by
  `volume_uuid`, else folded `volume_title` (a server re-OCR can mint a new
  uuid); the LOCAL uuid is always kept. Entry hash equal → nothing. Different,
  or ABSENT locally (a one-time baseline for volumes installed before hashes)
  → download the primary sidecar (never a layer file), hash it, parse it
  (`decodeMokuroSidecar` + `parseMokuroFile`), then `applyCloudPrimaryOcr`:
  another page count, or ANY page whose image size (`img_width`/`img_height`)
  differs from the local primary's own (`firstImageSizeMismatch`; pages whose
  size either side does not know are not compared) → skipped (OCR made for
  other images: its boxes would land in the wrong places) and remembered until
  the cloud hash changes; the same pages under other bytes (`sameOcrPages`:
  dimensions + blocks, not `img_path`) → only the hash is recorded; unedited →
  the primary is replaced wholesale on the volume's OWN image names
  (`fitPagesToVolume`), with `mokuro_version`, `character_count`,
  `page_char_counts` and the hash.
- **Provenance of an unedited primary.** Does not matter: it is replaced
  outright, whether it is attested as THIS cloud's file or came from anywhere
  else (a local re-import, an archive's EMBEDDED `.mokuro`, a legacy row with
  no hash, another provider's attestation). Nothing of it is kept — so OCR
  the user re-ran and imported locally is reverted to the cloud's file by the
  next listing unless it was backed up first (owner, 2026-11-02: no keepsake
  copies). v1.10.0 kept such a primary as a device-local "Previous OCR" layer
  (`previous-ocr`, `previous-ocr-<n>`); the first start after the update
  deletes the ones nobody claimed, both rows, chosen from metadata alone
  (`deleteRetiredPreviousOcrLayers`, `layer-store.ts`, run once per browser by
  `retirePreviousOcrLayers`). Claimed — edited, renamed, or the layer a volume
  displays (`ocrLayer`; picking or renaming moves no stamp) — they stay as
  ordinary layers.
- **A replacement drops the snapshots it made stale.** An unedited row can
  still hold an `original` layer (the pre-edit snapshot of the OLD OCR, from
  layer-sync or a reinstall) and an untouched `updated-ocr`; after the swap,
  Revert would restore the pre-upgrade OCR and promoting the `updated-ocr`
  would adopt an old hash. Both are deleted with the replacement (the
  `original`'s cloud copy tombstoned via `notePendingLayerDelete`, so no
  listing pulls it back); an `updated-ocr` the user edited stays. Exception:
  an `original` pulled from the SAME provider and untouched since is kept,
  cloud copy and all — on plain storage the primary only changes when another
  device edits it, and that device published this file as the edit's base.
- **Edited volumes keep their edits.** With `ocr_edited_at` set, a file equal
  to the pre-edit `original` layer only records the hash; otherwise it is
  filed as the `updated-ocr` layer ("Updated OCR", kind `ocr`) carrying
  `source_sha256` and `source_at` (= `updated_at` while untouched, compared
  like `passive_at`). While untouched that row is a mirror of the cloud's own
  primary: never pushed as a layer file (`layerNeedsPush`, the backup's layer
  sidecars) and REPLACED in place by a newer server OCR. Once the user edits
  it, it is theirs: left alone. `updated_ocr_sha256` on the row remembers the
  file filed (or refused) so the next pass needs no download — even after the
  user deleted the layer.
- **A volume open in the reader** (or its text view) is deferred, never
  swapped under the user: `currentVolumeData` re-reads pages whenever the row
  changes, which would move text and an edit session mid-page. Its series is
  retried by the next pass.
- **Read stats.** Progress is keyed by uuid and page and stays put. An upgrade
  recounts `page_char_counts`, so characters read of a partially read volume
  are re-derived against the new per-page counts wherever they come from
  `page_char_counts` (series/catalog views at once); the synced
  `VolumeData.chars` follows at the next page turn.
- **No HTTP cache in the way.** WebDAV data downloads (`webdav-core.ts`,
  main thread and workers alike) send `cache: 'no-cache'`: bunko serves
  sidecars with Last-Modified and no Cache-Control, so the default mode gave
  an old sidecar heuristic freshness and the browser kept returning the OLD
  bytes after a server re-OCR.
- **A short 503 is waited out.** Every WebDAV request (`webdav-retry-after.ts`,
  main thread and workers alike) re-sends a 503 whose `Retry-After` is at most
  30 s, at most twice — a server shedding load answers so and applied nothing.
- **mokuro-bunko** computes `mokuro_sha256` itself when it compiles
  `series.json` (it must hash the primary's JSON after gunzip, emit it after
  `mokuro_modified`, and move it whenever the sidecar changes). Old servers
  and plain storage that never published a hash simply get no upgrades.

### Series sidecar `series.json`

One file per series at `<Series Title>/series.json` (`src/lib/metadata/series-file.ts`,
`SERIES_FILE_NAME`). It carries the shareable series facts plus an index of the
series' volumes:

```typescript
{
  version: 2,
  series_title: string,          // the folder name, never derived from metadata
  external_ids: { anilist?: number, mal?: number },
  titles: { native?, romaji?, english? },
  synonyms: string[],
  tag?: string,
  unit?: 'volumes' | 'chapters', // are the archives volumes or chapters? absent = auto-detect
  updated_at: string,            // ISO — the facts stamp (SeriesMetadata.facts_updated_at)
  spine_offset?: number,         // % — shelf alignment, INDEX data (never a fact)
  volumes: {                     // the index
    volume_uuid: string,
    volume_title: string,
    page_count: number,
    character_count: number,
    mokuro_version: string,
    spine_width?: number,
    archive_size?: number,        // bytes of the .cbz; optional, like spine_width
    mokuro_size?: number,         // listing stamp of the primary .mokuro[.gz] the entry describes
    mokuro_modified?: number,     // (epoch s, truncated) — never a local clock
    mokuro_sha256?: string,       // lowercase hex SHA-256 of that primary's JSON bytes (after gunzip)
    cover_size?: number,
    cover_modified?: number,
    offset?: number                // px — per-volume shelf alignment, INDEX data
  }[]
}
```

Wire order of a volume entry is a contract with mokuro-bunko's compiler (key
insertion order, `orderVolumeEntryFields`): the fields above, in that order.

Rules:

- **Unauthoritative.** Local IndexedDB always wins for installed volumes; the
  index only fills gaps for volumes this device does not have, so the catalog can
  show a cloud-only volume with real page/char totals and attach synced progress
  to its real `volume_uuid` (`placeholders.ts`). Totals only — no per-page
  `page_char_counts` (it bloated the file; a placeholder's chars read come from
  the synced `VolumeData.chars`).
- **Never per-user state**: no progress, tracking, `title_preference`,
  `read_count`, `reread_prompt_suppressed`, thumbnails or page/OCR data. Series
  reading state (`read_count`, re-read mute, `tracking`) lives in
  `volume-data.json`'s `series` section instead (`src/lib/settings/series-data.ts`
  — same newest-`lastUpdated`-wins merge as the volume map it rides alongside).
- **Shelf alignment is index data, not a fact.** `spine_offset` (top-level, %)
  and each volume's `offset` (px) ride the file but never move
  `facts_updated_at`. An absent value means "no opinion" and inherits whatever
  the other side already published; a local `0` suppresses the published value
  at build time and is omitted from the file (build → parse stays an identity).
  The one exception is the PUT body to a `serverCompilesMetadata` provider,
  which reads an absent key as "keep yours": a deliberate local reset of a
  non-zero server `spine_offset` goes up as an explicit `0`
  (`withServerIndexClears`); the cached copy never holds it. bunko (≥ 0.8)
  reads a present `0`/`null` as "clear" and an absent key as "inherit"; older
  servers read the `0` as absent, so the reset only lands there once they
  update. A plain-storage file never carries a `0`.
  Inheritance is a JOIN, never an adoption: `series_metadata` stores only what
  this user edited, and a published alignment reaches the shelf from the cached
  `series_index` copy (`getSpineOffsets` returns `record ?? published`, per key)
  and rides back out through `buildSeriesFile`. Filling it into the record would
  make it ours to republish forever, so the device that measured it could never
  correct or reset it. Readers clamp both fields on parse (±50% / ±500px);
  mokuro-bunko stores whatever it is sent verbatim (one side owns the range
  rule).
- **`mokuro_sha256` is the primary sidecar's identity, INDEX data.** The hash
  of `<Series>/<Volume>.mokuro` (else `.mokuro.gz`, after gunzip) — never of a
  layer file. Absent = unknown, no opinion. It describes a FILE, so it travels
  with that file's `mokuro_size`/`mokuro_modified`: a merge carries it onto an
  entry only when those stamps match the entry it came from
  (`createVolumeEntryMerger`), and never moves the facts stamp. A reader
  publishes its own only when CERTAIN it describes the cloud file:
  `buildSeriesFile` emits an installed row's `mokuro_sha256` only when the
  row's `mokuro_sha256_cloud` (this device uploaded those exact bytes, or
  installed from a download of that listed file) names the listing's provider
  and the listed size/mtime. A published hash otherwise rides through while the
  listing still shows its file; a wrong hash is never written. bunko computes
  its own. Drives the OCR upgrade (see "OCR upgrades").
- **AniList display data (`format`, `status`, volume/chapter totals,
  `cover_url`) is never stored** — not here, not anywhere. The link picker
  shows it transiently from the search result only; the read-progress push
  (`progress-tracker.ts`) fetches the totals fresh in the same GraphQL request
  every time. The reader-facing "Auto" unit option only names a unit
  (`Auto (volumes)`/`Auto (chapters)`) when a marker in the archive names
  actually decided it; otherwise it shows plain `Auto` rather than a guess it
  can't stand behind — the guess itself can still differ from what a push
  resolves once real totals are in hand.
- **Merge**: facts merge by `updated_at` (strictly newer wins,
  `upsertFromSeriesFile`); volume entries merge by `volume_uuid` (local wins),
  then entries missing from the cloud listing are pruned (`buildSeriesFile`).
- **Written** automatically — debounced 2 s per series after a local fact OR
  shelf-alignment edit (`series-file-sync.ts` registers both
  `registerFactsChangeListener` and `registerIndexChangeListener` from
  `store.ts`, funnelling into the same per-series debounce so one patch
  touching both costs one write), after a series' backup uploads finish, on
  series rename (written at the new title, old deleted) and removed with the
  series folder — on a `serverCompilesMetadata` provider the client never
  DELETEs a `series.json` (the server refuses it and retires orphans itself);
  it only drops the cached index. Gated on a writable connected provider and ≥1 backed-up
  volume; read-only providers skip silently. There is no UI button. Facts or
  offsets arriving _from_ a sidecar never schedule a write (no ping-pong).
- **Backfill.** Every cloud listing also reconciles: a folder with at least one
  `.cbz`, no `series.json`, and at least one non-placeholder local row (counts
  even if its files were removed from this device) gets a write queued the same
  way (`reconcileMissingMetadataFiles`) — closes the hole left by libraries
  uploaded before this feature existed, or connected before their facts were
  ever set. The root `catalog.json` gets the same treatment when missing outright.
- **Cached** in the `series_index` Dexie table with the cloud file's
  `size`/`modifiedTime`. After every cloud listing, `series-index-sync.ts`
  re-downloads only the files whose (`size`, `modifiedTime`, provider) differ
  from the cached stamp (`indexNeedsRefresh`), max 4 concurrent, in the
  background. A record also carries the `parser` that produced it
  (`SERIES_INDEX_PARSER`): the parser drops unknown keys, so a copy cached by
  older code lacks fields it did not know, and is re-read once — bump the
  constant whenever `parseSeriesFile` starts keeping a field it used to drop.
- **Import/export**: a `series.json` in an imported ZIP (or file selection) is
  applied after the volumes save; series ZIP and single-volume ZIP/CBZ exports
  include one built from the local volumes.
- **mokuro-bunko**: bunko compiles `series.json` and `catalog.json` itself and is
  their sole producer (see `docs/superpowers/plans/2026-08-23-catalog-distribution-bunko.md`);
  it must partition metadata files out of progress handling (root `.json` =
  progress/profiles, `<Series>/series.json` and root `catalog.json` = metadata).
  A scoped user's `series.json` PUT is accepted as an update REQUEST — for the
  facts and the shelf alignment only (bunko computes counts, stamps and
  `mokuro_sha256` itself). So on a `serverCompilesMetadata` provider
  `writeSeriesFile` PUTs only when the built file's facts or offsets differ
  from the server's copy (`seriesFileCarriesServerRequest`): a placeholder's
  measurement, a download's recorded hash, a backup's drain or a delete's
  maintenance never cost a PUT there. bunko retires `<Series>/series.json`
  itself when the folder loses its last `.cbz`; the reader's cleanup never
  DELETEs it there (an emptied folder, a series rename) and only drops its
  cached index.

### Root `catalog.json`

The library's name/mapping/search data in one root file. It joins the same
root-config allowlist as `volume-data.json`/`profiles.json`
(`isRootConfigFile` in `syncable-file.ts`) — every provider lists, caches and
syncs it the same way — but for writes it is one of the two best-effort
compiled files, along with `series.json` (see Best-effort writes below).

### Root `goals.json`

This user's reading goals, the frozen snapshots of closed goal periods, and
per-volume reading deadlines (`src/lib/goals/goals-file.ts`, `GOALS_FILE_NAME`).

A ROOT CONFIG file, **not** a best-effort compiled one: best-effort exists for
files a bunko server compiles itself and rejects a scoped user's PUT of by
design, and no server compiles a user's personal goals. It is the user's own
state, like progress and profiles, so a failed write must surface. It is
therefore in `isRootConfigFile` and deliberately NOT in
`isBestEffortMetadataPath`.

Rules:

- **Keyed records with tombstones.** Every section is
  `Record<key, entry>` and every entry carries `lastUpdated`; targets, custom
  goals and deadlines also carry `deletedOn`. Arrays cannot merge per key, and
  a hard delete resurrects on the next sync with any device that still has the
  goal. Merge keys: `` `${goalType}:${periodKey}` `` for targets and snapshots,
  the goal uuid for custom goals, the volume uuid for deadlines.
- **Merge** is `mergeGoalSection`: newest `max(lastUpdated, deletedOn)` wins, a
  tie prefers the live record over a tombstone. Parse-time
  `FUTURE_TOLERANCE_MS` clamping, plus FORFEIT-ON-BOGUS detected on the RAW
  pre-clamp stamps (`detectBogusGoalKeys`) and unioned across every readable
  duplicate copy. The upload comparison is against the RAW cloud sections,
  never the parsed ones — a clamped value compares equal to the poison once
  parsed, so the file would never heal.
- **Snapshots merge by UNION, not newest-wins** (`mergeSnapshotEntries`):
  completions unioned with the earlier claim kept, `partialProgress` per volume
  by `Math.max`, `closedAt` the earlier. Newest-wins loses a real case — a
  laptop last synced in November finalizes `year:2026` from the 8 completions
  it knows on Jan 2, and the phone's honest 20 is erased permanently, because
  nothing ever rewrites a snapshot. Union makes convergence order-independent.
  Snapshots have no tombstone: an archived period must not be erasable by a
  device that merely never saw it.
- **Not per-device state.** `activeSelection` (which goal card is on screen)
  and the five `miscSettings` progress keys stay in localStorage. Syncing the
  selection would mean opening Manage Goals on the phone switches the card on
  the laptop, and every tap would dirty the file.
- **No file until there is a goal.** The default 52-volume year target is
  minted when the user opens the tracker, not at module evaluation — otherwise
  every user in the world gets a `goals.json` they never asked for on their
  first sync.
- **mokuro-bunko** must list `goals.json` in `PathMapper.PER_USER_FILES`.
  Anything else under `/mokuro-reader/` resolves into the SHARED library, so a
  goals file left off that set is one file for every account, each overwriting
  the others, and rejected outright for any account without library write
  permission.

### What syncs where

| Data                                                               | File                                      | Merge key                              |
| ------------------------------------------------------------------ | ----------------------------------------- | -------------------------------------- |
| Read progress, per-volume settings                                 | `volume-data.json` (volume uuid keys)     | `lastProgressUpdate` per volume        |
| Series reading state (`read_count`, re-read mute, tracking)        | `volume-data.json` → `series` section     | `lastUpdated` per `series_key`         |
| Settings profiles                                                  | `profiles.json`                           | `lastUpdated` per profile              |
| Series facts (link, titles, synonyms, tag, unit)                   | `<Series>/series.json` (+ `catalog.json`) | `updated_at` = the facts stamp         |
| Shelf alignment (`spine_offset`, per-volume `offset`)              | `<Series>/series.json` (index fields)     | local wins, else the published value   |
| Primary OCR identity (`mokuro_sha256`)                             | `<Series>/series.json` (index field)      | rides with its file's `mokuro_*` stamp |
| Volume completion date (`completedAt`)                             | `volume-data.json` (volume uuid keys)     | rides the whole-entry volume merge     |
| Reading goals, custom goals, closed-period snapshots               | `goals.json`                              | `lastUpdated` per key; snapshots union |
| Per-volume reading deadlines                                       | `goals.json` → `volumeDeadlines`          | `lastUpdated` per volume uuid          |
| Idle cutoff (automatic / manual override, `k`), long-pause default | `volume-data.json` → `tracking` section   | `lastUpdated` per key                  |
| Pre-history reading snapshot (`legacyStats`)                       | `volume-data.json` (volume uuid keys)     | later `before` wins                    |
| Device names, class corrections, merges                            | `volume-data.json` → `tracking.devices`   | `lastUpdated` per device id            |
| Newest reading position (30 days)                                  | `positions.json`                          | newest `t` per volume                  |

`positions.json` (`src/lib/positions/`) is the newest position per volume at a
FIXED path, so a device that was just picked up can learn where the user
stopped without the full listing: it is checked when the reader opens (≤ 1 s),
rides every sync right after the volume data, and is pushed 3 s after page
turns settle (at once when the tab is hidden); the push's own receipt seeds the
root-file memo (below), so neither the next push nor the next sync downloads it
back. Before the first listing has loaded (a cold start) the QUICK tier
(`util/sync/quick-sync.ts`) runs beside that listing: `fetchAllCloudVolumes` starts it, and it reads by known path
with no listing — `volume-data.json` merged (`quickMergeVolumeData`),
`positions.json` adopted (`probePositions`; the open/focus checks use the
probe too while the listing runs), and other devices' history imported from a
listing of `history/` alone (`SyncProvider.listFolder` + `importHistory`).
Providers do this through `readRootFileCopies` and `listFolder` (all five;
Drive walks reader → `history` → device folders, one `files.list` per level,
never the account-wide listing). The quick tier is READ-ONLY: every write
waits for the full sync, the only thing that shows every copy an upload must
not clobber, and each half merges newest-wins or unions by id, so the full
sync redoing it changes nothing. Opening a page never stamps a
position, and an adopted position keeps the other device's stamp. Not
authoritative: history and `volume-data.json` still carry every position.
mokuro-bunko gets it only when it lists it in `per_user_files`
(`ProviderStatus.positionsSync`; no version floor, unlike `historySync`) — a
bunko server through its identity, a cloud-direct folder through the lease
holder's marker (`withCloudBunkoStatus`); before that the path is a shared
library file, and the client neither reads nor writes it. Sync merges every listed copy (newest `t` per volume), so it is
in `MERGED_ACROSS_COPIES` (`syncable-file.ts`) with `volume-data.json` and
`goals.json`: the folder dedup moves a duplicate copy in beside the other
instead of trashing it.

**Root-file reads are conditional** (`util/sync/root-file-memo.ts`). Every
read of `volume-data.json`, `profiles.json`, `goals.json` and `positions.json`
in the full sync and the position push (`unified-sync-service.ts`,
`positions-sync.ts`, each duplicate copy on its own) goes through
`readRootFile`: an IN-MEMORY memo per provider type + account scope + file id
holds the bytes of the last copy this device read or wrote under the server
stamp they had, and `SyncProvider.statFile` (the stamp of ONE known file, no
body; `null` = gone → NOT_FOUND) decides whether to download. Only a change
TOKEN (`FileStamp.revision`) may say "unchanged" — Drive `version`, OneDrive
`cTag` else `eTag`, WebDAV `getetag` (PROPFIND Depth 0), the MEGA node id
(in-memory, no request) — never size + mtime: WebDAV's one-second
`getlastmodified` would merge two same-size writes within a second as one. A
provider with no token (Local Folder, a WebDAV server without `getetag`) is
read by plain download for the session after its first tokenless stat. The
stamp is sampled BEFORE the body, so a racing write costs a re-download, never
a stale hit. Uploads seed it from their RECEIPT (`UploadFileResult.revision`,
via `noteRootFileUpload` in `unifiedCloudManager.uploadFile` and the sync's
writers): this device's own write is never downloaded back; a receipt with no
token, or whose size disagrees with the bytes sent, drops that file's memo
(a WebDAV PUT whose `ETag` header was not readable records NO revision — never
a stat after the PUT: another device's write landing in between would bind our
bytes to its revision). Bounded (16 entries), cleared on logout, provider switch and cache
clear. Never a custom `If-None-Match`: plain servers' CORS allow-lists refuse
unknown request headers, and a refused preflight looks like a network
failure. Transport only — what a caller reads is byte-identical and no merge
rule moves. WebDAV also memoizes `ensureMokuroFolder` per connection for
uploads only (every listing asks the server again, so a reader folder deleted
there is made again), and a download whose size the stat already gave skips
its HEAD probe. `positions-cloud.ts`'s memo is cleared on the same occasions
and on every connect (`cacheManager.setActiveProvider`): Local Folder's
account scope is a folder basename, which two folders can share.

**Mid-session page turns do not upload `volume-data.json`**
(`util/sync/volume-data-deferral.ts`, pure; inputs gathered by
`deferVolumeDataUpload` in `unified-sync-service.ts`). While a reading session
is active — reader open on a volume (`positions/reader-open.ts`) AND the
document visible, read at decision time after the sync's downloads
(`util/sync/reading-session.ts`) — a sync whose merged file differs from the
cloud survivor copy ONLY in `progress`/`chars`/`lastProgressUpdate` of
records that exist on both sides with `progress > 0` (same series and tracking
sections) skips the upload, provided it is covered: `historySyncAllowed`, not
read-only, `positionsWriteAllowed`, `legacyCarriedBy` the provider, and every
moved volume is on its way through `positions.json` (a changed-mark EQUAL to
the record's stamp — the push sends only those, and a look-up restore leaves a
mark above it — or a known cloud entry with `t >=` it, `positions-cloud.ts`).
Anything else — a first read, a reset, a `completed` flip (positions entries
carry no flag, and an adopting device keeps its own for a closed volume), a new
or removed record, any other field — uploads as before. The session's END
uploads: `ReaderView` calls `noteReaderClosed` BEFORE `activityTracker.flush()`,
a hidden tab is already `hidden` when the flush runs, and a deferral sets
`noteVolumeDataDeferred` so that flush syncs even with no turn since. The flush
CONSUMES the flag when it starts that sync (`takeVolumeDataDeferred`) — offline
or read-only, the upload never lands, and every later hide would otherwise run
a full sync — and a provider disconnect or switch clears it. Every
sync outside a session uploads normally. `noteUploaded` escape reports run
only where the upload runs. `e2e/sync-bandwidth.spec.ts` holds the budgets
(no root-file body re-downloaded, no mid-session `volume-data.json` PUT, an
idle sync ≤ 4 stat requests and no bytes up) and `e2e/sync-session-deferral.spec.ts` the
two-device behaviour.

**Look-up visits claim nothing** (`reading-history/visits.ts`, live side
`positions/visit.ts`). A visit is one device's run of page views of one volume,
split on a gap over 10 min; it is a look-up when it has ≥ 2 views, ends on its
first view's pages, and read at most 2 other pages (≥ 3 s each, not skip-fast).
On coming home the record is put back as it was when the reader opened — its
own stamp when nothing of the visit was uploaded, else 1 ms above the newest
upload (`positions/escapes.ts`, reported before each PUT starts) — unless the
page on screen would move, or another device's position landed during the
visit (even while the reader was closed between two opens of it). After a
restore a newer position elsewhere is an offer, never a silent move. A
completion is held only while the visit could still be a look-up, and a
restore drops it; offers, characters read and speed samples ignore look-up
views. "Last read" (smart sort, progress tracker) comes from history
(`reading-history/last-read.ts`): the newest reading view, else a
`lastProgressUpdate` from before the volume's first event (reading history
never saw), else 0 — a re-stamp never moves a series. Another device's reading
that arrived ahead of its events counts too (`reading-history/remote-reads.ts`):
a position adopted from `positions.json` (with its device), or — where history
does not sync — a record `volume-data.json`'s merge moved to a newer stamp
(device unknown). It counts until that device's own page events reach the
stamp; then history judges it, look-ups and all.

Read progress, the series section, settings profiles and goals all sync
automatically on every `syncProvider` call — there is no per-file opt-in and no
separate "Sync profiles" button; `profiles.json` and `goals.json` ride along
unconditionally, the same way `volume-data.json` always has (whose UPLOAD alone
may wait for the reading session's end, above). Goals sync AFTER
volume data, because a closed period's snapshot is permanent and must be built
from the progress that sync just merged.

`series-metadata.json` was retired on 2026-08-23 before it ever shipped. A stale
copy in an existing cloud folder is inert junk — never listed, never read.

Clock-skew hazard: a cloud stamp more than 5 minutes into the future
(`FUTURE_TOLERANCE_MS`) is bogus — a fast-clock device's edit, or corruption.
The series section and `profiles.json` merges clamp such a cloud stamp to
`now` on read, but clamping alone can let the clamped value tie-or-beat a
genuine pending local edit on the first sync after the poisoning. Both merges
add FORFEIT-ON-BOGUS on top: detected on the _raw_, pre-clamp stamp, a bogus
cloud entry never outranks an existing local entry for that key — the clamped
value is only adopted when local has no entry at all. See
`detectBogusSeriesKeys`/`mergeSeriesSections` (`series-data.ts`) and
`isBogusCloudProfile`/`clampCloudProfileStamps` (`unified-sync-service.ts`).
`goals.json` gets the same clamp and FORFEIT-ON-BOGUS treatment, on every
section that has a tombstone. `completedAt` is guarded differently — read-side,
in the goals module, where a stamp beyond `FUTURE_TOLERANCE_MS` is treated as
absent. It is not a merge key but it IS a goal-period key, so a fast clock
would otherwise park a volume in a future period permanently, on every device;
a merge-side clamp would re-clamp to a fresher `now` per device per sync and
ping-pong the file forever.

Known and out of scope (pre-existing): only the `series` section of
`volume-data.json` got the clamp and FORFEIT-ON-BOGUS. The volume half still
merges on the raw, unclamped stamps (`lastProgressUpdate`/`addedOn`/`deletedOn`),
so a fast-clock device can still out-rank a local progress edit there.

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
      "external_ids": { "anilist": 98416 },
      "updated_at": "2026-08-18T19:36:24.324Z"
    }
  ]
}
```

Rules:

- **Names only.** Each entry is the FACTS subset of that series' `series.json` —
  same keys, same meaning, same facts stamp. No counts, no covers, no volume
  lists: those live in `series.json` and arrive when the series is opened. A
  series with no facts still gets an entry carrying just `series_title` and
  `FACTLESS_UPDATED_AT`, so the cached table stays complete for the
  size/mtime staleness check.
- **Load schedule.** Catalog open / provider connect → fetch `catalog.json` when
  its size/mtime changed (`catalog-index-sync.ts`), cache the entries in
  `catalog_index`, apply each entry's facts through `upsertFromSeriesFile` (so
  the factless rules apply unchanged). Series open → refresh that ONE
  `series.json` and materialize its volumes (`series-open.ts`).
- **Search enrichment, not cards.** `catalog.json` never mints a catalog card —
  a stale file would otherwise produce dead-end "Open to load volumes" cards
  for folders that no longer exist. Its facts merge into `series_metadata`
  the same way regardless: a series that already has rows or a cloud listing
  becomes searchable by every synonym/alt title/tag the file carries (same
  `seriesSearchTerms` as any other series), while a catalog-only entry with
  nothing local at all gets a `series_metadata` record but no card until it
  becomes real.
- **Materialization.** Series open promotes each index entry into a real
  `volumes` row in the metadata-only state (real uuid, counts, `mokuro_version`,
  `spine_width`), so progress attaches and stats count before anything is
  downloaded. It never overwrites an installed row, never gives a volume title a
  second row, and only ever FILLS gaps on an existing metadata-only row — the
  index stays unauthoritative (local wins). Covers come from the existing
  per-volume sidecars (`cover-install.ts`), never from the metadata files.
- **Produced by the client** for plain storage backends (Drive/MEGA/WebDAV/
  OneDrive/Local Folder): debounced globally after a fact edit and once per
  backup run, union-by-key with the cloud copy (newest facts stamp wins), pruned
  against the listing, never written from a stale listing. Never produced when
  the provider reports `serverCompilesMetadata` (mokuro-bunko compiles both files
  itself and is their sole producer).
- **Best-effort writes.** A failed `series.json` or `catalog.json` write logs at
  debug and changes nothing else: no read-only fallback, no cleared credentials,
  no snackbar (`isBestEffortMetadataPath`). A server that rejects metadata writes
  while serving reads is a first-class configuration.
- **Hole patching.** Synced progress referencing a series with no local rows and
  no cached index pulls that series' `series.json` and materializes it
  (`hole-patch.ts`), so stats views never dangle.

### Reading history (`mokuro_history`)

A SEPARATE Dexie database (`src/lib/reading-history/`, spec
`docs/superpowers/specs/2026-10-02-reading-history-event-log-design.md`), never
tables in `mokuro_v3`. Every event is permanent and keyed `[device+seq]`:
`device` is this install's random ID and `seq` is allocated inside the same
IndexedDB rw transaction as the write (`appendEvent`), so two tabs never
collide. Kinds: `page` (one per reader VIEW — whole pages on screen, raw
uncapped `dwell_ms`, emitted when the view ends via `ViewTracker`; a hidden
tab has no view), `adjust` (volume editor time/chars edits), `restart`
("restart series"), `forget` (delete stats), `position` (an answer to a
cross-device position offer — see below), `resolve` (an answer about a long
pause — see below). Record through `recordEvent` (`recordView` for a view and
its answer in one transaction, `recordResolve` for a later answer), which
never throw and load the DB module lazily (`volume-data.ts` imports it; many
suites mock `dexie` bare).

**Page turns come from history (phase 2b).** `updateProgress` no longer writes
`recentPageTurns`. The stats still read `PageTurn[]`, but the public `volumes`
store serves turns PROJECTED from every device's events (`project-turns.ts`,
`turns-store.ts` — loaded once on start, then updated per recorded/imported
event): a native view is a turn at its start; a converted legacy turn counts
only when no native view of that volume covers it (±2 s), so phase-1 reading
recorded both ways counts once; a `forget` hides that volume's earlier events.
`volumesWithTrash` records keep only their own UNCONVERTED turns — never write
projected turns back into a record (that is why the speed store's 2-tuple
write-back is gone). Until history loads, or for a volume it has nothing for,
the record's own turns are served, so no stat goes empty.

The cut-over (`cut-over.ts`) runs on start and inside every progress sync
between the merge and the upload: a record's turns become legacy events
(`device = 'legacy:' + volume`, `seq` = turn time — identical on every
device), committed BEFORE exactly those turns are stripped; if IndexedDB
fails the turns stay in the file. `archivedReads` become `restart` events
but stay in the record. Each device uploads the legacy events it holds as
`history/<device>/legacy.events`; imports union by key.

Progress syncs are batched while reading (`activity-tracker.ts`: 5 s debounce,
at most one per 3 min) and flushed when the reader closes, the tab hides or
the page goes away.

**Stats on events (phase 3a).** Time read, characters read, speed and time
left come from history — one clock (`stats-engine.ts`, pure; `stats-store.ts`
keeps it current, re-preparing only volumes whose events changed). Rules that
must hold:

- A view counts its raw dwell up to its CAP: `clamp(k × chars_visible × pace,
60 s, 30 min)`, pace = median ms/char of the newest 500 views (≥ 30 needed,
  else 5 min), or the synced manual override. Over the cap it counts the CAP
  unless answered (phase 3b, below) — the released timer's rule (time on a
  page stopped counting at the cutoff). Never default to "typical" time.
- A view faster than 1500 cpm is a SKIP: its time counts, never its speed; a
  page only skip views showed is skimmed, not read (`skippedChars`, shown apart).
  Per pass (split at `restart`) a page's characters count once.
- Converted legacy turns: page chars = the next turn's cumulative minus this
  one's; over the cap they count nothing (the old idle rule).
- Reading from before history is a per-volume SNAPSHOT in the synced record,
  `legacyStats {time_ms, chars, before}`: the old minute counter and lifetime
  characters, frozen at `before` (`freezeLegacyBaselines`, at start and after
  each sync — no events needed). Figures = `max(old, history before the
freeze) + history after` (`figuresFor`, via the engine's per-volume
  timeline): another device's pre-freeze events arriving later EXPLAIN the old
  figure, never add to it; an unfrozen record shows `max(old, history)`. Raw
  totals are clamped only after that, so an editor edit below the old figure
  works. Merge keeps the later snapshot; a forget drops it, and after one only
  a copy carrying that `forgotAt` may hold one.
- Per page turn the store counts only the changed volume: counts keep their
  pace until it moves > 2%, and the pace / recent speed take volumes newest
  first (`estimatePace`, `recentSpeed`) — never sort the whole library there.
- `timeReadInMinutes` is frozen: parsed, never written. The volume editor
  edits the derived time and records the difference as an `adjust` event (no
  record stamp). The reader timer is that figure plus the open view counted by
  the same rule (`countedDwell`: up to its cap); clicking it ends the view
  until the next page.
- Recent speed = the newest 8 h of counted reading, by time (no per-volume
  window); under 30 min, completed volumes' BASELINES fill in. A series' own
  speed (≥ 60 min of its reading) drives its time left (`series-speeds.ts`,
  one shared map — never group the catalog per card).
- The idle cutoff is NOT a profile setting: `tracking.idle` in
  `volume-data.json` (`tracking-data.ts`), per key newest-wins with the
  series section's clamp + forfeit-on-bogus and raw upload comparison.

**Long pauses (phase 3b).** A view that reaches its cap stops the timer and
counts the cap unless the user says otherwise. `pause-watch.ts` arms one timer
at `since + cap` (re-armed when the pace, `k` or the override moves) and, while
`tracking.pauses.ask` is on (the default), `LongPausePrompt.svelte` says so,
non-modal, above the page — never inside `Timer.svelte`, whose markup hides
with the HUD. Nothing NEEDS an answer. Rules that must hold:

- An answer is a `resolve` event (`volume`, `target: [device, seq]`, `count`
  = `full` | `typical` | `none`; `typical` is no longer offered, but recorded
  ones still count), kind 5 inside segment format 1. `volume` is
  the target's, so everything keyed by volume (turns store, codec, index)
  handles it unchanged. The latest answer per target wins in event order
  (t, device, seq) on every device; nothing is ever edited.
- A live answer SPLITS the view: the view so far and its `resolve` go in ONE
  rw transaction (`recordView` → `appendView`), and a continuation view of the
  same pages opens at the answer (`ViewTracker.split`). Nothing waits for a
  later event, so a page turn or close loses no answer; the continuation earns
  no new characters (a page counts once per pass).
- `countedDwell` is the one rule for engine and live timer: `full` = the raw
  dwell, `none` = 0, `typical` = typical, unanswered = up to the cap. Live, an
  open view STOPS at its cap (every answer splits it, so the open view is
  never answered); a view that just
  ended adds `endedViewMs` (what the stats will count) until the stats move,
  so the timer is exact both ways — no dip on a page turn, and no kept
  minutes after "Don't count" (it used to only ever rise). An answer
  applies under any later cap, and only to TIME — reads and skips are
  unchanged (`none` keeps the pages read and gives no speed sample).
- "Still reading" = `full` plus `widenedK`: `k` fits this view × 1.5, up to a
  half step, at most 20 and never past where the ceiling caps it; it never
  shrinks. `null` (nothing changes) under a manual override, without a pace,
  or when this page's CURRENT cap is held at the floor (`k × expected ≤
floor`: its time reflects the floor, not pace — fitting `k` to one tap on a
  one-bubble page raised every other page's cap ~5.5×). `k` shares
  `tracking.idle`'s stamp with the override; Settings shows the widening with
  a Reset (only while automatic: a fixed cutoff is never stretched).
- The prompt's copy and buttons (`pause-answer.ts` `PauseAnswer`, one pure
  function for all of them): at the cap "No page turn for N, so the timer
  stopped." → Still reading, Close (= keep), Don't ask again; two minutes past
  it "This page was open M. N counted." → Keep N, Count all M, Count none,
  Don't ask again. Keep and Close split the view UNANSWERED; Don't ask again
  is Keep plus `setAskOnLongPause(false)`. A page turn, hide or pause click
  ends the view unanswered. There is no review list and no standing answer:
  `tracking.pauses` is `{ ask, lastUpdated }` (its own key and stamp); an
  older build's `{ default }` reads as `ask: false` when one was set.
- Settings show both as one "Reading timer" card (`ReadingTimerSetting.svelte`):
  "Stop the timer after" (Automatic or fixed minutes) and "Ask if I'm still
  reading".
- Converted `legacy:` views are never prompted; over the cap they still count
  nothing, and a `resolve` aimed at one is ignored.
- `e2e/long-pauses.spec.ts` drives all of it on Playwright's page clock
  (`clock.install()` before the app loads, then `fastForward`).

**Position across devices (phase 2c).** The position stays the newest page
event; `planPosition` (`position-offer.ts`, pure) decides when OTHER reading is
offered instead of silently losing to it. Rules that must hold:

- The signal is what the NEWEST device (owner of the newest native view) saw.
  Another device's FINAL view is offered unless the newest device viewed that
  page after it, or the view's pages already include the current progress.
  A view's page is its `first_page` (a spread's position). Final, never
  furthest: peek-ahead-then-back resumes where the reader stopped.
- A restart wins. It is FOLLOWED once ANY device views page ≤ 1 after it; an
  unfollowed restart from another device, with newer reading on the newest
  device, is re-applied (`applyMissedRestart` archives the pass, then zeroes
  it) and that reading — as it stood when the reset was recorded — is offered.
  The reset waits while that volume is open in the reader.
- Answers are `position` events (`jump`/`stay`/`reset`, `through` = the offered
  reading's time): nothing at or before an answered `through` is offered again
  on any device, whatever stale copy arrives. Marking a volume read/unread
  records a `stay` (`settlePositionOffers`). A `forget` hides earlier events;
  converted `legacy:` events never drive offers.
- Jump (`jumpToPosition`) is not a page view and fires no completion notice.
- Cadence (`position-store.ts`, localStorage `position-offer:shown`): the reader
  banner shows an offer at most once a session, in at most 2 sessions; then the
  volume card shows a chip (`PositionOfferChip.svelte`) until answered.
- `positionPlanFor` is memoised per volume on its events version
  (`volumeEventsVersion`) and progress — the chip mounts once per card.

**Devices (phase 4).** A device is a raw id with a facts row (`devices`, from
its `device.json`) or a native event; `legacy:` ids are never devices
(`isDeviceId`, `paths.ts`). What the user chooses about a device lives ONLY in
`volume-data.json` → `tracking.devices[<id>]` (`DeviceLabel {name?, class?,
merged_into?, lastUpdated}`, `tracking-data.ts`) — never in `device.json`,
`pickFacts` or the history DB. Rules that must hold:

- One stamp per entry, newest `lastUpdated` wins, a tie keeps local, with the
  clamp + forfeit-on-bogus of the other `tracking` keys (bogus ids are
  `devices/<id>` in the one bogus set). The entry is replaced whole, so a
  cleared name or an unmerge wins by its stamp. The multi-copy fold filters per
  device id (`foldableTracking`): a bogus copy must never wipe other devices'
  labels.
- Labels (`devices.ts`, pure): a user name verbatim, else `<Class> · <OS> ·
<browser>` (`generatedLabel`). Generated labels that collide over ALL known
  raw ids (merged ones too) get ` (since Mar 2026)` from first-seen (UTC month,
  so every device agrees), then ` 2`, ` 3` by first-seen and id. "This device"
  is a badge on the group holding `resolveDevice(own)`, never in the label. The
  UUID is never shown.
- `merged_into` applies ONLY where reading is grouped by device: `resolveDevice`
  follows it with a visited set, and a cycle leaves every member unmerged;
  `mergeDevice` into a cycle member first takes it off the cycle.
  Events are never re-keyed — volume/series/total figures, resolve targets and
  `planPosition` use raw ids, so a merge or unmerge never recounts. Merging does
  not carry the source's name.
- Never show another device's `facts.last_seen`: `exportOwnFacts` leaves it out
  of the upload signature, so it is stale by design. "Last read" is the group's
  newest event.
- Per-device stats come from the engine's `byDevice` (raw id; every `legacy:`
  view under one key; characters to the first crediting view's device),
  grouped by `resolveDevice` in `deviceStats` (`device-stats.ts`; also
  `devices`, `knownDevices`, `deviceFacts`) — a label change regroups, never
  recounts. "Before history" = legacy views + the pre-history baseline, so rows
  sum to the page's totals; volume-editor `adjust`s are an "Edits" row. Both
  hidden at zero, neither renamable. Speed shows only with ≥ 30 min of samples.
- NO device UI for now (owner, 2026-11-07): the cloud page's Devices block,
  the reading-speed page's per-device card and its "name this device?"
  banner were removed as clutter. Readable labels and a clean "where you
  read" breakdown are wishlisted. The data layer stays — labels still parse,
  merge and sync (`tracking-data.ts` setters included), and `deviceStats` is
  a lazy store nothing subscribes to — so a later UI starts from real data.
- The position offer names the offering device by its label ("on Pixel 8");
  a device this one knows nothing about keeps "on another device".
- `e2e/devices.spec.ts` drives the offer's device name: browser contexts on
  the WebDAV stub (`device.json` + an encoded month).

**Cloud (phase 2a).** Each device uploads ONLY its own events, one file per UTC
month, `history/<device>/<YYYY-MM>.events` (deflated, versioned rows —
`segment-codec.ts`; a reader refuses a `format` it does not know), plus
`history/<device>/device.json` (its facts), and imports every other device's
(`history-sync.ts`, run at the end of every `syncProvider` by
`syncReadingHistory`, lazily imported). Rules that must hold:

- History is recognised by its FULL path (`reading-history/paths.ts`):
  `isSyncableFile` must be given the path relative to the mokuro folder, never a
  bare basename. Drive lists the account flat and walks parents to build it
  (`drive-history-path.ts`); its cache groups by the FIRST segment like every
  other provider. OneDrive creates nested folders one segment at a time.
- Import is idempotent by `[device, seq]` in one transaction with the file's
  stamp (`history_files`, Dexie v2); a file that fails to download, decode or
  match its path (device/month) records nothing and is retried next listing.
  Size/mtime only decide whether to download.
- Upload marks are per provider (`history_meta` `uploaded:<provider>:<month>`):
  a new provider gets every month. The current month goes up at most every
  5 min unless the sync is manual (non-silent); closed months always go up.
- Best-effort: history paths are in `isBestEffortMetadataPath` (a rejected
  write never demotes WebDAV), and the pass never fails the sync. Read-only
  providers get no uploads (imports still run). mokuro-bunko gets history only
  from **0.8.0**, which maps `history/` per user, lists it in `per_user_files`
  and is the first to report its `version` in `/login/api/me` (bunko issue
  #27): the WebDAV provider sets `ProviderStatus.historySync` only when BOTH
  hold — the version's numeric core ≥ 0.8.0 (a `0.8.0-beta.N` counts as 0.8.0;
  missing or unparseable = no) AND `per_user_files` contains `history/`
  (`bunko-version.ts`). These gates (with `positionsSync` and
  `editLayerSync`) follow the server, not the connect: each writer of a
  per-user file — the progress sync, the positions push/open/foreground
  checks (`syncPositions`), the listing- and edit-triggered layer sync, an
  edit layer's cloud delete, the backup's worker message — first calls
  `freshGateStatus`/`refreshGates` (`identity-gates.ts`), which re-reads the
  identity once the last answer (any answer, a failure included) is 5 min old;
  concurrent callers share one request. So after a bunko upgrade or rollback
  under an open tab a writer can act on the old answer for at most 5 min, never
  until a reload. A refresh never drops a held token on a transient answer, and
  one that identifies bunko turns the bunko gates on (`serverCompilesMetadata`)
  for a session that connected as plain storage. On a cloud-direct folder (Drive/OneDrive/MEGA/plain
  WebDAV) the fresh lease holder's marker decides the same way, from its
  `bunko_version` and `per_user_files` (`withCloudBunkoStatus`); no fresh
  holder = plain storage. `historySyncAllowed(status)` (`history-sync.ts`)
  gates EVERYTHING. Otherwise `history/` lands in the shared library, so neither
  upload nor import runs there, and the file keeps carrying page turns
  (`attachProjectedTurns`).

### Settings Architecture

Three-tier settings system:

1. **Global defaults**: Hardcoded in settings.ts
2. **Profile overrides**: User-created profiles with custom settings
3. **Volume-specific overrides**: Per-volume settings that override profile

### Stat Tracking

Tracked per volume in the `volumes` store:

- Pages read
- Characters read (cumulative from mokuro data)
- Time spent reading (tracked by Timer component)
- Last read date and current page

### Reader Input Handling

All reader gesture handling (pan, pinch, tap, swipe, wheel, keyboard) goes
through the shared modules in `src/lib/reader/input/` — see
**`docs/INPUT-CONTRACTS.md`** for the architecture and the contracts that
must not break. Highlights:

- `.textBox` is an input-routing protocol: double-tap there is the AnkiConnect capture gesture, mouse/pen drags are text selection (Yomitan/Migaku) — never pans, never zoom
- Each surface owns its gestures via `PointerGestureTracker` config; Reader owns only keyboard + intent callbacks
- Before starting any motion, handlers call their surface's `MotionGate` intent method instead of ad-hoc `finishNow()`/`stop()` combinations

### OCR text placement (auto font size)

`layoutLines` (`src/lib/reader/line-coords-layout.ts`) places every OCR line from its
`lines_coords` quad; `TextBoxes.svelte` renders ONE in-flow inline-block span per line and the
`positionPerLine` action snaps it onto its target with a measured transform (never
`position: absolute` — issue #254, Yomitan's cross-line scan).

- **Fixed-pitch grid, no per-character spans.** Japanese print is fixed-pitch, so every line
  is ONE text node stepped at a PITCH with
  `letter-spacing` (`gridSpacing` in `line-grid.ts`). The pitch is NOT `main / count`:
  - **Ink insets** (`glyph-insets.ts`, `inkInsets(text, vertical)` → `{ lead, trail }`). A
    detector's quad hugs the INK; a trailing `。、` inks a third of its cell, `」` its first
    third, `「` its last, a lone `一` in a column the middle. A quad spanning the ink covers
    `advance − lead − trail` cells, and the first CELL starts `lead` ems BEFORE the quad — so
    `LineLayout.inset` is usually negative. The table is calibrated on print (evidence in the
    module's doc comment); tune it there, with measurements.
  - **Tracked text.** When the solid pitch exceeds the quad's thickness, the glyphs are as
    big as the quad is thick and the rest of the length is per-character tracking
    (`ownPitch`): the run is flush with the quad's ends, not centred in n equal shares.
  - **Block-shared pitch** (`linePitches`). The clean lines of a block vote (glyph-count
    weighted median, lines of ≥ 4 cells first); a line takes the block's pitch when its ink
    would then end within `PITCH_TOLERANCE_CELLS` (0.75, absolute — not a percentage) of its
    quad's end, ANCHORED AT ITS START. Lines that do not fit vote again among themselves
    (ruby vs base text, a heading). Font size follows the pitch (cross-capped,
    block-uniform as before), so `「嫌だ」` is as large as the body text beside it.
- **Where the grid gives up.** Outside −0.35…1.5 em of spacing the quad or the text is wrong
  and the line renders unspaced, as before. Wrapped/banded/hidden lines are never spaced.
  The measurer and the line spans both run with kerning off.
- **Rotation.** A clean line whose quad is tilted renders in the quad's own frame:
  `translate(…) rotate(θ)` about the centre of a main × cross box (`lineFrame`,
  `lineTransform`). The dead band is length-aware: |θ| ≥ 2° AND the tilt must carry the
  line's end across more than `TILT_MIN_SHIFT` (0.35) of its thickness
  (`|sin θ| · main > 0.35 · cross`) — corner noise reads 2–11° on short lines that are level
  in print. `LineFrame.tilt` keeps the measured angle for the editor's quad operations. θ is
  CSS-clockwise, in (−90°, 90°]. The browser hit-tests the turned glyphs, so pop-up
  dictionaries scan along the slant. A rotated line is never clipped or wrapped; one that
  would cross another clean line falls back to the upright layout.
- **Original mode** is the file as it is: the file's PLACEMENT at the file's SIZE — and where
  the two contradict each other, the GEOMETRY wins. A block with usable `lines_coords` takes
  the same per-line path as auto — frame, block pitch, ink insets, letter-spacing, rotation —
  via `layoutLines(…, { size: 'file' })`. The size rule (`fileLineSizes`): a line can carry a
  size up to where its glyphs would close up by `FILE_MIN_SPACING_EM` (−0.05em) on its pitch
  (`maxSizeAtSpacing`; solid fullwidth text: `pitch / 0.95`) and up to `CROSS_SLACK` (1.2) ×
  its quad's thickness; the BLOCK renders at `min(font_size, its tightest full line's cap)` —
  one size per block, as the file has (full = ≥ 4 cells and not merged-columns; ruby-sized
  lines, under 0.7 of the block's median cap, don't pull the block down), and only a line
  that cannot carry even that goes lower, alone. So a consistent file (font_size ≤ ~5% over
  its pitch) keeps its size exactly, a smaller one gets positive spacing, and mokuro's usual
  overstatement (quad width incl. furigana: median +20%, p95 2×) no longer draws glyphs on
  top of each other or overflows the box. Still NOT auto: no fitted/uniform vote, no wrap
  containers, no overlap bands, no nudging/clipping, and a tilt is never refused; the ONE
  heuristic kept is hiding a re-captured duplicate line (same glyphs twice on one spot; its
  text is inside the line that hides it). A block WITHOUT
  usable `lines_coords` keeps the legacy whole-block paragraph at the raw `font_size`.
  Manual sizes use none of it.
- **The OCR editor agrees** (`EditableBlock.svelte`, geometry in
  `src/lib/reader/edit/block-geometry.ts`): `blockLineGeometries` runs the SAME
  `linePitches` vote over the block's lines, and a positioned line is one text node on that
  pitch (letter-spacing + the start inset as `text-indent`), centred across its quad; a
  tilted quad is the own-frame box with `rotate(θ)` — also while its contenteditable is
  open. The reader's font mode changes nothing there: the editor
  sizes each line from its pitch and RAW text (whole px) in every mode, not by the viewer's
  block-uniform size nor (in `original`) the file's `font_size`, which it re-derives from
  the quads on every quad edit. Line ops keep the tilt: move translates, resize
  drags one edge in the quad's frame (`resizeQuadEdge`), an inserted line is its neighbour
  in that frame; `resizeLine` squares up only UPRIGHT quads.
- Real-browser coverage: `e2e/novel-grid.spec.ts` (a canvas-drawn novel page whose quads are
  measured off the drawn ink: glyph-on-cell drift, body-sized short lines, pointer-on-print
  hit-testing), `e2e/line-grid.spec.ts` (grid, rotation, hit-testing, turned cells, editing
  a tilted line), `e2e/char-offsets.spec.ts` (original mode, viewer and editor).

### Images are raster only

SVG is an unsupported format. Every page, cover and thumbnail ends up behind a
`blob:` URL on the app's origin, served with the Blob's own `type`, so an
`image/svg+xml` or `text/html` Blob (or an untyped one the browser sniffs as
HTML) runs its script as the app when the user picks "Open image in new tab".
`src/lib/util/raster-image.ts` is the rule: a stored image's type comes ONLY
from its magic bytes (`toRasterImageFile`, `sniffRasterImageType`), for the
formats in `IMAGE_MIME_TYPES` — never from a remote `Content-Type` or a file
extension — and anything else is refused, never stored. `processVolume` types
every page and the thumbnail sidecar that way (non-raster pages become missing
pages); deep-link covers and cloud covers go through the same call. On the
way out, thumbnail/cover surfaces and the Anki `{cover}` field go through
`displayableCoverBlob` (a raster-typed Blob as is, an untyped one — older
archive imports stored thumbnail sidecars untyped — under a raster label, any
explicit non-raster type never), page object URLs are minted from a
raster-labelled view (`displayableImageBlob`, for pages stored untyped by older
builds), and `processThumbnails` re-types or drops any stored thumbnail whose
type is not raster.

### Cloud covers

`requestCover(vol)` (`src/lib/catalog/cover-service.ts`) is the only way anything obtains a
cloud cover: surfaces through `createCoverClaims`, the series-open pass through
`installCoversForSeries` (a candidate builder), the backfill's stale refresh with
`{ refresh: true }`. Its ladder: fresh row thumbnail → cached in `cloud_covers` (PROMOTED
onto the row when the volume is metadata-only AND read, `coverBelongsOnRow`) → fetch. A cached cover
whose recorded stamp is stale against the listing is fetched again (stampless rows wait for the
14-day expiry); a rewrite at the same key reaches cards already showing it
(`replaceCoverKeys`). The
write queue (`cover-persist.ts`) routes by the same predicate. Never fetch or write a cover
from anywhere else. Synced-progress rows are minted after every progress sync
(`resolveSyncedProgress`), never from a view mount.

### Modal Button Z-Index

**Always add `relative z-10` to action button containers in modals.**

Night mode applies a CSS `filter` to `<dialog>` elements (see `src/lib/styles/night-mode.css`). The `filter` property creates a new stacking context, which resets all z-index relationships inside the dialog. Without explicit z-index, scrollable containers (`overflow: auto/scroll`) can capture click events instead of sibling button containers.

```svelte
<!-- ✅ Correct - buttons will be clickable even with night mode filter -->
<div class="relative z-10 flex justify-end gap-2">
  <Button>Cancel</Button>
  <Button>Save</Button>
</div>

<!-- ❌ Wrong - buttons may not receive clicks when night mode is active -->
<div class="flex justify-end gap-2">
  <Button>Cancel</Button>
  <Button>Save</Button>
</div>
```

**Why this happens**: Properties like `filter`, `transform`, `opacity < 1`, and `will-change` create new stacking contexts. Test modals with night mode ON to catch these issues.

## Environment Variables

Create a `.env.local` file for cloud provider integration:

```
VITE_GDRIVE_CLIENT_ID=your_client_id
VITE_GDRIVE_API_KEY=your_api_key
VITE_ONEDRIVE_CLIENT_ID=your_azure_app_client_id
VITE_ANILIST_CLIENT_ID=your_anilist_client_id
```

- `VITE_GDRIVE_*`: required only for Google Drive sync.
- `VITE_GDRIVE_AUTH_BACKEND=true` + the server-only `GDRIVE_CLIENT_SECRET`,
  `GDRIVE_SESSION_KEY` (`openssl rand -base64 32`), optional `GDRIVE_SESSION_KEY_PREV`,
  `GDRIVE_CLIENT_ID` (falls back to `VITE_GDRIVE_CLIENT_ID`) and `GDRIVE_POP=off`: the Drive
  auth backend (`docs/gdrive-auth-backend.md`). Secrets never take a `VITE_`/`PUBLIC_` prefix;
  `npm run build` fails if one set in its env shows up in the output.
- `VITE_ONEDRIVE_CLIENT_ID`: required only for OneDrive sync. Register an
  Azure AD app (any Microsoft account tenant, "common" authority) and add the
  deploy origin as a **Single-page application** redirect URI. Scopes used:
  `Files.ReadWrite`, `offline_access`, `User.Read`. When unset, the OneDrive
  option is hidden from the cloud screen.
- `VITE_ANILIST_CLIENT_ID`: required only for pushing read progress to AniList.
  Register an AniList API client (implicit grant) whose redirect URL is the deploy
  origin with a trailing slash. Searching/linking series needs no key.
- MEGA, WebDAV, and Local Folder require no env vars.
- `CSP_MODE` (build time, NOT a `VITE_` var — read by `svelte.config.js`):
  `off` (default) | `report-only` | `enforce`. See "Security headers and CSP".
  Any other value fails the build.

### Security headers and CSP

- **`vercel.json`** sends `X-Content-Type-Options: nosniff`, `X-Frame-Options:
SAMEORIGIN`, `Cross-Origin-Opener-Policy: same-origin-allow-popups` (never
  `same-origin`: it severs the GIS popup) and a `Permissions-Policy` denying
  unused device features (never microphone — Migaku —, clipboard, fullscreen,
  wake lock, share, local-network/loopback) on every path but `/api/` and
  `/oauth/` (those get their own rules; keep one header name per path). Both of
  those carry `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and their
  own `nosniff`; `/api/` a `default-src 'none'; frame-ancestors 'none'` CSP, and
  the Drive sign-in callback (`/oauth/`) `X-Frame-Options: DENY`, `noindex` and an
  ENFORCED CSP (whatever `CSP_MODE` says) allowing only its own same-origin
  script — `google-callback.js` fetches nothing, styles nothing and has no
  inline code; keep it that way or widen that one policy with evidence. The
  module workers (`/_app/immutable/workers/*`) get their own CSP: a worker does
  not inherit the page's. That one is NOT phased by `CSP_MODE` — it is enforced
  from the first deploy. No global `Referrer-Policy` (the Drive API key's
  referrer restriction needs the origin).
- **The shell's CSP** is `kit.csp` (`src/lib/security/csp-policy.js`, mode
  `hash` — never nonces on a CDN-cached shell), phased by `CSP_MODE`. Every
  source in it is justified there; add a third-party host only with the same
  evidence, and NEVER bare `accounts.google.com` / `www.gstatic.com` in
  `script-src` (JSONP/AngularJS bypass gadgets — exact paths only). Report-only
  carries `report-to csp-noop` (kit 500s every page without one) and no
  Reporting-Endpoints header: reports go nowhere. No inline `<style>`/`<script>`
  in `app.html` (kit hashes only its own): styles go in a stylesheet. No
  `default-src` (it would only refuse the https: media extensions inject).
  `frame-src` carries `login.live.com` beside `login.microsoftonline.com`: MSAL's
  silent-renewal iframe sends a personal account through it. Safari below 16
  (`'wasm-unsafe-eval'`, `style-src-attr`) is knowingly unsupported under
  enforce.
- **Vercel Toolbar**: injected into preview deployments (beta), refused by the
  policy. Turn it off for previews in the Vercel project settings rather than
  widening the policy — beta must enforce exactly what production does.
- **Violations** are kept in an in-page ring buffer (`csp-violations.ts`,
  installed by `src/hooks.client.ts`): `__mokuroCspViolations()` in the console.
  A violation inside a worker fires on the worker, so every app worker calls
  `forwardWorkerCspViolations()` first thing (BroadcastChannel
  `mokuro-csp-violations`, entries `context: 'worker <path>'`); a new app worker
  must too. Third-party blob:/data: workers (zip.js codecs, pica) are not
  covered. `isAppViolation` is for the automated spec only: checking a device
  by hand, ANY entry recorded while Yomitan or Migaku is active — extension-
  attributed ones included — blocks enforcement until it is allowed or shown
  harmless (Chrome exempts an extension's own loads, so what does fire is its
  main-world injection, exactly what enforce would break).
- **The Google scripts** (gapi, GIS) load on demand (`google-scripts.ts`): when
  Drive is the active provider at boot, and when the cloud page mounts —
  never first inside the Connect click (the GIS popup needs its activation).
  Each waiter waits for its own script only (`loadGapiScript` for the Drive
  client and Picker, `loadGisScript` for the token client): with the auth
  backend GIS is just the popup fallback, and a blocked GIS must not take the
  Drive client down. The backend's sign-in (a full-page `location.assign` to
  Google) and renewals (`fetch('/api/gdrive/…')`, `connect-src 'self'`) need
  no Google script and nothing beyond the shell policy.
- `e2e/csp.spec.ts` builds each mode (own `MOKURO_E2E_KIT_OUT_DIR`), re-applies
  `vercel.json`'s headers, and requires zero app violations through boot,
  import, reader, OCR text, settings, night mode and the cloud page.

## Testing

- Tests use Vitest with jsdom environment
- Component tests use @testing-library/svelte
- Run tests with `npm test`
- Example test files: `src/lib/util/count-chars.test.ts`, `src/lib/components/Settings/__tests__/QuickAccess.test.ts`

### Bunko contract (`src/lib/interop/`)

- The reader's tests parse mokuro-bunko's own answers (`interop/contract/bunko/*.json`), record the
  requests the reader sends (`reader/*.json`, which bunko replays), and run its seal and sidecar-name
  vectors. They read a bunko checkout: `BUNKO_REPO=<checkout>`, else a sibling `mokuro-webdav-library`
  found by looking around. A sibling counts only when it holds every file of `CONTRACT_BASELINE`
  (`contract.ts`, the newest contract files the tests read — add one there when a test starts reading
  a new fixture): one on an older branch is ignored with a warning and the tests run on the reader's
  snapshots, instead of failing ordinary unit tests on fixtures it never had. It may still be on
  another branch than the one you are pairing with, so name it. `BUNKO_REPO` is used as named, never
  skipped: one without `seed.json`, or lacking any `CONTRACT_BASELINE` file, throws once, listing
  what it lacks. `BUNKO_CONTRACT_REQUIRED=1` turns a missing checkout (or a missing vectors file) into
  a failure.
- CI checks out bunko at `vars.BUNKO_REF` (default `0.8/remote-storage`) with
  `BUNKO_CONTRACT_REQUIRED=1`, so a reader branch whose tests read a newer contract fails CI until that
  bunko branch carries it: push bunko's contract FIRST, then the reader branch that reads it.
- `BUNKO_REPO=<checkout> READER_BLESS=1 npx vitest run src/lib/interop` rewrites the records, in that
  checkout only. A changed request lands in bunko FIRST (commit the records there, run its
  `contract_replay`), then in the reader.
- `fixtureFetch` answers a request from the fixtures it was given by method, path, query and
  `Depth`; when several match, the request's auth, then its body, narrow them, and any still tied
  throw "ambiguous fixtures" naming them — hand it only the fixtures the test means.
- Fixtures report `/login/api/me`'s `version` as the sentinel `"0.0.0"`, below 0.8.0: a gate derived
  from a recorded identity (history) is OFF there. A test that needs it on sets it itself.

### Interop rig driver (`src/lib/interop/rig-driver.ts`)

- mokuro-bunko's rig (`cargo xtask interop rig`, `interop/e2e/rig/`) builds this reader with
  `vite build --mode interop` and drives it through `globalThis.__mokuroInterop` (API v1: connect,
  sync, library, progress, rename/delete, edit/Publish/layer selection, provider/control/history
  status). `+layout.svelte` installs it only under `CLOUD_TEST_HOOKS`, and
  `scripts/check-no-test-hooks.mjs` bans its names from the production bundle.
- Each method calls the stores and functions the UI calls for that action (the cloud screen's
  connect, `syncProgress`, the volume editor's rename, the card's delete, the paged page turn —
  `reader/paged-progress.ts`, shared with `Reader.svelte` —, the editor persist path, the layer
  picker's Publish). Add product logic to the app and call it from here, never the reverse.
- `capabilities` names only what the branch really ships; a rig spec needing a missing one fails
  unless bunko's `interop/pending-reader-caps.txt` lists it. Add a name with the cluster that ships it.
- Before any page script the rig sets `globalThis.__mokuroInteropConfig` (v1: `bases`, `tokens`
  for google and onedrive, `gapiShim`); `cloud-test-hooks.ts` reads it once at init. An injected
  Google token replaces Google Identity Services in `token-manager.ts`, an injected OneDrive token
  MSAL (no client id needed).
- The injected Google client cannot mint: a silent re-auth for the token already held gets the
  same string back ONCE (a one-off 401 refreshes), and a second rejection before a sync worked
  with it is `access_denied` — token cleared, banner up — until the rig sets another token
  (`__mokuroCloudTestHooks.setCloudTestToken('google', …)`). So a revoked-token spec just revokes
  in cloudsim; a refresh spec that EXPIRES the token sets a newly minted one first, as GIS would
  hand out.
- The driver refuses what the UI refuses: `renameSeries` renames the catalog card's series uuid
  only (its first row's) and throws `Nothing to rename`; `setSpineOffset` skips a value the shelf
  already shows; `editFirstBlock` on `original` throws (`persistLayerPageEdit`).
- `open(volumeId)` downloads a volume that is not on the device first, through the card's
  Download (`downloadQueue.queueVolume`, waited out), and answers `{ id }` — the uuid the
  download installed it under. Within v1 the rig's dav and api suites also call
  `showSeries(series)` (the catalog card's click: the series page, so its volume cards mark
  themselves shown for the OCR queue poller) and `pendingOcr(volumeId)` (what the card shows of
  the server's queue, `describePendingOcr`).
- The shared suite (the reader and a cloud Bunko on one folder) also calls
  `importVolume({ path, base64 })` — the upload modal's `importFiles` of `<Series>/<Volume>.cbz`
  as a folder pick names it, an image-only archive's review answered keeping its names
  (`defaultNaming` in `folder` mode) — and `backupVolume(volumeId)`: the card's Backup, awaited
  to the end of its run (`backupQueueSettled`, `util/backup-queue.ts`: the upload, then the run's
  listing and its `series.json`/`catalog.json` writes), answering `{ cloudPath }` or the
  failure THIS run recorded (`uploadFailures` keeps a volume's failure until an upload of it
  succeeds, so one whose `at` did not move is an earlier run's).
- `settleSeriesWrites()` (the spine offset scenario) runs every queued `series.json` write now
  and waits out those in flight (`settleSeriesFileWrites`, `metadata/series-file-sync.ts`), so a
  spec counts the writes a sync caused without waiting out the 2 s debounce.
- An interop build reaches no host off the machine but the ones the config names: the rig
  refuses every other request and FAILS the spec that made it (only `apis.google.com/js/api.js`
  and `accounts.google.com/gsi/client`, which `google-scripts.ts` injects on demand, are
  answered, empty). So
  `src/lib/interop/hermetic.ts` (`INTEROP_BUILD`, MODE interop only — Vitest keeps it off) skips
  the Noto Sans JP web font, and `src/hooks.server.ts` serves the shell without `app.html`'s
  other absolute addresses (the font host's preconnects, the jidoujisho icon). A new third-party
  fetch needs the same treatment, or the rig fails.
- Local rig runs pass `--reader-dir <this worktree>`; `interop/reader.ref` must name a pushed commit.
- CI (`.github/workflows/interop.yml`, job `rig`): PRs into `main`, `develop` and
  `feat/cloud-bunko`, nightly for `develop` and `feat/cloud-bunko`, and on demand, only where
  `rig-driver.ts` exists (else shown skipped). Bunko is the nightly pre-release `BUNKO_REF` maps
  to (`0.8/remote-storage` → `nightly-0.8`, `main` → `nightly`, checked out at its `bunko_sha`),
  built from source for any other branch. It runs Bunko's six legs as six jobs per target
  (`local` = dav,api; each of google/microsoft/mega/rclone = bridge,direct,shared; `cloud` on
  all; 60 min each — all 18 pairs in one job took 49 min locally), each one
  `cargo xtask interop rig <suites> --provider <p>` with `--reader-dir` on the PR's checkout,
  and uploads the results as `rig-<target>-<leg>` on every run.

### E2E (Playwright)

- `npm run test:e2e` runs `e2e/*.spec.ts`. The config starts (or **silently reuses**) a dev server on port 5173.
- **Multi-worktree caveat**: if another worktree's dev server already owns 5173, the suite would run against that worktree's code. Set `E2E_PORT=<free port>` to start a dedicated server for the current worktree.
- `E2E_CHROMIUM=/path/to/chrome` points Playwright at an existing browser binary instead of downloading one (e.g. a build under `~/.cache/ms-playwright/`).
- The zoom specs import production modules (`zoom-controller.ts`, `zoom-layout.ts`, `page-detection.ts`) through the Vite dev server and drive them against synthetic page strips.

## Common Development Tasks

### Adding a New Settings Option

1. Add the setting to the `Settings` type in `src/lib/settings/settings.ts`
2. Add default value to `defaultSettings` constant
3. Update the settings UI component (e.g., ReaderToggles.svelte, ReaderSelects.svelte)
4. Use the setting via the `currentSettings` derived store

### Adding Cloud Sync Features

The sync system (`src/lib/util/sync/`) uses a provider abstraction. To extend:

1. For provider-specific features: modify the provider in `providers/<name>/`
2. For cross-provider features: update `unified-sync-service.ts`
3. New providers must implement the `SyncProvider` interface from `provider-interface.ts`

### Working with IndexedDB

Always use the Dexie instance from `src/lib/catalog/db.ts`:

```typescript
import { db } from '$lib/catalog/db';

// Query volumes
const volumes = await db.volumes.toArray();
const volume = await db.volumes.get(volume_uuid);

// Get OCR and files separately (V3 split tables)
const ocr = await db.volume_ocr.get(volume_uuid);
const files = await db.volume_files.get(volume_uuid);

// Update volume metadata
await db.volumes.update(volume_uuid, { series_title: newTitle });
```

## Extension Compatibility & DOM Keying

This app is designed for Japanese learning extensions (Yomitan, Migaku, etc.) that manipulate text content in the DOM. These extensions can interfere with Svelte's reactivity.

### The Problem

Japanese learning extensions aggressively mutate the DOM:

- **Yomitan**: Wraps text in `<span>` tags for dictionary lookups (relatively clean)
- **Migaku**: Aggressively mutates text based on user settings (very invasive)
  - Causes text carryover between manga pages
  - Prevents UI elements from updating correctly
  - Modifies settings panel controls

### The Solution: Keyed Blocks

Use Svelte's `{#key}` blocks to force DOM recreation when extensions interfere. When a key changes, Svelte destroys the old DOM and creates a fresh one, bypassing extension mutations.

**Why This Works for This App:**

- Page changes are discrete user actions (not continuous scrolling)
- No form state to preserve during reading
- Performance cost acceptable for intentional page transitions
- Extensions can't carry stale state across fresh DOM nodes

### Required Keying

**Manga Page Layout** (prevents text carryover):

```svelte
{#key currentPage}
  <MangaPage {pageData} />
{/key}
```

**Status Indicators** (counters, timers, badges):

```svelte
{#key tokenMinutesLeft}
  <span>{tokenMinutesLeft}m</span>
{/key}
```

**Any Dynamic Text** that extensions modify and needs to stay fresh.

### Where Keying Doesn't Help

**Settings Panel**: Migaku modifies the controls themselves, not just their parents. Keying the parent doesn't prevent this. Known issue with no current workaround.

### When NOT to Use Keyed Blocks

Don't use keyed blocks for:

- Form inputs (will lose focus/state)
- Large component trees (performance impact)
- Static content (unnecessary)
- Content that SHOULD persist across updates

### Testing

Test with Migaku enabled to catch DOM mutation issues.

## Git Workflow

### Worktree-Based Development (REQUIRED)

**CRITICAL**: This repository uses git worktrees for ALL development work. The main working directory must remain on the `main` branch at all times.

**Rules:**

- The main directory (`/home/nathan/Projects/mokuro-reader`) must ALWAYS stay on `main` branch
- NEVER create feature branches or make commits directly in the main directory
- All changes must be made through git worktrees in `/home/nathan/Projects/mokuro-reader-worktrees/`

**Starting new work:**

```bash
# Create a new worktree for a feature/fix
git worktree add ../mokuro-reader-worktrees/<branch-name> -b <branch-name>

# Or check out an existing remote branch
git worktree add ../mokuro-reader-worktrees/<branch-name> <branch-name>
```

**If asked to make changes without worktree context**: Automatically create an appropriate worktree (e.g., `fix/<issue>` or `feat/<feature>`) and work there. Do not prompt—just create it and proceed.

**Future note**: The protected branch will eventually move from `main` to `develop`.

### General Git Practices

**Don't auto-push during active development**: If `npm run dev` or `npm run preview` is running, the user is actively iterating on changes. Only commit locally and wait for explicit instruction to push. This keeps the commit history clean and allows for squashing/amending before pushing.

**Branch workflow**: Development happens on `develop`. Merge into `main` for releases.

## Known Issues and Considerations

- Cloud provider auth tokens may expire (Google Drive ~1 hour, others vary)
- Large volume imports may cause memory pressure on low-end devices
- Text selection in reader requires special handling to not conflict with drag panning
- Migaku extension aggressively mutates DOM and can interfere with UI controls
