export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  parents?: string[];
  description?: string;
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

  // Token expiry monitoring
  TOKEN_WARNING_BUFFER_MS: 10 * 60 * 1000, // Warn 10 minutes before expiry
  TOKEN_REFRESH_CHECK_INTERVAL_MS: 60 * 1000, // Check every minute

  // Debug mode: Set to true to use short-lived tokens for testing (30 seconds)
  DEBUG_SHORT_TOKEN_EXPIRY: false
} as const;
