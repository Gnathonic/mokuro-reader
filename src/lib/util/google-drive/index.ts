import { writable } from 'svelte/store';
import { tokenManager } from './token-manager';
import { driveApiClient, DriveApiError } from './api-client';
import { syncService } from './sync-service';
import { driveState } from './drive-state';
import { GOOGLE_DRIVE_CONFIG } from './constants';
import { providerManager } from '../sync/provider-manager';
import { unifiedCloudManager } from '../sync/unified-cloud-manager';
import { driveFilesCache } from './drive-files-cache';

// Re-export the main modules
export { tokenManager, driveApiClient, DriveApiError, syncService, driveState, GOOGLE_DRIVE_CONFIG, driveFilesCache };
export type { TokenInfo, DriveFile, SyncProgress } from './types';
export type { DriveState } from './drive-state';
export type { DriveFileMetadata } from './drive-files-cache';

// Backward compatibility exports for old API
// TODO: Migrate cloud/+page.svelte to use tokenManager, syncService directly
export const accessTokenStore = tokenManager.token;
export const tokenClientStore = tokenManager.tokenClient;
export const readerFolderIdStore = syncService.readerFolderId;
export const volumeDataIdStore = writable<string>(''); // Legacy - not used by new implementation
export const profilesIdStore = writable<string>(''); // Legacy - not used by new implementation

// Constants compatibility
export const CLIENT_ID = GOOGLE_DRIVE_CONFIG.CLIENT_ID;
export const API_KEY = GOOGLE_DRIVE_CONFIG.API_KEY;
export const READER_FOLDER = GOOGLE_DRIVE_CONFIG.FOLDER_NAMES.READER;

// Initialize the Google Drive API
export async function initGoogleDriveApi(): Promise<void> {
  try {
    await driveApiClient.initialize();

    if (tokenManager.isAuthenticated()) {
      // Set flag to sync after login
      localStorage.setItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.SYNC_AFTER_LOGIN, 'true');

      console.log('Google Drive API initialized with authenticated token');
    }
  } catch (error) {
    console.error('Failed to initialize Google Drive API:', error);
    throw error;
  }
}

// Convenience functions for external use
export function signInToGoogleDrive(): void {
  if (!tokenManager.isAuthenticated()) {
    // Will auto-detect if first-time (consent) or re-auth (minimal)
    // Cache fetch happens automatically in token manager callback
    // Provider status will be updated automatically in token manager callback
    tokenManager.requestNewToken(false, false);
  }
}

export async function signOutFromGoogleDrive(): Promise<void> {
  await tokenManager.logout();
  unifiedCloudManager.clearCache();
  providerManager.updateStatus();
}

export function isSignedIn(): boolean {
  return tokenManager.isAuthenticated();
}

export async function syncReadProgress(): Promise<void> {
  await syncService.syncReadProgress();
}

// Backward compatibility aliases
export const signIn = signInToGoogleDrive;
export const logout = signOutFromGoogleDrive;