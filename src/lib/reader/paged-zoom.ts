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
   * Zoom in (1) or out (-1) one step of the notched-wheel ladder, anchored at
   * the screen centre — what one wheel notch does, without a pointer (#55).
   */
  zoomStep(direction: 1 | -1): void;
}

/** Set while a paged reader is mounted; undefined in continuous mode. */
export const pagedZoom = writable<PagedZoomApi | undefined>(undefined);
