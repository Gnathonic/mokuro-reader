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
 * The primary is named by the maker of the CURRENT main, recorded on the
 * volume row whenever a main is installed, replaced or promoted
 * (`VolumeMetadata.ocr_maker`); an edit keeps it. A layer's id still names it
 * when the id says what the layer IS (an account's corrections, the shared
 * `curated`, a hand-made layer). Only a set-aside main sidecar
 * (`pre-upgrade…`, `previous-ocr…`) and the OCR upgrade's `updated-ocr` —
 * whose ids say nothing about their maker — are named by the mokuro version
 * when no engine made them.
 */
import {
  isCuratedLayerId,
  isPersonalLayerId,
  isServerKeepsakeLayerId,
  isSetAsideLayerId,
  layerNameForId,
  PREVIOUS_OCR_ID_RE,
  PREVIOUS_OCR_NAME_RE,
  titleCasedLayerId,
  UPDATED_OCR_LAYER_ID,
  UPDATED_OCR_LAYER_NAME
} from './layer-names';

export { isSetAsideLayerId };

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
 * What made a volume's CURRENT main OCR (`VolumeMetadata.ocr_maker`): the
 * engine id and parts of the file's `ocr_engine`, else (mokuro wrote it) just
 * its version. Stored when a main is installed, replaced or promoted; an edit
 * keeps it, so an edited main is still named by what made it.
 */
export interface MainOcrMaker {
  engine?: string;
  parts?: OcrPart[];
  /** The version the maker's file named; absent → the row's `mokuro_version`. */
  mokuro_version?: string;
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The maker of a main file from its provenance entry (`provenanceOfFile`) and
 * `version`: a GENERATED file's engine and parts; nothing known for an EDITED
 * file (undefined: the volume falls back as before); no block at all → mokuro
 * made it.
 */
export function mainMakerOfFile(
  provenance: unknown,
  version: string | null | undefined
): MainOcrMaker | undefined {
  if (isPlainObject(provenance) && isPlainObject(provenance.edited)) return undefined;
  const v = trimmed(version);
  const engine = isPlainObject(provenance) ? provenance.engine : undefined;
  if (isPlainObject(engine) && trimmed(engine.id)) {
    const parts = ocrPartsOf(engine);
    return {
      engine: trimmed(engine.id),
      ...(parts ? { parts } : {}),
      ...(v ? { mokuro_version: v } : {})
    };
  }
  return v ? { mokuro_version: v } : {};
}

/**
 * The maker a layer brings when it is promoted to the main: what its file
 * said (engine, parts, version). Undefined when the row knows nothing of a
 * maker (the `original`, a person's corrections, a hand-made layer): those
 * pages are the current main's, or edits on it, so its maker stays.
 */
export function mainMakerOfLayer(layer: {
  engine?: string;
  maker_engine?: string;
  ocr_parts?: unknown;
  mokuro_version?: string;
}): MainOcrMaker | undefined {
  const engine = trimmed(layer.engine) || trimmed(layer.maker_engine);
  const parts = validParts(layer.ocr_parts);
  const version = trimmed(layer.mokuro_version);
  if (!engine && !parts && !version) return undefined;
  return {
    ...(engine ? { engine } : {}),
    ...(parts ? { parts } : {}),
    ...(version ? { mokuro_version: version } : {})
  };
}

/**
 * What the primary OCR row is called in the layer picker, settings select and
 * switch toasts: what made the CURRENT main (`ocr_maker`, `ocrFileLabel`) —
 * also once edited here. A volume installed before the maker was recorded
 * falls back to its newest provenance entry while unedited, else
 * `mokuro <version>` (an image-only volume: `mokuro`).
 */
export function primaryLayerName(
  volume:
    | {
        mokuro_version?: string | null;
        ocr_edited_at?: string;
        ocr_provenance?: readonly unknown[];
        ocr_maker?: unknown;
      }
    | null
    | undefined
): string {
  if (!volume) return mokuroLabel(undefined);
  const maker = volume.ocr_maker;
  if (isPlainObject(maker)) {
    return ocrFileLabel({
      engine: trimmed(maker.engine) || undefined,
      parts: validParts(maker.parts),
      version: trimmed(maker.mokuro_version) || volume.mokuro_version
    });
  }
  const engine = volume.ocr_edited_at ? null : newestEngineBlock(volume.ocr_provenance);
  return ocrFileLabel({
    ...(engine ? { engine: engine.id as string, parts: ocrPartsOf(engine) } : {}),
    version: volume.mokuro_version
  });
}

/** What a layer row knows about the file it was read from, and how it was named. */
export interface LayerLabelRow {
  layer_id: string;
  name: string;
  engine?: string;
  /** The engine a file named, kept for naming only (`updated-ocr`, which is never filed by it). */
  maker_engine?: string;
  ocr_parts?: OcrPart[];
  mokuro_version?: string;
  /** The user typed this name (a rename, or a layer made by name): never relabelled. */
  named_by_user?: true;
  cloud?: unknown;
  passive_at?: string;
  source_at?: string;
}

function isCorrectionsId(layerId: string): boolean {
  return (
    isCuratedLayerId(layerId) || isPersonalLayerId(layerId) || isServerKeepsakeLayerId(layerId)
  );
}

/** Ids that say why a layer exists, not who made it: named by their maker. */
function isNamedByMaker(layerId: string): boolean {
  return isSetAsideLayerId(layerId) || layerId === UPDATED_OCR_LAYER_ID;
}

/**
 * The name a layer row gets when nobody renamed it: a corrections layer by its
 * id ("Your corrections", "Shared corrections"); a file with parts by its
 * parts; a set-aside main sidecar or `updated-ocr` by its maker
 * (`ocrFileLabel`); anything else by its id, as before (`layerNameForId`:
 * "PP-OCR Manga", "Charspot Small").
 */
export function autoLayerName(row: Omit<LayerLabelRow, 'name'>): string {
  if (isCorrectionsId(row.layer_id)) return layerNameForId(row.layer_id);
  const parts = validParts(row.ocr_parts);
  if (parts) return partsLabel(parts);
  if (isNamedByMaker(row.layer_id)) {
    return ocrFileLabel({
      engine: row.engine || row.maker_engine,
      version: row.mokuro_version
    });
  }
  return layerNameForId(row.layer_id);
}

/**
 * Did the row come from a file (a cloud listing, an import, an archive, the
 * OCR upgrade, reader v1.10.0's keepsake) rather than from a person making it
 * here? Only such a row was ever named by the reader.
 */
function cameFromFile(row: LayerLabelRow): boolean {
  return (
    !!row.cloud ||
    !!row.engine ||
    !!row.maker_engine ||
    !!validParts(row.ocr_parts) ||
    !!row.mokuro_version ||
    row.passive_at !== undefined ||
    row.source_at !== undefined
  );
}

/** A name an earlier reader gave this id (before layers were named by maker). */
function isLegacyAutoName(row: LayerLabelRow): boolean {
  if (row.name === titleCasedLayerId(row.layer_id) || row.name === layerNameForId(row.layer_id)) {
    return true;
  }
  if (PREVIOUS_OCR_ID_RE.test(row.layer_id) && PREVIOUS_OCR_NAME_RE.test(row.name)) return true;
  return row.layer_id === UPDATED_OCR_LAYER_ID && row.name === UPDATED_OCR_LAYER_NAME;
}

/**
 * Was this row named by the reader, never by a person? Not if the user typed
 * its name (`named_by_user`, set by a rename or by making a layer by name),
 * nor if it was made here rather than read from a file; else its name must be
 * one the reader gave it — an old one (the title-cased slug "Pre Upgrade",
 * the id's display name, v1.10.0's "Previous OCR", "Updated OCR") or the label
 * its file gives it now.
 */
export function isAutoNamedLayer(row: LayerLabelRow): boolean {
  if (row.named_by_user || !cameFromFile(row)) return false;
  return isLegacyAutoName(row) || row.name === autoLayerName(row);
}

/** The name to show: what the user typed, else what the row's file says made it. */
export function layerDisplayName(row: LayerLabelRow): string {
  return isAutoNamedLayer(row) ? autoLayerName(row) : row.name;
}

/**
 * The name to store when a file (re)writes a layer row: the existing row's own
 * name unless the reader gave it, else the new file's (`autoLayerName`).
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

/** A parsed layer file's maker, and whether a server stamped it (`ocr_engine`). */
export interface LayerFileMaker {
  fields: LayerMakerFields;
  /** The file carries an `ocr_engine` block: it says who made it. */
  stamped: boolean;
}

/** The version of the OCR on these pages: the first page that names one. */
export function pagesVersion(pages: unknown): string {
  if (!Array.isArray(pages)) return '';
  for (const page of pages) {
    const v = isPlainObject(page) ? trimmed(page.version) : '';
    if (v) return v;
  }
  return '';
}

/**
 * What a parsed layer file says about its maker, to remember on its row:
 * `ocr_parts` (its `ocr_engine.parts`) and `mokuro_version` — the version its
 * PAGES name (mokuro writes it on every page, and a file the reader writes
 * keeps the pages' own), else the file's top-level `version`. Undefined for a
 * file a person edited (an `edited` block): it says nothing of its maker.
 */
export function layerFileMaker(json: unknown): LayerFileMaker | undefined {
  if (!isPlainObject(json) || isPlainObject(json.edited)) return undefined;
  const parts = ocrPartsOf(json.ocr_engine);
  const version = pagesVersion(json.pages) || trimmed(json.version);
  return {
    fields: {
      ...(parts ? { ocr_parts: parts } : {}),
      ...(version ? { mokuro_version: version } : {})
    },
    stamped: isPlainObject(json.ocr_engine)
  };
}

function hasMakerFields(row: LayerMakerFields | undefined): boolean {
  return !!row && (!!validParts(row.ocr_parts) || !!trimmed(row.mokuro_version));
}

/**
 * The maker fields a (re)written row stores. The file's — unless the file
 * cannot say: an edited file, or one with no `ocr_engine` (a file the reader
 * itself wrote, re-imported) over a row that already knows its maker. Then
 * the row keeps what it knew.
 */
export function makerFieldsOnWrite(
  existing: LayerMakerFields | undefined,
  file: LayerFileMaker | undefined
): LayerMakerFields {
  const keep = !file || (!file.stamped && hasMakerFields(existing));
  const source = keep ? (existing ?? {}) : file.fields;
  const parts = validParts(source.ocr_parts);
  const version = trimmed(source.mokuro_version);
  return {
    ...(parts ? { ocr_parts: parts } : {}),
    ...(version ? { mokuro_version: version } : {})
  };
}
