/**
 * The paged-mode zoom API surface, registered by PagedViewport while mounted.
 *
 * Replaces the old module-level panzoom singleton (panzoomStore & friends).
 * Kept dependency-free (svelte/store + types only) so settings-layer modules
 * never need to import reader internals — consumers subscribe and call.
 */

import { writable } from 'svelte/store';

export interface PagedZoomApi {
  /** Arrow-key style smooth vertical pan (75% of the viewport). */
  scrollImage(direction: 'up' | 'down'): void;
  /** QuickActions: show the whole page (fit-to-screen view, level 1). */
  zoomFitToScreen(): void;
  /**
   * Page Down / Space / Page Up on content taller than the screen (#283):
   * scroll it a screenful toward `direction` if it continues past the
   * viewport that way. True when it scrolled — the caller must then NOT turn
   * the page; false means "turn as usual".
   */
  pageKeyScroll(direction: 'forward' | 'backward'): boolean;
  /**
   * Open the page `pageKey` at its BOTTOM edge if it is the next one shown
   * (one-shot; a backward page-key turn, so reading backwards is continuous).
   */
  landAtEndOf(pageKey: number | string): void;
}

/** Set while a paged reader is mounted; undefined in continuous mode. */
export const pagedZoom = writable<PagedZoomApi | undefined>(undefined);
