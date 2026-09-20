/**
 * Google Cloud Vision `DOCUMENT_TEXT_DETECTION` → a mokuro page. Vision gives
 * blocks → paragraphs → words → symbols with boxes and break hints; mokuro
 * wants blocks with `lines`, a writing direction, one font size, and a quad
 * per line. Furigana comes back as its own tiny lines beside the big ones —
 * mokuro drops them, so we do too. The symbol boxes also say where every
 * character sits along its line, which goes out as `char_offsets`.
 */
import type { Block, Page } from '$lib/types';
import {
  codePoints,
  pageHasPlacement,
  scaleOffsets,
  validLineOffsets
} from '$lib/reader/char-offsets';
import { quadExtents } from '$lib/reader/line-coords-layout';

export interface GcvVertex {
  x?: number;
  y?: number;
}
export interface GcvSymbol {
  text?: string;
  boundingBox?: { vertices?: GcvVertex[] };
  property?: { detectedBreak?: { type?: string; isPrefix?: boolean } };
}
export interface GcvWord {
  symbols?: GcvSymbol[];
}
export interface GcvParagraph {
  words?: GcvWord[];
}
export interface GcvBlock {
  boundingBox?: { vertices?: GcvVertex[] };
  paragraphs?: GcvParagraph[];
}
export interface GcvAnnotateResponse {
  responses?: {
    fullTextAnnotation?: { pages?: { blocks?: GcvBlock[] }[] };
    error?: { code?: number; message?: string };
  }[];
}

type Box = [number, number, number, number];
type Quad = number[][];

/** `Page.char_offsets_method` for offsets read off Vision's per-symbol boxes. */
export const GCV_OFFSETS_METHOD = 'gcv-symbols';

/** A line whose symbols are under this fraction of the block's median is furigana. */
const FURIGANA_RATIO = 0.55;
const LINE_BREAKS = new Set(['LINE_BREAK', 'EOL_SURE_SPACE']);
const SPACE_BREAKS = new Set(['SPACE', 'SURE_SPACE']);

function bounds(vertices: GcvVertex[] | undefined): Box | null {
  if (!vertices || vertices.length === 0) return null;
  const xs = vertices.map((v) => v.x ?? 0);
  const ys = vertices.map((v) => v.y ?? 0);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function union(boxes: Box[]): Box {
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3]))
  ];
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

interface SymbolGeom {
  text: string;
  box: Box;
  /** A SPACE break put a ' ' into the line text after this symbol. */
  spaceAfter: boolean;
}
interface LineGeom {
  /** The emitted line: the symbols' text and break spaces, trimmed. */
  text: string;
  symbols: SymbolGeom[];
  box: Box;
  vertical: boolean;
}

/** Symbols advance mostly in y along a vertical line; box aspect decides for one symbol. */
function lineIsVertical(symbols: SymbolGeom[], box: Box): boolean {
  if (symbols.length >= 2) {
    const first = symbols[0].box;
    const last = symbols[symbols.length - 1].box;
    const dx = Math.abs((last[0] + last[2]) / 2 - (first[0] + first[2]) / 2);
    const dy = Math.abs((last[1] + last[3]) / 2 - (first[1] + first[3]) / 2);
    return dy > dx;
  }
  return box[3] - box[1] > box[2] - box[0];
}

function collectLines(block: GcvBlock): LineGeom[] {
  const lines: LineGeom[] = [];
  let text = '';
  let symbols: SymbolGeom[] = [];
  const flush = () => {
    const clean = text.trim();
    if (clean && symbols.length) {
      const box = union(symbols.map((s) => s.box));
      lines.push({ text: clean, symbols, box, vertical: lineIsVertical(symbols, box) });
    }
    text = '';
    symbols = [];
  };
  for (const paragraph of block.paragraphs ?? []) {
    for (const word of paragraph.words ?? []) {
      for (const symbol of word.symbols ?? []) {
        const box = bounds(symbol.boundingBox?.vertices);
        if (!box) continue;
        const brk = symbol.property?.detectedBreak?.type;
        const isLineBreak = !!brk && LINE_BREAKS.has(brk);
        const spaceAfter = !isLineBreak && !!brk && SPACE_BREAKS.has(brk);
        text += symbol.text ?? '';
        symbols.push({ text: symbol.text ?? '', box, spaceAfter });
        if (isLineBreak) flush();
        else if (spaceAfter) text += ' ';
      }
    }
    flush();
  }
  flush();
  return lines;
}

/** The symbol's size across the writing direction — the glyph size. */
function symbolExtent(s: SymbolGeom, vertical: boolean): number {
  return vertical ? s.box[2] - s.box[0] : s.box[3] - s.box[1];
}

function boxQuad(box: Box): Quad {
  return [
    [box[0], box[1]],
    [box[2], box[1]],
    [box[2], box[3]],
    [box[0], box[3]]
  ];
}

/**
 * The last step for every entry, fresh or rescaled: integers, inside the quad,
 * never decreasing — then the reader's own validation, so nothing leaves here
 * that the reader would throw away. A NaN that got this far fails it too.
 */
function settleOffsets(
  text: string,
  values: number[],
  quad: Quad,
  vertical: boolean
): number[] | null {
  const main = quadExtents(quad, vertical)?.main;
  if (!main) return null;
  const limit = Math.floor(main);
  let floor = 0;
  const offsets = values.map((v) => (floor = Math.max(floor, Math.min(limit, Math.round(v)))));
  // No extent at all is every glyph on one point — no placement worth writing.
  if (!(offsets[offsets.length - 1] > offsets[0])) return null;
  return validLineOffsets(text, offsets, main);
}

/**
 * `char_offsets` for one line: each symbol box projected onto the BLOCK's
 * reading axis — the axis the reader lays every line of the block along, and
 * the one the contract measures on. Neighbours meet at the midpoint between one
 * box's end and the next one's start (the same point when they overlap), so
 * the cells are contiguous and each glyph sits centred between its gaps.
 *
 * Null rather than a guess whenever the symbols cannot be tied to the emitted
 * text or to that axis:
 * - the line runs across the block (a horizontal caption in a vertical block):
 *   along the block axis its symbols all share one span;
 * - a symbol sits before its predecessor (Vision read two columns as one line):
 *   cells would run down one column while the quad spans both, and a celled
 *   line skips the reader's merged-columns wrapping;
 * - the rebuilt characters are not the emitted text.
 */
function lineOffsets(line: LineGeom, vertical: boolean): number[] | null {
  // One symbol has no direction of its own (lineIsVertical fell back to the
  // box aspect), so only a real run of symbols can disagree with the block.
  if (line.symbols.length >= 2 && line.vertical !== vertical) return null;
  const axis = vertical ? 1 : 0;
  const start = (s: SymbolGeom) => s.box[axis];
  const end = (s: SymbolGeom) => s.box[axis + 2];

  // A textless symbol still widens the quad, but there is nothing to place.
  const placed = line.symbols.filter((s) => s.text.length > 0);
  if (placed.length === 0) return null;
  for (let k = 1; k < placed.length; k++) {
    if (start(placed[k]) + end(placed[k]) < start(placed[k - 1]) + end(placed[k - 1])) return null;
  }
  const edges = [start(placed[0])];
  for (let k = 1; k < placed.length; k++) edges.push((end(placed[k - 1]) + start(placed[k])) / 2);
  edges.push(end(placed[placed.length - 1]));
  // A box swallowed by its predecessor ends before the boundary it starts at.
  // Forcing that monotone would hand a real glyph an empty cell; rounding is
  // the only disorder settleOffsets is there to absorb.
  if (edges.some((edge, i) => i > 0 && edge < edges[i - 1])) return null;

  // Rebuild the text exactly as collectLines did, one boundary per code point.
  const chars: string[] = [];
  const bounds = [edges[0]];
  let k = 0;
  for (const symbol of line.symbols) {
    const points = codePoints(symbol.text);
    if (points.length > 0) {
      // Several code points in one box (`!?`) share it evenly, as the contract asks.
      const span = edges[k + 1] - edges[k];
      points.forEach((point, j) => {
        chars.push(point);
        bounds.push(edges[k] + (span * (j + 1)) / points.length);
      });
      k++;
    }
    if (symbol.spaceAfter) {
      // Whitespace is zero-width in the contract: the space sits ON the boundary.
      chars.push(' ');
      bounds.push(bounds[bounds.length - 1]);
    }
  }

  // ...and clean it the same way: what trim() dropped takes its cells along.
  const raw = chars.join('');
  const lead = codePoints(raw).length - codePoints(raw.trimStart()).length;
  const kept = codePoints(raw.trim()).length;
  if (chars.slice(lead, lead + kept).join('') !== line.text) return null;

  const origin = line.box[axis];
  const values = bounds.slice(lead, lead + kept + 1).map((b) => b - origin);
  return settleOffsets(line.text, values, boxQuad(line.box), vertical);
}

function convertBlock(block: GcvBlock): Block | null {
  const lines = collectLines(block);
  if (lines.length === 0) return null;
  const symbolCount = (v: boolean) =>
    lines.filter((l) => l.vertical === v).reduce((n, l) => n + l.symbols.length, 0);
  const vertical = symbolCount(true) >= symbolCount(false);

  const extents = lines.map((l) => median(l.symbols.map((s) => symbolExtent(s, l.vertical))));
  // Max, not median: with exactly two lines (main + its furigana, the common
  // ruby case) the median is their mean, which drags the threshold down
  // enough to keep the furigana line.
  const maxExtent = Math.max(...extents);
  const kept = lines.filter((_, i) => lines.length < 2 || extents[i] >= FURIGANA_RATIO * maxExtent);
  if (kept.length === 0) return null;

  const fontSize = Math.round(
    median(kept.flatMap((l) => l.symbols.map((s) => symbolExtent(s, l.vertical))))
  );
  const box = bounds(block.boundingBox?.vertices) ?? union(kept.map((l) => l.box));
  // Built from the kept lines only, so a dropped furigana line takes its entry
  // with it and the array stays parallel to `lines`.
  const offsets = kept.map((l) => lineOffsets(l, vertical));
  return {
    box: [box[0], box[1], box[2], box[3]],
    vertical,
    font_size: Math.max(1, fontSize),
    lines: kept.map((l) => l.text),
    lines_coords: kept.map((l) => boxQuad(l.box)),
    ...(offsets.some(Boolean) ? { char_offsets: offsets } : {})
  };
}

function scaleBlock(block: Block, factor: number): Block {
  if (factor === 1) return block;
  const r = (n: number) => Math.round(n * factor);
  const { char_offsets: unscaled, ...rest } = block;
  const lines_coords = block.lines_coords?.map((q) => q.map(([x, y]) => [r(x), r(y)]));
  // Corners and offsets round separately, so a scaled entry can end a pixel
  // past its scaled quad: settle it against the quad it will be read with.
  const offsets = unscaled?.map((entry, i) =>
    entry && lines_coords?.[i]
      ? settleOffsets(block.lines[i], scaleOffsets(entry, factor), lines_coords[i], block.vertical)
      : null
  );
  return {
    ...rest,
    box: block.box.map(r),
    font_size: Math.max(1, r(block.font_size)),
    lines_coords,
    ...(offsets?.some(Boolean) ? { char_offsets: offsets } : {})
  };
}

/**
 * @param scale request-px per image-px: 1 when the image was sent as-is,
 *   0.5 when it was halved before upload. Output is always in image px.
 */
export function gcvToPage(response: GcvAnnotateResponse, page: Page, scale = 1): Page {
  const blocks: Block[] = [];
  const factor = 1 / scale;
  for (const gcvPage of response.responses?.[0]?.fullTextAnnotation?.pages ?? []) {
    for (const gcvBlock of gcvPage.blocks ?? []) {
      const block = convertBlock(gcvBlock);
      if (block) blocks.push(scaleBlock(block, factor));
    }
  }
  return {
    version: page.version,
    img_width: page.img_width,
    img_height: page.img_height,
    img_path: page.img_path,
    blocks,
    // Judged on what was emitted (after scaling), never carried over from `page`.
    ...(pageHasPlacement({ blocks }) ? { char_offsets_method: GCV_OFFSETS_METHOD } : {})
  };
}
