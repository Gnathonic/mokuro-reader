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
  mokuro_version: string;
  series_title: string;
  series_uuid: string;
  volume_title: string;
  volume_uuid: string;
  page_count: number;
  character_count: number;
  characters_per_page?: number[]; // v3: Pre-calculated character count per page
  thumbnail?: File;

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

export interface VolumeData {
  volume_uuid: string;
  pages: Page[]; // v3: OCR data only, images moved to volumes_images
}

// v3: Thumbnail cache
export interface VolumeCover {
  volume_uuid: string;
  thumbnail: File;
}

// v3: Per-page image storage (separated from OCR data in volumes_data)
export interface VolumeImage {
  volume_uuid: string;
  page_number: number;
  filename: string;
  image: File;
}
