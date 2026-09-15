/**
 * Google Cloud Vision `DOCUMENT_TEXT_DETECTION` → a mokuro page. Vision gives
 * blocks → paragraphs → words → symbols with boxes and break hints; mokuro
 * wants blocks with `lines`, a writing direction, one font size, and a quad
 * per line. Furigana comes back as its own tiny lines beside the big ones —
 * mokuro drops them, so we do too.
 */
import type { Block, Page } from '$lib/types';

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
}
interface LineGeom {
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
        text += symbol.text ?? '';
        symbols.push({ text: symbol.text ?? '', box });
        const brk = symbol.property?.detectedBreak?.type;
        if (brk && LINE_BREAKS.has(brk)) flush();
        else if (brk && SPACE_BREAKS.has(brk)) text += ' ';
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

function convertBlock(block: GcvBlock): Block | null {
  const lines = collectLines(block);
  if (lines.length === 0) return null;
  const symbolCount = (v: boolean) =>
    lines.filter((l) => l.vertical === v).reduce((n, l) => n + l.symbols.length, 0);
  const vertical = symbolCount(true) >= symbolCount(false);

  const extents = lines.map((l) => median(l.symbols.map((s) => symbolExtent(s, l.vertical))));
  const blockMedian = median(extents);
  const kept = lines.filter(
    (_, i) => lines.length < 2 || extents[i] >= FURIGANA_RATIO * blockMedian
  );
  if (kept.length === 0) return null;

  const fontSize = Math.round(
    median(kept.flatMap((l) => l.symbols.map((s) => symbolExtent(s, l.vertical))))
  );
  const box = bounds(block.boundingBox?.vertices) ?? union(kept.map((l) => l.box));
  return {
    box: [box[0], box[1], box[2], box[3]],
    vertical,
    font_size: Math.max(1, fontSize),
    lines: kept.map((l) => l.text),
    lines_coords: kept.map((l) => [
      [l.box[0], l.box[1]],
      [l.box[2], l.box[1]],
      [l.box[2], l.box[3]],
      [l.box[0], l.box[3]]
    ])
  };
}

function scaleBlock(block: Block, factor: number): Block {
  if (factor === 1) return block;
  const r = (n: number) => Math.round(n * factor);
  return {
    ...block,
    box: block.box.map(r),
    font_size: Math.max(1, r(block.font_size)),
    lines_coords: block.lines_coords?.map((q) => q.map(([x, y]) => [r(x), r(y)]))
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
    blocks
  };
}
