import type { VolumeMetadata } from '$lib/types';
import { pageHasPlacement } from '$lib/reader/char-offsets';

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
  char_offsets_method?: string;
  spine_width?: number;
}

export interface BuildMokuroMetadataOptions {
  /** Not-yet-committed rename: build with the NEW titles (uuids unchanged). */
  seriesTitle?: string;
  volumeTitle?: string;
}

/**
 * The method of the first PLACED page that names one. A page without placement
 * is skipped even when it carries the key: whatever it says describes text that
 * is not there, and must not label the volume ahead of a page that placed.
 */
function firstCharOffsetsMethod(pages: unknown[]): string | undefined {
  for (const page of pages) {
    const method = (page as { char_offsets_method?: unknown })?.char_offsets_method;
    if (typeof method === 'string' && pageHasPlacement(page)) return method;
  }
  return undefined;
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
  // Only emit the top-level method when some block actually has placement —
  // a stray page-level key with nothing placed anywhere shouldn't claim the
  // whole volume was processed by that method.
  const method = firstCharOffsetsMethod(pages);
  if (method != null) meta.char_offsets_method = method;
  if (volume.spine_width != null) meta.spine_width = volume.spine_width;
  return meta;
}
