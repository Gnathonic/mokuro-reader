import { db } from '$lib/catalog/db';
import type { Volume } from '$lib/types';
import { showSnackbar } from '$lib/util/snackbar';
import { requestPersistentStorage } from '$lib/util/upload';
import { ZipReader, BlobWriter, getMimeType, Uint8ArrayReader } from '@zip.js/zip.js';
import { resetProgress, updateProgress, updateVolumeProgress } from '$lib/stores/uploadProgress';

export * from './web-import'

const zipTypes = ['zip', 'cbz', 'ZIP', 'CBZ'];
const imageTypes = ['image/jpeg', 'image/png', 'image/webp'];

export async function unzipManga(file: File) {
  const zipFileReader = new Uint8ArrayReader(new Uint8Array(await file.arrayBuffer()));
  const zipReader = new ZipReader(zipFileReader);

  const entries = await zipReader.getEntries();
  const unzippedFiles: Record<string, File> = {};

  // Sort entries and group by volume
  const sortedEntries = entries.sort((a, b) => {
    return a.filename.localeCompare(b.filename, undefined, {
      numeric: true,
      sensitivity: 'base'
    });
  });

  // Group entries by volume directory
  const volumeGroups = new Map<string, ZipEntry[]>();
  sortedEntries.forEach(entry => {
    const volumePath = entry.filename.split('/')[0];
    if (!volumeGroups.has(volumePath)) {
      volumeGroups.set(volumePath, []);
    }
    volumeGroups.get(volumePath)?.push(entry);
  });

  // Get number of available CPU threads, fallback to 4 if not available
  const maxThreads = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;

  // Process volumes in parallel batches based on available threads
  const volumes = Array.from(volumeGroups.entries());
  for (let i = 0; i < volumes.length; i += maxThreads) {
    const batch = volumes.slice(i, i + maxThreads);
    await Promise.all(batch.map(async ([volumePath, entries]) => {
      // Process volume entries sequentially to maintain order
      for (const entry of entries) {
        const mime = getMimeType(entry.filename);
        const isMokuroFile = entry.filename.split('.').pop() === 'mokuro';
        if (imageTypes.includes(mime) || isMokuroFile) {
          const writerType = isMokuroFile ? 'application/json' : mime;
          const blob = await entry.getData?.(new BlobWriter(writerType));
          if (blob) {
            const fileName = entry.filename.split('/').pop() || entry.filename;
            const file = new File([blob], fileName, { type: writerType });
            Object.defineProperty(file, 'webkitRelativePath', { value: entry.filename });
            unzippedFiles[entry.filename] = file;
          }
        }
      }
    }));
  }

  return unzippedFiles;
}

function getDetails(file: File) {
  const { webkitRelativePath, name } = file
  const split = name.split('.');
  const ext = split.pop();
  const filename = split.join('.');
  let path = filename

  if (webkitRelativePath) {
    path = webkitRelativePath.split('.')[0]
  }

  return {
    filename,
    ext,
    path
  };
}

async function getFile(fileEntry: FileSystemFileEntry) {
  try {
    return new Promise<File>((resolve, reject) => fileEntry.file((file) => {
      if (!file.webkitRelativePath) {
        Object.defineProperty(file, 'webkitRelativePath', {
          value: fileEntry.fullPath.substring(1)
        })
      }
      resolve(file)
    }, reject));
  } catch (err) {
    console.log(err);
  }
}

export async function scanFiles(item: FileSystemEntry, files: Promise<File | undefined>[]) {
  if (item.isDirectory) {
    const directoryReader = (item as FileSystemDirectoryEntry).createReader();
    await new Promise<void>((resolve) => {
      function readEntries() {
        directoryReader.readEntries(async (entries) => {
          if (entries.length > 0) {
            for (const entry of entries) {
              if (entry.isFile) {
                files.push(getFile(entry as FileSystemFileEntry));
              } else {
                await scanFiles(entry, files);
              }
            }
            readEntries()
          } else {
            resolve();
          }
        });
      }

      readEntries()
    });
  }
}

// Create a Map for faster volume lookups
const volumePathMap = new Map<string, string>();

// Process a single file and return volume data
async function processFile(file: File): Promise<{ path: string; volumeData: Partial<Volume> } | null> {
  const { ext, filename, path } = getDetails(file);
  const { type, webkitRelativePath } = file;

  updateProgress(state => ({ processedFiles: state.processedFiles + 1 }));

  // Process mokuro files
  if (ext === 'mokuro') {
    updateVolumeProgress(path, { status: 'processing', name: filename, progress: 0, message: 'Processing mokuro file' });
    const mokuroData: Volume['mokuroData'] = JSON.parse(await file.text());
    volumePathMap.set(path, path); // Add to lookup map
    updateVolumeProgress(path, { progress: 50, message: 'Mokuro file processed' });
    return {
      path,
      volumeData: {
        mokuroData,
        volumeName: filename
      }
    };
  }

  // Process images
  const mimeType = type || getMimeType(file.name);
  if (imageTypes.includes(mimeType) && webkitRelativePath) {
    const imageName = webkitRelativePath.split('/').at(-1);
    // Use prefix matching for faster lookup
    const vol = Array.from(volumePathMap.keys()).find(key => webkitRelativePath.startsWith(key));
    
    if (vol && imageName) {
      updateVolumeProgress(vol, { status: 'processing', progress: 75, message: 'Processing images' });
      return {
        path: vol,
        volumeData: {
          files: {
            [imageName]: file
          }
        }
      };
    }
  }

  // Process zip files
  if (ext && zipTypes.includes(ext)) {
    updateVolumeProgress(path, { status: 'processing', name: filename, progress: 0, message: 'Extracting zip file' });
    const unzippedFiles = await unzipManga(file);
    if (unzippedFiles) {
      updateVolumeProgress(path, { progress: 50, message: 'Zip file extracted' });
      return {
        path,
        volumeData: {
          files: unzippedFiles
        }
      };
    }
  }

  return null;
}

interface VolumeFiles {
  mokuroFile?: File;
  imageFiles: File[];
  zipFile?: File;
}

function groupFilesByVolume(files: File[]): Record<string, VolumeFiles> {
  const volumeGroups: Record<string, VolumeFiles> = {};

  for (const file of files) {
    const { ext, path } = getDetails(file);
    const isMokuro = ext === 'mokuro';
    const isZip = zipTypes.includes(ext || '');

    if (!volumeGroups[path]) {
      volumeGroups[path] = { imageFiles: [] };
    }

    if (isMokuro) {
      volumeGroups[path].mokuroFile = file;
    } else if (isZip) {
      volumeGroups[path].zipFile = file;
    } else {
      volumeGroups[path].imageFiles.push(file);
    }
  }

  return volumeGroups;
}

async function processVolume(
  path: string,
  files: VolumeFiles,
  existingVolumes: Record<string, Volume> = {}
): Promise<{ volume: Volume; mangaId: string } | null> {
  updateVolumeProgress(path, { status: 'processing', name: path, progress: 0, message: 'Starting volume processing' });

  // Process mokuro file first
  if (!files.mokuroFile) {
    updateVolumeProgress(path, { status: 'error', progress: 0, message: 'Missing mokuro file' });
    return null;
  }

  try {
    // Step 1: Process mokuro file
    updateVolumeProgress(path, { progress: 10, message: 'Reading mokuro file' });
    const mokuroData: Volume['mokuroData'] = JSON.parse(await files.mokuroFile.text());
    const volumeName = getDetails(files.mokuroFile).filename;

    // Step 2: Process zip file if present
    let processedFiles: Record<string, File> = {};
    if (files.zipFile) {
      updateVolumeProgress(path, { progress: 20, message: 'Extracting zip file' });
      processedFiles = await unzipManga(files.zipFile);
      updateVolumeProgress(path, { progress: 50, message: 'Zip file extracted' });
    } else {
      // Process individual image files
      updateVolumeProgress(path, { progress: 20, message: 'Processing image files' });
      for (const file of files.imageFiles) {
        const imageName = file.webkitRelativePath.split('/').at(-1) || file.name;
        processedFiles[imageName] = file;
      }
      updateVolumeProgress(path, { progress: 50, message: 'Image files processed' });
    }

    // Step 3: Validate files
    if (Object.keys(processedFiles).length === 0) {
      updateVolumeProgress(path, { status: 'error', progress: 50, message: 'No image files found' });
      return null;
    }

    // Step 4: Save to database
    updateVolumeProgress(path, { progress: 75, message: 'Saving to database' });
    await requestPersistentStorage();

    const volume: Volume = {
      mokuroData,
      volumeName,
      files: processedFiles
    };

    const existingCatalog = await db.catalog.get(mokuroData.title_uuid);
    
    // Check if volume already exists
    if (existingCatalog?.manga.some(manga => 
      manga.mokuroData.volume_uuid === volume.mokuroData.volume_uuid
    )) {
      updateVolumeProgress(path, { status: 'error', progress: 75, message: 'Volume already exists' });
      return null;
    }

    // Update database
    await db.transaction('rw', db.catalog, async () => {
      if (existingCatalog) {
        await db.catalog.update(mokuroData.title_uuid, {
          manga: [...existingCatalog.manga, volume]
        });
      } else {
        await db.catalog.add({
          id: mokuroData.title_uuid,
          manga: [volume]
        });
      }
    });

    updateVolumeProgress(path, { status: 'complete', progress: 100, message: 'Volume processed successfully' });
    return { volume, mangaId: mokuroData.title_uuid };

  } catch (error) {
    console.error('Error processing volume:', error);
    updateVolumeProgress(path, { 
      status: 'error', 
      progress: 0, 
      message: error instanceof Error ? error.message : 'Unknown error occurred' 
    });
    return null;
  }
}

// Get number of available CPU threads, fallback to 4 if not available
const maxThreads = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;

async function processBatch(
  volumeBatch: [string, VolumeFiles][],
  volumes: Record<string, Volume>,
  processedCount: { value: number },
  totalVolumes: number
): Promise<void> {
  await Promise.all(
    volumeBatch.map(async ([path, volumeFiles]) => {
      const result = await processVolume(path, volumeFiles, volumes);
      if (result) {
        const { volume } = result;
        volumes[path] = volume;
      }
      processedCount.value++;
      updateProgress({ 
        processedFiles: processedCount.value,
        totalFiles: totalVolumes 
      });
    })
  );
}

export async function processFiles(_files: File[]) {
  resetProgress();
  
  // Sort files for consistent ordering
  const files = _files.sort((a, b) => {
    return decodeURI(a.name).localeCompare(decodeURI(b.name), undefined, {
      numeric: true,
      sensitivity: 'base'
    });
  });

  // Handle single zip file case
  if (files.length === 1 && zipTypes.includes(files[0].name.split('.').pop() || '')) {
    const unzippedFiles = await unzipManga(files[0]);
    return processFiles(Object.values(unzippedFiles));
  }

  // Group files by volume
  const volumeGroups = groupFilesByVolume(files);
  const volumeEntries = Object.entries(volumeGroups);
  const totalVolumes = volumeEntries.length;
  
  updateProgress({ 
    totalFiles: totalVolumes, 
    processedFiles: 0,
    currentPhase: 'processing' 
  });

  // Process volumes in parallel batches
  const volumes: Record<string, Volume> = {};
  const batchSize = maxThreads;
  const processedCount = { value: 0 };

  // Process volumes in batches
  for (let i = 0; i < volumeEntries.length; i += batchSize) {
    const batch = volumeEntries.slice(i, i + batchSize);
    await processBatch(batch, volumes, processedCount, totalVolumes);
  }

  // Final status update
  if (Object.keys(volumes).length > 0) {
    updateProgress({ currentPhase: 'complete' });
    showSnackbar('Catalog updated successfully');
  } else {
    updateProgress({ currentPhase: 'error' });
    showSnackbar('No volumes were processed successfully');
  }
}
