/**
 * Pure zoom math — no DOM, fully testable.
 *
 * Coordinate system:
 * - Content space: native pixel coordinates within the unscaled content
 * - Screen space: pixel coordinates on the viewport (0,0 = top-left of viewport)
 * - Scroll space: scrollLeft/scrollTop of the scroll container
 *
 * The zoom wrapper uses transform: scale(zoom) with transform-origin: top left.
 * The wrapper is offset in the scroll flow by spacers (e.g., 50vh centering spacer).
 */

export interface ZoomState {
  /** Current content-space X of the anchor point */
  contentX: number;
  /** Current content-space Y of the anchor point */
  contentY: number;
  /** Screen position where the anchor should appear */
  screenX: number;
  /** Screen position where the anchor should appear */
  screenY: number;
}

/**
 * Compute content-space coordinates from a screen position.
 *
 * @param screenX Screen X position (e.g., click position)
 * @param screenY Screen Y position
 * @param wrapperVisualLeft Wrapper's getBoundingClientRect().left
 * @param wrapperVisualTop Wrapper's getBoundingClientRect().top
 * @param currentZoom Current zoom level
 */
export function screenToContent(
  screenX: number,
  screenY: number,
  wrapperVisualLeft: number,
  wrapperVisualTop: number,
  currentZoom: number
): { contentX: number; contentY: number } {
  return {
    contentX: (screenX - wrapperVisualLeft) / currentZoom,
    contentY: (screenY - wrapperVisualTop) / currentZoom
  };
}

/**
 * Compute the scroll position that places a content point at a screen position.
 *
 * With transform-origin: top left, a content point at (cx, cy) appears at
 * visual position (wrapperOffset + cx * zoom, wrapperOffset + cy * zoom)
 * relative to the scroll container's content origin.
 *
 * To place it at screen position (sx, sy):
 *   scrollLeft = wrapperOffsetX + cx * zoom - sx
 *   scrollTop = wrapperOffsetY + cy * zoom - sy
 *
 * @param contentX Content-space X
 * @param contentY Content-space Y
 * @param targetScreenX Desired screen X position
 * @param targetScreenY Desired screen Y position
 * @param zoom Zoom level
 * @param wrapperOffsetX Wrapper's fixed offset in scroll flow (X)
 * @param wrapperOffsetY Wrapper's fixed offset in scroll flow (Y)
 */
export function computeScrollPosition(
  contentX: number,
  contentY: number,
  targetScreenX: number,
  targetScreenY: number,
  zoom: number,
  wrapperOffsetX: number,
  wrapperOffsetY: number
): { scrollLeft: number; scrollTop: number } {
  return {
    scrollLeft: wrapperOffsetX + contentX * zoom - targetScreenX,
    scrollTop: wrapperOffsetY + contentY * zoom - targetScreenY
  };
}

/**
 * Verify: given a scroll position and zoom, where does a content point appear on screen?
 * This is the inverse of computeScrollPosition — used for test validation.
 */
export function contentToScreen(
  contentX: number,
  contentY: number,
  scrollLeft: number,
  scrollTop: number,
  zoom: number,
  wrapperOffsetX: number,
  wrapperOffsetY: number
): { screenX: number; screenY: number } {
  return {
    screenX: wrapperOffsetX + contentX * zoom - scrollLeft,
    screenY: wrapperOffsetY + contentY * zoom - scrollTop
  };
}
