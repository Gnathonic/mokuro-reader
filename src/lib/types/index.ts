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

export type MokuroData = {
  version: string;
  title: string;
  title_uuid: string;
  volume: string;
  volume_uuid: string;
  pages: Page[];
};

export type VolumeFile = {
  id: string;
  volumeId: string;
  path: string;
  file: File;
};

export type Volume = {
  id: string;
  mokuroData: MokuroData;
  volumeName: string;
  fileIds: Record<string, string>;
  thumbnail?: string; // Base64 thumbnail for quick loading
};
