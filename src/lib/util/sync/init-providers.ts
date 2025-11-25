import { browser } from '$app/environment';
import { providerManager } from './provider-manager';
import { googleDriveProvider } from './providers/google-drive/google-drive-provider';
import { megaProvider } from './providers/mega/mega-provider';
import { webdavProvider } from './providers/webdav/webdav-provider';
import { unifiedCloudManager } from './unified-cloud-manager';
import { driveApiClient } from '$lib/util/sync/providers/google-drive/api-client';
import { tokenManager } from '$lib/util/sync/providers/google-drive/token-manager';
import { GOOGLE_DRIVE_CONFIG } from '$lib/util/sync/providers/google-drive/constants';
import { getConfiguredProviderType } from './provider-detection';

/**
 * Initialize all sync providers and register them with the provider manager.
 * This should be called once on app startup.
 *
 * Strategy:
 * - Always register providers (needed for login buttons to work)
 * - Only initialize API for the active provider (since providers are mutually exclusive)
 * - Inactive providers will lazy-initialize when user clicks login
 */
export async function initializeProviders(): Promise<void> {
  // Always register all providers (so login buttons work, even if not logged in)
  providerManager.registerProvider(googleDriveProvider);
  providerManager.registerProvider(megaProvider);
  providerManager.registerProvider(webdavProvider);

  console.log('✅ Sync providers registered');

  // Check which provider (if any) is active
  // Providers are mutually exclusive - only one can be logged in at a time
  const activeProvider = getConfiguredProviderType();

  // If no provider is active, we're done - providers will lazy-init when user clicks login
  if (!activeProvider) {
    console.log('ℹ️ No active provider. Providers will initialize on login.');
    return;
  }

  // Only initialize Google Drive API if it's the active provider (for auto-restore)
  // MEGA and WebDAV handle their own initialization in whenReady()
  if (activeProvider === 'google-drive') {
    console.log('🔧 Initializing Google Drive API client for auto-restore...');
    try {
      await driveApiClient.initialize();
      console.log('✅ Google Drive API client initialized');

      // Check if token is expired and handle re-authentication
      const gdriveExpiry = localStorage.getItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.TOKEN_EXPIRES);
      if (gdriveExpiry) {
        const expiryTime = parseInt(gdriveExpiry, 10);
        const isExpired = expiryTime <= Date.now();

        if (isExpired) {
          console.log('⚠️ Google Drive token expired');

          // Update provider status to reflect expired state (triggers UI updates)
          providerManager.updateStatus();

          // Check if auto re-auth is enabled
          const { miscSettings } = await import('$lib/settings/misc');
          const { get } = await import('svelte/store');
          const settings = get(miscSettings);

          if (settings.gdriveAutoReAuth) {
            console.log('🔄 Auto re-auth enabled, triggering re-authentication...');
            const { showSnackbar } = await import('../snackbar');
            showSnackbar('Google Drive session expired. Re-authenticating...');

            // Trigger re-auth popup
            tokenManager.reAuthenticate();
          } else {
            console.log('⚠️ Auto re-auth disabled. User must manually re-authenticate.');
          }
        }
      }
    } catch (error) {
      console.warn('⚠️ Failed to initialize Google Drive API client:', error);
    }
  }

  // Don't update status here - wait for providers to finish loading credentials
  // The constructor already set initial "configured" state, don't overwrite it

  // Wait for providers to be ready (MEGA/WebDAV restore credentials on init)
  console.log('⏳ Waiting for providers to be ready...');
  await Promise.all([megaProvider.whenReady(), webdavProvider.whenReady()]);
  console.log('✅ Providers are ready');

  // Update status again after providers finish authentication
  providerManager.updateStatus();

  // Initialize the current provider (detects which one is authenticated)
  providerManager.initializeCurrentProvider();

  // Fetch cloud volumes cache if a provider is authenticated AND token is valid
  const currentProvider = providerManager.getActiveProvider();
  if (currentProvider) {
    // For Google Drive, check if token is still valid before trying to use it
    // For other providers, they handle their own token validity
    let shouldFetch = true;
    if (currentProvider.type === 'google-drive') {
      const gdriveExpiry = localStorage.getItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.TOKEN_EXPIRES);
      if (gdriveExpiry) {
        const expiryTime = parseInt(gdriveExpiry, 10);
        if (expiryTime <= Date.now()) {
          console.log('ℹ️ Google Drive token expired, skipping fetch/sync until re-authentication');
          shouldFetch = false;
        }
      }
    }

    if (shouldFetch) {
      console.log(`📦 Populating cloud cache from ${currentProvider.type}...`);
      try {
        await unifiedCloudManager.fetchAllCloudVolumes();
        console.log('✅ Cloud cache populated on app startup');

        // Sync progress after cache is populated
        console.log('🔄 Syncing progress on app startup...');
        await unifiedCloudManager.syncProgress({ silent: true });
        console.log('✅ Initial sync completed');
      } catch (error) {
        console.warn('⚠️ Failed to populate cloud cache or sync on startup:', error);
      }
    }
  } else {
    console.log('ℹ️ No provider authenticated, skipping cache population and sync');
  }
}
