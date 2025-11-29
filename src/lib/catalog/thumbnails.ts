import Pica from 'pica';

export interface ThumbnailResult {
  file: File;
  width: number;
  height: number;
}

// Resize strategy levels - we escalate through these on failure
type ResizeStrategy = 'default' | 'js-only' | 'prescale' | 'canvas-native';

// Remember what works - persists across calls within session
let currentStrategy: ResizeStrategy = 'default';

// Pica instances - created lazily as needed
let picaDefault: ReturnType<typeof Pica> | null = null;
let picaJsOnly: ReturnType<typeof Pica> | null = null;

// Safe canvas size limit for mobile (4 megapixels is conservative)
const SAFE_CANVAS_PIXELS = 4_000_000;

// Detect if we're likely on a mobile device with canvas restrictions
function isMobileBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
}

type PicaInstance = ReturnType<typeof Pica>;

function getPicaDefault(): PicaInstance {
  if (!picaDefault) picaDefault = new Pica();
  return picaDefault;
}

function getPicaJsOnly(): PicaInstance {
  if (!picaJsOnly) picaJsOnly = new Pica({ features: ['js'] });
  return picaJsOnly;
}

const PICA_OPTIONS = {
  filter: 'lanczos3' as const,
  unsharpAmount: 80,
  unsharpRadius: 0.6,
  unsharpThreshold: 2
};

async function resizeWithPica(
  pica: PicaInstance,
  srcCanvas: HTMLCanvasElement,
  destCanvas: HTMLCanvasElement,
  mimeType: string
): Promise<Blob> {
  await pica.resize(srcCanvas, destCanvas, PICA_OPTIONS);
  return await pica.toBlob(destCanvas, mimeType, 0.85);
}

function resizeWithCanvas(
  srcCanvas: HTMLCanvasElement,
  destCanvas: HTMLCanvasElement,
  mimeType: string
): Promise<Blob> {
  const ctx = destCanvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');

  // Enable image smoothing for better quality
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(srcCanvas, 0, 0, destCanvas.width, destCanvas.height);

  return new Promise((resolve, reject) => {
    destCanvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))),
      mimeType,
      0.85
    );
  });
}

function prescaleCanvas(srcCanvas: HTMLCanvasElement, maxPixels: number): HTMLCanvasElement {
  const pixels = srcCanvas.width * srcCanvas.height;
  if (pixels <= maxPixels) return srcCanvas;

  const scale = Math.sqrt(maxPixels / pixels);
  const newWidth = Math.floor(srcCanvas.width * scale);
  const newHeight = Math.floor(srcCanvas.height * scale);

  const scaled = document.createElement('canvas');
  scaled.width = newWidth;
  scaled.height = newHeight;

  const ctx = scaled.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(srcCanvas, 0, 0, newWidth, newHeight);

  return scaled;
}

export async function generateThumbnail(
  file: File,
  maxWidth = 250,
  maxHeight = 350
): Promise<ThumbnailResult> {
  // Create an image element and load the file
  const img = new Image();
  const imgUrl = URL.createObjectURL(file);
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = imgUrl;
  });
  URL.revokeObjectURL(imgUrl);

  // Calculate target dimensions maintaining aspect ratio
  const scaleW = maxWidth / img.width;
  const scaleH = maxHeight / img.height;
  const scale = Math.min(scaleW, scaleH, 1); // Don't scale up

  const targetWidth = Math.round(img.width * scale);
  const targetHeight = Math.round(img.height * scale);

  // Create source canvas from image
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = img.width;
  srcCanvas.height = img.height;
  const srcCtx = srcCanvas.getContext('2d');
  if (!srcCtx) throw new Error('Could not get canvas context');
  srcCtx.drawImage(img, 0, 0);

  // Create destination canvas
  const destCanvas = document.createElement('canvas');
  destCanvas.width = targetWidth;
  destCanvas.height = targetHeight;

  const mimeType = file.type || 'image/jpeg';
  const sourcePixels = img.width * img.height;

  // On mobile with large images, skip straight to prescale strategy
  if (
    isMobileBrowser() &&
    sourcePixels > SAFE_CANVAS_PIXELS &&
    (currentStrategy === 'default' || currentStrategy === 'js-only')
  ) {
    currentStrategy = 'prescale';
  }

  let blob: Blob | null = null;
  let startStrategy = currentStrategy;

  // Try strategies in order, starting from our current known-good level
  const strategies: ResizeStrategy[] = ['default', 'js-only', 'prescale', 'canvas-native'];
  const startIndex = strategies.indexOf(startStrategy);

  for (let i = startIndex; i < strategies.length; i++) {
    const strategy = strategies[i];

    try {
      switch (strategy) {
        case 'default':
          blob = await resizeWithPica(getPicaDefault(), srcCanvas, destCanvas, mimeType);
          break;

        case 'js-only':
          blob = await resizeWithPica(getPicaJsOnly(), srcCanvas, destCanvas, mimeType);
          break;

        case 'prescale': {
          const prescaled = prescaleCanvas(srcCanvas, SAFE_CANVAS_PIXELS);
          blob = await resizeWithPica(getPicaJsOnly(), prescaled, destCanvas, mimeType);
          break;
        }

        case 'canvas-native':
          blob = await resizeWithCanvas(srcCanvas, destCanvas, mimeType);
          break;
      }

      // Success - remember this strategy for future calls
      if (blob) {
        if (strategy !== currentStrategy) {
          console.info(`[thumbnails] Strategy '${strategy}' succeeded, using for future resizes`);
          currentStrategy = strategy;
        }
        break;
      }
    } catch (err) {
      console.warn(`[thumbnails] Strategy '${strategy}' failed:`, err);
      // Continue to next strategy
    }
  }

  if (!blob) {
    throw new Error('All thumbnail generation strategies failed');
  }

  return {
    file: new File([blob], `thumbnail_${file.name}`, { type: mimeType }),
    width: targetWidth,
    height: targetHeight
  };
}
