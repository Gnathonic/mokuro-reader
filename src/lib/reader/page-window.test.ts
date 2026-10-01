import { afterEach, describe, expect, it, vi } from 'vitest';
import { PageWindow, seedPageWindow } from './page-window';

type Callback = (entries: Partial<IntersectionObserverEntry>[]) => void;

function stubObserver() {
  const created: { cb: Callback; options: IntersectionObserverInit; observed: Element[] }[] = [];
  class FakeObserver {
    observed: Element[] = [];
    constructor(cb: Callback, options: IntersectionObserverInit) {
      created.push({ cb, options, observed: this.observed });
    }
    observe(el: Element) {
      this.observed.push(el);
    }
    disconnect() {
      this.observed.length = 0;
    }
  }
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  return created;
}

describe('seedPageWindow', () => {
  it('covers the page and its neighbours, clamped to the volume', () => {
    expect([...seedPageWindow(0, 10)]).toEqual([0, 1, 2]);
    expect([...seedPageWindow(5, 10)]).toEqual([3, 4, 5, 6, 7]);
    expect([...seedPageWindow(9, 10)]).toEqual([7, 8, 9]);
  });
});

describe('PageWindow', () => {
  afterEach(() => vi.unstubAllGlobals());

  const els = () => Array.from({ length: 5 }, () => document.createElement('div'));

  it('observes every page against the scroll root with a strip-axis margin', () => {
    const created = stubObserver();
    const root = document.createElement('div');
    const pages = els();
    new PageWindow({ axis: 'y', onChange: () => {} }).attach(root, pages);
    expect(created[0].options.root).toBe(root);
    expect(created[0].options.rootMargin).toBe('200% 0px');
    expect(created[0].observed).toEqual(pages);

    new PageWindow({ axis: 'x', marginViewports: 1, onChange: () => {} }).attach(root, pages);
    expect(created[1].options.rootMargin).toBe('0px 100%');
  });

  it('drops a page at once and adds one after it has stayed near', () => {
    vi.useFakeTimers();
    const created = stubObserver();
    const pages = els();
    const seen: number[][] = [];
    const w = new PageWindow({ axis: 'y', onChange: (s) => seen.push([...s].sort()) }, [0, 1]);
    w.attach(document.createElement('div'), pages);
    created[0].cb([
      { target: pages[0], isIntersecting: false },
      { target: pages[2], isIntersecting: true },
      { target: pages[3], isIntersecting: true }
    ]);
    expect(seen).toEqual([[1]]);
    vi.advanceTimersByTime(100);
    expect(seen.at(-1)).toEqual([1, 2, 3]);
    // nothing changed → no emission
    const count = seen.length;
    created[0].cb([{ target: pages[2], isIntersecting: true }]);
    vi.advanceTimersByTime(100);
    expect(seen).toHaveLength(count);
    vi.useRealTimers();
  });

  it('never mounts a page that only flew past (an animated jump)', () => {
    vi.useFakeTimers();
    const created = stubObserver();
    const pages = els();
    const seen: number[][] = [];
    const w = new PageWindow({ axis: 'y', onChange: (s) => seen.push([...s].sort()) }, [0]);
    w.attach(document.createElement('div'), pages);
    for (const i of [1, 2, 3]) {
      created[0].cb([{ target: pages[i], isIntersecting: true }]);
      vi.advanceTimersByTime(10);
      created[0].cb([{ target: pages[i], isIntersecting: false }]);
    }
    created[0].cb([{ target: pages[4], isIntersecting: true }]);
    vi.advanceTimersByTime(100);
    expect(seen.flat()).not.toContain(1);
    expect(seen.flat()).not.toContain(2);
    expect(seen.flat()).not.toContain(3);
    expect(seen.at(-1)).toEqual([0, 4]);
    w.detach();
    vi.useRealTimers();
  });

  it('mounts every page when there is no IntersectionObserver', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const seen: number[][] = [];
    new PageWindow({ axis: 'y', onChange: (s) => seen.push([...s]) }).attach(
      document.createElement('div'),
      els()
    );
    expect(seen).toEqual([[0, 1, 2, 3, 4]]);
  });
});
