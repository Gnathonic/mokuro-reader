/**
 * Current-page detection for the continuous scroll readers — pure rect math.
 *
 * Everything operates on getBoundingClientRect-style visual rects, which
 * reflect the zoom transform. The bug class this guards against (issue #195
 * "aberrant paging"): comparing unscaled layout offsets (offsetTop) against
 * scaled scroll coordinates made detection drift by the zoom factor — at 2×
 * on page 10 it reported ~page 20, corrupting read stats and keyboard nav.
 */

import type { RectLike } from './zoom-math';

/**
 * Index of the page whose visual center is closest to the container's center
 * along the given axis. Returns 0 when no rects are usable.
 */
export function closestPageToCenter(
  containerRect: RectLike,
  pageRects: readonly (RectLike | undefined)[],
  axis: 'x' | 'y'
): number {
  const center =
    axis === 'y'
      ? containerRect.top + containerRect.height / 2
      : containerRect.left + containerRect.width / 2;
  let closest = 0;
  let closestDist = Infinity;
  for (let i = 0; i < pageRects.length; i++) {
    const rect = pageRects[i];
    if (!rect) continue;
    const rectCenter = axis === 'y' ? rect.top + rect.height / 2 : rect.left + rect.width / 2;
    const dist = Math.abs(rectCenter - center);
    if (dist < closestDist) {
      closestDist = dist;
      closest = i;
    }
  }
  return closest;
}

/** Horizontally visible fraction (0–1) of a rect within the container. */
export function horizontalVisibilityRatio(rect: RectLike, containerRect: RectLike): number {
  if (rect.width <= 0) return 0;
  const visibleLeft = Math.max(rect.left, containerRect.left);
  const visibleRight = Math.min(rect.left + rect.width, containerRect.left + containerRect.width);
  return Math.max(0, visibleRight - visibleLeft) / rect.width;
}

/**
 * Horizontal-reader detection: among pages >95% visible, the one whose center
 * is closest to the viewport center; otherwise any page whose center lies in
 * the viewport, closest first; otherwise the fallback.
 */
export function detectHorizontalPage(
  containerRect: RectLike,
  pageRects: readonly (RectLike | undefined)[],
  fallback: number
): number {
  const viewportCenter = containerRect.left + containerRect.width / 2;

  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < pageRects.length; i++) {
    const rect = pageRects[i];
    if (!rect) continue;
    if (horizontalVisibilityRatio(rect, containerRect) > 0.95) {
      const centerX = rect.left + rect.width / 2;
      const dist = Math.abs(centerX - viewportCenter);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
  }
  if (bestIdx >= 0) return bestIdx;

  for (let i = 0; i < pageRects.length; i++) {
    const rect = pageRects[i];
    if (!rect) continue;
    const centerX = rect.left + rect.width / 2;
    if (centerX >= containerRect.left && centerX <= containerRect.left + containerRect.width) {
      const dist = Math.abs(centerX - viewportCenter);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
  }

  return bestIdx >= 0 ? bestIdx : fallback;
}

/**
 * 1-based inclusive range of pages with ANY part inside the container along
 * `axis` — reading history counts whole pages, so a sliver counts. Null when
 * no page is on screen.
 */
export function visiblePageRange(
  containerRect: RectLike,
  rects: (RectLike | undefined)[],
  axis: 'x' | 'y'
): [number, number] | null {
  const cStart = axis === 'x' ? containerRect.left : containerRect.top;
  const cEnd = cStart + (axis === 'x' ? containerRect.width : containerRect.height);
  let first = -1;
  let last = -1;
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i];
    if (!rect) continue;
    const start = axis === 'x' ? rect.left : rect.top;
    const size = axis === 'x' ? rect.width : rect.height;
    if (size <= 0) continue;
    if (Math.min(start + size, cEnd) - Math.max(start, cStart) > 0) {
      if (first < 0) first = i;
      last = i;
    }
  }
  return first < 0 ? null : [first + 1, last + 1];
}
