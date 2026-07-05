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

export { isSyncableFile } from '../../syncable-file';
