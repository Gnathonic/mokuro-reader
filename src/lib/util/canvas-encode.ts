/**
 * A canvas encoded NOW, on the calling thread — for encodes a user is waiting on.
 *
 * Chromium encodes JPEG and PNG for `HTMLCanvasElement.toBlob` and for a
 * main-thread `OffscreenCanvas.convertToBlob` in IDLE tasks
 * (`CanvasAsyncBlobCreator`): the encode starts only in an idle period of the
 * main thread, else when a 1 s start timeout fires; an encode that started but
 * could not finish in idle slices is forced 5.7 s after that (4 s and 9 s on
 * Android). Right for background work, wrong behind a button: whenever the
 * renderer is short of CPU — a phone, a busy machine, DevTools' 4× throttling —
 * idle periods stop arriving and the call takes 1.0 s or 6.7 s, a dead button
 * the whole time. Measured on the cover crop: 15 ms on an idle machine; under
 * load or 4× throttling ~1 040 ms for EVERY append and crop, and 6 720 ms for
 * some. (WebP is encoded on a worker thread and never waits, which is why the
 * thumbnail pipeline is unaffected.)
 *
 * `toDataURL` encodes synchronously: the same main-thread work Chromium falls
 * back to after its timeouts, without the wait — tens of ms for a page-sized
 * JPEG. Main thread only (an `OffscreenCanvas` is copied onto a document canvas
 * first, which needs a `document`).
 */

/** `canvas` as a data URL of `type` (the browser's PNG if it cannot write `type`). */
export function canvasDataUrlNow(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  type: string,
  quality?: number
): string {
  if (canvas.width <= 0 || canvas.height <= 0) {
    throw new Error(`cannot encode an empty canvas (${canvas.width}×${canvas.height})`);
  }
  let target: HTMLCanvasElement;
  if (typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement) {
    target = canvas;
  } else {
    target = document.createElement('canvas');
    target.width = canvas.width;
    target.height = canvas.height;
    const context = target.getContext('2d');
    if (!context) throw new Error('could not get a 2D context to encode on');
    context.drawImage(canvas, 0, 0);
  }
  const url = target.toDataURL(type, quality);
  // `data:,` is what a canvas the browser could not encode (e.g. too large) returns.
  if (!url.startsWith('data:image/')) throw new Error('the canvas could not be encoded');
  return url;
}

/** A base64 `data:` URL's bytes as a Blob of its own type. */
export function dataUrlToBlob(dataUrl: string): Blob {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match || !match[2]) throw new Error('not a base64 data URL');
  const binary = atob(match[3]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: match[1] });
}

/** `canvas` as a Blob of `type`, encoded now (see the module comment). */
export function canvasBlobNow(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  type: string,
  quality?: number
): Blob {
  return dataUrlToBlob(canvasDataUrlNow(canvas, type, quality));
}
