/**
 * Paged-mode zoom session math — pure, no DOM.
 *
 * User zoom in paged mode is a multiplier over the mode's base scale, with a
 * per-page level ladder:
 *
 * - floor = min(1, fitScale / baseScale): the whole-page escape hatch — in
 *   zoomOriginal (and fitToWidth on tall pages) the user can still zoom down
 *   to fit-to-screen, never below it.
 * - top = max(3, 2 / baseScale): at least 2× native pixels stays reachable
 *   on small fit scales (portrait phones).
 *
 * keepZoom preserves the *effective* on-screen scale across base changes
 * (page turns, spreads, resize, KeyZ entry): level′ = level·oldBase/newBase,
 * clamped into the new ladder's range.
 */

import { baseTransform, type Size } from './paged-zoom-layout';
import type { PagedCamera } from './paged-camera';
import type { ContinuousZoomController } from './zoom-controller';

const EPS = 0.001;

/** Sorted, deduped level ladder for a page context. */
export function pagedLevels(baseScale: number, fitScale: number): number[] {
  const floor = baseScale > 0 ? Math.min(1, fitScale / baseScale) : 1;
  const top = baseScale > 0 ? Math.max(3, 2 / baseScale) : 3;
  const levels = [floor, 1, 1.5, 2, 3, top]
    .filter((l) => l >= floor - EPS && l <= top + EPS)
    .sort((a, b) => a - b);
  return levels.filter((l, i) => i === 0 || l - levels[i - 1] > EPS);
}

/**
 * Contextual double-tap target:
 * - zoomed above level 1 → reset to 1
 * - at/below 1 with an overflowing base (floor < 1) and not yet at the
 *   floor → drop to fit (today's double-tap-to-fit)
 * - otherwise → zoom in to 2×
 */
export function doubleTapTarget(currentLevel: number, floor: number): number {
  if (currentLevel > 1 + EPS) return 1;
  if (floor < 1 - EPS && currentLevel > floor + EPS) return floor;
  return 2;
}

/** keepZoom: the level in the new base that preserves the effective scale. */
export function convertLevelAcrossBases(
  level: number,
  oldBase: number,
  newBase: number,
  floor: number,
  top: number
): number {
  if (!(oldBase > 0) || !(newBase > 0)) return Math.max(floor, Math.min(top, 1));
  const converted = (level * oldBase) / newBase;
  return Math.max(floor, Math.min(top, converted));
}

// ============================================================
// Base-application orchestration
// ============================================================

export interface PagedZoomSessionState {
  baseScale: number;
  fitScale: number;
  initialized: boolean;
}

export function createSessionState(): PagedZoomSessionState {
  return { baseScale: 1, fitScale: 1, initialized: false };
}

/** keepZoom and its legacy persisted aliases (localStorage / synced profiles). */
function isKeepZoomMode(mode: string): boolean {
  return mode === 'keepZoom' || mode === 'keepZoomStart' || mode === 'keepZoomTopCorner';
}

/**
 * Apply a mode base for the given content/viewport: finish any in-flight
 * gesture, recompute the ladder, convert (keepZoom) or reset the user level,
 * and place the view. Instant — never animated. Shared verbatim by
 * PagedViewport and the e2e suite so the orchestration cannot silently
 * diverge from what's tested.
 */
export function applyPagedBase(
  deps: {
    camera: PagedCamera;
    controller: ContinuousZoomController;
    state: PagedZoomSessionState;
  },
  mode: string,
  content: Size,
  viewport: Size,
  rtl: boolean
): void {
  const { camera, controller, state } = deps;
  if (!(content.width > 0) || !(content.height > 0)) return;

  const oldBaseScale = state.baseScale;
  controller.finishNow();
  // Read the level after finishNow — mid-animation it would be a transient
  // value between levels; finishNow settles it at the gesture's target.
  const oldLevel = controller.currentZoom;

  const base = baseTransform(mode, content, viewport, rtl);
  state.fitScale = Math.min(viewport.width / content.width, viewport.height / content.height);
  state.baseScale = base.scale;

  const levels = pagedLevels(state.baseScale, state.fitScale);
  const level =
    isKeepZoomMode(mode) && state.initialized
      ? convertLevelAcrossBases(
          oldLevel,
          oldBaseScale,
          state.baseScale,
          levels[0],
          levels[levels.length - 1]
        )
      : 1;

  camera.applyBase(content, base);
  controller.snapToLevel(level);
  camera.place();
  state.initialized = true;
}
