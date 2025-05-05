import { db } from '$lib/catalog/db';
import type { VolumeData, VolumeMetadata } from '$lib/types';
import { showSnackbar } from '$lib/util/snackbar';
import { requestPersistentStorage } from '$lib/util/upload';
import { getMimeType, ZipReaderStream } from '@zip.js/zip.js';
import { generateThumbnail } from '$lib/catalog/thumbnails';

export * from './web-import';

const zipTypes = ['zip', 'cbz'];
const imageTypes = ['image/jpeg', 'image/png', 'image/webp'];

function getDetails(file: File) {
  const { webkitRelativePath, name } = file;
  const split = name.split('.');
  const ext = split.length > 1 ? split.pop() : '';
  const filename = split.join('.');
  let path = filename;

  if (webkitRelativePath) {
    path =
      ext && ext.length > 0
        ? webkitRelativePath.split('.').slice(0, -1).join('.')
        : webkitRelativePath;
  }

  return {
    filename,
    ext,
    path
  };
}

async function getFile(fileEntry: FileSystemFileEntry) {
  try {
    return new Promise<File>((resolve, reject) =>
      fileEntry.file((file) => {
        if (!file.webkitRelativePath) {
          Object.defineProperty(file, 'webkitRelativePath', {
            value: fileEntry.fullPath.substring(1)
          });
        }
        resolve(file);
      }, reject)
    );
  } catch (err) {
    console.log(err);
  }
}

function getExtension(fileName: string) {
  return fileName.split('.')?.pop()?.toLowerCase() ?? '';
}

function removeExtension(fileName: string) {
  const lastDotIndex = fileName.lastIndexOf('.');
  if (lastDotIndex > -1 && lastDotIndex > fileName.lastIndexOf('/')) {
    return fileName.slice(0, lastDotIndex);
  }
  return fileName; // Return the original file path if no extension exists
}

function isMokuro(fileName: string) {
  return getExtension(fileName) === 'mokuro';
}

function isImage(fileName: string) {
  return getMimeType(fileName).startsWith('image/') || imageTypes.includes(getExtension(fileName));
}

function isZip(fileName: string) {
  return zipTypes.includes(getExtension(fileName));
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
            readEntries();
          } else {
            resolve();
          }
        });
      }

      readEntries();
    });
  }
}

async function uploadVolumeData(
  volumesByPath: Record<string, Partial<VolumeMetadata>>,
  path: string,
  uploadData: undefined | Partial<VolumeData>
) {
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
    await requestPersistentStorage();
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

      uploadMetadata.thumbnail = await generateThumbnail(
        uploadData.files?.[Object.keys(uploadData.files)[0]]
      );
      await db.transaction('rw', db.volumes, async () => {
        await db.volumes.add(uploadMetadata as VolumeMetadata, uploadMetadata.volume_uuid);
      });
      await db.transaction('rw', db.volumes_data, async () => {
        await db.volumes_data.add(uploadData as VolumeData, uploadMetadata.volume_uuid);
      });
    }
  }
}

interface MokuroData {
  version: string;
  title: string;
  title_uuid: string;
  pages: any[];
  chars: number;
  volume: string;
  volume_uuid: string;
}

async function processMokuroFile(file: File): Promise<{
  metadata: Partial<VolumeMetadata>;
  data: Partial<VolumeData>;
  titleUuid: string;
}> {
  const mokuroData: MokuroData = JSON.parse(await file.text());
  return {
    metadata: {
      mokuro_version: mokuroData.version,
      series_title: mokuroData.title,
      series_uuid: mokuroData.title_uuid,
      page_count: mokuroData.pages.length,
      character_count: mokuroData.chars,
      volume_title: mokuroData.volume,
      volume_uuid: mokuroData.volume_uuid
    },
    data: {
      volume_uuid: mokuroData.volume_uuid,
      pages: mokuroData.pages
    },
    titleUuid: mokuroData.title_uuid
  };
}

// List of problematic directory patterns to exclude
const excludedDirPatterns = [
  // macOS system directories
  '__MACOSX',
  '.DS_Store',
  '.Trashes',
  '.Spotlight-V100',
  '.fseventsd',
  '.TemporaryItems',
  '.Trash',
  
  // Windows system directories
  'System Volume Information',
  '$RECYCLE.BIN',
  'Thumbs.db',
  'desktop.ini',
  'Desktop.ini',
  'RECYCLER',
  'RECYCLED',
  
  // Linux/Unix system directories
  '.Trash-1000',
  '.thumbnails',
  '.directory',
  
  // Cloud storage special folders
  '.dropbox',
  '.dropbox.cache',
  
  // Version control
  '.git',
  '.svn',
  
  // General backup/temp files
  '~$',
  '.bak',
  '.tmp',
  '.temp'
];

// Function to check if a path contains any problematic directory patterns
function isProblematicPath(path: string): boolean {
  if (!path) return false;
  
  // Check for macOS hidden files that start with "._"
  const pathParts = path.split('/');
  const fileName = pathParts[pathParts.length - 1];
  if (fileName.startsWith('._')) {
    return true;
  }
  
  return excludedDirPatterns.some(pattern => 
    path.includes('/' + pattern + '/') || 
    path.endsWith('/' + pattern) || 
    path === pattern
  );
}

async function processFile(
  file: { path: any; file: File },
  volumesByPath: Record<string, Partial<VolumeMetadata>>,
  volumesDataByPath: Record<string, Partial<VolumeData>>,
  pendingImagesByPath: Record<string, Record<string, File>>
) {
  // Skip processing if the file path contains any problematic directory patterns
  if (isProblematicPath(file.path) || isProblematicPath(file.file.webkitRelativePath)) {
    console.log(`Skipping file in problematic directory: ${file.path || file.file.webkitRelativePath}`);
    return;
  }
  
  if (isMokuro(file.file.name)) {
    await processMokuroWithPendingImages(
      file,
      volumesByPath,
      volumesDataByPath,
      pendingImagesByPath
    );
    showSnackbar('processed mokuro ' + file.file.name);
  } else if (isZip(file.file.name)) {
    showSnackbar('opening ' + file.file.name, 5000);
    await processZipFile(file, volumesDataByPath, volumesByPath, pendingImagesByPath);
  } else if (isImage(file.file.name)) {
    await processStandaloneImage(file, volumesDataByPath, volumesByPath, pendingImagesByPath);
    showSnackbar('processed image ' + file.file.name);
  }
}

async function processZipFile(
  zipFile: { path: string; file: File },
  volumesDataByPath: Record<string, Partial<VolumeData>>,
  volumesByPath: Record<string, Partial<VolumeMetadata>>,
  pendingImagesByPath: Record<string, Record<string, File>>
): Promise<void> {
  for await (const entry of zipFile.file.stream().pipeThrough(new ZipReaderStream())) {
    // Skip directories as we're only creating File objects
    if (entry.directory) continue;

    // Process file entries
    if (entry.readable) {
      // Convert readable stream to blob
      const blob = await new Response(entry.readable).blob();

      // Create a File object
      const fileBlob = new File([blob], entry.filename, {
        lastModified: entry.lastModified?.getTime() || Date.now()
      });
      const path = zipFile.path === '' ? entry.filename : `${zipFile.path}/${entry.filename}`;
      const file = { path: path, file: fileBlob };

      await processFile(file, volumesByPath, volumesDataByPath, pendingImagesByPath);
    }
  }
}

async function processStandaloneImage(
  file: { path: string; file: File },
  volumesDataByPath: Record<string, Partial<VolumeData>>,
  volumesByPath: Record<string, Partial<VolumeMetadata>>,
  pendingImagesByPath: Record<string, Record<string, File>>
): Promise<void> {
  const path = file.path;

  if (!path) return;

  const relativePath = file.file.name;
  const vol = Object.keys(volumesDataByPath).find((key) => path.startsWith(key));

  if (!vol) {
    // Store images for potential mokuro files
    const dirPath = path.split('/').slice(0, -1).join('/');

    // Add this image to the pendingImagesByPath record for this dirPath
    if (!pendingImagesByPath[dirPath]) {
      pendingImagesByPath[dirPath] = {};
    }
    pendingImagesByPath[dirPath][relativePath] = file.file;
    return;
  }

  if (!vol || !relativePath) return;

  // Add image to volume data
  if (!volumesDataByPath[vol].files) {
    volumesDataByPath[vol].files = {};
  }
  volumesDataByPath[vol].files![relativePath] = file.file;

  // Check if volume is complete
  if (volumesDataByPath[vol].pages?.length === Object.keys(volumesDataByPath[vol].files!).length) {
    const uploadData = volumesDataByPath[vol];
    delete volumesDataByPath[vol];
    await uploadVolumeData(volumesByPath, vol, uploadData);
  }
}

async function processMokuroWithPendingImages(
  file: { path: string; file: File },
  volumesByPath: Record<string, Partial<VolumeMetadata>>,
  volumesDataByPath: Record<string, Partial<VolumeData>>,
  pendingImagesByPath: Record<string, Record<string, File>>
): Promise<void> {
  const path = removeExtension(file.path);
  const { metadata, data, titleUuid } = await processMokuroFile(file.file);
  volumesByPath[path] = metadata;

  // Check if we have pending images for this mokuro file
  const vol = Object.keys(pendingImagesByPath).find((key) => key.startsWith(path));
  if (vol && pendingImagesByPath[vol]) {
    volumesDataByPath[path] = {
      ...data,
      files: pendingImagesByPath[vol]
    };
    delete pendingImagesByPath[vol];

    // Upload if complete
    if (
      volumesDataByPath[path].pages?.length === Object.keys(volumesDataByPath[path].files!).length
    ) {
      const uploadData = volumesDataByPath[path];
      delete volumesDataByPath[path];
      await uploadVolumeData(volumesByPath, path, uploadData);
    }
  } else {
    // Store mokuro data for potential future images
    volumesDataByPath[path] = {
      ...data,
      files: {}
    };
  }
}

export async function processFiles(_files: File[]) {
  const volumesByPath: Record<string, Partial<VolumeMetadata>> = {};
  const volumesDataByPath: Record<string, Partial<VolumeData>> = {};
  const pendingImagesByPath: Record<string, Record<string, File>> = {};

  // Create a stack of files to process
  let fileStack: { path: string; file: File }[] = [];
  _files.forEach((file) => {
    const path = getDetails(file).path;
    fileStack.push({ path, file });
  });

  fileStack = fileStack.sort((a, b) =>
    a.file.name.localeCompare(b.file.name, undefined, { numeric: true })
  );

  for (const file of fileStack) {
    await processFile(file, volumesByPath, volumesDataByPath, pendingImagesByPath);
  }

  showSnackbar('Files uploaded successfully');
  db.processThumbnails(5);
}
