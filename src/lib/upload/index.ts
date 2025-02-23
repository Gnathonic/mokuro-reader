import { db } from '$lib/catalog/db';
import type { VolumeData, VolumeMetadata } from '$lib/types';
import { showSnackbar } from '$lib/util/snackbar';
import { requestPersistentStorage } from '$lib/util/upload';
import { BlobWriter, getMimeType, ZipReaderStream } from '@zip.js/zip.js';
import { generateThumbnail } from '$lib/catalog/thumbnails';

export * from './web-import';

const zipTypes = ['zip', 'cbz', 'ZIP', 'CBZ'];
const imageTypes = ['image/jpeg', 'image/png', 'image/webp'];

export async function unzipManga(file: File) {
  // Create a TransformStream for the zip content
  const zipFileStream = new TransformStream();
  // Create a Promise that will resolve with the entries
  const entriesPromise = (async () => {
    const zipReader = new ZipReaderStream(file.stream());
    return await zipReader.getEntries();
  })();
  const entries = await entriesPromise;
  const unzippedFiles: Record<string, File> = {};

  // Sort entries by filename
  const sortedEntries = entries.sort((a, b) => {
    return a.filename.localeCompare(b.filename, undefined, {
      numeric: true,
      sensitivity: 'base'
    });
  });

  // Process entries sequentially to maintain memory efficiency
  for (const entry of sortedEntries) {
    const mime = getMimeType(entry.filename);
    const isMokuroFile = entry.filename.split('.').pop() === 'mokuro';

    if (imageTypes.includes(mime) || isMokuroFile) {
      // Create a TransformStream for each entry
      const entryStream = new TransformStream();
      const blobPromise = new Response(entryStream.readable).blob();
      
      // Get the entry data as a stream
      await entry.getData(entryStream.writable);
      
      // Wait for the blob to be ready
      const blob = await blobPromise;
      const fileName = entry.filename.split('/').pop() || entry.filename;
      const file = new File([blob], fileName, { type: mime });
      
      // Set webkitRelativePath for proper file path handling
      if (!file.webkitRelativePath) {
        Object.defineProperty(file, 'webkitRelativePath', {
          value: entry.filename
        });
      }
      unzippedFiles[entry.filename] = file;
    }
  }

  return unzippedFiles;
}

function getDetails(file: File) {
  const { webkitRelativePath, name } = file;
  const split = name.split('.');
  const ext = split.pop();
  const filename = split.join('.');
  let path = filename;

  if (webkitRelativePath) {
    path = webkitRelativePath.split('.')[0];
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

async function extractZipContents(
  file: File,
  parentPath: string
): Promise<{ path: string; file: File }[]> {
  const unzippedFiles = await unzipManga(file);
  const extractedFiles: { path: string; file: File }[] = [];

  for (const [name, file] of Object.entries(unzippedFiles)) {
    const ext = getDetails(file).ext;
    const relativePath = ext ? name.slice(0, -(ext.length + 1)) : name;
    const path = `${parentPath}/${relativePath}`;
    extractedFiles.push({ path, file });
  }

  return extractedFiles.sort((a, b) => a.path.localeCompare(b.path));
}

async function processZipFile(
  file: { path: string; file: File },
  fileStack: { path: string; file: File }[]
): Promise<void> {
  const path = file.path;

  // Extract and add all files to the stack
  const extractedFiles = await extractZipContents(file.file, path);
  fileStack.push(...extractedFiles.reverse());
}

async function processStandaloneImage(
  file: { path: string; file: File },
  volumesDataByPath: Record<string, Partial<VolumeData>>,
  volumesByPath: Record<string, Partial<VolumeMetadata>>,
  pendingImagesByPath: Record<string, Record<string, File>>
): Promise<void> {
  const path = file.path;

  if (!path) return;

  const relativePath = file.file.webkitRelativePath;
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
  const path = file.path;
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
  const fileStack: { path: string; file: File }[] = [];
  _files.reverse().forEach((file) => {
    const ext = getDetails(file).ext;
    const path = ext
      ? file.webkitRelativePath.slice(0, -(ext.length + 1))
      : file.webkitRelativePath;
    fileStack.push({ path, file });
  });

  // Process files using a stack
  while (fileStack.length > 0) {
    const file = fileStack.pop()!;
    const { ext } = getDetails(file.file);

    if (ext === 'mokuro') {
      await processMokuroWithPendingImages(
        file,
        volumesByPath,
        volumesDataByPath,
        pendingImagesByPath
      );
    } else if (ext && zipTypes.includes(ext)) {
      await processZipFile(file, fileStack);
    } else {
      const mimeType = getMimeType(file.file.name);
      if (imageTypes.includes(mimeType)) {
        await processStandaloneImage(file, volumesDataByPath, volumesByPath, pendingImagesByPath);
      }
    }
  }

  showSnackbar('Files uploaded successfully');
  db.processThumbnails(5);
}
