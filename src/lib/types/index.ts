export type Block = {
  box: number[];
  vertical: boolean;
  font_size: number;
  lines: string[];
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

  // Generic cloud storage fields (new multi-provider format)
  cloudProvider?: 'google-drive' | 'mega' | 'webdav';
  cloudFileId?: string;
  cloudModifiedTime?: string;
  cloudSize?: number;

  // Legacy Drive-specific fields (kept for backward compatibility)
  // When present without cloudProvider, assumed to be google-drive
  driveFileId?: string;
  driveModifiedTime?: string;
  driveSize?: number;
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
