import type { ProviderType, UploadFileResult } from '$lib/util/sync/provider-interface';
import type { UploadRetryInfo } from '$lib/util/sync/providers/webdav/webdav-upload';

export type CloudCoreProviderType = ProviderType;

export type CloudCoreCredentials = Record<string, unknown>;

/**
 * A request carrying a bearer token was answered 401: ask the session for
 * fresh credentials (`staleAuthorization` is the header that was refused, so a
 * token someone else already replaced is not re-issued again). Null = no
 * fresh credentials (re-issue refused, rate-limited, unreachable): the request
 * fails with its 401. Main thread: the provider's single-flight re-issue.
 * Worker: a round trip to the main thread (`worker-auth-refresh.ts`).
 */
export type CloudCoreAuthRefresher = (
  staleAuthorization: string
) => Promise<CloudCoreCredentials | null>;

export interface CloudCoreDownloadArgs {
  fileId: string;
  credentials: CloudCoreCredentials;
  onProgress: (loaded: number, total: number) => void;
  refreshAuth?: CloudCoreAuthRefresher;
}

export interface CloudCoreUploadArgs {
  seriesTitle: string;
  filename: string;
  blob: Blob;
  credentials: CloudCoreCredentials;
  mimeType?: string;
  existingFileId?: string;
  onProgress?: (loaded: number, total: number) => void;
  /** A transient failure is being retried (providers that retry archive uploads). */
  onRetry?: (info: UploadRetryInfo) => void;
  refreshAuth?: CloudCoreAuthRefresher;
}

export interface CloudProviderCore {
  downloadFile(args: CloudCoreDownloadArgs): Promise<ArrayBuffer>;
  uploadFile(args: CloudCoreUploadArgs): Promise<UploadFileResult>;
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
