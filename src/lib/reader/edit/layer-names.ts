/**
 * What the reader calls a layer, from its id alone. Pure: no database, no sync
 * stack — so a volume card can name a server's pending layer the same way the
 * layer menu names it once it has landed. Re-exported from `layers.ts`.
 */

/**
 * Engines whose name is not their slug title-cased: `ppocr-manga` would read
 * "Ppocr Manga", and the engine is PP-OCR (PaddlePaddle OCR).
 */
const ENGINE_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  'ppocr-manga': 'PP-OCR Manga'
};

/** `paddle-manga` → "Paddle Manga"; `tr-en` → "Tr En"; `gcv` → "Gcv"; `ppocr-manga` → "PP-OCR Manga". */
export function layerNameForId(layerId: string): string {
  return ENGINE_DISPLAY_NAMES[layerId] ?? titleCasedLayerId(layerId);
}

/**
 * The slug title-cased and nothing more — what `layerNameForId` called every
 * layer before an engine had a name of its own, and so how a row that was never
 * renamed by hand is recognised (`layer-sync.ts` re-files those).
 */
export function titleCasedLayerId(layerId: string): string {
  return layerId
    .split('-')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}
