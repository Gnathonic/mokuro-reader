import { tokenManager } from './token-manager';
import { GOOGLE_DRIVE_CONFIG } from './constants';

// tokenManager is used by cloud page, CloudView, NavBar
export { tokenManager };

// READER_FOLDER used by cloud page and CloudView UI display (via $lib/util re-export)
export const READER_FOLDER = GOOGLE_DRIVE_CONFIG.FOLDER_NAMES.READER;

// syncReadProgress is used by cloud page and CloudView (via $lib/util re-export)
export async function syncReadProgress(): Promise<void> {
  // Use unified sync manager for progress sync (dynamic import to avoid circular dependency)
  const { unifiedCloudManager } = await import('../../unified-cloud-manager');
  await unifiedCloudManager.syncProgress({ silent: false });
}
