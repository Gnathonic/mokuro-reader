/**
 * Per-line layout of a text block, derived from the `lines_coords`
 * quadrilaterals that mokuro emits for every OCR line. It places the lines of
 * the reader's `auto` font mode (sizes fitted to the quads) and of its
 * `original` one (`size: 'file'` — the file's own `font_size`, capped by the
 * same quads).
 *
 * mokuro's block-level `font_size` is the mean detected line-quad width, which
 * for vertical Japanese includes furigana and mask slack — median 1.2x (p95 2x)
 * larger than the true character size — so rendering `font_size`px overflows
 * the block box. The quads themselves are reliable: each line's quad gives its
 * exact position and extent, and its pitch (`line-grid.ts`) recovers the true
 * per-line font size. See docs/superpowers/specs/
 * 2026-07-04-original-mode-line-coords-design.md (written when only the mode
 * now called `auto` existed, under the name "original").
 *
 * Characters sit on a FIXED-PITCH GRID along the line (`line-grid.ts`): the
 * pitch comes from the quad corrected for the ink the first and last glyphs do
 * not have (`glyph-insets.ts`) and is shared by the lines of a block; the run
 * is letter-spaced to that pitch from the line's start, and a line whose quad
 * is tilted renders rotated, in its own frame. See docs/superpowers/specs/
 * 2026-09-19-ocr-engine-options-findings.md.
 */

import { inkInsets } from './glyph-insets';
import {
  VOTER_MIN_CELLS,
  griddable,
  gridSpacing,
  inkLength,
  lineFrame,
  linePitches,
  maxSizeAtSpacing,
  ownPitch,
  quadAxes,
  rectBounds,
  rectOverlapArea,
  rectsCollide,
  spacingUnits,
  type LineFrame,
  type LinePitch,
  type OrientedRect,
  type PitchInput
} from './line-grid';

/** One OCR line quad: 4 corner points, [x, y] each, in page pixels. */
export type Quad = number[][];

const ELLIPSIS = '…';

/**
 * The reader's ellipsis substitution, in ONE place: a run of three ASCII or
 * three fullwidth periods renders as `…`. Matching is left to right and
 * non-overlapping (`....` → `….`).
 */
export function processLine(raw: string): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\.\.\./g, ELLIPSIS).replace(/．．．/g, ELLIPSIS);
}

/** Advance of a text string in em units (width at font-size 1). */
export type TextMeasurer = (text: string) => number;

export interface LayoutBlock {
  box: number[];
  vertical: boolean;
  font_size: number;
  lines: string[];
  lines_coords?: Quad[];
}

export interface LayoutOptions {
  /**
   * Where a fitted line's font size comes from. `'fitted'` (auto mode, the
   * default) reads it off the quads: the line's pitch, made uniform across
   * the block. `'file'` (original mode) renders the block's own `font_size`
   * — as far as the file's own line geometry can carry it (`fileLineSizes`):
   * mokuro's is known to overstate the print, and where the two contradict
   * each other the GEOMETRY wins, or the glyphs draw on top of each other.
   *
   * The PLACEMENT is the same either way — the quad's frame, the block's
   * pitch grid anchored at each line's start, the ink insets, the rotation —
   * so the letter-spacing comes out as what is left of the pitch once the
   * file's size is taken: never below `FILE_MIN_SPACING_EM`, and wide open
   * when the file's size is smaller than the print's.
   *
   * What `'file'` drops is everything that second-guesses the file to make
   * the result fit: no line is wrapped into its quad, no overlap cluster is
   * re-flowed into bands, nothing is nudged, clipped or shrunk, and a tilted
   * quad is never refused its turn. One heuristic stays, because without it
   * the view is unreadable rather than faithful: a line re-captured inside
   * another (`RECAPTURE_OVERLAP`, its text contained in the bigger one's)
   * stays hidden — the same glyphs twice on one spot, and nothing the file
   * says is lost with it.
   *
   * A file with no usable `font_size` keeps the fitted sizes.
   */
  size?: 'fitted' | 'file';
}

export interface LineLayout {
  /**
   * px, relative to the block box origin. Upright line: where the text run
   * starts (before `inset`). Rotated line (`rotation` ≠ 0): the corner of the
   * line's OWN-FRAME box — `width` × `height`, centred on the quad's centre,
   * as it lies before the turn.
   */
  left: number;
  top: number;
  fontSize: number;
  /**
   * True when the quad is much wider than the block's reference size and the
   * text only fits at a much smaller size — i.e. multiple print columns
   * (typically base text + furigana) were captured as one OCR "line". The
   * line then renders with white-space wrapping inside its full quad bbox.
   */
  wrap: boolean;
  /** Quad bbox dims, px — the wrapping container for wrap lines. For a
   * rotated line: its own-frame box, cross × main (vertical) or main × cross. */
  width: number;
  height: number;
  /**
   * Degrees clockwise (CSS `rotate()`) about the centre of the own-frame box;
   * 0 for an upright line — and for every wrapped, banded, suspect or hidden
   * one: a wrap container is an axis-aligned guess already, turning it would
   * only move the guess.
   */
  rotation: number;
  /**
   * px of CSS letter-spacing that puts the run on its line's fixed-pitch grid
   * (`gridSpacing`); 0 for wrapped/hidden lines and lines the grid gives up on.
   */
  letterSpacing: number;
  /**
   * px along the reading axis from `left`/`top` (or the own-frame box's start
   * edge) to where the run starts. Usually NEGATIVE: the quad starts at the
   * first glyph's INK, its cell a little earlier (`gridSpacing`).
   */
  inset: number;
  /**
   * True for lines suppressed by intra-block overlap dedupe: the detector
   * re-captured the same ink region as multiple overlapping "lines", which
   * would render stacked on top of each other.
   */
  hidden?: boolean;
}

/**
 * Guard against zero/NaN font sizes, not readability: hallucinated OCR lines
 * (text far longer than the quad) must stay contained in their quad, so the
 * computed size may be legitimately sub-pixel.
 */
const MIN_FONT_SIZE = 0.5;

/**
 * A merged-columns suspect wraps when it would need to shrink below
 * WRAP_SHRINK × reference to fit on one line AND wrapping actually buys at
 * least WRAP_GAIN × the single-line size inside its quad.
 */
const WRAP_SHRINK = 0.7;
const WRAP_GAIN = 1.25;
/** ≥2 clean lines whose sizes agree within this spread fix the block size —
 * a wrapped line's lower fit no longer pulls the whole block down. */
const CONSENSUS_SPREAD = 1.25;
/** A quad ≥ this many times its own fitted size is merged-columns suspect
 * and excluded from the block reference computation. */
const SUSPECT_RATIO = 1.6;
/** Is a quad this thick, around text this size, more than one print column?
 * The viewer's and the OCR editor's one answer. */
export function isMergedColumns(cross: number, fitted: number): boolean {
  return cross >= SUSPECT_RATIO * fitted;
}
/** A line fitting below this fraction of the reference is deliberately small
 * print (standalone furigana, asides): it keeps its own size. */
const SMALL_OUTLIER = 0.7;
/** Lines may run this much past their own quad's length at the uniform size —
 * quad slack varies line to line while print size is constant. */
const OVERFLOW_TOL = 1.15;
/** …and a quad can carry glyphs this much bigger than it is thick: the quads
 * of one balloon's columns differ by about that (54–66px around 56px print on
 * the fixture page), while print size is constant. Auto's uniform size and
 * original mode's file size are held to the same limit. */
const CROSS_SLACK = 1.2;
/**
 * Original mode (`size: 'file'`): the file's font size may close a line's
 * glyphs up by no more than this (em). Read off the data: a CONSISTENT mokuro
 * block says about 5% more than its pitch (fixture block 1: 59px on a 56.2px
 * step, −0.047em) and must keep its size exactly; full-bodied kanji leave
 * about that much of their cell free, so up to here no ink touches; overlap
 * shows from about −0.12em, and the contradictory blocks are far beyond it
 * (fixture block 2: 155px on a 111px step, −0.28em).
 */
export const FILE_MIN_SPACING_EM = -0.05;

/**
 * The sizes original mode renders a block's lines at: the file's `font_size`,
 * capped by the file's own line geometry.
 *
 * A line can carry a size up to where its glyphs would close up by
 * `FILE_MIN_SPACING_EM` on its pitch (`maxSizeAtSpacing`), and up to
 * `CROSS_SLACK` × its quad's thickness (columns must not run into each other
 * sideways, which no letter-spacing can fix): its `cap`.
 *
 * The file has ONE size per block, and print one per balloon — so the cap is
 * not taken line by line, which would set the columns of a bubble in slightly
 * different sizes (a quad that ends early, an `…` the print spreads over three
 * cells). The BLOCK is capped, by its TIGHTEST FULL line: full as in long
 * enough to say anything about the pitch (`VOTER_MIN_CELLS`; a balloon of
 * short lines only has those) and one clean column (`body`). Deliberately
 * small print — ruby split off its base text, an aside: a cap under
 * `SMALL_OUTLIER` of the block's area-weighted median, as for auto's reference
 * size — does not pull the block down to its size. Every line then renders at
 * the block's size, and only one that cannot carry even that (the ruby; a thin
 * quad around two glyphs) goes lower, alone.
 *
 * A `cap` is null for a hidden line, which takes no file size.
 */
function fileLineSizes(
  fileSize: number,
  lines: { cap: number | null; cells: number; area: number; body: boolean }[]
): (number | null)[] {
  // No clean column at all (a hallucination cluster, one quad around a whole
  // balloon): nothing speaks for the block, and every line has its own cap.
  const body = lines.filter((line) => line.cap !== null && line.body);
  const full = body.filter((line) => line.cells >= VOTER_MIN_CELLS);
  const deciding = full.length ? full : body;
  let blockSize = fileSize;
  if (deciding.length) {
    const reference = weightedMedian(
      deciding.map((line) => line.cap!),
      deciding.map((line) => line.area)
    );
    for (const line of deciding) {
      if (line.cap! >= SMALL_OUTLIER * reference) blockSize = Math.min(blockSize, line.cap!);
    }
  }
  return lines.map((line) => (line.cap === null ? null : Math.min(blockSize, line.cap)));
}

/** Two lines whose bboxes overlap by this fraction of the smaller one are
 * re-captures of the same ink region — one of them is suppressed. */
const RECAPTURE_OVERLAP = 0.7;

/**
 * Median of `values` where each value counts proportionally to its weight.
 * The block reference weights lines by quad ink area so a big base line is
 * not outvoted by small ruby fragments split around it.
 */
function weightedMedian(values: number[], weights: number[]): number {
  const order = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
  const total = weights.reduce((s, w) => s + w, 0);
  let cumulative = 0;
  for (const i of order) {
    cumulative += weights[i];
    if (cumulative >= total / 2) return values[i];
  }
  return values[order[order.length - 1]];
}

/**
 * Largest font size ≤ startSize at which `advanceEm` ems wrap into columns of
 * length `main` without the column count overflowing `cross`. For each column
 * count n, the size is bounded by the column pitch (cross / n) and by the text
 * capacity (n × main / advance); take the best n.
 */
function wrapFitSize(startSize: number, advanceEm: number, main: number, cross: number): number {
  let best = 0;
  for (let n = 1; n <= 12; n++) {
    const size = Math.min(startSize, cross / n, (n * main) / advanceEm);
    if (size > best) best = size;
  }
  return best;
}

/**
 * Fallback measurer for environments without canvas (tests, SSR): fullwidth
 * characters advance 1em, halfwidth/ASCII roughly half.
 */
export function heuristicMeasurer(text: string): number {
  let advance = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x2000 || (code >= 0xff61 && code <= 0xff9f)) {
      advance += 0.55;
    } else {
      advance += 1;
    }
  }
  return advance;
}

/**
 * Canvas-based measurer using the reader's text font. Memoized per string;
 * falls back to the heuristic when canvas is unavailable.
 *
 * Vertical text approximation: upright CJK advances ~1em vertically, which
 * matches its horizontal measure; rotated Latin advances by its horizontal
 * width. Residual error is bounded by the quad-cross cap in layoutLines.
 */
export function createCanvasMeasurer(fontFamily = "'Noto Sans JP', sans-serif"): TextMeasurer {
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = document.createElement('canvas').getContext('2d');
    if (ctx) {
      ctx.font = `100px ${fontFamily}`;
      // Fixed-pitch text is measured as such: with kerning on, the canvas
      // closes up pairs like 」「 and reports 38.91em for 39 fullwidth glyphs,
      // which sizes the font 0.2% too large. The line spans render with
      // `font-kerning: none` to match. (Absent in older engines: harmless.)
      if ('fontKerning' in ctx) ctx.fontKerning = 'none';
    }
  } catch {
    ctx = null;
  }
  if (!ctx || typeof ctx.measureText !== 'function') return heuristicMeasurer;
  const canvasCtx = ctx;
  const cache = new Map<string, number>();
  return (text: string) => {
    let advance = cache.get(text);
    if (advance === undefined) {
      advance = canvasCtx.measureText(text).width / 100;
      if (!Number.isFinite(advance) || advance < 0) advance = heuristicMeasurer(text);
      cache.set(text, advance);
    }
    return advance;
  };
}

let defaultMeasurer: TextMeasurer | null = null;

/** Shared memoized canvas measurer (heuristic fallback outside the browser). */
export function getDefaultMeasurer(): TextMeasurer {
  if (!defaultMeasurer) defaultMeasurer = createCanvasMeasurer();
  return defaultMeasurer;
}

/**
 * Extents of a quad along the writing direction (main) and across it (cross),
 * via edge-midpoint vectors — the same construction comic-text-detector uses,
 * so it tolerates rotated quads.
 */
export function quadExtents(quad: Quad, vertical: boolean): { main: number; cross: number } | null {
  const axes = quadAxes(quad);
  if (!axes) return null;
  return vertical ? { main: axes.v, cross: axes.h } : { main: axes.h, cross: axes.v };
}

/**
 * What the pitch model (`line-grid.ts`) needs to know about one line: its
 * quad's extents, its text's natural advance, and the ink insets of its first
 * and last glyph. One place, so the viewer and the OCR editor cannot disagree.
 */
export function pitchInput(
  extents: { main: number; cross: number },
  text: string,
  vertical: boolean,
  measure: TextMeasurer
): PitchInput {
  return {
    main: extents.main,
    cross: extents.cross,
    advanceEm: measure(text),
    count: spacingUnits(text),
    ...inkInsets(text, vertical)
  };
}

/**
 * The font size at which `text` fits ONE line quad: the line's own pitch
 * (`ownPitch` — the quad's length over the cells its ink spans), never more
 * than its thickness (`cross`). Orientation is judged from the quad itself
 * (taller than wide → vertical), not from the block flag — mokuro mixes
 * orientations inside one block.
 *
 * Shared with the OCR editor (`block-geometry.ts`): a mis-detected 483×697
 * quad holding 8 characters must render at ~88 px (its length over 8 cells),
 * not at its 483 px thickness.
 */
export function fittedLineFontSize(quad: Quad, text: string, measure: TextMeasurer): number {
  const xs = quad.map((p) => p[0]);
  const ys = quad.map((p) => p[1]);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  const vertical = height > width;
  const extents = quadExtents(quad, vertical);
  if (!extents) return Math.max(MIN_FONT_SIZE, vertical ? width : height);
  const own = ownPitch(pitchInput(extents, text, vertical, measure));
  return Math.max(MIN_FONT_SIZE, Math.min(extents.cross, own?.pitch ?? extents.cross));
}

/**
 * Compute per-line positions and font sizes for a block.
 *
 * @param block the OCR block (box, vertical, lines_coords)
 * @param processedLines the text actually rendered (post ellipsis substitution);
 *   must be parallel to block.lines_coords
 * @param measure text advance measurer in em units
 * @returns one layout per line, or null when the block has no usable
 *   lines_coords — callers fall back to legacy block-level rendering
 */
export function layoutLines(
  block: LayoutBlock,
  processedLines: string[],
  measure: TextMeasurer,
  opts?: LayoutOptions
): LineLayout[] | null {
  const coords = block.lines_coords;
  if (!coords || coords.length !== processedLines.length || coords.length === 0) return null;

  // Original mode: the file's size (as far as the quads can carry it), and
  // none of the fit-making below.
  const asFiled = opts?.size === 'file';
  const fileSize =
    asFiled && Number.isFinite(block.font_size) && block.font_size > 0 ? block.font_size : null;

  // First pass: per-line geometry and single-line fitted sizes.
  interface MeasuredLine {
    /** The quad as a turned box: centre, extents in its own frame, angle */
    frame: LineFrame;
    extents: { main: number; cross: number };
    advanceEm: number;
    /** The line as the pitch model sees it */
    input: PitchInput;
    /** The line's place on the fixed-pitch grid: its own until the block's
     * vote, then possibly the block's. Null for a line with no advance. */
    pitch: LinePitch | null;
    /** The size at which the text is as long as the line: its pitch. */
    fitted: number;
    candidate: number;
    suspect: boolean;
    bbox: { minX: number; minY: number; maxX: number; maxY: number };
    hidden: boolean;
    /** Band of an overlap cluster's union bbox this line renders in */
    slice?: { minX: number; minY: number; maxX: number; maxY: number };
  }
  const measured: MeasuredLine[] = [];
  for (let i = 0; i < coords.length; i++) {
    const frame = lineFrame(coords[i], block.vertical);
    if (!frame) return null;
    const extents = { main: frame.main, cross: frame.cross };
    const advanceEm = measure(processedLines[i]);
    const input = pitchInput(extents, processedLines[i], block.vertical, measure);
    const pitch = ownPitch(input);
    // A line is as big as its pitch — NOT `main / advance`, which takes the
    // ink-free ends of the first and last cells for part of the quad and
    // renders 「嫌だ」 at two thirds of the body text beside it.
    const fitted = advanceEm > 0 ? (pitch?.pitch ?? extents.cross) : extents.cross;
    const xs = coords[i].map((p) => p[0]);
    const ys = coords[i].map((p) => p[1]);
    measured.push({
      frame,
      extents,
      advanceEm,
      input,
      pitch,
      fitted,
      candidate: Math.min(extents.cross, fitted),
      // quad wide enough for 1.6+ columns of its own fitted size: likely
      // multiple print columns captured as one OCR "line".
      suspect: advanceEm > 0 && isMergedColumns(extents.cross, fitted),
      bbox: {
        minX: Math.min(...xs),
        minY: Math.min(...ys),
        maxX: Math.max(...xs),
        maxY: Math.max(...ys)
      },
      hidden: false
    });
  }

  // Intra-block overlap handling: the detector sometimes re-captures the
  // same ink region as several overlapping "lines" (a column alone AND a
  // bigger quad spanning it plus its neighbors), which would render stacked.
  // Two cases when one bbox covers most of a smaller one:
  // 1. The smaller line's text is contained in the bigger's → true
  //    re-capture; the smaller hides (bigger wraps the region, no text lost).
  // 2. The texts diverged (hallucination cluster on dense/slanted regions):
  //    the individual placements are garbage but every OCR line must remain
  //    READABLE — the cluster's union bbox is partitioned into reading-order
  //    bands (weighted by text length) and each line wraps in its own band.
  //
  // Two upright quads are compared by their bboxes, as always. When either is
  // TILTED the bbox lies — it grows with the lean, so two parallel slanted
  // columns that share no ink share most of their bboxes and would be
  // "re-captures" of each other — and the quads are compared as the turned
  // boxes they are.
  const bboxArea = (b: MeasuredLine['bbox']) => (b.maxX - b.minX) * (b.maxY - b.minY);
  const tiltedPair = (a: MeasuredLine, b: MeasuredLine) =>
    a.frame.angle !== 0 || b.frame.angle !== 0;
  const inkArea = (m: MeasuredLine, other: MeasuredLine) =>
    tiltedPair(m, other) ? m.extents.main * m.extents.cross : bboxArea(m.bbox);
  const overlapsHeavily = (a: MeasuredLine, b: MeasuredLine) => {
    const smallArea = Math.min(inkArea(a, b), inkArea(b, a));
    if (!(smallArea > 0)) return false;
    if (tiltedPair(a, b)) {
      const shared = rectOverlapArea(
        frameRect(a.frame, block.vertical),
        frameRect(b.frame, block.vertical)
      );
      return shared >= RECAPTURE_OVERLAP * smallArea;
    }
    const ox = Math.max(0, Math.min(a.bbox.maxX, b.bbox.maxX) - Math.max(a.bbox.minX, b.bbox.minX));
    const oy = Math.max(0, Math.min(a.bbox.maxY, b.bbox.maxY) - Math.max(a.bbox.minY, b.bbox.minY));
    return ox * oy >= RECAPTURE_OVERLAP * smallArea;
  };
  // Pass 1: hide true re-captures (text-subsumed duplicates).
  for (let i = 0; i < measured.length; i++) {
    if (measured[i].hidden) continue;
    for (let j = i + 1; j < measured.length; j++) {
      if (measured[i].hidden) break;
      if (measured[j].hidden) continue;
      if (!overlapsHeavily(measured[i], measured[j])) continue;
      const smaller =
        inkArea(measured[i], measured[j]) <= inkArea(measured[j], measured[i]) ? i : j;
      const bigger = smaller === i ? j : i;
      const smallText = processedLines[smaller].trim();
      if (smallText.length > 0 && processedLines[bigger].includes(smallText)) {
        measured[smaller].hidden = true;
      }
    }
  }
  // Pass 2: cluster the remaining diverged overlaps (connected components)
  // and partition each cluster's union bbox into reading-order bands. Not as
  // filed: lines with different text on overlapping quads are what the file
  // says, and each renders on its own quad.
  const clusterOf = measured.map(() => -1);
  let clusterCount = 0;
  for (let i = 0; i < measured.length && !asFiled; i++) {
    if (measured[i].hidden) continue;
    for (let j = i + 1; j < measured.length; j++) {
      if (measured[j].hidden) continue;
      if (!overlapsHeavily(measured[i], measured[j])) continue;
      if (clusterOf[i] < 0 && clusterOf[j] < 0) {
        clusterOf[i] = clusterOf[j] = clusterCount++;
      } else if (clusterOf[i] < 0) {
        clusterOf[i] = clusterOf[j];
      } else if (clusterOf[j] < 0) {
        clusterOf[j] = clusterOf[i];
      } else if (clusterOf[i] !== clusterOf[j]) {
        const from = clusterOf[j];
        for (let k = 0; k < clusterOf.length; k++)
          if (clusterOf[k] === from) clusterOf[k] = clusterOf[i];
      }
    }
  }
  for (let c = 0; c < clusterCount; c++) {
    const cluster = [];
    for (let i = 0; i < measured.length; i++) if (clusterOf[i] === c) cluster.push(i);
    if (cluster.length < 2) continue;
    const union = {
      minX: Math.min(...cluster.map((i) => measured[i].bbox.minX)),
      minY: Math.min(...cluster.map((i) => measured[i].bbox.minY)),
      maxX: Math.max(...cluster.map((i) => measured[i].bbox.maxX)),
      maxY: Math.max(...cluster.map((i) => measured[i].bbox.maxY))
    };
    const weights = cluster.map((i) => Math.max(measured[i].advanceEm, 0.5));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    // vertical text: bands right→left along x; horizontal: top→bottom along y
    let offset = 0;
    for (let k = 0; k < cluster.length; k++) {
      const frac = weights[k] / totalWeight;
      const m = measured[cluster[k]];
      if (block.vertical) {
        const bandW = (union.maxX - union.minX) * frac;
        m.slice = {
          minX: union.maxX - offset - bandW,
          maxX: union.maxX - offset,
          minY: union.minY,
          maxY: union.maxY
        };
        offset += bandW;
      } else {
        const bandH = (union.maxY - union.minY) * frac;
        m.slice = {
          minX: union.minX,
          maxX: union.maxX,
          minY: union.minY + offset,
          maxY: union.minY + offset + bandH
        };
        offset += bandH;
      }
    }
  }

  // Block pitch: the columns of a block are typeset at ONE pitch, and a long
  // column knows it far better than a short line does (`linePitches`). Only
  // lines whose quad is one clean column vote or take the result; their size
  // follows their pitch, so a short line is sized like the body around it.
  const pitches = linePitches(
    measured.map((m, i) => ({
      ...m.input,
      votes: !m.hidden && !m.slice && !m.suspect && griddable(processedLines[i])
    }))
  );
  measured.forEach((m, i) => {
    const pitch = pitches[i];
    if (!pitch || pitch.pitch === m.pitch?.pitch) return;
    m.pitch = pitch;
    m.fitted = pitch.pitch;
    m.candidate = Math.min(m.extents.cross, m.fitted);
  });

  // Original mode's sizes, from the pitches just settled.
  const fileSizes =
    fileSize === null
      ? null
      : fileLineSizes(
          fileSize,
          measured.map((m) => ({
            cap: m.hidden
              ? null
              : Math.min(
                  m.extents.cross * CROSS_SLACK,
                  m.pitch
                    ? maxSizeAtSpacing({
                        pitch: m.pitch,
                        advanceEm: m.advanceEm,
                        count: m.input.count,
                        minSpacingEm: FILE_MIN_SPACING_EM
                      })
                    : Number.POSITIVE_INFINITY
                ),
            cells: m.pitch ? m.advanceEm - m.pitch.lead - m.pitch.trail : 0,
            area: m.extents.main * m.extents.cross,
            body: !m.suspect
          }))
        );

  // Block reference size: print keeps one size per balloon, so all lines
  // render uniformly at the size the trustworthy lines agree on. Exclude
  // merged-columns suspects (their fitted size is artificially small), then
  // deliberately-small lines (standalone furigana, asides). Lines vote with
  // their quad ink area: a big base line must not be outvoted by the small
  // ruby fragments split around it (Killing Bites 01 p42 「百獣王」).
  const area = (m: MeasuredLine) => m.extents.main * m.extents.cross;
  const visible = measured.filter((m) => !m.hidden && !m.slice);
  const clean = visible.filter((m) => !m.suspect);
  const refPool = clean.length ? clean : visible.length ? visible : measured;
  const refBase = weightedMedian(
    refPool.map((m) => m.candidate),
    refPool.map(area)
  );
  const consensus = visible.filter((m) => !m.suspect && m.candidate >= SMALL_OUTLIER * refBase);
  const consensusSizes = consensus.map((m) => m.candidate);
  const referenceSize = consensus.length
    ? weightedMedian(consensusSizes, consensus.map(area))
    : refBase;

  // With no clean lines (e.g. a whole balloon captured as ONE quad+line),
  // the reference derives from the suspect line itself, so it cannot gate
  // the wrap — let geometry find the optimal column layout instead.
  const hasCleanLines = clean.length > 0;
  const wrapStart = hasCleanLines ? referenceSize : Number.POSITIVE_INFINITY;
  const wraps = measured.map(
    (m) =>
      // as filed, a merged-columns suspect is one long run on its quad
      !asFiled &&
      !m.hidden &&
      !m.slice &&
      m.suspect &&
      (m.fitted < WRAP_SHRINK * referenceSize || !hasCleanLines) &&
      wrapFitSize(wrapStart, m.advanceEm, m.extents.main, m.extents.cross) >= WRAP_GAIN * m.fitted
  );

  // When ≥2 clean lines agree on the size, that consensus IS the block size.
  // Otherwise (0-1 clean lines: low information), wrapped lines may need to
  // step below the reference to fit their quad, and the block follows so
  // every line still shares one size.
  const trustConsensus =
    consensusSizes.length >= 2 &&
    Math.max(...consensusSizes) <= CONSENSUS_SPREAD * Math.min(...consensusSizes);
  let uniformSize = referenceSize;
  if (!trustConsensus) {
    for (let i = 0; i < measured.length; i++) {
      if (wraps[i]) {
        const m = measured[i];
        uniformSize = Math.min(
          uniformSize,
          wrapFitSize(referenceSize, m.advanceEm, m.extents.main, m.extents.cross)
        );
      }
    }
  }

  const layouts: LineLayout[] = [];
  for (let i = 0; i < coords.length; i++) {
    const { extents, advanceEm, candidate, bbox, hidden } = measured[i];
    const minX = bbox.minX - block.box[0];
    const minY = bbox.minY - block.box[1];
    const maxX = bbox.maxX - block.box[0];
    const maxY = bbox.maxY - block.box[1];
    const width = maxX - minX;
    const height = maxY - minY;

    if (hidden) {
      layouts.push({
        left: minX,
        top: minY,
        fontSize: MIN_FONT_SIZE,
        wrap: false,
        width,
        height,
        ...UPRIGHT,
        hidden: true
      });
      continue;
    }

    const slice = measured[i].slice;
    if (slice) {
      // overlap-cluster member: wrap the text inside its band of the union
      const sliceW = slice.maxX - slice.minX;
      const sliceH = slice.maxY - slice.minY;
      const main = block.vertical ? sliceH : sliceW;
      const cross = block.vertical ? sliceW : sliceH;
      const fontSize = Math.max(
        MIN_FONT_SIZE,
        wrapFitSize(Number.POSITIVE_INFINITY, advanceEm, main, cross)
      );
      layouts.push({
        left: slice.minX - block.box[0],
        top: slice.minY - block.box[1],
        fontSize,
        wrap: true,
        width: sliceW,
        height: sliceH,
        ...UPRIGHT
      });
      continue;
    }

    if (wraps[i]) {
      const fontSize = Math.max(
        MIN_FONT_SIZE,
        wrapFitSize(hasCleanLines ? uniformSize : wrapStart, advanceEm, extents.main, extents.cross)
      );
      layouts.push({ left: minX, top: minY, fontSize, wrap: true, width, height, ...UPRIGHT });
      continue;
    }

    // Use the uniform size when this line's quad can carry it (allowing for
    // per-quad slack); otherwise fall back to the line's own fitted size
    // (deliberately-small print such as furigana lines, or quads far too
    // tight for the block consensus).
    const fitsUniform =
      uniformSize <= measured[i].fitted * OVERFLOW_TOL &&
      uniformSize <= extents.cross * CROSS_SLACK &&
      candidate >= SMALL_OUTLIER * refBase;
    const fontSize = Math.max(
      MIN_FONT_SIZE,
      fileSizes?.[i] ?? (fitsUniform ? uniformSize : candidate)
    );

    // Reading axis: anchor at the quad start (top for vertical, left for
    // horizontal). Cross axis: center the rendered column/row in the quad —
    // quads are often wider than the glyphs (attached ruby, mask slack, empty
    // margin) and the base glyphs sit near the middle; edge-anchoring can
    // shove a column into its neighbor's space.
    layouts.push({
      left: block.vertical ? (minX + maxX) / 2 - fontSize / 2 : minX,
      top: block.vertical ? minY : (minY + maxY) / 2 - fontSize / 2,
      fontSize,
      wrap: false,
      width,
      height,
      ...UPRIGHT
    });
  }

  const model = collisionModel(block, layouts, measured, wraps);

  // Rotation. A clean single line whose quad is tilted renders in the quad's
  // own frame: a main × cross box centred on the quad's centre, turned by the
  // quad's angle. Only lines whose placement involved no guessing (trust 2)
  // turn — a wrapped, banded or merged-columns line lives in an axis-aligned
  // container that was a guess to begin with.
  //
  // The no-overlap machinery below is axis-aligned, so a rotated line is
  // admitted only if its turned rectangle is clear of every other clean line
  // as rendered; one that is not falls back to the upright layout it had until
  // now (both of them, if both are turned) and takes part in the nudging and
  // clipping like before. Every fallback is a line that stops being rotated,
  // so this settles in at most one pass per line.
  //
  // As filed there are no guessed containers and nothing arbitrates overlaps,
  // so every visible line turns with its quad, whatever it then touches.
  const upright = layouts.slice();
  for (let i = 0; i < layouts.length; i++) {
    const { frame } = measured[i];
    if (frame.angle === 0 || (asFiled ? layouts[i].hidden : model.trust[i] !== 2)) continue;
    const width = block.vertical ? frame.cross : frame.main;
    const height = block.vertical ? frame.main : frame.cross;
    layouts[i] = {
      ...upright[i],
      left: frame.cx - block.box[0] - width / 2,
      top: frame.cy - block.box[1] - height / 2,
      width,
      height,
      rotation: frame.angle,
      inset: 0
    };
  }
  if (!asFiled) {
    for (let settled = false; !settled; ) {
      settled = true;
      for (let i = 0; i < layouts.length; i++) {
        if (!layouts[i].rotation) continue;
        for (let j = 0; j < layouts.length; j++) {
          if (j === i || model.trust[j] !== 2 || !model.rectsHit(i, j)) continue;
          layouts[i] = upright[i];
          if (layouts[j].rotation) layouts[j] = upright[j];
          settled = false;
          break;
        }
      }
    }
    enforceNoOverlap(layouts, model);
  }

  // The fixed-pitch grid, last: it needs the sizes the clipping above settled
  // on. Wrapped (so also banded) and hidden lines have no single run to space.
  for (let i = 0; i < layouts.length; i++) {
    const l = layouts[i];
    const pitch = measured[i].pitch;
    if (l.hidden || l.wrap || !pitch || !griddable(processedLines[i])) continue;
    const grid = gridSpacing({
      pitch,
      advanceEm: measured[i].advanceEm,
      fontSize: l.fontSize,
      count: spacingUnits(processedLines[i])
    });
    if (!grid) continue;
    l.letterSpacing = grid.letterSpacing;
    l.inset = grid.inset;
    // Spreading a run out makes it longer than the text the overlap pass just
    // cleared. If that reaches a neighbour (quads overlapping end to end), the
    // line keeps the unspaced run it had. A rotated line was admitted at its
    // full length, and closing a run up only ever shortens it. (As filed no
    // overlap pass ran, and none is made up for here.)
    if (grid.letterSpacing > 0 && !l.rotation && !asFiled) {
      for (let j = 0; j < layouts.length; j++) {
        if (j === i || model.collision(i, j) <= OVERLAP_EPS) continue;
        l.letterSpacing = 0;
        l.inset = 0;
        break;
      }
    }
  }

  return layouts;
}

/** A line's quad as the turned box it is, in page px. */
function frameRect(frame: LineFrame, vertical: boolean): OrientedRect {
  return {
    cx: frame.cx,
    cy: frame.cy,
    width: vertical ? frame.cross : frame.main,
    height: vertical ? frame.main : frame.cross,
    angle: frame.angle
  };
}

/** What every line that is neither rotated nor on the grid carries. */
const UPRIGHT = { rotation: 0, letterSpacing: 0, inset: 0 } as const;

/** Overlaps up to this much are treated as already separate (float slop). */
const OVERLAP_EPS = 0.5;

type Span = [number, number];

interface CollisionModel {
  vertical: boolean;
  /** 2 = clean, correctly-placed column; 1 = suspect/wrapped/banded (its
   * placement already involved guessing); -1 = hidden. Only a 2 is ever
   * rotated. */
  trust: number[];
  quadSpan(i: number): Span;
  crossSpan(i: number): Span;
  mainSpan(i: number): Span;
  /** Do the two lines' rendered rectangles overlap, rotation included? */
  rectsHit(i: number, j: number): boolean;
  /** Cross-axis overlap when the rendered rects truly intersect, else 0. */
  collision(i: number, j: number): number;
  advanceEm(i: number): number;
}

const spanOverlap = (a: Span, b: Span) => Math.min(a[1], b[1]) - Math.max(a[0], b[0]);

/**
 * Where each line actually paints, for the overlap rules. Reads `layouts`
 * live, so it follows every nudge, clip and fallback made after it is built.
 *
 * An upright line is the axis-aligned rect it has always been. A ROTATED line
 * is its turned rectangle for the yes/no question (`rectsHit`) — its bbox
 * grows with the lean and would collide with neighbours it is nowhere near —
 * and the bbox of that rectangle for the spans, which is what a lower-trust
 * line is clipped around: conservative, never a new overlap.
 */
function collisionModel(
  block: LayoutBlock,
  layouts: LineLayout[],
  measured: {
    extents: { main: number; cross: number };
    advanceEm: number;
    input: PitchInput;
    pitch: LinePitch | null;
    suspect: boolean;
    bbox: { minX: number; minY: number; maxX: number; maxY: number };
    hidden: boolean;
    slice?: unknown;
  }[],
  wraps: boolean[]
): CollisionModel {
  const vertical = block.vertical;
  const trust = measured.map((m, i) => (m.hidden ? -1 : m.suspect || wraps[i] || m.slice ? 1 : 2));

  const advance = (i: number) => measured[i].advanceEm * layouts[i].fontSize;

  const rendered = (i: number): OrientedRect => {
    const l = layouts[i];
    if (l.rotation) {
      // The whole main extent even when the text is shorter: the grid is
      // about to spread the run over it.
      const length = Math.max(measured[i].extents.main, advance(i));
      return {
        cx: l.left + l.width / 2,
        cy: l.top + l.height / 2,
        width: vertical ? l.fontSize : length,
        height: vertical ? length : l.fontSize,
        angle: l.rotation
      };
    }
    const cross = crossSpan(i);
    const main = mainSpan(i);
    const [x, y] = vertical ? [cross, main] : [main, cross];
    return {
      cx: (x[0] + x[1]) / 2,
      cy: (y[0] + y[1]) / 2,
      width: x[1] - x[0],
      height: y[1] - y[0],
      angle: 0
    };
  };
  const crossSpan = (i: number): Span => {
    const l = layouts[i];
    if (l.rotation) {
      const b = rectBounds(rendered(i));
      return vertical ? [b.minX, b.maxX] : [b.minY, b.maxY];
    }
    if (l.wrap) return vertical ? [l.left, l.left + l.width] : [l.top, l.top + l.height];
    return vertical ? [l.left, l.left + l.fontSize] : [l.top, l.top + l.fontSize];
  };
  const mainSpan = (i: number): Span => {
    const l = layouts[i];
    if (l.rotation) {
      const b = rectBounds(rendered(i));
      return vertical ? [b.minY, b.maxY] : [b.minX, b.maxX];
    }
    if (l.wrap) return vertical ? [l.top, l.top + l.height] : [l.left, l.left + l.width];
    const start = vertical ? l.top : l.left;
    // On the grid the INK runs from the line's start edge for as long as the
    // text is at its pitch — the quad's own length unless the block's pitch
    // moved the end. (The run's box starts earlier and ends later by the
    // ink-free parts of its end cells, which collide with nothing.)
    const m = measured[i];
    if (l.letterSpacing > 0 && m.pitch) {
      const length = inkLength(
        { ...m.input, lead: m.pitch.lead, trail: m.pitch.trail },
        m.pitch.pitch
      );
      return [start, start + length];
    }
    return [start, start + advance(i)];
  };
  const rectsHit = (i: number, j: number) => {
    if (trust[i] < 0 || trust[j] < 0) return false;
    return rectsCollide(rendered(i), rendered(j), OVERLAP_EPS);
  };
  const collision = (i: number, j: number): number => {
    if (trust[i] < 0 || trust[j] < 0) return 0;
    if ((layouts[i].rotation || layouts[j].rotation) && !rectsHit(i, j)) return 0;
    if (spanOverlap(mainSpan(i), mainSpan(j)) <= OVERLAP_EPS) return 0;
    return spanOverlap(crossSpan(i), crossSpan(j));
  };
  const quadSpan = (k: number): Span => {
    const q = measured[k].bbox;
    return vertical
      ? [q.minX - block.box[0], q.maxX - block.box[0]]
      : [q.minY - block.box[1], q.maxY - block.box[1]];
  };
  return {
    vertical,
    trust,
    quadSpan,
    crossSpan,
    mainSpan,
    rectsHit,
    collision,
    advanceEm: (i) => measured[i].advanceEm
  };
}

/**
 * Final invariant: rendered text must never overlap — whatever the quads
 * claim, two visible lines painting the same pixels is a wrong layout
 * (OPM 28 p136/p176: offset re-captures under the RECAPTURE_OVERLAP gate,
 * and a slant-inflated suspect bbox swallowing its clean neighbors).
 *
 * Clean single-column lines hold their ground; suspect/wrapped/banded lines
 * are clipped around every clean rect they touch and re-wrap in the widest
 * space that remains — for a slant-inflated quad that recovers the true
 * column between its neighbors. Equal-trust collisions first try nudging
 * apart within their own quads (uniform size preserved; first round only,
 * since nudging is the one move that claims new ground), then split the
 * contested span at its midpoint. Every clip yields a subset of the previous
 * extent, so resolution never creates a new overlap and converges.
 *
 * A ROTATED line is never moved, clipped or put in a wrap container: it was
 * admitted only because it is clear of every other clean line, so here it is
 * just one more clean rect the lower-trust lines yield to (around the bbox of
 * its turned rectangle, and only when they really cross it).
 */
function enforceNoOverlap(layouts: LineLayout[], model: CollisionModel): void {
  const { vertical, trust, crossSpan, collision, quadSpan } = model;
  /** Clip line i's cross extent to `span` and refit its text inside. */
  const setCrossSpan = (i: number, span: Span) => {
    const l = layouts[i];
    const size = Math.max(span[1] - span[0], MIN_FONT_SIZE);
    if (l.wrap) {
      const main = vertical ? l.height : l.width;
      l.fontSize = Math.max(MIN_FONT_SIZE, wrapFitSize(l.fontSize, model.advanceEm(i), main, size));
      if (vertical) {
        l.left = span[0];
        l.width = size;
      } else {
        l.top = span[0];
        l.height = size;
      }
    } else {
      l.fontSize = Math.min(l.fontSize, size);
      const center = (span[0] + span[1]) / 2;
      if (vertical) l.left = center - l.fontSize / 2;
      else l.top = center - l.fontSize / 2;
    }
  };

  for (let iter = 0; iter < 4; iter++) {
    let dirty = false;

    // Lower-trust lines yield to every clean rect they touch: subtract all
    // of them from the line's extent and keep the widest surviving gap.
    for (let i = 0; i < layouts.length; i++) {
      if (trust[i] !== 1) continue;
      const mine = crossSpan(i);
      let segments: Span[] = [mine];
      let clipped = false;
      for (let j = 0; j < layouts.length; j++) {
        if (trust[j] !== 2 || collision(i, j) <= OVERLAP_EPS) continue;
        const other = crossSpan(j);
        const next: Span[] = [];
        for (const s of segments) {
          if (other[0] > s[0]) next.push([s[0], Math.min(s[1], other[0])]);
          if (other[1] < s[1]) next.push([Math.max(s[0], other[1]), s[1]]);
        }
        segments = next;
        clipped = true;
      }
      if (!clipped) continue;
      segments.sort((a, b) => b[1] - b[0] - (a[1] - a[0]));
      setCrossSpan(i, segments[0] ?? [mine[0], mine[0] + MIN_FONT_SIZE]);
      dirty = true;
    }

    // Equal-trust collisions: nudge apart within the quads' own slack on the
    // first round, else split the contested span at its midpoint.
    for (let i = 0; i < layouts.length; i++) {
      for (let j = i + 1; j < layouts.length; j++) {
        if (trust[i] < 0 || trust[i] !== trust[j]) continue;
        // admitted clear of every clean line, and not ours to move
        if (layouts[i].rotation || layouts[j].rotation) continue;
        const overlap = collision(i, j);
        if (overlap <= OVERLAP_EPS) continue;
        const a = crossSpan(i);
        const b = crossSpan(j);
        const [lo, hi] = a[0] + a[1] <= b[0] + b[1] ? [i, j] : [j, i];
        const loSpan = lo === i ? a : b;
        const hiSpan = hi === i ? a : b;
        const loSlack = Math.max(0, loSpan[0] - quadSpan(lo)[0]);
        const hiSlack = Math.max(0, quadSpan(hi)[1] - hiSpan[1]);
        if (iter === 0 && !layouts[lo].wrap && !layouts[hi].wrap && loSlack + hiSlack >= overlap) {
          const shiftLo = Math.min(loSlack, Math.max(overlap / 2, overlap - hiSlack));
          const shiftHi = overlap - shiftLo;
          if (vertical) {
            layouts[lo].left -= shiftLo;
            layouts[hi].left += shiftHi;
          } else {
            layouts[lo].top -= shiftLo;
            layouts[hi].top += shiftHi;
          }
        } else {
          const mid = (Math.max(loSpan[0], hiSpan[0]) + Math.min(loSpan[1], hiSpan[1])) / 2;
          setCrossSpan(lo, [loSpan[0], mid]);
          setCrossSpan(hi, [mid, hiSpan[1]]);
        }
        dirty = true;
      }
    }

    if (!dirty) break;
  }
}
