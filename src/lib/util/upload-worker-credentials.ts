import type { SyncProvider } from './sync/provider-interface';

/**
 * The credential/target plumbing every WORKER-driven upload shares, extracted
 * from `backup-queue.ts` so the sidecar backfill's worker feed reuses the same
 * code — and, critically, the same per-`provider:series` lock map. Two queues
 * preparing the same series folder concurrently is exactly the race the lock
 * exists for (on MEGA a mkdir race creates a DUPLICATE series folder — see
 * `mega-core.ts`'s "Never mkdir here" comment), so splitting the map per
 * caller would reopen it.
 */

// Series upload target initialization lock (provider-agnostic)
// Prevents multiple concurrent workers from racing to prepare the same provider+series target
// Maps "provider:seriesTitle" -> Promise that resolves when target is guaranteed to exist
const seriesFolderLocks = new Map<string, Promise<Record<string, any> | void>>();

export async function prepareSeriesUploadTarget(
  provider: SyncProvider,
  seriesTitle: string
): Promise<Record<string, any> | void> {
  if (!provider.prepareUploadTarget) return;

  const lockKey = `${provider.type}:${seriesTitle}`;
  const existingLock = seriesFolderLocks.get(lockKey);
  if (existingLock) {
    return await existingLock;
  }

  const lockPromise = (async () => {
    try {
      return await provider.prepareUploadTarget!(seriesTitle);
    } catch (error) {
      // On error, remove lock so it can be retried
      seriesFolderLocks.delete(lockKey);
      throw error;
    }
  })();

  seriesFolderLocks.set(lockKey, lockPromise);
  return await lockPromise;
}

export async function getUploadWorkerCredentials(
  provider: SyncProvider,
  seriesTitle: string
): Promise<Record<string, any>> {
  const baseCredentials = provider.getWorkerUploadCredentials
    ? await provider.getWorkerUploadCredentials()
    : {};

  const targetData = await prepareSeriesUploadTarget(provider, seriesTitle);
  return { ...baseCredentials, ...(targetData || {}) };
}
