import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from '$lib/types';
import { ImageCache } from './image-cache';
import { BLOB_URL_GRACE_MS } from './blob-urls';

const page = (img_path: string, text = ''): Page =>
  ({
    version: '0.2.1',
    img_width: 10,
    img_height: 10,
    img_path,
    blocks: text ? [{ lines: [text] }] : []
  }) as unknown as Page;

const filesFor = (names: string[]) =>
  Object.fromEntries(names.map((n) => [n, new File([n], n, { type: 'image/png' })]));

describe('ImageCache.updateCache', () => {
  let created = 0;
  let revoked = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    created = 0;
    revoked = 0;
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => `blob:${++created}`,
      revokeObjectURL: () => {
        revoked++;
      }
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const names = ['1.png', '2.png', '3.png', '4.png'];

  it('keeps every cached image when only the pages change (an OCR layer swap)', () => {
    const cache = new ImageCache();
    const files = filesFor(names);
    cache.updateCache(
      files,
      names.map((n) => page(n)),
      0
    );
    const first = created;
    expect(first).toBeGreaterThan(0);

    cache.updateCache(
      files,
      names.map((n) => page(n, 'other layer')),
      0
    );
    expect(created).toBe(first);
    expect(revoked).toBe(0);
  });

  it('reloads the images whose files changed', () => {
    const cache = new ImageCache();
    const files = filesFor(names);
    cache.updateCache(
      files,
      names.map((n) => page(n)),
      0
    );
    const first = created;

    cache.updateCache(
      filesFor(names),
      names.map((n) => page(n)),
      0
    );
    vi.advanceTimersByTime(BLOB_URL_GRACE_MS);
    expect(revoked).toBe(first);
    expect(created).toBe(first * 2);
  });
});
