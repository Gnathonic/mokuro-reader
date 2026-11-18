import { afterEach, describe, expect, it, vi } from 'vitest';
import { canvasBlobNow, canvasDataUrlNow, dataUrlToBlob } from './canvas-encode';

// The first bytes of a JPEG (SOI + APP0 marker), as the browser would encode them.
const JPEG_BYTES = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
const JPEG_URL = `data:image/jpeg;base64,${btoa(String.fromCharCode(...JPEG_BYTES))}`;

function canvas(width: number, height: number) {
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  return element;
}

afterEach(() => vi.restoreAllMocks());

describe('canvasDataUrlNow', () => {
  it('encodes in the same call, with the type and quality asked for', () => {
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(JPEG_URL);
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob');

    expect(canvasDataUrlNow(canvas(30, 40), 'image/jpeg', 0.9)).toBe(JPEG_URL);
    expect(toDataURL).toHaveBeenCalledWith('image/jpeg', 0.9);
    // Never the idle-scheduled path.
    expect(toBlob).not.toHaveBeenCalled();
  });

  it('copies an OffscreenCanvas onto a document canvas of its size first', () => {
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage
    } as unknown as CanvasRenderingContext2D);
    let encoded: { width: number; height: number } | null = null;
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function (
      this: HTMLCanvasElement
    ) {
      encoded = { width: this.width, height: this.height };
      return JPEG_URL;
    });
    const offscreen = { width: 120, height: 80 } as OffscreenCanvas;

    expect(canvasDataUrlNow(offscreen, 'image/jpeg', 0.8)).toBe(JPEG_URL);
    expect(drawImage).toHaveBeenCalledWith(offscreen, 0, 0);
    expect(encoded).toEqual({ width: 120, height: 80 });
  });

  it('refuses an empty canvas instead of returning an empty image', () => {
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL');
    expect(() => canvasDataUrlNow(canvas(0, 40), 'image/jpeg')).toThrow(/empty canvas/);
    expect(toDataURL).not.toHaveBeenCalled();
  });

  it('fails when the browser could not encode (it answers `data:,`)', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:,');
    expect(() => canvasDataUrlNow(canvas(30, 40), 'image/jpeg')).toThrow(/could not be encoded/);
  });
});

describe('dataUrlToBlob', () => {
  it('decodes a base64 data URL to its bytes, typed as the URL says', async () => {
    const blob = dataUrlToBlob(JPEG_URL);
    expect(blob.type).toBe('image/jpeg');
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual(JPEG_BYTES);
  });

  it('refuses a URL that is not base64 data', () => {
    expect(() => dataUrlToBlob('data:,')).toThrow();
    expect(() => dataUrlToBlob('data:text/plain,hello')).toThrow();
    expect(() => dataUrlToBlob('blob:https://example.test/x')).toThrow();
  });
});

describe('canvasBlobNow', () => {
  it('is the canvas encoded now, as a Blob', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(JPEG_URL);
    const blob = canvasBlobNow(canvas(30, 40), 'image/jpeg', 0.9);
    expect(blob.type).toBe('image/jpeg');
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual(JPEG_BYTES);
  });
});
