/**
 * Returns true when the current environment supports the File System Access API
 * (specifically `window.showDirectoryPicker`). Chromium-based browsers only.
 */
export function isFilesystemProviderSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}
