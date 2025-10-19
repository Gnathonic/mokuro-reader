import { browser } from '$app/environment';
import type { SyncProvider, ProviderCredentials, ProviderStatus } from '../../provider-interface';
import { ProviderError } from '../../provider-interface';
import type { WebDAVClient } from 'webdav';

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
const VOLUME_DATA_FILE = '/mokuro-reader/volume-data.json';
const PROFILES_FILE = '/mokuro-reader/profiles.json';

export class WebDAVProvider implements SyncProvider {
	readonly type = 'webdav' as const;
	readonly name = 'WebDAV';
	readonly supportsWorkerDownload = true; // Workers can download directly with Basic Auth
	readonly uploadConcurrencyLimit = 2; // Conservative, depends on server capacity
	readonly downloadConcurrencyLimit = 2;

	private client: WebDAVClient | null = null;
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
		return this.client !== null;
	}

	getStatus(): ProviderStatus {
		return {
			isAuthenticated: this.isAuthenticated(),
			needsAttention: false,
			statusMessage: this.isAuthenticated() ? 'Connected to WebDAV' : 'Not connected'
		};
	}

	async login(credentials?: ProviderCredentials): Promise<void> {
		if (
			!credentials ||
			!credentials.serverUrl ||
			!credentials.username ||
			!credentials.password
		) {
			throw new ProviderError(
				'Server URL, username, and password are required',
				'webdav',
				'INVALID_CREDENTIALS'
			);
		}

		const { serverUrl, username, password } = credentials as WebDAVCredentials;

		// Normalize server URL (remove trailing slash)
		const normalizedUrl = serverUrl.replace(/\/$/, '');

		try {
			// Dynamically import webdav to reduce initial bundle size
			const { createClient } = await import('webdav');

			// Create WebDAV client
			this.client = createClient(normalizedUrl, {
				username,
				password
			});

			// Test connection by getting server info
			await this.client.getDirectoryContents('/');

			// Ensure mokuro folder exists
			await this.ensureMokuroFolder();

			// Store credentials in localStorage
			if (browser) {
				localStorage.setItem(STORAGE_KEYS.SERVER_URL, normalizedUrl);
				localStorage.setItem(STORAGE_KEYS.USERNAME, username);
				localStorage.setItem(STORAGE_KEYS.PASSWORD, password);
			}

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
			localStorage.removeItem(STORAGE_KEYS.SERVER_URL);
			localStorage.removeItem(STORAGE_KEYS.USERNAME);
			localStorage.removeItem(STORAGE_KEYS.PASSWORD);
		}

		console.log('WebDAV logged out');
	}

	async uploadVolumeData(data: any): Promise<void> {
		if (!this.isAuthenticated() || !this.client) {
			throw new ProviderError('Not authenticated', 'webdav', 'NOT_AUTHENTICATED', true);
		}

		try {
			await this.ensureMokuroFolder();
			const content = JSON.stringify(data);
			await this.client.putFileContents(VOLUME_DATA_FILE, content, {
				overwrite: true
			});
			console.log('✅ Volume data uploaded to WebDAV');
		} catch (error) {
			throw new ProviderError(
				`Failed to upload volume data: ${error instanceof Error ? error.message : 'Unknown error'}`,
				'webdav',
				'UPLOAD_FAILED',
				false,
				true
			);
		}
	}

	async downloadVolumeData(): Promise<any | null> {
		if (!this.isAuthenticated() || !this.client) {
			throw new ProviderError('Not authenticated', 'webdav', 'NOT_AUTHENTICATED', true);
		}

		try {
			await this.ensureMokuroFolder();

			// Check if file exists
			const exists = await this.client.exists(VOLUME_DATA_FILE);
			if (!exists) {
				return null;
			}

			const content = await this.client.getFileContents(VOLUME_DATA_FILE, {
				format: 'text'
			});

			return JSON.parse(content as string);
		} catch (error) {
			// File not found is not an error, just return null
			const errorMessage = error instanceof Error ? error.message : '';
			if (errorMessage.includes('404') || errorMessage.includes('not found')) {
				return null;
			}

			throw new ProviderError(
				`Failed to download volume data: ${errorMessage || 'Unknown error'}`,
				'webdav',
				'DOWNLOAD_FAILED',
				false,
				true
			);
		}
	}

	async uploadProfiles(data: any): Promise<void> {
		if (!this.isAuthenticated() || !this.client) {
			throw new ProviderError('Not authenticated', 'webdav', 'NOT_AUTHENTICATED', true);
		}

		try {
			await this.ensureMokuroFolder();
			const content = JSON.stringify(data);
			await this.client.putFileContents(PROFILES_FILE, content, {
				overwrite: true
			});
			console.log('✅ Profiles uploaded to WebDAV');
		} catch (error) {
			throw new ProviderError(
				`Failed to upload profiles: ${error instanceof Error ? error.message : 'Unknown error'}`,
				'webdav',
				'UPLOAD_FAILED',
				false,
				true
			);
		}
	}

	async downloadProfiles(): Promise<any | null> {
		if (!this.isAuthenticated() || !this.client) {
			throw new ProviderError('Not authenticated', 'webdav', 'NOT_AUTHENTICATED', true);
		}

		try {
			await this.ensureMokuroFolder();

			// Check if file exists
			const exists = await this.client.exists(PROFILES_FILE);
			if (!exists) {
				return null;
			}

			const content = await this.client.getFileContents(PROFILES_FILE, {
				format: 'text'
			});

			return JSON.parse(content as string);
		} catch (error) {
			// File not found is not an error, just return null
			const errorMessage = error instanceof Error ? error.message : '';
			if (errorMessage.includes('404') || errorMessage.includes('not found')) {
				return null;
			}

			throw new ProviderError(
				`Failed to download profiles: ${errorMessage || 'Unknown error'}`,
				'webdav',
				'DOWNLOAD_FAILED',
				false,
				true
			);
		}
	}

	private async loadPersistedCredentials(): Promise<void> {
		if (!browser) return;

		const serverUrl = localStorage.getItem(STORAGE_KEYS.SERVER_URL);
		const username = localStorage.getItem(STORAGE_KEYS.USERNAME);
		const password = localStorage.getItem(STORAGE_KEYS.PASSWORD);

		if (serverUrl && username && password) {
			try {
				await this.login({ serverUrl, username, password });
				console.log('Restored WebDAV session from stored credentials');
			} catch (error) {
				console.error('Failed to restore WebDAV session:', error);
				// Clear invalid credentials
				this.logout();
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
}

export const webdavProvider = new WebDAVProvider();
