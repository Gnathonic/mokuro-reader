import { db } from '$lib/catalog/db';
import type { VolumeData, VolumeMetadata } from '$lib/types';
import { showSnackbar } from '$lib/util/snackbar';
import {
  promptImageOnlyImport,
  promptImportMismatch,
  type SeriesImportInfo,
  type ImportMismatchInfo
} from '$lib/util/modals';
import { requestPersistentStorage } from '$lib/util/upload';
import { normalizeFilename, remapPagePaths, comparePagePathsToFiles } from '$lib/util/misc';
import { getMimeType, ZipReaderStream } from '@zip.js/zip.js';
import { generateThumbnail } from '$lib/catalog/thumbnails';
import { calculateCumulativeCharCounts } from '$lib/catalog/migration';
import {
  generateFallbackVolumeData,
  extractSeriesName,
  type SeriesInfo
} from './image-only-fallback';

/**
 * Groups orphaned images by their extracted series name
 * This allows multiple volumes to be grouped into the same series
 */
interface SeriesGroup {
  seriesName: string;
  seriesUuid: string;
  volumes: Array<{ path: string; images: Record<string, File> }>;
}

/**
 * Generates a deterministic UUID from a string using a simple hash
 * Duplicated here for grouping - same algorithm as in image-only-fallback
 */
function generateDeterministicUUID(input: string): string {
  const normalized = input.toLowerCase().trim();
  let hash1 = 5381;
  let hash2 = 52711;

  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i);
    hash1 = (hash1 * 33) ^ char;
    hash2 = (hash2 * 33) ^ char;
  }

  hash1 = hash1 >>> 0;
  hash2 = hash2 >>> 0;

  const hex1 = hash1.toString(16).padStart(8, '0');
  const hex2 = hash2.toString(16).padStart(8, '0');
  const hash3 = ((hash1 ^ hash2) >>> 0).toString(16).padStart(8, '0');
  const hash4 = ((hash1 + hash2) >>> 0).toString(16).padStart(8, '0');

  return `${hex1}-${hex2.slice(0, 4)}-4${hex2.slice(5, 8)}-${(8 + (parseInt(hash3[0], 16) % 4)).toString(16)}${hash3.slice(1, 4)}-${hash3.slice(4)}${hash4.slice(0, 4)}`;
}

/**
 * Groups orphaned images by their series name
 * Volumes with the same extracted series name will be grouped together
 */
function groupOrphanedImagesBySeries(
  pendingImagesByPath: Record<string, Record<string, File>>
): SeriesGroup[] {
  const groupsBySeriesName = new Map<string, SeriesGroup>();

  for (const [path, images] of Object.entries(pendingImagesByPath)) {
    const seriesName = extractSeriesName(path);

    let group = groupsBySeriesName.get(seriesName);
    if (!group) {
      group = {
        seriesName,
        seriesUuid: generateDeterministicUUID(seriesName),
        volumes: []
      };
      groupsBySeriesName.set(seriesName, group);
    }

    group.volumes.push({ path, images });
  }

  return Array.from(groupsBySeriesName.values());
}

export * from './web-import';

const zipTypes = ['zip', 'cbz'];
const imageExtensions = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'tif', 'tiff', 'gif', 'bmp', 'jxl'];

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
  return (
    getMimeType(fileName).startsWith('image/') || imageExtensions.includes(getExtension(fileName))
  );
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
    uploadMetadata.mokuro_version !== undefined && // Allow empty string for image-only volumes
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
          Object.entries(uploadData.files).sort(([aKey], [bKey]) =>
            aKey.localeCompare(bKey, undefined, {
              numeric: true,
              sensitivity: 'base'
            })
          )
        );
      }

      // Remap page img_path values if image formats have changed (e.g., png->webp)
      if (uploadData.pages && uploadData.files) {
        uploadData.pages = remapPagePaths(uploadData.pages, uploadData.files);
      }

      // Generate thumbnail from first file
      let thumbnailResult: { file: File; width: number; height: number } | undefined;
      const firstFileKey = uploadData.files ? Object.keys(uploadData.files)[0] : undefined;
      const firstFile = firstFileKey ? uploadData.files?.[firstFileKey] : undefined;
      if (firstFile) {
        thumbnailResult = await generateThumbnail(firstFile);
      }

      // Calculate cumulative character counts from pages
      const pageCharCounts = uploadData.pages
        ? calculateCumulativeCharCounts(uploadData.pages)
        : [];

      // Write to all 3 tables in a single transaction
      await db.transaction('rw', [db.volumes, db.volume_ocr, db.volume_files], async () => {
        // Write metadata with thumbnail, dimensions, and page_char_counts
        await db.volumes.add(
          {
            ...uploadMetadata,
            page_char_counts: pageCharCounts,
            thumbnail: thumbnailResult?.file,
            thumbnail_width: thumbnailResult?.width,
            thumbnail_height: thumbnailResult?.height
          } as VolumeMetadata,
          uploadMetadata.volume_uuid
        );

        // Write OCR data
        if (uploadData.pages) {
          await db.volume_ocr.add({
            volume_uuid: uploadMetadata.volume_uuid!,
            pages: uploadData.pages
          });
        }

        // Write files
        if (uploadData.files && Object.keys(uploadData.files).length > 0) {
          await db.volume_files.add({
            volume_uuid: uploadMetadata.volume_uuid!,
            files: uploadData.files
          });
        }
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

  // Use volume title as fallback for empty series title
  const seriesTitle = mokuroData.title || mokuroData.volume || file.name.replace('.mokuro', '');

  return {
    metadata: {
      mokuro_version: mokuroData.version,
      series_title: seriesTitle,
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

  return excludedDirPatterns.some(
    (pattern) =>
      path.includes('/' + pattern + '/') || path.endsWith('/' + pattern) || path === pattern
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
    console.log(
      `Skipping file in problematic directory: ${file.path || file.file.webkitRelativePath}`
    );
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
  // Cast to any to workaround TypeScript type definition limitation
  // ZipReaderStream does support async iteration at runtime
  for await (const entry of zipFile.file.stream().pipeThrough(new ZipReaderStream()) as any) {
    // Skip directories as we're only creating File objects
    if (entry.directory) continue;

    // Process file entries
    if (entry.readable) {
      // Convert readable stream to ArrayBuffer to avoid intermediate Blob disk writes
      const arrayBuffer = await new Response(entry.readable).arrayBuffer();

      // Create a File object directly from ArrayBuffer
      const fileBlob = new File([arrayBuffer], entry.filename, {
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
  const path = normalizeFilename(file.path);

  if (!path) return;

  // Normalize filename to handle URL-encoded Unicode characters
  const relativePath = normalizeFilename(file.file.name);
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

/**
 * Shows the import confirmation modal and waits for user response
 */
function showImportConfirmationModal(seriesGroups: SeriesGroup[]): Promise<boolean> {
  return new Promise((resolve) => {
    const totalVolumes = seriesGroups.reduce((sum, group) => sum + group.volumes.length, 0);

    // Sort by series name for display
    const sortedGroups = [...seriesGroups].sort((a, b) =>
      a.seriesName.localeCompare(b.seriesName, undefined, { sensitivity: 'base' })
    );

    // Convert to SeriesImportInfo format
    const seriesList: SeriesImportInfo[] = sortedGroups.map((group) => ({
      seriesName: group.seriesName,
      volumeCount: group.volumes.length
    }));

    promptImageOnlyImport(
      seriesList,
      totalVolumes,
      () => resolve(true),
      () => resolve(false)
    );
  });
}

/**
 * Process images that weren't matched to any .mokuro file (image-only volumes)
 * Groups volumes by series name so they appear together in the catalog
 */
async function processOrphanedImages(
  pendingImagesByPath: Record<string, Record<string, File>>,
  volumesByPath: Record<string, Partial<VolumeMetadata>>
): Promise<void> {
  const orphanedPaths = Object.keys(pendingImagesByPath);

  if (orphanedPaths.length === 0) {
    return;
  }

  // Group orphaned images by series name
  const seriesGroups = groupOrphanedImagesBySeries(pendingImagesByPath);

  const totalVolumes = seriesGroups.reduce((sum, group) => sum + group.volumes.length, 0);
  const seriesCount = seriesGroups.length;

  // Show confirmation modal and wait for user response
  const confirmed = await showImportConfirmationModal(seriesGroups);

  if (!confirmed) {
    showSnackbar(`Image-only import cancelled`, 3000);
    return;
  }

  showSnackbar(`Importing ${totalVolumes} image-only volume(s) in ${seriesCount} series...`, 5000);

  // Process each series group
  for (const group of seriesGroups) {
    const seriesInfo: SeriesInfo = {
      seriesName: group.seriesName,
      seriesUuid: group.seriesUuid
    };

    // Process each volume in the group
    for (const { path, images } of group.volumes) {
      // Skip if no images
      if (!images || Object.keys(images).length === 0) {
        continue;
      }

      try {
        showSnackbar(`Processing: ${path}`, 3000);

        // Generate fallback metadata and data with shared series info
        const { metadata, data } = await generateFallbackVolumeData(path, images, seriesInfo);

        // Store in volumesByPath
        volumesByPath[path] = metadata;

        // Upload to database
        await uploadVolumeData(volumesByPath, path, data);

        showSnackbar(`Added: ${metadata.volume_title} (${group.seriesName})`, 3000);
      } catch (error) {
        console.error(`Failed to process image-only volume at ${path}:`, error);
        showSnackbar(`Failed to import images from ${path}`, 3000);
      }
    }
  }
}

export interface ProcessFilesResult {
  success: boolean;
  failedVolumes: ImportMismatchInfo[];
}

export interface ProcessFilesOptions {
  onMismatchDismiss?: () => void;
}

export async function processFiles(
  _files: File[],
  options?: ProcessFilesOptions
): Promise<ProcessFilesResult> {
  const volumesByPath: Record<string, Partial<VolumeMetadata>> = {};
  const volumesDataByPath: Record<string, Partial<VolumeData>> = {};
  const pendingImagesByPath: Record<string, Record<string, File>> = {};

  // Create a stack of files to process
  let fileStack: { path: string; file: File }[] = [];
  _files.forEach((file) => {
    const path = getDetails(file).path;
    fileStack.push({ path, file });
  });

  // Sort files: images and zips first, then mokuro files last
  // This ensures images are stored in pendingImagesByPath before mokuro files try to match them
  fileStack = fileStack.sort((a, b) => {
    const aIsMokuro = isMokuro(a.file.name);
    const bIsMokuro = isMokuro(b.file.name);

    // Mokuro files should come after non-mokuro files
    if (aIsMokuro && !bIsMokuro) return 1;
    if (!aIsMokuro && bIsMokuro) return -1;

    // Within each group, sort alphabetically
    return a.file.name.localeCompare(b.file.name, undefined, { numeric: true });
  });

  for (const file of fileStack) {
    await processFile(file, volumesByPath, volumesDataByPath, pendingImagesByPath);
  }

  // Process orphaned images (images without .mokuro files) as image-only volumes
  await processOrphanedImages(pendingImagesByPath, volumesByPath);

  // Check for volumes that failed to import due to file count/path mismatches
  const failedVolumes = Object.entries(volumesDataByPath);
  const mismatchInfos: ImportMismatchInfo[] = [];

  if (failedVolumes.length > 0) {
    for (const [path, volumeData] of failedVolumes) {
      const metadata = volumesByPath[path];
      const volumeName = metadata?.volume_title || path.split('/').pop() || 'Unknown';

      // Get expected page paths from mokuro data
      const expectedPaths = volumeData.pages?.map((p) => p.img_path) ?? [];
      // Get actual file names
      const actualFiles = Object.keys(volumeData.files ?? {});

      // Compare to find mismatches
      const matchResult = comparePagePathsToFiles(expectedPaths, actualFiles);

      console.error('[Import] Volume failed due to file mismatch:', {
        path,
        volumeName,
        expectedCount: expectedPaths.length,
        actualCount: actualFiles.length,
        matched: matchResult.matched,
        missingFiles: matchResult.missingFiles,
        extraFiles: matchResult.extraFiles
      });

      mismatchInfos.push({
        volumeName,
        expectedCount: expectedPaths.length,
        actualCount: actualFiles.length,
        missingFiles: matchResult.missingFiles,
        extraFiles: matchResult.extraFiles
      });
    }

    // Show the mismatch modal
    if (mismatchInfos.length > 0) {
      promptImportMismatch(mismatchInfos, options?.onMismatchDismiss);
      db.processThumbnails(5);
      return { success: false, failedVolumes: mismatchInfos };
    }
  }

  showSnackbar('Files uploaded successfully');
  db.processThumbnails(5);
  return { success: true, failedVolumes: [] };
}
