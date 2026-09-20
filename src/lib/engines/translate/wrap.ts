/**
 * A translated string into the SOURCE block's box: horizontal, no quads and no
 * character offsets (the reader's legacy fit path sizes it), wrapped by a width heuristic, the font
 * shrunk until the lines fit — but never below the size at which three lines
 * fit, so a long translation in a small bubble stays legible rather than tiny.
 */
import type { Block } from '$lib/types';

const CHAR_WIDTH_EM = 0.55;
const LINE_HEIGHT_EM = 1.2;

export function wrapText(text: string, charsPerLine: number): string[] {
  const max = Math.max(1, charsPerLine);
  const lines: string[] = [];
  let line = '';
  for (const rawWord of text.split(/\s+/).filter(Boolean)) {
    let word = rawWord;
    while (word.length > max) {
      if (line) {
        lines.push(line);
        line = '';
      }
      lines.push(word.slice(0, max));
      word = word.slice(max);
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= max) line += ' ' + word;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

export function wrapTranslatedBlock(block: Block, text: string): Block {
  const [x0, y0, x1, y1] = block.box;
  const width = Math.max(1, x1 - x0);
  const height = Math.max(1, y1 - y0);
  let fontSize = Math.max(1, block.font_size);
  const floor = Math.max(1, Math.floor(height / 3 / LINE_HEIGHT_EM));
  let lines = wrapText(text, Math.floor(width / (fontSize * CHAR_WIDTH_EM)));
  while (lines.length * fontSize * LINE_HEIGHT_EM > height && fontSize > floor) {
    fontSize = Math.max(floor, Math.floor(fontSize * 0.9));
    lines = wrapText(text, Math.floor(width / (fontSize * CHAR_WIDTH_EM)));
  }
  // The quads and the per-character offsets describe the OCR lines; the
  // translated lines bear no relation to them, and stale offsets beside new
  // text would be read as a placement for it.
  const { lines_coords: _quads, char_offsets: _offsets, ...rest } = block;
  void _quads;
  void _offsets;
  return { ...rest, box: [...block.box], vertical: false, font_size: fontSize, lines };
}
