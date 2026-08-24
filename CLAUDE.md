# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Mokuro Reader is a web-based manga reader for [mokuro](https://github.com/kha-white/mokuro)-processed manga. It's a SvelteKit 5 application with offline support, stat tracking, and Google Drive sync capabilities.

## Development Commands

### Essential Commands

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run preview` - Preview production build
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

| Provider     | Auth Method                     | Status                |
| ------------ | ------------------------------- | --------------------- |
| Google Drive | OAuth2 implicit flow            | Full support          |
| MEGA         | Email/password (+ optional 2FA) | Full support          |
| WebDAV       | URL + credentials               | Full support          |
| OneDrive     | MSAL (OAuth2 auth code + PKCE)  | Full support          |
| Local Folder | Directory picker (no account)   | Desktop Chromium only |

**Architecture:**

- **provider-interface.ts**: Common `SyncProvider` interface all providers implement
- **provider-manager.ts**: Manages provider instances and state
- **unified-sync-service.ts**: Provider-agnostic sync logic
- **providers/**: Provider-specific implementations

**Google Drive specifics** (`providers/google-drive/`):

- Uses OAuth2 implicit flow (access tokens only, ~1 hour expiry)
- `escapeNameForDriveQuery()` must be used for file/folder names in API queries
- Broad queries + client-side filtering is the correct pattern (Google scopes by app permissions)

### Svelte 5 Reactive Performance

- `$derived` and `$derived.by()` run for EVERY component instance
- If a component appears N times, derived operations run N times
- Expensive operations or logging in derived causes severe performance issues
- Remove debug logging once the issue being debugged is resolved

### Worker Pool Pattern

The application uses Web Workers for parallel cloud downloads:

- **worker-pool.ts**: Manages multiple worker instances with memory limits
- **download-worker.ts**: Handles individual file downloads and ZIP extraction
- Memory management prevents overwhelming the browser during large batch downloads
- Configurable concurrency and throttling for low-memory devices

### Database Schema (V3)

The application uses a V3 database (`mokuro_v3`) with Dexie, currently at Dexie schema **version 4** (`db-v3.ts`; version 2 added `series_metadata`, version 3 added `series_index`, version 4 added `catalog_index` — all additive, no data migration). Volume data is split across three tables for performance, alongside per-series metadata and index tables:

| Table             | Primary Key   | Indexed Fields                | Purpose                                                                           |
| ----------------- | ------------- | ----------------------------- | --------------------------------------------------------------------------------- |
| `volumes`         | `volume_uuid` | `series_uuid`, `series_title` | Metadata, thumbnails                                                              |
| `volume_ocr`      | `volume_uuid` | —                             | OCR page data (text blocks)                                                       |
| `volume_files`    | `volume_uuid` | —                             | Image files (File objects)                                                        |
| `series_metadata` | `series_key`  | —                             | Per-series AniList link, titles, tag, tracking (key = normalized `series_title`)  |
| `series_index`    | `series_key`  | —                             | Cached `series.json` sidecar + cloud file stamp (download cache, unauthoritative) |
| `catalog_index`   | `series_key`  | —                             | Cached root `catalog.json` entry per series (names/facts only, download cache)    |

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

The app writes `.mokuro` files in this pure upstream format — no reader-specific
keys. Series-level data lives beside them in `series.json`.

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
    offset?: number                // px — per-volume shelf alignment, INDEX data
  }[]
}
```

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
  Inheritance is a JOIN, never an adoption: `series_metadata` stores only what
  this user edited, and a published alignment reaches the shelf from the cached
  `series_index` copy (`getSpineOffsets` returns `record ?? published`, per key)
  and rides back out through `buildSeriesFile`. Filling it into the record would
  make it ours to republish forever, so the device that measured it could never
  correct or reset it. Readers clamp both fields on parse (±50% / ±500px);
  mokuro-bunko stores whatever it is sent verbatim (one side owns the range
  rule).
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
  series folder. Gated on a writable connected provider and ≥1 backed-up
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
  background.
- **Import/export**: a `series.json` in an imported ZIP (or file selection) is
  applied after the volumes save; series ZIP and single-volume ZIP/CBZ exports
  include one built from the local volumes.
- **mokuro-bunko**: bunko compiles `series.json` and `catalog.json` itself and is
  their sole producer (see `docs/superpowers/plans/2026-08-23-catalog-distribution-bunko.md`);
  it must partition metadata files out of progress handling (root `.json` =
  progress/profiles, `<Series>/series.json` and root `catalog.json` = metadata).
  A scoped user's `series.json` PUT is accepted as an update REQUEST.

### Root `catalog.json`

The library's name/mapping/search data in one root file. It joins the same
root-config allowlist as `volume-data.json`/`profiles.json`
(`isRootConfigFile` in `syncable-file.ts`) — every provider lists, caches and
syncs it the same way — but for writes it is one of the two best-effort
compiled files, along with `series.json` (see Best-effort writes below).

### What syncs where

| Data                                                        | File                                      | Merge key                            |
| ----------------------------------------------------------- | ----------------------------------------- | ------------------------------------ |
| Read progress, per-volume settings                          | `volume-data.json` (volume uuid keys)     | `lastProgressUpdate` per volume      |
| Series reading state (`read_count`, re-read mute, tracking) | `volume-data.json` → `series` section     | `lastUpdated` per `series_key`       |
| Settings profiles                                           | `profiles.json`                           | `lastUpdated` per profile            |
| Series facts (link, titles, synonyms, tag, unit)            | `<Series>/series.json` (+ `catalog.json`) | `updated_at` = the facts stamp       |
| Shelf alignment (`spine_offset`, per-volume `offset`)       | `<Series>/series.json` (index fields)     | local wins, else the published value |

Read progress, the series section and settings profiles all sync automatically
on every `syncProvider` call — there is no per-file opt-in and no separate
"Sync profiles" button; `profiles.json` rides along unconditionally, the same
way `volume-data.json` always has.

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

### Modal Button Z-Index

**Always add `relative z-10` to action button containers in modals.**

Night mode applies a CSS `filter` to `<dialog>` elements (see `app.html`). The `filter` property creates a new stacking context, which resets all z-index relationships inside the dialog. Without explicit z-index, scrollable containers (`overflow: auto/scroll`) can capture click events instead of sibling button containers.

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
- `VITE_ONEDRIVE_CLIENT_ID`: required only for OneDrive sync. Register an
  Azure AD app (any Microsoft account tenant, "common" authority) and add the
  deploy origin as a **Single-page application** redirect URI. Scopes used:
  `Files.ReadWrite`, `offline_access`, `User.Read`. When unset, the OneDrive
  option is hidden from the cloud screen.
- `VITE_ANILIST_CLIENT_ID`: required only for pushing read progress to AniList.
  Register an AniList API client (implicit grant) whose redirect URL is the deploy
  origin with a trailing slash. Searching/linking series needs no key.
- MEGA, WebDAV, and Local Folder require no env vars.

## Testing

- Tests use Vitest with jsdom environment
- Component tests use @testing-library/svelte
- Run tests with `npm test`
- Example test files: `src/lib/util/count-chars.test.ts`, `src/lib/components/Settings/__tests__/QuickAccess.test.ts`

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
