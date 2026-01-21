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
- **Panzoom**: Pan/zoom functionality for manga pages
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
│   ├── panzoom/         # Custom pan/zoom implementation
│   ├── reader/          # Core reader logic
│   ├── settings/        # Settings stores and profiles
│   ├── styles/          # Shared CSS styles
│   ├── types/           # TypeScript type definitions
│   ├── upload/          # Legacy upload utilities
│   ├── util/            # Utilities
│   │   └── sync/        # Multi-provider cloud sync
│   │       └── providers/
│   │           ├── google-drive/
│   │           ├── mega/
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

| Provider     | Auth Method          | Status       |
| ------------ | -------------------- | ------------ |
| Google Drive | OAuth2 implicit flow | Full support |
| MEGA         | Email/password       | Full support |
| WebDAV       | URL + credentials    | Full support |

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

The application uses a V3 database (`mokuro_v3`) with Dexie. Data is split across three tables for performance:

| Table          | Primary Key   | Indexed Fields                | Purpose                     |
| -------------- | ------------- | ----------------------------- | --------------------------- |
| `volumes`      | `volume_uuid` | `series_uuid`, `series_title` | Metadata, thumbnails        |
| `volume_ocr`   | `volume_uuid` | —                             | OCR page data (text blocks) |
| `volume_files` | `volume_uuid` | —                             | Image files (File objects)  |

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

### Text Selection Handling

The reader has complex text selection logic to prevent interference with panzoom drag:

- `beforeMouseDown` handler in MangaPage.svelte checks if click is on text
- Text selection is only allowed within text boxes, not on background
- See `src/routes/[manga]/[volume]/+page.svelte` for implementation

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

Create a `.env.local` file for Google Drive integration:

```
VITE_GDRIVE_CLIENT_ID=your_client_id
VITE_GDRIVE_API_KEY=your_api_key
```

These are only required for Google Drive sync. MEGA and WebDAV don't require env vars.

## Testing

- Tests use Vitest with jsdom environment
- Component tests use @testing-library/svelte
- Run tests with `npm test`
- Example test files: `src/lib/util/count-chars.test.ts`, `src/lib/components/Settings/__tests__/QuickAccess.test.ts`

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

**Always use rebase when merging PRs to upstream**: When merging a PR from this fork to `ZXY101/mokuro-reader`, always use `--rebase`:

```bash
gh pr merge <PR_NUMBER> --repo ZXY101/mokuro-reader --rebase
```

This keeps commit SHAs identical between repos and avoids the fork falling "behind" by a merge commit. After merging, sync local main:

```bash
git fetch upstream && git reset --hard upstream/main && git push origin main
```

## Known Issues and Considerations

- Cloud provider auth tokens may expire (Google Drive ~1 hour, others vary)
- Large volume imports may cause memory pressure on low-end devices
- Text selection in reader requires special handling to not conflict with panzoom
- Migaku extension aggressively mutates DOM and can interfere with UI controls
