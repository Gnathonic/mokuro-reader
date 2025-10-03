import { db } from '$lib/catalog/db';
import type { VolumeData, VolumeMetadata } from '$lib/types';
import { showSnackbar } from '$lib/util/snackbar';
import { requestPersistentStorage } from '$lib/util/upload';
import { getMimeType, ZipReaderStream } from '@zip.js/zip.js';
import { generateThumbnail } from '$lib/catalog/thumbnails';
import { driveApiClient, driveFilesCache } from '$lib/util/google-drive';
import { progressTrackerStore } from '$lib/util/progress-tracker';

/**
 * Download and extract a volume from Google Drive
 *
 * Flow:
 * 1. Download .cbz file from Drive as blob
 * 2. Extract .mokuro JSON to get real metadata
 * 3. Extract all image files
 * 4. Write to IndexedDB (volumes + volumes_data)
 * 5. Remove from Drive cache (placeholder will disappear from catalog)
 */
export async function downloadVolumeFromDrive(
  placeholder: VolumeMetadata,
  onProgress?: (step: string, percent: number) => void
): Promise<void> {
  if (!placeholder.driveFileId) {
    throw new Error('No Drive file ID for placeholder');
  }

  const processId = `download-${placeholder.volume_uuid}`;

  try {
    await requestPersistentStorage();

    // Add progress tracker
    progressTrackerStore.addProcess({
      id: processId,
      description: `Downloading ${placeholder.volume_title}`,
      progress: 0,
      status: 'Starting download...'
    });

    // Step 1: Download file from Drive
    progressTrackerStore.updateProcess(processId, {
      progress: 10,
      status: 'Downloading from Drive...'
    });

    const response = await gapi.client.drive.files.get({
      fileId: placeholder.driveFileId,
      alt: 'media'
    });

    // Convert response to blob
    const blob = await fetch(`data:application/octet-stream;base64,${btoa(response.body)}`).then(
      (r) => r.blob()
    );

    // Create a File object from the blob
    const file = new File([blob], `${placeholder.volume_title}.cbz`, {
      type: 'application/x-cbz'
    });

    progressTrackerStore.updateProcess(processId, {
      progress: 30,
      status: 'Extracting archive...'
    });

    // Step 2: Extract ZIP contents
    const volumesByPath: Record<string, Partial<VolumeMetadata>> = {};
    const volumesDataByPath: Record<string, Partial<VolumeData>> = {};
    let mokuroData: any = null;
    const imageFiles: Record<string, File> = {};

    let entryCount = 0;
    let processedEntries = 0;

    // First pass: count entries
    for await (const entry of file.stream().pipeThrough(new ZipReaderStream())) {
      if (!entry.directory) entryCount++;
    }

    // Second pass: extract files
    for await (const entry of file.stream().pipeThrough(new ZipReaderStream())) {
      if (entry.directory) continue;

      if (entry.readable) {
        const blob = await new Response(entry.readable).blob();
        const fileBlob = new File([blob], entry.filename, {
          lastModified: entry.lastModified?.getTime() || Date.now()
        });

        // Check if it's a mokuro file
        if (entry.filename.endsWith('.mokuro')) {
          mokuroData = JSON.parse(await fileBlob.text());
        }
        // Check if it's an image
        else if (getMimeType(entry.filename).startsWith('image/')) {
          imageFiles[entry.filename] = fileBlob;
        }

        processedEntries++;
        const extractProgress = 30 + Math.round((processedEntries / entryCount) * 40);
        progressTrackerStore.updateProcess(processId, {
          progress: extractProgress,
          status: `Extracting: ${processedEntries}/${entryCount} files`
        });
      }
    }

    if (!mokuroData) {
      throw new Error('No .mokuro file found in archive');
    }

    progressTrackerStore.updateProcess(processId, {
      progress: 80,
      status: 'Processing metadata...'
    });

    // Step 3: Create VolumeMetadata and VolumeData
    const metadata: VolumeMetadata = {
      mokuro_version: mokuroData.version,
      series_title: mokuroData.title,
      series_uuid: mokuroData.title_uuid,
      page_count: mokuroData.pages.length,
      character_count: mokuroData.chars,
      volume_title: mokuroData.volume,
      volume_uuid: mokuroData.volume_uuid
    };

    // Sort image files by name
    const sortedImageFiles = Object.fromEntries(
      Object.entries(imageFiles).sort(([aKey], [bKey]) =>
        aKey.localeCompare(bKey, undefined, {
          numeric: true,
          sensitivity: 'base'
        })
      )
    );

    const volumeData: VolumeData = {
      volume_uuid: mokuroData.volume_uuid,
      pages: mokuroData.pages,
      files: sortedImageFiles
    };

    progressTrackerStore.updateProcess(processId, {
      progress: 90,
      status: 'Generating thumbnail...'
    });

    // Step 4: Generate thumbnail
    const firstImageFile = Object.values(sortedImageFiles)[0];
    if (firstImageFile) {
      metadata.thumbnail = await generateThumbnail(firstImageFile);
    }

    // Step 5: Write to database
    progressTrackerStore.updateProcess(processId, {
      progress: 95,
      status: 'Saving to database...'
    });

    // Check if already exists (shouldn't, but be safe)
    const existingVolume = await db.volumes
      .where('volume_uuid')
      .equals(metadata.volume_uuid)
      .first();

    if (!existingVolume) {
      await db.transaction('rw', db.volumes, async () => {
        await db.volumes.add(metadata, metadata.volume_uuid);
      });
      await db.transaction('rw', db.volumes_data, async () => {
        await db.volumes_data.add(volumeData, metadata.volume_uuid);
      });

      // Step 6: Remove from Drive cache (placeholder will disappear)
      driveFilesCache.removeDriveFile(placeholder.series_title, placeholder.volume_title);

      progressTrackerStore.updateProcess(processId, {
        progress: 100,
        status: 'Complete'
      });

      showSnackbar(`Downloaded ${metadata.volume_title}`, 'success');
    } else {
      throw new Error('Volume already exists in database');
    }
  } catch (error) {
    console.error('Download failed:', error);
    showSnackbar(
      `Download failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'error'
    );
    throw error;
  } finally {
    // Remove progress tracker after a short delay
    setTimeout(() => {
      progressTrackerStore.removeProcess(processId);
    }, 2000);
  }
}
