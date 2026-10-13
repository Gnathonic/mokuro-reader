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

/**
 * The layer the OCR editor saves a volume's corrections into (bunko design
 * 0.8 D4): pushed as `<Volume>.edit.mokuro`, never as the main sidecar.
 */
export const EDIT_LAYER_ID = 'edit';
const EDIT_LAYER_NAME = 'Your corrections';

/**
 * mokuro-bunko's copy of a main sidecar it upgraded (`<Volume>.pre-upgrade.mokuro`,
 * `-2`, `-3` … for later upgrades): the OCR the volume had before, which may
 * hold corrections made in an older reader.
 */
const PRE_UPGRADE_RE = /^pre-upgrade(?:-(\d+))?$/;
const PRE_UPGRADE_NAME = 'Before upgrade (may contain your corrections)';

/** Is this id one of bunko's `pre-upgrade` layers? */
export function isPreUpgradeLayerId(layerId: string): boolean {
  return PRE_UPGRADE_RE.test(layerId);
}

/**
 * `paddle-manga` → "Paddle Manga"; `tr-en` → "Tr En"; `gcv` → "Gcv"; `ppocr-manga` → "PP-OCR Manga";
 * `edit` → "Your corrections"; `pre-upgrade` → "Before upgrade (may contain your corrections)".
 */
export function layerNameForId(layerId: string): string {
  if (layerId === EDIT_LAYER_ID) return EDIT_LAYER_NAME;
  const preUpgrade = PRE_UPGRADE_RE.exec(layerId);
  if (preUpgrade) {
    return preUpgrade[1]
      ? `Before upgrade ${preUpgrade[1]} (may contain your corrections)`
      : PRE_UPGRADE_NAME;
  }
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
