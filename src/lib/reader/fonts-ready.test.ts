import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

describe('fontsReady', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function setup() {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    let reads = 0;
    const target = new EventTarget();
    // A real getter: Object.assign would call it once and copy the value.
    Object.defineProperty(target, 'ready', {
      get() {
        reads++;
        return Promise.resolve();
      }
    });
    Object.defineProperty(document, 'fonts', { configurable: true, value: target });
    const mod = await import('./fonts-ready');
    return { ...mod, frames, reads: () => reads, fonts: target };
  }

  it('reads the getter once for every caller in the same frame', async () => {
    const { fontsReady, reads } = await setup();
    const all = Array.from({ length: 1000 }, () => fontsReady());
    await Promise.all(all);
    expect(reads()).toBe(1);
  });

  it('reads it again after a frame, so a later mount sees a fresh promise', async () => {
    const { fontsReady, frames, reads } = await setup();
    await fontsReady();
    frames.shift()!(0);
    await fontsReady();
    expect(reads()).toBe(2);
  });

  it('waits for the web font faces to be registered before reading it', async () => {
    let finish!: () => void;
    vi.doMock('$lib/util/web-fonts', () => ({
      webFontsRegistered: () => new Promise<void>((r) => (finish = r))
    }));
    const { fontsReady, reads } = await setup();
    const done = fontsReady();
    await Promise.resolve();
    expect(reads()).toBe(0);
    finish();
    await done;
    expect(reads()).toBe(1);
    vi.doUnmock('$lib/util/web-fonts');
  });

  it('bumps the font load epoch on every loadingdone', async () => {
    const { fontLoadEpoch, currentFontLoadEpoch, fonts } = await setup();
    const seen: number[] = [];
    const stop = fontLoadEpoch.subscribe((e) => seen.push(e));
    fonts.dispatchEvent(new Event('loadingdone'));
    fonts.dispatchEvent(new Event('loadingdone'));
    expect(seen).toEqual([0, 1, 2]);
    expect(currentFontLoadEpoch()).toBe(2);
    expect(get(fontLoadEpoch)).toBe(2);
    stop();
  });
});

describe('getDefaultMeasurer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('starts its memo over once fonts finish loading', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: (t: string) => ({ width: t.length * 100 })
    } as unknown as CanvasRenderingContext2D);
    const target = new EventTarget();
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: Object.assign(target, { ready: Promise.resolve() })
    });
    const { fontLoadEpoch } = await import('./fonts-ready');
    const { getDefaultMeasurer } = await import('./line-coords-layout');
    const stop = fontLoadEpoch.subscribe(() => {});
    const before = getDefaultMeasurer();
    expect(getDefaultMeasurer()).toBe(before);
    target.dispatchEvent(new Event('loadingdone'));
    expect(getDefaultMeasurer()).not.toBe(before);
    stop();
  });
});
