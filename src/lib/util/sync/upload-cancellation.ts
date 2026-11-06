/**
 * Cancelling a provider's uploads without importing the upload machinery.
 *
 * A provider's logout has to stop that account's uploads before it ends the
 * session, but the providers sit underneath the backup queue in the module
 * graph (the queue imports the cloud manager, which imports the providers).
 * So the queue registers its canceller here when it loads, and a provider
 * calls `cancelProviderUploads` without knowing who listens. When the queue
 * was never loaded, nothing of it is running and there is nothing to cancel.
 */
import type { ProviderType } from './provider-interface';

/** Cancels `provider`'s queued and in-flight uploads, and resolves once they are dropped. */
export type UploadCanceller = (provider: ProviderType, reason: string) => void | Promise<void>;

const cancellers = new Set<UploadCanceller>();

/** Register `canceller`; returns the function that unregisters it. */
export function registerUploadCanceller(canceller: UploadCanceller): () => void {
  cancellers.add(canceller);
  return () => {
    cancellers.delete(canceller);
  };
}

/**
 * Cancel every upload to `provider`. A canceller that throws is logged and
 * the others still run: a logout must not be stopped by its own cleanup.
 */
export async function cancelProviderUploads(
  provider: ProviderType,
  reason = 'Upload cancelled'
): Promise<void> {
  for (const canceller of [...cancellers]) {
    try {
      await canceller(provider, reason);
    } catch (error) {
      console.error(`[uploads] cancelling ${provider} uploads failed:`, error);
    }
  }
}
