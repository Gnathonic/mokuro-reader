/**
 * Microsoft Graph failure classification shared by the main-thread client and
 * the upload worker core — so no svelte imports here.
 *
 * A full drive answers 507 (insufficientStorage), or names quotaLimitReached
 * in the body. Neither clears by waiting, so neither is retried like a 5xx.
 */

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

/** The worker message for a full drive; the provider matches it by pattern. */
export function graphQuotaMessage(status: number, code?: string): string {
  return `OneDrive storage full (${status} ${code ?? 'insufficientStorage'})`;
}

/** What a serialized worker message names a full drive by. */
export const GRAPH_QUOTA_MESSAGE = /\b507\b|insufficientStorage|quotaLimitReached/;

export class GraphQuotaError extends Error {
  constructor(status: number, code?: string) {
    super(graphQuotaMessage(status, code));
    this.name = 'GraphQuotaError';
  }
}
