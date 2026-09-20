/**
 * How much of its cell a glyph leaves EMPTY along the reading axis.
 *
 * Japanese print is fixed-pitch: every character owns one cell (an em box),
 * and a detector's line quad hugs the INK, not the cells. A trailing `。`
 * inks only the first third of its cell, a closing `」` its first third, an
 * opening `「` its last third, and a lone `一` in a column is a thin stroke in
 * the middle of its cell. Treating the quad as n FULL cells squeezes such a
 * line and the error grows along it — measured at 0.62 of a glyph at the end
 * of lines ending in `。、」`, against ≤ 0.18 for lines ending in a full glyph.
 *
 * `lead` is the ink-free fraction of an em at the START of the first glyph's
 * cell, `trail` the one at the END of the last glyph's. A line whose quad
 * spans the ink covers `n − lead − trail` cells (`line-grid.ts`).
 *
 * CALIBRATION (2026-09-20). Ten pages of a scanned novel at 2800 px: for every
 * column the print's own pitch and cell phase were recovered from the page
 * image (a least-squares comb over the column's ink profile — 40-glyph columns
 * give the pitch to 0.1 %; across the columns of one block it varies by a
 * median 0.06 %, p95 0.3 %), and the ink extent of every glyph was read off
 * inside its cell. Medians in em, lead / trail, VERTICAL text:
 *
 *   kanji           0.05 / 0.05   n = 877   (font: 0.04 / 0.04)
 *   hiragana        0.11 / 0.10   n = 1712  (font: 0.11 / 0.09)
 *   katakana        0.12 / 0.08   n = 45    (font: 0.15 / 0.10)
 *   small kana      0.26 / 0.25   n = 93    (font: 0.18 / 0.20)
 *   。、            0.06 / 0.68   n = 203   (font: 0.07 / 0.67)
 *   」』）】        0.08 / 0.62   n = 10    (font: 0.04 / 0.65)
 *   「『（【        0.66 / 0.02   n = 9     (font: 0.65 / 0.04)
 *   一              0.42 / 0.47   n = 17    (font: 0.41 / 0.50)
 *   ー ―            0.06 / 0.03   n = 9     (font: 0.09 / 0.09)
 *   ！？            0.15 / 0.09   n = 4     (font: 0.12 / 0.12)
 *   … ‥             0.09 / 0.06   n = 4 — too few: the font's 0.14, rounded down
 *
 * "font" is the same measurement on the outlines of Noto Serif / Sans CJK JP
 * with the `vert` feature: print and font agree to a few hundredths wherever
 * the print has samples, so the font fills in what the novel cannot give —
 * every HORIZONTAL value (the book has nine horizontal lines, none over six glyphs), `・`,
 * and fullwidth Latin. Two tables only where the two directions really differ:
 * small kana, `一`, `！？` and fullwidth Latin.
 *
 * At the line ENDS, where the detector's quad edge stands in for the ink, the
 * same classes measure 0.06 (kanji lead), 0.64 (`「` lead), 0.70 (`。、` trail),
 * 0.61 (`」` trail): the ink-tight PP-OCR quads sit a median +1 px / −2 px off
 * the ink. comic-text-detector's quads are noisier (sd 0.4 of a cell, from
 * lines whose text and quad disagree by a whole character) but their median
 * residual against this table is −0.01 / +0.02 of a cell — no per-producer
 * offset is warranted.
 *
 * Pure data, no DOM.
 */

export interface InkInsets {
  /** ink-free fraction of an em before the first glyph's ink */
  lead: number;
  /** ink-free fraction of an em after the last glyph's ink */
  trail: number;
}

type Pair = readonly [lead: number, trail: number];

interface GlyphClass {
  chars: string;
  vertical: Pair;
  /** absent = the same as `vertical` */
  horizontal?: Pair;
}

const CLASSES: GlyphClass[] = [
  { chars: '。、，．', vertical: [0.06, 0.68] },
  { chars: '」』）】〟〕］｝〉》', vertical: [0.06, 0.63] },
  { chars: '「『（【〝〔［｛〈《', vertical: [0.65, 0.03] },
  {
    chars: 'っゃゅょぁぃぅぇぉゎッャュョァィゥェォヮ',
    vertical: [0.25, 0.25],
    horizontal: [0.19, 0.17]
  },
  // a thin horizontal stroke: mid-cell in a column, the whole cell in a row
  { chars: '一', vertical: [0.42, 0.47], horizontal: [0.05, 0.05] },
  // turned with the column (vertical forms), so they fill the cell either way
  { chars: 'ー―—─〜～', vertical: [0.06, 0.05] },
  { chars: '…‥', vertical: [0.1, 0.1] },
  // full height, but a narrow glyph centred in its cell when read in a row
  { chars: '！？', vertical: [0.14, 0.1], horizontal: [0.35, 0.35] },
  { chars: '・：；', vertical: [0.4, 0.4] }
];

const BY_CHAR = new Map<string, GlyphClass>();
for (const glyphClass of CLASSES) for (const ch of glyphClass.chars) BY_CHAR.set(ch, glyphClass);

const KANJI: Pair = [0.05, 0.05];
const HIRAGANA: Pair = [0.11, 0.1];
const KATAKANA: Pair = [0.12, 0.1];
const FULLWIDTH_LATIN: GlyphClass = { chars: '', vertical: [0.13, 0.11], horizontal: [0.22, 0.21] };
/** ASCII and half-width kana: side bearings of a proportional glyph */
const HALF_WIDTH: Pair = [0.04, 0.04];

function pairOf(ch: string, vertical: boolean): Pair {
  const listed = BY_CHAR.get(ch);
  if (listed) return vertical ? listed.vertical : (listed.horizontal ?? listed.vertical);
  const code = ch.codePointAt(0) ?? 0;
  if (code < 0x2000 || (code >= 0xff61 && code <= 0xff9f)) return HALF_WIDTH;
  if (code >= 0x3041 && code <= 0x309f) return HIRAGANA;
  if (code >= 0x30a0 && code <= 0x30ff) return KATAKANA;
  if (code >= 0xff01 && code <= 0xff5e) {
    return vertical ? FULLWIDTH_LATIN.vertical : FULLWIDTH_LATIN.horizontal!;
  }
  return KANJI;
}

/** Marks that ride on their base and joiners: not a character of their own
 * (the same set `spacingUnits` leaves uncounted). */
function rides(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x200b && code <= 0x200d) ||
    code === 0x2060 ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    /^[\p{Mn}\p{Me}]$/u.test(ch)
  );
}

const IDEOGRAPHIC_SPACE = '\u3000';

/**
 * The insets of `text` as it is RENDERED (the processed line in the viewer,
 * the raw one in the editor). An ideographic space at either end is a whole
 * empty cell on top of its neighbour's inset — the browser does not collapse
 * it, and the quad starts at the ink after it.
 */
export function inkInsets(text: string, vertical: boolean): InkInsets {
  const chars = Array.from(text ?? '').filter((ch) => !rides(ch));
  let first = 0;
  let last = chars.length - 1;
  while (first <= last && chars[first] === IDEOGRAPHIC_SPACE) first++;
  while (last >= first && chars[last] === IDEOGRAPHIC_SPACE) last--;
  if (first > last) return { lead: 0, trail: 0 };
  return {
    lead: first + pairOf(chars[first], vertical)[0],
    trail: chars.length - 1 - last + pairOf(chars[last], vertical)[1]
  };
}
