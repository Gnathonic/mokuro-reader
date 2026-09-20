/**
 * The translator's contract: blocks in reading order with an index, JSON
 * back aligned by index. Provider-agnostic — every adapter sends these two
 * strings and hands the reply to `parseTranslation`.
 */
import type { TranslationInput, TranslationResult } from './types';

export class MalformedTranslationError extends Error {
  name = 'MalformedTranslationError';
}

/** RTL pages: right column first (xmax desc), then top to bottom; LTR: rows then columns. */
export function readingOrder(blocks: { box: number[] }[], rtl: boolean): number[] {
  const idx = blocks.map((_, i) => i);
  if (rtl) {
    return idx.sort(
      (a, b) => blocks[b].box[2] - blocks[a].box[2] || blocks[a].box[1] - blocks[b].box[1]
    );
  }
  return idx.sort(
    (a, b) => blocks[a].box[1] - blocks[b].box[1] || blocks[a].box[0] - blocks[b].box[0]
  );
}

export function buildSystemPrompt(target: string, wrapInObject = false): string {
  return [
    `You translate Japanese manga dialogue into ${target}.`,
    'Keep honorifics and names, match the register and tone of each speaker, keep sound effects short.',
    'Blocks are given in reading order with an index; translate each block on its own but use the others as context.',
    wrapInObject
      ? 'Reply with JSON only: an object {"translations": [{"index": number, "text": string}, …]} with one entry per input index, nothing else.'
      : 'Reply with JSON only: an array of {"index": number, "text": string}, one entry per input index, nothing else.'
  ].join(' ');
}

export function buildUserPrompt(input: TranslationInput): string {
  return [
    `Series: ${input.seriesTitle}`,
    `Volume: ${input.volumeTitle}`,
    `Target language: ${input.target}`,
    'Blocks:',
    JSON.stringify(input.blocks, null, 2)
  ].join('\n');
}

/**
 * Where the JSON of a reply may sit, most literal reading first. Not every
 * provider has a JSON mode (Anthropic does not), and a model asked for "JSON
 * only" still likes a sentence before or after it — a reply that is 95% right
 * must not cost the page its translation. The whole reply goes first so plain
 * JSON is never second-guessed (a translated string may itself hold a fence or
 * brackets); then the first fenced block anywhere; then the outermost
 * `{…}` / `[…]` span.
 */
function jsonCandidates(raw: string): string[] {
  const text = raw.trim();
  const candidates = [text];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) candidates.push(fence[1]);
  const open = text.search(/[[{]/);
  if (open !== -1) {
    const close = text.lastIndexOf(text[open] === '[' ? ']' : '}');
    if (close > open) candidates.push(text.slice(open, close + 1));
  }
  return candidates;
}

export function parseTranslation(raw: string, expectedIndices: number[]): TranslationResult[] {
  let parsed: unknown;
  let found = false;
  for (const candidate of jsonCandidates(raw)) {
    try {
      parsed = JSON.parse(candidate);
      found = true;
      break;
    } catch {
      // not this one — try the next place the JSON could be
    }
  }
  if (!found) throw new MalformedTranslationError('translation reply was not JSON');
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'translations' in parsed) {
    parsed = (parsed as { translations: unknown }).translations;
  }
  if (!Array.isArray(parsed)) {
    throw new MalformedTranslationError('translation reply was not an array');
  }
  const byIndex = new Map<number, string>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const { index, text: t } = entry as { index?: unknown; text?: unknown };
    if (typeof index !== 'number' || typeof t !== 'string') {
      throw new MalformedTranslationError('translation entry malformed');
    }
    byIndex.set(index, t);
  }
  return expectedIndices.map((index) => {
    const t = byIndex.get(index);
    if (t === undefined) {
      throw new MalformedTranslationError(`missing translation for block ${index}`);
    }
    return { index, text: t };
  });
}
