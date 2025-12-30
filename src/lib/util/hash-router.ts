/**
 * Hash-based router for SPA navigation
 * Provides unified navigation that works offline without PWA detection
 */

import { writable, derived, get } from 'svelte/store';

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
 * Current view state
 */
export const currentView = writable<View>({ type: 'catalog' });

/**
 * Parse a hash URL into a View object
 * Falls back to catalog if URL cannot be parsed (e.g., malformed percent-encoding)
 */
export function parseHash(hash: string): View {
  try {
    const path = hash.replace(/^#\/?/, '');
    const segments = path.split('/').filter(Boolean);

    if (segments.length === 0 || segments[0] === 'catalog') {
      return { type: 'catalog' };
    }
    if (segments[0] === 'cloud') return { type: 'cloud' };
    if (segments[0] === 'upload') return { type: 'upload' };
    if (segments[0] === 'reading-speed') return { type: 'reading-speed' };

    if (segments[0] === 'series' && segments.length >= 2) {
      const seriesId = decodeURIComponent(segments[1]);
      if (segments[2] === 'text') return { type: 'series-text', seriesId };
      return { type: 'series', seriesId };
    }

    if (segments[0] === 'reader' && segments.length >= 3) {
      const seriesId = decodeURIComponent(segments[1]);
      const volumeId = decodeURIComponent(segments[2]);
      if (segments[3] === 'text') return { type: 'volume-text', seriesId, volumeId };
      return { type: 'reader', seriesId, volumeId };
    }

    return { type: 'catalog' };
  } catch {
    // decodeURIComponent can throw URIError on malformed percent-encoding
    // Fall back to catalog page if URL cannot be parsed
    console.warn('Failed to parse URL hash, redirecting to catalog:', hash);
    return { type: 'catalog' };
  }
}

/**
 * Convert a View object to a hash URL
 */
export function viewToHash(view: View): string {
  switch (view.type) {
    case 'catalog':
      return '#/catalog';
    case 'series':
      return `#/series/${encodeURIComponent(view.seriesId)}`;
    case 'reader':
      return `#/reader/${encodeURIComponent(view.seriesId)}/${encodeURIComponent(view.volumeId)}`;
    case 'volume-text':
      return `#/reader/${encodeURIComponent(view.seriesId)}/${encodeURIComponent(view.volumeId)}/text`;
    case 'series-text':
      return `#/series/${encodeURIComponent(view.seriesId)}/text`;
    case 'cloud':
      return '#/cloud';
    case 'upload':
      return '#/upload';
    case 'reading-speed':
      return '#/reading-speed';
  }
}

/**
 * Navigation options
 */
interface NavigateOptions {
  replaceState?: boolean;
}

/**
 * Navigate to a view - updates hash and view state
 * Always navigates to root path (/) to ensure hash routing works correctly
 */
export function navigate(view: View, options?: NavigateOptions): void {
  const hash = viewToHash(view);
  // Always use root path to avoid issues when navigating from legacy paths like /upload
  const url = '/' + hash;
  if (options?.replaceState) {
    window.history.replaceState(null, '', url);
  } else {
    window.history.pushState(null, '', url);
  }
  currentView.set(view);
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

/**
 * Derived store that provides route params from view state
 * Components should use this for accessing manga/volume params
 */
export const routeParams = derived(currentView, ($currentView) => {
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
});

/**
 * Check if currently on reader view
 */
export const isOnReader = derived(currentView, ($currentView) => $currentView.type === 'reader');

/**
 * Initialize the router - sets up hashchange listener
 * Call this on app initialization, returns cleanup function
 */
export function initRouter(): () => void {
  // Handle legacy pathname-based routes from before hash router migration
  const pathname = window.location.pathname;

  // Handle /upload path: redirect to hash-based #/upload while preserving query params
  // This supports cross-site imports like /upload?manga=X&volume=Y
  if (pathname.startsWith('/upload')) {
    const newUrl = '/' + window.location.search + '#/upload';
    window.history.replaceState(null, '', newUrl);
  } else if (pathname && pathname !== '/') {
    // Redirect all other legacy routes to catalog
    window.history.replaceState(null, '', '/#/catalog');
  }

  // Parse initial hash
  const initialView = parseHash(window.location.hash);
  currentView.set(initialView);

  // Ensure hash exists (default to catalog)
  if (!window.location.hash || window.location.hash === '#' || window.location.hash === '#/') {
    window.history.replaceState(null, '', '#/catalog');
  }

  // Listen for hash changes (back/forward buttons)
  function handleHashChange() {
    currentView.set(parseHash(window.location.hash));
  }

  window.addEventListener('hashchange', handleHashChange);
  return () => window.removeEventListener('hashchange', handleHashChange);
}
