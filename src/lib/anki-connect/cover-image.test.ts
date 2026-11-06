import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));

import { coverImageDataUrl } from './index';

// The test setup swaps in Node's Blob/File, which jsdom's FileReader refuses.
class NodeFileReader {
  result: string | null = null;
  onloadend: (() => void) | null = null;
  readAsDataURL(blob: Blob) {
    void blob.arrayBuffer().then((buf) => {
      this.result = `data:${blob.type};base64,${btoa(String.fromCharCode(...new Uint8Array(buf)))}`;
      this.onloadend?.();
    });
  }
}
vi.stubGlobal('FileReader', NodeFileReader);

/**
 * The `{cover}` field sends the volume's stored thumbnail to Anki. A thumbnail
 * stored as `image/svg+xml` before the raster-only rule (and not yet repaired
 * by `processThumbnails`) is never sent.
 */
describe('coverImageDataUrl', () => {
  it('sends a raster thumbnail as a data URL', async () => {
    const thumb = new File([new Uint8Array([0xff, 0xd8, 0xff])], 't.jpg', { type: 'image/jpeg' });
    expect(await coverImageDataUrl(thumb)).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('sends nothing for an SVG or HTML thumbnail', async () => {
    for (const type of ['image/svg+xml', 'text/html']) {
      const thumb = new File(['<svg onload="x()"/>'], 't', { type });
      expect(await coverImageDataUrl(thumb), type).toBeNull();
    }
  });

  // Earlier builds stored archive thumbnail sidecars untyped; until
  // `processThumbnails` re-types them they still go to Anki, raster-labelled.
  it('sends an untyped thumbnail under a raster label', async () => {
    const thumb = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'Vol 1.jpg');
    expect(await coverImageDataUrl(thumb)).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('sends nothing without a thumbnail', async () => {
    expect(await coverImageDataUrl(undefined)).toBeNull();
    expect(await coverImageDataUrl(null)).toBeNull();
  });
});
