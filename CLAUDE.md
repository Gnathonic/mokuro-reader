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

### Preview Server Port Management

**CRITICAL**: The preview server MUST always run on port 4173 for Google OAuth to work correctly.

Before starting a new preview server:

1. Kill all existing preview processes to free up port 4173
2. Use these commands to find and kill processes:

```bash
# Find process on port 4173
netstat -ano | findstr :4173 | awk '{print $5}' | head -1

# Kill the process (replace PID with actual process ID)
taskkill //F //PID <PID>

# Kill processes on multiple ports if needed (4173-4178)
netstat -ano | findstr :4174 | awk '{print $5}' | head -1 | xargs -I {} taskkill //F //PID {}
```

3. Then start the preview server: `npm run preview`

**Why this matters**: Vite's preview server auto-increments the port if 4173 is occupied. Google OAuth is configured for localhost:4173 specifically, so any other port will break authentication.

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
│   ├── catalog/         # Volume library management (Dexie DB, thumbnails)
│   ├── reader/          # Core reader logic
│   ├── settings/        # Settings stores and profiles
│   ├── anki-connect/    # Anki integration for vocabulary mining
│   ├── panzoom/         # Custom pan/zoom implementation
│   ├── upload/          # File import and processing
│   ├── workers/         # Web Workers for background tasks
│   ├── util/            # Utilities including Google Drive sync
│   │   └── google-drive/ # Modular Google Drive API integration
│   ├── components/      # Svelte components
│   └── types/           # TypeScript type definitions
├── routes/
│   ├── +page.svelte              # Home/catalog page
│   ├── [manga]/+page.svelte      # Manga series volume list
│   ├── [manga]/[volume]/+page.svelte  # Reader page
│   ├── upload/+page.svelte       # Upload page
│   └── cloud/+page.svelte        # Google Drive sync page
└── app.d.ts             # App-level type definitions
```

### State Management

- **Svelte Stores**: Primary state management (writable, derived, readable stores)
- **LocalStorage Sync**: Many stores use `syncStore` utility to persist to localStorage
- **Key Stores**:
  - `volumes` (settings/volume-data.ts): Read progress tracking per volume
  - `currentSettings` (settings/settings.ts): Reader settings per volume
  - `profiles` (settings/settings.ts): User profiles with different settings
  - `miscSettings` (settings/misc.ts): Global app settings
  - Token stores in `google-drive/token-manager.ts`: OAuth tokens and auth state

### Google Drive Integration

Located in `src/lib/util/google-drive/`, the integration is modular:

- **token-manager.ts**: OAuth token lifecycle, automatic refresh attempts, expiry monitoring
- **api-client.ts**: Google Drive API wrapper with error handling
- **sync-service.ts**: Sync read progress and merge local/cloud data
- **constants.ts**: Configuration and storage keys
- **types.ts**: TypeScript types

The implementation uses Google's OAuth2 implicit flow (access tokens only, no refresh tokens since there's no backend). Tokens expire after ~1 hour but the system attempts automatic renewal and shows user-friendly warnings.

**IMPORTANT - Query String Escaping**: When constructing Google Drive API queries with file or folder names, **always** use the `escapeNameForDriveQuery()` function from `api-client.ts`. This escapes special characters (backslashes and single quotes) that would otherwise cause API errors. Never manually escape names or construct queries without this function.

```typescript
import { escapeNameForDriveQuery } from '$lib/util/google-drive/api-client';

// ✅ Correct
const escapedName = escapeNameForDriveQuery(folderName);
const query = `name='${escapedName}' and ...`;

// ❌ Wrong - will fail with names containing apostrophes
const query = `name='${folderName}' and ...`;
```

**Important**: The `prompt` parameter in OAuth requests determines the user experience:

- `prompt: 'consent'` - Forces full consent screen every time (use only for initial sign-in)
- `prompt: ''` (empty) - Minimal UI, reuses existing permissions (use for re-authentication after token expiry)
- `silent: true` - Attempts completely silent refresh with no UI

**Google Drive API Query Pattern**:

- Our broad queries like `(name contains '.cbz' or mimeType='folder') and trashed=false` are intentionally designed this way
- Google automatically scopes results to only what the app has permission to access - we don't need manual folder restrictions
- This pattern (broad query + client-side filtering) is the CORRECT approach - it minimizes API calls while working within OAuth permission constraints
- If you think folder scoping might be needed, ask first - broad queries are almost always the right solution

**Svelte 5 Reactive Performance**:

- `$derived` and `$derived.by()` functions run for EVERY instance of a component
- If a component appears N times (e.g., BackupButton for each volume), operations inside derived run N times
- Expensive operations or console logging in derived can cause severe performance issues with repeated components
- Debug logging is fine when actively debugging an issue, but MUST be removed once that issue is addressed or when switching focus to other work

### Worker Pool Pattern

The application uses Web Workers for parallel downloads from Google Drive:

- **worker-pool.ts**: Manages multiple worker instances with memory limits
- **download-worker.ts**: Handles individual file downloads and ZIP extraction
- Memory management prevents overwhelming the browser during large batch downloads
- Configurable concurrency and throttling for low-memory devices

### Database Migrations

Dexie handles schema migrations. Current version is 2:

- Version 1: Old `catalog` table (deprecated)
- Version 2: Split into `volumes` (metadata) and `volumes_data` (pages/files)

When adding new fields or tables, increment the version number and provide an upgrade function.

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

Create a `.env` file for Google Drive integration:

```
VITE_GDRIVE_CLIENT_ID=your_client_id
VITE_GDRIVE_API_KEY=your_api_key
```

These are required for Google Drive features to work.

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

### Adding Google Drive Features

The Google Drive module is already refactored. To extend:

1. Add new API methods to `api-client.ts`
2. Add new sync logic to `sync-service.ts`
3. Update types in `types.ts`
4. Expose functionality via `index.ts`

### Working with IndexedDB

Always use the Dexie instance from `src/lib/catalog/db.ts`:

```typescript
import { db } from '$lib/catalog/db';

// Query volumes
const volumes = await db.volumes.toArray();

// Add a volume
await db.volumes.add(volumeMetadata);

// Update a volume
await db.volumes.update(volume_uuid, { thumbnail: newThumbnail });
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

- Google Drive auth expires every hour (access token limitation without backend), but re-auth should be minimal (just account selection, not full consent)
- Large volume imports may cause memory pressure on low-end devices (use throttle mode)
- Service worker caching can interfere with Google Drive downloads (cleared automatically)
- Text selection in reader requires special handling to not conflict with panzoom
