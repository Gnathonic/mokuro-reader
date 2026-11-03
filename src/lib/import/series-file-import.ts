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
import { normalizeSeriesKey, normalizeVolumeTitleKey } from '$lib/metadata/series-key';
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
  /**
   * Set when a LINK brought the file (`LinkSeriesGuard`). Absent for files the
   * user picked or dropped themselves.
   */
  linkGuard?: LinkSeriesGuard;
}

/**
 * What keeps a LINK's `series.json` to the series that link brought. A link's
 * server is whoever made the link; it may name a new series, but it does not
 * get to rewrite the AniList link or titles of one the user already has — and
 * so, through the write this would queue, the user's own cloud copy — unseen.
 *
 * A link's files are therefore applied apart from the rest of the batch
 * (`applyImportedSeriesFiles`): keyed only by the titles THAT import stored
 * volumes under, and refused for every series the library holds at apply time
 * that the link did not create itself — read again then, not just at the
 * link's turn, since another import (or a sync, or a cloud download) may have
 * added the very series the file names while the link's archives were still
 * in the queue.
 *
 * "Created by the link" is observed, never inferred: just before the link's
 * import first saves a volume under a series, the library is read again
 * (`noteLinkSeriesBeforeSave`), and only a series absent at that moment is the
 * link's. Whatever path wrote the series first — another import, a download,
 * a sync — the read sees it.
 */
export interface LinkSeriesGuard {
  /** The link's import (`PairedSource.batch`); archives nested in it share it. */
  batch: number;
  /**
   * Series already in the library when the link had its import turn
   * (`protectedSeriesKey`), minus any the user agreed in the import
   * confirmation to let it update.
   */
  protectedKeys: ReadonlySet<string>;
  /** The same read, again: the library's series now, minus the agreed one. */
  refresh: () => Promise<ReadonlySet<string>>;
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

/**
 * The fold a protected series is recorded and looked up by: the catalog's
 * grouping fold plus unicode composition (`normalizeVolumeTitleKey`, the fold
 * `series_metadata.folded_key` and the cloud folder match use), so a link that
 * spells a series decomposed (NFD) still finds the composed one the user has.
 */
export function protectedSeriesKey(title: string): string {
  return normalizeVolumeTitleKey(title);
}

/**
 * Collect a `series.json` extracted from an archive. Never throws.
 *
 * @param linkGuard the archive's guard, when a LINK brought it
 *   (`PairedSource.seriesGuard`): a file inside a deep-linked archive is just
 *   as much the link's as one its manifest listed.
 */
export function collectSeriesFileFromBytes(
  path: string,
  data: ArrayBuffer,
  lastModified: number,
  linkGuard?: LinkSeriesGuard
): void {
  let text: string;
  try {
    text = new TextDecoder().decode(data);
  } catch (error) {
    console.warn(`[Import] Could not read the ${SERIES_FILE_NAME} at '${path}':`, error);
    return;
  }
  const parsed = parseImportedSeriesFile(path, text, data.byteLength, lastModified);
  if (parsed) recordSeriesFile(linkGuard ? { ...parsed, linkGuard } : parsed);
}

// The batch: everything collected since the last apply. Module state rather
// than a threaded argument because a `series.json` is found while an archive is
// being scanned, several layers below the call that knows the import is done.
const pendingFiles: PendingSeriesFile[] = [];
const importedTitles = new Set<string>();
/** volume_uuid → the series title that volume was stored under. */
const importedVolumes = new Map<string, string>();
/** Per import (`PairedSource.batch`): the titles its volumes were stored under. */
const titlesByImport = new Map<number, Set<string>>();
/** Per import: volume_uuid → series title, as `importedVolumes`. */
const volumesByImport = new Map<number, Map<string, string>>();
/**
 * Per link (`LinkSeriesGuard.batch`): the series keys its import has saved a
 * volume under (`checked`), and those of them that were absent from the
 * library just before that first save (`created`) — the only series a link's
 * file may land on unasked.
 *
 * NOT drained with the batch: a link's archives can outlive an apply, and the
 * record of what it created is a fact about the save, not about the batch it
 * happened in. A link's entry goes once its files are applied or dropped
 * (`forgetLinkSeries`). Losing an entry early can only ever refuse a file —
 * the next save re-reads the library and finds the series there — never let
 * one through.
 */
const linkSeries = new Map<number, { checked: Set<string>; created: Set<string> }>();

export function recordSeriesFile(entry: PendingSeriesFile): void {
  pendingFiles.push(entry);
}

/**
 * Forget the files a LINK's import recorded, unapplied: the import failed or
 * imported nothing, so its `series.json` has no series of its own to describe
 * — left in the batch, it would wait for whatever the next import stores.
 */
export function dropLinkSeriesFiles(batch: number): void {
  for (let i = pendingFiles.length - 1; i >= 0; i--) {
    if (pendingFiles[i].linkGuard?.batch === batch) pendingFiles.splice(i, 1);
  }
  linkSeries.delete(batch);
}

/**
 * Call just BEFORE a link's import saves a volume under `seriesTitle` (the
 * title it will be stored under, `storedTitleSegment`). The first time that
 * link saves under a series, the library is read again: a series that is not
 * there yet is one the link creates, so its file may describe it. One the
 * library already holds — whoever put it there, and whenever — stays the
 * user's. A failed read creates nothing (the file is then refused); it never
 * fails the import.
 */
export async function noteLinkSeriesBeforeSave(
  guard: LinkSeriesGuard,
  seriesTitle: string
): Promise<void> {
  if (!seriesTitle) return;
  const key = protectedSeriesKey(seriesTitle);
  let entry = linkSeries.get(guard.batch);
  if (!entry) linkSeries.set(guard.batch, (entry = { checked: new Set(), created: new Set() }));
  if (entry.checked.has(key)) return;
  // Claimed before the read: a second save under the same key never gets a
  // second, later look that a volume of this very link would answer.
  entry.checked.add(key);
  try {
    const present = await guard.refresh();
    if (!present.has(key) && !guard.protectedKeys.has(key)) entry.created.add(key);
  } catch (error) {
    console.warn(
      `[Import] Could not read the library before a link saved into '${seriesTitle}'; its ${SERIES_FILE_NAME} will not apply there`,
      error
    );
  }
}

/**
 * The series title a volume of this batch was actually stored under, with that
 * volume's uuid when the caller knows it — the uuid is what lets a sidecar be
 * matched to its series by index membership rather than by its (possibly
 * stale) `series_title` — and the import (`PairedSource.batch`) that stored it,
 * which is what a link's file is keyed by (`LinkSeriesGuard`).
 */
export function recordImportedSeriesTitle(
  seriesTitle: string,
  volumeUuid?: string,
  batch?: number
): void {
  if (!seriesTitle) return;
  importedTitles.add(seriesTitle);
  if (volumeUuid) importedVolumes.set(volumeUuid, seriesTitle);
  if (batch === undefined) return;
  let titles = titlesByImport.get(batch);
  if (!titles) titlesByImport.set(batch, (titles = new Set()));
  titles.add(seriesTitle);
  if (volumeUuid) {
    let volumes = volumesByImport.get(batch);
    if (!volumes) volumesByImport.set(batch, (volumes = new Map()));
    volumes.set(volumeUuid, seriesTitle);
  }
}

/** Forget the batch without applying it (tests, cancelled imports). */
export function resetImportedSeriesFiles(): void {
  pendingFiles.length = 0;
  importedTitles.clear();
  importedVolumes.clear();
  titlesByImport.clear();
  volumesByImport.clear();
  linkSeries.clear();
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

/** The series key → title map `resolveSeriesTitle` looks titles up in. */
function keyTitles(titles: Iterable<string>): Map<string, string> {
  const byKey = new Map<string, string>();
  for (const title of titles) byKey.set(normalizeSeriesKey(title), title);
  return byKey;
}

/**
 * Apply and drain the batch — the drain happens even when nothing could be
 * applied, so a batch never leaks into the next import. Facts merge through `upsertFromSeriesFile` (strictly
 * newer wins), and the file is cached in `series_index` so this device reports
 * the same index as the one that wrote it — even though every volume of the
 * batch is installed locally and needs nothing from it.
 *
 * The files the user brought are keyed against every title of the batch. A
 * LINK's files (`LinkSeriesGuard`) are keyed per link, against only the titles
 * that link's own import stored volumes under, and never applied to a series
 * the library holds now that the link did not create.
 */
export async function applyImportedSeriesFiles(): Promise<void> {
  const entries = pendingFiles.splice(0, pendingFiles.length);
  const titles = [...importedTitles];
  const volumesByUuid = new Map(importedVolumes);
  const importTitles = new Map(titlesByImport);
  const importVolumes = new Map(volumesByImport);
  importedTitles.clear();
  importedVolumes.clear();
  titlesByImport.clear();
  volumesByImport.clear();
  if (entries.length === 0) return;

  const own = entries.filter((entry) => !entry.linkGuard);
  const titlesByKey = keyTitles(titles);
  for (const entry of own) {
    const seriesTitle = resolveSeriesTitle(entry, titlesByKey, volumesByUuid, own.length);
    if (seriesTitle) await applySeriesFile(entry, seriesTitle);
    else warnUnkeyed(entry);
  }

  const byLink = new Map<number, PendingSeriesFile[]>();
  for (const entry of entries) {
    if (!entry.linkGuard) continue;
    const group = byLink.get(entry.linkGuard.batch);
    if (group) group.push(entry);
    else byLink.set(entry.linkGuard.batch, [entry]);
  }
  for (const [batch, group] of byLink) {
    const guard = group[0].linkGuard!;
    const linkTitles = importTitles.get(batch) ?? new Set<string>();
    const created = linkSeries.get(batch)?.created ?? new Set<string>();
    // Applied or refused below, either way this link's files are settled.
    linkSeries.delete(batch);
    let protectedKeys: Set<string>;
    try {
      protectedKeys = new Set([...guard.protectedKeys, ...(await guard.refresh())]);
    } catch (error) {
      // No guard, no apply: the file would be free to land on any series.
      console.warn(
        `[Import] Not applying a link's ${SERIES_FILE_NAME}: could not read the library`,
        error
      );
      continue;
    }
    // The series this link created: absent from the library just before the
    // link first saved a volume there (`noteLinkSeriesBeforeSave`).
    for (const key of created) protectedKeys.delete(key);
    const linkTitlesByKey = keyTitles(linkTitles);
    const linkVolumes = importVolumes.get(batch) ?? new Map<string, string>();
    for (const entry of group) {
      const seriesTitle = resolveSeriesTitle(entry, linkTitlesByKey, linkVolumes, group.length);
      if (!seriesTitle) {
        warnUnkeyed(entry);
        continue;
      }
      if (protectedKeys.has(protectedSeriesKey(seriesTitle))) {
        // Neither the facts nor the cached index: both would reach this series.
        console.info(
          `[Import] Not applying the ${SERIES_FILE_NAME} at '${entry.path}' to '${seriesTitle}': that series was already in the library and the import did not allow changing it`
        );
        continue;
      }
      await applySeriesFile(entry, seriesTitle);
    }
  }
}

function warnUnkeyed(entry: PendingSeriesFile): void {
  console.warn(
    `[Import] Could not tell which series the ${SERIES_FILE_NAME} at '${entry.path}' belongs to; ignoring it`
  );
}

/** Apply one keyed file: its facts, a cloud write for them, the cached index. */
async function applySeriesFile(entry: PendingSeriesFile, seriesTitle: string): Promise<void> {
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
