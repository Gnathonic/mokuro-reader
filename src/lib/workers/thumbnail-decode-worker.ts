/**
 * Web Worker for off-main-thread thumbnail decoding
 * Receives File objects, returns ImageBitmaps via Transferable
 */

import { forwardWorkerCspViolations } from '$lib/security/csp-violations';

// A violation here fires on this worker, where the page's buffer cannot see it.
forwardWorkerCspViolations();

export interface DecodeRequest {
  id: number;
  file: File;
}

export interface DecodeResponse {
  id: number;
  bitmap?: ImageBitmap;
  error?: string;
}

self.onmessage = async (event: MessageEvent<DecodeRequest>) => {
  const { id, file } = event.data;

  try {
    const bitmap = await createImageBitmap(file);

    // Transfer the bitmap back (zero-copy)
    self.postMessage({ id, bitmap } satisfies DecodeResponse, { transfer: [bitmap] });
  } catch (err) {
    self.postMessage({
      id,
      error: err instanceof Error ? err.message : 'Failed to decode image'
    } satisfies DecodeResponse);
  }
};
