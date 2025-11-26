/**
 * PWA detection utilities
 * Detects if the app is running as an installed PWA vs in a browser tab
 */

import { readable } from 'svelte/store';

/**
 * Check if running as an installed PWA
 */
function checkPWAMode(): boolean {
  if (typeof window === 'undefined') return false;

  // iOS Safari standalone mode
  if ((navigator as any).standalone === true) return true;

  // Manifest display modes - this app uses "fullscreen"
  if (window.matchMedia('(display-mode: fullscreen)').matches) return true;
  if (window.matchMedia('(display-mode: standalone)').matches) return true;

  return false;
}

/**
 * Reactive store that reflects PWA mode status
 * Updates automatically if display mode changes (e.g., user installs PWA while app is open)
 */
export const isPWA = readable(false, (set) => {
  if (typeof window === 'undefined') return;

  set(checkPWAMode());

  // Listen for display mode changes
  const fullscreenQuery = window.matchMedia('(display-mode: fullscreen)');
  const standaloneQuery = window.matchMedia('(display-mode: standalone)');

  const handler = () => set(checkPWAMode());

  fullscreenQuery.addEventListener('change', handler);
  standaloneQuery.addEventListener('change', handler);

  return () => {
    fullscreenQuery.removeEventListener('change', handler);
    standaloneQuery.removeEventListener('change', handler);
  };
});
