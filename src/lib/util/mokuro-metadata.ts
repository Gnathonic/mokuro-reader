import type { VolumeMetadata } from '$lib/types';
import type { EmbeddedSeriesMetadata, SeriesMetadata } from '$lib/metadata/types';
import { toEmbedded } from '$lib/metadata/embed';

/**
 * The .mokuro JSON the app writes (sidecars, CBZ-embedded, exports).
 * `series_metadata` and `spine_width` are reader extensions; upstream mokuro
 * ignores unknown keys, mokuro-bunko reads `series_metadata.tag`.
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
  series_metadata?: EmbeddedSeriesMetadata;
}

export interface BuildMokuroMetadataOptions {
  /** Not-yet-committed rename: build with the NEW titles (uuids unchanged). */
  seriesTitle?: string;
  volumeTitle?: string;
  /** Series record to embed (facts + tag only). */
  seriesMetadata?: SeriesMetadata | null;
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
  const embedded = toEmbedded(opts.seriesMetadata);
  if (embedded) meta.series_metadata = embedded;
  return meta;
}
