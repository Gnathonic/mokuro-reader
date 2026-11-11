/**
 * What the reader calls a piece of OCR — the primary and every layer read from
 * a file — by what MADE it. Pure: no database, no sync stack.
 *
 * One rule for every OCR file:
 * - its `ocr_engine.parts` (bunko: each tool the OCR was made with, display
 *   order, recognizer first) → "Hayai Nova 2.5 · PP-OCR Manga 0.3";
 * - else its `ocr_engine.id` → that engine's display name ("Hayai Nova");
 * - else mokuro wrote it → "mokuro 0.2.2" (plain "mokuro" with no version).
 *
 * A layer's id still names it when the id says what the layer IS (an
 * account's corrections, the shared `curated`, a hand-made layer). Only a
 * set-aside main sidecar (`pre-upgrade…`, `previous-ocr…`) — whose id says
 * nothing about its maker — is named by the mokuro version when no engine
 * made it.
 */
import {
  isCuratedLayerId,
  isPersonalLayerId,
  isServerKeepsakeLayerId,
  layerNameForId,
  titleCasedLayerId
} from './layer-names';

/** One tool an OCR file was made with, as bunko's `ocr_engine.parts` lists it. */
export interface OcrPart {
  /** `recognizer`, `detector`, … — informative only: the list order is the display order. */
  role?: string;
  /** Already a display name ("PP-OCR Manga"): rendered as given. */
  name: string;
  version?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The parts an `ocr_engine` block (or a stored row's copy of them) lists, or
 * undefined. Lenient on purpose: anything but a non-empty array of objects
 * that each have a non-blank string `name` means "no parts" — the label then
 * falls back to the engine id. A `version` that is not a non-blank string is
 * left out (the part reads as its name alone).
 */
export function ocrPartsOf(engine: unknown): OcrPart[] | undefined {
  if (!isPlainObject(engine)) return undefined;
  return validParts(engine.parts);
}

/** `ocrPartsOf` on the array itself (rows in IndexedDB are user data: re-checked). */
export function validParts(raw: unknown): OcrPart[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const parts: OcrPart[] = [];
  for (const p of raw) {
    if (!isPlainObject(p) || typeof p.name !== 'string' || !p.name.trim()) return undefined;
    const version = typeof p.version === 'string' ? p.version.trim() : '';
    parts.push({
      ...(typeof p.role === 'string' ? { role: p.role } : {}),
      name: p.name.trim(),
      ...(version ? { version } : {})
    });
  }
  return parts;
}

/** "Hayai Nova 2.5 · PP-OCR Manga 0.3": each part's name and version, joined by a middle dot. */
export function partsLabel(parts: readonly OcrPart[]): string {
  return parts.map((p) => (p.version ? `${p.name} ${p.version}` : p.name)).join(' · ');
}

/** `mokuro 0.2.2`, or plain `mokuro` with no version (an image-only volume). */
export function mokuroLabel(version: string | undefined | null): string {
  const v = (version ?? '').trim();
  return v ? `mokuro ${v}` : 'mokuro';
}

/** The maker of one OCR file: its parts, else its engine's display name, else mokuro. */
export function ocrFileLabel(file: {
  engine?: string;
  parts?: readonly OcrPart[];
  version?: string | null;
}): string {
  const parts = validParts(file.parts);
  if (parts) return partsLabel(parts);
  if (file.engine) return layerNameForId(file.engine);
  return mokuroLabel(file.version);
}

/** The `ocr_engine` block of the newest provenance entry, when it is a GENERATED one with an id. */
function newestEngineBlock(list: readonly unknown[] | undefined): Record<string, unknown> | null {
  const entry = list?.[0];
  if (!isPlainObject(entry) || isPlainObject(entry.edited)) return null;
  const engine = entry.engine;
  return isPlainObject(engine) && typeof engine.id === 'string' && engine.id ? engine : null;
}

/**
 * What the primary OCR row is called in the layer picker, settings select and
 * switch toasts: the maker of the main sidecar it was installed from
 * (`ocrFileLabel`), read from the volume's newest provenance entry — the
 * `ocr_engine` block a server stamped on it. No block (a legacy mokuro file,
 * an image-only volume, an installed EDITED main) → `mokuro <version>`.
 *
 * A primary edited here (`ocr_edited_at`) is not the engine's output any more
 * — and its newest entry may be the `updated-ocr` layer's block, not its own
 * base's — so it keeps the `mokuro <version>` name it always had.
 */
export function primaryLayerName(
  volume:
    | {
        mokuro_version?: string | null;
        ocr_edited_at?: string;
        ocr_provenance?: readonly unknown[];
      }
    | null
    | undefined
): string {
  if (!volume) return mokuroLabel(undefined);
  const engine = volume.ocr_edited_at ? null : newestEngineBlock(volume.ocr_provenance);
  return ocrFileLabel({
    ...(engine ? { engine: engine.id as string, parts: ocrPartsOf(engine) } : {}),
    version: volume.mokuro_version
  });
}

/**
 * `pre-upgrade`, `previous-ocr` and their `-<n>` siblings: a volume's earlier
 * main sidecar kept beside the one that replaced it (an older bunko's
 * `<Volume>.pre-upgrade.mokuro`; reader v1.10.0's "Previous OCR"). Their id
 * says why they exist, not who made them, so they are named by their maker.
 */
const SET_ASIDE_RE = /^(?:pre-upgrade|previous-ocr)(?:-\d+)?$/;

export function isSetAsideLayerId(layerId: string): boolean {
  return SET_ASIDE_RE.test(layerId);
}

/** What a layer row knows about the file it was read from. */
export interface LayerLabelRow {
  layer_id: string;
  name: string;
  engine?: string;
  ocr_parts?: OcrPart[];
  mokuro_version?: string;
}

function isCorrectionsId(layerId: string): boolean {
  return (
    isCuratedLayerId(layerId) || isPersonalLayerId(layerId) || isServerKeepsakeLayerId(layerId)
  );
}

/**
 * The name a layer row gets when nobody renamed it: a corrections layer by its
 * id ("Your corrections", "Shared corrections"); a file with parts by its
 * parts; a set-aside main sidecar by its maker (`ocrFileLabel`); anything else
 * by its id, as before (`layerNameForId`: "PP-OCR Manga", "Charspot Small").
 */
export function autoLayerName(row: Omit<LayerLabelRow, 'name'>): string {
  if (isCorrectionsId(row.layer_id)) return layerNameForId(row.layer_id);
  const parts = validParts(row.ocr_parts);
  if (parts) return partsLabel(parts);
  if (isSetAsideLayerId(row.layer_id)) {
    return ocrFileLabel({ engine: row.engine, version: row.mokuro_version });
  }
  return layerNameForId(row.layer_id);
}

/**
 * Was this row never renamed by hand? Its name is one the reader gave it: the
 * title-cased slug (every row before engines had names — "Pre Upgrade",
 * "Ppocr Manga"), the id's display name, or the name its file gives it now.
 */
export function isAutoNamedLayer(row: LayerLabelRow): boolean {
  return (
    row.name === titleCasedLayerId(row.layer_id) ||
    row.name === layerNameForId(row.layer_id) ||
    row.name === autoLayerName(row)
  );
}

/** The name to show: what the user typed, else what the row's file says made it. */
export function layerDisplayName(row: LayerLabelRow): string {
  return isAutoNamedLayer(row) ? autoLayerName(row) : row.name;
}

/**
 * The name to store when a file (re)writes a layer row: the existing row's own
 * name when the user typed it, else the new file's (`autoLayerName`).
 */
export function layerNameOnWrite(
  existing: LayerLabelRow | undefined,
  next: Omit<LayerLabelRow, 'name'>
): string {
  if (existing && !isAutoNamedLayer(existing)) return existing.name;
  return autoLayerName(next);
}

/** What a layer row remembers of its file's maker. */
export interface LayerMakerFields {
  ocr_parts?: OcrPart[];
  mokuro_version?: string;
}

/**
 * What a parsed layer file says about its maker, to remember on its row:
 * `ocr_parts` (its `ocr_engine.parts`) and `mokuro_version` (its `version`).
 * Undefined for a file a person edited (an `edited` block — every edited
 * layer a reader pushes): its `version` is the volume's, not the maker's, so
 * the row keeps what it knew (`makerFieldsOnWrite`).
 */
export function layerFileLabelFields(json: unknown): LayerMakerFields | undefined {
  if (!isPlainObject(json) || isPlainObject(json.edited)) return undefined;
  const parts = ocrPartsOf(json.ocr_engine);
  const version = typeof json.version === 'string' ? json.version.trim() : '';
  return {
    ...(parts ? { ocr_parts: parts } : {}),
    ...(version ? { mokuro_version: version } : {})
  };
}

/** The maker fields a (re)written row stores: the file's, else (an edited file) the row's own. */
export function makerFieldsOnWrite(
  existing: LayerMakerFields | undefined,
  fromFile: LayerMakerFields | undefined
): LayerMakerFields {
  const source = fromFile ?? existing ?? {};
  const parts = validParts(source.ocr_parts);
  return {
    ...(parts ? { ocr_parts: parts } : {}),
    ...(source.mokuro_version ? { mokuro_version: source.mokuro_version } : {})
  };
}
