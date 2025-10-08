import { browser } from '$app/environment';
import { writable } from 'svelte/store';
import { syncReadProgress } from './google-drive';
import { tokenManager } from './google-drive/token-manager';

type ActivityCallback = {
  onActive: () => void;
  onInactive: () => void;
};

class ActivityTracker {
  private timeoutId: number | null = null;
  private isActive = writable(false);
  private callbacks: ActivityCallback | null = null;
  private timeoutDuration = 5 * 60 * 1000; // 5 minutes in milliseconds
  private currentActiveState = false;

  constructor() {
    if (browser) {
      // Subscribe to activity state changes
      this.isActive.subscribe(active => {
        const wasActive = this.currentActiveState;

        if (active) {
          this.callbacks?.onActive();
        } else {
          this.callbacks?.onInactive();

          // Sync only when transitioning from active to inactive
          if (wasActive && !active && tokenManager.isAuthenticated()) {
            console.log('Auto-syncing due to inactivity...');
            syncReadProgress().catch(error => {
              console.error('Auto-sync failed:', error);
            });
          }
        }

        this.currentActiveState = active;
      });
    }
  }

  /**
   * Set the inactivity timeout duration
   */
  setTimeoutDuration(minutes: number) {
    // Sanity check: ensure minutes is a valid positive number, default to 5 if invalid
    const validMinutes = (typeof minutes === 'number' && minutes > 0 && !isNaN(minutes)) ? minutes : 5;
    this.timeoutDuration = validMinutes * 60 * 1000;
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
  }

  /**
   * Handle inactivity timeout
   */
  private handleInactivity() {
    console.log('User inactive for', this.timeoutDuration / 60000, 'minutes');

    // Set inactive state (will trigger timer stop and sync via callback)
    this.isActive.set(false);

    // Clear timeout
    this.timeoutId = null;
  }

  /**
   * Stop tracking and clear timeout
   */
  stop() {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.isActive.set(false);
  }

  /**
   * Get current active state
   */
  get active() {
    return this.isActive;
  }
}

export const activityTracker = new ActivityTracker();
