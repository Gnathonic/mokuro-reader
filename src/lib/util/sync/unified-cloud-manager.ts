import { derived, type Readable } from 'svelte/store';
import type { SyncProvider, CloudVolumeMetadata, ProviderType } from './provider-interface';
import { unifiedSyncService, type SyncOptions, type SyncResult } from './unified-sync-service';
import { cacheManager } from './cache-manager';
import { providerManager } from './provider-manager';

/**
 * CloudVolumeMetadata with provider information for placeholder generation
 */
export interface CloudVolumeWithProvider extends CloudVolumeMetadata {
	provider: ProviderType;
}

/**
 * Unified Cloud Manager - Single Provider Design
 *
 * Provides a convenient interface for cloud storage operations.
 * Delegates to THE current provider via providerManager.
 *
 * ARCHITECTURE NOTE:
 * This manager provides a unified API but delegates all operations to:
 * - providerManager.getActiveProvider() for provider operations
 * - cacheManager for cache operations
 *
 * Only ONE provider can be active at a time.
 */

class UnifiedCloudManager {

	/**
	 * Store containing cloud volumes from the current provider
	 * Delegates to cacheManager and adds provider field to each file
	 */
	get cloudFiles(): Readable<CloudVolumeWithProvider[]> {
		return derived(cacheManager.allFiles, ($files) => {
			const provider = this.getActiveProvider();
			if (!provider) return [];

			// Add provider field to each file
			return $files.map(file => ({
				...file,
				provider: provider.type
			}));
		}, []);
	}

	/**
	 * Store indicating whether a fetch is in progress
	 * Delegates to cacheManager's reactive fetching state
	 */
	get isFetching(): Readable<boolean> {
		return cacheManager.isFetchingState;
	}

	/**
	 * Fetch all cloud volumes from the current provider
	 * Delegates to cacheManager
	 */
	async fetchAllCloudVolumes(): Promise<void> {
		await cacheManager.fetchAll();
	}

	/**
	 * Get all cloud volumes (current cached value)
	 */
	getAllCloudVolumes(): any[] {
		return cacheManager.getAllFiles();
	}

	/**
	 * Get cloud volume by file ID
	 */
	getCloudVolume(fileId: string): any | undefined {
		const volumes = this.getAllCloudVolumes();
		return volumes.find((v: any) => v.fileId === fileId);
	}

	/**
	 * Get cloud volumes for a specific series
	 */
	getCloudVolumesBySeries(seriesTitle: string): any[] {
		return cacheManager.getBySeries(seriesTitle);
	}

	/**
	 * Get the current provider
	 */
	getActiveProvider(): SyncProvider | null {
		return providerManager.getActiveProvider();
	}

	/**
	 * Upload a volume CBZ to the current provider
	 */
	async uploadVolumeCbz(
		path: string,
		blob: Blob,
		description?: string
	): Promise<string> {
		const provider = this.getActiveProvider();
		if (!provider) {
			throw new Error('No cloud provider authenticated');
		}

		const fileId = await provider.uploadVolumeCbz(path, blob, description);

		// Update cache via cacheManager
		const cache = cacheManager.getCache(provider.type);
		if (cache && cache.add) {
			cache.add(path, {
				fileId,
				path,
				modifiedTime: new Date().toISOString(),
				size: blob.size,
				description
			});
		}

		return fileId;
	}

	/**
	 * Download a volume CBZ using the active provider
	 */
	async downloadVolumeCbz(
		fileId: string,
		onProgress?: (loaded: number, total: number) => void
	): Promise<Blob> {
		const provider = this.getActiveProvider();
		if (!provider) {
			throw new Error(`No cloud provider authenticated`);
		}

		return await provider.downloadVolumeCbz(fileId, onProgress);
	}

	/**
	 * Delete a volume CBZ from the current provider
	 */
	async deleteVolumeCbz(fileId: string): Promise<void> {
		const provider = this.getActiveProvider();
		if (!provider) {
			throw new Error('No cloud provider authenticated');
		}

		await provider.deleteVolumeCbz(fileId);

		// Remove from cache via cacheManager
		const cache = cacheManager.getCache(provider.type);
		if (cache && cache.removeById) {
			cache.removeById(fileId);
		}
	}

	/**
	 * Delete an entire series folder (all volumes in the series)
	 */
	async deleteSeriesFolder(seriesTitle: string): Promise<{ succeeded: number; failed: number }> {
		const provider = this.getActiveProvider();
		if (!provider) {
			throw new Error('No cloud provider authenticated');
		}

		// Get all volumes for this series from the current provider
		const seriesVolumes = this.getCloudVolumesBySeries(seriesTitle);

		if (seriesVolumes.length === 0) {
			return { succeeded: 0, failed: 0 };
		}

		// Check if provider has a deleteSeriesFolder method
		if ('deleteSeriesFolder' in provider && typeof provider.deleteSeriesFolder === 'function') {
			try {
				await (provider as any).deleteSeriesFolder(seriesTitle);

				// Remove all volumes from cache
				const cache = cacheManager.getCache(provider.type);
				if (cache && cache.removeById) {
					for (const volume of seriesVolumes) {
						cache.removeById(volume.fileId);
					}
				}

				return { succeeded: seriesVolumes.length, failed: 0 };
			} catch (error) {
				console.error(`Failed to delete series folder:`, error);
				return { succeeded: 0, failed: seriesVolumes.length };
			}
		} else {
			// Fallback: delete individual files if provider doesn't support folder deletion
			let successCount = 0;
			let failCount = 0;

			for (const volume of seriesVolumes) {
				try {
					await this.deleteVolumeCbz(volume.fileId);
					successCount++;
				} catch (error) {
					console.error(`Failed to delete ${volume.path}:`, error);
					failCount++;
				}
			}

			return { succeeded: successCount, failed: failCount };
		}
	}

	/**
	 * Check if a volume exists in the current provider by path
	 */
	existsInCloud(seriesTitle: string, volumeTitle: string): boolean {
		const path = `${seriesTitle}/${volumeTitle}.cbz`;
		return cacheManager.has(path);
	}

	/**
	 * Get cloud file metadata by path from the current provider
	 */
	getCloudFile(seriesTitle: string, volumeTitle: string): any | null {
		const path = `${seriesTitle}/${volumeTitle}.cbz`;
		return cacheManager.get(path);
	}

	/**
	 * Get the default provider for uploads (the current provider)
	 */
	getDefaultProvider(): SyncProvider | null {
		return this.getActiveProvider();
	}

	/**
	 * Clear all cached data
	 */
	clearCache(): void {
		cacheManager.clearAll();
	}

	/**
	 * Update cache entry (e.g., after modifying description)
	 */
	updateCacheEntry(fileId: string, updates: Partial<any>): void {
		const provider = this.getActiveProvider();
		if (!provider) return;

		const cache = cacheManager.getCache(provider.type);
		if (cache && cache.update) {
			cache.update(fileId, updates);
		}
	}

	/**
	 * Sync progress (volume data and optionally profiles) with the current provider
	 */
	async syncProgress(options?: SyncOptions): Promise<SyncResult> {
		const provider = this.getActiveProvider();
		if (!provider) {
			return {
				totalProviders: 0,
				succeeded: 0,
				failed: 0,
				results: []
			};
		}

		const result = await unifiedSyncService.syncProvider(provider, options);
		return {
			totalProviders: 1,
			succeeded: result.success ? 1 : 0,
			failed: result.success ? 0 : 1,
			results: [result]
		};
	}

	/**
	 * Check if sync is currently in progress
	 */
	get isSyncing(): Readable<boolean> {
		return unifiedSyncService.isSyncing;
	}
}

export const unifiedCloudManager = new UnifiedCloudManager();
