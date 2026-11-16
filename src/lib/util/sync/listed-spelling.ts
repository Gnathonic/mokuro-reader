/**
 * Names as the library knows them: case-insensitive and case-preserving on
 * every host and store (sidecar names rule 2, R1). Two names are one entry iff
 * they fold alike (`foldName`), so:
 * - a LOOKUP of a path finds the listed entry of that fold, whatever its
 *   spelling ({@link listedCopies}, {@link listedEntry}): every provider cache
 *   answers `has`/`get`/`getAll` through these;
 * - a WRITE goes onto the spelling already listed, never a second one
 *   ({@link resolveListedSpelling}, {@link resolveListedPath}, R9): on Drive
 *   and MEGA the existing file is then found by id, on WebDAV, OneDrive and a
 *   local folder it is the path written, and Bunko never sees a request to
 *   create a case variant (which it would refuse).
 *
 * Among several listed spellings of one fold (a fold group, which only a
 * case-sensitive store can hold) the exact spelling wins, else the
 * code-point-smallest (R6), never UTF-16 order, so every device and Bunko pick
 * the same one.
 */
import { compareCodePoints, foldName } from '#lib/util/names/fold.js';

/**
 * The listed spelling a write of `name` goes to (R9): `name` itself when it
 * is listed, else the one listed name that folds alike, else (a fold group)
 * the code-point-smallest of those, else `name` (nothing listed: create it).
 */
export function resolveListedSpelling(listing: Iterable<string>, name: string): string {
  const folded = foldName(name);
  let best: string | undefined;
  for (const listed of listing) {
    if (listed === name) return name;
    if (foldName(listed) !== folded) continue;
    if (best === undefined || compareCodePoints(listed, best) < 0) best = listed;
  }
  return best ?? name;
}

/** Order copies of one entry: the exact spelling first, then code-point order (R6). */
function byR6<T extends { path: string }>(copies: T[], path: string): T[] {
  return copies.sort((a, b) => {
    const ax = a.path === path;
    const bx = b.path === path;
    if (ax !== bx) return ax ? -1 : 1;
    return compareCodePoints(a.path, b.path);
  });
}

/** Per listing revision: the fold of each first segment → the group keys spelled so. */
const groupIndexes = new WeakMap<object, Map<string, string[]>>();

function groupKeysFolding(
  groups: ReadonlyMap<string, readonly unknown[]>,
  revision: object | undefined,
  first: string
): string[] {
  const folded = foldName(first);
  if (!revision) return [...groups.keys()].filter((key) => foldName(key) === folded);
  let index = groupIndexes.get(revision);
  if (!index) {
    index = new Map();
    for (const key of groups.keys()) {
      const k = foldName(key);
      const list = index.get(k);
      if (list) list.push(key);
      else index.set(k, [key]);
    }
    groupIndexes.set(revision, index);
  }
  return index.get(folded) ?? [];
}

/**
 * Every listed copy of the entry `path` names (R1: its path folds alike), in a
 * listing grouped by first path segment (the shape every provider cache
 * keeps), the exact spelling first, then code-point order. `revision` (the
 * cache's revision token) memoises the fold of the group keys; without it they
 * are folded per call.
 */
export function listedCopies<T extends { path: string }>(
  groups: ReadonlyMap<string, readonly T[]>,
  path: string,
  revision?: object
): T[] {
  const folded = foldName(path);
  const out: T[] = [];
  for (const key of groupKeysFolding(groups, revision, path.split('/')[0])) {
    for (const file of groups.get(key) ?? []) {
      if (file.path === path || foldName(file.path) === folded) out.push(file);
    }
  }
  return byR6(out, path);
}

/**
 * The listed entry `path` names: the exact spelling when it is listed (the
 * fast path: no fold), else the R6 pick of the spellings that fold alike, else
 * null.
 */
export function listedEntry<T extends { path: string }>(
  groups: ReadonlyMap<string, readonly T[]>,
  path: string,
  revision?: object
): T | null {
  const exact = groups.get(path.split('/')[0])?.find((file) => file.path === path);
  if (exact) return exact;
  return listedCopies(groups, path, revision)[0] ?? null;
}

/**
 * The path a write of `path` (`<Series>/<file>`, `history/<device>/<file>` or a
 * root `<file>`) goes to on a store whose listing is `groups` (grouped by
 * first segment, as every provider cache keeps it) (R9): each segment resolved
 * onto the listed name of that fold under the segments before it, so the
 * folder and the file keep the listing's spelling. A segment nothing lists
 * keeps the caller's spelling, and so does everything after it.
 */
export function resolveListedPath<T extends { path: string }>(
  groups: ReadonlyMap<string, readonly T[]>,
  path: string,
  revision?: object
): string {
  const parts = path.split('/');
  if (parts.some((p) => p === '')) return path;
  const keys = groupKeysFolding(groups, revision, parts[0]);
  if (keys.length === 0) return path;
  let candidates: string[] = [];
  for (const key of keys) for (const file of groups.get(key) ?? []) candidates.push(file.path);
  let prefix = '';
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    const names = new Set<string>();
    for (const listed of candidates) {
      if (prefix && !listed.startsWith(prefix)) continue;
      const rest = listed.slice(prefix.length);
      const slash = rest.indexOf('/');
      // A folder segment names a listed folder; the last one, a listed file.
      if (last ? slash < 0 : slash > 0) names.add(last ? rest : rest.slice(0, slash));
    }
    const spelled = resolveListedSpelling(names, parts[i]);
    if (spelled === parts[i] && !names.has(spelled)) {
      // Nothing listed here: the rest is new, spelled as the caller spells it.
      return prefix + parts.slice(i).join('/');
    }
    prefix += last ? spelled : `${spelled}/`;
    if (!last) candidates = candidates.filter((listed) => listed.startsWith(prefix));
  }
  return prefix;
}

/**
 * `cache.listedPath(path)` when the cache can resolve one (R9), else `path`:
 * a provider's write goes through this, so a cache that cannot list (or a
 * stand-in) writes the path as given.
 */
export function listedPathOn(
  cache: { listedPath?: (path: string) => string } | null | undefined,
  path: string
): string {
  return typeof cache?.listedPath === 'function' ? cache.listedPath(path) : path;
}
