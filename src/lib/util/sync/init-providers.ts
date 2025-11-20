import { browser } from '$app/environment';
import { providerManager } from './provider-manager';
import { unifiedCloudManager } from './unified-cloud-manager';
import { getConfiguredProviderType } from './provider-detection';
import type { SyncProvider } from './provider-interface';

// Guard to prevent multiple initializations
let initializationPromise: Promise<void> | null = null;

/**
 * Initialize sync providers on demand.
 * This should be called once on app startup.
 * Safe to call multiple times - will only initialize once.
 *
 * Strategy:
 * - Only import and register the ACTIVE provider
 * - Inactive providers will be lazy-loaded when user clicks their login button
 * - This reduces initial bundle size and prevents unnecessary initialization
 */
export async function initializeProviders(): Promise<void> {
	// If already initialized or in progress, return the existing promise
	if (initializationPromise) {
		return initializationPromise;
	}

	// Start initialization and store the promise
	initializationPromise = doInitialize();
	return initializationPromise;
}

async function doInitialize(): Promise<void> {
	// Check which provider (if any) is active
	// Providers are mutually exclusive - only one can be logged in at a time
	const activeProvider = getConfiguredProviderType();

	// Only import and register the active provider
	// This prevents loading unused provider modules
	let providerInstance: SyncProvider | null = null;

	if (activeProvider === 'google-drive') {
		const { googleDriveProvider } = await import('./providers/google-drive/google-drive-provider');
		providerManager.registerProvider(googleDriveProvider);
		providerInstance = googleDriveProvider;
		console.log('✅ Google Drive provider registered');
	} else if (activeProvider === 'mega') {
		const { megaProvider } = await import('./providers/mega/mega-provider');
		providerManager.registerProvider(megaProvider);
		providerInstance = megaProvider;
		console.log('✅ MEGA provider registered');
	} else if (activeProvider === 'webdav') {
		const { webdavProvider } = await import('./providers/webdav/webdav-provider');
		providerManager.registerProvider(webdavProvider);
		providerInstance = webdavProvider;
		console.log('✅ WebDAV provider registered');
	}

	// If no provider is active, we're done - providers will lazy-init when user clicks login
	if (!activeProvider || !providerInstance) {
		console.log('ℹ️ No active provider. Providers will initialize on login.');
		return;
	}

	// Only initialize Google Drive API if it's the active provider (for auto-restore)
	// MEGA and WebDAV handle their own initialization in whenReady()
	if (activeProvider === 'google-drive') {
		console.log('🔧 Initializing Google Drive API client for auto-restore...');
		try {
			const { driveApiClient } = await import('./providers/google-drive/api-client');
			const { tokenManager } = await import('./providers/google-drive/token-manager');
			const { GOOGLE_DRIVE_CONFIG } = await import('./providers/google-drive/constants');

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

	// Wait for the active provider to be ready
	console.log(`⏳ Waiting for active provider (${activeProvider}) to be ready...`);
	await providerInstance.whenReady();
	console.log(`✅ Active provider (${activeProvider}) is ready`);

	// Update status again after providers finish authentication
	console.log('🔄 Updating provider status after authentication...');
	providerManager.updateStatus();

	// Initialize the current provider (detects which one is authenticated)
	providerManager.initializeCurrentProvider();

	// Final status update after initialization
	console.log('🔄 Final provider status update...');
	providerManager.updateStatus();

	// Fetch cloud volumes cache if a provider is authenticated AND token is valid
	const currentProvider = providerManager.getActiveProvider();
	if (currentProvider) {
		// For Google Drive, check if token is still valid before trying to use it
		// For other providers, they handle their own token validity
		let shouldFetch = true;
		if (currentProvider.type === 'google-drive') {
			const { GOOGLE_DRIVE_CONFIG } = await import('./providers/google-drive/constants');
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
