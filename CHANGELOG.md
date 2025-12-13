# Changelog

## [1.0.6] - 2025-12-12

### Fixed

- Made swipe page turn reliable on high-end mobile devices

## [1.0.5.8] - 2025-12-07

### Fixed

- Consistent wheel zoom step sizes between Chrome and Firefox with platform-aware speed adjustment
- Handle mokuro files with empty series name (falls back to volume name)
- Stop timer when paging into next/previous volume
- Double-clicking text boxes no longer triggers zoom
- Crop image popup now works on first page load without needing to page first
- Copying text from OCR boxes no longer has double linebreaks (fixes Yomitan Anki sentence capture)

### Reverted

- Rolled back mobile swipe/pinch-zoom changes from 1.0.6 that broke textbox touch visibility

## 1.0.5

### Patch Changes

- [#265](https://github.com/Gnathonic/mokuro-reader/pull/265) [`41ce39b`](https://github.com/Gnathonic/mokuro-reader/commit/41ce39b5c5d8602b536b60ee3fef0bab22391b78) Thanks [@Gnathonic](https://github.com/Gnathonic)! - Add detailed WebDAV error modal with network error troubleshooting. Shows collapsible sections for CORS, SSL, DNS, and connection issues with specific console error codes to look for and fix instructions.

## [1.0.4] - 2025-12-03

### Added

- Update banner now shows version diff (e.g., v1.0.3 → v1.0.4)
- Expandable "what's new" section in update banner fetches release notes from GitHub
- Link to full release notes on GitHub

### Fixed

- Fix cross-site imports via `/upload?manga=X&volume=Y` URLs (regression from hash router migration)
- Cross-site imports now use global progress tracker instead of dedicated page

## [1.0.3] - 2025-12-03

### Added

- Support anonymous WebDAV connections (blank username/password)
- Detect read-only WebDAV servers and hide write-dependent UI controls
- Show read-only badge on cloud page
- New import mismatch modal displays when mokuro pages don't match downloaded/uploaded files, showing missing or extra files

### Fixed

- Fix double-tap zoom not working in the reader
- Fix time tracking to work regardless of Timer visibility
- Fix stats page discrepancy between achievements, recent speed, and empty state notice
- Fall back to catalog when URL cannot be parsed
- Add missing leading slash in WebDAV upload path

## [1.0.2] - 2025-11-29

### Added

- "Update available" banner when a new service worker version is detected, allowing PWA users to update the app
- Add AVIF, TIFF, GIF, BMP support to upload and download
- Add extension-agnostic file matching for converted images (e.g., png→webp, jpg→avif)
- Fuzzy matching to align image files with mokuro page data when paths don't match exactly

### Fixed

- Fix inconsistent zoom step sizes between Chrome and Firefox
- Prevent scrollbars in reader by hiding document overflow
- Skip hotkey handling when user is in text inputs or inside settings drawer
- Skip hotkey handling when inside OCR text boxes for text selection
- Ignore letter key shortcuts when Ctrl/Alt/Meta is pressed
- Reset document scroll when settings menu scroll leaks through
- Fix reader exit/fullscreen buttons not showing after hash router migration

## [1.0.1] - 2025-11-27

### Added

- Hash-based SPA router - navigation no longer causes full page reloads, fixing PWA refresh issues
- V3 database schema with split tables for better performance
- Pica-based thumbnail generation for higher quality
- Configurable catalog stacking settings with presets (Default, Minimal, Expanded, Spine Showcase)
- Background thumbnail processing now reports progress via progress tracker

### Fixed

- Smart fallback system for thumbnail generation that handles mobile browser limitations
- Improve zoom behavior with symmetric scaling and bounds limits
- Remove panning wiggle room when content fits viewport
- Mark Spine Showcase as alpha and auto-reset on page load to prevent getting stuck

## [1.0.0] - 2025-11-25

### Cloud Integration

- Full integration with Google Drive, MEGA, and WebDAV - files uploaded show in the catalog as placeholders that can be downloaded in a single tap
- Automatic progress sync with the cloud - switch between devices and keep your read position and stats in sync
- Remembers Google Drive connection between sessions and can auto-prompt for token refresh
- Storage quota statistics (used/available storage) on cloud page for all providers

### Reading Experience

- Automatic dual/single page mode - switches based on screen orientation and whether the current image looks like a two-page spread
- Automatic resizing and wrapping if OCR text would be oversized
- Page preloading that doesn't block the UI, with paging animations
- Paging past the beginning or end of a volume loads the next/previous volume. If there are no more volumes, returns to series page
- Timer now pauses if you don't turn the page for 1-30 minutes (user configurable, default 5)
- Time left to finish estimate shown below the timer

### Stats & Analytics

- Reading Speed History page with read history, speed tracking, achievements, graphs, and motivational features
- Volumes now show character counts and time-to-finish estimates based on your reading speed
- Series page shows time left estimate based on your recent reading speed
- Volume text page for text analysis
- Series text page for text analysis

### Catalog & Navigation

- Series in the catalog now have up to 3 thumbnails stacked with a marker if you've finished reading
- Series page now has thumbnail view, sorting options, and time estimates
- Added sorting modes to series and catalog pages
- PWA file association for `.cbz` files - double-click to open directly in Mokuro
- Universal drag-and-drop support - drop files anywhere to import

### Keyboard Shortcuts

- N for night mode
- I for invert colors
- P for page mode
- C for cover toggle
- Z for zoom mode
- Esc to back out of current volume or series
- Up/Down keys now pan instead of page
- Scroll wheel behavior follows standards (toggle available to swap)

### Night Mode

- Automatic scheduling for night mode and invert colors - choose between Manual (hotkey) or Scheduled (time-based)
- Night mode filter now applies to settings dialog

### Performance & Reliability

- Rewrote database to be much more performant at scale - can now handle >2000 volumes with ease
- Restructured database to prevent out-of-memory errors when editing long series
- Much more robust handling of file and folder names
- Handles more arrangements of zips, cbzs, files, folders, and mokuro files - much better at importing
- Support for importing volumes without .mokuro files (image-only)
- Prevent browser running out of memory during large file uploads
- Lazy-loading of cloud provider modules to reduce initial bundle size

### Framework Updates

- Updated to latest Svelte and Node versions
- Tailwind CSS v4 and Flowbite-Svelte v1 upgrade

### Bug Fixes

- Fix reactivity race conditions causing UI flashes in reader and catalog
- Fix MEGA auto-sync cache staleness issues
- Fix page turn animation wiping in wrong direction
- Fix IndexedDB deadlock during volume deletion
- Fix Timer crash when navigating between volumes
- Fix Google Drive OAuth not initializing when token is expired

## [0.9.1] - 2024-05-18

### Added

- Google Drive integration - sync volume data and profiles to the cloud
- Profile uploading to Google Drive
- Catalog search
- Manga extracting (export volumes)
- exSTATic support
- Jidoujisho support
- Single volume deletion
- Manual timer controls
- Misc settings

### Fixed

- Fix spacebar navigation
- Fix volume sorting
- Fix zip image ordering
- Fix file import ordering
- Prevent edge swipe in reader
- Various QOL improvements

## [0.9.0] - 2023-10-05

### Added

- Core manga reader with panzoom controls
- Mokuro OCR text overlay support
- Catalog with drag and drop upload
- ZIP/CBZ file support
- Settings system with volume-specific overrides
- Double page mode with cover page handling
- Progress tracking per volume
- Profile import/export
- Stats tracking
- Anki Connect integration
- About section

This was the first public release of Mokuro Reader by ZXY101.
