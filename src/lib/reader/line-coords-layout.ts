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
    /** Band of an overlap cluster's union bbox this line renders in */
    slice?: { minX: number; minY: number; maxX: number; maxY: number };
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
  const bboxArea = (b: MeasuredLine['bbox']) => (b.maxX - b.minX) * (b.maxY - b.minY);
  const overlapsHeavily = (a: MeasuredLine['bbox'], b: MeasuredLine['bbox']) => {
    const ox = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
    const oy = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
    const smallArea = Math.min(bboxArea(a), bboxArea(b));
    return smallArea > 0 && ox * oy >= RECAPTURE_OVERLAP * smallArea;
  };
  // Pass 1: hide true re-captures (text-subsumed duplicates).
  for (let i = 0; i < measured.length; i++) {
    if (measured[i].hidden) continue;
    for (let j = i + 1; j < measured.length; j++) {
      if (measured[i].hidden) break;
      if (measured[j].hidden) continue;
      if (!overlapsHeavily(measured[i].bbox, measured[j].bbox)) continue;
      const smaller = bboxArea(measured[i].bbox) <= bboxArea(measured[j].bbox) ? i : j;
      const bigger = smaller === i ? j : i;
      const smallText = processedLines[smaller].trim();
      if (smallText.length > 0 && processedLines[bigger].includes(smallText)) {
        measured[smaller].hidden = true;
      }
    }
  }
  // Pass 2: cluster the remaining diverged overlaps (connected components)
  // and partition each cluster's union bbox into reading-order bands.
  const clusterOf = measured.map(() => -1);
  let clusterCount = 0;
  for (let i = 0; i < measured.length; i++) {
    if (measured[i].hidden) continue;
    for (let j = i + 1; j < measured.length; j++) {
      if (measured[j].hidden) continue;
      if (!overlapsHeavily(measured[i].bbox, measured[j].bbox)) continue;
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
    const members = [];
    for (let i = 0; i < measured.length; i++) if (clusterOf[i] === c) members.push(i);
    if (members.length < 2) continue;
    const union = {
      minX: Math.min(...members.map((i) => measured[i].bbox.minX)),
      minY: Math.min(...members.map((i) => measured[i].bbox.minY)),
      maxX: Math.max(...members.map((i) => measured[i].bbox.maxX)),
      maxY: Math.max(...members.map((i) => measured[i].bbox.maxY))
    };
    const weights = members.map((i) => Math.max(measured[i].advanceEm, 0.5));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    // vertical text: bands right→left along x; horizontal: top→bottom along y
    let offset = 0;
    for (let k = 0; k < members.length; k++) {
      const frac = weights[k] / totalWeight;
      const m = measured[members[k]];
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
        height: sliceH
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

  enforceNoOverlap(block, layouts, measured, wraps);
  return layouts;
}

/** Overlaps up to this much are treated as already separate (float slop). */
const OVERLAP_EPS = 0.5;

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
 */
function enforceNoOverlap(
  block: LayoutBlock,
  layouts: LineLayout[],
  measured: {
    advanceEm: number;
    suspect: boolean;
    bbox: { minX: number; minY: number; maxX: number; maxY: number };
    hidden: boolean;
    slice?: unknown;
  }[],
  wraps: boolean[]
): void {
  const vertical = block.vertical;
  type Span = [number, number];
  // 2 = clean, correctly-placed column; 1 = suspect/wrapped/banded (its
  // placement already involved guessing); -1 = hidden.
  const trust = measured.map((m, i) => (m.hidden ? -1 : m.suspect || wraps[i] || m.slice ? 1 : 2));

  const crossSpan = (i: number): Span => {
    const l = layouts[i];
    if (l.wrap) return vertical ? [l.left, l.left + l.width] : [l.top, l.top + l.height];
    return vertical ? [l.left, l.left + l.fontSize] : [l.top, l.top + l.fontSize];
  };
  const mainSpan = (i: number): Span => {
    const l = layouts[i];
    if (l.wrap) return vertical ? [l.top, l.top + l.height] : [l.left, l.left + l.width];
    const advance = measured[i].advanceEm * l.fontSize;
    return vertical ? [l.top, l.top + advance] : [l.left, l.left + advance];
  };
  const spanOverlap = (a: Span, b: Span) => Math.min(a[1], b[1]) - Math.max(a[0], b[0]);
  /** Cross-axis overlap when the rendered rects truly intersect, else 0. */
  const collision = (i: number, j: number): number => {
    if (trust[i] < 0 || trust[j] < 0) return 0;
    if (spanOverlap(mainSpan(i), mainSpan(j)) <= OVERLAP_EPS) return 0;
    return spanOverlap(crossSpan(i), crossSpan(j));
  };
  /** Clip line i's cross extent to `span` and refit its text inside. */
  const setCrossSpan = (i: number, span: Span) => {
    const l = layouts[i];
    const size = Math.max(span[1] - span[0], MIN_FONT_SIZE);
    if (l.wrap) {
      const main = vertical ? l.height : l.width;
      l.fontSize = Math.max(
        MIN_FONT_SIZE,
        wrapFitSize(l.fontSize, measured[i].advanceEm, main, size)
      );
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
        const overlap = collision(i, j);
        if (overlap <= OVERLAP_EPS) continue;
        const a = crossSpan(i);
        const b = crossSpan(j);
        const [lo, hi] = a[0] + a[1] <= b[0] + b[1] ? [i, j] : [j, i];
        const loSpan = lo === i ? a : b;
        const hiSpan = hi === i ? a : b;
        const quadSpan = (k: number): Span => {
          const q = measured[k].bbox;
          return vertical
            ? [q.minX - block.box[0], q.maxX - block.box[0]]
            : [q.minY - block.box[1], q.maxY - block.box[1]];
        };
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
