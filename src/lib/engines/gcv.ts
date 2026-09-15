/**
 * Google Cloud Vision client: image prep (downscale past 4 MP — accuracy does
 * not improve beyond that and the payload shrinks), the annotate request, and
 * the cheapest possible key probe. Converting the reply is `gcv-convert.ts`.
 */
import { RetryableError, isRetryableStatus } from './run-queue';
import type { GcvAnnotateResponse } from './gcv-convert';

export const VISION_ENDPOINT = 'https://vision.googleapis.com/v1/images:annotate';
export const VISION_MAX_PIXELS = 4_000_000;

/** 1×1 transparent PNG — one billable unit, inside the free monthly 1000. */
const PROBE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

export interface DecodedImage {
  width: number;
  height: number;
  draw: (width: number, height: number) => Promise<Blob>;
}

async function decodeWithCanvas(file: Blob): Promise<DecodedImage> {
  const bitmap = await createImageBitmap(file);
  return {
    width: bitmap.width,
    height: bitmap.height,
    draw: async (width, height) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
      return new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob failed'))),
          'image/jpeg',
          0.92
        )
      );
    }
  };
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Base64 of the image, downscaled to at most `maxPixels`; `scale` = sent / original. */
export async function prepareImage(
  file: Blob,
  maxPixels = VISION_MAX_PIXELS,
  decode: (file: Blob) => Promise<DecodedImage> = decodeWithCanvas
): Promise<{ base64: string; scale: number }> {
  const img = await decode(file);
  const pixels = img.width * img.height;
  if (pixels <= maxPixels) return { base64: await toBase64(file), scale: 1 };
  const scale = Math.sqrt(maxPixels / pixels);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const blob = await img.draw(w, h);
  return { base64: await toBase64(blob), scale: w / img.width };
}

export async function annotateImage(
  base64: string,
  key: string,
  opts: { fetch?: typeof fetch; signal?: AbortSignal } = {}
): Promise<GcvAnnotateResponse> {
  const f = opts.fetch ?? fetch;
  const res = await f(`${VISION_ENDPOINT}?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: opts.signal,
    body: JSON.stringify({
      requests: [
        {
          image: { content: base64 },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
          imageContext: { languageHints: ['ja'] }
        }
      ]
    })
  });
  const json = (await res.json().catch(() => ({}))) as GcvAnnotateResponse & {
    error?: { message?: string };
  };
  if (!res.ok) {
    const message = json.error?.message ?? `Cloud Vision request failed (${res.status})`;
    if (isRetryableStatus(res.status)) throw new RetryableError(message, res.status);
    throw new Error(message);
  }
  const inner = json.responses?.[0]?.error;
  if (inner?.message) throw new Error(inner.message);
  return json;
}

export async function testGoogleVision(
  key: string,
  fetchImpl?: typeof fetch
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await annotateImage(PROBE_PNG, key, { fetch: fetchImpl });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
