/**
 * Pure OCR edit operations: every function takes a `Page` and returns a NEW
 * `Page`, replacing only the block objects it changed. `EditSession` layers
 * history and persistence on top; nothing here touches the DOM or Dexie.
 */
import type { Block, Page } from '$lib/types';
import {
  boxContainingQuads,
  clampBox,
  estimateFontSize,
  lineGeometry,
  medianLineFontSize,
  quadBounds,
  readingOrder,
  rectQuad,
  scaleQuads,
  splitBoxAtLine,
  translateQuads,
  unionBox,
  type Box
} from './block-geometry';

function replaceBlock(page: Page, index: number, block: Block): Page {
  const blocks = page.blocks.slice();
  blocks[index] = block;
  return { ...page, blocks };
}

function area(b: Block): number {
  return (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]);
}

export function pageMajorityVertical(page: Page): boolean {
  if (page.blocks.length === 0) return true;
  const vertical = page.blocks.filter((b) => b.vertical).length;
  return vertical * 2 >= page.blocks.length;
}

export function moveBlock(page: Page, index: number, dx: number, dy: number): Page {
  const block = page.blocks[index];
  const [x0, y0, x1, y1] = block.box;
  // Clamp the DELTA, not the box: a move never changes the block's size, it
  // just stops at the image edge.
  const realDx = Math.min(Math.max(dx, -x0), page.img_width - x1);
  const realDy = Math.min(Math.max(dy, -y0), page.img_height - y1);
  if (realDx === 0 && realDy === 0) return page;
  return replaceBlock(page, index, {
    ...block,
    box: [x0 + realDx, y0 + realDy, x1 + realDx, y1 + realDy],
    lines_coords: translateQuads(block.lines_coords, realDx, realDy)
  });
}

export function resizeBlock(page: Page, index: number, box: number[]): Page {
  const block = page.blocks[index];
  const from = block.box as Box;
  const to = clampBox(box, page.img_width, page.img_height);
  const fromCross = block.vertical ? from[2] - from[0] : from[3] - from[1];
  const toCross = block.vertical ? to[2] - to[0] : to[3] - to[1];
  const ratio = fromCross > 0 ? toCross / fromCross : 1;
  return replaceBlock(page, index, {
    ...block,
    box: to,
    font_size: Math.max(1, Math.round(block.font_size * ratio)),
    lines_coords: scaleQuads(block.lines_coords, from, to)
  });
}

/** Replace the lines; quads survive only while the line count is unchanged. */
export function setBlockLines(page: Page, index: number, lines: string[]): Page {
  const block = page.blocks[index];
  const keepQuads = block.lines_coords && block.lines_coords.length === lines.length;
  const next: Block = { ...block, lines: lines.slice() };
  if (keepQuads) next.lines_coords = block.lines_coords;
  else delete next.lines_coords;
  return replaceBlock(page, index, next);
}

export function addBlock(
  page: Page,
  box: number[],
  opts: { vertical?: boolean } = {}
): { page: Page; index: number } {
  const clamped = clampBox(box, page.img_width, page.img_height);
  const vertical = opts.vertical ?? pageMajorityVertical(page);
  const block: Block = {
    box: clamped,
    vertical,
    font_size: estimateFontSize(clamped, vertical, 1),
    lines: ['']
  };
  return { page: { ...page, blocks: [...page.blocks, block] }, index: page.blocks.length };
}

export function removeBlocks(page: Page, indices: number[]): Page {
  const drop = new Set(indices);
  return { ...page, blocks: page.blocks.filter((_, i) => !drop.has(i)) };
}

/**
 * One block at the union box; lines concatenated in reading order (vertical:
 * right-to-left by xmax, horizontal: top-to-bottom by ymin); writing mode and
 * font size from the largest source; quads kept only if every source has them.
 * The merged block takes the lowest source index.
 */
export function mergeBlocks(page: Page, indices: number[]): { page: Page; index: number } {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const sources = sorted.map((i) => page.blocks[i]);
  const largest = sources.reduce((best, b) => (area(b) > area(best) ? b : best));
  const vertical = largest.vertical;
  const order = readingOrder(sources, vertical);
  const lines = order.flatMap((i) => sources[i].lines);
  const allQuads = sources.every((b) => b.lines_coords && b.lines_coords.length === b.lines.length);
  const merged: Block = {
    box: unionBox(sources.map((b) => b.box)),
    vertical,
    font_size: largest.font_size,
    lines
  };
  if (allQuads) merged.lines_coords = order.flatMap((i) => sources[i].lines_coords!);
  const blocks = page.blocks.filter((_, i) => !sorted.includes(i));
  blocks.splice(sorted[0], 0, merged);
  return { page: { ...page, blocks }, index: sorted[0] };
}

/** Split between lines `atLine-1` and `atLine`; a no-op when out of range. */
export function splitBlock(
  page: Page,
  index: number,
  atLine: number
): { page: Page; indices: [number, number] } {
  const block = page.blocks[index];
  const n = block.lines.length;
  if (atLine <= 0 || atLine >= n) return { page, indices: [index, index] };
  const [boxA, boxB] = splitBoxAtLine(
    block.box as Box,
    block.vertical,
    atLine,
    n,
    block.lines_coords
  );
  const a: Block = { ...block, box: boxA, lines: block.lines.slice(0, atLine) };
  const b: Block = { ...block, box: boxB, lines: block.lines.slice(atLine) };
  if (block.lines_coords && block.lines_coords.length === n) {
    a.lines_coords = block.lines_coords.slice(0, atLine);
    b.lines_coords = block.lines_coords.slice(atLine);
  } else {
    delete a.lines_coords;
    delete b.lines_coords;
  }
  const blocks = page.blocks.slice();
  blocks.splice(index, 1, a, b);
  return { page: { ...page, blocks }, indices: [index, index + 1] };
}

/**
 * Toggle the writing mode. The box is left alone by default (a flip is
 * usually a correction of the flag, not of the geometry); `swapBox` rotates
 * the box's aspect about its centre and drops the quads.
 */
export function flipBlock(page: Page, index: number, swapBox = false): Page {
  const block = page.blocks[index];
  const next: Block = { ...block, vertical: !block.vertical };
  if (swapBox) {
    const [x0, y0, x1, y1] = block.box;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const hw = (y1 - y0) / 2;
    const hh = (x1 - x0) / 2;
    next.box = clampBox([cx - hw, cy - hh, cx + hw, cy + hh], page.img_width, page.img_height);
    delete next.lines_coords;
  }
  return replaceBlock(page, index, next);
}

// ---------------------------------------------------------------------------
// Line-centric ops. A block's lines are individually positioned objects (its
// `lines_coords` quads); every op below keeps `lines` and `lines_coords`
// parallel, grows the box to contain every quad (never shrinks it), and
// re-derives the block `font_size` from the line median so an oversized OCR
// value heals on the first edit.
// ---------------------------------------------------------------------------

function hasParallelQuads(block: Block): block is Block & { lines_coords: number[][][] } {
  return !!block.lines_coords && block.lines_coords.length === block.lines.length;
}

/** Re-fit `box` around the quads and heal `font_size` from the line median. */
function withQuads(page: Page, block: Block, quads: number[][][]): Block {
  const box = clampBox(boxContainingQuads(block.box, quads), page.img_width, page.img_height);
  return { ...block, box, lines_coords: quads, font_size: medianLineFontSize(quads) };
}

export function healBlockFontSize(page: Page, blockIndex: number): Page {
  const block = page.blocks[blockIndex];
  if (!hasParallelQuads(block)) return page;
  const font_size = medianLineFontSize(block.lines_coords);
  if (font_size === block.font_size) return page;
  return replaceBlock(page, blockIndex, { ...block, font_size });
}

export function moveLine(
  page: Page,
  blockIndex: number,
  lineIndex: number,
  dx: number,
  dy: number
): Page {
  const block = page.blocks[blockIndex];
  if (!hasParallelQuads(block)) return page;
  const [x0, y0, x1, y1] = quadBounds(block.lines_coords[lineIndex]);
  const realDx = Math.min(Math.max(dx, -x0), page.img_width - x1);
  const realDy = Math.min(Math.max(dy, -y0), page.img_height - y1);
  if (realDx === 0 && realDy === 0) return page;
  const quads = block.lines_coords.slice();
  quads[lineIndex] = quads[lineIndex].map(([x, y]) => [x + realDx, y + realDy]);
  return replaceBlock(page, blockIndex, withQuads(page, block, quads));
}

export function resizeLine(
  page: Page,
  blockIndex: number,
  lineIndex: number,
  quad: number[][]
): Page {
  const block = page.blocks[blockIndex];
  if (!hasParallelQuads(block)) return page;
  const [x0, y0, x1, y1] = clampBox(quadBounds(quad), page.img_width, page.img_height);
  const quads = block.lines_coords.slice();
  quads[lineIndex] = rectQuad(x0, y0, x1 - x0, y1 - y0);
  return replaceBlock(page, blockIndex, withQuads(page, block, quads));
}

/**
 * Give a quad-less block one quad per line by dividing its box evenly along
 * the writing axis: vertical → columns right-to-left, horizontal → rows
 * top-to-bottom. Makes the lines positionable.
 */
export function placeLines(page: Page, blockIndex: number): Page {
  const block = page.blocks[blockIndex];
  if (hasParallelQuads(block) || block.lines.length === 0) return page;
  const [x0, y0, x1, y1] = block.box;
  const n = block.lines.length;
  const quads: number[][][] = [];
  if (block.vertical) {
    const w = (x1 - x0) / n;
    for (let i = 0; i < n; i++) quads.push(rectQuad(x1 - w * (i + 1), y0, w, y1 - y0));
  } else {
    const h = (y1 - y0) / n;
    for (let i = 0; i < n; i++) quads.push(rectQuad(x0, y0 + h * i, x1 - x0, h));
  }
  return replaceBlock(page, blockIndex, withQuads(page, block, quads));
}

/**
 * Insert an empty line after `afterLine`. With quads, the new line gets a quad
 * one line advance further along the cross axis (vertical: to the LEFT,
 * horizontal: BELOW), same size as the line it follows.
 */
export function insertLine(page: Page, blockIndex: number, afterLine: number): Page {
  const block = page.blocks[blockIndex];
  const lines = block.lines.slice();
  lines.splice(afterLine + 1, 0, '');
  if (!hasParallelQuads(block)) {
    const next: Block = { ...block, lines };
    delete next.lines_coords;
    return replaceBlock(page, blockIndex, next);
  }
  const g = lineGeometry(block.lines_coords[afterLine]);
  const quad = g.vertical
    ? rectQuad(g.left - g.width, g.top, g.width, g.height)
    : rectQuad(g.left, g.top + g.height, g.width, g.height);
  const quads = block.lines_coords.slice();
  quads.splice(afterLine + 1, 0, quad);
  return replaceBlock(page, blockIndex, withQuads(page, { ...block, lines }, quads));
}

/** Remove a line and its quad; a block always keeps at least one line. */
export function removeLine(page: Page, blockIndex: number, lineIndex: number): Page {
  const block = page.blocks[blockIndex];
  if (block.lines.length <= 1) return page;
  const lines = block.lines.filter((_, i) => i !== lineIndex);
  if (!hasParallelQuads(block)) {
    const next: Block = { ...block, lines };
    delete next.lines_coords;
    return replaceBlock(page, blockIndex, next);
  }
  const quads = block.lines_coords.filter((_, i) => i !== lineIndex);
  return replaceBlock(page, blockIndex, withQuads(page, { ...block, lines }, quads));
}
