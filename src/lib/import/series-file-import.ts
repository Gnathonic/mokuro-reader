/**
 * `series.json` on the import side.
 *
 * A sidecar can ride along with an import three ways: picked next to the
 * `.cbz`/`.mokuro` files, at the root of a series ZIP holding several volumes,
 * or at the root of a single-volume archive (where our own exporter puts it).
 * None of them is a volume, so the pairing stage ignores it; this module
 * collects the parsed copies during an import and applies them once the batch's
 * volumes are on disk — the key is the FINAL sanitized `series_title` the
 * volumes were stored under, never a title derived from a folder name.
 *
 * Everything here is best effort: an import must never fail because of a
 * `series.json`, so a malformed or unkeyable file is one `console.warn` and the
 * volumes still import.
 */

import { putSeriesIndex } from '$lib/metadata/series-index';
import { normalizeSeriesKey } from '$lib/metadata/series-key';
import { SERIES_FILE_NAME, parseSeriesFile, type SeriesFile } from '$lib/metadata/series-file';
import { upsertFromSeriesFile } from '$lib/metadata/store';
import { sanitizeTitleSegment } from '$lib/util/sanitize-title';

/** A validated `series.json` waiting for the batch's volumes to be saved. */
export interface PendingSeriesFile {
  file: SeriesFile;
  /** Where it came from: an archive entry path or the picked file's name. */
  path: string;
  size: number;
  /** The file's own timestamp, ISO — the `source` stamp of the cached index. */
  modifiedTime: string;
}

/**
 * Validate one candidate `series.json`. Junk (not JSON, wrong shape, blank
 * `series_title`) is a single warning and `undefined` — never a throw, since
 * this runs inside the import pipeline.
 */
export function parseImportedSeriesFile(
  path: string,
  text: string,
  size: number,
  lastModified: number
): PendingSeriesFile | undefined {
  let file: SeriesFile | undefined;
  try {
    file = parseSeriesFile(JSON.parse(text));
  } catch {
    file = undefined;
  }
  if (!file) {
    console.warn(`[Import] Ignoring an unreadable ${SERIES_FILE_NAME} at '${path}'`);
    return undefined;
  }
  return {
    file,
    path,
    size,
    modifiedTime: new Date(
      Number.isFinite(lastModified) && lastModified > 0 ? lastModified : Date.now()
    ).toISOString()
  };
}

/** `Blob.text()` where it exists, `FileReader` where it does not (jsdom). */
async function readAsText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

/** Collect a picked/dropped `series.json`. Never throws. */
export async function collectSeriesFileFromFile(path: string, file: File): Promise<void> {
  let text: string;
  try {
    text = await readAsText(file);
  } catch (error) {
    console.warn(`[Import] Could not read the ${SERIES_FILE_NAME} at '${path}':`, error);
    return;
  }
  const parsed = parseImportedSeriesFile(path, text, file.size, file.lastModified);
  if (parsed) recordSeriesFile(parsed);
}

/** Collect a `series.json` extracted from an archive. Never throws. */
export function collectSeriesFileFromBytes(
  path: string,
  data: ArrayBuffer,
  lastModified: number
): void {
  let text: string;
  try {
    text = new TextDecoder().decode(data);
  } catch (error) {
    console.warn(`[Import] Could not read the ${SERIES_FILE_NAME} at '${path}':`, error);
    return;
  }
  const parsed = parseImportedSeriesFile(path, text, data.byteLength, lastModified);
  if (parsed) recordSeriesFile(parsed);
}

// The batch: everything collected since the last apply. Module state rather
// than a threaded argument because a `series.json` is found while an archive is
// being scanned, several layers below the call that knows the import is done.
const pendingFiles: PendingSeriesFile[] = [];
const importedTitles = new Set<string>();

export function recordSeriesFile(entry: PendingSeriesFile): void {
  pendingFiles.push(entry);
}

/** The series title a volume of this batch was actually stored under. */
export function recordImportedSeriesTitle(seriesTitle: string): void {
  if (seriesTitle) importedTitles.add(seriesTitle);
}

/** Forget the batch without applying it (tests, cancelled imports). */
export function resetImportedSeriesFiles(): void {
  pendingFiles.length = 0;
  importedTitles.clear();
}

/**
 * Which series does this file belong to?
 *
 * The file's own `series_title` decides whenever it names one of the series
 * just imported — that is what keeps a multi-series drop straight. When it
 * names none of them, a single-series batch is unambiguous anyway (the sidecar
 * was exported before the series was renamed here), and anything else is a
 * guess we refuse to make.
 */
function resolveSeriesTitle(
  entry: PendingSeriesFile,
  titlesByKey: Map<string, string>,
  pendingCount: number
): string | undefined {
  const ownKey = normalizeSeriesKey(sanitizeTitleSegment(entry.file.series_title));
  const named = titlesByKey.get(ownKey);
  if (named) return named;
  if (pendingCount === 1 && titlesByKey.size === 1) return [...titlesByKey.values()][0];
  return undefined;
}

/**
 * Apply and drain the batch. Facts merge through `upsertFromSeriesFile` (strictly
 * newer wins), and the file is cached in `series_index` so this device reports
 * the same index as the one that wrote it — even though every volume of the
 * batch is installed locally and needs nothing from it.
 */
export async function applyImportedSeriesFiles(): Promise<void> {
  const entries = pendingFiles.splice(0, pendingFiles.length);
  const titles = [...importedTitles];
  importedTitles.clear();
  if (entries.length === 0) return;

  const titlesByKey = new Map<string, string>();
  for (const title of titles) titlesByKey.set(normalizeSeriesKey(title), title);

  for (const entry of entries) {
    const seriesTitle = resolveSeriesTitle(entry, titlesByKey, entries.length);
    if (!seriesTitle) {
      console.warn(
        `[Import] Could not tell which series the ${SERIES_FILE_NAME} at '${entry.path}' belongs to; ignoring it`
      );
      continue;
    }

    try {
      await upsertFromSeriesFile(seriesTitle, entry.file);
      await putSeriesIndex({
        series_key: normalizeSeriesKey(seriesTitle),
        series_title: seriesTitle,
        file: entry.file,
        source: {
          provider: 'import',
          path: entry.path,
          size: entry.size,
          modifiedTime: entry.modifiedTime
        },
        fetched_at: new Date().toISOString()
      });
    } catch (error) {
      console.warn(`[Import] Failed to apply the ${SERIES_FILE_NAME} of '${seriesTitle}':`, error);
    }
  }
}
