/**
 * The per-user gates (`historySync`, `positionsSync`, `editLayerSync`) read
 * what the server last said it keeps per account — and a bunko can be
 * upgraded or rolled back under an open tab. Every writer of a per-user file
 * asks through here first, so its gate is never older than
 * `IDENTITY_MAX_AGE_MS`: the progress sync, the page-turn positions push and
 * the reader-open/foreground checks, the listing- and edit-triggered layer
 * sync, an edit layer's delete, and the backup's worker message.
 *
 * Cheap when fresh: the provider skips the request while its last answer
 * (any answer, a failure included) is younger than the max age, and
 * concurrent callers share the one request in flight (`refreshIdentity`).
 */
import type { ProviderStatus, SyncProvider } from './provider-interface';

/** How old the server's identity may be before a per-user write asks again. */
export const IDENTITY_MAX_AGE_MS = 5 * 60_000;

/** Refresh the identity if it is older than the max age. Never rejects. */
export async function refreshGates(provider: Pick<SyncProvider, 'refreshIdentity'>): Promise<void> {
  try {
    await provider.refreshIdentity?.({ maxAgeMs: IDENTITY_MAX_AGE_MS });
  } catch (error) {
    console.debug('[sync] identity refresh failed (keeping the last answer):', error);
  }
}

/** `refreshGates`, then the status the gates read. Never rejects. */
export async function freshGateStatus(
  provider: Pick<SyncProvider, 'getStatus' | 'refreshIdentity'>
): Promise<ProviderStatus> {
  await refreshGates(provider);
  return provider.getStatus();
}
