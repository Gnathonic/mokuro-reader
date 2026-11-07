/**
 * The crop maths behind `ImageCropper.svelte` (the cover picker's and the Anki
 * modal's crop), kept free of the DOM so it can be tested on its own.
 *
 * cropperjs 2 is a set of web components that only knows about CSS pixels on
 * its `<cropper-canvas>`; everything the app keeps or outputs is in IMAGE
 * pixels. Coordinates here are one of two kinds:
 *
 *   frame  CSS pixels inside the `<cropper-canvas>` (the selection's own x/y/w/h)
 *   image  natural pixels of the image AS DISPLAYED — after any quarter turn, so
 *          a 90° turn of a 1000×1400 page is a 1400×1000 image. This is the space
 *          cropperjs 1's `getData()` reported in, and what the output is cut from.
 *
 * Where these replicate cropperjs 1.6.2 (the rounding, the output canvas size)
 * the v1 code they follow is named, so the numbers can be checked against it.
 */

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type QuarterTurn = 0 | 90 | 180 | 270;

/** The cover crop's default shape: 3 wide by 4 tall. */
export const COVER_ASPECT = 3 / 4;

export function nextQuarterTurn(rotation: QuarterTurn): QuarterTurn {
  return ((rotation + 90) % 360) as QuarterTurn;
}

/** The image's size once turned by `rotation`. */
export function rotatedSize(
  width: number,
  height: number,
  rotation: QuarterTurn
): { width: number; height: number } {
  return rotation === 90 || rotation === 270 ? { width: height, height: width } : { width, height };
}

/**
 * Where the (turned) image sits in the frame: scaled to fit inside it, aspect
 * kept, centred — cropperjs 1's `viewMode` 0/1 initial canvas, and where v1 put
 * a portrait page after `rotate(90)` too.
 */
export interface ImageLayout {
  /** Frame pixels per image pixel. */
  scale: number;
  left: number;
  top: number;
  /** The displayed (turned) image's size, in frame pixels. */
  width: number;
  height: number;
}

export function containLayout(
  naturalWidth: number,
  naturalHeight: number,
  rotation: QuarterTurn,
  frameWidth: number,
  frameHeight: number
): ImageLayout {
  const turned = rotatedSize(naturalWidth, naturalHeight, rotation);
  const scale = Math.min(frameWidth / turned.width, frameHeight / turned.height);
  const width = turned.width * scale;
  const height = turned.height * scale;
  return {
    scale,
    left: (frameWidth - width) / 2,
    top: (frameHeight - height) / 2,
    width,
    height
  };
}

/** The layout's image rectangle, in frame pixels. */
export function layoutBounds(layout: ImageLayout): CropRect {
  return { x: layout.left, y: layout.top, width: layout.width, height: layout.height };
}

/**
 * The CSS `matrix(a, b, c, d, e, f)` that puts a `<cropper-image>` where
 * `layout` says. The element is a natural-size box at the frame's origin,
 * transformed about its own centre (CSS's default `transform-origin`), so the
 * matrix scales and turns it there and then moves that centre onto the layout's.
 */
export function layoutMatrix(
  naturalWidth: number,
  naturalHeight: number,
  rotation: QuarterTurn,
  layout: ImageLayout
): [number, number, number, number, number, number] {
  const radians = (rotation * Math.PI) / 180;
  // Exact for quarter turns (Math.cos(π/2) is 6e-17, not 0).
  const cos = Math.round(Math.cos(radians));
  const sin = Math.round(Math.sin(radians));
  const s = layout.scale;
  return [
    s * cos,
    s * sin,
    -s * sin,
    s * cos,
    layout.left + layout.width / 2 - naturalWidth / 2,
    layout.top + layout.height / 2 - naturalHeight / 2
  ];
}

/** A frame rectangle in image pixels. */
export function toImageRect(frame: CropRect, layout: ImageLayout): CropRect {
  return {
    x: (frame.x - layout.left) / layout.scale,
    y: (frame.y - layout.top) / layout.scale,
    width: frame.width / layout.scale,
    height: frame.height / layout.scale
  };
}

/** An image rectangle in frame pixels. */
export function toFrameRect(image: CropRect, layout: ImageLayout): CropRect {
  return {
    x: layout.left + image.x * layout.scale,
    y: layout.top + image.y * layout.scale,
    width: image.width * layout.scale,
    height: image.height * layout.scale
  };
}

export function fullImageRect(width: number, height: number): CropRect {
  return { x: 0, y: 0, width, height };
}

/**
 * The cover picker's starting crop: full height at 3:4, centred, when the image
 * is at least that wide; otherwise (a page narrower than 3:4) the whole image.
 *
 * cropperjs 1 built the same box in display pixels, but offset it by the image's
 * left margin in the crop area (it added `getImageData().left`, which is relative
 * to the image, to a position relative to the container), so for images wider
 * than 3:4 it started left of centre by an amount that depended on the window
 * width. Its own Reset already gave this centred box; now the first view does too.
 */
export function initialCoverCrop(width: number, height: number): CropRect {
  if (width / height < COVER_ASPECT) return fullImageRect(width, height);
  const cropWidth = height * COVER_ASPECT;
  return { x: (width - cropWidth) / 2, y: 0, width: cropWidth, height };
}

/**
 * `rect` kept the same size (shrunk to fit if it is larger) and moved just far
 * enough to lie inside `bounds` — how cropperjs 1 (`viewMode: 1`) stopped a crop
 * box dragged against the image's edge, and the Anki modal's own `clampToImage`.
 */
export function clampMove(rect: CropRect, bounds: CropRect): CropRect {
  const width = Math.min(rect.width, bounds.width);
  const height = Math.min(rect.height, bounds.height);
  return {
    x: Math.min(Math.max(rect.x, bounds.x), bounds.x + bounds.width - width),
    y: Math.min(Math.max(rect.y, bounds.y), bounds.y + bounds.height - height),
    width,
    height
  };
}

/** The part of `rect` inside `bounds`, or null if they do not overlap. */
export function clampResize(rect: CropRect, bounds: CropRect): CropRect | null {
  const left = Math.max(rect.x, bounds.x);
  const top = Math.max(rect.y, bounds.y);
  const right = Math.min(rect.x + rect.width, bounds.x + bounds.width);
  const bottom = Math.min(rect.y + rect.height, bounds.y + bounds.height);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * What a selection change becomes when the crop must stay inside the image:
 * a MOVE (same size) slides along the edge it hits; a RESIZE or a newly drawn
 * box stops at the edge (the part outside is cut off). Null: nothing of it is
 * inside the image, so the change is refused.
 */
export function constrainSelection(
  next: CropRect,
  current: CropRect,
  bounds: CropRect
): CropRect | null {
  const moved = next.width === current.width && next.height === current.height;
  return moved ? clampMove(next, bounds) : clampResize(next, bounds);
}

export function sameRect(a: CropRect, b: CropRect, epsilon = 1e-9): boolean {
  return (
    Math.abs(a.x - b.x) <= epsilon &&
    Math.abs(a.y - b.y) <= epsilon &&
    Math.abs(a.width - b.width) <= epsilon &&
    Math.abs(a.height - b.height) <= epsilon
  );
}

/**
 * cropperjs 1's `getData(true)`: the top-left corner and the bottom-right corner
 * rounded, so rounding never adds a pixel at the right or bottom edge (v1 #343).
 */
export function roundCropData(rect: CropRect): CropRect {
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  return {
    x,
    y,
    width: Math.round(rect.x + rect.width) - x,
    height: Math.round(rect.y + rect.height) - y
  };
}

const REGEXP_DECIMALS = /\.\d*(?:0|9){12}\d*$/;

/** cropperjs 1's `normalizeDecimalNumber`: 0.30000000000000004 → 0.3, 999.9999999999999 → 1000. */
export function normalizeDecimalNumber(value: number, times = 100000000000): number {
  return REGEXP_DECIMALS.test(String(value)) ? Math.round(value * times) / times : value;
}

/**
 * The output canvas for an image-pixel crop of a `sourceWidth`×`sourceHeight`
 * image — cropperjs 1.6.2's `getCroppedCanvas()` with no size options, step for
 * step (its source canvas was the turned image at natural size, so its `ratio`
 * was 1): the canvas is the crop's size with the fraction dropped (a canvas
 * dimension is an integer; assigning 999.75 gives 999), and `drawParams` are
 * the `drawImage` source/destination rectangles, floored as v1 floored them.
 * `drawParams` is null when nothing of the image is inside the crop.
 */
export interface CropCanvasPlan {
  width: number;
  height: number;
  drawParams: [number, number, number, number, number, number, number, number] | null;
}

export function croppedCanvasPlan(
  crop: CropRect,
  sourceWidth: number,
  sourceHeight: number
): CropCanvasPlan {
  const { x: initialX, y: initialY, width: initialWidth, height: initialHeight } = crop;
  const aspectRatio = initialWidth / initialHeight;
  // getAdjustedSizes({ aspectRatio, width, height }) in its 'contain' mode.
  let width = initialWidth;
  let height = initialHeight;
  if (height * aspectRatio > width) height = width / aspectRatio;
  else width = height * aspectRatio;

  let srcX = initialX;
  let srcY = initialY;
  let srcWidth = 0;
  let srcHeight = 0;
  let dstX = 0;
  let dstY = 0;
  let dstWidth = 0;
  let dstHeight = 0;

  if (srcX <= -initialWidth || srcX > sourceWidth) {
    srcX = 0;
  } else if (srcX <= 0) {
    dstX = -srcX;
    srcX = 0;
    srcWidth = Math.min(sourceWidth, initialWidth + srcX);
    dstWidth = srcWidth;
  } else {
    srcWidth = Math.min(initialWidth, sourceWidth - srcX);
    dstWidth = srcWidth;
  }

  if (srcWidth <= 0 || srcY <= -initialHeight || srcY > sourceHeight) {
    srcY = 0;
    srcHeight = 0;
  } else if (srcY <= 0) {
    dstY = -srcY;
    srcY = 0;
    srcHeight = Math.min(sourceHeight, initialHeight + srcY);
    dstHeight = srcHeight;
  } else {
    srcHeight = Math.min(initialHeight, sourceHeight - srcY);
    dstHeight = srcHeight;
  }

  const canvasWidth = Math.max(0, Math.floor(normalizeDecimalNumber(width)));
  const canvasHeight = Math.max(0, Math.floor(normalizeDecimalNumber(height)));
  if (!(dstWidth > 0 && dstHeight > 0)) {
    return { width: canvasWidth, height: canvasHeight, drawParams: null };
  }
  const scale = width / initialWidth;
  const params = [
    srcX,
    srcY,
    srcWidth,
    srcHeight,
    dstX * scale,
    dstY * scale,
    dstWidth * scale,
    dstHeight * scale
  ].map((value) => Math.floor(normalizeDecimalNumber(value)) + 0); // + 0: no -0
  return {
    width: canvasWidth,
    height: canvasHeight,
    drawParams: params as CropCanvasPlan['drawParams']
  };
}

/**
 * A crop as fractions of its image, so it can be offered again on another
 * volume's cover ("Copy Last Crop Zone").
 */
export interface CropZone {
  xPercent: number;
  yPercent: number;
  widthPercent: number;
  heightPercent: number;
  aspectRatio: number;
}

export function rectToCropZone(rect: CropRect, width: number, height: number): CropZone | null {
  if (!width || !height || !rect.width || !rect.height) return null;
  return {
    xPercent: rect.x / width,
    yPercent: rect.y / height,
    widthPercent: rect.width / width,
    heightPercent: rect.height / height,
    aspectRatio: rect.width / rect.height
  };
}

/**
 * A saved crop zone on a `width`×`height` image: its aspect ratio kept, as close
 * to its relative size as that allows, and inside the image.
 */
export function cropZoneToRect(zone: CropZone, width: number, height: number): CropRect | null {
  if (!width || !height) return null;

  const aspectRatio = Math.max(zone.aspectRatio, 0.0001);
  const widthFromPercent = Math.max(zone.widthPercent * width, 1);
  const heightFromPercent = Math.max(zone.heightPercent * height, 1);

  // Preserve the aspect ratio while staying close to the stored relative size.
  let cropWidth = widthFromPercent;
  let cropHeight = cropWidth / aspectRatio;
  if (cropHeight > heightFromPercent) {
    cropHeight = heightFromPercent;
    cropWidth = cropHeight * aspectRatio;
  }

  // Clamp the size to the image while preserving the aspect ratio.
  const maxWidth = Math.min(width, height * aspectRatio);
  if (cropWidth > maxWidth) {
    cropWidth = maxWidth;
    cropHeight = cropWidth / aspectRatio;
  }
  const maxHeight = width / aspectRatio;
  if (cropHeight > height) {
    cropHeight = height;
    cropWidth = cropHeight * aspectRatio;
  } else if (cropHeight > maxHeight) {
    cropHeight = maxHeight;
    cropWidth = cropHeight * aspectRatio;
  }

  // Apply the relative origin and clamp so the crop always fits in the image.
  return {
    x: Math.min(Math.max(zone.xPercent * width, 0), width - cropWidth),
    y: Math.min(Math.max(zone.yPercent * height, 0), height - cropHeight),
    width: cropWidth,
    height: cropHeight
  };
}
