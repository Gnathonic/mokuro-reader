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
  char_offsets_method?: string;
  spine_width?: number;
}

export interface BuildMokuroMetadataOptions {
  /** Not-yet-committed rename: build with the NEW titles (uuids unchanged). */
  seriesTitle?: string;
  volumeTitle?: string;
}

/** A block carrying at least one placed (non-null) `char_offsets` entry. */
function hasPlacement(page: unknown): boolean {
  const blocks = (page as { blocks?: unknown })?.blocks;
  if (!Array.isArray(blocks)) return false;
  return blocks.some((block) => {
    const offsets = (block as { char_offsets?: unknown })?.char_offsets;
    return Array.isArray(offsets) && offsets.some((entry) => entry != null);
  });
}

/** The first page-level `char_offsets_method` found among the volume's pages. */
function firstCharOffsetsMethod(pages: unknown[]): string | undefined {
  for (const page of pages) {
    const method = (page as { char_offsets_method?: unknown })?.char_offsets_method;
    if (typeof method === 'string') return method;
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
  if (pages.some(hasPlacement)) {
    const method = firstCharOffsetsMethod(pages);
    if (method != null) meta.char_offsets_method = method;
  }
  if (volume.spine_width != null) meta.spine_width = volume.spine_width;
  return meta;
}
