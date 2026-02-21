/**
 * Library module exports
 * Read-only WebDAV libraries for browsing and downloading manga
 */

// Client
export {
	LibraryWebDAVClient,
	createLibraryClient,
	type LibraryFileMetadata
} from './library-webdav-client';

// Cache manager
export {
	fetchLibrary,
	fetchAllLibraries,
	getLibraryStatus,
	getLibraryFiles,
	getAllLibraryFiles,
	clearLibraryCache,
	clearAllLibraryCaches,
	removeLibraryFromCache,
	getLibraryClient,
	clearClientCache,
	clearAllClients,
	libraryFilesStore,
	libraryStatusStore,
	isAnyLibraryFetching,
	totalLibraryFileCount,
	libraryErrors,
	type LibraryStatus
} from './library-cache-manager';

// Placeholders
export { generateLibraryPlaceholders, isLibraryVolume } from './library-placeholders';
