import { browser } from '$app/environment';
import type { SyncProvider, ProviderCredentials, ProviderStatus, WebDAVFileMetadata } from '../../provider-interface';
import { ProviderError } from '../../provider-interface';
import type { WebDAVClient, FileStat } from 'webdav';
import { setActiveProvider, clearActiveProvider } from '../../provider-detection';

interface WebDAVCredentials {
	serverUrl: string;
	username: string;
	password: string;
}

const STORAGE_KEYS = {
	SERVER_URL: 'webdav_server_url',
	USERNAME: 'webdav_username',
	PASSWORD: 'webdav_password'
};

const MOKURO_FOLDER = '/mokuro-reader';

export class WebDAVProvider implements SyncProvider {
	readonly type = 'webdav' as const;
	readonly name = 'WebDAV';
	readonly supportsWorkerDownload = true; // Workers can download directly with Basic Auth
	readonly uploadConcurrencyLimit = 8;
	readonly downloadConcurrencyLimit = 8;

	private client: WebDAVClient | null = null;
	private initPromise: Promise<void> | null = null;

	constructor() {
		// Don't automatically load credentials in constructor
		// Only load when whenReady() is called (which happens for active provider only)
	}

	/**
	 * Wait for provider initialization to complete
	 * Use this to ensure credentials have been restored before checking authentication
	 */
	async whenReady(): Promise<void> {
		// Only initialize once, on first call
		if (!this.initPromise && browser) {
			this.initPromise = this.loadPersistedCredentials();
		}
		await this.initPromise;
	}

	isAuthenticated(): boolean {
		return this.client !== null;
	}

	getStatus(): ProviderStatus {
		const isConnected = this.isAuthenticated();

		// hasStoredCredentials checks if we have actual login credentials stored
		const hasCredentials = !!(
			browser &&
			localStorage.getItem(STORAGE_KEYS.SERVER_URL)
		);

		return {
			isAuthenticated: isConnected,
			hasStoredCredentials: hasCredentials,
			needsAttention: false,
			statusMessage: isConnected ? 'Connected to WebDAV' : hasCredentials ? 'Configured (not connected)' : 'Not configured'
		};
	}

	async login(credentials?: ProviderCredentials): Promise<void> {
		if (!credentials || !credentials.serverUrl) {
			throw new ProviderError(
				'Server URL is required',
				'webdav',
				'INVALID_CREDENTIALS'
			);
		}

		const { serverUrl, username, password } = credentials as WebDAVCredentials;

		// Normalize server URL (remove trailing slash)
		const normalizedUrl = serverUrl.replace(/\/$/, '');

		try {
			console.log('🔧 WebDAV login starting...', { serverUrl: normalizedUrl, hasUsername: !!username, hasPassword: !!password });

			// Dynamically import webdav to reduce initial bundle size
			const { createClient } = await import('webdav');
			console.log('📦 WebDAV module imported');

			// Create WebDAV client (credentials are optional)
			// If either username or password is provided, send both (use empty string for missing)
			const clientOptions: { username?: string; password?: string } = {};
			if (username || password) {
				clientOptions.username = username || '';
				clientOptions.password = password || '';
			}

			this.client = createClient(normalizedUrl, clientOptions);
			console.log('🔌 WebDAV client created, testing connection...');

			// Test connection with timeout
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

			try {
				await this.client.getDirectoryContents('/', { signal: controller.signal });
			} finally {
				clearTimeout(timeoutId);
			}
			console.log('✅ WebDAV connection test passed');

			// Ensure mokuro folder exists
			await this.ensureMokuroFolder();
			console.log('📁 Mokuro folder ensured');

			// Store credentials in localStorage
			if (browser) {
				localStorage.setItem(STORAGE_KEYS.SERVER_URL, normalizedUrl);
				if (username) {
					localStorage.setItem(STORAGE_KEYS.USERNAME, username);
				} else {
					localStorage.removeItem(STORAGE_KEYS.USERNAME);
				}
				if (password) {
					localStorage.setItem(STORAGE_KEYS.PASSWORD, password);
				} else {
					localStorage.removeItem(STORAGE_KEYS.PASSWORD);
				}
			}

			// Set as active provider
			setActiveProvider('webdav');

			console.log('✅ WebDAV login successful');
		} catch (error) {
			this.client = null;

			const errorMessage =
				error instanceof Error ? error.message : 'Unknown error';

			// Provide user-friendly error messages
			let userMessage = `WebDAV login failed: ${errorMessage}`;
			if (errorMessage.includes('401')) {
				userMessage = 'Invalid username or password';
			} else if (errorMessage.includes('404') || errorMessage.includes('ENOTFOUND')) {
				userMessage = 'Server not found. Check the server URL';
			} else if (errorMessage.includes('CORS')) {
				userMessage = 'CORS error. Your WebDAV server may need CORS configuration';
			}

			throw new ProviderError(userMessage, 'webdav', 'LOGIN_FAILED', true);
		}
	}

	async logout(): Promise<void> {
		this.client = null;

		if (browser) {
			// Clear password but keep URL and username for convenience
			localStorage.removeItem(STORAGE_KEYS.PASSWORD);
			clearActiveProvider();
		}

		console.log('WebDAV logged out');
	}

	/**
	 * Get the last used server URL (persists after logout for convenience)
	 */
	getLastServerUrl(): string | null {
		if (!browser) return null;
		return localStorage.getItem(STORAGE_KEYS.SERVER_URL);
	}

	/**
	 * Clear stored server URL (for full reset)
	 */
	clearServerUrl(): void {
		if (browser) {
			localStorage.removeItem(STORAGE_KEYS.SERVER_URL);
			localStorage.removeItem(STORAGE_KEYS.USERNAME);
		}
	}

	private async loadPersistedCredentials(): Promise<void> {
		if (!browser) return;

		const serverUrl = localStorage.getItem(STORAGE_KEYS.SERVER_URL);
		const username = localStorage.getItem(STORAGE_KEYS.USERNAME) || undefined;
		const password = localStorage.getItem(STORAGE_KEYS.PASSWORD) || undefined;

		if (serverUrl) {
			try {
				await this.login({ serverUrl, username, password });
				console.log('Restored WebDAV session from stored credentials');
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);

				// Only clear credentials if they're actually invalid (wrong credentials/URL)
				// Don't clear on network errors or temporary server issues
				const isAuthError =
					errorMessage.includes('401') ||
					errorMessage.includes('403') ||
					errorMessage.includes('unauthorized') ||
					errorMessage.includes('authentication') ||
					errorMessage.includes('credentials') ||
					errorMessage.includes('password');

				if (isAuthError) {
					console.error('WebDAV credentials invalid, clearing stored credentials');
					this.logout();
				} else {
					// Temporary error - keep credentials for retry later
					console.warn('Failed to restore WebDAV session (temporary error), will retry on next sync:', errorMessage);
				}
			}
		}
	}

	private async ensureMokuroFolder(): Promise<void> {
		if (!this.client) return;

		try {
			const exists = await this.client.exists(MOKURO_FOLDER);

			if (!exists) {
				await this.client.createDirectory(MOKURO_FOLDER);
				console.log('Created mokuro-reader folder in WebDAV');
			}
		} catch (error) {
			throw new ProviderError(
				`Failed to ensure mokuro folder exists: ${error instanceof Error ? error.message : 'Unknown error'}`,
				'webdav',
				'FOLDER_ERROR'
			);
		}
	}

	/**
	 * Get stored credentials for worker downloads
	 * Returns null if not authenticated
	 */
	getCredentials(): { serverUrl: string; username?: string; password?: string } | null {
		if (!browser) return null;

		const serverUrl = localStorage.getItem(STORAGE_KEYS.SERVER_URL);
		if (!serverUrl) return null;

		const username = localStorage.getItem(STORAGE_KEYS.USERNAME) || undefined;
		const password = localStorage.getItem(STORAGE_KEYS.PASSWORD) || undefined;

		return { serverUrl, username, password };
	}

	/**
	 * Ensure a series folder exists (may be nested path like "Series/Subseries")
	 */
	private async ensureSeriesFolder(folderPath: string): Promise<void> {
		if (!this.client) return;

		const fullPath = `${MOKURO_FOLDER}/${folderPath}`;

		try {
			const exists = await this.client.exists(fullPath);
			if (!exists) {
				// Use recursive option to create nested folders
				await this.client.createDirectory(fullPath, { recursive: true });
				console.log(`Created series folder: ${folderPath}`);
			}
		} catch (error) {
			throw new ProviderError(
				`Failed to create series folder: ${error instanceof Error ? error.message : 'Unknown error'}`,
				'webdav',
				'FOLDER_ERROR'
			);
		}
	}

	// GENERIC FILE OPERATIONS

	async listCloudVolumes(): Promise<WebDAVFileMetadata[]> {
		if (!this.isAuthenticated() || !this.client) {
			throw new ProviderError('Not authenticated', 'webdav', 'NOT_AUTHENTICATED', true);
		}

		try {
			// Check if mokuro folder exists first
			const folderExists = await this.client.exists(MOKURO_FOLDER);
			if (!folderExists) {
				console.log('Mokuro folder does not exist, returning empty list');
				return [];
			}

			const files: WebDAVFileMetadata[] = [];

			// Recursively get contents without using deep:true (which some servers reject)
			const processFolder = async (folderPath: string) => {
				const contents = await this.client!.getDirectoryContents(folderPath) as FileStat[];

				for (const item of contents) {
					if (item.type === 'directory') {
						// Recurse into subdirectories
						await processFolder(item.filename);
					} else {
						// Check if file is a CBZ or relevant JSON
						const basename = item.basename.toLowerCase();
						const isCbz = basename.endsWith('.cbz');
						const isJson = item.basename === 'volume-data.json' || item.basename === 'profiles.json';

						if (!isCbz && !isJson) continue;

						// Build relative path from mokuro-reader folder
						// item.filename is like /mokuro-reader/Series/Volume.cbz
						// We want: Series/Volume.cbz
						const relativePath = item.filename.replace(`${MOKURO_FOLDER}/`, '');

						files.push({
							provider: 'webdav',
							fileId: item.filename, // Full WebDAV path for operations
							path: relativePath,     // Relative path for display/grouping
							modifiedTime: item.lastmod,
							size: item.size,
							etag: item.etag || undefined
						});
					}
				}
			};

			await processFolder(MOKURO_FOLDER);

			console.log(`✅ Listed ${files.length} files from WebDAV`);
			return files;
		} catch (error) {
			throw new ProviderError(
				`Failed to list cloud volumes: ${error instanceof Error ? error.message : 'Unknown error'}`,
				'webdav',
				'LIST_FAILED',
				false,
				true
			);
		}
	}

	async uploadFile(
		path: string,
		blob: Blob,
		description?: string
	): Promise<string> {
		if (!this.isAuthenticated() || !this.client) {
			throw new ProviderError('Not authenticated', 'webdav', 'NOT_AUTHENTICATED', true);
		}

		try {
			await this.ensureMokuroFolder();

			// Parse path to get series folder (e.g., "SeriesTitle/VolumeTitle.cbz")
			const pathParts = path.split('/');
			if (pathParts.length > 1) {
				// Create series folder if path includes subfolder
				const seriesFolderPath = pathParts.slice(0, -1).join('/');
				await this.ensureSeriesFolder(seriesFolderPath);
			}

			// Convert Blob to ArrayBuffer
			const arrayBuffer = await blob.arrayBuffer();
			const fullPath = `${MOKURO_FOLDER}/${path}`;

			// Delete existing file first to avoid server creating duplicates
			// Some WebDAV servers (like copyparty) rename files instead of overwriting
			try {
				const exists = await this.client.exists(fullPath);
				if (exists) {
					await this.client.deleteFile(fullPath);
				}
			} catch {
				// Ignore errors during delete - file may not exist
			}

			// Upload file
			await this.client.putFileContents(fullPath, arrayBuffer);

			console.log(`✅ Uploaded ${path} to WebDAV`);
			return fullPath;
		} catch (error) {
			throw new ProviderError(
				`Failed to upload file: ${error instanceof Error ? error.message : 'Unknown error'}`,
				'webdav',
				'UPLOAD_FAILED',
				false,
				true
			);
		}
	}

	async downloadFile(
		file: import('../../provider-interface').CloudFileMetadata,
		onProgress?: (loaded: number, total: number) => void
	): Promise<Blob> {
		if (!this.isAuthenticated() || !this.client) {
			throw new ProviderError('Not authenticated', 'webdav', 'NOT_AUTHENTICATED', true);
		}

		try {
			// For WebDAV, fileId is the full path
			const content = await this.client.getFileContents(file.fileId, {
				format: 'binary',
				onDownloadProgress: onProgress ? (e) => onProgress(e.loaded, e.total) : undefined
			});

			// In browser context, webdav returns ArrayBuffer
			// Handle both ArrayBuffer and potential BufferLike responses
			let arrayBuffer: ArrayBuffer;
			if (content instanceof ArrayBuffer) {
				arrayBuffer = content;
			} else if (ArrayBuffer.isView(content)) {
				// Handle typed arrays (Uint8Array, etc.)
				// Create a new ArrayBuffer copy to avoid SharedArrayBuffer issues
				const view = content as Uint8Array;
				arrayBuffer = new Uint8Array(view).buffer as ArrayBuffer;
			} else {
				// Fallback - try to use as-is
				arrayBuffer = content as ArrayBuffer;
			}

			const blob = new Blob([arrayBuffer], { type: 'application/zip' });
			console.log(`✅ Downloaded ${file.path} from WebDAV`);
			return blob;
		} catch (error) {
			throw new ProviderError(
				`Failed to download file: ${error instanceof Error ? error.message : 'Unknown error'}`,
				'webdav',
				'DOWNLOAD_FAILED',
				false,
				true
			);
		}
	}

	async deleteFile(file: import('../../provider-interface').CloudFileMetadata): Promise<void> {
		if (!this.isAuthenticated() || !this.client) {
			throw new ProviderError('Not authenticated', 'webdav', 'NOT_AUTHENTICATED', true);
		}

		try {
			// For WebDAV, fileId is the full path
			await this.client.deleteFile(file.fileId);
			console.log(`✅ Deleted ${file.path} from WebDAV`);
		} catch (error) {
			throw new ProviderError(
				`Failed to delete file: ${error instanceof Error ? error.message : 'Unknown error'}`,
				'webdav',
				'DELETE_FAILED',
				false,
				true
			);
		}
	}

	/**
	 * Delete an entire series folder
	 */
	async deleteSeriesFolder(seriesTitle: string): Promise<void> {
		if (!this.isAuthenticated() || !this.client) {
			throw new ProviderError('Not authenticated', 'webdav', 'NOT_AUTHENTICATED', true);
		}

		try {
			const folderPath = `${MOKURO_FOLDER}/${seriesTitle}`;

			// Check if folder exists
			const exists = await this.client.exists(folderPath);
			if (!exists) {
				console.log(`Series folder '${seriesTitle}' not found in WebDAV`);
				return;
			}

			// Delete the folder (WebDAV deleteFile works on directories too)
			await this.client.deleteFile(folderPath);
			console.log(`✅ Deleted series folder '${seriesTitle}' from WebDAV`);
		} catch (error) {
			throw new ProviderError(
				`Failed to delete series folder: ${error instanceof Error ? error.message : 'Unknown error'}`,
				'webdav',
				'DELETE_FAILED',
				false,
				true
			);
		}
	}

	/**
	 * Check if a file exists at the given path (relative to mokuro-reader folder)
	 */
	async fileExists(path: string): Promise<boolean> {
		if (!this.isAuthenticated() || !this.client) {
			return false;
		}

		try {
			const fullPath = `${MOKURO_FOLDER}/${path}`;
			return await this.client.exists(fullPath);
		} catch {
			return false;
		}
	}

	/**
	 * Download a file directly by path (relative to mokuro-reader folder)
	 * Returns null if file doesn't exist
	 */
	async downloadFileByPath(path: string): Promise<Blob | null> {
		if (!this.isAuthenticated() || !this.client) {
			throw new ProviderError('Not authenticated', 'webdav', 'NOT_AUTHENTICATED', true);
		}

		try {
			const fullPath = `${MOKURO_FOLDER}/${path}`;

			// Check if file exists first
			const exists = await this.client.exists(fullPath);
			if (!exists) {
				return null;
			}

			const content = await this.client.getFileContents(fullPath, {
				format: 'binary'
			});

			// Handle ArrayBuffer response
			let arrayBuffer: ArrayBuffer;
			if (content instanceof ArrayBuffer) {
				arrayBuffer = content;
			} else if (ArrayBuffer.isView(content)) {
				const view = content as Uint8Array;
				arrayBuffer = new Uint8Array(view).buffer as ArrayBuffer;
			} else {
				arrayBuffer = content as ArrayBuffer;
			}

			return new Blob([arrayBuffer], { type: 'application/json' });
		} catch (error) {
			// Return null for 404 errors
			if (error instanceof Error && (
				error.message.includes('404') ||
				error.message.includes('not found')
			)) {
				return null;
			}
			throw new ProviderError(
				`Failed to download file: ${error instanceof Error ? error.message : 'Unknown error'}`,
				'webdav',
				'DOWNLOAD_FAILED',
				false,
				true
			);
		}
	}

	/**
	 * Delete a file directly by path (relative to mokuro-reader folder)
	 * No error if file doesn't exist
	 */
	async deleteFileByPath(path: string): Promise<void> {
		if (!this.isAuthenticated() || !this.client) {
			throw new ProviderError('Not authenticated', 'webdav', 'NOT_AUTHENTICATED', true);
		}

		try {
			const fullPath = `${MOKURO_FOLDER}/${path}`;

			// Check if file exists first
			const exists = await this.client.exists(fullPath);
			if (!exists) {
				return;
			}

			await this.client.deleteFile(fullPath);
			console.log(`✅ Deleted ${path} from WebDAV`);
		} catch (error) {
			throw new ProviderError(
				`Failed to delete file: ${error instanceof Error ? error.message : 'Unknown error'}`,
				'webdav',
				'DELETE_FAILED',
				false,
				true
			);
		}
	}
}

export const webdavProvider = new WebDAVProvider();
