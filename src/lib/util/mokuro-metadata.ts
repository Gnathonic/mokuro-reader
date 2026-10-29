import type { VolumeMetadata } from '$lib/types';
import { carriedProvenance } from '$lib/catalog/ocr-provenance';

/**
 * The .mokuro JSON the app writes (sidecars, CBZ-embedded, exports).
 * Upstream mokuro's own shape plus `spine_width`, a reader extension (upstream
 * ignores unknown keys), plus at most ONE provenance block: `ocr_engine`
 * (generated — carried, never minted: `buildPrimaryMokuroMetadata`) or
 * `edited` (a person's text). Series metadata lives in the per-series
 * `series.json` sidecar instead — see `$lib/metadata/series-file`.
 */
export interface MokuroMetadata {
  version: string;
  title: string;
  title_uuid: string;
  volume: string;
  volume_uuid: string;
  pages: any[];
  chars: number;
  spine_width?: number;
  /**
   * The generating engine's block, carried verbatim from an installed file
   * whose pages these are (`$lib/catalog/ocr-provenance`).
   */
  ocr_engine?: Record<string, unknown>;
  /**
   * Human corrections (bunko design 0.8 D4) — see {@link buildLayerMokuroMetadata}.
   * On a primary, either this reader's own block or an installed EDITED file's,
   * carried verbatim.
   */
  edited?: MokuroEditedBlock | Record<string, unknown>;
}

/**
 * Marks a `.mokuro` as a person's corrections, not model output (bunko design
 * 0.8 D4): mokuro-bunko never treats such a file as OCR, never upgrades or
 * replaces it. `base_sha256` names the main sidecar the corrections were made
 * on, `base_seal` that file's content seal (`ocr_engine.seal`) — each null
 * when this device does not know it.
 */
export interface MokuroEditedBlock {
  by: 'mokuro-reader';
  at: string;
  base_sha256: string | null;
  base_seal: string | null;
}

export interface BuildMokuroMetadataOptions {
  /** Not-yet-committed rename: build with the NEW titles (uuids unchanged). */
  seriesTitle?: string;
  volumeTitle?: string;
}

const SEAL_RE = /^v1:[0-9a-f]{64}$/;

function editedBlock(
  at: string,
  base: unknown,
  baseSeal: string | null | undefined
): MokuroEditedBlock {
  return {
    by: 'mokuro-reader',
    at,
    base_sha256: typeof base === 'string' && SHA256_HEX_RE.test(base) ? base : null,
    base_seal: typeof baseSeal === 'string' && SEAL_RE.test(baseSeal) ? baseSeal : null
  };
}

/**
 * The upstream shape every .mokuro the app writes is built on (no provenance
 * block: primaries add theirs in `buildPrimaryMokuroMetadata`, layers in
 * `buildLayerMokuroMetadata`). Pure; worker-safe.
 */
export function buildMokuroMetadata(
  volume: VolumeMetadata,
  pages: unknown[],
  opts: BuildMokuroMetadataOptions = {}
): MokuroMetadata {
  const meta: MokuroMetadata = {
    version: volume.mokuro_version,
    title: opts.seriesTitle ?? volume.series_title,
    title_uuid: volume.series_uuid,
    volume: opts.volumeTitle ?? volume.volume_title,
    volume_uuid: volume.volume_uuid,
    pages: pages as any[],
    chars: volume.character_count
  };
  if (volume.spine_width != null) meta.spine_width = volume.spine_width;
  return meta;
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export interface BuildPrimaryMokuroMetadataOptions extends BuildMokuroMetadataOptions {
  /**
   * `pages` are the volume's own primary row (an export, an archive, a cloud
   * main that falls back to the primary) rather than its `original` snapshot:
   * when the volume is edited and no block can be carried, mark it `edited`.
   */
  markEdited?: boolean;
  /** With `markEdited`: the seal of the file the edits were made on (`editBaseSeal`). */
  baseSeal?: string | null;
}

/**
 * The volume's PRIMARY `.mokuro` — every primary or main sidecar the app
 * writes goes through here (layers: `buildLayerMokuroMetadata`).
 *
 * Carries the installed file's block (`ocr_engine`, or an EDITED file's
 * `edited`) exactly when these pages reproduce the digest of that file's
 * pages (`carriedProvenance`): a rename or re-serialization keeps the block
 * (and a seal still checks, names being outside it), an edit drops it. With
 * `markEdited`, an edited volume whose pages carry no block gets a fresh
 * `edited` block instead. Never both. Keys in Bunko's order:
 * version, title, title_uuid, volume, volume_uuid, the block, pages, chars,
 * spine_width.
 */
export async function buildPrimaryMokuroMetadata(
  volume: VolumeMetadata,
  pages: unknown[],
  opts: BuildPrimaryMokuroMetadataOptions = {}
): Promise<MokuroMetadata> {
  const carried = await carriedProvenance(volume.ocr_provenance, pages);
  const ocrEngine = carried?.engine;
  const edited =
    carried?.edited ??
    (!carried && opts.markEdited && volume.ocr_edited_at
      ? editedBlock(volume.ocr_edited_at, volume.mokuro_sha256, opts.baseSeal)
      : undefined);
  const meta: MokuroMetadata = {
    version: volume.mokuro_version,
    title: opts.seriesTitle ?? volume.series_title,
    title_uuid: volume.series_uuid,
    volume: opts.volumeTitle ?? volume.volume_title,
    volume_uuid: volume.volume_uuid,
    ...(ocrEngine ? { ocr_engine: ocrEngine } : {}),
    ...(edited ? { edited } : {}),
    pages: pages as any[],
    chars: volume.character_count
  };
  if (volume.spine_width != null) meta.spine_width = volume.spine_width;
  return meta;
}

/**
 * The `.mokuro` of one OCR LAYER — every layer file the app writes (layer-sync
 * pushes, backup/rename layer sidecars, exports) goes through here. Upstream
 * format with the layer's own character count; a layer of kind `edit` (the
 * editor's `edit` layer, a hand-made layer) also carries the top-level
 * `edited` block, so a server can tell a person's corrections from model
 * output. A layer file never carries `ocr_engine`: only a primary does
 * (`buildPrimaryMokuroMetadata`). `opts.baseSeal` is the seal of the main
 * sidecar the edits sit on (`editBaseSeal`; sync callers pass none).
 */
export function buildLayerMokuroMetadata(
  volume: VolumeMetadata,
  layer: { kind: string; updated_at: string; pages: unknown[] },
  characterCount: number,
  opts: BuildMokuroMetadataOptions & { baseSeal?: string | null } = {}
): MokuroMetadata {
  const meta = buildMokuroMetadata(
    { ...volume, character_count: characterCount },
    layer.pages,
    opts
  );
  if (layer.kind === 'edit') {
    meta.edited = editedBlock(layer.updated_at, volume.mokuro_sha256, opts.baseSeal);
  }
  return meta;
}
