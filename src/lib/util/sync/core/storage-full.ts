/**
 * A full account, across the worker boundary. Worker-safe: no svelte, no DOM.
 *
 * The cores throw a full account as the providers' typed `QUOTA_EXCEEDED`
 * error, but the upload worker posts only `error: message` for a failure; the
 * type does not survive. It therefore also posts `kind: 'quota'` for a full
 * account, and the backup queue turns that into the same "storage is full"
 * wording the main-thread providers raise — falling back to the message for
 * an error the pool synthesized or an older worker bundle posted.
 */

import { DriveHttpError, isQuotaExceededError } from './providers/drive-http';

/** The one failure kind a worker names on its error message. */
export type WorkerFailureKind = 'quota';

/** The providers' own storage-full wording (see {@link storageFullMessage}). */
const STORAGE_FULL_MESSAGE = /storage is full/;
/**
 * A Drive message naming its ONE storage-full reason (`context: status
 * statusText [storageQuotaExceeded]`) — not `quotaExceeded`, an API usage
 * quota that resets, and never on a 429, which is a rate limit.
 */
const DRIVE_QUOTA_MESSAGE = /(?::\s*(\d{3})\b[^[]*)?\[storageQuotaExceeded\]/;
/** What an older worker's message named a full OneDrive by. */
const GRAPH_QUOTA_MESSAGE = /\b507\b|insufficientStorage|quotaLimitReached/;
/** megajs names a full MEGA account `EOVERQUOTA (-17)` (see mega-provider). */
const MEGA_QUOTA_MESSAGE = /EOVERQUOTA|\(-17\)/;

function isDriveQuotaMessage(message: string): boolean {
  const match = DRIVE_QUOTA_MESSAGE.exec(message);
  return !!match && match[1] !== '429';
}

/** `'quota'` for a full account on any provider the worker uploads to. */
export function workerFailureKind(error: unknown): WorkerFailureKind | undefined {
  if (isQuotaExceededError(error)) return 'quota';
  if (error instanceof DriveHttpError) return error.kind === 'quota' ? 'quota' : undefined;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return STORAGE_FULL_MESSAGE.test(message) ||
    isDriveQuotaMessage(message) ||
    GRAPH_QUOTA_MESSAGE.test(message) ||
    MEGA_QUOTA_MESSAGE.test(message)
    ? 'quota'
    : undefined;
}

/** A worker's error message names a full account — by its kind, else by its text. */
export function isStorageFullFailure(failure: { kind?: string; error?: string }): boolean {
  if (failure.kind === 'quota') return true;
  return !!failure.error && workerFailureKind(new Error(failure.error)) === 'quota';
}

const STORAGE_FULL_NAMES: Record<string, string> = {
  'google-drive': 'Google Drive',
  onedrive: 'OneDrive',
  mega: 'MEGA',
  webdav: 'WebDAV',
  filesystem: 'Local Folder'
};

/** The providers' own `QUOTA_EXCEEDED` wording, for a failure that arrived as text. */
export function storageFullMessage(provider: string): string {
  return `${STORAGE_FULL_NAMES[provider] ?? 'Cloud'} storage is full — free up space or upgrade your plan`;
}
