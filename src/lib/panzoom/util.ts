import { settings } from '$lib/settings';
import type { PanZoom } from 'panzoom';
import panzoom from 'panzoom';
import { get, writable } from 'svelte/store';

let pz: PanZoom | undefined;
let container: HTMLElement | undefined;

export const panzoomStore = writable<PanZoom | undefined>(undefined);

// Session-only store to track fullscreen state across volume navigation
// undefined = not set yet (initial load), true/false = explicit state from user or navigation
export const sessionFullscreenState = writable<boolean | undefined>(undefined);

// Store for zoom level notifications
export const zoomNotification = writable<{ percent: number; timestamp: number } | null>(null);

export function initPanzoom(node: HTMLElement) {
  container = node;

  pz = panzoom(node, {
    bounds: false,
    maxZoom: 10,
    minZoom: 0.1,
    zoomDoubleClickSpeed: 1,
    enableTextSelection: true,
    onDoubleClick: () => false, // Allow dblclick events to propagate to Reader's onDoubleTap handler
    beforeMouseDown: (e) => {
      const target = e.target as HTMLElement;
      // Check if the target is a text box or a child of a text box
      const isTextBox = target.classList.contains('textBox') || target.closest('.textBox') !== null;
      // Return true to prevent panning when clicking on text boxes
      // This allows text selection within text boxes
      return isTextBox;
    },
    // Disable library's wheel zoom - we handle it ourselves for symmetric zoom
    beforeWheel: () => true,
    // Let panzoom handle all touch events including pinch-zoom
    // Our swipe detection uses velocity + multi-touch cooldown to avoid conflicts
    pinchSpeed: 1,
    // Panzoom typing is wrong here
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    filterKey: (e: KeyboardEvent) => {
      // Filter (ignore) keys that shouldn't be handled by panzoom
      const target = e.target as HTMLElement;

      // Always filter left/right arrows (page navigation)
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        return true;
      }

      // Filter all keys when in text inputs, settings, popovers, or textboxes
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable ||
        target.closest('#settings') ||
        target.closest('[data-popover]') ||
        target.closest('.textBox')
      ) {
        return true;
      }

      // Filter nav keys when modifier keys are pressed (for text selection, etc.)
      const isNavKey = ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key);
      if (isNavKey && (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey)) {
        return true;
      }

      return false;
    }
  });

  panzoomStore.set(pz);

  pz.on('pan', () => keepInBounds());
  pz.on('zoom', () => keepInBounds());
  pz.on('transform', () => keepInBounds());
  pz.on('panend', () => keepInBounds());
  pz.on('zoomend', () => keepInBounds());

  // Wheel handler is registered at window level in Reader.svelte
  // to capture events from all UI elements and prevent browser zoom

  // Return cleanup function
  return {
    destroy() {
      pz?.dispose();
    }
  };
}

type PanX = 'left' | 'center' | 'right';
type PanY = 'top' | 'center' | 'bottom';

export function panAlign(alignX: PanX, alignY: PanY) {
  if (!pz || !container) {
    return;
  }

  const { scale } = pz.getTransform();
  const { innerWidth, innerHeight } = window;
  const { offsetWidth, offsetHeight } = container;

  let x = 0;
  let y = 0;

  switch (alignX) {
    case 'left':
      x = 0;
      break;
    case 'center':
      x = (innerWidth - offsetWidth * scale) / 2;
      break;
    case 'right':
      x = innerWidth - offsetWidth * scale;
      break;
  }

  switch (alignY) {
    case 'top':
      y = 0;
      break;
    case 'center':
      y = (innerHeight - offsetHeight * scale) / 2;
      break;
    case 'bottom':
      y = innerHeight - offsetHeight * scale;
      break;
  }

  pz.pause();
  pz.moveTo(x, y);
  pz.resume();
}

export function zoomOriginal() {
  pz?.moveTo(0, 0);
  pz?.zoomTo(0, 0, 1 / pz.getTransform().scale);
  panAlign('center', 'center');
}

export function zoomFitToWidth() {
  if (!pz || !container) {
    return;
  }
  const { innerWidth } = window;

  const scale = (1 / pz.getTransform().scale) * (innerWidth / container.offsetWidth);

  pz.moveTo(0, 0);
  pz.zoomTo(0, 0, scale);
  panAlign('center', 'top');
}

export function zoomFitToScreen() {
  if (!pz || !container) {
    return;
  }
  const { innerWidth, innerHeight } = window;
  const scaleX = innerWidth / container.offsetWidth;
  const scaleY = innerHeight / container.offsetHeight;
  const scale = (1 / pz.getTransform().scale) * Math.min(scaleX, scaleY);
  pz.moveTo(0, 0);
  pz.zoomTo(0, 0, scale);
  panAlign('center', 'center');
}

export function keepZoomStart() {
  panAlign('center', 'top');
}

export function zoomDefault() {
  const zoomDefault = get(settings).zoomDefault;
  switch (zoomDefault) {
    case 'zoomFitToScreen':
      zoomFitToScreen();
      return;
    case 'zoomFitToWidth':
      zoomFitToWidth();
      return;
    case 'zoomOriginal':
      zoomOriginal();
      return;
    case 'keepZoomStart':
      keepZoomStart();
      return;
  }
}

export function zoomDefaultWithLayoutWait() {
  // Double RAF ensures browser has completed layout reflow
  // First RAF: waits for current layout calculations to finish
  // Second RAF: ensures next paint frame has correct dimensions
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      zoomDefault();
    });
  });
}

export function keepInBounds() {
  if (!pz || !container) {
    return;
  }

  const { mobile, bounds } = get(settings);

  if (!mobile && !bounds) {
    return;
  }

  const transform = pz.getTransform();
  let { x, y, scale } = transform;
  const { innerWidth, innerHeight } = window;

  // Enforce minimum zoom level (can't zoom out past fit-to-screen)
  const fitScaleX = innerWidth / container.offsetWidth;
  const fitScaleY = innerHeight / container.offsetHeight;
  const fitScale = Math.min(fitScaleX, fitScaleY);
  // Large images (fitScale < 1): can zoom out to fit
  // Small images (fitScale > 1): can't zoom out past 100%
  const minScale = Math.min(fitScale, 1.0);
  const maxScale = 10;

  if (scale < minScale) {
    // Zoom back to minimum, centered
    const zoomMultiplier = minScale / scale;
    pz.zoomTo(innerWidth / 2, innerHeight / 2, zoomMultiplier);
    scale = minScale;
  } else if (scale > maxScale) {
    const zoomMultiplier = maxScale / scale;
    pz.zoomTo(innerWidth / 2, innerHeight / 2, zoomMultiplier);
    scale = maxScale;
  }

  const width = container.offsetWidth * scale;
  const height = container.offsetHeight * scale;

  let minX: number;
  let maxX: number;
  let minY: number;
  let maxY: number;
  let forceCenterX = false;
  let forceCenterY = false;

  // Content fits horizontally - center it and prevent panning
  if (width <= innerWidth) {
    forceCenterX = true;
    minX = 0;
    maxX = 0;
  } else {
    // Content is wider than viewport - allow panning edge to edge
    minX = innerWidth - width;
    maxX = 0;
  }

  // Content fits vertically - center it and prevent panning
  if (height <= innerHeight) {
    forceCenterY = true;
    minY = 0;
    maxY = 0;
  } else {
    // Content is taller than viewport - allow panning edge to edge
    minY = innerHeight - height;
    maxY = 0;
  }

  let newX = x;
  let newY = y;

  if (forceCenterX) {
    newX = (innerWidth - width) / 2;
  } else {
    if (x < minX) {
      newX = minX;
    }
    if (x > maxX) {
      newX = maxX;
    }
  }

  if (forceCenterY) {
    newY = (innerHeight - height) / 2;
  } else {
    if (y < minY) {
      newY = minY;
    }
    if (y > maxY) {
      newY = maxY;
    }
  }

  // Apply the corrected position if it changed
  if (newX !== x || newY !== y) {
    pz.moveTo(newX, newY);
  }
}

export function scrollImage(direction: 'up' | 'down') {
  if (!pz) return;

  const { x, y } = pz.getTransform();
  const scrollAmount = window.innerHeight * 0.75; // 75% of visible page height

  if (direction === 'up') {
    pz.smoothMoveTo(x, y + scrollAmount);
  } else {
    pz.smoothMoveTo(x, y - scrollAmount);
  }

  keepInBounds();
}

export function toggleFullScreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen();
    sessionFullscreenState.set(true);
  } else if (document.exitFullscreen) {
    document.exitFullscreen();
    sessionFullscreenState.set(false);
  }
}

/**
 * Handle wheel events for panning and zooming.
 * Called from window-level listener to capture events from all UI elements.
 * Must be registered with { capture: true, passive: false } to intercept before browser.
 */
export function handleWheel(e: WheelEvent): void {
  if (!pz || !container) return;

  const swapWheelBehavior = get(settings).swapWheelBehavior;
  // When swapWheelBehavior is true: zoom without modifier, pan with Ctrl
  // When swapWheelBehavior is false (default): pan without modifier, zoom with Ctrl
  const shouldZoom = swapWheelBehavior ? !e.ctrlKey : e.ctrlKey;

  e.preventDefault();

  if (shouldZoom) {
    // Normalize wheel delta to ~15% zoom per typical tick
    // Actual observed deltas: Chrome ~15, Firefox ~1
    const baseMultiplier = e.deltaMode === 1 ? 0.15 : e.deltaMode ? 1 : 0.01;

    // Mac trackpad/mouse feels correct at full speed, but Windows/Linux
    // mice with discrete scroll wheels are too aggressive - halve the speed
    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
    const platformMultiplier = isMac ? 1 : 0.5;

    const normalizedDelta = -e.deltaY * baseMultiplier * platformMultiplier;

    // Linear scaling: directly use normalized delta as percentage change
    // e.g., normalizedDelta of 0.2 = 20% zoom change
    let scaleMultiplier = 1 + normalizedDelta;

    // Clamp resulting scale to bounds (d3-zoom's scaleExtent approach)
    const currentScale = pz.getTransform().scale;
    const maxZoom = 10;

    // Calculate minimum scale based on bounds mode
    const { mobile, bounds } = get(settings);
    let minScale = 0.1;
    if ((mobile || bounds) && container) {
      const { innerWidth, innerHeight } = window;
      const fitScaleX = innerWidth / container.offsetWidth;
      const fitScaleY = innerHeight / container.offsetHeight;
      const fitScale = Math.min(fitScaleX, fitScaleY);
      // Large images (fitScale < 1): can zoom out to fit
      // Small images (fitScale > 1): can't zoom out past 100%
      minScale = Math.min(fitScale, 1.0);
    }

    // Clamp the new scale and adjust multiplier accordingly
    const newScale = Math.max(minScale, Math.min(maxZoom, currentScale * scaleMultiplier));
    scaleMultiplier = newScale / currentScale;

    // Edge-aware zoom: blend zoom point toward center when near edges
    // This prevents corners from being pushed off-screen when zooming
    const { x: tx, y: ty } = pz.getTransform();
    const contentWidth = container.offsetWidth * currentScale;
    const contentHeight = container.offsetHeight * currentScale;

    // Calculate cursor position relative to content (0-1 range)
    const relX = (e.clientX - tx) / contentWidth;
    const relY = (e.clientY - ty) / contentHeight;

    // Calculate edge proximity (0 = center, 1 = edge)
    // Using a smooth curve that ramps up near edges
    const edgeThreshold = 0.2; // Start blending within 20% of edge
    const edgeProximityX =
      Math.max(0, Math.max(edgeThreshold - relX, relX - (1 - edgeThreshold))) / edgeThreshold;
    const edgeProximityY =
      Math.max(0, Math.max(edgeThreshold - relY, relY - (1 - edgeThreshold))) / edgeThreshold;
    const edgeProximity = Math.max(edgeProximityX, edgeProximityY);

    // Blend zoom point AWAY from viewport center (toward edge) when near edges
    // This keeps corners visible by making them the anchor point
    const viewportCenterX = window.innerWidth / 2;
    const viewportCenterY = window.innerHeight / 2;
    const blendFactor = Math.min(1, edgeProximity); // 0 = cursor, 1 = toward edge

    // Push zoom point away from center (opposite direction)
    const zoomX = e.clientX - (viewportCenterX - e.clientX) * blendFactor * 0.5;
    const zoomY = e.clientY - (viewportCenterY - e.clientY) * blendFactor * 0.5;

    // Zoom centered on blended position
    pz.zoomTo(zoomX, zoomY, scaleMultiplier);

    // Emit zoom notification for UI feedback
    zoomNotification.set({ percent: Math.round(newScale * 100), timestamp: Date.now() });
  } else {
    // Pan vertically based on wheel deltaY
    const { x, y } = pz.getTransform();
    pz.moveTo(x, y - e.deltaY);
  }
  keepInBounds();
}
