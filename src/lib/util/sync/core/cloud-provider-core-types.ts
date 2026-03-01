import type { ProviderType } from '$lib/util/sync/provider-interface';

export type CloudCoreProviderType = ProviderType;

export type CloudCoreCredentials = Record<string, unknown>;

export interface CloudCoreDownloadArgs {
  fileId: string;
  credentials: CloudCoreCredentials;
  onProgress: (loaded: number, total: number) => void;
}

export interface CloudCoreUploadArgs {
  seriesTitle: string;
  filename: string;
  blob: Blob;
  credentials: CloudCoreCredentials;
  mimeType?: string;
  existingFileId?: string;
  onProgress?: (loaded: number, total: number) => void;
}

export interface CloudProviderCore {
  downloadFile(args: CloudCoreDownloadArgs): Promise<ArrayBuffer>;
  uploadFile(args: CloudCoreUploadArgs): Promise<string>;
}

export function requireCredentialString(
  credentials: CloudCoreCredentials,
  key: string,
  label: string
): string {
  const value = credentials[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing ${label}`);
  }
  return value;
}

export function optionalCredentialString(credentials: CloudCoreCredentials, key: string): string {
  const value = credentials[key];
  return typeof value === 'string' ? value : '';
}
