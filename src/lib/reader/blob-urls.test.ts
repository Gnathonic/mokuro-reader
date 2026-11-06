import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireBlobUrl, blobForUrl, releaseBlobUrl, BLOB_URL_GRACE_MS } from './blob-urls';

describe('shared blob URLs', () => {
  let created = 0;
  const revoked: string[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    created = 0;
    revoked.length = 0;
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => `blob:${++created}`,
      revokeObjectURL: (u: string) => revoked.push(u)
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('hands every holder of one file the same URL', () => {
    const file = new File(['a'], 'a.png');
    const a = acquireBlobUrl(file);
    expect(acquireBlobUrl(file)).toBe(a);
    expect(created).toBe(1);
    releaseBlobUrl(file);
    releaseBlobUrl(file);
  });

  it('keeps the URL through a release-then-acquire remount', () => {
    const file = new File(['b'], 'b.png');
    const url = acquireBlobUrl(file);
    releaseBlobUrl(file); // the old reader unmounts…
    expect(acquireBlobUrl(file)).toBe(url); // …the new one mounts the same page
    vi.advanceTimersByTime(BLOB_URL_GRACE_MS * 2);
    expect(revoked).toEqual([]);
    releaseBlobUrl(file);
  });

  it('revokes a grace period after the last holder lets go', () => {
    const file = new File(['c'], 'c.png');
    const url = acquireBlobUrl(file);
    releaseBlobUrl(file);
    vi.advanceTimersByTime(BLOB_URL_GRACE_MS - 1);
    expect(revoked).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(revoked).toEqual([url]);
    // a later holder gets a fresh URL
    expect(acquireBlobUrl(file)).not.toBe(url);
    releaseBlobUrl(file);
  });

  it('maps a live URL back to its Blob until it is revoked', () => {
    const file = new File(['c'], 'c.png');
    const url = acquireBlobUrl(file);
    expect(blobForUrl(url)).toBe(file);
    expect(blobForUrl('blob:unknown')).toBeNull();
    releaseBlobUrl(file);
    expect(blobForUrl(url)).toBe(file); // still inside the grace period
    vi.advanceTimersByTime(BLOB_URL_GRACE_MS);
    expect(blobForUrl(url)).toBeNull();
  });

  // A page imported before the raster-only rule may be stored untyped, or
  // (never by this app, but by hand) as SVG/HTML. Its object URL must carry
  // a raster label, so "Open image in new tab" can never run it as a document.
  it('mints the URL from a raster-labelled view of a page that has no raster type', () => {
    const seen: Blob[] = [];
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: (blob: Blob) => {
        seen.push(blob);
        return `blob:${seen.length}`;
      },
      revokeObjectURL: () => {}
    });
    const untyped = new File(['<html><script>1</script>'], 'p001.jpg');
    const svg = new File(['<svg/>'], 'p002.png', { type: 'image/svg+xml' });
    const nameless = new Blob(['<html>'], { type: 'text/html' });
    const typed = new File(['x'], 'p003.webp', { type: 'image/webp' });
    acquireBlobUrl(untyped);
    acquireBlobUrl(svg);
    acquireBlobUrl(nameless);
    acquireBlobUrl(typed);
    expect(seen.map((b) => b.type)).toEqual(['image/jpeg', 'image/png', 'image/png', 'image/webp']);
    expect(seen[3]).toBe(typed); // already raster: the very same Blob
    // The page's identity is still the stored File.
    expect(blobForUrl('blob:1')).toBe(untyped);
    for (const b of [untyped, svg, nameless, typed]) releaseBlobUrl(b);
  });
});
