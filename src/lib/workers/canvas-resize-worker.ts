/**
 * Worker for canvas-based image resizing.
 * Fallback for when pica fails on older devices.
 * Uses OffscreenCanvas to avoid blocking the main thread.
 */

export interface ResizeMessage {
  type: 'resize';
  id: number;
  bitmap: ImageBitmap;
  targetWidth: number;
  targetHeight: number;
}

export interface ResizeResult {
  type: 'result';
  id: number;
  bitmap: ImageBitmap;
}

export interface ResizeError {
  type: 'error';
  id: number;
  error: string;
}

self.onmessage = async (e: MessageEvent<ResizeMessage>) => {
  const { type, id, bitmap, targetWidth, targetHeight } = e.data;

  if (type !== 'resize') return;

  try {
    // Create OffscreenCanvas at target size
    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      throw new Error('Failed to get 2d context');
    }

    // High quality scaling
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // Draw scaled image
    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);

    // Convert to ImageBitmap for transfer back
    const resultBitmap = await createImageBitmap(canvas);

    // Close the source bitmap to free memory
    bitmap.close();

    const result: ResizeResult = {
      type: 'result',
      id,
      bitmap: resultBitmap
    };

    self.postMessage(result, { transfer: [resultBitmap] });
  } catch (err) {
    const error: ResizeError = {
      type: 'error',
      id,
      error: err instanceof Error ? err.message : String(err)
    };
    self.postMessage(error);
  }
};
