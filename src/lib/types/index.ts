import type { ProviderType } from '$lib/util/sync/provider-interface';

export type Block = {
  box: number[];
  vertical: boolean;
  font_size: number;
  lines: string[];
  /** Per-line quadrilaterals (4 corner points each) from mokuro; present in
   * standard .mokuro output and stored verbatim, but optional because
   * image-only volumes and older imports may lack it. */
  lines_coords?: number[][][];
};

export type Page = {
  version: string;
  img_width: number;
  img_height: number;
  blocks: Block[];
  img_path: string;
};

export interface VolumeMetadata {
  mokuro_version: string; // Empty string '' indicates image-only volume without OCR
  series_title: string;
  series_uuid: string;
  volume_title: string;
  volume_uuid: string;
  page_count: number;
  character_count: number;
  // Cumulative character counts per page: [50, 120, 200] means page 3 has 200 total chars through it
  page_char_counts: number[];

  // Thumbnail (small ~10-20KB file) and dimensions for synchronous layout
  thumbnail?: File;
  thumbnail_width?: number;
  thumbnail_height?: number;

  // Number of missing pages that were replaced with placeholders during import
  missing_pages?: number;
  // Paths of pages that were replaced with placeholders (for forced OCR visibility)
  missing_page_paths?: string[];

  // Placeholder fields for cloud-only volumes (not yet downloaded locally)
  isPlaceholder?: boolean;

  /**
   * Placeholders only, and never stored: this placeholder was built from a
   * `series.json` entry, so its uuid and counts are the volume's real ones
   * rather than derived from its path. Set at construction
   * (`createPlaceholder`) because it is a fact about where the data came from,
   * which no later inspection of the values can recover. Read it through
   * `isIndexedPlaceholder` (`$lib/catalog/placeholders`).
   */
  indexed?: true;

  /**
   * This row is metadata only: the volume's OCR and image rows are not on this
   * device (the user removed them to save space). Everything else — thumbnail,
   * counts, and above all the `volume_uuid` the read history is keyed by —
   * stays, so the volume still shows and still counts; it just cannot be
   * opened until it is downloaded again. Absent on installed volumes, and
   * never set on placeholders, which have no row at all.
   *
   * A state, like `mokuro_version === ''` for image-only volumes, not an event.
   * Read it through `isVolumeInstalled`/`needsDownload`
   * (`$lib/catalog/volume-state`) rather than testing the flag directly.
   */
  metadata_only?: true;

  // Generic cloud storage fields (new multi-provider format)
  cloudProvider?: ProviderType;
  cloudFileId?: string;
  cloudModifiedTime?: string;
  cloudSize?: number;
  cloudPath?: string; // Full path for series extraction during download
  cloudThumbnailFileId?: string; // Provider-specific file ID for cloud thumbnail sidecar
  cloudThumbnailPath?: string; // Full path to the thumbnail sidecar (e.g. "Series/Volume.webp" or "Series/Volume.jpg")
  /**
   * The cloud LISTING's own size/mtime for `cloudThumbnailFileId`, decorated
   * onto a placeholder or a metadata-only row's in-memory copy alongside the
   * other `cloudThumbnail*` fields — never stored on the row itself. This is
   * the DECISION-TIME snapshot a cover fetch is committed against: see
   * `cover_size`/`cover_modified` below for the PERSISTED counterpart derived
   * from it once a fetch actually lands.
   */
  cloudThumbnailSize?: number;
  cloudThumbnailModifiedTime?: string;

  // Legacy Drive-specific fields (kept for backward compatibility)
  // When present without cloudProvider, assumed to be google-drive
  driveFileId?: string;
  driveModifiedTime?: string;
  driveSize?: number;

  // Spine width in pixels (from mokuro metadata, used for catalog stacking)
  spine_width?: number;

  /**
   * Bytes of this volume's `.cbz`.
   *
   * A permanent fact about the archive, like `spine_width` — not per-user state
   * and not a cloud field: it is recorded wherever the size is cheaply known
   * (backup upload, cloud download, a cloud listing, a `series.json` entry) and
   * kept afterwards, so a volume whose pages are not on this device can still
   * say how big the download is even with no provider connected.
   *
   * Absent means "nobody has told us yet", never "zero bytes". Read it through
   * `getArchiveSize` (`$lib/util/cloud-fields`), which prefers a live listing.
   */
  archive_size?: number;

  /**
   * The cloud LISTING's size (bytes) / mtime (epoch seconds, truncated) for
   * the cover sidecar a PERSISTED `thumbnail` on this row came from — set
   * only when the thumbnail was fetched from the cloud with a decision-time
   * listing snapshot in hand (the catalog card's cover-persist path, or a
   * backfill's stale-cover refresh); absent for a thumbnail measured from the
   * volume's own pages (an installed volume) or installed by older code that
   * predates this scheme.
   *
   * Mirrors `SeriesFileVolume.cover_size`/`cover_modified`
   * (`$lib/metadata/series-file`) in name and exact semantics — same guards
   * (`isArchiveSize`/epoch-seconds), same staleness rule
   * (`isSidecarStale`/`$lib/metadata/cloud-sidecar-stamps`): ABSENT is never
   * treated as stale on its own (a stampless thumbnail adopts the listing as
   * baseline rather than being re-fetched — the same migration-safety
   * inversion as the series-index entry stamps). Never read as a source of
   * truth by anything other than the staleness check that decides whether to
   * re-fetch — the reader always prefers the row's OWN `thumbnail` file.
   */
  cover_size?: number;
  cover_modified?: number;
}

// v3 table: volume_ocr
export interface VolumeOCR {
  volume_uuid: string;
  pages: Page[];
}

// v3 table: volume_files
export interface VolumeFiles {
  volume_uuid: string;
  files: Record<string, File>;
}

// Combined view for API compatibility (assembled from volume_ocr + volume_files)
export interface VolumeData {
  volume_uuid: string;
  pages: Page[];
  files?: Record<string, File>;
}
