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
