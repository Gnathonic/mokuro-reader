/**
 * Navigation state management
 * Provides URL-optional navigation that works in both browser and PWA modes
 */

import { writable, derived, get } from 'svelte/store';
import { goto } from '$app/navigation';
import { page } from '$app/stores';
import { isPWA } from './pwa';

/**
 * View types for in-app navigation
 */
export type View =
  | { type: 'catalog' }
  | { type: 'series'; seriesId: string }
  | { type: 'reader'; seriesId: string; volumeId: string }
  | { type: 'volume-text'; seriesId: string; volumeId: string }
  | { type: 'series-text'; seriesId: string }
  | { type: 'cloud' }
  | { type: 'upload' }
  | { type: 'reading-speed' };

/**
 * Current view state - used for PWA mode navigation
 */
export const currentView = writable<View>({ type: 'catalog' });

/**
 * Navigation options
 */
interface NavigateOptions {
  replaceState?: boolean;
  invalidateAll?: boolean;
}

/**
 * Convert a view to its URL path
 */
function viewToUrl(view: View): string {
  switch (view.type) {
    case 'catalog':
      return '/';
    case 'series':
      return `/${view.seriesId}`;
    case 'reader':
      return `/${view.seriesId}/${view.volumeId}`;
    case 'volume-text':
      return `/${view.seriesId}/${view.volumeId}/text`;
    case 'series-text':
      return `/${view.seriesId}/text`;
    case 'cloud':
      return '/cloud';
    case 'upload':
      return '/upload';
    case 'reading-speed':
      return '/reading-speed';
  }
}

/**
 * Navigate to a view
 * In PWA mode: only updates the view store (URL stays at /)
 * In browser mode: updates both view store and URL
 */
export async function navigate(view: View, options?: NavigateOptions): Promise<void> {
  currentView.set(view);

  // In PWA mode, don't update URL - keeps refresh landing on catalog
  if (get(isPWA)) {
    return;
  }

  // In browser mode, also update URL for bookmarking/sharing
  const url = viewToUrl(view);
  await goto(url, options);
}

/**
 * Helper functions for common navigation patterns
 */
export const nav = {
  /** Navigate to catalog (home) */
  toCatalog: (options?: NavigateOptions) => navigate({ type: 'catalog' }, options),

  /** Navigate to a series page */
  toSeries: (seriesId: string, options?: NavigateOptions) =>
    navigate({ type: 'series', seriesId }, options),

  /** Navigate to the reader */
  toReader: (seriesId: string, volumeId: string, options?: NavigateOptions) =>
    navigate({ type: 'reader', seriesId, volumeId }, options),

  /** Navigate to volume text view */
  toVolumeText: (seriesId: string, volumeId: string, options?: NavigateOptions) =>
    navigate({ type: 'volume-text', seriesId, volumeId }, options),

  /** Navigate to series text view */
  toSeriesText: (seriesId: string, options?: NavigateOptions) =>
    navigate({ type: 'series-text', seriesId }, options),

  /** Navigate to cloud page */
  toCloud: (options?: NavigateOptions) => navigate({ type: 'cloud' }, options),

  /** Navigate to upload page */
  toUpload: (options?: NavigateOptions) => navigate({ type: 'upload' }, options),

  /** Navigate to reading speed page */
  toReadingSpeed: (options?: NavigateOptions) => navigate({ type: 'reading-speed' }, options)
};

/**
 * Convert URL params and pathname to a View object
 */
export function urlToView(params: { manga?: string; volume?: string }, pathname: string): View {
  if (pathname === '/cloud') {
    return { type: 'cloud' };
  } else if (pathname === '/upload') {
    return { type: 'upload' };
  } else if (pathname === '/reading-speed') {
    return { type: 'reading-speed' };
  } else if (params.volume && pathname.endsWith('/text')) {
    return { type: 'volume-text', seriesId: params.manga!, volumeId: params.volume };
  } else if (params.manga && pathname.endsWith('/text')) {
    return { type: 'series-text', seriesId: params.manga };
  } else if (params.volume) {
    return { type: 'reader', seriesId: params.manga!, volumeId: params.volume };
  } else if (params.manga) {
    return { type: 'series', seriesId: params.manga };
  } else {
    return { type: 'catalog' };
  }
}

/**
 * Initialize view state from current URL (for browser mode page loads)
 * Call this on app initialization to sync URL -> view state
 */
export function initViewFromUrl(
  params: { manga?: string; volume?: string },
  pathname: string
): void {
  // Don't override if already in PWA mode
  if (get(isPWA)) return;

  currentView.set(urlToView(params, pathname));
}

/**
 * Derived store that provides route params from either URL (browser mode) or view state (PWA mode)
 * Components should use this instead of $page.params to support PWA navigation
 */
export const routeParams = derived([isPWA, currentView, page], ([$isPWA, $currentView, $page]) => {
  if ($isPWA) {
    // In PWA mode, derive params from currentView
    switch ($currentView.type) {
      case 'series':
        return { manga: $currentView.seriesId };
      case 'reader':
        return { manga: $currentView.seriesId, volume: $currentView.volumeId };
      case 'volume-text':
        return { manga: $currentView.seriesId, volume: $currentView.volumeId };
      case 'series-text':
        return { manga: $currentView.seriesId };
      default:
        return {};
    }
  }
  // In browser mode, use URL params
  return $page.params;
});

/**
 * Check if currently on a specific view type
 */
export const isOnReader = derived([isPWA, currentView, page], ([$isPWA, $currentView, $page]) => {
  if ($isPWA) {
    return $currentView.type === 'reader';
  }
  return $page.route.id === '/[manga]/[volume]';
});

/**
 * Navigate "back" or "up" in the view hierarchy
 * Used for Escape key and back button behavior
 *
 * Hierarchy:
 * - reader -> series
 * - volume-text -> reader
 * - series-text -> series
 * - series -> catalog
 * - cloud -> catalog
 * - reading-speed -> catalog
 * - upload -> catalog
 * - catalog -> (no-op)
 */
export function navigateBack(): void {
  const view = get(currentView);

  switch (view.type) {
    case 'reader':
      nav.toSeries(view.seriesId);
      break;
    case 'volume-text':
      nav.toReader(view.seriesId, view.volumeId);
      break;
    case 'series-text':
      nav.toSeries(view.seriesId);
      break;
    case 'series':
      nav.toCatalog();
      break;
    case 'cloud':
    case 'reading-speed':
    case 'upload':
      nav.toCatalog();
      break;
    case 'catalog':
      // Already at root, do nothing
      break;
  }
}
