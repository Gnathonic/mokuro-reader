/**
 * A full account, across the worker boundary. Worker-safe: no svelte, no DOM.
 *
 * The upload worker posts only `error: message` for a failure; the typed
 * errors (`DriveHttpError`, `GraphQuotaError`) do not survive. It therefore
 * also posts `kind: 'quota'` for a full account, and the backup queue turns
 * that into the same "storage is full" wording the main-thread providers
 * raise as `QUOTA_EXCEEDED` — falling back to the message for an error the
 * pool synthesized or an older worker bundle posted.
 */

import { isDriveQuotaError } from './providers/drive-http';
import { GRAPH_QUOTA_MESSAGE, GraphQuotaError } from '../providers/onedrive/graph-errors';

/** The one failure kind a worker names on its error message. */
export type WorkerFailureKind = 'quota';

/** megajs names a full MEGA account `EOVERQUOTA (-17)` (see mega-provider). */
const MEGA_QUOTA_MESSAGE = /EOVERQUOTA|\(-17\)/;

/** `'quota'` for a full account on any provider the worker uploads to. */
export function workerFailureKind(error: unknown): WorkerFailureKind | undefined {
  if (error instanceof GraphQuotaError || isDriveQuotaError(error)) return 'quota';
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return GRAPH_QUOTA_MESSAGE.test(message) || MEGA_QUOTA_MESSAGE.test(message)
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
