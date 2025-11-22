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

export const GOOGLE_DRIVE_CONFIG = {
  CLIENT_ID: import.meta.env.VITE_GDRIVE_CLIENT_ID,
  API_KEY: import.meta.env.VITE_GDRIVE_API_KEY,
  DISCOVERY_DOC: 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest',
  SCOPES: 'https://www.googleapis.com/auth/drive.file',
  OAUTH_ENDPOINT: 'https://oauth2.googleapis.com/revoke',

  FOLDER_NAMES: {
    READER: 'mokuro-reader'
  },

  FILE_NAMES: {
    VOLUME_DATA: 'volume-data.json',
    PROFILES: 'profiles.json'
  },

  MIME_TYPES: {
    FOLDER: 'application/vnd.google-apps.folder',
    JSON: 'application/json'
  },

  STORAGE_KEYS: {
    TOKEN: 'gdrive_token',
    TOKEN_EXPIRES: 'gdrive_token_expires',
    SYNC_AFTER_LOGIN: 'sync_after_login',
    LAST_AUTH_TIME: 'gdrive_last_auth_time',
    HAS_AUTHENTICATED: 'gdrive_has_authenticated' // Track if user has ever authenticated
  },

  // Token refresh settings - Layer 1: Smart multi-attempt refresh
  TOKEN_REFRESH_BUFFER_MS: 15 * 60 * 1000, // Start refresh attempts 15 minutes before expiry (at 45 min mark)
  TOKEN_WARNING_BUFFER_MS: 10 * 60 * 1000, // Warn 10 minutes before expiry if refresh attempts failing
  TOKEN_REFRESH_CHECK_INTERVAL_MS: 60 * 1000, // Check every minute for more responsive refresh

  // Multi-attempt refresh schedule (time before expiry -> retry if needed)
  REFRESH_SCHEDULE: [
    { at: 15 * 60 * 1000, maxRetries: 2 }, // 45 min mark: try twice
    { at: 10 * 60 * 1000, maxRetries: 2 }, // 50 min mark: try twice
    { at: 5 * 60 * 1000, maxRetries: 2 }, // 55 min mark: try twice
    { at: 2 * 60 * 1000, maxRetries: 1 } // 58 min mark: last attempt
  ],

  // Debug mode: Set to true to use short-lived tokens for testing (30 seconds)
  DEBUG_SHORT_TOKEN_EXPIRY: false
} as const;
