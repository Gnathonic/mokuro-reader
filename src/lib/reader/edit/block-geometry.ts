/**
 * Geometry helpers shared by the OCR edit operations (`edit-ops.ts`). Pure,
 * image-pixel space, no DOM.
 */
import {
  fittedLineFontSize,
  getDefaultMeasurer,
  type TextMeasurer
} from '$lib/reader/line-coords-layout';

export type Box = [number, number, number, number];

const MIN_FONT = 8;
const MAX_FONT = 200;

/** Clamp a box to the image, re-order inverted corners, keep ≥ 1px extent. */
export function clampBox(box: number[], width: number, height: number): Box {
  let [x0, y0, x1, y1] = box;
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 < y0) [y0, y1] = [y1, y0];
  x0 = Math.min(Math.max(0, x0), width);
  x1 = Math.min(Math.max(0, x1), width);
  y0 = Math.min(Math.max(0, y0), height);
  y1 = Math.min(Math.max(0, y1), height);
  if (x1 - x0 < 1) x1 = Math.min(width, x0 + 1);
  if (x1 - x0 < 1) x0 = Math.max(0, x1 - 1);
  if (y1 - y0 < 1) y1 = Math.min(height, y0 + 1);
  if (y1 - y0 < 1) y0 = Math.max(0, y1 - 1);
  return [x0, y0, x1, y1];
}

export function translateQuads(
  quads: number[][][] | undefined,
  dx: number,
  dy: number
): number[][][] | undefined {
  if (!quads) return undefined;
  return quads.map((quad) => quad.map(([x, y]) => [x + dx, y + dy]));
}

/** Map every quad point affinely from box `from` onto box `to`. */
export function scaleQuads(
  quads: number[][][] | undefined,
  from: Box,
  to: Box
): number[][][] | undefined {
  if (!quads) return undefined;
  const fw = from[2] - from[0] || 1;
  const fh = from[3] - from[1] || 1;
  const sx = (to[2] - to[0]) / fw;
  const sy = (to[3] - to[1]) / fh;
  return quads.map((quad) =>
    quad.map(([x, y]) => [to[0] + (x - from[0]) * sx, to[1] + (y - from[1]) * sy])
  );
}

export function unionBox(boxes: number[][]): Box {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const [a, b, c, d] of boxes) {
    x0 = Math.min(x0, a);
    y0 = Math.min(y0, b);
    x1 = Math.max(x1, c);
    y1 = Math.max(y1, d);
  }
  return [x0, y0, x1, y1];
}

function quadBox(quad: number[][]): Box {
  return unionBox(quad.map(([x, y]) => [x, y, x, y]));
}

/**
 * Split `box` between lines `atLine-1` and `atLine`. Vertical text reads
 * right-to-left, so the FIRST group keeps the right side. With quads the cut
 * is midway between the two groups' nearest edges; otherwise proportional to
 * line count.
 */
export function splitBoxAtLine(
  box: Box,
  vertical: boolean,
  atLine: number,
  lineCount: number,
  quads?: number[][][]
): [Box, Box] {
  const [x0, y0, x1, y1] = box;
  if (quads && quads.length === lineCount && atLine > 0 && atLine < lineCount) {
    const first = quads.slice(0, atLine).map(quadBox);
    const second = quads.slice(atLine).map(quadBox);
    if (vertical) {
      const firstMin = Math.min(...first.map((b) => b[0]));
      const secondMax = Math.max(...second.map((b) => b[2]));
      const cut = (firstMin + secondMax) / 2;
      return [
        [cut, y0, x1, y1],
        [x0, y0, cut, y1]
      ];
    }
    const firstMax = Math.max(...first.map((b) => b[3]));
    const secondMin = Math.min(...second.map((b) => b[1]));
    const cut = (firstMax + secondMin) / 2;
    return [
      [x0, y0, x1, cut],
      [x0, cut, x1, y1]
    ];
  }
  const frac = atLine / lineCount;
  if (vertical) {
    const cut = x1 - (x1 - x0) * frac;
    return [
      [cut, y0, x1, y1],
      [x0, y0, cut, y1]
    ];
  }
  const cut = y0 + (y1 - y0) * frac;
  return [
    [x0, y0, x1, cut],
    [x0, cut, x1, y1]
  ];
}

/** Cross-writing-axis extent per line, clamped to a sane font range. */
export function estimateFontSize(box: Box, vertical: boolean, lineCount: number): number {
  const cross = vertical ? box[2] - box[0] : box[3] - box[1];
  const size = cross / Math.max(1, lineCount);
  return Math.round(Math.min(MAX_FONT, Math.max(MIN_FONT, size)));
}

/** Indices in reading order: vertical right-to-left, horizontal top-to-bottom. */
export function readingOrder(blocks: { box: number[] }[], vertical: boolean): number[] {
  const idx = blocks.map((_, i) => i);
  return idx.sort((a, b) =>
    vertical
      ? blocks[b].box[2] - blocks[a].box[2] || blocks[a].box[1] - blocks[b].box[1]
      : blocks[a].box[1] - blocks[b].box[1] || blocks[a].box[0] - blocks[b].box[0]
  );
}

// ---------------------------------------------------------------------------
// Line quads — the editor treats each OCR line as an object of its own.
// ---------------------------------------------------------------------------

/** Axis-aligned quad for a rectangle (mokuro's corner order: tl, tr, br, bl). */
export function rectQuad(x: number, y: number, w: number, h: number): number[][] {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h]
  ];
}

/** Bounding box of a quad. */
export function quadBounds(quad: number[][]): Box {
  return unionBox(quad.map(([x, y]) => [x, y, x, y]));
}

export interface LineGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Taller than wide → vertical writing. Decided per LINE, not per block:
   * mokuro blocks routinely mix orientations (tables of contents, SFX). */
  vertical: boolean;
  /**
   * The size the line's text renders at: with `text`, the FITTED size (the
   * text fills the quad's length, capped by its thickness — see
   * `fittedLineFontSize`); without, the thickness alone.
   */
  fontSize: number;
}

export function lineGeometry(
  quad: number[][],
  text?: string,
  measure: TextMeasurer = getDefaultMeasurer()
): LineGeometry {
  const [x0, y0, x1, y1] = quadBounds(quad);
  const width = x1 - x0;
  const height = y1 - y0;
  const vertical = height > width;
  const fontSize =
    text === undefined ? (vertical ? width : height) : fittedLineFontSize(quad, text, measure);
  return {
    left: x0,
    top: y0,
    width,
    height,
    vertical,
    fontSize: Math.max(1, Math.round(fontSize))
  };
}

/** Median per-line font size across a block's quads (fitted sizes when `lines` are given). */
export function medianLineFontSize(
  quads: number[][][],
  lines?: string[],
  measure: TextMeasurer = getDefaultMeasurer()
): number {
  const sizes = quads
    .map((q, i) => lineGeometry(q, lines?.[i], measure).fontSize)
    .sort((a, b) => a - b);
  if (sizes.length === 0) return 0;
  const mid = Math.floor(sizes.length / 2);
  return sizes.length % 2 ? sizes[mid] : Math.round((sizes[mid - 1] + sizes[mid]) / 2);
}

/** The smallest box containing `box` and every quad — a box never shrinks. */
export function boxContainingQuads(box: number[], quads: number[][][]): Box {
  return unionBox([box, ...quads.map(quadBounds)]);
}
