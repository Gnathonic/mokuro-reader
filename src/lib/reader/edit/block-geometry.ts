/**
 * Geometry helpers shared by the OCR edit operations (`edit-ops.ts`). Pure,
 * image-pixel space, no DOM.
 */
import {
  fittedLineFontSize,
  getDefaultMeasurer,
  type TextMeasurer
} from '$lib/reader/line-coords-layout';
import {
  griddable,
  gridSpacing,
  lineFrame,
  quadAxes,
  spacingUnits,
  type GridSpacing
} from '$lib/reader/line-grid';

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
  /** The quad's axis-aligned BOUNDS, page px — what the block box grows around
   * and what a drag is measured from, tilted or not. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Taller than wide → vertical writing. Decided per LINE, not per block:
   * mokuro blocks routinely mix orientations (tables of contents, SFX). A
   * tilted quad is judged by its OWN extents — its bounds grow with the lean
   * and, past 45°, call a column a row. */
  vertical: boolean;
  /**
   * The size the line's text renders at: with `text`, the FITTED size (the
   * text fills the quad's length, capped by its thickness — see
   * `fittedLineFontSize`); without, the thickness alone.
   */
  fontSize: number;
  /** Degrees clockwise (CSS `rotate()`), as the viewer turns the line
   * (`lineFrame`): 0 for an upright quad and inside the dead band. */
  rotation: number;
  /** Extent along the line's own writing axis — what the uniform grid spans. */
  main: number;
  /**
   * Where the line ELEMENT goes, page px. Upright: the bounds above. Tilted:
   * the quad's own-frame box (cross × main, or main × cross) centred on the
   * quad's centre as it lies BEFORE the turn; `rotate(rotation)` about its
   * centre lands it on the quad.
   */
  box: { left: number; top: number; width: number; height: number };
}

export function lineGeometry(
  quad: number[][],
  text?: string,
  measure: TextMeasurer = getDefaultMeasurer()
): LineGeometry {
  const [x0, y0, x1, y1] = quadBounds(quad);
  const width = x1 - x0;
  const height = y1 - y0;
  const bounds = { left: x0, top: y0, width, height };
  const upright = height > width;
  let frame = lineFrame(quad, upright);
  if (!frame || frame.angle === 0) {
    const fontSize =
      text === undefined ? (upright ? width : height) : fittedLineFontSize(quad, text, measure);
    return {
      ...bounds,
      vertical: upright,
      fontSize: Math.max(1, Math.round(fontSize)),
      rotation: 0,
      main: frame?.main ?? (upright ? height : width),
      box: bounds
    };
  }
  const axes = quadAxes(quad)!;
  const vertical = axes.v > axes.h;
  if (vertical !== upright) frame = lineFrame(quad, vertical)!;
  const advanceEm = text === undefined ? 0 : measure(text);
  const fontSize = advanceEm > 0 ? Math.min(frame.cross, frame.main / advanceEm) : frame.cross;
  const boxWidth = vertical ? frame.cross : frame.main;
  const boxHeight = vertical ? frame.main : frame.cross;
  return {
    ...bounds,
    vertical,
    fontSize: Math.max(1, Math.round(fontSize)),
    rotation: frame.angle,
    main: frame.main,
    box: {
      left: frame.cx - boxWidth / 2,
      top: frame.cy - boxHeight / 2,
      width: boxWidth,
      height: boxHeight
    }
  };
}

const NO_GRID: GridSpacing = { letterSpacing: 0, inset: 0 };

/**
 * The viewer's uniform grid (`gridSpacing`) for a line as the EDITOR draws it:
 * its own fitted, whole-px size and the text it shows. Spacing after every
 * glyph stretches the run over the quad's length, and the run starts half a
 * spacing in. No grid (zeros) where the viewer has none either.
 */
export function lineGrid(
  g: LineGeometry,
  text: string,
  measure: TextMeasurer = getDefaultMeasurer()
): GridSpacing {
  if (!griddable(text)) return NO_GRID;
  return (
    gridSpacing({
      main: g.main,
      advanceEm: measure(text),
      fontSize: g.fontSize,
      count: spacingUnits(text)
    }) ?? NO_GRID
  );
}

/** Unit vectors of a line's own frame in page space: `along` its writing axis,
 * and `right`/`down` as the turn leaves them. */
function frameAxes(vertical: boolean, rotation: number) {
  const t = (rotation * Math.PI) / 180;
  const right: [number, number] = [Math.cos(t), Math.sin(t)];
  const down: [number, number] = [-Math.sin(t), Math.cos(t)];
  return { right, down, along: vertical ? down : right };
}

/**
 * Drag one edge of a line quad in the quad's OWN frame. `end` is the edge the
 * text runs to (length), `side` the one the next line would sit against
 * (thickness → font size): a column's left, a row's bottom. Only the part of
 * the drag along that edge's axis counts, and only the two corners of that
 * edge move — so the angle survives, the opposite edge stays put, and the
 * centre follows the dragged edge. An edge stops 1px short of the opposite
 * one: a quad folded through itself has no angle left to keep.
 */
export function resizeQuadEdge(
  quad: number[][],
  vertical: boolean,
  part: 'end' | 'side',
  dx: number,
  dy: number
): number[][] {
  const frame = lineFrame(quad, vertical);
  if (!frame) return quad;
  const { right, down, along } = frameAxes(vertical, frame.angle);
  // outward normal of the dragged edge
  const axis: [number, number] = part === 'end' ? along : vertical ? [-right[0], -right[1]] : down;
  const extent = part === 'end' ? frame.main : frame.cross;
  const delta = Math.max(dx * axis[0] + dy * axis[1], 1 - extent);
  // The corner ORDER is file data (a quad may be listed from any corner), so
  // the edge is found by where its corners are, not by their index.
  return quad.map(([x, y]) =>
    (x - frame.cx) * axis[0] + (y - frame.cy) * axis[1] > 0
      ? [x + delta * axis[0], y + delta * axis[1]]
      : [x, y]
  );
}

/** Where a selected line's two resize handles sit, page px: the middle of its
 * `end` and `side` edges (see `resizeQuadEdge`), on the turned quad. */
export function lineHandlePoints(g: LineGeometry): {
  end: { x: number; y: number };
  side: { x: number; y: number };
} {
  const { right, down, along } = frameAxes(g.vertical, g.rotation);
  const cx = g.box.left + g.box.width / 2;
  const cy = g.box.top + g.box.height / 2;
  const main = g.vertical ? g.box.height : g.box.width;
  const cross = g.vertical ? g.box.width : g.box.height;
  const side = g.vertical ? [-right[0], -right[1]] : down;
  return {
    end: { x: cx + (along[0] * main) / 2, y: cy + (along[1] * main) / 2 },
    side: { x: cx + (side[0] * cross) / 2, y: cy + (side[1] * cross) / 2 }
  };
}

/**
 * The quad of a line inserted after `quad`: the same quad one thickness
 * further along the cross axis (a column's LEFT, a row's BELOW) — in the
 * line's own frame, so a line added to tilted text is tilted with it.
 */
export function nextLineQuad(quad: number[][]): number[][] {
  const g = lineGeometry(quad);
  if (!g.rotation) {
    return g.vertical
      ? rectQuad(g.left - g.width, g.top, g.width, g.height)
      : rectQuad(g.left, g.top + g.height, g.width, g.height);
  }
  const { right, down } = frameAxes(g.vertical, g.rotation);
  const step = g.vertical ? g.box.width : g.box.height;
  const [ux, uy] = g.vertical ? [-right[0], -right[1]] : down;
  return quad.map(([x, y]) => [x + ux * step, y + uy * step]);
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
