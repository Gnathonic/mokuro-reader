/**
 * Library configuration store for read-only WebDAV libraries
 * Libraries are separate from sync providers - they're browse-only sources for importing manga
 */

import { browser } from '$app/environment';
import { writable, derived, get } from 'svelte/store';

export interface LibraryConfig {
	id: string;
	name: string;
	serverUrl: string;
	username?: string;
	password?: string;
	basePath: string; // Subfolder path (default: '/')
	lastFetched?: string; // ISO timestamp of last successful fetch
	lastError?: string; // Error message if unreachable
	lastErrorTime?: string; // When error occurred
	createdAt: string; // ISO timestamp
}

export interface LibraryState {
	libraries: LibraryConfig[];
	selectedLibraryId: string | null; // null = show all
}

const STORAGE_KEY = 'mokuro_libraries';

const defaultState: LibraryState = {
	libraries: [],
	selectedLibraryId: null
};

// Load from localStorage
function loadState(): LibraryState {
	if (!browser) return defaultState;

	const stored = localStorage.getItem(STORAGE_KEY);
	if (!stored) return defaultState;

	try {
		const parsed = JSON.parse(stored);
		// Ensure all required fields exist
		return {
			libraries: Array.isArray(parsed.libraries) ? parsed.libraries : [],
			selectedLibraryId: parsed.selectedLibraryId ?? null
		};
	} catch {
		return defaultState;
	}
}

// Main store
export const librariesStore = writable<LibraryState>(loadState());

// Auto-save to localStorage
librariesStore.subscribe((state) => {
	if (browser) {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	}
});

// Derived store for just the libraries array
export const libraries = derived(librariesStore, ($state) => $state.libraries);

// Derived store for selected library ID
export const selectedLibraryId = derived(librariesStore, ($state) => $state.selectedLibraryId);

// Derived store for currently selected library config (or null if showing all)
export const selectedLibrary = derived(librariesStore, ($state) => {
	if (!$state.selectedLibraryId) return null;
	return $state.libraries.find((lib) => lib.id === $state.selectedLibraryId) ?? null;
});

// Derived store: whether any libraries are configured
export const hasLibraries = derived(libraries, ($libraries) => $libraries.length > 0);

/**
 * Add a new library configuration
 */
export function addLibrary(
	config: Omit<LibraryConfig, 'id' | 'createdAt'>
): LibraryConfig {
	const newLibrary: LibraryConfig = {
		...config,
		id: crypto.randomUUID(),
		createdAt: new Date().toISOString()
	};

	librariesStore.update((state) => ({
		...state,
		libraries: [...state.libraries, newLibrary]
	}));

	return newLibrary;
}

/**
 * Remove a library by ID
 */
export function removeLibrary(id: string): void {
	librariesStore.update((state) => {
		const newLibraries = state.libraries.filter((lib) => lib.id !== id);
		return {
			libraries: newLibraries,
			// Clear selection if we removed the selected library
			selectedLibraryId: state.selectedLibraryId === id ? null : state.selectedLibraryId
		};
	});
}

/**
 * Update a library's configuration
 */
export function updateLibrary(id: string, updates: Partial<Omit<LibraryConfig, 'id' | 'createdAt'>>): void {
	librariesStore.update((state) => ({
		...state,
		libraries: state.libraries.map((lib) =>
			lib.id === id ? { ...lib, ...updates } : lib
		)
	}));
}

/**
 * Set the selected library for filtering
 * Pass null to show all libraries
 */
export function setSelectedLibrary(id: string | null): void {
	librariesStore.update((state) => ({
		...state,
		selectedLibraryId: id
	}));
}

/**
 * Get a library by ID
 */
export function getLibraryById(id: string): LibraryConfig | undefined {
	const state = get(librariesStore);
	return state.libraries.find((lib) => lib.id === id);
}

/**
 * Mark a library as successfully fetched
 */
export function markLibraryFetched(id: string): void {
	updateLibrary(id, {
		lastFetched: new Date().toISOString(),
		lastError: undefined,
		lastErrorTime: undefined
	});
}

/**
 * Mark a library as having an error
 */
export function markLibraryError(id: string, error: string): void {
	updateLibrary(id, {
		lastError: error,
		lastErrorTime: new Date().toISOString()
	});
}

/**
 * Clear error state for a library
 */
export function clearLibraryError(id: string): void {
	updateLibrary(id, {
		lastError: undefined,
		lastErrorTime: undefined
	});
}

/**
 * Get all libraries (useful for iteration)
 */
export function getAllLibraries(): LibraryConfig[] {
	return get(librariesStore).libraries;
}

/**
 * Import libraries from profile sync data
 * Uses newest-wins merge strategy by library ID
 */
export function importLibraries(importedLibraries: LibraryConfig[]): void {
	librariesStore.update((state) => {
		const mergedMap = new Map<string, LibraryConfig>();

		// Add existing libraries
		for (const lib of state.libraries) {
			mergedMap.set(lib.id, lib);
		}

		// Merge imported libraries (newest wins based on createdAt)
		for (const imported of importedLibraries) {
			const existing = mergedMap.get(imported.id);
			if (!existing) {
				mergedMap.set(imported.id, imported);
			} else {
				// Keep the one with newer createdAt (or lastFetched as tiebreaker)
				const existingTime = new Date(existing.lastFetched || existing.createdAt).getTime();
				const importedTime = new Date(imported.lastFetched || imported.createdAt).getTime();
				if (importedTime > existingTime) {
					mergedMap.set(imported.id, imported);
				}
			}
		}

		return {
			...state,
			libraries: Array.from(mergedMap.values())
		};
	});
}

/**
 * Export libraries for profile sync
 */
export function exportLibraries(): LibraryConfig[] {
	return get(librariesStore).libraries;
}
