/**
 * The single source of truth for which files sync providers list and cache.
 * Shared by ALL five providers — do not fork per-provider copies again.
 *
 * Categories:
 * - CBZ archives (the volumes themselves)
 * - Sidecars: OCR data (.mokuro / .mokuro.gz), thumbnails (.webp/.jpg/.jpeg)
 *   and the per-series index `<Series Title>/series.json`
 * - Root config files: volume-data.json (read progress + series-level reading
 *   state) and profiles.json (settings profiles), plus catalog.json (the
 *   compiled library index)
 *
 * `series.json` is a sidecar of the SERIES FOLDER, not of a volume: it is the
 * only sidecar whose basename does not start with a volume title, so anything
 * pairing sidecars to volumes by `<Series>/<Volume>.<ext>` (the cloud manager's
 * managed-file matcher, the placeholder generator) skips it by construction.
 *
 * libraries.json is deliberately NOT listed: it belonged to the removed
 * libraries feature. Stale copies may still exist in users' cloud folders —
 * keep ignoring them.
 */

import { CATALOG_FILE_NAME, isCatalogFilePath } from '$lib/metadata/catalog-file';
import { SERIES_FILE_NAME, isSeriesFilePath } from '$lib/metadata/series-file';

const ROOT_CONFIG_FILENAMES = new Set(['volume-data.json', 'profiles.json', CATALOG_FILE_NAME]);

// series-metadata.json is deliberately NOT listed: it was retired on 2026-08-23
// before ever shipping (facts moved to <Series>/series.json, reading state to
// volume-data.json's `series` section). A stale copy may still sit in a folder
// somebody synced from a dev build — keep ignoring it, exactly like libraries.json.

const SIDECAR_IMAGE_RE = /\.(webp|jpe?g)$/i;

function basenameOf(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? '';
}

export function isCbzFile(basename: string): boolean {
  return basename.toLowerCase().endsWith('.cbz');
}

export function isSidecarFile(basename: string): boolean {
  const lower = basename.toLowerCase();
  return (
    lower.endsWith('.mokuro') ||
    lower.endsWith('.mokuro.gz') ||
    SIDECAR_IMAGE_RE.test(lower) ||
    // Exact basename, never a suffix match: `my-series.json` is not ours.
    lower === SERIES_FILE_NAME
  );
}

export function isRootConfigFile(basename: string): boolean {
  return ROOT_CONFIG_FILENAMES.has(basename.toLowerCase());
}

export function isSyncableFile(path: string): boolean {
  const basename = basenameOf(path);
  return isCbzFile(basename) || isSidecarFile(basename) || isRootConfigFile(basename);
}

/**
 * Is this path one of the COMPILED metadata files — `<Series>/series.json` or
 * the root `catalog.json`?
 *
 * Writing them is best-effort by contract: on a bunko-backed library the server
 * compiles both, a scoped user's `catalog.json` PUT is rejected outright and a
 * `series.json` PUT is an update *request*. A rejection there says nothing about
 * whether the account can write progress or upload archives, so it must never
 * demote the provider to read-only, never clear stored credentials and never
 * surface UI. Progress (`volume-data.json`) and profiles are deliberately NOT
 * in this set: those are the user's own state, and a silent failure there
 * really is a problem worth surfacing.
 *
 * `catalog.json` only counts at the ROOT — a nested one is somebody else's file.
 */
export function isBestEffortMetadataPath(path: string): boolean {
  return isSeriesFilePath(path) || isCatalogFilePath(path);
}
