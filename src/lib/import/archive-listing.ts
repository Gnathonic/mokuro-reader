/**
 * What an archive holds, read from its entry NAMES (#285).
 *
 * The queue's PASS 1 (`processArchiveContents`, with the `.mokuro` bytes in
 * hand) and the pre-import scan (names only — zip.js reads the central
 * directory, a few KB from the end of the file) both turn an archive listing
 * into volume pairings HERE, so the review offers exactly the image-only
 * volumes the queue will later find.
 *
 * The pre-scan keeps nothing but strings: an archive's listing is reduced to
 * the inner paths and title paths of its image-only volumes and a flag, then
 * dropped. Archives are listed one at a time.
 */

import type { FileEntry, PairedSource } from './types';
import { isArchiveExtension, isImageExtension, isMokuroExtension, isSystemFile } from './types';
import { pairMokuroWithSources } from './pairing';
import { isSeriesFilePath } from '$lib/metadata/series-file';
import { extractLayerEntries, type ExtractedLayerEntry } from '$lib/reader/edit/layer-import';

/** One archive entry as listed: `data` is empty unless its bytes were extracted. */
export interface ListedEntry {
  filename: string;
  data: ArrayBuffer;
}

export function isThumbnailSidecarPath(path: string, sourceStems?: Set<string>): boolean {
  const filename = path.split('/').pop()?.toLowerCase() || '';
  if (!filename.endsWith('.webp')) return false;
  if (!sourceStems || sourceStems.size === 0) return false;
  const stem = filename.slice(0, -5);
  return sourceStems.has(stem);
}

/** `path` without an archive extension. */
export function stripArchiveExtension(path: string): string {
  return path.replace(/\.(zip|cbz|cbr|rar|7z)$/i, '');
}

/** `parent/child`, where `.`/empty children are the parent itself. */
export function joinTitlePath(parent: string, child: string): string {
  return child === '' || child === '.' ? parent : `${parent}/${child}`;
}

/** An archive listing as pairing input (mokuro bytes kept, images as empty placeholders). */
function archiveFileEntries(entries: ListedEntry[]): {
  fileEntries: FileEntry[];
  nestedArchivePaths: string[];
  seriesFilePaths: string[];
} {
  const fileEntries: FileEntry[] = [];
  const nestedArchivePaths: string[] = [];
  const seriesFilePaths: string[] = [];

  // Source stems from mokuro files and top-level folders, for sidecar detection.
  // The exporter places thumbnail sidecars at the archive root as {VolumeTitle}.webp,
  // matching the mokuro filename stem or the image folder name.
  const archiveSourceStems = new Set<string>();
  for (const entry of entries) {
    if (isSystemFile(entry.filename)) continue;
    const ext = entry.filename.split('.').pop()?.toLowerCase() || '';
    const name = entry.filename.split('/').pop() || entry.filename;
    if (isMokuroExtension(ext)) {
      archiveSourceStems.add(name.replace(/\.mokuro$/i, '').toLowerCase());
    }
    if (entry.filename.includes('/')) {
      const topFolder = entry.filename.split('/')[0].toLowerCase();
      if (topFolder) archiveSourceStems.add(topFolder);
    }
  }

  for (const entry of entries) {
    if (isSystemFile(entry.filename)) continue;
    const ext = entry.filename.split('.').pop()?.toLowerCase() || '';
    const filename = entry.filename.split('/').pop() || entry.filename;

    if (isSeriesFilePath(entry.filename)) {
      seriesFilePaths.push(entry.filename);
    } else if (isMokuroExtension(ext)) {
      fileEntries.push({
        path: entry.filename,
        file: new File([entry.data], filename, { lastModified: Date.now() })
      });
    } else if (isImageExtension(ext)) {
      if (isThumbnailSidecarPath(entry.filename, archiveSourceStems)) continue;
      fileEntries.push({
        path: entry.filename,
        file: new File([], filename, { lastModified: Date.now() })
      });
    } else if (isArchiveExtension(ext)) {
      nestedArchivePaths.push(entry.filename);
    }
  }

  return { fileEntries, nestedArchivePaths, seriesFilePaths };
}

export interface ArchiveListingPlan {
  mokuroPairings: PairedSource[];
  /** `titlePath` set; a root-level volume's `basePath` renamed to the archive stem. */
  imageOnlyPairings: PairedSource[];
  /** Image-only pairing id → its path INSIDE the archive (`.` = the root), as listed. */
  innerPaths: Map<string, string>;
  nestedArchivePaths: string[];
  seriesFilePaths: string[];
  /** `<stem>.<id>.mokuro` layer entries, for the caller to stash (or ignore). */
  layerEntries: ExtractedLayerEntry[];
  warnings: string[];
}

/**
 * An archive's volumes, from its listing. `archive.titlePath` is where the
 * archive itself sits, extension dropped (the literal-location half that the
 * inside path alone loses).
 */
export async function planArchiveListing(
  entries: ListedEntry[],
  archive: { name: string; titlePath: string },
  externalMokuro: File | null = null
): Promise<ArchiveListingPlan> {
  const { fileEntries, nestedArchivePaths, seriesFilePaths } = archiveFileEntries(entries);
  if (externalMokuro) fileEntries.push({ path: externalMokuro.name, file: externalMokuro });

  const layerSplit = extractLayerEntries(fileEntries);
  const { pairings, warnings } = await pairMokuroWithSources(layerSplit.entries);
  const mokuroPairings = pairings.filter((p) => !p.imageOnly);
  const imageOnlyPairings = pairings.filter((p) => p.imageOnly);

  const archiveStem = stripArchiveExtension(archive.name);
  const innerPaths = new Map<string, string>();
  for (const pairing of imageOnlyPairings) {
    innerPaths.set(pairing.id, pairing.basePath);
    // A volume is named from where it sits in the archive AND where the
    // archive sits — `basePath` here is only the inside half.
    pairing.titlePath = joinTitlePath(archive.titlePath, pairing.basePath);
    if (pairing.basePath === '.' || pairing.basePath === '') pairing.basePath = archiveStem;
  }

  return {
    mokuroPairings,
    imageOnlyPairings,
    innerPaths,
    nestedArchivePaths,
    seriesFilePaths,
    layerEntries: [...layerSplit.layers, ...layerSplit.standalone],
    warnings
  };
}

export interface InnerVolume {
  /** Path inside the archive (`.` = its root) — the key approved names travel under. */
  innerPath: string;
  basePath: string;
  titlePath: string;
}

export type ArchiveScan =
  /** Could not be listed: the queue opens it as today and reviews it there. */
  | { kind: 'unlisted' }
  /** Nothing image-only: imports silently, as today. */
  | { kind: 'silent' }
  /** Image-only volumes to review; `importsRegardless` = it also holds .mokuro volumes or archives. */
  | { kind: 'review'; inner: InnerVolume[]; importsRegardless: boolean };

export async function scanArchiveListing(
  entries: ListedEntry[],
  archive: { name: string; titlePath: string }
): Promise<ArchiveScan> {
  const plan = await planArchiveListing(entries, archive);
  if (plan.imageOnlyPairings.length === 0) return { kind: 'silent' };
  return {
    kind: 'review',
    inner: plan.imageOnlyPairings.map((p) => ({
      innerPath: plan.innerPaths.get(p.id) ?? p.basePath,
      basePath: p.basePath,
      titlePath: p.titlePath ?? p.basePath
    })),
    importsRegardless: plan.mokuroPairings.length > 0 || plan.nestedArchivePaths.length > 0
  };
}

/** Lists an archive's entry names without extracting entry bytes. */
export type ListArchive = (file: File) => Promise<ListedEntry[]>;

/**
 * Pre-scan every picked archive that carries no external `.mokuro`, ONE AT A
 * TIME. Keyed by pairing id; pairings that are not scanned are absent.
 */
export async function prescanArchives(
  pairings: PairedSource[],
  list: ListArchive
): Promise<Map<string, ArchiveScan>> {
  const scans = new Map<string, ArchiveScan>();
  for (const pairing of pairings) {
    if (pairing.source.type !== 'archive' || pairing.mokuroFile) continue;
    const file = pairing.source.file;
    const titlePath =
      pairing.titlePath ?? stripArchiveExtension(file.webkitRelativePath || file.name);
    try {
      scans.set(
        pairing.id,
        await scanArchiveListing(await list(file), { name: file.name, titlePath })
      );
    } catch (error) {
      console.warn(
        `[Import] Could not list ${file.name}; it is reviewed when the queue opens it`,
        error
      );
      scans.set(pairing.id, { kind: 'unlisted' });
    }
  }
  return scans;
}

/** The grey source line of an archive volume in the review. */
export function archiveSourceLabel(file: File, innerPath: string): string {
  const picked = file.webkitRelativePath || file.name;
  return innerPath === '.' || innerPath === '' ? picked : `${picked} › ${innerPath}`;
}
