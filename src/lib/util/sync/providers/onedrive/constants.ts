export const ONEDRIVE_CONFIG = {
  CLIENT_ID: import.meta.env.VITE_ONEDRIVE_CLIENT_ID as string | undefined,
  AUTHORITY: 'https://login.microsoftonline.com/common',
  SCOPES: ['Files.ReadWrite', 'offline_access', 'User.Read'],

  GRAPH_BASE_URL: 'https://graph.microsoft.com/v1.0',
  MOKURO_FOLDER: 'mokuro-reader',

  /** 10 MiB — Microsoft's recommended chunk size for upload sessions */
  UPLOAD_CHUNK_SIZE: 10 * 1024 * 1024,

  STORAGE_KEYS: {
    HAS_AUTHENTICATED: 'onedrive_has_authenticated'
  }
} as const;
