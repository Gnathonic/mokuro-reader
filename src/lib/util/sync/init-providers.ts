import { providerManager } from './provider-manager';
import { unifiedCloudManager } from './unified-cloud-manager';
import { driveApiClient } from '$lib/util/sync/providers/google-drive/api-client';
import { tokenManager } from '$lib/util/sync/providers/google-drive/token-manager';
import { GOOGLE_DRIVE_CONFIG } from '$lib/util/sync/providers/google-drive/constants';
import { getConfiguredProviderType } from './provider-detection';
import type { SyncProvider, ProviderType } from './provider-interface';

/**
 * Dynamically load a provider module by type.
 * This enables lazy-loading of provider code - only the active provider is loaded on startup.
 *
 * When a provider module is loaded, it self-registers its cache with the cache manager.
 */
export async function loadProvider(type: ProviderType): Promise<SyncProvider> {
  switch (type) {
    case 'google-drive': {
      const { googleDriveProvider } = await import(
        './providers/google-drive/google-drive-provider'
      );
      return googleDriveProvider;
    }
    case 'mega': {
      const { megaProvider } = await import('./providers/mega/mega-provider');
      return megaProvider;
    }
    case 'webdav': {
      const { webdavProvider } = await import('./providers/webdav/webdav-provider');
      return webdavProvider;
    }
  }
}

/**
 * Initialize sync providers on app startup.
 *
 * Strategy:
 * - Only load the active provider (reduces initial bundle size)
 * - Inactive providers are lazy-loaded when user clicks login button
 * - Provider modules self-register their caches when loaded
 */
export async function initializeProviders(): Promise<void> {
  // Check which provider (if any) is active
  const activeProviderType = getConfiguredProviderType();

  // If no provider is active, we're done - providers will lazy-load when user clicks login
  if (!activeProviderType) {
    console.log('ℹ️ No active provider configured. Providers will load on login.');
    return;
  }

  console.log(`🔧 Loading ${activeProviderType} provider...`);

  // Dynamically load only the active provider module
  // This also triggers self-registration of the provider's cache
  const activeProvider = await loadProvider(activeProviderType);
  providerManager.registerProvider(activeProvider);

  console.log(`✅ ${activeProviderType} provider loaded and registered`);

  // Provider-specific initialization
  if (activeProviderType === 'google-drive') {
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
  } else if (activeProviderType === 'mega' || activeProviderType === 'webdav') {
    // MEGA and WebDAV restore credentials in their constructors via whenReady()
    console.log(`⏳ Waiting for ${activeProviderType} to restore credentials...`);
    await (activeProvider as any).whenReady();
    console.log(`✅ ${activeProviderType} credentials restored`);
  }

  // Update status after provider finishes authentication
  providerManager.updateStatus();

  // Initialize the current provider (detects which one is authenticated)
  providerManager.initializeCurrentProvider();

  // Fetch cloud volumes cache if provider is authenticated AND token is valid
  const currentProvider = providerManager.getActiveProvider();
  if (currentProvider) {
    // For Google Drive, check if token is still valid before trying to use it
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
    console.log('ℹ️ Provider not authenticated after restore, skipping cache population and sync');
  }
}
