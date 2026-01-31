import { writable } from 'svelte/store';
import { browser } from '$app/environment';

/** Whether a service worker update is available and waiting */
export const swUpdateAvailable = writable(false);

/** Reference to the waiting service worker for triggering update */
let waitingWorker: ServiceWorker | null = null;

/** Flag to track if we explicitly requested the update */
let updateRequested = false;

/**
 * Initialize service worker update detection.
 * Call this once on app startup.
 */
export function initSwUpdateDetection() {
  if (!browser || !('serviceWorker' in navigator)) {
    return;
  }

  navigator.serviceWorker.ready.then((registration) => {
    // Check if there's already a waiting worker
    if (registration.waiting) {
      waitingWorker = registration.waiting;
      swUpdateAvailable.set(true);
    }

    // Listen for new service workers
    registration.addEventListener('updatefound', () => {
      const newWorker = registration.installing;
      if (!newWorker) return;

      newWorker.addEventListener('statechange', () => {
        // When the new worker is installed and waiting
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          waitingWorker = newWorker;
          swUpdateAvailable.set(true);
        }
      });
    });
  });

  // Listen for controller change (when new SW takes over)
  // Only reload if we explicitly requested the update via applySwUpdate()
  // This prevents unexpected reloads on mobile when SW updates in background
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (updateRequested) {
      window.location.reload();
    }
  });
}

/**
 * Apply the pending update by telling the waiting SW to skip waiting.
 * This will trigger a page reload via the controllerchange listener.
 */
export function applySwUpdate() {
  if (waitingWorker) {
    updateRequested = true;
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  }
}

/**
 * Dismiss the update notification without applying it.
 * The update will still be applied on next full page load.
 */
export function dismissSwUpdate() {
  swUpdateAvailable.set(false);
}
