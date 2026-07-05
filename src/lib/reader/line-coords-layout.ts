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
}

/**
 * Guard against zero/NaN font sizes, not readability: hallucinated OCR lines
 * (text far longer than the quad) must stay contained in their quad, so the
 * computed size may be legitimately sub-pixel.
 */
const MIN_FONT_SIZE = 0.5;

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

  const layouts: LineLayout[] = [];
  for (let i = 0; i < coords.length; i++) {
    const extents = quadExtents(coords[i], block.vertical);
    if (!extents) return null;
    const advanceEm = measure(processedLines[i]);
    const fitted = advanceEm > 0 ? extents.main / advanceEm : extents.cross;
    const fontSize = Math.max(MIN_FONT_SIZE, Math.min(extents.cross, fitted));
    const xs = coords[i].map((p) => p[0]);
    const ys = coords[i].map((p) => p[1]);
    // Reading axis: anchor at the quad start (top for vertical, left for
    // horizontal). Cross axis: center the rendered column/row in the quad —
    // quads are often wider than the glyphs (attached ruby, mask slack, empty
    // margin) and the base glyphs sit near the middle; edge-anchoring can
    // shove a column into its neighbor's space.
    const minX = Math.min(...xs) - block.box[0];
    const minY = Math.min(...ys) - block.box[1];
    const maxX = Math.max(...xs) - block.box[0];
    const maxY = Math.max(...ys) - block.box[1];
    layouts.push({
      left: block.vertical ? (minX + maxX) / 2 - fontSize / 2 : minX,
      top: block.vertical ? minY : (minY + maxY) / 2 - fontSize / 2,
      fontSize
    });
  }
  return layouts;
}
