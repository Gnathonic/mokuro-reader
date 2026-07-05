/**
 * Drop duplicate OCR blocks before rendering.
 *
 * comic-text-detector occasionally emits the same balloon twice: once
 * properly segmented into lines, and once from a second YOLO hit whose
 * segmentation lines were claimed by the first block — that block gets its
 * whole bbox as one synthetic "line" (huge font_size, all text concatenated).
 * ~19 duplicate pairs per 1000 pages in a 60-volume corpus scan.
 *
 * Rule: two blocks are duplicates when their joined text is identical and
 * their boxes overlap (IoU > 0.5). The better-segmented block (more lines)
 * wins; ties keep the earlier block. Render-time dedupe fixes volumes that
 * are already imported.
 */
import type { Block } from '$lib/types';

export interface KeptBlock {
  block: Block;
  /** Index into the original page.blocks array */
  blockIndex: number;
}

const IOU_THRESHOLD = 0.5;

function boxIoU(a: number[], b: number[]): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

export function dedupeBlocks(blocks: Block[]): KeptBlock[] {
  const dropped = new Set<number>();
  const texts = blocks.map((b) => (b.lines ?? []).join('').trim());

  for (let i = 0; i < blocks.length; i++) {
    if (dropped.has(i) || !texts[i]) continue;
    for (let j = i + 1; j < blocks.length; j++) {
      if (dropped.has(j)) continue;
      if (texts[i] !== texts[j]) continue;
      if (boxIoU(blocks[i].box, blocks[j].box) <= IOU_THRESHOLD) continue;
      // duplicate pair: keep the better-segmented block (more lines);
      // on a tie keep the earlier one
      if (blocks[j].lines.length > blocks[i].lines.length) {
        dropped.add(i);
        break;
      } else {
        dropped.add(j);
      }
    }
  }

  return blocks
    .map((block, blockIndex) => ({ block, blockIndex }))
    .filter(({ blockIndex }) => !dropped.has(blockIndex));
}
