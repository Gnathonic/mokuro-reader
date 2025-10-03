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

  // Placeholder fields for Drive-only volumes (not yet downloaded)
  isPlaceholder?: boolean;      // True if this is a Drive-only placeholder
  driveFileId?: string;         // Google Drive file ID
  driveModifiedTime?: string;   // Last modified timestamp from Drive
  driveSize?: number;           // File size in bytes
}

export interface VolumeData {
  volume_uuid: string;
  pages: Page[];
  files?: Record<string, File>;
}
