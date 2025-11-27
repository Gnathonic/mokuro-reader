import { browser } from '$app/environment';
import { writable } from 'svelte/store';
import { CatalogDexieV3, getV3Database, startThumbnailProcessing } from './db-v3';

// Re-export the v3 database class
export { CatalogDexieV3 };

// Legacy upgrade store (kept for backward compatibility)
export const isUpgrading = writable(false);

// Export the singleton v3 database instance
export const db = getV3Database();

// Re-export thumbnail processing
export { startThumbnailProcessing };

// Start thumbnail processing on module load
if (browser) {
  startThumbnailProcessing();
}
