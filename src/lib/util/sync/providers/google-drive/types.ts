export interface TokenInfo {
  access_token: string;
  expires_in: number;
  expires_at: number;
  refresh_token?: string;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  parents?: string[];
  description?: string;
}

export interface SyncProgress {
  phase: 'connecting' | 'downloading' | 'merging' | 'uploading' | 'complete' | 'error';
  progress: number;
  status: string;
}
