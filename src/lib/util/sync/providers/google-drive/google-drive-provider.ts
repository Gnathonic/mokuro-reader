import { browser } from '$app/environment';
import type { SyncProvider, ProviderStatus, CloudVolumeMetadata } from '../../provider-interface';
import { ProviderError } from '../../provider-interface';
import { tokenManager } from '$lib/util/google-drive/token-manager';
import { driveApiClient } from '$lib/util/google-drive/api-client';
import { GOOGLE_DRIVE_CONFIG } from '$lib/util/google-drive/constants';
import { parseVolumesFromJson } from '$lib/settings';
import { getOrCreateFolder, uploadCbzToDrive } from '$lib/util/backup';

/**
 * Google Drive Provider
 *
 * Wraps existing Google Drive integration into the unified SyncProvider interface.
 * This allows Drive to work alongside MEGA and WebDAV providers.
 */
export class GoogleDriveProvider implements SyncProvider {
	readonly type = 'google-drive' as const;
	readonly name = 'Google Drive';
	readonly supportsWorkerDownload = true; // Workers can download directly with access token
	readonly uploadConcurrencyLimit = 4;
	readonly downloadConcurrencyLimit = 4;

	private readerFolderId: string | null = null;

	isAuthenticated(): boolean {
		return tokenManager.isAuthenticated();
	}

	getStatus(): ProviderStatus {
		const authenticated = this.isAuthenticated();
		const timeLeft = tokenManager.getTimeUntilExpiry();
		const needsAttention = authenticated && timeLeft !== null && timeLeft < 5 * 60 * 1000; // Less than 5 minutes

		let statusMessage = 'Not connected';
		if (authenticated) {
			statusMessage = needsAttention ? 'Token expiring soon' : 'Connected to Google Drive';
		}

		return {
			isAuthenticated: authenticated,
			needsAttention,
			statusMessage
		};
	}

	async login(): Promise<void> {
		try {
			if (!browser) {
				throw new Error('Google Drive auth only works in browser');
			}

			// Initialize Drive API if needed
			await driveApiClient.initialize();

			// Request OAuth token (will show Google sign-in if needed)
			tokenManager.requestNewToken(true, false);

			// Wait for token to be set
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => {
					reject(new Error('Login timeout'));
				}, 60000); // 60 second timeout

				const unsubscribe = tokenManager.token.subscribe(token => {
					if (token) {
						clearTimeout(timeout);
						unsubscribe();
						resolve();
					}
				});
			});

			console.log('✅ Google Drive login successful');
		} catch (error) {
			throw new ProviderError(
				`Google Drive login failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
				'google-drive',
				'LOGIN_FAILED',
				true
			);
		}
	}

	async logout(): Promise<void> {
		tokenManager.clearToken();
		this.readerFolderId = null;
		console.log('Google Drive logged out');
	}

	async uploadVolumeData(data: any): Promise<void> {
		if (!this.isAuthenticated()) {
			throw new ProviderError('Not authenticated', 'google-drive', 'NOT_AUTHENTICATED', true);
		}

		try {
			// Ensure reader folder exists
			const folderId = await this.ensureReaderFolder();

			// Query for existing volume-data.json file
			const files = await driveApiClient.listFiles(
				`'${folderId}' in parents and name='${GOOGLE_DRIVE_CONFIG.FILE_NAMES.VOLUME_DATA}' and trashed=false`,
				'files(id)'
			);
			const existingFileId = files.length > 0 ? files[0].id : null;

			// Upload (create or update)
			const content = JSON.stringify(data);
			const metadata = {
				name: GOOGLE_DRIVE_CONFIG.FILE_NAMES.VOLUME_DATA,
				mimeType: GOOGLE_DRIVE_CONFIG.MIME_TYPES.JSON,
				...(existingFileId ? {} : { parents: [folderId] })
			};

			await driveApiClient.uploadFile(content, metadata, existingFileId || undefined);
			console.log('✅ Volume data uploaded to Google Drive');
		} catch (error) {
			throw new ProviderError(
				`Failed to upload volume data: ${error instanceof Error ? error.message : 'Unknown error'}`,
				'google-drive',
				'UPLOAD_FAILED',
				false,
				true
			);
		}
	}

	async downloadVolumeData(): Promise<any | null> {
		if (!this.isAuthenticated()) {
			throw new ProviderError('Not authenticated', 'google-drive', 'NOT_AUTHENTICATED', true);
		}

		try {
			// Ensure reader folder exists
			const folderId = await this.ensureReaderFolder();

			// Query for volume-data.json file
			const files = await driveApiClient.listFiles(
				`'${folderId}' in parents and name='${GOOGLE_DRIVE_CONFIG.FILE_NAMES.VOLUME_DATA}' and trashed=false`,
				'files(id)'
			);

			if (files.length === 0) {
				return null;
			}

			// Download and parse
			const content = await driveApiClient.getFileContent(files[0].id);
			return parseVolumesFromJson(content);
		} catch (error) {
			// File not found is not an error
			if (error instanceof Error && error.message.includes('not found')) {
				return null;
			}

			throw new ProviderError(
				`Failed to download volume data: ${error instanceof Error ? error.message : 'Unknown error'}`,
				'google-drive',
				'DOWNLOAD_FAILED',
				false,
				true
			);
		}
	}

	async uploadProfiles(data: any): Promise<void> {
		if (!this.isAuthenticated()) {
			throw new ProviderError('Not authenticated', 'google-drive', 'NOT_AUTHENTICATED', true);
		}

		try {
			// Ensure reader folder exists
			const folderId = await this.ensureReaderFolder();

			// Find existing profiles.json file
			const files = await driveApiClient.listFiles(
				`'${folderId}' in parents and name='${GOOGLE_DRIVE_CONFIG.FILE_NAMES.PROFILES}'`,
				'files(id)'
			);
			const existingFileId = files.length > 0 ? files[0].id : null;

			// Upload (create or update)
			const content = JSON.stringify(data);
			const metadata = {
				name: GOOGLE_DRIVE_CONFIG.FILE_NAMES.PROFILES,
				mimeType: GOOGLE_DRIVE_CONFIG.MIME_TYPES.JSON,
				...(existingFileId ? {} : { parents: [folderId] })
			};

			await driveApiClient.uploadFile(content, metadata, existingFileId || undefined);
			console.log('✅ Profiles uploaded to Google Drive');
		} catch (error) {
			throw new ProviderError(
				`Failed to upload profiles: ${error instanceof Error ? error.message : 'Unknown error'}`,
				'google-drive',
				'UPLOAD_FAILED',
				false,
				true
			);
		}
	}

	async downloadProfiles(): Promise<any | null> {
		if (!this.isAuthenticated()) {
			throw new ProviderError('Not authenticated', 'google-drive', 'NOT_AUTHENTICATED', true);
		}

		try {
			// Ensure reader folder exists
			const folderId = await this.ensureReaderFolder();

			// Find profiles.json file
			const files = await driveApiClient.listFiles(
				`'${folderId}' in parents and name='${GOOGLE_DRIVE_CONFIG.FILE_NAMES.PROFILES}'`,
				'files(id)'
			);

			if (files.length === 0) {
				return null;
			}

			// Download and parse
			const content = await driveApiClient.getFileContent(files[0].id);
			return JSON.parse(content);
		} catch (error) {
			// File not found is not an error
			if (error instanceof Error && error.message.includes('not found')) {
				return null;
			}

			throw new ProviderError(
				`Failed to download profiles: ${error instanceof Error ? error.message : 'Unknown error'}`,
				'google-drive',
				'DOWNLOAD_FAILED',
				false,
				true
			);
		}
	}

	// VOLUME STORAGE METHODS

	async listCloudVolumes(): Promise<CloudVolumeMetadata[]> {
		if (!this.isAuthenticated()) {
			throw new ProviderError('Not authenticated', 'google-drive', 'NOT_AUTHENTICATED', true);
		}

		try {
			console.log('Querying Google Drive for CBZ files...');

			// Query Drive API directly for all files owned by user
			const allItems = await driveApiClient.listFiles(
				`'me' in owners and trashed=false`,
				'files(id,name,mimeType,modifiedTime,size,parents,description)'
			);

			// Build folder map (folder ID -> folder name)
			const folderNames = new Map<string, string>();
			const cbzFiles: any[] = [];

			for (const item of allItems) {
				if (item.mimeType === GOOGLE_DRIVE_CONFIG.MIME_TYPES.FOLDER) {
					folderNames.set(item.id, item.name);
				} else if (item.name.endsWith('.cbz')) {
					cbzFiles.push(item);
				}
			}

			console.log(`Found ${cbzFiles.length} CBZ files and ${folderNames.size} folders`);

			// Transform CBZ files to CloudVolumeMetadata format with paths
			const cloudVolumes: CloudVolumeMetadata[] = [];

			for (const file of cbzFiles) {
				const parentId = file.parents?.[0];
				const parentName = parentId ? folderNames.get(parentId) : null;

				// Only include files that have a parent folder (series folder)
				if (parentName) {
					const path = `${parentName}/${file.name}`;
					cloudVolumes.push({
						fileId: file.id,
						path: path,
						modifiedTime: file.modifiedTime || new Date().toISOString(),
						size: file.size ? parseInt(file.size) : 0,
						description: file.description
					});
				}
			}

			console.log(`✅ Listed ${cloudVolumes.length} CBZ files from Google Drive`);
			return cloudVolumes;
		} catch (error) {
			throw new ProviderError(
				`Failed to list cloud volumes: ${error instanceof Error ? error.message : 'Unknown error'}`,
				'google-drive',
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
			throw new ProviderError('Not authenticated', 'google-drive', 'NOT_AUTHENTICATED', true);
		}

		try {
			// Parse path: "SeriesTitle/VolumeTitle.cbz"
			const pathParts = path.split('/');
			const fileName = pathParts.pop() || path;
			const seriesTitle = pathParts.join('/');

			// Ensure folder structure exists
			const rootFolderId = await getOrCreateFolder('mokuro-reader');
			let targetFolderId = rootFolderId;

			if (seriesTitle) {
				targetFolderId = await getOrCreateFolder(seriesTitle, rootFolderId);
			}

			// Upload the CBZ file
			const fileId = await uploadCbzToDrive(blob, fileName, targetFolderId);

			// Update file description if provided
			if (description) {
				await driveApiClient.updateFileDescription(fileId, description);
			}

			console.log(`✅ Uploaded ${fileName} to Google Drive (${fileId})`);
			return fileId;
		} catch (error) {
			throw new ProviderError(
				`Failed to upload volume CBZ: ${error instanceof Error ? error.message : 'Unknown error'}`,
				'google-drive',
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
			throw new ProviderError('Not authenticated', 'google-drive', 'NOT_AUTHENTICATED', true);
		}

		try {
			// Get current access token
			let token = '';
			tokenManager.token.subscribe(value => { token = value; })();

			if (!token) {
				throw new Error('No access token available');
			}

			// First get file size for progress tracking
			let totalSize = 0;
			if (onProgress) {
				const metadata = await driveApiClient.getFileMetadata(fileId, 'size');
				totalSize = parseInt(metadata.size || '0', 10);
			}

			// Download file with XMLHttpRequest for progress tracking
			return new Promise((resolve, reject) => {
				const xhr = new XMLHttpRequest();
				xhr.open('GET', `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
				xhr.setRequestHeader('Authorization', `Bearer ${token}`);
				xhr.responseType = 'blob';

				xhr.onprogress = (event) => {
					if (onProgress && event.lengthComputable) {
						onProgress(event.loaded, totalSize || event.total);
					}
				};

				xhr.onload = () => {
					if (xhr.status >= 200 && xhr.status < 300) {
						console.log(`✅ Downloaded CBZ from Google Drive (${fileId})`);
						resolve(xhr.response as Blob);
					} else {
						reject(new Error(`HTTP error ${xhr.status}: ${xhr.statusText}`));
					}
				};

				xhr.onerror = () => reject(new Error('Network error during download'));
				xhr.ontimeout = () => reject(new Error('Download timed out'));
				xhr.onabort = () => reject(new Error('Download aborted'));

				xhr.send();
			});
		} catch (error) {
			throw new ProviderError(
				`Failed to download volume CBZ: ${error instanceof Error ? error.message : 'Unknown error'}`,
				'google-drive',
				'DOWNLOAD_FAILED',
				false,
				true
			);
		}
	}

	async deleteVolumeCbz(fileId: string): Promise<void> {
		if (!this.isAuthenticated()) {
			throw new ProviderError('Not authenticated', 'google-drive', 'NOT_AUTHENTICATED', true);
		}

		try {
			// Delete from Drive
			await driveApiClient.deleteFile(fileId);

			console.log(`✅ Deleted file from Google Drive (${fileId})`);
		} catch (error) {
			throw new ProviderError(
				`Failed to delete volume CBZ: ${error instanceof Error ? error.message : 'Unknown error'}`,
				'google-drive',
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
		if (!this.isAuthenticated()) {
			throw new ProviderError('Not authenticated', 'google-drive', 'NOT_AUTHENTICATED', true);
		}

		try {
			// Ensure reader folder exists to get its ID
			const readerFolderId = await this.ensureReaderFolder();

			// Find the series folder using escapeNameForDriveQuery
			const { escapeNameForDriveQuery } = await import('$lib/util/google-drive/api-client');
			const escapedName = escapeNameForDriveQuery(seriesTitle);
			const query = `'${readerFolderId}' in parents and name='${escapedName}' and mimeType='${GOOGLE_DRIVE_CONFIG.MIME_TYPES.FOLDER}' and trashed=false`;

			const folders = await driveApiClient.listFiles(query, 'files(id)');

			if (folders.length === 0) {
				console.log(`Series folder '${seriesTitle}' not found in Google Drive`);
				return;
			}

			// Delete the folder
			const folderId = folders[0].id;
			await driveApiClient.deleteFile(folderId);

			console.log(`✅ Deleted series folder '${seriesTitle}' from Google Drive`);
		} catch (error) {
			throw new ProviderError(
				`Failed to delete series folder: ${error instanceof Error ? error.message : 'Unknown error'}`,
				'google-drive',
				'DELETE_FAILED',
				false,
				true
			);
		}
	}

	/**
	 * Ensure the mokuro-reader folder exists in Google Drive
	 */
	private async ensureReaderFolder(): Promise<string> {
		if (this.readerFolderId) {
			return this.readerFolderId;
		}

		const folders = await driveApiClient.listFiles(
			`mimeType='${GOOGLE_DRIVE_CONFIG.MIME_TYPES.FOLDER}' and name='${GOOGLE_DRIVE_CONFIG.FOLDER_NAMES.READER}'`,
			'files(id)'
		);

		if (folders.length === 0) {
			this.readerFolderId = await driveApiClient.createFolder(GOOGLE_DRIVE_CONFIG.FOLDER_NAMES.READER);
		} else {
			this.readerFolderId = folders[0].id;
		}

		return this.readerFolderId;
	}
}

export const googleDriveProvider = new GoogleDriveProvider();
