import { writable, get } from 'svelte/store';
import { progressTrackerStore } from '../progress-tracker';
import { volumes, profiles, parseVolumesFromJson } from '$lib/settings';
import { showSnackbar } from '../snackbar';
import type { SyncProvider, ProviderType } from './provider-interface';

export interface SyncOptions {
	/** If true, suppress snackbar notifications */
	silent?: boolean;
	/** If true, sync profiles in addition to volume data */
	syncProfiles?: boolean;
}

export interface ProviderSyncResult {
	provider: ProviderType;
	success: boolean;
	error?: string;
}

export interface SyncResult {
	totalProviders: number;
	succeeded: number;
	failed: number;
	results: ProviderSyncResult[];
}

/**
 * Unified Sync Service
 *
 * Syncs read progress and profiles across all authenticated cloud providers.
 * Works with the SyncProvider interface, making it provider-agnostic.
 */
class UnifiedSyncService {
	private isSyncingStore = writable<boolean>(false);
	private syncLock = false;

	get isSyncing() {
		return this.isSyncingStore;
	}

	/**
	 * Sync with all authenticated providers
	 */
	async syncAllProviders(
		providers: SyncProvider[],
		options: SyncOptions = {}
	): Promise<SyncResult> {
		// Prevent concurrent syncs
		if (this.syncLock) {
			console.log('⏭️ Sync already in progress, skipping');
			if (!options.silent) {
				showSnackbar('Sync already in progress');
			}
			return {
				totalProviders: 0,
				succeeded: 0,
				failed: 0,
				results: []
			};
		}

		this.syncLock = true;
		this.isSyncingStore.set(true);

		// Filter to only authenticated providers
		const authenticatedProviders = providers.filter(p => p.isAuthenticated());

		if (authenticatedProviders.length === 0) {
			console.log('ℹ️ No authenticated providers to sync');
			if (!options.silent) {
				showSnackbar('No cloud providers connected');
			}
			this.syncLock = false;
			this.isSyncingStore.set(false);
			return {
				totalProviders: 0,
				succeeded: 0,
				failed: 0,
				results: []
			};
		}

		const processId = 'unified-sync';

		try {
			if (!options.silent) {
				progressTrackerStore.addProcess({
					id: processId,
					description: 'Syncing with cloud providers',
					progress: 0,
					status: `Syncing with ${authenticatedProviders.length} provider(s)...`
				});
			}

			// Sync with all providers in parallel
			const results = await Promise.allSettled(
				authenticatedProviders.map(provider => this.syncProvider(provider, options))
			);

			// Count successes and failures
			let succeeded = 0;
			let failed = 0;
			const providerResults: ProviderSyncResult[] = [];

			results.forEach((result, index) => {
				const provider = authenticatedProviders[index];
				if (result.status === 'fulfilled' && result.value.success) {
					succeeded++;
					providerResults.push(result.value);
				} else {
					failed++;
					providerResults.push({
						provider: provider.type,
						success: false,
						error: result.status === 'rejected'
							? result.reason?.message || 'Unknown error'
							: result.value.error
					});
				}
			});

			// Show completion message
			if (!options.silent) {
				progressTrackerStore.updateProcess(processId, {
					progress: 100,
					status: 'Sync complete'
				});

				if (failed === 0) {
					showSnackbar(`Synced with ${succeeded} provider(s) successfully`);
				} else {
					showSnackbar(`Synced with ${succeeded} provider(s), ${failed} failed`);
				}
			}

			return {
				totalProviders: authenticatedProviders.length,
				succeeded,
				failed,
				results: providerResults
			};

		} catch (error) {
			console.error('Unified sync error:', error);
			if (!options.silent) {
				progressTrackerStore.updateProcess(processId, {
					progress: 0,
					status: 'Sync failed'
				});
				showSnackbar('Sync failed');
			}
			return {
				totalProviders: authenticatedProviders.length,
				succeeded: 0,
				failed: authenticatedProviders.length,
				results: authenticatedProviders.map(p => ({
					provider: p.type,
					success: false,
					error: 'Sync failed'
				}))
			};
		} finally {
			if (!options.silent) {
				setTimeout(() => progressTrackerStore.removeProcess(processId), 3000);
			}
			this.syncLock = false;
			this.isSyncingStore.set(false);
		}
	}

	/**
	 * Sync with a single provider
	 */
	async syncProvider(
		provider: SyncProvider,
		options: SyncOptions = {}
	): Promise<ProviderSyncResult> {
		try {
			console.log(`🔄 Syncing with ${provider.name}...`);

			// Check authentication - if provider needs to re-authenticate, let it handle that
			if (!provider.isAuthenticated()) {
				// For Google Drive specifically, trigger the auth flow if needed
				if (provider.type === 'google-drive') {
					console.log('Google Drive not authenticated, triggering login...');
					await provider.login();
				} else {
					throw new Error(`${provider.name} is not authenticated`);
				}
			}

			// Sync volume data (read progress)
			await this.syncVolumeData(provider);

			// Optionally sync profiles
			if (options.syncProfiles) {
				await this.syncProfiles(provider);
			}

			console.log(`✅ ${provider.name} sync complete`);
			return {
				provider: provider.type,
				success: true
			};

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			console.error(`❌ ${provider.name} sync failed:`, error);

			// If it's an authentication error for Google Drive, that's expected behavior
			if (provider.type === 'google-drive' && errorMessage.includes('not authenticated')) {
				console.log('Google Drive re-authentication in progress...');
			}

			return {
				provider: provider.type,
				success: false,
				error: errorMessage
			};
		}
	}

	/**
	 * Sync volume data (read progress) with a provider
	 */
	private async syncVolumeData(provider: SyncProvider): Promise<void> {
		// Step 1: Download cloud data
		const cloudVolumes = await provider.downloadVolumeData();

		// Step 2: Get local data
		const localVolumes = get(volumes);

		// Step 3: Merge data (newest wins)
		const mergedVolumes = this.mergeVolumeData(localVolumes, cloudVolumes || {});

		// Step 4: Update local storage
		volumes.set(mergedVolumes);

		// Step 5: Upload merged data if changed
		const mergedJson = JSON.stringify(mergedVolumes);
		const cloudJson = JSON.stringify(cloudVolumes || {});

		if (mergedJson !== cloudJson) {
			await provider.uploadVolumeData(mergedVolumes);
		}
	}

	/**
	 * Sync profiles with a provider
	 */
	private async syncProfiles(provider: SyncProvider): Promise<void> {
		// Step 1: Download cloud profiles
		const cloudProfiles = await provider.downloadProfiles();

		// Step 2: Get local profiles
		const localProfiles = get(profiles);

		// Step 3: Merge profiles (newest wins based on profile name)
		const mergedProfiles = this.mergeProfiles(localProfiles, cloudProfiles || {});

		// Step 4: Update local storage
		profiles.set(mergedProfiles);

		// Step 5: Upload merged profiles if changed
		const mergedJson = JSON.stringify(mergedProfiles);
		const cloudJson = JSON.stringify(cloudProfiles || {});

		if (mergedJson !== cloudJson) {
			await provider.uploadProfiles(mergedProfiles);
		}
	}

	/**
	 * Merge volume data using newest-wins strategy
	 * IMPORTANT: Always returns VolumeData class instances to ensure toJSON() is available
	 */
	private mergeVolumeData(local: any, cloud: any): any {
		const merged: any = {};
		const allVolumeIds = new Set([
			...Object.keys(local),
			...Object.keys(cloud)
		]);

		allVolumeIds.forEach(volumeId => {
			const localVol = local[volumeId];
			const cloudVol = cloud[volumeId];

			if (!localVol) {
				// Only in cloud - parse plain object to VolumeData instance
				// Use parseVolumesFromJson to ensure proper VolumeData instances
				const parsed = parseVolumesFromJson(JSON.stringify({ [volumeId]: cloudVol }));
				merged[volumeId] = parsed[volumeId];
			} else if (!cloudVol) {
				// Only in local - already a VolumeData instance
				merged[volumeId] = localVol;
			} else {
				// In both - keep newer based on lastProgressUpdate
				const localDate = new Date(localVol.lastProgressUpdate || 0).getTime();
				const cloudDate = new Date(cloudVol.lastProgressUpdate || 0).getTime();

				// Ensure cloud version is converted to VolumeData instance if selected
				if (localDate >= cloudDate) {
					merged[volumeId] = localVol;
				} else {
					const parsed = parseVolumesFromJson(JSON.stringify({ [volumeId]: cloudVol }));
					merged[volumeId] = parsed[volumeId];
				}
			}
		});

		return merged;
	}

	/**
	 * Merge profiles (Record<string, Settings>) keeping all unique profile names
	 */
	private mergeProfiles(local: any, cloud: any): any {
		// For profiles, we'll combine them with cloud profiles taking precedence
		// Profiles are Record<string, Settings> where key is profile name
		return {
			...local,
			...cloud
		};
	}
}

export const unifiedSyncService = new UnifiedSyncService();
