import { settings } from '$lib/settings';
import type { PanZoom } from 'panzoom';
import panzoom from 'panzoom';
import { get, writable } from 'svelte/store';

let pz: PanZoom | undefined;
let container: HTMLElement | undefined;

export const panzoomStore = writable<PanZoom | undefined>(undefined);

export function initPanzoom(node: HTMLElement) {
  container = node;
  pz = panzoom(node, {
    bounds: false,
    maxZoom: 10,
    minZoom: 0.1,
    zoomDoubleClickSpeed: 1,
    enableTextSelection: true,
    beforeMouseDown: (e) => {
      const target = e.target as HTMLElement;
      // Check if the target is a text box or a child of a text box
      const isTextBox = target.classList.contains('textBox') || 
                        target.closest('.textBox') !== null;
      // Return true to prevent panning when clicking on text boxes
      // This allows text selection within text boxes
      return isTextBox;
    },
    beforeWheel: (e) => e.altKey,
    onTouch: (e) => e.touches.length > 1,
    // Panzoom typing is wrong here
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    filterKey: (e: any) => {
      if (
        e.key === 'ArrowLeft' ||
        e.key === 'ArrowRight' ||
        e.key === 'ArrowUp' ||
        e.key === 'ArrowDown'
      ) {
        return true;
      }
    }
  });

  panzoomStore.set(pz);

  pz.on('pan', () => keepInBounds());
  pz.on('zoom', () => keepInBounds());
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

  const marginX = innerWidth * 0.001;
  const marginY = innerHeight * 0.01;

  let minX = innerWidth - width - marginX;
  let maxX = marginX;
  let minY = innerHeight - height - marginY;
  let maxY = marginY;

  let forceCenterY = false;

  if (width + 2 * marginX <= innerWidth) {
    minX = marginX;
    maxX = innerWidth - width - marginX;
  } else {
    minX = innerWidth - width - marginX;
    maxX = marginX;
  }

  if (height + 2 * marginY <= innerHeight) {
    minY = marginY;
    maxY = innerHeight - height - marginY;
    forceCenterY = true;
  } else {
    minY = innerHeight - height - marginY;
    maxY = marginY;
  }

  if (x < minX) {
    transform.x = minX;
  }
  if (x > maxX) {
    transform.x = maxX;
  }

  if (forceCenterY) {
    transform.y = innerHeight / 2 - height / 2;
  } else {
    if (y < minY) {
      transform.y = minY;
    }
    if (y > maxY) {
      transform.y = maxY;
    }
  }
}

export function toggleFullScreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen();
  } else if (document.exitFullscreen) {
    document.exitFullscreen();
  }
}
