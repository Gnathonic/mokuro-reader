import { unifiedCloudManager } from './sync/unified-cloud-manager';
import { takeVolumeDataDeferred } from './sync/reading-session';

/**
 * Batches progress syncs while reading: a page turn (`recordActivity`) marks
 * progress pending and arms a short timer, bounded by a minimum interval
 * between syncs. The inactivity timer that once stopped the reading timer
 * from here is gone — reading time is counted from history events
 * (`reading-history/stats-engine.ts`), with its own idle cutoff.
 */
export class ActivityTracker {
  private syncTimerId: number | null = null;
  private readonly SYNC_DELAY_MS = 5000; // 5 seconds
  /**
   * At most one progress sync per this interval while reading. Each sync
   * downloads, merges and may re-upload the whole progress file; once per page
   * pause it was a mobile data and battery drain. Leaving the reader or hiding
   * the tab flushes a pending change at once (`flush`).
   */
  private readonly SYNC_MIN_INTERVAL_MS = 3 * 60 * 1000;
  private lastSyncAt = -Infinity;
  private hasPendingProgress = false;

  /**
   * Record user activity (page turn): progress changed, sync it soon.
   */
  recordActivity() {
    this.resetSyncTimer();
    this.hasPendingProgress = true;
  }

  /**
   * Reset the sync timer (5 seconds after the last activity, within the interval)
   */
  private resetSyncTimer() {
    if (this.syncTimerId !== null) {
      clearTimeout(this.syncTimerId);
    }

    // 5 s after the last activity, but never sooner than the interval allows.
    const delay = Math.min(
      this.SYNC_MIN_INTERVAL_MS,
      Math.max(this.SYNC_DELAY_MS, this.lastSyncAt + this.SYNC_MIN_INTERVAL_MS - Date.now())
    );
    this.syncTimerId = window.setTimeout(() => {
      this.handleSyncTimeout();
    }, delay);
  }

  /**
   * Send a pending change now — leaving the reader, hiding the tab. Nothing
   * pending, nothing sent. A volume-data upload that a sync deferred while
   * the user was reading (`sync/reading-session.ts`) counts as pending: this
   * flush ends the session, and its sync is the one that uploads. The flush
   * spends that debt — a sync that cannot upload (offline, read-only) is not
   * re-run by every later hide; only a new deferral owes one again.
   */
  flush() {
    if (takeVolumeDataDeferred()) this.hasPendingProgress = true;
    if (!this.hasPendingProgress) return;
    if (this.syncTimerId !== null) {
      clearTimeout(this.syncTimerId);
      this.syncTimerId = null;
    }
    this.handleSyncTimeout();
  }

  /**
   * Handle sync timeout - triggers progress sync after 5 seconds of inactivity
   */
  private handleSyncTimeout() {
    if (!this.hasPendingProgress) return;

    const hasActiveProvider = unifiedCloudManager.getActiveProvider() !== null;
    if (hasActiveProvider) {
      // Only a real sync starts the interval: activity before a provider is
      // connected must not hold back the first sync after it is.
      this.lastSyncAt = Date.now();
      console.log('Auto-syncing after 5s inactivity...');
      unifiedCloudManager.syncProgress({ silent: true }).catch((error) => {
        console.error('Auto-sync failed:', error);
      });
    }

    this.hasPendingProgress = false;
    this.syncTimerId = null;
  }

  /**
   * Cancel the sync timer and drop the pending change (tests, full cleanup).
   */
  destroy() {
    if (this.syncTimerId !== null) {
      clearTimeout(this.syncTimerId);
      this.syncTimerId = null;
    }
    this.hasPendingProgress = false;
  }
}

export const activityTracker = new ActivityTracker();
