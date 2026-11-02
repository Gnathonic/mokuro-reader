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
 * The library's SHARED corrections (`<Volume>.curated.mokuro`): published by
 * an account with the rights to (bunko `permissions.curated`), read by all.
 */
export const CURATED_LAYER_ID = 'curated';
const CURATED_LAYER_NAME = 'Shared corrections';

/** `edit`, or a later `edit-<n>` (a second account's overlay moved in beside it). */
const PERSONAL_RE = /^edit(?:-(\d+))?$/;

/** Is this one of the account's own correction layers (bunko keeps it per account)? */
export function isPersonalLayerId(layerId: string): boolean {
  return PERSONAL_RE.test(layerId);
}

/** Is this the library's shared `curated` layer? */
export function isCuratedLayerId(layerId: string): boolean {
  return layerId === CURATED_LAYER_ID;
}

/** `curated-<n>`: bunko's keepsake of a second, different `curated` file a case merge found. */
const CURATED_KEEPSAKE_RE = /^curated-\d+$/;

/**
 * A layer only the server writes (bunko answers a client PUT with 403): the
 * `curated-<n>` a case merge keeps — its sidecar names rule v1 `layer_class`
 * ServerKeepsake, and nothing else is.
 */
export function isServerKeepsakeLayerId(layerId: string): boolean {
  return CURATED_KEEPSAKE_RE.test(layerId);
}

/**
 * Ids bunko reserves (its `RESERVED_NAMES` / `RESERVED_PREFIXES`, plus the
 * `edit-<n>` and `curated-<n>` families): no generation, and no layer this
 * reader mints by name (`slugifyLayerId`), may take one.
 */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  'original',
  'gcv',
  'updated-ocr',
  EDIT_LAYER_ID,
  CURATED_LAYER_ID
]);
const RESERVED_PREFIXES = ['tr-'] as const;
const RESERVED_FAMILY_RE = /^(?:edit|curated)-\d+$/;

/** Is this id reserved for a layer with a meaning of its own? */
export function isReservedLayerId(layerId: string): boolean {
  return (
    RESERVED_NAMES.has(layerId) ||
    RESERVED_PREFIXES.some((prefix) => layerId.startsWith(prefix)) ||
    RESERVED_FAMILY_RE.test(layerId)
  );
}

/**
 * `paddle-manga` → "Paddle Manga"; `tr-en` → "Tr En"; `gcv` → "Gcv"; `ppocr-manga` → "PP-OCR Manga";
 * `edit` → "Your corrections"; `edit-2` → "Your corrections 2"; `curated` → "Shared corrections".
 */
export function layerNameForId(layerId: string): string {
  if (layerId === CURATED_LAYER_ID) return CURATED_LAYER_NAME;
  const personal = PERSONAL_RE.exec(layerId);
  if (personal) return personal[1] ? `${EDIT_LAYER_NAME} ${personal[1]}` : EDIT_LAYER_NAME;
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
