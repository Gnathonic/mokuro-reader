/**
 * The single source of truth for which files sync providers list and cache.
 * Shared by ALL five providers — do not fork per-provider copies again.
 *
 * Categories:
 * - CBZ archives (the volumes themselves)
 * - Sidecars: OCR data (.mokuro / .mokuro.gz), thumbnails (.webp/.jpg/.jpeg)
 *   and the per-series index `<Series Title>/series.json`
 * - Root config files: volume-data.json (read progress + series-level reading
 *   state), profiles.json (settings profiles) and goals.json (reading goals,
 *   closed-period snapshots and per-volume deadlines), positions.json (the
 *   newest reading position per volume, at a fixed address), plus catalog.json
 *   (the compiled library index)
 *
 * `series.json` is a sidecar of the SERIES FOLDER, not of a volume: it is the
 * only sidecar whose basename does not start with a volume title, so anything
 * pairing sidecars to volumes by `<Series>/<Volume>.<ext>` (the cloud manager's
 * managed-file matcher, the placeholder generator) skips it by construction.
 *
 * libraries.json is deliberately NOT listed: it belonged to the removed
 * libraries feature. Stale copies may still exist in users' cloud folders —
 * keep ignoring them.
 */

import { CATALOG_FILE_NAME, isCatalogFilePath } from '$lib/metadata/catalog-file';
import { SERIES_FILE_NAME, isSeriesFilePath } from '$lib/metadata/series-file';
import { GOALS_FILE_NAME } from '$lib/goals/goals-file';
import { naturalSort } from '$lib/util/natural-sort';
import { isHistoryFilePath } from '$lib/reading-history/paths';
import { POSITIONS_FILE_NAME } from '$lib/positions/positions-file';
import { isReservedLayerId } from '$lib/reader/edit/layer-names';

const ROOT_CONFIG_FILENAMES = new Set([
  'volume-data.json',
  'profiles.json',
  GOALS_FILE_NAME,
  CATALOG_FILE_NAME,
  // The fast position index: the user's own state like goals.json, not best-effort.
  POSITIONS_FILE_NAME
]);

/**
 * Root files whose sync downloads EVERY listed copy and folds them into one
 * (`downloadVolumeDataFile`, `downloadGoalsFile`, positions sync's `runSync`),
 * so two copies converge losslessly at the next sync — the folder dedup keeps
 * both instead of trashing one. profiles.json is not one: sync reads one copy.
 */
const MERGED_ACROSS_COPIES = new Set(['volume-data.json', GOALS_FILE_NAME, POSITIONS_FILE_NAME]);

// series-metadata.json is deliberately NOT listed: it was retired on 2026-08-23
// before ever shipping (facts moved to <Series>/series.json, reading state to
// volume-data.json's `series` section). A stale copy may still sit in a folder
// somebody synced from a dev build — keep ignoring it, exactly like libraries.json.

const SIDECAR_IMAGE_RE = /\.(webp|jpe?g)$/i;

function basenameOf(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? '';
}

export function isCbzFile(basename: string): boolean {
  return basename.toLowerCase().endsWith('.cbz');
}

export function isSidecarFile(basename: string): boolean {
  const lower = basename.toLowerCase();
  return (
    lower.endsWith('.mokuro') ||
    lower.endsWith('.mokuro.gz') ||
    SIDECAR_IMAGE_RE.test(lower) ||
    // Exact basename, never a suffix match: `my-series.json` is not ours.
    lower === SERIES_FILE_NAME
  );
}

export function isRootConfigFile(basename: string): boolean {
  return ROOT_CONFIG_FILENAMES.has(basename.toLowerCase());
}

export function syncMergesEveryCopy(basename: string): boolean {
  return MERGED_ACROSS_COPIES.has(basename.toLowerCase());
}

/**
 * Must a folder merge keep EVERY copy of this file rather than trash the older?
 * Sync folds every copy of the merged root files into one, and Bunko reads
 * every copy of its control files (newest wins there, not here): two bunko
 * roots each hold their own marker and queue, and trashing one by write time
 * could drop the live lease or queued work.
 */
export function dedupKeepsEveryCopy(basename: string): boolean {
  return syncMergesEveryCopy(basename) || isBunkoControlFile(basename);
}

/**
 * The two CONTROL files a cloud-direct mokuro-bunko keeps at the library root
 * (`mokuro-reader/`): its OCR queue and its liveness marker / lease. They are
 * read directly by name (`SyncProvider.readControlFile`), never listed: neither
 * is a volume, a sidecar or a root config, and putting them in the listing
 * would feed them to the listing caches, the sync diff and the managed-file
 * matcher — some of which would try to download, move or delete them. So they
 * stay OUT of {@link isSyncableFile} on purpose (pinned by tests). Names are
 * exact (case-sensitive), like every other root file the reader owns.
 */
export const QUEUE_FILE_NAME = '.mokuro-queue.json';
export const BUNKO_MARKER_NAME = '.mokuro-bunko.json';

/** Is this basename one of Bunko's control files? */
export function isBunkoControlFile(basename: string): boolean {
  return basename === QUEUE_FILE_NAME || basename === BUNKO_MARKER_NAME;
}

/**
 * Pass the path RELATIVE to the mokuro folder, not a bare basename: reading
 * history (`history/<device>/<file>`) is recognised by its full path.
 */
export function isSyncableFile(path: string): boolean {
  const basename = basenameOf(path);
  return (
    isCbzFile(basename) ||
    isSidecarFile(basename) ||
    isRootConfigFile(basename) ||
    isHistoryFilePath(path)
  );
}

/**
 * Is this path one of the COMPILED metadata files — `<Series>/series.json` or
 * the root `catalog.json`?
 *
 * Writing them is best-effort by contract: on a bunko-backed library the server
 * compiles both, a scoped user's `catalog.json` PUT is rejected outright and a
 * `series.json` PUT is an update *request*. A rejection there says nothing about
 * whether the account can write progress or upload archives, so it must never
 * demote the provider to read-only, never clear stored credentials and never
 * surface UI. Progress (`volume-data.json`) and profiles are deliberately NOT
 * in this set: those are the user's own state, and a silent failure there
 * really is a problem worth surfacing.
 *
 * `catalog.json` only counts at the ROOT — a nested one is somebody else's file.
 *
 * `goals.json` is deliberately NOT here either: no server compiles a user's
 * personal reading goals, so there is nothing for a server to reject by design.
 * It is the user's own state, like progress and profiles, and a silently
 * dropped write there is data loss they never learn about.
 *
 * Reading-history segments (`history/<device>/…`) are best-effort too: they
 * are this device's copy of data it keeps locally and re-uploads on the next
 * sync. A rejection (a bunko server that does not map `history/` per-user yet,
 * a read-only share) must not demote the provider.
 */
export function isBestEffortMetadataPath(path: string): boolean {
  return isSeriesFilePath(path) || isCatalogFilePath(path) || isHistoryFilePath(path);
}

/**
 * Alternate OCR layers ride beside a volume as `<Volume Title>.<layer-id>.mokuro`
 * (optionally `.gz`) — the SAME shape mokuro-bunko's multi-engine OCR writes
 * (`Volume 01.paddle-manga.mokuro`), so an engine's output and a reader-made
 * layer are one thing. `layer-id` is a slug of `[a-z0-9-]` and IS the row's
 * `layer_id`.
 *
 * A bare filename cannot say whether `Vol 1.5.mokuro` is the primary of
 * `Vol 1.5.cbz` or layer `5` of `Vol 1.cbz`: {@link classifyMokuroSidecar}
 * decides by ARCHIVE PRESENCE in the same folder listing, and every site that
 * pairs a `.mokuro` with a volume must go through it. {@link splitLayerSidecarName}
 * is the listing-free split for a file arriving on its own (an import, an
 * export name round-trip), where the caller matches the stem itself.
 *
 * Sidecar names rule v1 — mokuro-bunko classifies with the same rule
 * (`bunko_core::sidecar_names`), so a file is the same thing on both sides:
 * 1. `.cbz`, `.mokuro` and `.mokuro.gz` match in any ASCII case;
 * 2. only `.cbz` archives define volume stems;
 * 3. stems compare folded, NFC then lowercase ({@link foldStem});
 * 4. a primary reading wins over a layer reading of the same name;
 * 5. the id must match {@link LAYER_ID_RE} AS WRITTEN — `Vol 1.GCV.mokuro` is
 *    an orphan, never layer `gcv` nor a primary ({@link miscasedLayerStem}) —
 *    and an all-digit id is a valid id;
 * 6. a sweep takes a layer with the archive spelled exactly like its stem
 *    before one that merely folds alike (`unified-cloud-manager.ts`);
 * 7. a leading UTF-8 BOM is tolerated on read (the text decoder drops it),
 *    never written, and hashes cover the raw bytes;
 * 8. ids this reader mints always contain a letter (`slugifyLayerId`).
 */
export const LAYER_ID_RE = /^[a-z0-9-]{1,32}$/;

export type MokuroSidecarClass =
  | { kind: 'primary'; stem: string; gz: boolean }
  | { kind: 'layer'; stem: string; layerId: string; gz: boolean }
  | { kind: 'orphan' };

function stripMokuroExtension(basename: string): { base: string; gz: boolean } | null {
  const lower = basename.toLowerCase();
  if (lower.endsWith('.mokuro.gz')) return { base: basename.slice(0, -10), gz: true };
  if (lower.endsWith('.mokuro')) return { base: basename.slice(0, -7), gz: false };
  return null;
}

/**
 * A volume stem as rule v1 compares it: NFC, then lowercase. A filename that
 * went through a decomposing filesystem (NFD) is still the same volume.
 */
export function foldStem(stem: string): string {
  return stem.normalize('NFC').toLowerCase();
}

/** Folded archive stems (`Vol 1.cbz` → `vol 1`) of a folder's basenames. */
export function cbzStemsOf(basenames: Iterable<string>): Set<string> {
  const stems = new Set<string>();
  for (const name of basenames) {
    if (isCbzFile(name)) stems.add(foldStem(name.slice(0, -4)));
  }
  return stems;
}

/**
 * Pure split of `<stem>.<id>.mokuro[.gz]` — null when the file has no dot
 * segment that is a valid layer id (`Vol 1.mokuro`, `Vol 1.Bad_Id.mokuro`).
 * Says nothing about whether `<stem>` is a real volume: see the classifier.
 */
export function splitLayerSidecarName(
  basename: string
): { stem: string; layerId: string; gz: boolean } | null {
  const stripped = stripMokuroExtension(basename);
  if (!stripped) return null;
  const dot = stripped.base.lastIndexOf('.');
  if (dot <= 0) return null;
  const stem = stripped.base.slice(0, dot);
  // As written: lowercasing here made `Vol 1.GCV.mokuro` a layer for this
  // reader and an orphan for bunko.
  const layerId = stripped.base.slice(dot + 1);
  if (!LAYER_ID_RE.test(layerId)) return null;
  return { stem, layerId, gz: stripped.gz };
}

/**
 * Is `path` a layer file whose id is reserved (`isReservedLayerId`)? bunko
 * refuses a write of some of those by design — a case merge's `curated-<n>`,
 * the `curated` layer to an account without the rights, a shared `edit` — so a
 * 403 there says nothing about the account's other writes (`webdav-provider`
 * keeps the provider read-write). Listing-free, so `Vol 1.edit.mokuro` counts
 * even when it is the primary of a volume titled `Vol 1.edit`.
 */
export function isReservedLayerSidecarPath(path: string): boolean {
  const split = splitLayerSidecarName(path.split('/').pop() ?? path);
  return !!split && isReservedLayerId(split.layerId);
}

/**
 * The stem of `<stem>.<ID>.mokuro[.gz]` whose id is a layer id but for its
 * case (`Vol 1.GCV.mokuro` → `Vol 1`), else null. Rule v1 makes such a file an
 * ORPHAN of `<stem>` — not a layer, and not its primary either — so a pass
 * that takes "any other `.mokuro`" as the primary must skip it, or it can
 * outrank the real `Vol 1.mokuro`. This reader used to file it as layer `gcv`.
 */
export function miscasedLayerStem(basename: string): string | null {
  const stripped = stripMokuroExtension(basename);
  if (!stripped) return null;
  const dot = stripped.base.lastIndexOf('.');
  if (dot <= 0) return null;
  const id = stripped.base.slice(dot + 1);
  if (LAYER_ID_RE.test(id) || !LAYER_ID_RE.test(id.toLowerCase())) return null;
  return stripped.base.slice(0, dot);
}

/**
 * What a listed `.mokuro` IS, given the archives listed in the same folder:
 * 1. `<full base>.cbz` present → that volume's PRIMARY sidecar;
 * 2. else `<stem>.<id>` with `<stem>.cbz` present and a valid id → LAYER `<id>`
 *    of `<stem>`;
 * 3. else an ORPHAN, ignored exactly as an unmatched `.mokuro` always was.
 * `cbzStems` come from {@link cbzStemsOf} (folded).
 */
export function classifyMokuroSidecar(
  basename: string,
  cbzStems: ReadonlySet<string>
): MokuroSidecarClass {
  const stripped = stripMokuroExtension(basename);
  if (!stripped) return { kind: 'orphan' };
  if (cbzStems.has(foldStem(stripped.base))) {
    return { kind: 'primary', stem: stripped.base, gz: stripped.gz };
  }
  const split = splitLayerSidecarName(basename);
  if (split && cbzStems.has(foldStem(split.stem))) {
    return { kind: 'layer', stem: split.stem, layerId: split.layerId, gz: split.gz };
  }
  return { kind: 'orphan' };
}

/**
 * The archive that OWNS a layer file whose stem is `layerStem`, among a
 * folder's archive stems AS SPELLED (`Vol 3` of `Vol 3.cbz`): the archive
 * spelled exactly like the stem, else the `naturalSort`-first of those that
 * fold alike (rule v1 #6). Two archives that fold alike are two volumes, and a
 * layer spelled like neither (`vol 3.hayai.mokuro` beside `Vol 3.cbz` and
 * `VOL 3.cbz`) must have ONE owner on every site, whatever order the listing
 * came in — else layer sync files it under one volume and a rename or delete
 * of the other sweeps it. Undefined when no archive folds alike (not a layer).
 */
export function layerOwnerArchive(
  layerStem: string,
  archiveStems: Iterable<string>
): string | undefined {
  const folded = foldStem(layerStem);
  let best: string | undefined;
  for (const archive of archiveStems) {
    if (archive === layerStem) return archive;
    if (foldStem(archive) !== folded) continue;
    if (best === undefined || naturalSort(archive, best) < 0) best = archive;
  }
  return best;
}

export function layerSidecarName(volumeTitle: string, layerId: string): string {
  return `${volumeTitle}.${layerId}.mokuro`;
}
