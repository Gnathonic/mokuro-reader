import type { VolumeMetadata } from '$lib/types';

/**
 * The .mokuro JSON the app writes (sidecars, CBZ-embedded, exports).
 * Upstream mokuro's own shape plus `spine_width`, a reader extension (upstream
 * ignores unknown keys). Series metadata lives in the per-series `series.json`
 * sidecar instead — see `$lib/metadata/series-file`.
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
  /** A layer of human corrections (bunko design 0.8 D4) — see {@link buildLayerMokuroMetadata}. */
  edited?: MokuroEditedBlock;
}

/**
 * Marks a `.mokuro` as a person's corrections, not model output (bunko design
 * 0.8 D4): mokuro-bunko never treats such a file as OCR, never upgrades or
 * replaces it, and `base_sha256` names the main sidecar the corrections were
 * made on (null when this device does not know it).
 */
export interface MokuroEditedBlock {
  by: 'mokuro-reader';
  at: string;
  base_sha256: string | null;
}

export interface BuildMokuroMetadataOptions {
  /** Not-yet-committed rename: build with the NEW titles (uuids unchanged). */
  seriesTitle?: string;
  volumeTitle?: string;
}

/** Single source of truth for every .mokuro the app writes. Pure; worker-safe. */
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

/**
 * The `.mokuro` of one OCR LAYER — every layer file the app writes (layer-sync
 * pushes, backup/rename layer sidecars, exports) goes through here. Upstream
 * format with the layer's own character count; a layer of kind `edit` (the
 * editor's `edit` layer, a hand-made layer) also carries the top-level
 * `edited` block, so a server can tell a person's corrections from model
 * output. Nothing the app writes carries `ocr_engine`.
 */
export function buildLayerMokuroMetadata(
  volume: VolumeMetadata,
  layer: { kind: string; updated_at: string; pages: unknown[] },
  characterCount: number,
  opts: BuildMokuroMetadataOptions = {}
): MokuroMetadata {
  const meta = buildMokuroMetadata(
    { ...volume, character_count: characterCount },
    layer.pages,
    opts
  );
  if (layer.kind === 'edit') {
    const base = volume.mokuro_sha256;
    meta.edited = {
      by: 'mokuro-reader',
      at: layer.updated_at,
      base_sha256: typeof base === 'string' && SHA256_HEX_RE.test(base) ? base : null
    };
  }
  return meta;
}
