import { browser } from '$app/environment';
import { initGoogleDriveApi } from '$lib/util';

// Initialize services that should be available app-wide
export function load() {
  if (browser) {
    // Initialize Google Drive API
    initGoogleDriveApi().catch(error => {
      console.error('Failed to initialize Google Drive API:', error);
    });
    
    // Start thumbnail processing
    import('$lib/catalog/thumbnails');
  }
  
  return {};
}