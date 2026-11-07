/**
 * Fold v2: the one name fold every name question is decided by, on every host
 * and store — which names are one entry, and (sidecar names rule 2,
 * `syncable-file.ts`) which files are a volume's. mokuro-bunko folds with the
 * same function (`bunko_core::names::fold_name`), from the same generated table
 * (`$lib/interop/contract/fold-table.json`, UCD 17.0.0), and both sides
 * reproduce `fold.json`'s vectors and its digest over every scalar value.
 *
 * F(s):
 * - an ASCII name: its ASCII lowercase;
 * - any other: drop Default_Ignorable code points, NFD, map each code point c
 *   to M(c) = casefold(full_upper(casefold(c))), NFC, drop Default_Ignorable
 *   again.
 *
 * F is idempotent and context-free (no Final_Sigma: `ΟΔΟΣ` and `ΟΔΟΣ.gcv`
 * fold their last sigma alike), and no code point folds to or from `.` or
 * `/`, so the k-th dot of a name is the k-th dot of its fold and every slice
 * of a name (stem, suffix, layer id) is cut at the same dot as its fold's
 * ({@link splitAtDots}). It is coarser than the lowercase Mokuro Reader 1.10.0
 * compared with: whatever that joined, F joins too.
 *
 * Library names are case-insensitive and case-preserving everywhere: compare
 * names with {@link foldName} (or {@link sameName}), never with
 * `toLowerCase()`, and write back the spelling that is already listed.
 */
import {
  FOLD_MAP,
  FOLD_TABLE_VERSION,
  FOLD_UCD,
  fromCodePoints,
  isDefaultIgnorable,
  nfcCodePoints,
  nfdCodePoints
} from './normalize';

export { FOLD_UCD };

/** The fold's version: Bunko's `bunko_core::names::FOLD_VERSION`. */
export const FOLD_VERSION = 2;
if (FOLD_TABLE_VERSION !== FOLD_VERSION) {
  throw new Error(`fold-table.json is fold ${FOLD_TABLE_VERSION}, this code is fold 2`);
}

// eslint-disable-next-line no-control-regex -- every ASCII code unit, controls included
const ASCII_RE = /^[\x00-\x7f]*$/;

/** F, computed every time (no memo): for the digest test and the memo itself. */
export function foldNameUncached(name: string): string {
  if (ASCII_RE.test(name)) return name.toLowerCase();
  const kept: number[] = [];
  for (const ch of name) {
    const cp = ch.codePointAt(0)!;
    if (!isDefaultIgnorable(cp)) kept.push(cp);
  }
  const mapped: number[] = [];
  for (const cp of nfdCodePoints(kept)) {
    const to = FOLD_MAP.get(cp);
    if (to === undefined) mapped.push(cp);
    else for (const out of to) mapped.push(out.codePointAt(0)!);
  }
  const composed = nfcCodePoints(mapped);
  return fromCodePoints(composed.filter((cp) => !isDefaultIgnorable(cp)));
}

/** How many non-ASCII folds {@link foldName} remembers. */
const MEMO_LIMIT = 10_000;
const memo = new Map<string, string>();

/**
 * F, fold v2: the form two names that are one entry share. ASCII names take
 * a fast path; others are remembered (a bounded memo, oldest out first), so a
 * library of Japanese titles folds each once per session.
 */
export function foldName(name: string): string {
  if (ASCII_RE.test(name)) return name.toLowerCase();
  const known = memo.get(name);
  if (known !== undefined) return known;
  const folded = foldNameUncached(name);
  if (memo.size >= MEMO_LIMIT) memo.delete(memo.keys().next().value!);
  memo.set(name, folded);
  return folded;
}

/** Are `a` and `b` one entry (R1)? */
export function sameName(a: string, b: string): boolean {
  return a === b || foldName(a) === foldName(b);
}

/**
 * Is `name` the fixed name `fixed` (`series.json`, `catalog.json`,
 * `volume-data.json`, `.mokuro-bunko.json`, ...) in some spelling (R8)?
 * `SERIES.JSON`, `ſeries.json` and `series\u{200B}.json` are, as every host makes
 * them one file with it.
 */
export function isFixedName(name: string, fixed: string): boolean {
  return sameName(name, fixed);
}

/**
 * Does the fold of `name` end with `suffix` (lowercase ASCII, its dot
 * included: `.cbz`, `.mokuro.gz`)? `V.CBZ`, `V.cb\u{200B}z` and `V.cbz\u{200B}` all
 * do.
 */
export function foldEndsWith(name: string, suffix: string): boolean {
  return foldName(name).endsWith(suffix);
}

/**
 * The whitespace of {@link seriesKey}, asked after the fold: Python's
 * `str.isspace()` united with JavaScript's `\s` (U+FEFF is default-ignorable,
 * so the fold has dropped it already). Bunko's `is_series_whitespace`.
 */
const SERIES_WHITESPACE_RE =
  // eslint-disable-next-line no-control-regex -- the control characters ARE whitespace here
  /[\u{9}-\u{d}\u{1c}-\u{20}\u{85}\u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}]+/gu;

/**
 * The key a series (and a volume title) is known by when two sources spell it
 * differently: F, then trimmed, then every run of whitespace one space.
 * A function of the fold, so never finer than it: `Straße` and `STRASSE`,
 * `Dr Stone` and `Dr  Stone` are one series. Bunko's
 * `bunko_core::names::series_key`; `fold.json`'s `series_key` vectors pin it.
 */
export function seriesKey(name: string): string {
  // Every run is one space by then, so trimming is a space off either end.
  return foldName(name).replace(SERIES_WHITESPACE_RE, ' ').replace(/^ | $/g, '');
}

/**
 * Code-point order (never UTF-16 order: U+FF21 sorts before U+1F600 here, and
 * after it by `<`). R6 picks a fold group's displayed spelling by it, as Bunko
 * does by bytes.
 */
export function compareCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    // Only where both are surrogates or both are not does UTF-16 order agree.
    const xs = x >= 0xd800 && x <= 0xdfff;
    const ys = y >= 0xd800 && y <= 0xdfff;
    if (xs !== ys) return xs ? 1 : -1;
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

/**
 * `raw` and its fold cut before their `k`-th dot from the end (1: the last
 * dot), or null when there are fewer than `k` dots. F keeps every dot, so the
 * two cuts are the same slice of the name.
 */
export function splitAtDots(
  raw: string,
  k: number
): { raw: string; rawRest: string; fold: string; foldRest: string } | null {
  const fold = foldName(raw);
  const rawCut = nthDotFromEnd(raw, k);
  const foldCut = nthDotFromEnd(fold, k);
  if (rawCut < 0 || foldCut < 0) return null;
  return {
    raw: raw.slice(0, rawCut),
    rawRest: raw.slice(rawCut),
    fold: fold.slice(0, foldCut),
    foldRest: fold.slice(foldCut)
  };
}

function nthDotFromEnd(s: string, k: number): number {
  let at = s.length;
  for (let i = 0; i < k; i++) {
    if (at === 0) return -1;
    at = s.lastIndexOf('.', at - 1);
    if (at < 0) return -1;
  }
  return at;
}
