/**
 * Cache manager for library files
 * Maintains separate caches per library and provides reactive stores for UI
 */

import { writable, derived, get, type Readable } from 'svelte/store';
import type { LibraryConfig } from '$lib/settings/libraries';
import {
	libraries,
	markLibraryFetched,
	markLibraryError,
	clearLibraryError
} from '$lib/settings/libraries';
import {
	LibraryWebDAVClient,
	createLibraryClient,
	type LibraryFileMetadata
} from './library-webdav-client';

export type LibraryStatus = 'idle' | 'fetching' | 'ready' | 'error';

interface LibraryState {
	status: LibraryStatus;
	files: LibraryFileMetadata[];
	mokuroFiles: LibraryFileMetadata[];
	error?: string;
}

// Per-library state store
const libraryStatesStore = writable<Map<string, LibraryState>>(new Map());

// WebDAV client instances (cached)
const clientCache = new Map<string, LibraryWebDAVClient>();

/**
 * Get or create a WebDAV client for a library
 */
function getClient(config: LibraryConfig): LibraryWebDAVClient {
	let client = clientCache.get(config.id);
	if (!client) {
		client = createLibraryClient(config);
		clientCache.set(config.id, client);
	}
	return client;
}

/**
 * Clear cached client for a library (call when config changes)
 */
export function clearClientCache(libraryId: string): void {
	clientCache.delete(libraryId);
}

/**
 * Clear all cached clients
 */
export function clearAllClients(): void {
	clientCache.clear();
}

/**
 * Fetch files from a single library
 */
export async function fetchLibrary(config: LibraryConfig): Promise<LibraryFileMetadata[]> {
	// Update status to fetching
		libraryStatesStore.update((states) => {
		const newStates = new Map(states);
		newStates.set(config.id, {
			status: 'fetching',
			files: states.get(config.id)?.files || [],
			mokuroFiles: states.get(config.id)?.mokuroFiles || [],
			error: undefined
		});
		return newStates;
	});

	try {
		const client = getClient(config);
		const [files, mokuroFiles] = await Promise.all([client.listFiles(), client.listMokuroFiles()]);

		// Update with success
		libraryStatesStore.update((states) => {
			const newStates = new Map(states);
			newStates.set(config.id, {
				status: 'ready',
				files,
				mokuroFiles,
				error: undefined
			});
			return newStates;
		});

		// Mark as fetched in library config
		markLibraryFetched(config.id);
		clearLibraryError(config.id);

		return files;
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);

		// Update with error
		libraryStatesStore.update((states) => {
			const newStates = new Map(states);
			newStates.set(config.id, {
				status: 'error',
				files: states.get(config.id)?.files || [], // Keep old files on error
				mokuroFiles: states.get(config.id)?.mokuroFiles || [], // Keep old sidecars on error
				error: errorMessage
			});
			return newStates;
		});

		// Mark error in library config
		markLibraryError(config.id, errorMessage);

		throw error;
	}
}

/**
 * Fetch files from all configured libraries
 */
export async function fetchAllLibraries(): Promise<void> {
	const libraryList = get(libraries);

	// Fetch all libraries in parallel
	const results = await Promise.allSettled(libraryList.map((lib) => fetchLibrary(lib)));

	// Log any failures
	results.forEach((result, index) => {
		if (result.status === 'rejected') {
			console.warn(`Failed to fetch library "${libraryList[index].name}":`, result.reason);
		}
	});
}

/**
 * Get status for a specific library
 */
export function getLibraryStatus(libraryId: string): LibraryStatus {
	const states = get(libraryStatesStore);
	return states.get(libraryId)?.status || 'idle';
}

/**
 * Get files for a specific library
 */
export function getLibraryFiles(libraryId: string): LibraryFileMetadata[] {
	const states = get(libraryStatesStore);
	return states.get(libraryId)?.files || [];
}

/**
 * Get all files from all libraries
 */
export function getAllLibraryFiles(): LibraryFileMetadata[] {
	const states = get(libraryStatesStore);
	const allFiles: LibraryFileMetadata[] = [];

	for (const state of states.values()) {
		allFiles.push(...state.files);
	}

	return allFiles;
}

/**
 * Clear cache for a specific library
 */
export function clearLibraryCache(libraryId: string): void {
	libraryStatesStore.update((states) => {
		const newStates = new Map(states);
		newStates.delete(libraryId);
		return newStates;
	});
	clearClientCache(libraryId);
}

/**
 * Clear all library caches
 */
export function clearAllLibraryCaches(): void {
	libraryStatesStore.set(new Map());
	clearAllClients();
}

/**
 * Remove a library from the cache (when library is deleted)
 */
export function removeLibraryFromCache(libraryId: string): void {
	clearLibraryCache(libraryId);
}

// ============================================================================
// Reactive Stores
// ============================================================================

/**
 * Reactive store of all library files
 * Map<libraryId, LibraryFileMetadata[]>
 */
export const libraryFilesStore: Readable<Map<string, LibraryFileMetadata[]>> = derived(
	libraryStatesStore,
	($states) => {
		const filesMap = new Map<string, LibraryFileMetadata[]>();
		for (const [libraryId, state] of $states) {
			if (state.files.length > 0) {
				filesMap.set(libraryId, state.files);
			}
		}
		return filesMap;
	}
);

/**
 * Reactive store of library statuses
 * Map<libraryId, LibraryStatus>
 */
export const libraryStatusStore: Readable<Map<string, LibraryStatus>> = derived(
	libraryStatesStore,
	($states) => {
		const statusMap = new Map<string, LibraryStatus>();
		for (const [libraryId, state] of $states) {
			statusMap.set(libraryId, state.status);
		}
		return statusMap;
	}
);

/**
 * Reactive store of library mokuro sidecar files
 * Map<libraryId, LibraryFileMetadata[]>
 */
export const libraryMokuroFilesStore: Readable<Map<string, LibraryFileMetadata[]>> = derived(
	libraryStatesStore,
	($states) => {
		const filesMap = new Map<string, LibraryFileMetadata[]>();
		for (const [libraryId, state] of $states) {
			if (state.mokuroFiles.length > 0) {
				filesMap.set(libraryId, state.mokuroFiles);
			}
		}
		return filesMap;
	}
);

/**
 * Reactive store indicating if any library is currently fetching
 */
export const isAnyLibraryFetching: Readable<boolean> = derived(libraryStatesStore, ($states) => {
	for (const state of $states.values()) {
		if (state.status === 'fetching') {
			return true;
		}
	}
	return false;
});

/**
 * Reactive store of total file count across all libraries
 */
export const totalLibraryFileCount: Readable<number> = derived(libraryStatesStore, ($states) => {
	let count = 0;
	for (const state of $states.values()) {
		count += state.files.length;
	}
	return count;
});

/**
 * Reactive store: Map of libraryId -> error message (only for libraries with errors)
 */
export const libraryErrors: Readable<Map<string, string>> = derived(libraryStatesStore, ($states) => {
	const errors = new Map<string, string>();
	for (const [libraryId, state] of $states) {
		if (state.error) {
			errors.set(libraryId, state.error);
		}
	}
	return errors;
});

/**
 * Get client for a library (for downloads)
 */
export function getLibraryClient(config: LibraryConfig): LibraryWebDAVClient {
	return getClient(config);
}

// Export for testing
export { libraryStatesStore as _libraryStatesStore };
