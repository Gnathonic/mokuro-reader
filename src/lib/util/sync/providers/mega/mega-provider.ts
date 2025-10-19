import { browser } from '$app/environment';
import type { SyncProvider, ProviderCredentials, ProviderStatus } from '../../provider-interface';
import { ProviderError } from '../../provider-interface';
import { unifiedCloudManager } from '../../unified-cloud-manager';

interface MegaCredentials {
	email: string;
	password: string;
}

const STORAGE_KEYS = {
	EMAIL: 'mega_email',
	PASSWORD: 'mega_password',
	FOLDER_PATH: 'mega_folder_path'
};

const MOKURO_FOLDER = 'mokuro-reader';
const VOLUME_DATA_FILE = 'volume-data.json';
const PROFILES_FILE = 'profiles.json';

/**
 * Exponential backoff with jitter for retrying MEGA API calls
 */
async function retryWithBackoff<T>(
	operation: () => Promise<T>,
	maxRetries: number = 8,
	baseDelay: number = 500,
	operationName: string = 'operation'
): Promise<T> {
	let lastError: Error | null = null;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await operation();
		} catch (error) {
			lastError = error as Error;

			// Check if error is retryable (EAGAIN, rate limit, temporary congestion)
			const errorMessage = error instanceof Error ? error.message : String(error);
			const isRetryable =
				errorMessage.includes('EAGAIN') ||
				errorMessage.includes('congestion') ||
				errorMessage.includes('rate') ||
				errorMessage.includes('429');

			if (!isRetryable || attempt === maxRetries) {
				// Non-retryable error or max retries reached
				throw error;
			}

			// Calculate exponential backoff with jitter
			// Formula: delay = baseDelay * 2^attempt + random(0, 1000)
			const exponentialDelay = baseDelay * Math.pow(2, attempt);
			const jitter = Math.random() * 1000;
			const delay = exponentialDelay + jitter;

			console.warn(
				`${operationName} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${errorMessage}. Retrying in ${Math.round(delay)}ms...`
			);

			await new Promise(resolve => setTimeout(resolve, delay));
		}
	}

	throw lastError;
}

/**
 * Smart retry wrapper for MEGA operations that may fail due to stale cache
 * When two devices sync back and forth, file IDs change but local cache is stale
 * This wrapper detects ENOENT errors, refreshes the cache, and retries once
 */
async function retryWithCacheRefresh<T>(
	operation: () => Promise<T>,
	operationName: string = 'operation',
	forceReload?: () => Promise<void>
): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);

		// Check if error is ENOENT (file/object not found)
		const isStaleCache =
			errorMessage.includes('ENOENT') ||
			errorMessage.includes('not found') ||
			errorMessage.includes('Object');

		if (isStaleCache) {
			console.warn(
				`${operationName} failed with ENOENT - cache may be stale. Waiting for MEGA to sync and retrying...`
			);

			// Give MEGA time to propagate server changes to storage.files
			// MEGA.js updates storage.files via events, but server changes take time
			await new Promise(resolve => setTimeout(resolve, 2000));

			// Force reload of MEGA's storage.files if provided
			if (forceReload) {
				await forceReload();
			}

			// Refresh our app's cloud cache
			await unifiedCloudManager.fetchAllCloudVolumes();

			// Retry the operation once with fresh cache
			try {
				return await operation();
			} catch (retryError) {
				console.error(`${operationName} failed again after cache refresh:`, retryError);
				throw retryError;
			}
		}

		// Non-stale-cache error, throw immediately
		throw error;
	}
}

export class MegaProvider implements SyncProvider {
	readonly type = 'mega' as const;
	readonly name = 'MEGA';
	readonly supportsWorkerDownload = true; // Workers can download via MEGA API from share links
	readonly uploadConcurrencyLimit = 6;
	readonly downloadConcurrencyLimit = 6;

	private storage: any = null;
	private mokuroFolder: any = null;
	private initPromise: Promise<void>;

	constructor() {
		if (browser) {
			this.initPromise = this.loadPersistedCredentials();
		} else {
			this.initPromise = Promise.resolve();
		}
	}

	/**
	 * Wait for provider initialization to complete
	 * Use this to ensure credentials have been restored before checking authentication
	 */
	async whenReady(): Promise<void> {
		await this.initPromise;
	}

	isAuthenticated(): boolean {
		return this.storage !== null;
	}

	getStatus(): ProviderStatus {
		return {
			isAuthenticated: this.isAuthenticated(),
			needsAttention: false,
			statusMessage: this.isAuthenticated() ? 'Connected to MEGA' : 'Not connected'
		};
	}

	async login(credentials?: ProviderCredentials): Promise<void> {
		if (!credentials || !credentials.email || !credentials.password) {
			throw new ProviderError('Email and password are required', 'mega', 'INVALID_CREDENTIALS');
		}

		const { email, password } = credentials as MegaCredentials;

		try {
			// Dynamically import megajs to reduce initial bundle size
			const { Storage } = await import('megajs');

			// Initialize MEGA storage
			this.storage = await new Promise((resolve, reject) => {
				const storage = new Storage(
					{
						email,
						password
					},
					(error: Error | null) => {
						if (error) {
							reject(error);
						} else {
							resolve(storage);
						}
					}
				);
			});

			// Wait for storage to be ready
			await this.waitForReady();

			// Ensure mokuro folder exists
			await this.ensureMokuroFolder();

			// Store credentials in localStorage
			if (browser) {
				localStorage.setItem(STORAGE_KEYS.EMAIL, email);
				localStorage.setItem(STORAGE_KEYS.PASSWORD, password);
			}

			console.log('✅ MEGA login successful');
		} catch (error) {
			this.storage = null;
			this.mokuroFolder = null;

			throw new ProviderError(
				`MEGA login failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
				'mega',
				'LOGIN_FAILED',
				true
			);
		}
	}

	async logout(): Promise<void> {
		this.storage = null;
		this.mokuroFolder = null;

		if (browser) {
			localStorage.removeItem(STORAGE_KEYS.EMAIL);
			localStorage.removeItem(STORAGE_KEYS.PASSWORD);
			localStorage.removeItem(STORAGE_KEYS.FOLDER_PATH);
		}

		console.log('MEGA logged out');
	}

	async uploadVolumeData(data: any): Promise<void> {
		if (!this.isAuthenticated()) {
			throw new ProviderError('Not authenticated', 'mega', 'NOT_AUTHENTICATED', true);
		}

		try {
			await this.ensureMokuroFolder();
			const content = JSON.stringify(data);
			await this.uploadFile(VOLUME_DATA_FILE, content);
			console.log('✅ Volume data uploaded to MEGA');
		} catch (error) {
			throw new ProviderError(
				`Failed to upload volume data: ${error instanceof Error ? error.message : 'Unknown error'}`,
				'mega',
				'UPLOAD_FAILED',
				false,
				true
			);
		}
	}

	async downloadVolumeData(): Promise<any | null> {
		if (!this.isAuthenticated()) {
			throw new ProviderError('Not authenticated', 'mega', 'NOT_AUTHENTICATED', true);
		}

		try {
			await this.ensureMokuroFolder();
			const content = await this.downloadFile(VOLUME_DATA_FILE);
			if (!content) return null;

			return JSON.parse(content);
		} catch (error) {
			// File not found is not an error, just return null
			if (error instanceof Error && error.message.includes('not found')) {
				return null;
			}

			throw new ProviderError(
				`Failed to download volume data: ${error instanceof Error ? error.message : 'Unknown error'}`,
				'mega',
				'DOWNLOAD_FAILED',
				false,
				true
			);
		}
	}

	async uploadProfiles(data: any): Promise<void> {
		if (!this.isAuthenticated()) {
			throw new ProviderError('Not authenticated', 'mega', 'NOT_AUTHENTICATED', true);
		}

		try {
			await this.ensureMokuroFolder();
			const content = JSON.stringify(data);
			await this.uploadFile(PROFILES_FILE, content);
			console.log('✅ Profiles uploaded to MEGA');
		} catch (error) {
			throw new ProviderError(
				`Failed to upload profiles: ${error instanceof Error ? error.message : 'Unknown error'}`,
				'mega',
				'UPLOAD_FAILED',
				false,
				true
			);
		}
	}

	async downloadProfiles(): Promise<any | null> {
		if (!this.isAuthenticated()) {
			throw new ProviderError('Not authenticated', 'mega', 'NOT_AUTHENTICATED', true);
		}

		try {
			await this.ensureMokuroFolder();
			const content = await this.downloadFile(PROFILES_FILE);
			if (!content) return null;

			return JSON.parse(content);
		} catch (error) {
			// File not found is not an error, just return null
			if (error instanceof Error && error.message.includes('not found')) {
				return null;
			}

			throw new ProviderError(
				`Failed to download profiles: ${error instanceof Error ? error.message : 'Unknown error'}`,
				'mega',
				'DOWNLOAD_FAILED',
				false,
				true
			);
		}
	}

	async loadPersistedCredentials(): Promise<void> {
		if (!browser) return;

		const email = localStorage.getItem(STORAGE_KEYS.EMAIL);
		const password = localStorage.getItem(STORAGE_KEYS.PASSWORD);

		if (email && password) {
			try {
				await this.login({ email, password });
				console.log('Restored MEGA session from stored credentials');
			} catch (error) {
				console.error('Failed to restore MEGA session:', error);
				// Clear invalid credentials
				this.logout();
			}
		}
	}

	private waitForReady(): Promise<void> {
		return new Promise((resolve, reject) => {
			// If storage is already ready, resolve immediately
			if (this.storage.ready) {
				resolve();
				return;
			}

			// Wait for ready event
			const timeout = setTimeout(() => {
				reject(new Error('Timeout waiting for MEGA storage to be ready'));
			}, 30000); // 30 second timeout

			this.storage.once('ready', () => {
				clearTimeout(timeout);
				resolve();
			});

			// Also listen for error events
			this.storage.once('error', (error: Error) => {
				clearTimeout(timeout);
				reject(error);
			});
		});
	}

	/**
	 * Reinitialize the MEGA connection to get a fresh storage cache
	 * This is needed when files change on other devices and the cache becomes stale
	 */
	private async reinitialize(): Promise<void> {
		if (!browser) return;

		// Save current credentials
		const email = localStorage.getItem(STORAGE_KEYS.EMAIL);
		const password = localStorage.getItem(STORAGE_KEYS.PASSWORD);

		if (!email || !password) {
			console.warn('Cannot reinitialize MEGA: no stored credentials');
			return;
		}

		console.log('🔄 Reinitializing MEGA connection to refresh cache...');

		// Clear current storage
		this.storage = null;
		this.mokuroFolder = null;

		// Reconnect with fresh credentials
		try {
			await this.login({ email, password });
			console.log('✅ MEGA connection reinitialized successfully');
		} catch (error) {
			console.error('Failed to reinitialize MEGA:', error);
			throw error;
		}
	}

	private async ensureMokuroFolder(): Promise<any> {
		try {
			// Always get fresh reference from storage.files to avoid stale references
			const files = Object.values(this.storage.files || {});

			// Find mokuro-reader folder anywhere, regardless of parent
			// Note: We don't check parent because MEGA's root folder location varies by account/locale
			let mokuroFolder = files.find(
				(f: any) => f.name === MOKURO_FOLDER && f.directory
			);

			if (!mokuroFolder) {
				// Create folder using storage.mkdir
				mokuroFolder = await this.createFolder(MOKURO_FOLDER);
				console.log('Created mokuro-reader folder in MEGA');
			}

			// Cache for cleanup on logout, but don't use for operations
			this.mokuroFolder = mokuroFolder;

			// Return fresh reference for immediate use
			return mokuroFolder;
		} catch (error) {
			console.error('ensureMokuroFolder error:', error);
			throw new ProviderError(
				`Failed to ensure mokuro folder exists: ${error instanceof Error ? error.message : 'Unknown error'}`,
				'mega',
				'FOLDER_ERROR'
			);
		}
	}

	private listFolder(folder: any): Promise<any[]> {
		return new Promise((resolve, reject) => {
			// Get all files from storage
			const files = Object.values(this.storage.files || {});

			// Filter files that are children of this folder
			const children = files.filter((f: any) => f.parent === folder);
			resolve(children);
		});
	}

	private createFolder(name: string): Promise<any> {
		return new Promise((resolve, reject) => {
			this.storage.mkdir(name, (error: Error | null, folder: any) => {
				if (error) {
					reject(error);
				} else {
					resolve(folder);
				}
			});
		});
	}

	private async uploadFile(filename: string, content: string): Promise<void> {
		// Wrap JSON file uploads with smart cache refresh retry
		return retryWithCacheRefresh(async () => {
			const mokuroFolder = await this.ensureMokuroFolder();

			return new Promise<void>(async (resolve, reject) => {
				try {
					// Check if file already exists using storage.files
					const children = await this.listFolder(mokuroFolder);
					const existingFile = children.find((f: any) => f.name === filename && !f.directory);

					const uploadNew = () => {
						// Convert string to Uint8Array (browser-compatible)
						const encoder = new TextEncoder();
						const contentBuffer = encoder.encode(content);

						mokuroFolder.upload(
							{
								name: filename,
								size: contentBuffer.length
							},
							contentBuffer,
							(error: Error | null) => {
								if (error) reject(error);
								else resolve();
							}
						);
					};

					if (existingFile) {
						// Delete existing file first
						existingFile.delete(true, (deleteError: Error | null) => {
							if (deleteError) {
								reject(deleteError);
							} else {
								uploadNew();
							}
						});
					} else {
						uploadNew();
					}
				} catch (error) {
					reject(error);
				}
			});
		}, `Upload ${filename}`, this.reinitialize.bind(this));
	}

	private async downloadFile(filename: string): Promise<string | null> {
		// Wrap JSON file downloads with smart cache refresh retry
		return retryWithCacheRefresh(async () => {
			const mokuroFolder = await this.ensureMokuroFolder();

			const children = await this.listFolder(mokuroFolder);
			const file = children.find((f: any) => f.name === filename && !f.directory);

			if (!file) {
				return null;
			}

			return new Promise<string>((resolve, reject) => {
				file.download((error: Error | null, data: Uint8Array) => {
					if (error) {
						reject(error);
					} else {
						// Convert Uint8Array to string (browser-compatible)
						const decoder = new TextDecoder('utf-8');
						const text = decoder.decode(data);
						resolve(text);
					}
				});
			});
		}, `Download ${filename}`, this.reinitialize.bind(this));
	}

	// VOLUME STORAGE METHODS

	async listCloudVolumes(): Promise<import('../../provider-interface').CloudVolumeMetadata[]> {
		if (!this.isAuthenticated()) {
			throw new ProviderError('Not authenticated', 'mega', 'NOT_AUTHENTICATED', true);
		}

		try {
			await this.ensureMokuroFolder();

			// Get all files from storage
			const files = Object.values(this.storage.files || {});

			// DEBUG: Log what we're seeing in MEGA
			console.log(`🔍 MEGA Debug: Total files/folders in storage: ${files.length}`);
			const rootItems = files.filter((f: any) => !f.parent);
			console.log(`🔍 MEGA Debug: Root items: ${rootItems.length}`);
			rootItems.forEach((item: any) => {
				console.log(`  - ${item.directory ? '[DIR]' : '[FILE]'} ${item.name}`);
			});

			const allCbzFiles = files.filter((f: any) => !f.directory && (f.name || '').toLowerCase().endsWith('.cbz'));
			console.log(`🔍 MEGA Debug: Total CBZ files anywhere: ${allCbzFiles.length}`);
			allCbzFiles.slice(0, 5).forEach((f: any) => {
				console.log(`  - ${f.name} (parent: ${f.parent?.name || 'root'})`);
			});

			// Find ALL mokuro-reader folders (there may be multiple from different sessions)
			// Note: We don't check parent because MEGA's root folder location varies by account/locale
			const mokuroFolders = files.filter(
				(f: any) => f.name === MOKURO_FOLDER && f.directory
			);
			console.log(`🔍 MEGA Debug: Found ${mokuroFolders.length} mokuro-reader folder(s)`);

			// Filter CBZ files that are in ANY mokuro-reader folder or its subfolders
			const cbzFiles: import('../../provider-interface').CloudVolumeMetadata[] = [];

			for (const file of files) {
				// Skip non-files
				if ((file as any).directory) continue;

				// Check if file is a CBZ
				const name = (file as any).name || '';
				if (!name.toLowerCase().endsWith('.cbz')) continue;

				// Check if file is in ANY mokuro-reader folder or subfolder
				let parent = (file as any).parent;
				let pathParts: string[] = [];
				let foundMokuroRoot = false;
				let isInTrash = false;

				// Walk up the tree to build path and verify it's under a mokuro-reader folder
				while (parent) {
					// Check if any parent is the Rubbish Bin (trash)
					if (parent.name === 'Rubbish Bin') {
						isInTrash = true;
						break;
					}

					// Check if this parent is ANY mokuro-reader folder
					const isMokuroFolder = mokuroFolders.some((mf: any) => mf === parent);
					if (isMokuroFolder) {
						foundMokuroRoot = true;
						break;
					}
					if (parent.name) {
						pathParts.unshift(parent.name);
					}
					parent = parent.parent;
				}

				// Skip files in trash
				if (isInTrash) continue;

				// If we found mokuro root, this file is under a mokuro-reader folder
				if (foundMokuroRoot) {
					// Build path as "SeriesTitle/VolumeTitle.cbz"
					pathParts.push(name);
					const path = pathParts.join('/');

					// Get file metadata
					const fileId = (file as any).nodeId || (file as any).id || '';
					const modifiedTime = (file as any).timestamp
						? new Date((file as any).timestamp * 1000).toISOString()
						: new Date().toISOString();
					const size = (file as any).size || 0;

					cbzFiles.push({
						fileId,
						path,
						modifiedTime,
						size
					});
				}
			}

			console.log(`✅ Listed ${cbzFiles.length} CBZ files from MEGA`);
			return cbzFiles;
		} catch (error) {
			throw new ProviderError(
				`Failed to list cloud volumes: ${error instanceof Error ? error.message : 'Unknown error'}`,
				'mega',
				'LIST_FAILED',
				false,
				true
			);
		}
	}

	async uploadVolumeCbz(
		path: string,
		blob: Blob,
		description?: string
	): Promise<string> {
		if (!this.isAuthenticated()) {
			throw new ProviderError('Not authenticated', 'mega', 'NOT_AUTHENTICATED', true);
		}

		try {
			const mokuroFolder = await this.ensureMokuroFolder();

			// Parse path: "SeriesTitle/VolumeTitle.cbz"
			const pathParts = path.split('/');
			const fileName = pathParts.pop() || path;
			const seriesFolderName = pathParts.join('/');

			// Find or create series folder if path includes subfolder
			let targetFolder = mokuroFolder;
			if (seriesFolderName) {
				targetFolder = await this.ensureSeriesFolder(seriesFolderName, mokuroFolder);
			}

			// Convert Blob to ArrayBuffer
			const arrayBuffer = await blob.arrayBuffer();
			const buffer = new Uint8Array(arrayBuffer);

			// Check if file already exists
			const children = await this.listFolder(targetFolder);
			const existingFile = children.find((f: any) => f.name === fileName && !f.directory);

			// Delete existing file if found
			if (existingFile) {
				await new Promise<void>((resolve, reject) => {
					existingFile.delete(true, (error: Error | null) => {
						if (error) reject(error);
						else resolve();
					});
				});
			}

			// Upload new file
			return new Promise((resolve, reject) => {
				targetFolder.upload(
					{
						name: fileName,
						size: buffer.length
					},
					buffer,
					(error: Error | null, file: any) => {
						if (error) {
							reject(error);
						} else {
							const fileId = file?.nodeId || file?.id || '';
							console.log(`✅ Uploaded ${fileName} to MEGA (${fileId})`);
							resolve(fileId);
						}
					}
				);
			});
		} catch (error) {
			throw new ProviderError(
				`Failed to upload volume CBZ: ${error instanceof Error ? error.message : 'Unknown error'}`,
				'mega',
				'UPLOAD_FAILED',
				false,
				true
			);
		}
	}

	async downloadVolumeCbz(
		fileId: string,
		onProgress?: (loaded: number, total: number) => void
	): Promise<Blob> {
		if (!this.isAuthenticated()) {
			throw new ProviderError('Not authenticated', 'mega', 'NOT_AUTHENTICATED', true);
		}

		try {
			// Find the file by ID
			const files = Object.values(this.storage.files || {});
			const file = files.find(
				(f: any) => (f.nodeId === fileId || f.id === fileId) && !f.directory
			);

			if (!file) {
				throw new Error('File not found');
			}

			return new Promise((resolve, reject) => {
				const fileObj = file as any;

				// Use download with progress callback if provided
				if (onProgress) {
					// MEGA.js download supports progress via stream options
					const stream = fileObj.download({ returnCiphertext: false });

					const chunks: Uint8Array[] = [];
					let loaded = 0;
					const total = fileObj.size || 0;

					stream.on('data', (chunk: Uint8Array) => {
						chunks.push(chunk);
						loaded += chunk.length;
						onProgress(loaded, total);
					});

					stream.on('end', () => {
						// Combine all chunks into a single Uint8Array
						const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
						const combined = new Uint8Array(totalLength);
						let offset = 0;
						for (const chunk of chunks) {
							combined.set(chunk, offset);
							offset += chunk.length;
						}

						const blob = new Blob([combined], { type: 'application/zip' });
						console.log(`✅ Downloaded ${fileObj.name} from MEGA`);
						resolve(blob);
					});

					stream.on('error', (error: Error) => {
						reject(error);
					});
				} else {
					// Simple download without progress
					fileObj.download((error: Error | null, data: Uint8Array) => {
						if (error) {
							reject(error);
						} else {
							// Convert to standard Uint8Array to satisfy TypeScript
							const standardArray = new Uint8Array(Array.from(data));
							const blob = new Blob([standardArray], { type: 'application/zip' });
							console.log(`✅ Downloaded ${fileObj.name} from MEGA`);
							resolve(blob);
						}
					});
				}
			});
		} catch (error) {
			throw new ProviderError(
				`Failed to download volume CBZ: ${error instanceof Error ? error.message : 'Unknown error'}`,
				'mega',
				'DOWNLOAD_FAILED',
				false,
				true
			);
		}
	}

	async deleteVolumeCbz(fileId: string): Promise<void> {
		if (!this.isAuthenticated()) {
			throw new ProviderError('Not authenticated', 'mega', 'NOT_AUTHENTICATED', true);
		}

		try {
			// Find the file by ID
			const files = Object.values(this.storage.files || {});
			const file = files.find(
				(f: any) => (f.nodeId === fileId || f.id === fileId) && !f.directory
			);

			if (!file) {
				throw new Error('File not found');
			}

			return new Promise((resolve, reject) => {
				(file as any).delete(true, (error: Error | null) => {
					if (error) {
						reject(error);
					} else {
						console.log(`✅ Deleted file from MEGA (${fileId})`);
						resolve();
					}
				});
			});
		} catch (error) {
			throw new ProviderError(
				`Failed to delete volume CBZ: ${error instanceof Error ? error.message : 'Unknown error'}`,
				'mega',
				'DELETE_FAILED',
				false,
				true
			);
		}
	}

	/**
	 * Create a temporary share link for a file
	 * Returns a public download URL that includes the decryption key
	 * Uses exponential backoff to handle MEGA rate limiting
	 *
	 * IMPORTANT: MEGA likely reuses existing share links, so calling this multiple
	 * times on the same file returns the same URL. This means orphaned links from
	 * previous failed cleanup attempts are automatically reused - a self-healing behavior.
	 */
	async createShareLink(fileId: string): Promise<string> {
		if (!this.isAuthenticated()) {
			throw new ProviderError('Not authenticated', 'mega', 'NOT_AUTHENTICATED', true);
		}

		try {
			// Wrap the share link creation with retry logic
			return await retryWithBackoff(
				async () => {
					// Find the file by ID
					const files = Object.values(this.storage.files || {});
					const file = files.find(
						(f: any) => (f.nodeId === fileId || f.id === fileId) && !f.directory
					);

					if (!file) {
						throw new Error('File not found');
					}

					return new Promise<string>((resolve, reject) => {
						// Create/get share link with decryption key (noKey: false is default)
						// NOTE: If file already has a share link, MEGA API likely returns the existing one
						(file as any).link((error: Error | null, url: string) => {
							if (error) {
								reject(error);
							} else {
								resolve(url);
							}
						});
					});
				},
				8, // maxRetries
				500, // baseDelay (ms)
				`Create MEGA share link (${fileId})`
			);
		} catch (error) {
			throw new ProviderError(
				`Failed to create share link: ${error instanceof Error ? error.message : 'Unknown error'}`,
				'mega',
				'LINK_FAILED',
				false,
				true
			);
		}
	}

	/**
	 * Delete a share link for a file
	 * This removes the public share link to prevent clutter
	 */
	async deleteShareLink(fileId: string): Promise<void> {
		if (!this.isAuthenticated()) {
			throw new ProviderError('Not authenticated', 'mega', 'NOT_AUTHENTICATED', true);
		}

		try {
			// Find the file by ID
			const files = Object.values(this.storage.files || {});
			const file = files.find(
				(f: any) => (f.nodeId === fileId || f.id === fileId) && !f.directory
			);

			if (!file) {
				throw new Error('File not found');
			}

			return new Promise((resolve, reject) => {
				// Unshare the file (removes the share link)
				(file as any).unshare((error: Error | null) => {
					if (error) {
						reject(error);
					} else {
						console.log(`✅ Deleted MEGA share link for file ${fileId}`);
						resolve();
					}
				});
			});
		} catch (error) {
			throw new ProviderError(
				`Failed to delete share link: ${error instanceof Error ? error.message : 'Unknown error'}`,
				'mega',
				'UNSHARE_FAILED',
				false,
				true
			);
		}
	}

	/**
	 * Delete an entire series folder
	 */
	async deleteSeriesFolder(seriesTitle: string): Promise<void> {
		if (!this.isAuthenticated()) {
			throw new ProviderError('Not authenticated', 'mega', 'NOT_AUTHENTICATED', true);
		}

		try {
			const mokuroFolder = await this.ensureMokuroFolder();

			// Find the series folder
			const children = await this.listFolder(mokuroFolder);
			const seriesFolder = children.find((f: any) => f.name === seriesTitle && f.directory);

			if (!seriesFolder) {
				console.log(`Series folder '${seriesTitle}' not found in MEGA`);
				return;
			}

			// Delete the folder (recursive delete)
			await new Promise<void>((resolve, reject) => {
				seriesFolder.delete(true, (error: Error | null) => {
					if (error) {
						reject(error);
					} else {
						console.log(`✅ Deleted series folder '${seriesTitle}' from MEGA`);
						resolve();
					}
				});
			});
		} catch (error) {
			throw new ProviderError(
				`Failed to delete series folder: ${error instanceof Error ? error.message : 'Unknown error'}`,
				'mega',
				'DELETE_FAILED',
				false,
				true
			);
		}
	}

	/**
	 * Ensure a series folder exists (may be nested path like "Series/Subseries")
	 */
	private async ensureSeriesFolder(folderPath: string, mokuroFolder: any): Promise<any> {
		const pathParts = folderPath.split('/').filter(Boolean);
		let currentFolder = mokuroFolder;

		for (const folderName of pathParts) {
			// Check if subfolder exists
			const children = await this.listFolder(currentFolder);
			let subfolder = children.find((f: any) => f.name === folderName && f.directory);

			if (!subfolder) {
				// Create subfolder under current folder
				subfolder = await new Promise((resolve, reject) => {
					currentFolder.mkdir(folderName, (error: Error | null, folder: any) => {
						if (error) reject(error);
						else resolve(folder);
					});
				});
				console.log(`Created folder: ${folderName}`);
			}

			currentFolder = subfolder;
		}

		return currentFolder;
	}
}

export const megaProvider = new MegaProvider();
