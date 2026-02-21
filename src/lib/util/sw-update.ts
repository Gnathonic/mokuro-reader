import { writable } from 'svelte/store';
import { browser, dev } from '$app/environment';

/** Whether a service worker update is available and waiting */
export const swUpdateAvailable = writable(false);

/** Reference to the waiting service worker for triggering update */
let waitingWorker: ServiceWorker | null = null;

/** Flag to track if we explicitly requested the update */
let updateRequested = false;
/** Guard against duplicate listener registration */
let initialized = false;
/** Fallback timer in case controllerchange doesn't fire after SKIP_WAITING */
let updateFallbackTimer: ReturnType<typeof setTimeout> | null = null;

const SW_UPDATE_DISMISSED_UNTIL_KEY = 'sw-update-dismissed-until';
const SW_UPDATE_DISMISS_MS = 24 * 60 * 60 * 1000; // 24 hours

function isDismissed(): boolean {
  if (!browser) return false;
  const raw = localStorage.getItem(SW_UPDATE_DISMISSED_UNTIL_KEY);
  if (!raw) return false;
  const dismissedUntil = Number(raw);
  return Number.isFinite(dismissedUntil) && dismissedUntil > Date.now();
}

function clearDismissal(): void {
  if (!browser) return;
  localStorage.removeItem(SW_UPDATE_DISMISSED_UNTIL_KEY);
}

function showUpdateBanner(): void {
  if (!isDismissed()) {
    swUpdateAvailable.set(true);
  }
}

/**
 * Initialize service worker update detection.
 * Call this once on app startup.
 */
export function initSwUpdateDetection() {
  // Update banner is noisy during local development where builds churn frequently.
  if (!browser || dev || !('serviceWorker' in navigator)) {
    return;
  }
  if (initialized) return;
  initialized = true;

  navigator.serviceWorker.ready.then((registration) => {
    // Check if there's already a waiting worker
    if (registration.waiting && navigator.serviceWorker.controller) {
      waitingWorker = registration.waiting;
      showUpdateBanner();
    }

    // Listen for new service workers
    registration.addEventListener('updatefound', () => {
      const newWorker = registration.installing;
      if (!newWorker) return;

      newWorker.addEventListener('statechange', () => {
        // When the new worker is installed and waiting
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          waitingWorker = newWorker;
          showUpdateBanner();
        }
      });
    });
  });

  // Listen for controller change (when new SW takes over)
  // Only reload if we explicitly requested the update via applySwUpdate()
  // This prevents unexpected reloads on mobile when SW updates in background
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // New SW took control: clear stale waiting state and dismissal cooldown.
    if (updateFallbackTimer) {
      clearTimeout(updateFallbackTimer);
      updateFallbackTimer = null;
    }
    waitingWorker = null;
    clearDismissal();
    swUpdateAvailable.set(false);
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
    clearDismissal();
    swUpdateAvailable.set(false);
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
    // Some browsers occasionally miss controllerchange; force reload as fallback.
    if (updateFallbackTimer) {
      clearTimeout(updateFallbackTimer);
    }
    updateFallbackTimer = setTimeout(() => {
      window.location.reload();
    }, 4000);
  }
}

/**
 * Dismiss the update notification without applying it.
 * The update will still be applied on next full page load.
 */
export function dismissSwUpdate() {
  swUpdateAvailable.set(false);
  if (browser) {
    localStorage.setItem(
      SW_UPDATE_DISMISSED_UNTIL_KEY,
      String(Date.now() + SW_UPDATE_DISMISS_MS)
    );
  }
}
