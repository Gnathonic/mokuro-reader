/**
 * Sync Provider Interface
 *
 * Defines the contract that all sync providers (Google Drive, MEGA, WebDAV) must implement.
 * This allows for a unified sync experience across different cloud storage backends.
 */

export type ProviderType = 'google-drive' | 'mega' | 'webdav';

/**
 * Pseudo-provider for local browser downloads (not a real sync provider)
 * Used by backup-queue.ts to handle export-to-download operations
 *
 * IMPORTANT: This should NOT be used where real ProviderType is expected.
 * It doesn't implement SyncProvider interface and can't be used for sync operations.
 */
export type PseudoProviderType = 'export-for-download';

/**
 * Union type for backup queue operations (real providers + pseudo-providers)
 */
export type BackupProviderType = ProviderType | PseudoProviderType;

/**
 * Type guard to check if a provider is a real sync provider
 */
export function isRealProvider(provider: BackupProviderType): provider is ProviderType {
  return provider === 'google-drive' || provider === 'mega' || provider === 'webdav';
}

/**
 * Type guard to check if a provider is a pseudo-provider
 */
export function isPseudoProvider(provider: BackupProviderType): provider is PseudoProviderType {
  return provider === 'export-for-download';
}

/**
 * Export Provider - Pseudo-provider for local browser downloads
 * Implements minimal provider interface to work uniformly with backup queue
 */
class ExportProvider {
  readonly type = 'export-for-download' as const;
  readonly name = 'Local Export';
  readonly uploadConcurrencyLimit = 6; // No network, purely CPU/memory bound
  readonly downloadConcurrencyLimit = 0; // Not applicable for export

  // Export provider doesn't need most of these, but implements for interface compatibility
  isAuthenticated(): boolean {
    return true; // Always "ready"
  }

  getStatus(): ProviderStatus {
    return {
      isAuthenticated: true,
      hasStoredCredentials: true,
      needsAttention: false,
      statusMessage: 'Ready to export'
    };
  }

  // Not supported operations - throw errors
  async login(): Promise<void> {
    throw new Error('Export provider does not support login');
  }

  async logout(): Promise<void> {
    throw new Error('Export provider does not support logout');
  }

  async listCloudVolumes(): Promise<CloudFileMetadata[]> {
    throw new Error('Export provider does not support cloud operations');
  }

  async uploadFile(): Promise<string> {
    throw new Error('Export provider does not support cloud operations');
  }

  async downloadFile(_file: CloudFileMetadata): Promise<Blob> {
    throw new Error('Export provider does not support cloud operations');
  }

  async deleteFile(_file: CloudFileMetadata): Promise<void> {
    throw new Error('Export provider does not support cloud operations');
  }
}

/**
 * Singleton instance of export provider
 */
export const exportProvider = new ExportProvider();

export interface ProviderStatus {
  isAuthenticated: boolean;
  /** Whether credentials are configured (even if not currently connected) */
  hasStoredCredentials: boolean;
  needsAttention: boolean;
  statusMessage: string;
}

export interface ProviderCredentials {
  // Google Drive: not used (OAuth)
  // MEGA: { email: string, password: string }
  // WebDAV: { serverUrl: string, username: string, password: string }
  [key: string]: any;
}

/**
 * Base metadata for a cloud-stored file (CBZ file)
 * This is the common interface - use provider-specific types when possible
 */
export interface CloudFileMetadata {
  /** Provider type discriminator for type-safe narrowing */
  provider: ProviderType;
  /** Provider-specific file ID (opaque - use full metadata object for operations) */
  fileId: string;
  /** Path in format "SeriesTitle/VolumeTitle.cbz" */
  path: string;
  /** File modification timestamp */
  modifiedTime: string;
  /** File size in bytes */
  size: number;
  /** Optional description/metadata */
  description?: string;
}

/**
 * Google Drive specific metadata
 * Extends base with Drive-specific fields
 */
export interface DriveFileMetadata extends CloudFileMetadata {
  provider: 'google-drive';
  /** Parent folder ID for hierarchical operations */
  parentId?: string;
  /** Original file name from Drive */
  name?: string;
}

/**
 * MEGA specific metadata
 * Extends base with MEGA-specific fields
 */
export interface MegaFileMetadata extends CloudFileMetadata {
  provider: 'mega';
  /** MEGA node handle (currently unused but reserved for future) */
  nodeHandle?: string;
}

/**
 * WebDAV specific metadata
 * Extends base with WebDAV-specific fields
 */
export interface WebDAVFileMetadata extends CloudFileMetadata {
  provider: 'webdav';
  /** Entity tag for cache validation */
  etag?: string;
  /** Full WebDAV URL */
  url?: string;
}

/**
 * Discriminated union of all cloud file metadata types
 * Use this when you need to handle any provider's metadata
 */
export type AnyCloudFileMetadata = DriveFileMetadata | MegaFileMetadata | WebDAVFileMetadata;

export interface SyncProvider {
  /** Provider type identifier */
  readonly type: ProviderType;

  /** Human-readable provider name */
  readonly name: string;

  /**
   * Indicates if this provider supports direct downloads in web workers.
   * - true: Workers can download directly (Google Drive, WebDAV)
   * - false: Main thread must download, workers decompress only (MEGA)
   */
  readonly supportsWorkerDownload: boolean;

  /**
   * Maximum concurrent upload operations for this provider
   * Controls how many simultaneous uploads can run for this provider
   * Worker pool size is based on hardware (CPU cores), this is provider-specific
   */
  readonly uploadConcurrencyLimit: number;

  /**
   * Maximum concurrent download operations for this provider
   * Controls how many simultaneous downloads can run for this provider
   * Worker pool size is based on hardware (CPU cores), this is provider-specific
   */
  readonly downloadConcurrencyLimit: number;

  /** Check if user is currently authenticated */
  isAuthenticated(): boolean;

  /** Get current provider status */
  getStatus(): ProviderStatus;

  /**
   * Authenticate with the provider
   * @param credentials Provider-specific credentials
   */
  login(credentials?: ProviderCredentials): Promise<void>;

  /** Logout and clear stored credentials */
  logout(): Promise<void>;

  // GENERIC FILE OPERATIONS (BLOB-BASED)
  /**
   * List all files in cloud storage
   * @returns Array of cloud file metadata
   */
  listCloudVolumes(): Promise<CloudFileMetadata[]>;

  /**
   * Upload a file to cloud storage
   * @param path Target path (e.g., "SeriesTitle/VolumeTitle.cbz")
   * @param blob File data as Blob
   * @param description Optional file description
   * @returns File ID in cloud storage
   */
  uploadFile(path: string, blob: Blob, description?: string): Promise<string>;

  /**
   * Download a file from cloud storage
   * @param file Cloud file metadata (provider extracts internal ID)
   * @param onProgress Optional progress callback (loaded, total)
   * @returns File data as Blob
   */
  downloadFile(
    file: CloudFileMetadata,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<Blob>;

  /**
   * Delete a file from cloud storage
   * @param file Cloud file metadata (provider extracts internal ID)
   */
  deleteFile(file: CloudFileMetadata): Promise<void>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly providerType: ProviderType,
    public readonly code?: string,
    public readonly isAuthError: boolean = false,
    public readonly isNetworkError: boolean = false
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
