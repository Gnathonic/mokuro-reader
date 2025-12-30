/**
 * Local Import Provider
 *
 * A pseudo-provider that wraps local file imports (drag-drop, file picker)
 * to integrate with the unified import queue system.
 *
 * Unlike cloud providers, this doesn't need authentication or network operations.
 * It provides a consistent interface for the queue system to work with both
 * local and cloud imports uniformly.
 */

import type { PairedSource, ImportQueueItem } from './types';
import { parseFilePath } from './types';

/**
 * Provider status for local imports (always ready)
 */
interface LocalProviderStatus {
	isAuthenticated: boolean;
	hasStoredCredentials: boolean;
	needsAttention: boolean;
	statusMessage: string;
}

/**
 * Local Import Provider - Pseudo-provider for local file imports
 *
 * Implements a minimal provider interface for compatibility with the queue system.
 * All cloud-related operations throw errors since they're not applicable.
 */
class LocalImportProvider {
	readonly type = 'local-import' as const;
	readonly name = 'Local Import';

	/**
	 * Local imports don't need worker downloads - files are already local.
	 * Archives are decompressed using workers, but that's separate from "download".
	 */
	readonly supportsWorkerDownload = false;

	/**
	 * Concurrency limits for local processing.
	 * These are CPU/memory bound, not network bound.
	 */
	readonly uploadConcurrencyLimit = 4;
	readonly downloadConcurrencyLimit = 4;

	/**
	 * Local imports are always "authenticated" (no auth needed)
	 */
	isAuthenticated(): boolean {
		return true;
	}

	/**
	 * Get provider status (always ready)
	 */
	getStatus(): LocalProviderStatus {
		return {
			isAuthenticated: true,
			hasStoredCredentials: true,
			needsAttention: false,
			statusMessage: 'Ready to import'
		};
	}

	// ========================================
	// UNSUPPORTED OPERATIONS
	// These throw errors since local imports don't use cloud operations
	// ========================================

	async login(): Promise<void> {
		throw new Error('Local import provider does not support login');
	}

	async logout(): Promise<void> {
		throw new Error('Local import provider does not support logout');
	}

	async listCloudVolumes(): Promise<never> {
		throw new Error('Local import provider does not support cloud operations');
	}

	async uploadFile(_path: string, _blob: Blob): Promise<never> {
		throw new Error('Local import provider does not support cloud operations');
	}

	async downloadFile(_file: unknown): Promise<never> {
		throw new Error('Local import provider does not support cloud operations');
	}

	async deleteFile(_file: unknown): Promise<never> {
		throw new Error('Local import provider does not support cloud operations');
	}

	async getStorageQuota(): Promise<never> {
		throw new Error('Local import provider does not support cloud operations');
	}
}

/**
 * Singleton instance of local import provider
 */
export const localImportProvider = new LocalImportProvider();

/**
 * Check if a paired source requires worker decompression
 *
 * - Archives need workers for ZIP decompression
 * - Directories and TOC directories are already decompressed
 *
 * @param source - The paired source to check
 * @returns true if worker decompression is needed
 */
export function requiresWorkerDecompression(source: PairedSource): boolean {
	return source.source.type === 'archive';
}

/**
 * Extract display title from a base path
 *
 * Uses the last path segment as the display title.
 * Falls back to "Untitled" if empty.
 *
 * @param basePath - The base path (e.g., "author/series/vol1")
 * @returns Display title (e.g., "vol1")
 */
function extractDisplayTitle(basePath: string): string {
	if (!basePath) {
		return 'Untitled';
	}

	const { filename } = parseFilePath(basePath);
	return filename || basePath || 'Untitled';
}

/**
 * Create a queue item from a paired source
 *
 * Converts a PairedSource into an ImportQueueItem ready for the queue.
 *
 * @param source - The paired source to create a queue item for
 * @returns Queue item ready for processing
 */
export function createLocalQueueItem(source: PairedSource): ImportQueueItem {
	return {
		id: source.id,
		source,
		provider: 'local-import',
		status: 'queued',
		progress: 0,
		displayTitle: extractDisplayTitle(source.basePath)
	};
}
