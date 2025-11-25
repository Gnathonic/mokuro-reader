import { browser } from '$app/environment';

// Disable SSR - this app requires IndexedDB and other browser APIs
export const ssr = false;

// Initialize services that should be available app-wide
export function load() {
  if (browser) {
    // Start thumbnail processing
    import('$lib/catalog/thumbnails');

    // Note: Provider initialization (Google Drive, MEGA, WebDAV) is handled by
    // +layout.svelte's initializeProviders() call, which includes conditional checks
    // to skip initialization when no credentials are present
  }

  return {};
}
