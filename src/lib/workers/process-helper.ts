// Helper functions for processing files in a worker context
import type { VolumeData, VolumeMetadata } from '$lib/types';
import { getMimeType, ZipReaderStream } from '@zip.js/zip.js';

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

// Process a mokuro file and return the metadata and data
async function processMokuroFile(file: File): Promise<{
  metadata: Partial<VolumeMetadata>;
  data: Partial<VolumeData>;
  titleUuid: string;
}> {
  const mokuroData = JSON.parse(await file.text());
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

// Process a file and update the data structures
async function processFileInWorker(
  file: { path: string; file: File },
  volumesByPath: Record<string, Partial<VolumeMetadata>>,
  volumesDataByPath: Record<string, Partial<VolumeData>>,
  pendingImagesByPath: Record<string, Record<string, File>>
) {
  if (isMokuro(file.file.name)) {
    await processMokuroWithPendingImages(
      file,
      volumesByPath,
      volumesDataByPath,
      pendingImagesByPath
    );
    console.log('Processed mokuro ' + file.file.name);
  } else if (isZip(file.file.name)) {
    console.log('Opening ' + file.file.name);
    await processZipFile(file, volumesDataByPath, volumesByPath, pendingImagesByPath);
  } else if (isImage(file.file.name)) {
    await processStandaloneImage(file, volumesDataByPath, volumesByPath, pendingImagesByPath);
    console.log('Processed image ' + file.file.name);
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

      await processFileInWorker(file, volumesByPath, volumesDataByPath, pendingImagesByPath);
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
  } else {
    // Store mokuro data for potential future images
    volumesDataByPath[path] = {
      ...data,
      files: {}
    };
  }
}

// Main function to process files in the worker
export async function processFilesInWorker(files: File[]): Promise<{
  volumesByPath: Record<string, Partial<VolumeMetadata>>;
  volumesDataByPath: Record<string, Partial<VolumeData>>;
}> {
  const volumesByPath: Record<string, Partial<VolumeMetadata>> = {};
  const volumesDataByPath: Record<string, Partial<VolumeData>> = {};
  const pendingImagesByPath: Record<string, Record<string, File>> = {};

  // Create a stack of files to process
  let fileStack: { path: string; file: File }[] = [];
  files.forEach((file) => {
    const path = getDetails(file).path;
    fileStack.push({ path, file });
  });

  fileStack = fileStack.sort((a, b) =>
    a.file.name.localeCompare(b.file.name, undefined, { numeric: true })
  );

  for (const file of fileStack) {
    await processFileInWorker(file, volumesByPath, volumesDataByPath, pendingImagesByPath);
  }

  return { volumesByPath, volumesDataByPath };
}