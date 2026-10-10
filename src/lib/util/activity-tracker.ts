import { browser } from '$app/environment';
import { writable } from 'svelte/store';
import { unifiedCloudManager } from './sync/unified-cloud-manager';

type ActivityCallback = {
  onActive: () => void;
  onInactive: () => void;
};

export class ActivityTracker {
  private timeoutId: number | null = null;
  private isActive = writable(false);
  private callbacks: ActivityCallback | null = null;
  private timeoutDuration = 5 * 60 * 1000; // 5 minutes in milliseconds
  private currentActiveState = false;

  // Separate sync timer (decoupled from activity timer)
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

  constructor() {
    if (browser) {
      // Subscribe to activity state changes
      this.isActive.subscribe((active) => {
        if (active) {
          this.callbacks?.onActive();
        } else {
          this.callbacks?.onInactive();
        }

        this.currentActiveState = active;
      });
    }
  }

  /**
   * Set the inactivity timeout duration
   */
  setTimeoutDuration(minutes: number) {
    this.timeoutDuration = minutes * 60 * 1000;
    // Restart the timer with new duration if currently active
    if (this.timeoutId !== null) {
      this.recordActivity();
    }
  }

  /**
   * Initialize the activity tracker with callbacks
   */
  initialize(callbacks: ActivityCallback) {
    this.callbacks = callbacks;
  }

  /**
   * Record user activity (page turn)
   */
  recordActivity() {
    // Clear existing timeout
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
    }

    // Set active state only if currently inactive to avoid triggering callbacks repeatedly
    if (!this.currentActiveState) {
      this.isActive.set(true);
    }

    // Set new timeout
    this.timeoutId = window.setTimeout(() => {
      this.handleInactivity();
    }, this.timeoutDuration);

    // Reset sync timer (independent of activity timer)
    this.resetSyncTimer();
    this.hasPendingProgress = true;
  }

  /**
   * Handle inactivity timeout
   */
  private handleInactivity() {
    console.log('User inactive for', this.timeoutDuration / 60000, 'minutes');

    // Set inactive state (will trigger timer stop via callback)
    this.isActive.set(false);

    // Clear timeout
    this.timeoutId = null;
  }

  /**
   * Reset the sync timer (independent 5-second timer for progress sync)
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
   * pending, nothing sent.
   */
  flush() {
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
   * Stop tracking and clear activity timeout
   * NOTE: Does NOT clear sync timer - sync will still fire if pending
   */
  stop() {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.isActive.set(false);
    // Sync timer continues running!
  }

  /**
   * Completely destroy the tracker and cancel all timers
   * Use this for testing or complete cleanup
   */
  destroy() {
    this.stop();
    if (this.syncTimerId !== null) {
      clearTimeout(this.syncTimerId);
      this.syncTimerId = null;
    }
    this.hasPendingProgress = false;
  }

  /**
   * Get current active state
   */
  get active() {
    return this.isActive;
  }
}

export const activityTracker = new ActivityTracker();
