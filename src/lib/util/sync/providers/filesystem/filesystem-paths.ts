/**
 * Pure path helpers for the filesystem provider.
 * Paths are POSIX-style, relative to the picked root directory.
 */

export function splitPathSegments(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

export function getBasename(path: string): string {
  const segments = splitPathSegments(path);
  return segments.length === 0 ? '' : segments[segments.length - 1];
}

export function getParentPath(path: string): string {
  const segments = splitPathSegments(path);
  return segments.slice(0, -1).join('/');
}

const SYNCABLE_EXTENSIONS = ['.cbz', '.mokuro', '.mokuro.gz', '.webp'];
const SYNCABLE_ROOT_FILENAMES = new Set(['volume-data.json', 'profiles.json']);

export function isSyncableFile(path: string): boolean {
  const basename = getBasename(path).toLowerCase();
  if (SYNCABLE_ROOT_FILENAMES.has(basename)) {
    return true;
  }
  return SYNCABLE_EXTENSIONS.some((ext) => basename.endsWith(ext));
}
