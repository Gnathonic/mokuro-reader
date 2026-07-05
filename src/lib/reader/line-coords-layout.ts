/**
 * Per-line layout for original-mode text rendering, derived from the
 * `lines_coords` quadrilaterals that mokuro emits for every OCR line.
 *
 * mokuro's block-level `font_size` is the mean detected line-quad width, which
 * for vertical Japanese includes furigana and mask slack — median 1.2x (p95 2x)
 * larger than the true character size — so rendering `font_size`px overflows
 * the block box. The quads themselves are reliable: each line's quad gives its
 * exact position and extent, and `extent / text advance` recovers the true
 * per-line font size. See docs/superpowers/specs/
 * 2026-07-04-original-mode-line-coords-design.md.
 */

/** One OCR line quad: 4 corner points, [x, y] each, in page pixels. */
export type Quad = number[][];

/** Advance of a text string in em units (width at font-size 1). */
export type TextMeasurer = (text: string) => number;

export interface LayoutBlock {
  box: number[];
  vertical: boolean;
  font_size: number;
  lines: string[];
  lines_coords?: Quad[];
}

export interface LineLayout {
  /** px, relative to the block box origin */
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
  /** Quad bbox dims, px — the wrapping container for wrap lines */
  width: number;
  height: number;
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
/** A line fitting below this fraction of the reference is deliberately small
 * print (standalone furigana, asides): it keeps its own size. */
const SMALL_OUTLIER = 0.7;
/** Lines may run this much past their own quad's length at the uniform size —
 * quad slack varies line to line while print size is constant. */
const OVERFLOW_TOL = 1.15;
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
    if (ctx) ctx.font = `100px ${fontFamily}`;
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
function quadExtents(quad: Quad, vertical: boolean): { main: number; cross: number } | null {
  if (!Array.isArray(quad) || quad.length !== 4) return null;
  for (const p of quad) {
    if (!Array.isArray(p) || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
      return null;
    }
  }
  const [p0, p1, p2, p3] = quad;
  const hx = (p1[0] + p2[0]) / 2 - (p0[0] + p3[0]) / 2;
  const hy = (p1[1] + p2[1]) / 2 - (p0[1] + p3[1]) / 2;
  const vx = (p2[0] + p3[0]) / 2 - (p0[0] + p1[0]) / 2;
  const vy = (p2[1] + p3[1]) / 2 - (p0[1] + p1[1]) / 2;
  const h = Math.hypot(hx, hy);
  const v = Math.hypot(vx, vy);
  if (h <= 0 || v <= 0) return null;
  return vertical ? { main: v, cross: h } : { main: h, cross: v };
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
  measure: TextMeasurer
): LineLayout[] | null {
  const coords = block.lines_coords;
  if (!coords || coords.length !== processedLines.length || coords.length === 0) return null;

  // First pass: per-line geometry and single-line fitted sizes.
  interface MeasuredLine {
    extents: { main: number; cross: number };
    advanceEm: number;
    fitted: number;
    candidate: number;
    suspect: boolean;
    bbox: { minX: number; minY: number; maxX: number; maxY: number };
    hidden: boolean;
  }
  const measured: MeasuredLine[] = [];
  for (let i = 0; i < coords.length; i++) {
    const extents = quadExtents(coords[i], block.vertical);
    if (!extents) return null;
    const advanceEm = measure(processedLines[i]);
    const fitted = advanceEm > 0 ? extents.main / advanceEm : extents.cross;
    const xs = coords[i].map((p) => p[0]);
    const ys = coords[i].map((p) => p[1]);
    measured.push({
      extents,
      advanceEm,
      fitted,
      candidate: Math.min(extents.cross, fitted),
      // quad wide enough for 1.6+ columns of its own fitted size: likely
      // multiple print columns captured as one OCR "line"
      suspect: advanceEm > 0 && extents.cross >= SUSPECT_RATIO * fitted,
      bbox: {
        minX: Math.min(...xs),
        minY: Math.min(...ys),
        maxX: Math.max(...xs),
        maxY: Math.max(...ys)
      },
      hidden: false
    });
  }

  // Intra-block overlap dedupe: the detector sometimes re-captures the same
  // ink region as several overlapping "lines" (a column alone AND a bigger
  // quad spanning it plus its neighbors), which would render stacked. When
  // one bbox covers most of a smaller one: if the smaller line's text is
  // contained in the bigger's, the smaller is a re-capture and hides (the
  // bigger wraps over the full region, no text lost); otherwise the texts
  // diverged (hallucination cluster) and the enclosing blob hides, keeping
  // the precise small captures.
  const bboxArea = (b: MeasuredLine['bbox']) => (b.maxX - b.minX) * (b.maxY - b.minY);
  for (let i = 0; i < measured.length; i++) {
    if (measured[i].hidden) continue;
    for (let j = i + 1; j < measured.length; j++) {
      if (measured[i].hidden) break;
      if (measured[j].hidden) continue;
      const a = measured[i].bbox;
      const b = measured[j].bbox;
      const ox = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
      const oy = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
      const smallArea = Math.min(bboxArea(a), bboxArea(b));
      if (smallArea <= 0 || ox * oy < RECAPTURE_OVERLAP * smallArea) continue;
      const smaller = bboxArea(a) <= bboxArea(b) ? i : j;
      const bigger = smaller === i ? j : i;
      const smallText = processedLines[smaller].trim();
      const dropSmaller = smallText.length > 0 && processedLines[bigger].includes(smallText);
      measured[dropSmaller ? smaller : bigger].hidden = true;
    }
  }

  // Block reference size: print keeps one size per balloon, so all lines
  // render uniformly at the size the trustworthy lines agree on. Exclude
  // merged-columns suspects (their fitted size is artificially small), then
  // deliberately-small lines (standalone furigana, asides). Lines vote with
  // their quad ink area: a big base line must not be outvoted by the small
  // ruby fragments split around it (Killing Bites 01 p42 「百獣王」).
  const area = (m: MeasuredLine) => m.extents.main * m.extents.cross;
  const visible = measured.filter((m) => !m.hidden);
  const clean = visible.filter((m) => !m.suspect);
  const refPool = clean.length ? clean : visible;
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
      !m.hidden &&
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
        hidden: true
      });
      continue;
    }

    if (wraps[i]) {
      const fontSize = Math.max(
        MIN_FONT_SIZE,
        wrapFitSize(hasCleanLines ? uniformSize : wrapStart, advanceEm, extents.main, extents.cross)
      );
      layouts.push({ left: minX, top: minY, fontSize, wrap: true, width, height });
      continue;
    }

    // Use the uniform size when this line's quad can carry it (allowing for
    // per-quad slack); otherwise fall back to the line's own fitted size
    // (deliberately-small print such as furigana lines, or quads far too
    // tight for the block consensus).
    const fitsUniform =
      uniformSize * advanceEm <= extents.main * OVERFLOW_TOL &&
      uniformSize <= extents.cross * 1.2 &&
      candidate >= SMALL_OUTLIER * refBase;
    const fontSize = Math.max(MIN_FONT_SIZE, fitsUniform ? uniformSize : candidate);

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
      height
    });
  }
  return layouts;
}
