/**
 * The single source of truth for which files sync providers list and cache.
 * Shared by ALL five providers — do not fork per-provider copies again.
 *
 * Categories:
 * - CBZ archives (the volumes themselves)
 * - Sidecars: OCR data (.mokuro / .mokuro.gz) and thumbnails (.webp/.jpg/.jpeg)
 * - Root config files: volume-data.json (read progress), profiles.json
 *   (settings profiles), libraries.json (library definitions)
 */

const ROOT_CONFIG_FILENAMES = new Set(['volume-data.json', 'profiles.json', 'libraries.json']);
const SIDECAR_IMAGE_RE = /\.(webp|jpe?g)$/i;

function basenameOf(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? '';
}

export function isCbzFile(basename: string): boolean {
  return basename.toLowerCase().endsWith('.cbz');
}

export function isSidecarFile(basename: string): boolean {
  const lower = basename.toLowerCase();
  return lower.endsWith('.mokuro') || lower.endsWith('.mokuro.gz') || SIDECAR_IMAGE_RE.test(lower);
}

export function isRootConfigFile(basename: string): boolean {
  return ROOT_CONFIG_FILENAMES.has(basename.toLowerCase());
}

export function isSyncableFile(path: string): boolean {
  const basename = basenameOf(path);
  return isCbzFile(basename) || isSidecarFile(basename) || isRootConfigFile(basename);
}
