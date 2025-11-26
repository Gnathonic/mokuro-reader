import { writable } from 'svelte/store';
import { tokenManager } from './token-manager';
import { driveApiClient, DriveApiError } from './api-client';
import { driveState } from './drive-state';
import { GOOGLE_DRIVE_CONFIG } from './constants';
import { driveFilesCache } from './drive-files-cache';

// Re-export the main modules
export {
  tokenManager,
  driveApiClient,
  DriveApiError,
  driveState,
  GOOGLE_DRIVE_CONFIG,
  driveFilesCache
};
export type { TokenInfo, DriveFile, SyncProgress } from './types';
export type { DriveState } from './drive-state';
export type { DriveFileMetadata } from './drive-files-cache';

// Backward compatibility exports for old API
export const accessTokenStore = tokenManager.token;
export const tokenClientStore = tokenManager.tokenClient;
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
export async function signInToGoogleDrive(): Promise<void> {
  if (!tokenManager.isAuthenticated()) {
    // Initialize Drive API first (lazy load)
    await driveApiClient.initialize();

    // Will auto-detect if first-time (consent) or re-auth (minimal)
    // Cache fetch happens automatically in token manager callback
    // Provider status will be updated automatically in token manager callback
    tokenManager.requestNewToken(false);
  }
}

export async function signOutFromGoogleDrive(): Promise<void> {
  await tokenManager.logout();

  // Dynamic imports to avoid circular dependency
  const { unifiedCloudManager } = await import('../../unified-cloud-manager');
  const { providerManager } = await import('../../provider-manager');
  const { clearActiveProviderKey } = await import('../../provider-detection');

  unifiedCloudManager.clearCache();
  clearActiveProviderKey();
  providerManager.updateStatus();
}

export function isSignedIn(): boolean {
  return tokenManager.isAuthenticated();
}

export async function syncReadProgress(): Promise<void> {
  // Use unified sync manager for progress sync (dynamic import to avoid circular dependency)
  const { unifiedCloudManager } = await import('../../unified-cloud-manager');
  await unifiedCloudManager.syncProgress({ silent: false });
}

// Backward compatibility aliases
export const signIn = signInToGoogleDrive;
export const logout = signOutFromGoogleDrive;
