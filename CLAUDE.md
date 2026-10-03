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

The app writes `.mokuro` files in this pure upstream format — no reader-specific
keys. Series-level data lives beside them in `series.json`.

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
`classifyMokuroSidecar` (`src/lib/util/sync/syncable-file.ts`) tells a listed
`.mokuro` apart from a layer file the same way it always disambiguated dotted
volume titles — by checking which stems have a `.cbz` in the same folder
listing — and `src/lib/metadata/layer-sync.ts` syncs layers for rows that
already exist locally (installed or metadata-only), newest-wins, no merge. A
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
(else the tombstone stays), a push removes the `.gz` it superseded
(best-effort, retried by later listings), and the volume delete/rename sweeps
corroborate per layer id so both copies ride together.

`.mokuro` files themselves stay pure upstream format regardless of which
layer produced them. A `gcv` or `tr-<lang>` layer from the removed
experimental client-side OCR/translation engines still lists, displays and
deletes like any other layer — `KNOWN_ENGINE_IDS` (`reader/edit/layers.ts`)
and `isTranslationLayerId` (`layer-kind.ts`) keep classifying those ids
correctly on purpose, for devices that still have them in IndexedDB.

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
  (backup — worker and main-thread —, the sidecar backfill incl. edited
  volumes' re-uploads, a rename's regenerated sidecar; `mokuro-upload-record.ts`).
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
- **Provenance of an unedited primary.** Replaced either way (the owner wants
  pre-existing OCR upgraded), but what is kept depends on where it came from.
  Attested as THIS cloud's file (`mokuro_sha256` + a `mokuro_sha256_cloud`
  naming the current provider) → it is only an older revision of the cloud's
  own file: replaced outright. Anything else — a local re-import after
  re-running mokuro, an archive's EMBEDDED `.mokuro`, a legacy row with no
  hash, an attestation for another provider — may be OCR the cloud never had:
  first kept as the local `previous-ocr` layer ("Previous OCR", kind `ocr`,
  `source_sha256` = the replaced hash when there was one, `source_at` =
  `updated_at`). While untouched it follows the same rules as an untouched
  `updated-ocr` (`isUntouchedUpgradeLayer`, `mokuro-hash.ts`): never pushed
  (`layerNeedsPush`), never exported or embedded (`compress-volume.ts`,
  `volume-sidecars.ts`), and a later replacement overwrites it in place. Once
  the user edits it, it is theirs: the next keepsake goes under
  `previous-ocr-2`, `-3`, ….
- **A replacement drops the snapshots it made stale.** An unedited row can
  still hold an `original` layer (the pre-edit snapshot of the OLD OCR, from
  layer-sync or a reinstall) and an untouched `updated-ocr`; after the swap,
  Revert would restore the pre-upgrade OCR and promoting the `updated-ocr`
  would adopt an old hash. Both are deleted with the replacement (the
  `original`'s cloud copy tombstoned via `notePendingLayerDelete`, so no
  listing pulls it back); an `updated-ocr` the user edited stays.
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
  maintenance never cost a PUT there.

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

| Data                                                        | File                                      | Merge key                              |
| ----------------------------------------------------------- | ----------------------------------------- | -------------------------------------- |
| Read progress, per-volume settings                          | `volume-data.json` (volume uuid keys)     | `lastProgressUpdate` per volume        |
| Series reading state (`read_count`, re-read mute, tracking) | `volume-data.json` → `series` section     | `lastUpdated` per `series_key`         |
| Settings profiles                                           | `profiles.json`                           | `lastUpdated` per profile              |
| Series facts (link, titles, synonyms, tag, unit)            | `<Series>/series.json` (+ `catalog.json`) | `updated_at` = the facts stamp         |
| Shelf alignment (`spine_offset`, per-volume `offset`)       | `<Series>/series.json` (index fields)     | local wins, else the published value   |
| Primary OCR identity (`mokuro_sha256`)                      | `<Series>/series.json` (index field)      | rides with its file's `mokuro_*` stamp |
| Volume completion date (`completedAt`)                      | `volume-data.json` (volume uuid keys)     | rides the whole-entry volume merge     |
| Reading goals, custom goals, closed-period snapshots        | `goals.json`                              | `lastUpdated` per key; snapshots union |
| Per-volume reading deadlines                                | `goals.json` → `volumeDeadlines`          | `lastUpdated` per volume uuid          |

Read progress, the series section, settings profiles and goals all sync
automatically on every `syncProvider` call — there is no per-file opt-in and no
separate "Sync profiles" button; `profiles.json` and `goals.json` ride along
unconditionally, the same way `volume-data.json` always has. Goals sync AFTER
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
("restart series"), `forget` (delete stats). Record through `recordEvent`,
which never throws and loads the DB module lazily (`volume-data.ts` imports
it; many suites mock `dexie` bare). Phase 1 only writes: nothing reads the
events yet, and `recentPageTurns`/`timeReadInMinutes` still drive every stat.

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

### Cloud covers

`requestCover(vol)` (`src/lib/catalog/cover-service.ts`) is the only way anything obtains a
cloud cover: surfaces through `createCoverClaims`, the series-open pass through
`installCoversForSeries` (a candidate builder), the backfill's stale refresh with
`{ refresh: true }`. Its ladder: fresh row thumbnail → cached in `cloud_covers` (PROMOTED
onto the row when the volume is metadata-only AND read, `coverBelongsOnRow`) → fetch. The
write queue (`cover-persist.ts`) routes by the same predicate. Never fetch or write a cover
from anywhere else. Synced-progress rows are minted after every progress sync
(`resolveSyncedProgress`), never from a view mount.

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
