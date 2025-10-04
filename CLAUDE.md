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

### Node.js Version Requirement
**IMPORTANT**: This project requires Node.js 18.x. It is not compatible with Node.js 19+ or earlier versions. Use `nvm use` (an `.nvmrc` file is present) or manually switch to Node 18.

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

#### **CRITICAL: Svelte 5 Store Subscription Patterns**

**NEVER use manual `.subscribe()` calls inside `$effect()` in Svelte 5 components. This causes circular dependency errors.**

❌ **WRONG - DO NOT USE:**
```svelte
let value = $state('');
$effect(() => {
  return someStore.subscribe(v => { value = v; });
});
```

❌ **WRONG - DO NOT USE:**
```svelte
let value = $state('');
$effect(() => {
  const unsub = someStore.subscribe(v => { value = v; });
  return unsub;
});
```

✅ **CORRECT - Use `$derived` with store auto-subscription:**
```svelte
let value = $derived($someStore);
```

✅ **CORRECT - Direct store access in templates:**
```svelte
<p>{$someStore}</p>
```

✅ **CORRECT - For objects with store properties, extract first:**
```svelte
const store = objectWithStore.store;  // Extract the store reference
let value = $derived($store);         // Then use $ prefix
```

❌ **WRONG - Cannot use $ on property chains:**
```svelte
let value = $derived($objectWithStore.store);  // ERROR!
```

**This pattern applies to ALL stores including:**
- `tokenManager.token` → Use `accessTokenStore` export instead
- `driveFilesCache.store` → Extract to `const cache = driveFilesCache.store` first
- `progressTrackerStore` → Use `$progressTrackerStore` directly
- Any writable/readable/derived store

**Common errors indicating this issue:**
- "Cannot access 'or' before initialization"
- "e.subscribe is not a function"
- Circular dependency errors
- Navigation/UI elements not responding to clicks

### Google Drive Integration

Located in `src/lib/util/google-drive/`, the integration is modular:

- **token-manager.ts**: OAuth token lifecycle, automatic refresh attempts, expiry monitoring
- **api-client.ts**: Google Drive API wrapper with error handling
- **sync-service.ts**: Sync read progress and merge local/cloud data
- **constants.ts**: Configuration and storage keys
- **types.ts**: TypeScript types

The implementation uses Google's OAuth2 implicit flow (access tokens only, no refresh tokens since there's no backend). Tokens expire after ~1 hour but the system attempts automatic renewal and shows user-friendly warnings.

**Important**: The `prompt` parameter in OAuth requests determines the user experience:
- `prompt: 'consent'` - Forces full consent screen every time (use only for initial sign-in)
- `prompt: ''` (empty) - Minimal UI, reuses existing permissions (use for re-authentication after token expiry)
- `silent: true` - Attempts completely silent refresh with no UI

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

## Known Issues and Considerations

- Google Drive auth expires every hour (access token limitation without backend), but re-auth should be minimal (just account selection, not full consent)
- Large volume imports may cause memory pressure on low-end devices (use throttle mode)
- Service worker caching can interfere with Google Drive downloads (cleared automatically)
- Text selection in reader requires special handling to not conflict with panzoom
