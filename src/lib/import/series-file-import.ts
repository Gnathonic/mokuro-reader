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

import { getSeriesIndex, putSeriesIndex } from '$lib/metadata/series-index';
import { normalizeSeriesKey } from '$lib/metadata/series-key';
import {
  SERIES_FILE_NAME,
  mergeSeriesFileForCache,
  parseSeriesFile,
  type SeriesFile
} from '$lib/metadata/series-file';
import { scheduleSeriesFileWrite } from '$lib/metadata/series-file-sync';
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
/** volume_uuid → the series title that volume was stored under. */
const importedVolumes = new Map<string, string>();

export function recordSeriesFile(entry: PendingSeriesFile): void {
  pendingFiles.push(entry);
}

/**
 * The series title a volume of this batch was actually stored under, with that
 * volume's uuid when the caller knows it — the uuid is what lets a sidecar be
 * matched to its series by index membership rather than by its (possibly
 * stale) `series_title`.
 */
export function recordImportedSeriesTitle(seriesTitle: string, volumeUuid?: string): void {
  if (!seriesTitle) return;
  importedTitles.add(seriesTitle);
  if (volumeUuid) importedVolumes.set(volumeUuid, seriesTitle);
}

/** Forget the batch without applying it (tests, cancelled imports). */
export function resetImportedSeriesFiles(): void {
  pendingFiles.length = 0;
  importedTitles.clear();
  importedVolumes.clear();
}

/**
 * Which series does this file belong to?
 *
 * In order of how much the file actually proves:
 *
 * 1. Its index lists a volume we just imported → it is that series' sidecar,
 *    whatever name it carries (this is how a sidecar written before the series
 *    was renamed here still lands correctly). When the index straddles several
 *    imported series, the one its `series_title` names wins, else the one
 *    holding most of its volumes.
 * 2. Its `series_title` names one of the series just imported → that one. This
 *    keeps a multi-series drop straight.
 * 3. A lone file in a single-series batch that claims nothing (no title) or
 *    claims that very series.
 *
 * Anything else is ignored. A file naming a series that is not in the batch
 * belongs to that series — "Bleach/series.json" dropped next to a Naruto
 * archive must never link Naruto to Bleach's AniList entry.
 */
function resolveSeriesTitle(
  entry: PendingSeriesFile,
  titlesByKey: Map<string, string>,
  volumesByUuid: Map<string, string>,
  pendingCount: number
): string | undefined {
  // Membership: an index can straddle two local series (a volume that this
  // batch stored under a variant title), so tally every owner and let the
  // file's own name break the tie before falling back to the majority.
  const ownerHits = new Map<string, number>();
  for (const indexed of entry.file.volumes) {
    const owner = volumesByUuid.get(indexed.volume_uuid);
    if (owner) ownerHits.set(owner, (ownerHits.get(owner) ?? 0) + 1);
  }
  if (ownerHits.size > 0) {
    const claimedKey = normalizeSeriesKey(sanitizeTitleSegment(entry.file.series_title));
    for (const owner of ownerHits.keys()) {
      if (normalizeSeriesKey(owner) === claimedKey) return owner;
    }
    return [...ownerHits.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }

  const named = titlesByKey.get(normalizeSeriesKey(sanitizeTitleSegment(entry.file.series_title)));
  if (named) return named;

  if (pendingCount === 1 && titlesByKey.size === 1) {
    const only = [...titlesByKey.values()][0];
    const claimed = normalizeSeriesKey(entry.file.series_title);
    if (!claimed || claimed === normalizeSeriesKey(only)) return only;
  }
  return undefined;
}

/**
 * Apply and drain the batch — the drain happens even when nothing could be
 * applied, so a batch never leaks into the next import. Facts merge through `upsertFromSeriesFile` (strictly
 * newer wins), and the file is cached in `series_index` so this device reports
 * the same index as the one that wrote it — even though every volume of the
 * batch is installed locally and needs nothing from it.
 */
export async function applyImportedSeriesFiles(): Promise<void> {
  const entries = pendingFiles.splice(0, pendingFiles.length);
  const titles = [...importedTitles];
  const volumesByUuid = new Map(importedVolumes);
  importedTitles.clear();
  importedVolumes.clear();
  if (entries.length === 0) return;

  const titlesByKey = new Map<string, string>();
  for (const title of titles) titlesByKey.set(normalizeSeriesKey(title), title);

  for (const entry of entries) {
    const seriesTitle = resolveSeriesTitle(entry, titlesByKey, volumesByUuid, entries.length);
    if (!seriesTitle) {
      console.warn(
        `[Import] Could not tell which series the ${SERIES_FILE_NAME} at '${entry.path}' belongs to; ignoring it`
      );
      continue;
    }

    try {
      const applied = await upsertFromSeriesFile(seriesTitle, entry.file);
      // An import is out of band: the cloud copy has never seen these facts and
      // no other path will publish them, so queue a write. No ping-pong risk —
      // this only fires for facts that actually landed, and the next read of the
      // same file applies nothing, so the exchange converges. (An offsets-only
      // file never reports `true` at all; its alignment rides the cached index
      // below.) The debounced writer still needs a writable cloud that already
      // holds the series.
      if (applied) scheduleSeriesFileWrite(seriesTitle);
      const key = normalizeSeriesKey(seriesTitle);
      // Merge over whatever is cached: an imported file only knows the volumes
      // of the library that exported it, so caching it as-is would drop the
      // entries a cloud fetch had already collected for this series.
      const cached = await getSeriesIndex(key);
      await putSeriesIndex({
        series_key: key,
        series_title: seriesTitle,
        file: mergeSeriesFileForCache(seriesTitle, entry.file, cached?.file),
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
