/**
 * The archives of the OTHER extensions (`.cbr`, `.zip`, `.rar`) the provider
 * listings saw and dropped.
 *
 * The reader syncs only `.cbz` volumes, so no listing carries these files
 * (`isSyncableFile`): a series delete or rename must never touch a volume the
 * reader does not even show. But sidecar names rule 2 (R2) says every archive
 * extension keeps a SWEEP off its files: beside `Vol 01.cbz` and `Vol 01.5.zip`
 * (a Bunko library OCRs both), `Vol 01.5.mokuro` reads as layer `5` of `Vol 01`
 * yet is the `.zip` volume's main, and deleting `Vol 01` must leave it. The
 * sweep ({@link FolderNames.sweepSet}) can only honour that when it is given
 * the `.zip`'s name, so each listing notes the foreign archives it passes over
 * here, and the sweep adds them to the folder's names.
 *
 * Add-only, on purpose. A name only ever takes files OUT of a sweep (it adds a
 * stem; it never makes one alone), so a stale entry — a `.zip` deleted since —
 * can at worst leave a sidecar behind under its old name: nothing is lost.
 * Missing one would delete another volume's OCR.
 */
import { foldName } from '#lib/util/names/fold.js';

/** The archive extensions that are no `.cbz` (rule 2's other `ARCHIVE_EXTENSIONS`). */
const FOREIGN_ARCHIVE_EXTENSIONS = ['.cbr', '.zip', '.rar'] as const;

/** provider → folded parent folder → raw basenames. */
const seen = new Map<string, Map<string, Set<string>>>();

function split(path: string): { parent: string; name: string } {
  const clean = path.replace(/^\/+|\/+$/g, '');
  const slash = clean.lastIndexOf('/');
  return slash < 0
    ? { parent: '', name: clean }
    : { parent: clean.slice(0, slash), name: clean.slice(slash + 1) };
}

/** Is `basename` a `.cbr`/`.zip`/`.rar` archive, by its fold (R2)? */
export function isForeignArchiveFile(basename: string): boolean {
  const folded = foldName(basename);
  return FOREIGN_ARCHIVE_EXTENSIONS.some((ext) => folded.endsWith(ext));
}

/**
 * A listing of `provider` passed over the file at `path` (relative to the
 * reader folder, as `CloudFileMetadata.path`): kept when it is a foreign
 * archive, ignored otherwise.
 */
export function noteSkippedListedFile(provider: string, path: string): void {
  const { parent, name } = split(path);
  if (!parent || !isForeignArchiveFile(name)) return;
  let folders = seen.get(provider);
  if (!folders) seen.set(provider, (folders = new Map()));
  const key = foldName(parent);
  let names = folders.get(key);
  if (!names) folders.set(key, (names = new Set()));
  names.add(name);
}

/**
 * The foreign archives `provider` listed in `folder` (relative path), in any
 * spelling of it (R1: more names only ever protect more).
 */
export function foreignArchiveNamesIn(provider: string, folder: string): string[] {
  const names = seen.get(provider)?.get(foldName(folder.replace(/^\/+|\/+$/g, '')));
  return names ? [...names] : [];
}

export function resetForeignArchivesForTest(): void {
  seen.clear();
}
