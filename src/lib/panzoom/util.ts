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
    onTouch: (e) => e.touches.length > 1,
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

  // Custom wheel handler for panning/zooming
  // We implement our own zoom because panzoom's default is asymmetric
  // (zoom in by 1.125x and out by 0.875x don't cancel out)
  const wheelHandler = (e: WheelEvent) => {
    if (!pz) return;

    const swapWheelBehavior = get(settings).swapWheelBehavior;
    // When swapWheelBehavior is true: zoom without modifier, pan with Ctrl
    // When swapWheelBehavior is false (default): pan without modifier, zoom with Ctrl
    const shouldZoom = swapWheelBehavior ? !e.ctrlKey : e.ctrlKey;

    e.preventDefault();

    if (shouldZoom) {
      // Normalize wheel delta to pixels across browsers (based on Facebook's normalize-wheel)
      // https://github.com/basilfx/normalize-wheel
      const LINE_HEIGHT = 25; // Tuned to match Chrome's zoom steps
      const PAGE_HEIGHT = 800; // Approximate pixels per page
      let pixelDelta: number;
      if (e.deltaMode === 1) {
        // Lines (Firefox) - convert to pixels
        pixelDelta = e.deltaY * LINE_HEIGHT;
      } else if (e.deltaMode === 2) {
        // Pages - convert to pixels
        pixelDelta = e.deltaY * PAGE_HEIGHT;
      } else {
        // Already in pixels (Chrome, Edge, Safari)
        pixelDelta = e.deltaY;
      }

      // Calculate zoom multiplier (based on anvaka/panzoom approach)
      // speed * delta / 128, capped at 0.25 (25% max per event)
      const zoomSpeed = 0.2;
      const sign = Math.sign(pixelDelta);
      const deltaAdjustedSpeed = Math.min(0.25, Math.abs((zoomSpeed * pixelDelta) / 128));
      let scaleMultiplier = 1 - sign * deltaAdjustedSpeed;

      // In bounds mode, limit zoom out to the smaller of:
      // 1. Fit-to-screen scale (so large content can fill viewport)
      // 2. 1.0 (100% zoom - small content can't go below pixel-for-pixel)
      const { mobile, bounds } = get(settings);
      if ((mobile || bounds) && container) {
        const currentScale = pz.getTransform().scale;
        const { innerWidth, innerHeight } = window;
        const fitScaleX = innerWidth / container.offsetWidth;
        const fitScaleY = innerHeight / container.offsetHeight;
        const fitScale = Math.min(fitScaleX, fitScaleY);
        // Large images (fitScale < 1): can zoom out to fit
        // Small images (fitScale > 1): can't zoom out past 100%
        const minScale = Math.min(fitScale, 1.0);

        const newScale = currentScale * scaleMultiplier;
        if (newScale < minScale) {
          // Clamp to minimum scale
          scaleMultiplier = minScale / currentScale;
        }
      }

      // Zoom centered on mouse position (zoomTo expects client coordinates)
      pz.zoomTo(e.clientX, e.clientY, scaleMultiplier);
    } else {
      // Pan vertically based on wheel deltaY
      const { x, y } = pz.getTransform();
      pz.moveTo(x, y - e.deltaY);
    }
    keepInBounds();
  };

  node.addEventListener('wheel', wheelHandler, { passive: false });

  // Return cleanup function
  return {
    destroy() {
      node.removeEventListener('wheel', wheelHandler);
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

  const { x, y, scale } = transform;
  const { innerWidth, innerHeight } = window;

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

  if (forceCenterX) {
    transform.x = (innerWidth - width) / 2;
  } else {
    if (x < minX) {
      transform.x = minX;
    }
    if (x > maxX) {
      transform.x = maxX;
    }
  }

  if (forceCenterY) {
    transform.y = (innerHeight - height) / 2;
  } else {
    if (y < minY) {
      transform.y = minY;
    }
    if (y > maxY) {
      transform.y = maxY;
    }
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
