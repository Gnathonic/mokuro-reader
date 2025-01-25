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

export async function processFiles(_files: File[]) {
  resetProgress();
  const volumes: Record<string, Volume> = {};
  const mangas = new Set<string>(); // Use Set for faster lookups

  const files = _files.sort((a, b) => {
    return decodeURI(a.name).localeCompare(decodeURI(b.name), undefined, {
      numeric: true,
      sensitivity: 'base'
    });
  });
  
  updateProgress({ totalFiles: files.length, currentPhase: 'processing' });

  // Process all files in parallel, but handle zip files separately
  const zipFiles = files.filter(f => zipTypes.includes(f.name.split('.').pop() || ''));
  const regularFiles = files.filter(f => !zipFiles.includes(f));

  // Handle single zip file case
  if (files.length === 1 && zipFiles.length === 1) {
    const unzippedFiles = await unzipManga(zipFiles[0]);
    return processFiles(Object.values(unzippedFiles));
  }

  // Process regular files in parallel
  const results = await Promise.all(regularFiles.map(processFile));
  
  // Process zip files sequentially to avoid memory issues
  for (const zipFile of zipFiles) {
    const result = await processFile(zipFile);
    if (result) results.push(result);
  }

  // Merge results into volumes
  for (const result of results.filter(Boolean)) {
    if (!result) continue;
    const { path, volumeData } = result;
    volumes[path] = {
      ...volumes[path],
      ...volumeData,
      files: {
        ...volumes[path]?.files,
        ...volumeData.files
      }
    };

    // Track manga IDs
    if (volumeData.mokuroData) {
      mangas.add(volumeData.mokuroData.title_uuid);
    }
  }

  const vols = Object.values(volumes);

  if (vols.length > 0) {
    updateProgress({ currentPhase: 'saving' });
    // Validate volumes
    const valid = vols.every((vol) => {
      const { files, mokuroData, volumeName } = vol;
      if (!mokuroData || !volumeName) {
        showSnackbar('Missing .mokuro file');
        updateProgress({ currentPhase: 'error' });
        return false;
      }
      if (!files) {
        showSnackbar('Missing image files');
        updateProgress({ currentPhase: 'error' });
        return false;
      }
      return true;
    });

    if (valid) {
      await requestPersistentStorage();

      // Batch database operations
      const transaction = db.transaction('rw', db.catalog, async () => {
        const updates = Array.from(mangas).map(async (key) => {
          const existingCatalog = await db.catalog.get(key);
          const filtered = vols.filter((vol) => (
            !existingCatalog?.manga.some((manga) => 
              manga.mokuroData.volume_uuid === vol.mokuroData.volume_uuid
            ) && key === vol.mokuroData.title_uuid
          ));

          if (existingCatalog) {
            return db.catalog.update(key, { manga: [...existingCatalog.manga, ...filtered] });
          } else {
            return db.catalog.add({ id: key, manga: filtered });
          }
        });

        await Promise.all(updates);
      });

      await transaction;
      
      // Mark all volumes as complete
      Object.keys(volumes).forEach(path => {
        updateVolumeProgress(path, { status: 'complete', progress: 100, message: 'Volume processed successfully' });
      });
      
      updateProgress({ currentPhase: 'complete' });
      showSnackbar('Catalog updated successfully');
    }
  } else {
    updateProgress({ currentPhase: 'error' });
    showSnackbar('Missing .mokuro file');
  }
}
