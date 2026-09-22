/**
 * Wrap opportunities for a merged OCR line rendered as one string.
 *
 * Japanese has no spaces, and `line-break: anywhere` will break mid-word.
 * BudouX phrase boundaries (then Intl.Segmenter word boundaries) are marked
 * with U+200B. Wrapped lines use `word-break: keep-all`, so the browser
 * breaks at those hints the way it breaks at an English space. U+200B has
 * zero advance in Noto Sans CJK.
 */

import { BudouXParser } from './vendor/budoux-parser';
import { model as jaModel } from './vendor/budoux-ja-model.js';

type TextMeasurer = (text: string) => number;

/** Renderless break opportunity. Not HTML whitespace, so it is not collapsed. */
export const WRAP_HINT = '\u200B';

/** How many characters before the natural fill point a better boundary may be. */
const LOOKBACK = 1;

/** Must not start a column (kinsoku). A break is never placed before these. */
const NO_START = new Set(
  '、。，．！？?!）」』】〕〉》っゃゅょぁぃぅぇぉッャュョァィゥェォー…・ゝゞ々'
);

/** Must not end a column. */
const NO_END = new Set('「『【（([{');

let parser: BudouXParser | null = null;
let segmenter: Intl.Segmenter | null | undefined;
const boundaryCache = new Map<string, { phrase: Set<number>; word: Set<number> }>();

function japaneseParser(): BudouXParser {
  if (!parser) parser = new BudouXParser(jaModel);
  return parser;
}

function wordSegmenter(): Intl.Segmenter | null {
  if (segmenter !== undefined) return segmenter;
  segmenter =
    typeof Intl !== 'undefined' && 'Segmenter' in Intl
      ? new Intl.Segmenter('ja', { granularity: 'word' })
      : null;
  return segmenter;
}

function boundariesOf(text: string): { phrase: Set<number>; word: Set<number> } {
  const cached = boundaryCache.get(text);
  if (cached) return cached;
  const chars = [...text];
  const phrase = new Set<number>();
  const word = new Set<number>();

  const parts = japaneseParser().parse(text);
  if (parts.join('') === text) {
    let i = 0;
    for (const part of parts) {
      i += [...part].length;
      if (i > 0 && i < chars.length) phrase.add(i);
    }
  }

  const seg = wordSegmenter();
  if (seg) {
    let i = 0;
    for (const part of seg.segment(text)) {
      i += [...part.segment].length;
      if (i > 0 && i < chars.length) word.add(i);
    }
  }

  // Spaces and closing punctuation are already wrap points under keep-all.
  // Recording them keeps the fitter in step with the browser.
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if ((ch === ' ' || ch === '\u3000' || NO_START.has(ch)) && i + 1 < chars.length) {
      phrase.add(i + 1);
    }
  }

  const found = { phrase, word };
  if (boundaryCache.size > 4000) boundaryCache.clear();
  boundaryCache.set(text, found);
  return found;
}

interface Plan {
  chars: string[];
  costs: number[];
  phrase: Set<number>;
  word: Set<number>;
}

function planOf(text: string, measure: TextMeasurer): Plan {
  const chars = [...text];
  const { phrase, word } = boundariesOf(text);
  return { chars, costs: chars.map((ch) => measure(ch)), phrase, word };
}

function legalBreak(chars: string[], b: number, start: number): boolean {
  return b > start && b < chars.length && !NO_END.has(chars[b - 1]) && !NO_START.has(chars[b]);
}

/**
 * Column-start indexes for a column capacity of `cap` em.
 * A column never runs past `cap`, so the browser's keep-all wrap does not
 * invent an extra break at punctuation inside the chunk.
 */
function columnBreaks(plan: Plan, cap: number, lookback: number): number[] {
  const { chars, costs } = plan;
  const breaks: number[] = [];
  let i = 0;
  while (i < chars.length) {
    let used = 0;
    let j = i;
    while (j < chars.length && used + costs[j] <= cap + 1e-6) {
      used += costs[j];
      j++;
    }
    if (j >= chars.length) break;

    // Break at or before the first glyph that does not fit. Hanging a
    // forbidden line-start past `cap` makes a chunk the browser will
    // re-break at punctuation, which adds a column the quad may not hold.
    const limit = j;
    const minB = Math.max(i + 1, j - lookback);
    let chosen = -1;
    for (let b = limit; b >= minB; b--) {
      if (b >= chars.length) continue;
      if (legalBreak(chars, b, i) && plan.phrase.has(b)) {
        chosen = b;
        break;
      }
    }
    if (chosen < 0) {
      for (let b = limit; b >= minB; b--) {
        if (b >= chars.length) continue;
        if (legalBreak(chars, b, i) && plan.word.has(b)) {
          chosen = b;
          break;
        }
      }
    }
    if (chosen < 0) {
      for (let b = j; b > i; b--) {
        if (legalBreak(chars, b, i)) {
          chosen = b;
          break;
        }
      }
    }
    if (chosen < 0) chosen = Math.min(j, chars.length - 1);
    if (chosen <= i) chosen = i + 1;
    breaks.push(chosen);
    i = chosen;
  }
  return breaks;
}

function packing(
  plan: Plan,
  cap: number,
  lookback: number
): { breaks: number[]; cols: number; fits: boolean } {
  const breaks = columnBreaks(plan, cap, lookback);
  const edges = [0, ...breaks, plan.chars.length];
  let fits = true;
  for (let k = 0; k < edges.length - 1; k++) {
    let cost = 0;
    for (let i = edges[k]; i < edges[k + 1]; i++) cost += plan.costs[i];
    // Columns have to fit the line box. A chunk that sticks out gets split
    // by the browser at the next punctuation mark and can spill an extra
    // column across the quad.
    if (cost > cap + 1e-6) fits = false;
  }
  return { breaks, cols: plan.chars.length === 0 ? 1 : breaks.length + 1, fits };
}

/**
 * Largest font size ≤ startSize at which the hinted columns fit in `cross`.
 * Look-back of one character is kept only when it does not add a column past
 * the break-anywhere packing; otherwise the fill point is used, still kinsoku-legal.
 */
export function fitWrappedFontSize(
  startSize: number,
  text: string,
  measure: TextMeasurer,
  main: number,
  cross: number
): number {
  if (!(main > 0) || !(cross > 0)) return 0;
  if (!text) return Math.min(startSize, cross);
  const plan = planOf(text, measure);
  let best = 0;
  for (let n = 1; n <= 12; n++) {
    const ceiling = Math.min(startSize, cross / n);
    if (!(ceiling > 0)) continue;
    let lo = 0;
    let hi = ceiling;
    for (let it = 0; it < 18; it++) {
      const mid = (lo + hi) / 2;
      const cap = main / mid;
      const eager = packing(plan, cap, LOOKBACK);
      const plain = packing(plan, cap, 0);
      const chosen = eager.fits && eager.cols <= n ? eager : plain;
      if (chosen.fits && chosen.cols <= n) lo = mid;
      else hi = mid;
    }
    if (lo > best) best = lo;
  }
  return best;
}

/** Original text with U+200B inserted at the wrap points for this font size. */
export function hintWrappedText(
  text: string,
  measure: TextMeasurer,
  main: number,
  cross: number,
  fontSize: number
): string {
  if (!text || !(main > 0) || !(fontSize > 0)) return text;
  const plan = planOf(text, measure);
  const cap = main / fontSize;
  const eager = packing(plan, cap, LOOKBACK);
  const plain = packing(plan, cap, 0);
  // Same choice as fitWrappedFontSize: take the phrase/word nudge when those
  // columns still fit in the quad, otherwise break at the fill point.
  const budget = cross > 0 ? cross / fontSize : plain.cols;
  const chosen = eager.fits && eager.cols <= budget + 1e-6 ? eager : plain;
  const breaks = chosen.breaks;
  if (breaks.length === 0) return text;
  const at = new Set(breaks);
  let out = '';
  for (let i = 0; i < plan.chars.length; i++) {
    if (at.has(i)) out += WRAP_HINT;
    out += plan.chars[i];
  }
  return out;
}

export function stripWrapHints(text: string): string {
  return text.replaceAll(WRAP_HINT, '');
}
