import { writable } from 'svelte/store';
import { progressTrackerStore } from '../progress-tracker';
import { volumes } from '$lib/settings';
import { showSnackbar } from '../snackbar';
import { syncOrchestrator } from '../sync-orchestrator';
import { driveApiClient, DriveApiError, escapeNameForDriveQuery } from './api-client';
import { tokenManager } from './token-manager';
import { GOOGLE_DRIVE_CONFIG, type SyncProgress } from './constants';

class SyncService {
  private folderIds = writable({
    reader: '',
    volumeData: '',
    profiles: ''
  });

  get readerFolderId() {
    return this.folderIds;
  }

  getCurrentReaderFolderId(): string {
    let id = '';
    this.folderIds.subscribe(ids => { id = ids.reader; })();
    return id;
  }

  async ensureReaderFolderExists(): Promise<string> {
    const folders = await driveApiClient.listFiles(
      `mimeType='${GOOGLE_DRIVE_CONFIG.MIME_TYPES.FOLDER}' and name='${GOOGLE_DRIVE_CONFIG.FOLDER_NAMES.READER}'`,
      'files(id)'
    );

    let folderId: string;

    if (folders.length === 0) {
      folderId = await driveApiClient.createFolder(GOOGLE_DRIVE_CONFIG.FOLDER_NAMES.READER);
    } else {
      folderId = folders[0].id;
    }

    this.folderIds.update(ids => ({ ...ids, reader: folderId }));
    return folderId;
  }

  async findFileInFolder(fileName: string, folderId: string): Promise<string> {
    const escapedFileName = escapeNameForDriveQuery(fileName);

    const files = await driveApiClient.listFiles(
      `'${folderId}' in parents and name='${escapedFileName}'`,
      'files(id)'
    );

    return files.length > 0 ? files[0].id : '';
  }

  // Layer 1: Ensure token is valid and won't expire during sync
  private async ensureTokenValid(): Promise<boolean> {
    if (!tokenManager.isAuthenticated()) {
      return false;
    }

    const timeLeft = tokenManager.getTimeUntilExpiry();

    // If token expires in less than 2 minutes, try to refresh it silently
    if (timeLeft !== null && timeLeft < 2 * 60 * 1000) {
      console.log('⚡ Token expiring soon, pre-validating before sync...');

      try {
        // Attempt silent refresh (will use existing SSO session)
        tokenManager.reAuthenticate();

        // Give it a moment to complete
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Check if still authenticated after refresh attempt
        return tokenManager.isAuthenticated();
      } catch (error) {
        console.error('Failed to pre-validate token:', error);
        return false;
      }
    }

    return true;
  }

  async syncReadProgress(): Promise<void> {
    if (!tokenManager.isAuthenticated()) {
      localStorage.setItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.SYNC_AFTER_LOGIN, 'true');
      // Re-authentication: use minimal prompt to reuse existing permissions
      tokenManager.requestNewToken(false, false);
      return;
    }

    // Layer 1: Pre-validate token before sync
    const tokenValid = await this.ensureTokenValid();
    if (!tokenValid) {
      showSnackbar('Session expired. Please sign in again to sync.');
      localStorage.setItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.SYNC_AFTER_LOGIN, 'true');
      tokenManager.requestNewToken(false, false);
      return;
    }

    const processId = 'sync-read-progress';

    try {
      progressTrackerStore.addProcess({
        id: processId,
        description: 'Syncing read progress',
        progress: 0,
        status: 'Initializing...'
      });

      // Step 1: Ensure folder exists and get volume-data.json files from cache
      progressTrackerStore.updateProcess(processId, {
        progress: 10,
        status: 'Checking for existing data...'
      });

      const readerFolderId = await this.ensureReaderFolderExists();

      // Query Drive API directly for volume-data.json files
      const volumeDataQuery = `'${readerFolderId}' in parents and name='${GOOGLE_DRIVE_CONFIG.FILE_NAMES.VOLUME_DATA}' and trashed=false`;
      const volumeDataFilesRaw = await driveApiClient.listFiles(volumeDataQuery, 'files(id,name)');
      const volumeDataFiles = volumeDataFilesRaw.map(file => ({ fileId: file.id, name: file.name }));

      console.log('Volume data files from Drive API:', volumeDataFiles);

      // Step 2: Download cloud data from all volume-data.json files
      const cloudJsonStrings: string[] = [];
      if (volumeDataFiles.length > 0) {
        progressTrackerStore.updateProcess(processId, {
          progress: 30,
          status: `Downloading cloud data (${volumeDataFiles.length} file${volumeDataFiles.length > 1 ? 's' : ''})...`
        });

        for (const file of volumeDataFiles) {
          try {
            const jsonString = await driveApiClient.getFileContent(file.fileId);
            cloudJsonStrings.push(jsonString);
          } catch (error) {
            console.warn(`Failed to download cloud data from file ${file.fileId}:`, error);
          }
        }
      }

      // Step 3: Orchestrate sync (parse, merge, enrich)
      progressTrackerStore.updateProcess(processId, {
        progress: 60,
        status: 'Merging local and cloud data...'
      });

      const enrichedVolumes = await syncOrchestrator.syncVolumeData(cloudJsonStrings);

      // Step 4: Upload merged data (only if changed) and clean up duplicates
      const enrichedJson = JSON.stringify(enrichedVolumes);
      const cloudJson = cloudJsonStrings.length > 0 ? cloudJsonStrings[0] : '{}';

      if (enrichedJson !== cloudJson || volumeDataFiles.length > 1) {
        progressTrackerStore.updateProcess(processId, {
          progress: 90,
          status: volumeDataFiles.length > 1
            ? 'Uploading merged data and cleaning duplicates...'
            : 'Uploading merged data...'
        });

        // Upload to first file (or create new if none exist)
        const primaryFileId = volumeDataFiles.length > 0 ? volumeDataFiles[0].fileId : null;
        console.log('Uploading with primaryFileId:', primaryFileId);
        const uploadResult = await this.uploadVolumeData(enrichedVolumes, primaryFileId, readerFolderId);

        // Delete duplicate files (if any)
        if (volumeDataFiles.length > 1) {
          for (let i = 1; i < volumeDataFiles.length; i++) {
            try {
              await driveApiClient.deleteFile(volumeDataFiles[i].fileId);
              console.log(`Deleted duplicate volume-data.json file: ${volumeDataFiles[i].fileId}`);
            } catch (error) {
              console.warn(`Failed to delete duplicate file ${volumeDataFiles[i].fileId}:`, error);
            }
          }
        }
      } else {
        progressTrackerStore.updateProcess(processId, {
          progress: 90,
          status: 'No changes to upload'
        });
      }

      progressTrackerStore.updateProcess(processId, {
        progress: 100,
        status: 'Sync complete'
      });

      showSnackbar('Read progress synced successfully');

    } catch (error) {
      this.handleSyncError(error, processId);
    } finally {
      setTimeout(() => progressTrackerStore.removeProcess(processId), 3000);
    }
  }

  private async uploadVolumeData(
    volumeData: any,
    existingFileId: string | null,
    parentFolderId: string
  ): Promise<void> {
    const content = JSON.stringify(volumeData);
    const metadata = {
      name: GOOGLE_DRIVE_CONFIG.FILE_NAMES.VOLUME_DATA,
      mimeType: GOOGLE_DRIVE_CONFIG.MIME_TYPES.JSON,
      ...(existingFileId ? {} : { parents: [parentFolderId] })
    };

    await driveApiClient.uploadFile(content, metadata, existingFileId || undefined);
  }

  private handleSyncError(error: any, processId: string): void {
    let errorMessage = 'Sync failed';
    let shouldPromptReauth = false;

    if (error instanceof DriveApiError) {
      if (error.isNetworkError) {
        errorMessage = 'Network error - please check your connection';
      } else if (error.status === 401 || error.status === 403) {
        errorMessage = 'Session expired - please sign in again';
        shouldPromptReauth = true;
      } else {
        errorMessage = `Sync failed: ${error.message}`;
      }
    }

    progressTrackerStore.updateProcess(processId, {
      progress: 0,
      status: errorMessage
    });

    showSnackbar(errorMessage);
    console.error('Sync error:', error);

    // If auth error, set flag to prompt re-auth after next login
    if (shouldPromptReauth) {
      localStorage.setItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.SYNC_AFTER_LOGIN, 'true');
    }
  }
}

export const syncService = new SyncService();
