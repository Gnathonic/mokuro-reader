/**
 * The single source of truth for which files sync providers list and cache.
 * Shared by ALL five providers — do not fork per-provider copies again.
 *
 * Categories:
 * - CBZ archives (the volumes themselves)
 * - Sidecars: OCR data (.mokuro / .mokuro.gz), thumbnails (.webp/.jpg/.jpeg)
 *   and the per-series index `<Series Title>/series.json`
 * - Root config files: volume-data.json (read progress), profiles.json
 *   (settings profiles), series-metadata.json (per-series AniList link,
 *   titles, tag, tracking)
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

import { SERIES_FILE_NAME } from '$lib/metadata/series-file';

const ROOT_CONFIG_FILENAMES = new Set([
  'volume-data.json',
  'profiles.json',
  'series-metadata.json'
]);
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
