/**
 * Lightweight read-only WebDAV client for library browsing
 * Simplified version of webdav-provider.ts - only supports listing and downloading
 */

import type { LibraryConfig } from '$lib/settings/libraries';
import type { WebDAVClient } from 'webdav';

export interface LibraryFileMetadata {
	libraryId: string;
	fileId: string; // Full WebDAV path
	path: string; // Relative path from base folder (e.g., "SeriesTitle/VolumeTitle.cbz")
	modifiedTime: string;
	size: number;
}

export interface LibraryClientOptions {
	timeout?: number; // Connection timeout in ms (default: 10000)
}

export class LibraryWebDAVClient {
	private client: WebDAVClient | null = null;
	private config: LibraryConfig;
	private supportsDepthInfinity: boolean | null = null;

	constructor(config: LibraryConfig) {
		this.config = config;
	}

	/**
	 * Get the library ID this client is associated with
	 */
	get libraryId(): string {
		return this.config.id;
	}

	/**
	 * Get the library name
	 */
	get libraryName(): string {
		return this.config.name;
	}

	/**
	 * Get the base path for this library
	 */
	private get basePath(): string {
		// Normalize base path to not have trailing slash
		const path = this.config.basePath || '/';
		return path.endsWith('/') && path !== '/' ? path.slice(0, -1) : path;
	}

	/**
	 * Test connection to the WebDAV server
	 * Returns true if successful, throws on failure
	 */
	async testConnection(options?: LibraryClientOptions): Promise<boolean> {
		const timeout = options?.timeout ?? 10000;

		try {
			const { createClient } = await import('webdav');

			// Create client with optional credentials
			const clientOptions: { username?: string; password?: string } = {};
			if (this.config.username || this.config.password) {
				clientOptions.username = this.config.username || '';
				clientOptions.password = this.config.password || '';
			}

			const normalizedUrl = this.config.serverUrl.replace(/\/$/, '');
			const client = createClient(normalizedUrl, clientOptions);

			// Test with timeout
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), timeout);

			try {
				await client.getDirectoryContents(this.basePath, { signal: controller.signal });
			} finally {
				clearTimeout(timeoutId);
			}

			this.client = client;
			return true;
		} catch (error) {
			this.client = null;
			throw this.wrapError(error);
		}
	}

	/**
	 * Connect to the library (initialize client)
	 */
	async connect(): Promise<void> {
		if (this.client) return;

		const { createClient } = await import('webdav');

		const clientOptions: { username?: string; password?: string } = {};
		if (this.config.username || this.config.password) {
			clientOptions.username = this.config.username || '';
			clientOptions.password = this.config.password || '';
		}

		const normalizedUrl = this.config.serverUrl.replace(/\/$/, '');
		this.client = createClient(normalizedUrl, clientOptions);
	}

	/**
	 * List all CBZ files in the library
	 */
	async listFiles(): Promise<LibraryFileMetadata[]> {
		return this.listByExtensions(['.cbz', '.zip']);
	}

	/**
	 * List all mokuro sidecar files in the library
	 */
	async listMokuroFiles(): Promise<LibraryFileMetadata[]> {
		return this.listByExtensions(['.mokuro', '.mokuro.gz']);
	}

	private async listByExtensions(extensions: string[]): Promise<LibraryFileMetadata[]> {
		if (!this.client) {
			await this.connect();
		}

		const client = this.client!;
		const basePath = this.basePath;
		const normalizedExtensions = extensions.map((ext) => ext.toLowerCase());

		try {
			// Try Depth: infinity first if not known to be unsupported
			if (this.supportsDepthInfinity !== false) {
				try {
					const files = await this.listWithDepthInfinity(
						client,
						basePath,
						normalizedExtensions
					);
					if (this.supportsDepthInfinity === null) {
						console.log(`[Library ${this.config.name}] Server supports Depth: infinity`);
						this.supportsDepthInfinity = true;
					}
					return files;
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error);
					const isDepthInfinityError =
						errorMessage.includes('403') ||
						errorMessage.includes('400') ||
						errorMessage.includes('infinity') ||
						errorMessage.includes('Depth');

					if (isDepthInfinityError && this.supportsDepthInfinity === null) {
						console.log(
							`[Library ${this.config.name}] Server does not support Depth: infinity, using recursive`
						);
						this.supportsDepthInfinity = false;
					} else if (this.supportsDepthInfinity === null) {
						console.warn(
							`[Library ${this.config.name}] Depth: infinity failed unexpectedly, trying recursive:`,
							errorMessage
						);
					} else {
						throw error;
					}
				}
			}

			// Fall back to recursive listing
			return await this.listRecursive(client, basePath, normalizedExtensions);
		} catch (error) {
			throw this.wrapError(error);
		}
	}

	/**
	 * List files using Depth: infinity (single request)
	 */
	private async listWithDepthInfinity(
		client: WebDAVClient,
		basePath: string,
		extensions: string[]
	): Promise<LibraryFileMetadata[]> {
		const contents = (await client.getDirectoryContents(basePath, {
			deep: true
		})) as Array<{
			type: string;
			filename: string;
			basename: string;
			lastmod: string;
			size: number;
		}>;

		const files: LibraryFileMetadata[] = [];

		for (const item of contents) {
			if (item.type === 'file') {
				const name = item.basename.toLowerCase();
				if (extensions.some((ext) => name.endsWith(ext))) {
					const relativePath = this.getRelativePath(item.filename, basePath);
					files.push({
						libraryId: this.config.id,
						fileId: item.filename,
						path: relativePath,
						modifiedTime: item.lastmod || new Date().toISOString(),
						size: item.size || 0
					});
				}
			}
		}

		console.log(`[Library ${this.config.name}] Listed ${files.length} files (depth infinity)`);
		return files;
	}

	/**
	 * List files using recursive folder traversal
	 */
	private async listRecursive(
		client: WebDAVClient,
		basePath: string,
		extensions: string[]
	): Promise<LibraryFileMetadata[]> {
		const files: LibraryFileMetadata[] = [];

		const processFolder = async (folderPath: string): Promise<void> => {
			const contents = (await client.getDirectoryContents(folderPath)) as Array<{
				type: string;
				filename: string;
				basename: string;
				lastmod: string;
				size: number;
			}>;

			for (const item of contents) {
				if (item.type === 'directory') {
					await processFolder(item.filename);
				} else {
					const name = item.basename.toLowerCase();
					if (extensions.some((ext) => name.endsWith(ext))) {
						const relativePath = this.getRelativePath(item.filename, basePath);
						files.push({
							libraryId: this.config.id,
							fileId: item.filename,
							path: relativePath,
							modifiedTime: item.lastmod || new Date().toISOString(),
							size: item.size || 0
						});
					}
				}
			}
		};

		await processFolder(basePath);
		console.log(`[Library ${this.config.name}] Listed ${files.length} files (recursive)`);
		return files;
	}

	/**
	 * Download a file from the library
	 */
	async downloadFile(fileId: string): Promise<Blob> {
		if (!this.client) {
			await this.connect();
		}

		try {
			// URL encode path segments to handle special characters like #
			const encodedPath = fileId
				.split('/')
				.map((segment) => encodeURIComponent(segment))
				.join('/');

			const response = await this.client!.getFileContents(encodedPath);

			if (response instanceof ArrayBuffer) {
				return new Blob([response]);
			} else if (response instanceof Uint8Array) {
				// Create new ArrayBuffer from Uint8Array for Blob compatibility
				const buffer = new ArrayBuffer(response.byteLength);
				new Uint8Array(buffer).set(response);
				return new Blob([buffer]);
			} else {
				// String response
				return new Blob([response as string]);
			}
		} catch (error) {
			throw this.wrapError(error);
		}
	}

	/**
	 * Get credentials for worker downloads
	 */
	getWorkerCredentials(): { webdavUrl: string; webdavUsername?: string; webdavPassword?: string } {
		return {
			webdavUrl: this.config.serverUrl.replace(/\/$/, ''),
			webdavUsername: this.config.username,
			webdavPassword: this.config.password
		};
	}

	/**
	 * Extract relative path from full WebDAV path
	 */
	private getRelativePath(fullPath: string, basePath: string): string {
		const prefix = basePath === '/' ? '/' : basePath + '/';
		return fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : fullPath;
	}

	/**
	 * Wrap errors with more descriptive messages
	 */
	private wrapError(error: unknown): Error {
		const message = error instanceof Error ? error.message : String(error);

		if (message.includes('401') || message.includes('403') || message.includes('unauthorized')) {
			return new Error(`Authentication failed for library "${this.config.name}": ${message}`);
		}

		if (
			message.includes('Failed to fetch') ||
			message.includes('NetworkError') ||
			message.includes('ENOTFOUND')
		) {
			return new Error(`Cannot connect to library "${this.config.name}": ${message}`);
		}

		if (message.includes('404')) {
			return new Error(
				`Library path not found "${this.config.name}" (${this.basePath}): ${message}`
			);
		}

		return new Error(`Library error "${this.config.name}": ${message}`);
	}
}

/**
 * Create a library client instance
 */
export function createLibraryClient(config: LibraryConfig): LibraryWebDAVClient {
	return new LibraryWebDAVClient(config);
}
