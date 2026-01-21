/**
 * Archive extraction logic
 *
 * Core extraction functions that can be used both in Workers and directly in tests.
 * This module contains pure logic without Worker-specific code.
 */

import { BlobReader, ZipReader, Uint8ArrayWriter, configure } from '@zip.js/zip.js';
import { isSystemFile, isImageExtension, isMokuroExtension } from './types';

// Configure zip.js to not use web workers in Node.js environments
// Web workers don't work properly in jsdom/vitest
const isNode =
  typeof globalThis !== 'undefined' &&
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).process?.versions?.node != null;

if (isNode) {
  configure({
    useWebWorkers: false
  });
}

/**
 * Volume definition for extraction
 */
export interface VolumeExtractDef {
  id: string;
  pathPrefix: string;
}

/**
 * Extracted entry with volume association
 */
export interface ExtractedEntry {
  filename: string;
  data: ArrayBuffer;
  volumeId: string;
}

/**
 * Result of archive extraction
 */
export interface ExtractionResult {
  entries: ExtractedEntry[];
  extracted: number;
  skipped: number;
}

/**
 * Match a filename to a volume based on path prefixes.
 *
 * Matching rules:
 * 1. Specific prefixes are checked first (e.g., "vol1/" matches "vol1/page.jpg")
 * 2. Root-level prefix ("." or "") matches files without directory separators
 * 3. More specific prefixes take priority over root-level
 *
 * @param filename - The file path to match
 * @param volumePrefixes - Map of pathPrefix → volumeId
 * @returns The matched volumeId, or null if no match
 */
export function matchFileToVolume(
  filename: string,
  volumePrefixes: Map<string, string>
): string | null {
  // First pass: check specific prefixes (not root)
  for (const [prefix, volId] of volumePrefixes) {
    // Skip root-level prefix for now, check it last
    if (prefix === '.' || prefix === '') continue;
    if (filename.startsWith(prefix + '/') || filename === prefix) {
      return volId;
    }
  }

  // Second pass: if no specific prefix matched, check for root-level volume
  // Root-level means files without directory separators
  for (const [prefix, volId] of volumePrefixes) {
    if (prefix === '.' || prefix === '') {
      // Match root-level files (no directory in path)
      if (!filename.includes('/')) {
        return volId;
      }
    }
  }

  return null;
}

/**
 * Calculate relative path for a file within a volume
 *
 * @param filename - Full filename from archive
 * @param pathPrefix - The volume's path prefix
 * @returns Relative path within the volume
 */
export function getRelativePath(filename: string, pathPrefix: string): string {
  if (pathPrefix === '.' || pathPrefix === '') {
    return filename;
  }
  return filename.startsWith(pathPrefix + '/') ? filename.slice(pathPrefix.length + 1) : filename;
}

/**
 * Extract images from an archive, grouped by volume.
 *
 * This is the core extraction logic that can be used both in Workers
 * and directly in tests.
 *
 * @param archiveBlob - The archive file as a Blob
 * @param volumes - Volume definitions with path prefixes
 * @param onProgress - Optional progress callback
 * @param onEntry - Optional callback for each extracted entry (for streaming)
 * @returns Map of volumeId → (relativePath → File)
 */
export async function extractArchiveByVolumes(
  archiveBlob: Blob,
  volumes: VolumeExtractDef[],
  onProgress?: (extracted: number, total: number) => void,
  onEntry?: (entry: ExtractedEntry) => void
): Promise<Map<string, Map<string, File>>> {
  const EXTRACT_CONCURRENCY = 5;

  // Map of volumeId → (relativePath → File)
  const allVolumeFiles = new Map<string, Map<string, File>>();

  // Initialize maps for each volume
  for (const vol of volumes) {
    allVolumeFiles.set(vol.id, new Map());
  }

  // Build prefix → volumeId lookup
  const volumePrefixes = new Map<string, string>();
  for (const vol of volumes) {
    volumePrefixes.set(vol.pathPrefix, vol.id);
  }

  const zipReader = new ZipReader(new BlobReader(archiveBlob));
  const entries = await zipReader.getEntries();

  // Categorize entries - determine which files to extract and for which volume
  const toExtract: { entry: (typeof entries)[0]; volumeId: string }[] = [];

  for (const entry of entries) {
    if (entry.directory) continue;
    if (isSystemFile(entry.filename)) continue;

    // Match file to volume
    const matchedVolumeId = matchFileToVolume(entry.filename, volumePrefixes);
    if (!matchedVolumeId) continue;

    // Check if it's an image
    const ext = entry.filename.split('.').pop()?.toLowerCase() || '';
    if (!isImageExtension(ext)) continue;

    toExtract.push({ entry, volumeId: matchedVolumeId });
  }

  // Extract in parallel batches
  let extracted = 0;
  const totalFiles = toExtract.length;

  for (let i = 0; i < toExtract.length; i += EXTRACT_CONCURRENCY) {
    const batch = toExtract.slice(i, i + EXTRACT_CONCURRENCY);

    const results = await Promise.all(
      batch.map(async ({ entry, volumeId }) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const uint8Array = await (entry as any).getData(new Uint8ArrayWriter());
          return {
            filename: entry.filename,
            data: uint8Array.buffer as ArrayBuffer,
            volumeId
          };
        } catch (err) {
          console.error(`Error extracting ${entry.filename}:`, err);
          return null;
        }
      })
    );

    // Process results
    for (const result of results) {
      if (result) {
        // Find the volume and its prefix
        const vol = volumes.find((v) => v.id === result.volumeId);
        const prefix = vol?.pathPrefix || '';

        // Calculate relative path
        const relativePath = getRelativePath(result.filename, prefix);
        const filename = result.filename.split('/').pop() || result.filename;

        // Create File and store
        const file = new File([result.data], filename, { lastModified: Date.now() });
        const volumeFiles = allVolumeFiles.get(result.volumeId);
        if (volumeFiles) {
          volumeFiles.set(relativePath, file);
        }

        // Call entry callback if provided (for streaming/progress)
        if (onEntry) {
          onEntry(result);
        }

        extracted++;
      }
    }

    // Progress callback
    if (onProgress) {
      onProgress(extracted, totalFiles);
    }
  }

  await zipReader.close();

  return allVolumeFiles;
}

/**
 * Filter options for selective extraction
 */
export interface ExtractFilter {
  extensions?: string[];
  pathPrefixes?: string[];
}

/**
 * Raw decompressed entry
 */
export interface RawEntry {
  filename: string;
  data: ArrayBuffer;
}

/**
 * Decompress an archive with optional filtering.
 *
 * This mirrors the worker's decompress-only mode but runs directly.
 * Used in tests where Workers aren't available.
 *
 * @param archiveBlob - The archive file as a Blob
 * @param filter - Optional filter for selective extraction
 * @param listOnly - If true, return file list without content
 * @param listAllExtractFiltered - If true, list all but only extract filtered
 * @param onProgress - Optional progress callback
 * @returns Array of extracted entries
 */
export async function decompressArchive(
  archiveBlob: Blob,
  filter?: ExtractFilter,
  listOnly?: boolean,
  listAllExtractFiltered?: boolean,
  onProgress?: (extracted: number, total: number) => void
): Promise<RawEntry[]> {
  const EXTRACT_CONCURRENCY = 5;

  const zipReader = new ZipReader(new BlobReader(archiveBlob));
  const entries = await zipReader.getEntries();

  const results: RawEntry[] = [];

  // Filter entries
  const toProcess = entries.filter((entry) => {
    if (entry.directory) return false;
    if (isSystemFile(entry.filename)) return false;
    return true;
  });

  // Determine which entries to extract content for
  const shouldExtractContent = (filename: string): boolean => {
    if (listOnly) return false;

    if (!filter) return true;

    const ext = filename.split('.').pop()?.toLowerCase() || '';

    if (filter.extensions) {
      if (!filter.extensions.includes(ext)) {
        return listAllExtractFiltered ? false : false;
      }
    }

    if (filter.pathPrefixes) {
      const matchesPrefix = filter.pathPrefixes.some(
        (prefix) => filename.startsWith(prefix + '/') || filename === prefix
      );
      if (!matchesPrefix) {
        return listAllExtractFiltered ? false : false;
      }
    }

    return true;
  };

  // Process in batches
  let processed = 0;
  const totalFiles = toProcess.length;

  for (let i = 0; i < toProcess.length; i += EXTRACT_CONCURRENCY) {
    const batch = toProcess.slice(i, i + EXTRACT_CONCURRENCY);

    const batchResults = await Promise.all(
      batch.map(async (entry) => {
        try {
          if (listAllExtractFiltered) {
            // List all files, but only extract content for filtered ones
            const shouldExtract = shouldExtractContent(entry.filename);
            if (shouldExtract) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const uint8Array = await (entry as any).getData(new Uint8ArrayWriter());
              return { filename: entry.filename, data: uint8Array.buffer as ArrayBuffer };
            } else {
              // Return entry with empty data (just for listing)
              return { filename: entry.filename, data: new ArrayBuffer(0) };
            }
          } else if (shouldExtractContent(entry.filename)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const uint8Array = await (entry as any).getData(new Uint8ArrayWriter());
            return { filename: entry.filename, data: uint8Array.buffer as ArrayBuffer };
          } else if (listOnly) {
            return { filename: entry.filename, data: new ArrayBuffer(0) };
          }
          return null;
        } catch (err) {
          console.error(`Error processing ${entry.filename}:`, err);
          return null;
        }
      })
    );

    for (const result of batchResults) {
      if (result) {
        results.push(result);
        processed++;
      }
    }

    if (onProgress) {
      onProgress(processed, totalFiles);
    }
  }

  await zipReader.close();

  return results;
}
