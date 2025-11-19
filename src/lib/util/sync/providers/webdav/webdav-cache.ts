import { writable, get as getStoreValue } from 'svelte/store';
import type { CloudCache } from '../../cloud-cache-interface';
import type { WebDAVFileMetadata } from '../../provider-interface';
import { webdavProvider } from './webdav-provider';

/**
 * WebDAV Cache Manager
 *
 * Returns Map<seriesTitle, WebDAVFileMetadata[]> for efficient series-based operations.
 * Cache is grouped by series folder names extracted from file paths.
 */
class WebDAVCacheManager implements CloudCache<WebDAVFileMetadata> {
	private cache = writable<Map<string, WebDAVFileMetadata[]>>(new Map());
	private isFetchingStore = writable<boolean>(false);
	private fetchingFlag = false;
	private loadedFlag = false;

	get store() {
		return this.cache;
	}

	get isFetchingState() {
		return this.isFetchingStore;
	}

	/**
	 * Fetch cloud volumes from WebDAV provider
	 */
	async fetch(): Promise<void> {
		if (this.fetchingFlag) {
			console.log('WebDAV cache fetch already in progress');
			return;
		}

		if (!webdavProvider.isAuthenticated()) {
			console.log('WebDAV not authenticated, skipping cache fetch');
			return;
		}

		this.fetchingFlag = true;
		this.isFetchingStore.set(true);
		try {
			const volumes = await webdavProvider.listCloudVolumes();

			// Group by series title (extracted from path: "SeriesTitle/VolumeTitle.cbz")
			const cacheMap = new Map<string, WebDAVFileMetadata[]>();
			for (const volume of volumes) {
				// Extract series title from path
				const seriesTitle = volume.path.split('/')[0];

				const existing = cacheMap.get(seriesTitle);
				if (existing) {
					existing.push(volume);
				} else {
					cacheMap.set(seriesTitle, [volume]);
				}
			}

			// Replace entire cache atomically
			this.cache.set(cacheMap);
			this.loadedFlag = true;
			console.log(`✅ WebDAV cache populated with ${volumes.length} files in ${cacheMap.size} series`);
		} catch (error) {
			console.error('Failed to fetch WebDAV cache:', error);
		} finally {
			this.fetchingFlag = false;
			this.isFetchingStore.set(false);
		}
	}

	has(path: string): boolean {
		const currentCache = getStoreValue(this.cache);

		// Extract series title from path and find within that series
		const seriesTitle = path.split('/')[0];
		const seriesFiles = currentCache.get(seriesTitle);
		return seriesFiles?.some(f => f.path === path) || false;
	}

	get(path: string): WebDAVFileMetadata | null {
		const currentCache = getStoreValue(this.cache);

		// Extract series title from path and find within that series
		const seriesTitle = path.split('/')[0];
		const seriesFiles = currentCache.get(seriesTitle);
		return seriesFiles?.find(f => f.path === path) || null;
	}

	getAll(path: string): WebDAVFileMetadata[] {
		const currentCache = getStoreValue(this.cache);

		// Extract series title from path and find all matches within that series
		const seriesTitle = path.split('/')[0];
		const seriesFiles = currentCache.get(seriesTitle);
		return seriesFiles?.filter(f => f.path === path) || [];
	}

	getBySeries(seriesTitle: string): WebDAVFileMetadata[] {
		const currentCache = getStoreValue(this.cache);

		const result: WebDAVFileMetadata[] = [];
		for (const files of currentCache.values()) {
			result.push(...files.filter((file) => file.path.startsWith(`${seriesTitle}/`)));
		}
		return result;
	}

	getAllFiles(): WebDAVFileMetadata[] {
		const currentCache = getStoreValue(this.cache);

		const result: WebDAVFileMetadata[] = [];
		for (const files of currentCache.values()) {
			result.push(...files);
		}
		return result;
	}

	clear(): void {
		this.cache.set(new Map());
		this.loadedFlag = false;
	}

	isFetching(): boolean {
		return this.fetchingFlag;
	}

	isLoaded(): boolean {
		return this.loadedFlag;
	}

	// Optional methods for cache updates
	add(path: string, metadata: WebDAVFileMetadata): void {
		this.cache.update((cache) => {
			const newCache = new Map(cache);

			// Extract series title from path
			const seriesTitle = path.split('/')[0];
			const existing = newCache.get(seriesTitle);

			if (existing) {
				// Check if this file ID already exists, replace it
				const index = existing.findIndex(f => f.fileId === metadata.fileId);
				if (index >= 0) {
					newCache.set(seriesTitle, [
						...existing.slice(0, index),
						metadata,
						...existing.slice(index + 1)
					]);
				} else {
					newCache.set(seriesTitle, [...existing, metadata]);
				}
			} else {
				newCache.set(seriesTitle, [metadata]);
			}

			return newCache;
		});
	}

	removeById(fileId: string): void {
		this.cache.update((cache) => {
			const newCache = new Map(cache);

			for (const [path, files] of newCache.entries()) {
				const filtered = files.filter(f => f.fileId !== fileId);
				if (filtered.length === 0) {
					newCache.delete(path);
				} else if (filtered.length !== files.length) {
					newCache.set(path, filtered);
				}
			}

			return newCache;
		});
	}

	update(fileId: string, updates: Partial<WebDAVFileMetadata>): void {
		this.cache.update((cache) => {
			const newCache = new Map(cache);

			for (const [path, files] of newCache.entries()) {
				const updated = files.map(file =>
					file.fileId === fileId
						? { ...file, ...updates }
						: file
				);
				newCache.set(path, updated);
			}

			return newCache;
		});
	}
}

export const webdavCache = new WebDAVCacheManager();
