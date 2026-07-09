/**
 * Reader-specific zoomed layout, applied imperatively from the zoom
 * controller's frame step (before it measures and corrects scroll).
 *
 * This is the single source of truth for the layout rules behind issue #195:
 *
 * - The wrapper scales via transform with the origin on the scroll-origin
 *   side: `top right` in RTL, `top left` otherwise. Per CSS Overflow,
 *   content overflowing past the inline-start edge is unreachable by
 *   scrolling, so the scaled strip must grow toward inline-end.
 * - Spacers take the wrapper's measured layout size × zoom so the scroll
 *   range covers the visual extent in every continuousZoomDefault mode.
 * - Vertical: the wrapper's layout width is pinned to the viewport width
 *   while zoomed — the spacer grows to provide scroll range, and an unpinned
 *   block wrapper would track it, resizing fit-to-width pages every frame
 *   (zoom² growth) and re-centering mx-auto pages.
 * - Horizontal: cross-axis alignment is a pure function of measured geometry
 *   (`flex-start` when the strip's visual height exceeds the container,
 *   `center` otherwise), applied in the same task as the transform so the
 *   controller's measurement sees post-alignment layout. Reactive-state
 *   flips flush asynchronously and caused the old settle jump.
 *
 * The e2e suite imports this module through the Vite dev server and drives
 * the real functions — keep it free of Svelte and component state.
 */

export interface VerticalZoomElements {
  wrapper: HTMLElement;
  spacer: HTMLElement;
}

export interface HorizontalZoomElements {
  wrapper: HTMLElement;
  spacer: HTMLElement;
  container: HTMLElement;
}

/**
 * @param contentWidth Widest page's scaled layout width at the current zoom
 * mode (computed from page data). The wrapper is pinned to the CONTENT width
 * — not the viewport width — and centered, scaling from `top center`: the
 * scroll range then hugs the content exactly. Pinning to the viewport width
 * made the side margins of narrower-than-viewport content (fit-to-screen)
 * part of the scaled wrapper, creating a pan range that let pages be pushed
 * fully off screen.
 *
 * Geometry: spacer width = max(viewport, content×zoom); the centered wrapper's
 * visual span is [spacer/2 − content×zoom/2, spacer/2 + content×zoom/2],
 * which stays inside the spacer on both sides for any zoom — no unreachable
 * inline-start overflow, no phantom margin panning.
 */
export function applyVerticalZoomLayout(
  els: VerticalZoomElements,
  viewport: { width: number; height: number },
  contentWidth: number,
  zoom: number
): void {
  const { wrapper, spacer } = els;
  wrapper.style.transformOrigin = 'top center';
  if (zoom > 1) {
    wrapper.style.width = `${contentWidth}px`;
    wrapper.style.marginLeft = 'auto';
    wrapper.style.marginRight = 'auto';
    spacer.style.width = `${Math.max(viewport.width, contentWidth * zoom)}px`;
    spacer.style.minHeight = `${wrapper.offsetHeight * zoom + viewport.height}px`;
    wrapper.style.transform = `scale(${zoom})`;
  } else {
    wrapper.style.transform = '';
    wrapper.style.width = '';
    wrapper.style.marginLeft = '';
    wrapper.style.marginRight = '';
    spacer.style.width = '';
    spacer.style.minHeight = '';
  }
}

/** `flex-start` when the strip's visual height exceeds the container, else `center`. */
function horizontalAlignment(visualHeight: number, containerHeight: number): string {
  return visualHeight > containerHeight + 1 ? 'flex-start' : 'center';
}

export function applyHorizontalAlignment(els: HorizontalZoomElements, zoom: number): void {
  const align = horizontalAlignment(els.wrapper.offsetHeight * zoom, els.container.clientHeight);
  els.container.style.alignItems = align;
  els.spacer.style.alignItems = align;
}

export function applyHorizontalZoomLayout(
  els: HorizontalZoomElements,
  rtl: boolean,
  zoom: number
): void {
  const { wrapper, spacer } = els;
  wrapper.style.transformOrigin = rtl ? 'top right' : 'top left';
  if (zoom > 1) {
    spacer.style.width = `${wrapper.offsetWidth * zoom}px`;
    spacer.style.height = `${wrapper.offsetHeight * zoom}px`;
    wrapper.style.transform = `scale(${zoom})`;
  } else {
    wrapper.style.transform = '';
    spacer.style.width = '';
    spacer.style.height = '';
  }
  applyHorizontalAlignment(els, zoom);
}
