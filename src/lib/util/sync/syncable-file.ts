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

import { CATALOG_FILE_NAME, isCatalogFilePath } from '#lib/metadata/catalog-file.js';
import { SERIES_FILE_NAME, isSeriesFilePath } from '#lib/metadata/series-file.js';
import { GOALS_FILE_NAME } from '#lib/goals/goals-file.js';
import { compareCodePoints, foldName, splitAtDots } from '#lib/util/names/fold.js';
import { isHistoryFilePath } from '#lib/reading-history/paths.js';
import { POSITIONS_FILE_NAME } from '#lib/positions/positions-file.js';
import { isReservedLayerId } from '#lib/reader/edit/layer-names.js';

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

const SIDECAR_IMAGE_RE = /\.(webp|jpe?g)$/;

function basenameOf(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? '';
}

/**
 * Every predicate here reads names by their fold (fold v2, `$lib/util/names/fold`):
 * the library is case-insensitive and case-preserving on every host and store,
 * so `VOL 1.CBZ`, `Vol 1.cb\u{200B}z` and `Vol 1.cbz` are one name to the
 * reader exactly as they are one entry to Bunko (sidecar names rule 2, R1-R2,
 * R8).
 */
export function isCbzFile(basename: string): boolean {
  return foldName(basename).endsWith('.cbz');
}

export function isSidecarFile(basename: string): boolean {
  const folded = foldName(basename);
  return (
    folded.endsWith('.mokuro') ||
    folded.endsWith('.mokuro.gz') ||
    SIDECAR_IMAGE_RE.test(folded) ||
    // A fixed name, never a suffix match: `my-series.json` is not ours.
    folded === SERIES_FILE_NAME
  );
}

export function isRootConfigFile(basename: string): boolean {
  return ROOT_CONFIG_FILENAMES.has(foldName(basename));
}

export function syncMergesEveryCopy(basename: string): boolean {
  return MERGED_ACROSS_COPIES.has(foldName(basename));
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
 * stay OUT of {@link isSyncableFile} on purpose (pinned by tests). Like every
 * fixed name they are recognised by their fold (rule 2, R8): on every host
 * `.MOKURO-BUNKO.JSON` is the same entry as the marker.
 */
export const QUEUE_FILE_NAME = '.mokuro-queue.json';
export const BUNKO_MARKER_NAME = '.mokuro-bunko.json';

/** Is this basename one of Bunko's ROOT control files (R8: by its fold)? */
export function isBunkoControlFile(basename: string): boolean {
  const folded = foldName(basename);
  return folded === QUEUE_FILE_NAME || folded === BUNKO_MARKER_NAME;
}

/**
 * Bunko's per-series OCR queue file (queue file v2): `<Series>/` + this name,
 * one per series folder that owes OCR. A control file like the two above —
 * read by name (`readControlFile(name, { folder })`), never listed, so it stays
 * OUT of {@link isSyncableFile} — but it lives in a SERIES folder, so it is not
 * an {@link isBunkoControlFile} (that one names the root files only). The name
 * folds to neither root name, so a released reader's exact-name hooks stay
 * silent for it.
 */
export const SERIES_QUEUE_FILE_NAME = '.mokuro-series-queue.json';

/**
 * Is this basename the series queue file (R8: by its fold)? Two spellings of
 * one series folder are compared the same way: `foldName` on both (R1), so
 * `Example Saga/`, `example saga/` and an NFD spelling are one folder.
 */
export function isSeriesQueueFile(basename: string): boolean {
  return foldName(basename) === SERIES_QUEUE_FILE_NAME;
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
 * Sidecar names rule 2 — mokuro-bunko classifies with the same rule
 * (`bunko_core::sidecar_names`), and both run the vectors of its
 * `interop/contract/sidecar-names.json` (vendored in `$lib/interop/contract/`).
 * Rule 2 is rule v1 asked of F, fold v2 ({@link foldName}), of every listed
 * name. F keeps every dot, so each slice of a name (stem, suffix, id) is cut
 * at the same dot as its fold's ({@link splitAtDots}):
 * - R1: two names are one entry iff they fold alike.
 * - R2: the suffix is the first of `.cbz`, `.mokuro.gz`, `.mokuro`, `.webp`,
 *   `.nocover` the fold ends with; only `.cbz` archives define volume stems
 *   (the folds of their stems, {@link cbzStemsOf}); `.cbr`/`.zip`/`.rar` still
 *   keep a sweep off their files.
 * - R3: a `.mokuro[.gz]` whose folded base is a volume stem is its PRIMARY.
 * - R4: a primary reading wins over a layer reading of the same name.
 * - R5: otherwise `<s>.<id>` (split on the last dot) with `<s>` a volume stem
 *   and the FOLDED id matching {@link LAYER_ID_RE} is LAYER `<id>` of `<s>`,
 *   the id reported folded (`Vol 1.GCV.mokuro` is layer `gcv`, as Mokuro
 *   Reader 1.10.0 already read it); all-digit ids are layers. Otherwise an
 *   ORPHAN.
 * - R6: of the listed archives whose folded stem is `<s>`, the one spelled
 *   exactly like the file's stem, else the only one; in a fold group (two
 *   spellings of one fold listed) the code-point-smallest to read or show
 *   ({@link layerOwnerArchive}), exact spellings only to sweep, delete or
 *   rename ({@link sweepOwnerArchive}, {@link FolderNames.volumeFiles}).
 * - R7: a leading UTF-8 BOM is tolerated on read (the text decoder drops it),
 *   never written, and hashes cover the raw bytes.
 * - R8: fixed names (`series.json`, `catalog.json`, `volume-data.json`, the
 *   control files) are recognised by their fold.
 * - R9: a writer writes `<listed archive stem>.<id>.mokuro`, ids this reader
 *   mints lowercase ASCII with a letter (`slugifyLayerId`), onto the listed
 *   entry of the same fold rather than a new spelling
 *   (`resolveListedSpelling`).
 */
export const LAYER_ID_RE = /^[a-z0-9-]{1,32}$/;

/** The sidecar names rule this reader implements (`sidecar-names.json`'s `rule`). */
export const SIDECAR_RULE = 2;

export type MokuroSidecarClass =
  | { kind: 'primary'; stem: string; gz: boolean }
  /** `layerId` is FOLDED (R5); `stem` is spelled as in the name. */
  | { kind: 'layer'; stem: string; layerId: string; gz: boolean }
  | { kind: 'orphan' };

/** Archive extensions a volume can have; only `.cbz` defines stems (R2). */
const ARCHIVE_EXTENSIONS = ['.cbz', '.cbr', '.zip', '.rar'] as const;

/** A name and its fold before `suffix` (lowercase, dots included), when the fold ends with it. */
function stripFolded(name: string, suffix: string): { raw: string; fold: string } | null {
  if (!foldName(name).endsWith(suffix)) return null;
  const cut = splitAtDots(name, suffix.split('.').length - 1);
  return cut && { raw: cut.raw, fold: cut.fold };
}

/** `(raw base, folded base, gz)` of a `.mokuro[.gz]` name (R2: on the fold). */
function stripMokuroExtension(name: string): { base: string; fold: string; gz: boolean } | null {
  const gz = stripFolded(name, '.mokuro.gz');
  if (gz) return { base: gz.raw, fold: gz.fold, gz: true };
  const plain = stripFolded(name, '.mokuro');
  return plain && { base: plain.raw, fold: plain.fold, gz: false };
}

/**
 * `(raw stem, folded stem, folded id)` of a base `<stem>.<id>`, split on its
 * LAST dot, when the folded id is a layer id and the folded stem is not empty.
 */
function splitBase(raw: string, fold: string): { stem: string; fold: string; id: string } | null {
  const foldDot = fold.lastIndexOf('.');
  const rawDot = raw.lastIndexOf('.');
  if (foldDot <= 0 || rawDot < 0) return null;
  const id = fold.slice(foldDot + 1);
  if (!LAYER_ID_RE.test(id)) return null;
  return { stem: raw.slice(0, rawDot), fold: fold.slice(0, foldDot), id };
}

/** `Vol 1` for `Vol 1.cbz` (any spelling the fold reads as `.cbz`), else null. */
export function cbzStemOf(name: string): string | null {
  return stripFolded(name, '.cbz')?.raw ?? null;
}

/** Folded archive stems (`Vol 1.cbz` → `vol 1`) of a folder's basenames (R2). */
export function cbzStemsOf(basenames: Iterable<string>): Set<string> {
  const stems = new Set<string>();
  for (const name of basenames) {
    const folded = foldName(name);
    if (folded.endsWith('.cbz')) stems.add(folded.slice(0, -4));
  }
  return stems;
}

/**
 * Pure split of `<stem>.<id>.mokuro[.gz]`: the stem as written, the id FOLDED
 * (R5: `Vol 1.GCV.mokuro` is `{ stem: 'Vol 1', layerId: 'gcv' }`), null when the
 * folded last segment is no layer id (`Vol 1.mokuro`, `Vol 1.Bad_Id.mokuro`).
 * Says nothing about whether `<stem>` is a real volume: see the classifier.
 */
export function splitLayerSidecarName(
  basename: string
): { stem: string; layerId: string; gz: boolean } | null {
  const stripped = stripMokuroExtension(basename);
  if (!stripped) return null;
  const split = splitBase(stripped.base, stripped.fold);
  return split && { stem: split.stem, layerId: split.id, gz: stripped.gz };
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
 * Rule 2's reading of one `.mokuro[.gz]` (R3-R5): raw and folded stem, the
 * folded id (`null` for a primary), gz.
 */
function readSidecar(
  basename: string,
  cbzStems: ReadonlySet<string>
): { stem: string; fold: string; id: string | null; gz: boolean } | null {
  const stripped = stripMokuroExtension(basename);
  if (!stripped) return null;
  if (cbzStems.has(stripped.fold)) {
    return { stem: stripped.base, fold: stripped.fold, id: null, gz: stripped.gz };
  }
  const split = splitBase(stripped.base, stripped.fold);
  if (!split || !cbzStems.has(split.fold)) return null;
  return { stem: split.stem, fold: split.fold, id: split.id, gz: stripped.gz };
}

/**
 * What a listed `.mokuro` IS, given the archives listed in the same folder
 * (R3-R5): its archive's PRIMARY, a LAYER (folded id) of an archive, or an
 * ORPHAN, ignored exactly as an unmatched `.mokuro` always was. `cbzStems` come
 * from {@link cbzStemsOf} (folded). The stem is spelled as in the name; which
 * listed archive it is (R6) is {@link layerOwnerArchive}'s question.
 */
export function classifyMokuroSidecar(
  basename: string,
  cbzStems: ReadonlySet<string>
): MokuroSidecarClass {
  const read = readSidecar(basename, cbzStems);
  if (!read) return { kind: 'orphan' };
  if (read.id === null) return { kind: 'primary', stem: read.stem, gz: read.gz };
  return { kind: 'layer', stem: read.stem, layerId: read.id, gz: read.gz };
}

/**
 * The archive a volume file whose stem is `stem` is read and shown with (R6),
 * among a folder's archive stems AS SPELLED (`Vol 3` of `Vol 3.cbz`): the
 * archive spelled exactly like the stem, else the only one that folds alike,
 * else (a fold group: two spellings of one fold listed) the code-point-smallest
 * of those — never UTF-16 order, so every device and Bunko pick the same one.
 * Undefined when no archive folds alike. What a sweep may take is stricter:
 * {@link sweepOwnerArchive}.
 */
export function layerOwnerArchive(
  stem: string,
  archiveStems: Iterable<string>
): string | undefined {
  const folded = foldName(stem);
  let best: string | undefined;
  for (const archive of archiveStems) {
    if (archive === stem) return archive;
    if (foldName(archive) !== folded) continue;
    if (best === undefined || compareCodePoints(archive, best) < 0) best = archive;
  }
  return best;
}

/** One file of a volume, as {@link FolderNames.volumeFiles} finds it; a layer's id is folded. */
export type VolumeFileKind =
  | { kind: 'primary'; gz: boolean }
  | { kind: 'cover' }
  | { kind: 'nocover' }
  | { kind: 'layer'; layerId: string; gz: boolean };

interface ListedName {
  raw: string;
  fold: string;
}

/**
 * A folder listing prepared once for every archive in it, mirroring Bunko's
 * `sidecar_names::Folder`: every name folded once, the archive stems, and how
 * many spellings fold to each.
 */
export class FolderNames {
  private readonly names: ListedName[];
  /** Folded stems of every archive of {@link ARCHIVE_EXTENSIONS}, with how many spellings fold to each. */
  private readonly stemSpellings = new Map<string, number>();
  /** The listed `.cbz` archives: name, raw stem, folded stem. */
  private readonly cbz: Array<{ name: string; stem: string; fold: string }> = [];
  /** The folds of the listed `.cbz` stems ({@link cbzStemsOf}). */
  readonly stems: ReadonlySet<string>;

  constructor(basenames: Iterable<string>) {
    this.names = [...basenames].map((raw) => ({ raw, fold: foldName(raw) }));
    const exact = new Set<string>();
    for (const { raw } of this.names) {
      for (const ext of ARCHIVE_EXTENSIONS) {
        const cut = stripFolded(raw, ext);
        if (!cut) continue;
        if (!exact.has(cut.raw)) {
          exact.add(cut.raw);
          this.stemSpellings.set(cut.fold, (this.stemSpellings.get(cut.fold) ?? 0) + 1);
        }
        if (ext === '.cbz') this.cbz.push({ name: raw, stem: cut.raw, fold: cut.fold });
        break;
      }
    }
    this.stems = new Set(this.cbz.map(({ fold }) => fold));
  }

  /** The listed `.cbz` archives' stems as spelled. */
  archiveStems(): string[] {
    return this.cbz.map(({ stem }) => stem);
  }

  /**
   * The listed files that belong to the archive `cbzName`: its primary, cover,
   * no-cover marker and layers, in listing order. Stricter than
   * {@link classifyMokuroSidecar}, because what it returns may be deleted (R6):
   * - a stem matches exactly, or by its fold only when that archive is the one
   *   listed of its folded stem (beside `Vol 01.cbz` and `VOL 01.cbz`,
   *   `vol 01.mokuro` is neither's);
   * - a name whose base is any archive's stem (`.cbz`, `.cbr`, `.zip`, `.rar`)
   *   is never a layer here (`Vol 01.5.mokuro` beside `Vol 01.5.zip`).
   */
  volumeFiles(cbzName: string): Array<{ name: string; file: VolumeFileKind }> {
    const anchor = stripFolded(cbzName, '.cbz');
    if (!anchor) return [];
    const out: Array<{ name: string; file: VolumeFileKind }> = [];
    for (const name of this.names) {
      const file = this.fileOf(anchor, name.raw);
      if (file) out.push({ name: name.raw, file });
    }
    return out;
  }

  private fileOf(anchor: { raw: string; fold: string }, name: string): VolumeFileKind | null {
    const alone = (this.stemSpellings.get(anchor.fold) ?? 0) <= 1;
    const owns = (raw: string, fold: string) =>
      fold === anchor.fold && (raw === anchor.raw || alone);
    let cut: { raw: string; fold: string } | null;
    let file: VolumeFileKind;
    const mokuro = stripMokuroExtension(name);
    if (mokuro) {
      cut = { raw: mokuro.base, fold: mokuro.fold };
      file = { kind: 'primary', gz: mokuro.gz };
    } else if ((cut = stripFolded(name, '.webp'))) {
      file = { kind: 'cover' };
    } else if ((cut = stripFolded(name, '.nocover'))) {
      file = { kind: 'nocover' };
    } else {
      return null;
    }
    if (owns(cut.raw, cut.fold)) return file;
    if (file.kind !== 'primary' || this.stemSpellings.has(cut.fold)) return null;
    const split = splitBase(cut.raw, cut.fold);
    if (!split || !owns(split.stem, split.fold)) return null;
    return { kind: 'layer', layerId: split.id, gz: file.gz };
  }

  /** The names that go when `cbzName` goes (a delete or a rename's sweep). */
  sweepSet(cbzName: string): string[] {
    return this.volumeFiles(cbzName).map(({ name }) => name);
  }

  /**
   * The archive (its listed `.cbz` name) a volume file `name` — a `.mokuro`,
   * layer, cover or no-cover marker — is read and shown with (R6): exact, else
   * the only one, else the code-point-smallest of the fold group.
   */
  displayArchive(name: string): string | undefined {
    const owner = this.ownerStem(name);
    if (!owner) return undefined;
    const found = this.cbz.filter(({ fold }) => fold === owner.fold);
    const exact = found.find(({ stem }) => stem === owner.stem);
    if (exact) return exact.name;
    let best: string | undefined;
    for (const { name: archive } of found) {
      if (best === undefined || compareCodePoints(archive, best) < 0) best = archive;
    }
    return best;
  }

  /**
   * The archive (its listed `.cbz` name) whose sweep (delete, rename) takes the
   * volume file `name` (R6): exact spellings only in a fold group; undefined
   * when no archive's sweep takes it.
   */
  sweepArchive(name: string): string | undefined {
    return this.cbz.find(({ stem, fold }) => this.fileOf({ raw: stem, fold }, name) !== null)?.name;
  }

  private ownerStem(name: string): { stem: string; fold: string } | null {
    const read = readSidecar(name, this.stems);
    if (read) return { stem: read.stem, fold: read.fold };
    for (const suffix of ['.webp', '.nocover']) {
      const cut = stripFolded(name, suffix);
      if (cut) return this.stems.has(cut.fold) ? { stem: cut.raw, fold: cut.fold } : null;
    }
    return null;
  }
}

/**
 * The archive stem (as spelled in `archiveNames`, a folder's listed basenames)
 * whose sweep — a delete or a rename of that volume — may take the volume file
 * `name` (R6): the exact spelling, else the only archive of that fold, else none
 * (a fold group takes only exact spellings, so a variant's file never leaves
 * with another archive). The cloud-stamp corroboration before a layer delete
 * still applies on top.
 */
export function sweepOwnerArchive(name: string, folderNames: Iterable<string>): string | undefined {
  const archive = new FolderNames(folderNames).sweepArchive(name);
  return archive === undefined ? undefined : (cbzStemOf(archive) ?? undefined);
}

export function layerSidecarName(volumeTitle: string, layerId: string): string {
  return `${volumeTitle}.${layerId}.mokuro`;
}
