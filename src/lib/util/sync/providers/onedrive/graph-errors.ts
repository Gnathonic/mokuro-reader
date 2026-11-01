/**
 * Microsoft Graph failure classification shared by the main-thread client and
 * the upload worker core — so no svelte imports here.
 *
 * A full drive answers 507 (insufficientStorage), or names quotaLimitReached
 * in the body. Neither clears by waiting, so neither is retried like a 5xx.
 */
import { ProviderError } from '../../provider-interface';

const QUOTA_CODES = new Set(['insufficientStorage', 'quotaLimitReached']);

/** `error.code` of a Graph error body, else the first nested innerError code. */
export function graphErrorCode(body: unknown): string | undefined {
  let parsed = body;
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body);
    } catch {
      return undefined;
    }
  }
  const error = (parsed as { error?: Record<string, unknown> } | null)?.error;
  if (!error || typeof error !== 'object') return undefined;
  if (typeof error.code === 'string' && QUOTA_CODES.has(error.code)) return error.code;
  for (let inner = error.innerError ?? error.innererror; inner && typeof inner === 'object'; ) {
    const node = inner as Record<string, unknown>;
    if (typeof node.code === 'string' && QUOTA_CODES.has(node.code)) return node.code;
    inner = node.innerError ?? node.innererror;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}

export function isGraphQuotaFailure(status: number, code?: string): boolean {
  return status === 507 || (code !== undefined && QUOTA_CODES.has(code));
}

/** 408, 429 and 5xx — except 507, which waiting never fixes. */
export function isGraphRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status !== 507);
}

/**
 * The storage-full error, thrown where the refusal is read (the upload core,
 * main thread or worker) so the upload-failed notice shows it as is (the
 * code and wording MEGA uses).
 */
export function oneDriveStorageFullError(): ProviderError {
  return new ProviderError(
    'OneDrive storage is full — free up space or upgrade your plan',
    'onedrive',
    'QUOTA_EXCEEDED'
  );
}
