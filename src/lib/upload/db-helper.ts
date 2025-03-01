// Helper functions for database operations
import { db } from '$lib/catalog/db';
import type { VolumeData, VolumeMetadata } from '$lib/types';
import { showSnackbar } from '$lib/util/snackbar';
import { requestPersistentStorage } from '$lib/util/upload';
import { generateThumbnail } from '$lib/catalog/thumbnails';

// Save processed data to the database
export async function saveToDatabase(
  volumesByPath: Record<string, Partial<VolumeMetadata>>,
  volumesDataByPath: Record<string, Partial<VolumeData>>
) {
  // Request persistent storage
  await requestPersistentStorage();
  
  // Process each volume
  for (const path in volumesDataByPath) {
    const uploadData = volumesDataByPath[path];
    const uploadMetadata = volumesByPath[path];
    
    if (
      uploadData &&
      uploadMetadata &&
      uploadMetadata.series_uuid &&
      uploadMetadata.mokuro_version &&
      uploadMetadata.volume_uuid &&
      uploadMetadata.series_title &&
      uploadMetadata.volume_title &&
      uploadMetadata.page_count
    ) {
      const existingVolume = await db.volumes
        .where('volume_uuid')
        .equals(uploadMetadata.volume_uuid)
        .first();

      if (!existingVolume) {
        showSnackbar('adding ' + uploadMetadata.volume_title + ' to your catalog');
        
        // Sort files by name case-insensitively
        if (uploadData.files) {
          uploadData.files = Object.fromEntries(
            Object.entries(uploadData.files).sort(([aKey, aFile], [bKey, bFile]) =>
              aKey.localeCompare(bKey, undefined, {
                numeric: true,
                sensitivity: 'base'
              })
            )
          );
        }

        // Generate thumbnail
        uploadMetadata.thumbnail = await generateThumbnail(
          uploadData.files?.[Object.keys(uploadData.files || {})[0]]
        );
        
        // Save to database
        await db.transaction('rw', db.volumes, async () => {
          await db.volumes.add(uploadMetadata as VolumeMetadata, uploadMetadata.volume_uuid);
        });
        
        await db.transaction('rw', db.volumes_data, async () => {
          await db.volumes_data.add(uploadData as VolumeData, uploadMetadata.volume_uuid);
        });
      }
    }
  }
  
  // Process thumbnails
  db.processThumbnails(5);
  
  // Show success message
  showSnackbar('Files uploaded successfully');
}