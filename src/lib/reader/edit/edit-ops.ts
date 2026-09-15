/**
 * Pure OCR edit operations: every function takes a `Page` and returns a NEW
 * `Page`, replacing only the block objects it changed. `EditSession` layers
 * history and persistence on top; nothing here touches the DOM or Dexie.
 */
import type { Block, Page } from '$lib/types';
import {
  clampBox,
  estimateFontSize,
  readingOrder,
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
