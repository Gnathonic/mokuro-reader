/**
 * The reader's own Unicode normalization (NFD, NFC) and the tables of fold v2,
 * decoded once from the vendored `fold-table.json` (mokuro-bunko's
 * `interop/contract/fold-table.json`, generated on UCD 17.0.0 by its
 * `crates/bunko-core/scripts/gen_fold.py`; never edit the copy, re-run
 * `scripts/vendor-contract.mjs`).
 *
 * Why not `String.prototype.normalize`: its tables are the engine's (the
 * system ICU on Safari, whatever Node a CI runs), so a code point newer than
 * the engine's Unicode would normalize differently on two devices, and the
 * fold — which decides which names are one entry — with it. Bunko pins UCD
 * 17.0.0; so does this file, on every browser. `fold.test.ts` checks it against
 * the contract's digest over every scalar value and against the engine's own
 * normalize for every code point the engine has assigned.
 *
 * The table format is the contract README's ("Fold v2 and sidecar names rule
 * 2"): `;`-separated entries in lowercase hex, delta-encoded.
 */
import table from '$lib/interop/contract/fold-table.json';

/** The UCD version the tables (and so the fold) are pinned to. */
export const FOLD_UCD: string = table.ucd;
/** The fold's version (fold v2): a change of it is a new sidecar names rule. */
export const FOLD_TABLE_VERSION: number = table.fold;

function entries(field: string): string[][] {
  return field ? field.split(';').map((entry) => entry.split(':')) : [];
}

const hex = (value: string): number => parseInt(value, 16);

/** `<g>:<n>[:...]` ranges: each starts `g` after the previous one's end (+1). */
function decodeRanges(field: string): Array<[number, number, string[]]> {
  const out: Array<[number, number, string[]]> = [];
  let next = 0;
  for (const [gap, count, ...rest] of entries(field)) {
    const lo = next + hex(gap);
    const hi = lo + hex(count) - 1;
    out.push([lo, hi, rest]);
    next = hi + 1;
  }
  return out;
}

/** `M(c)` for every scalar it changes, as a string. */
export const FOLD_MAP: ReadonlyMap<number, string> = (() => {
  const map = new Map<number, string>();
  let cp = 0;
  for (const [delta, outputs] of entries(table.map)) {
    cp += hex(delta);
    map.set(cp, String.fromCodePoint(...outputs.split(',').map((o) => cp + hex(o))));
  }
  return map;
})();

/** Default_Ignorable_Code_Point, as sorted inclusive ranges `[lo0, hi0, lo1, hi1, ...]`. */
const IGNORABLE: Uint32Array = Uint32Array.from(
  decodeRanges(table.ignorable).flatMap(([lo, hi]) => [lo, hi])
);
const FIRST_IGNORABLE = IGNORABLE[0];

/** Is `cp` a Default_Ignorable_Code_Point (UCD {@link FOLD_UCD})? */
export function isDefaultIgnorable(cp: number): boolean {
  if (cp < FIRST_IGNORABLE) return false;
  let lo = 0;
  let hi = IGNORABLE.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (IGNORABLE[mid * 2 + 1] < cp) lo = mid + 1;
    else if (IGNORABLE[mid * 2] > cp) hi = mid - 1;
    else return true;
  }
  return false;
}

/** Non-zero canonical combining classes. */
const CCC: ReadonlyMap<number, number> = (() => {
  const map = new Map<number, number>();
  for (const [lo, hi, [klass]] of decodeRanges(table.ccc)) {
    const k = hex(klass);
    for (let cp = lo; cp <= hi; cp++) map.set(cp, k);
  }
  return map;
})();

/** The canonical combining class of `cp` (0 for a starter). */
export function combiningClass(cp: number): number {
  return CCC.get(cp) ?? 0;
}

/** One level of canonical decomposition, as UnicodeData lists it (Hangul excluded). */
const DECOMP_ONE: ReadonlyMap<number, readonly number[]> = (() => {
  const map = new Map<number, number[]>();
  let cp = 0;
  for (const [delta, targets] of entries(table.decomp)) {
    cp += hex(delta);
    map.set(cp, targets.split(',').map(hex));
  }
  return map;
})();

/** Full (recursive) canonical decompositions of {@link DECOMP_ONE}'s sources. */
const DECOMP: ReadonlyMap<number, readonly number[]> = (() => {
  const full = new Map<number, number[]>();
  const expand = (cp: number): number[] => {
    const known = full.get(cp);
    if (known) return known;
    const one = DECOMP_ONE.get(cp);
    if (!one) return [cp];
    const out = one.flatMap(expand);
    full.set(cp, out);
    return out;
  };
  for (const cp of DECOMP_ONE.keys()) expand(cp);
  return full;
})();

const S_BASE = 0xac00;
const L_BASE = 0x1100;
const V_BASE = 0x1161;
const T_BASE = 0x11a7;
const L_COUNT = 19;
const V_COUNT = 21;
const T_COUNT = 28;
const N_COUNT = V_COUNT * T_COUNT;
const S_COUNT = L_COUNT * N_COUNT;

const pairKey = (a: number, b: number): number => a * 0x110000 + b;

/**
 * Primary composites: the two-code-point decompositions whose source is not a
 * Full_Composition_Exclusion (Hangul is algorithmic).
 */
const COMPOSE: ReadonlyMap<number, number> = (() => {
  const excluded = new Set<number>();
  for (const [lo, hi] of decodeRanges(table.exclusions)) {
    for (let cp = lo; cp <= hi; cp++) excluded.add(cp);
  }
  const map = new Map<number, number>();
  for (const [cp, targets] of DECOMP_ONE) {
    if (targets.length === 2 && !excluded.has(cp)) map.set(pairKey(targets[0], targets[1]), cp);
  }
  return map;
})();

function compose(a: number, b: number): number | undefined {
  const l = a - L_BASE;
  if (l >= 0 && l < L_COUNT) {
    const v = b - V_BASE;
    if (v >= 0 && v < V_COUNT) return S_BASE + (l * V_COUNT + v) * T_COUNT;
    return undefined;
  }
  const s = a - S_BASE;
  if (s >= 0 && s < S_COUNT && s % T_COUNT === 0) {
    const t = b - T_BASE;
    if (t > 0 && t < T_COUNT) return a + t;
    return undefined;
  }
  return COMPOSE.get(pairKey(a, b));
}

/** Push the full canonical decomposition of `cp` onto `out`. */
function pushDecomposed(out: number[], cp: number): void {
  const s = cp - S_BASE;
  if (s >= 0 && s < S_COUNT) {
    out.push(L_BASE + Math.floor(s / N_COUNT), V_BASE + Math.floor((s % N_COUNT) / T_COUNT));
    if (s % T_COUNT) out.push(T_BASE + (s % T_COUNT));
    return;
  }
  const full = DECOMP.get(cp);
  if (full) out.push(...full);
  else out.push(cp);
}

/** Canonical ordering, in place: each run of non-starters sorted stably by class. */
function reorder(cps: number[]): number[] {
  for (let i = 1; i < cps.length; i++) {
    const k = combiningClass(cps[i]);
    if (k === 0) continue;
    let j = i;
    while (j > 0) {
      const prev = combiningClass(cps[j - 1]);
      if (prev <= k) break;
      [cps[j - 1], cps[j]] = [cps[j], cps[j - 1]];
      j--;
    }
  }
  return cps;
}

/** NFD of a sequence of code points (lone surrogates pass through). */
export function nfdCodePoints(cps: Iterable<number>): number[] {
  const out: number[] = [];
  for (const cp of cps) pushDecomposed(out, cp);
  return reorder(out);
}

/** NFC of a sequence of code points: NFD, then canonical composition. */
export function nfcCodePoints(cps: Iterable<number>): number[] {
  const d = nfdCodePoints(cps);
  if (d.length < 2) return d;
  const out: number[] = [];
  let starter = -1;
  let lastClass = 0;
  for (const cp of d) {
    const k = combiningClass(cp);
    if (starter >= 0 && (lastClass < k || lastClass === 0)) {
      const composite = compose(out[starter], cp);
      if (composite !== undefined) {
        out[starter] = composite;
        continue;
      }
    }
    if (k === 0) starter = out.length;
    // A non-starter before any starter blocks nothing it could compose with.
    lastClass = starter < 0 ? 256 : k;
    out.push(cp);
  }
  return out;
}

/** The code points of `s` (a lone surrogate is its own code unit). */
export function codePoints(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) out.push(ch.codePointAt(0)!);
  return out;
}

export function fromCodePoints(cps: readonly number[]): string {
  let out = '';
  // In chunks: a long name would overflow the argument list of one call.
  for (let i = 0; i < cps.length; i += 4096) {
    out += String.fromCodePoint(...cps.slice(i, i + 4096));
  }
  return out;
}

/** NFD of `s` on the pinned UCD (never the engine's tables). */
export function nfd(s: string): string {
  return fromCodePoints(nfdCodePoints(codePoints(s)));
}

/** NFC of `s` on the pinned UCD (never the engine's tables). */
export function nfc(s: string): string {
  return fromCodePoints(nfcCodePoints(codePoints(s)));
}
