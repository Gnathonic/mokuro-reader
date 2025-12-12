import type { Block } from '$lib/types';

/**
 * Replaces predetermined sequences with their combined character
 * for correct vertical text display.
 */
export const ligaturize = (text: string): string => {
  const ellipsis = '\u2026'; // vertically centered 1.5em variant: '．\ufe01．\ufe01．\ufe01'
  const doubleExcl = '\u203C';
  const exclQuest = '\u2049';

  const regexes = new Map<RegExp, string>();
  regexes.set(/[\.．。]{2,}/g, ellipsis);
  regexes.set(/[!！]{2,}/g, doubleExcl);
  regexes.set(/[!！][?？]/g, exclQuest);

  let s = text;
  for (const [reg, pattern] of regexes) {
    s = s.replaceAll(reg, pattern);
  }
  return s;
};

/**
 * Gets the scale ratio of rendered pixels to image pixels.
 */
export const getScaleRatios = (
  containerElement: HTMLElement,
  imgWidth: number,
  imgHeight: number
) => {
  if (!containerElement.parentElement) {
    return { scaleRatioX: 1, scaleRatioY: 1 };
  }
  // This rect is the size of the image container as rendered
  const rect = containerElement.parentElement.getBoundingClientRect();

  // page.img_width is the original image file width
  const scaleRatioX = imgWidth / rect.width;
  const scaleRatioY = imgHeight / rect.height;

  return { scaleRatioX, scaleRatioY };
};

/**
 * Gets the real image pixel coordinates from a mouse click event,
 * accounting for current panzoom scale and offset.
 */
export const getRelativeCoords = (
  event: MouseEvent,
  containerElement: HTMLElement,
  imgWidth: number,
  imgHeight: number,
) => {
  if (!containerElement.parentElement) {
    return { imgX: 0, imgY: 0 };
  }

  const { scaleRatioX, scaleRatioY } = getScaleRatios(containerElement, imgWidth, imgHeight);

  // rect is the page's bounding box, *including* pan and zoom
  const rect = containerElement.parentElement.getBoundingClientRect();

  // 1. Get click position relative to the panned, zoomed container
  const relativeX = event.clientX - rect.left;
  const relativeY = event.clientY - rect.top;

  // 2. Convert container-relative pixels to image-absolute pixels
  const imgX = relativeX * scaleRatioX;
  const imgY = relativeY * scaleRatioY;

  return { imgX, imgY };
};

/**
 * Gets the real image pixel deltas from a mouse move event,
 * accounting for the current panzoom scale.
 */
export const getImageDeltas = (
  moveEvent: { movementX: number, movementY: number },
  containerElement: HTMLElement,
  imgWidth: number,
  imgHeight: number,
) => {
  const { scaleRatioX, scaleRatioY } = getScaleRatios(containerElement, imgWidth, imgHeight);

  // 1. Get mouse movement delta (browser handles zoom natively in movementX/Y usually, 
  // but we apply the ratio to map to image space)
  const relativeDeltaX = moveEvent.movementX;
  const relativeDeltaY = moveEvent.movementY;

  // 2. Convert container-relative delta to image-absolute delta
  const imageDeltaX = relativeDeltaX * scaleRatioX / devicePixelRatio;
  const imageDeltaY = relativeDeltaY * scaleRatioY / devicePixelRatio;

  return { imageDeltaX, imageDeltaY };
};

/**
 * Automatically set the font of the current block such that
 * the text fits snug to the current line's box.
 * @param block The block data (mutated)
 * @param lineElement The DOM element containing the text
 * @param imgWidth Original image width (for max bounds)
 * @param fontScale Current visual scale factor
 */
export function smartResizeFont(
  block: Block,
  lineElement: HTMLElement,
  imgWidth: number,
  fontScale: number
) {
  if (!lineElement || !lineElement.parentElement) return;

  const isVertical = block.vertical ?? false;

  // 1. Get Target Dimension
  const parentRect = lineElement.parentElement.getBoundingClientRect();
  const targetMeasure = isVertical ? parentRect.height : parentRect.width;

  // 2. Define search range
  const MIN_FONT_SIZE = 8;
  const MAX_FONT_SIZE = imgWidth / 2;

  // 3. Helper function to measure the DOM at a specific size
  const range = document.createRange();
  range.selectNodeContents(lineElement);
  const measure = (size: number): number => {
    lineElement.style.fontSize = `${fontScale / devicePixelRatio * size}px`;
    const rect = lineElement.getBoundingClientRect();
    return isVertical ? rect.height : rect.width;
  };

  // 4. Binary search
  let min = MIN_FONT_SIZE;
  let max = MAX_FONT_SIZE;
  let minMeasure = measure(min);
  let maxMeasure = measure(max);
  let guess = min + ((targetMeasure - minMeasure) / (maxMeasure - minMeasure)) * (max - min);
  let bestGuess = guess;

  for (let i = 0; i < 100; i++) {
    let guessMeasure = measure(guess);
    let delta = targetMeasure - guessMeasure;

    if (delta > 0) {
      min = guess;
      minMeasure = guessMeasure;
      bestGuess = guess;
    }
    if (delta < 0) {
      max = guess;
      maxMeasure = guessMeasure;
    }
    if (max - min < 0.001 || Math.abs(delta) < 0.1) {
      break;
    }

    // Linear interpolation
    guess = min + ((targetMeasure - minMeasure) / (maxMeasure - minMeasure)) * (max - min);
  }

  // 5. Return result (Mutation is handled by caller or we can do it here if we pass object)
  block.font_size = +bestGuess.toFixed(3);
  // lineElement.style.fontSize = `${fontScale * block.font_size}px`;

  // 6. cleanup
  range.detach();
}
