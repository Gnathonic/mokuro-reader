import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INK_COLOR_NAMES,
  INK_PALETTE,
  autoInkColor,
  inkColorFor,
  isMonochrome,
  cancelInkPrefetch,
  pageNeedsInk,
  peekPageInk,
  prefetchPageInk,
  sanitizeInkColor
} from './ink-color';

function imageData(pixels: [number, number, number, number][]): { data: Uint8ClampedArray } {
  return { data: new Uint8ClampedArray(pixels.flat()) };
}

function fill(n: number, px: [number, number, number, number]) {
  return Array.from({ length: n }, () => px);
}

describe('isMonochrome', () => {
  it('a grey ramp is monochrome', () => {
    const ramp = Array.from(
      { length: 256 },
      (_, v) => [v, v, v, 255] as [number, number, number, number]
    );
    expect(isMonochrome(imageData(ramp))).toBe(true);
  });

  it('tolerates channel noise up to the tolerance', () => {
    expect(isMonochrome(imageData(fill(100, [120, 128, 124, 255])))).toBe(true);
    expect(isMonochrome(imageData(fill(100, [120, 129, 124, 255])))).toBe(false);
  });

  it('allows up to 1% coloured pixels, not more', () => {
    const grey: [number, number, number, number] = [200, 200, 200, 255];
    const red: [number, number, number, number] = [200, 40, 40, 255];
    expect(isMonochrome(imageData([...fill(99, grey), ...fill(1, red)]))).toBe(true);
    expect(isMonochrome(imageData([...fill(98, grey), ...fill(2, red)]))).toBe(false);
  });

  it('ignores fully transparent pixels', () => {
    const grey: [number, number, number, number] = [10, 10, 10, 255];
    const clearRed: [number, number, number, number] = [255, 0, 0, 0];
    expect(isMonochrome(imageData([...fill(10, grey), ...fill(90, clearRed)]))).toBe(true);
  });

  it('takes a custom tolerance and threshold', () => {
    const px = imageData([...fill(95, [0, 0, 0, 255]), ...fill(5, [0, 20, 0, 255])]);
    expect(isMonochrome(px)).toBe(false);
    expect(isMonochrome(px, 8, 0.05)).toBe(true);
    expect(isMonochrome(px, 20)).toBe(true);
  });

  it('works on a real ImageData-shaped buffer (100×100 RGBA)', () => {
    const data = new Uint8ClampedArray(100 * 100 * 4);
    for (let i = 0; i < data.length; i += 4) data.set([30, 30, 30, 255], i);
    expect(isMonochrome({ data })).toBe(true);
    for (let i = 0; i < 4 * 200; i += 4) data.set([0, 0, 255, 255], i); // 2% blue
    expect(isMonochrome({ data })).toBe(false);
  });
});

describe('autoInkColor', () => {
  const uuid = 'a1b2c3d4-0000-4000-8000-000000000000';
  const sum = [...uuid].reduce((s, c) => s + c.charCodeAt(0), 0);

  it('is the char-code sum of the volume uuid, mod 7, on the first 32 pages', () => {
    const expected = INK_COLOR_NAMES[sum % 7];
    expect(autoInkColor(uuid, 0)).toBe(expected);
    expect(autoInkColor(uuid, 31)).toBe(expected);
  });

  it('moves to the next colour every 32 pages, wrapping', () => {
    expect(autoInkColor(uuid, 32)).toBe(INK_COLOR_NAMES[(sum + 1) % 7]);
    expect(autoInkColor(uuid, 63)).toBe(INK_COLOR_NAMES[(sum + 1) % 7]);
    expect(autoInkColor(uuid, 64)).toBe(INK_COLOR_NAMES[(sum + 2) % 7]);
    expect(autoInkColor(uuid, 32 * 7)).toBe(INK_COLOR_NAMES[sum % 7]);
  });

  it('gives different volumes different colours', () => {
    const colors = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((u) => autoInkColor(u, 0)));
    expect(colors.size).toBe(7);
  });

  it('treats a missing or bad page index as page 0', () => {
    expect(autoInkColor(uuid, NaN)).toBe(autoInkColor(uuid, 0));
    expect(autoInkColor(uuid, -5)).toBe(autoInkColor(uuid, 0));
  });
});

describe('inkColorFor', () => {
  it('is null when off', () => {
    expect(inkColorFor('off', 'x', 3)).toBeNull();
  });

  it('is the fixed colour on every page', () => {
    expect(inkColorFor('blue', 'x', 0)).toBe('blue');
    expect(inkColorFor('blue', 'y', 500)).toBe('blue');
  });

  it('is the auto colour in auto', () => {
    expect(inkColorFor('auto', 'vol', 40)).toBe(autoInkColor('vol', 40));
    expect(inkColorFor('auto', 'vol', undefined)).toBe(autoInkColor('vol', 0));
  });
});

describe('sanitizeInkColor', () => {
  it('keeps every valid value', () => {
    for (const v of ['off', 'auto', ...INK_COLOR_NAMES]) expect(sanitizeInkColor(v)).toBe(v);
  });

  it('turns anything else off', () => {
    for (const v of [undefined, null, 'purple', 'AUTO', 3, {}])
      expect(sanitizeInkColor(v)).toBe('off');
  });
});

describe('INK_PALETTE', () => {
  it('carries the userscript’s rotations and text colours', () => {
    const script: Record<string, [number, string]> = {
      red: [320, '#bf534c'],
      orange: [350, '#9b5b20'],
      yellow: [15, '#806c19'],
      green: [50, '#497c19'],
      blue: [190, '#4c6ac0'],
      violet: [230, '#8a57bf'],
      pink: [290, '#c44d78']
    };
    for (const name of INK_COLOR_NAMES) {
      expect([INK_PALETTE[name].rotation, INK_PALETTE[name].text]).toEqual(script[name]);
      expect(INK_PALETTE[name].ink).toMatch(/^#[0-9a-f]{6}$/);
      expect(INK_PALETTE[name].paper).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('pageNeedsInk', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubDecode(pixel: [number, number, number, number] | Error) {
    const createImageBitmap = vi.fn(async () => {
      if (pixel instanceof Error) throw pixel;
      return { close: vi.fn() };
    });
    const ctx = {
      drawImage: vi.fn(),
      getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => {
        const data = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < data.length; i += 4) data.set(pixel as number[], i);
        return { data };
      })
    };
    class FakeOffscreenCanvas {
      constructor(
        public width: number,
        public height: number
      ) {}
      getContext() {
        return ctx;
      }
    }
    vi.stubGlobal('createImageBitmap', createImageBitmap);
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    return { createImageBitmap, ctx };
  }

  it('samples a 100×100 downscale and says yes for a grey page', async () => {
    const { createImageBitmap, ctx } = stubDecode([128, 128, 128, 255]);
    await expect(pageNeedsInk(new Blob(['grey']))).resolves.toBe(true);
    expect(createImageBitmap).toHaveBeenCalledWith(expect.any(Blob), {
      resizeWidth: 100,
      resizeHeight: 100,
      resizeQuality: 'low'
    });
    expect(ctx.getImageData).toHaveBeenCalledWith(0, 0, 100, 100);
  });

  it('says no for a colour page', async () => {
    stubDecode([200, 30, 30, 255]);
    await expect(pageNeedsInk(new Blob(['red']))).resolves.toBe(false);
  });

  it('samples each image once', async () => {
    const { createImageBitmap } = stubDecode([0, 0, 0, 255]);
    const blob = new Blob(['once']);
    const [a, b] = await Promise.all([pageNeedsInk(blob), pageNeedsInk(blob)]);
    expect(await pageNeedsInk(blob)).toBe(true);
    expect([a, b]).toEqual([true, true]);
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
  });

  it('exposes a settled verdict synchronously, and nothing before it settles', async () => {
    stubDecode([0, 0, 0, 255]);
    const blob = new Blob(['peek']);
    expect(peekPageInk(blob)).toBeUndefined();
    const pending = pageNeedsInk(blob);
    expect(peekPageInk(blob)).toBeUndefined();
    await pending;
    expect(peekPageInk(blob)).toBe(true);
  });

  it('leaves a page it cannot decode uncoloured', async () => {
    stubDecode(new Error('decode failed'));
    await expect(pageNeedsInk(new Blob(['broken']))).resolves.toBe(false);
  });
});

describe('prefetchPageInk', () => {
  let started: Blob[];
  let finish: Map<Blob, () => void>;

  beforeEach(() => {
    started = [];
    finish = new Map();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(
        (blob: Blob) =>
          new Promise((resolve) => {
            started.push(blob);
            finish.set(blob, () => resolve({ close: vi.fn() }));
          })
      )
    );
    class FakeOffscreenCanvas {
      getContext() {
        return {
          drawImage: vi.fn(),
          getImageData: () => ({ data: new Uint8ClampedArray([9, 9, 9, 255]) })
        };
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
  });

  afterEach(() => {
    cancelInkPrefetch();
    for (const done of finish.values()) done();
    vi.unstubAllGlobals();
  });

  const flush = () => new Promise((r) => setTimeout(r, 0));
  const pages = (n: number) => Array.from({ length: n }, (_, i) => new Blob([`p${i}`]));

  it('samples the current page first, then nearest pages, two at a time', async () => {
    const files = pages(20);
    prefetchPageInk(files, 10, 3, 2);
    expect(started).toEqual([files[10], files[11]]);
    finish.get(files[10])!();
    await flush();
    expect(started).toEqual([files[10], files[11], files[9]]);
    for (let k = 0; k < 6; k++) {
      for (const b of [...started]) finish.get(b)!();
      await flush();
    }
    // 10, then 11, 9, 12, 8, 13 — ahead 3, behind 2
    expect(started).toEqual([10, 11, 9, 12, 8, 13].map((i) => files[i]));
    expect(peekPageInk(files[13])).toBe(true);
  });

  it('a new centre replaces the queue; running samples finish', async () => {
    const files = pages(40);
    prefetchPageInk(files, 0, 8, 0);
    expect(started).toEqual([files[0], files[1]]);
    prefetchPageInk(files, 30, 1, 0);
    for (let k = 0; k < 4; k++) {
      for (const b of [...started]) finish.get(b)!();
      await flush();
    }
    expect(started).toEqual([files[0], files[1], files[30], files[31]]);
  });

  it('skips pages already sampled or missing, and cancel drops the queue', async () => {
    const files: (Blob | undefined)[] = pages(6);
    files[2] = undefined;
    const done = pageNeedsInk(files[0]!);
    finish.get(files[0]!)!();
    await done;
    started = [];
    prefetchPageInk(files, 0, 5, 0);
    expect(started).toEqual([files[1], files[3]]);
    cancelInkPrefetch();
    for (const b of [...started]) finish.get(b)!();
    await flush();
    expect(started).toEqual([files[1], files[3]]);
  });
});
