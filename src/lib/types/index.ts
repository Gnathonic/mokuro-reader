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
  pages: Page[];
  edited_pages?: Page[];
  files?: Record<string, File>;
}
