import { describe, it, expect } from 'vitest';
import { COVER_VIEWPORT_ROOT_MARGIN } from '$lib/catalog/cover-viewport';
import {
  installIntersectionObserverStub,
  IntersectionObserverStub
} from '$lib/catalog/__tests__/intersection-observer-stub';

/**
 * THE STUB IS TEST INFRASTRUCTURE, so its own defects are invisible: they do not
 * fail a suite, they quietly change what a suite is asserting about. These pin
 * the properties every cover suite leans on.
 */

/** Observe through whatever class is installed globally right now. */
function observeThrough(rootMargin: string): { entries: boolean[]; target: Element } {
  const entries: boolean[] = [];
  const target = document.createElement('div');
  const Installed = (globalThis as { IntersectionObserver?: unknown })
    .IntersectionObserver as typeof IntersectionObserverStub;
  const observer = new Installed(
    (records) => {
      for (const record of records) entries.push(record.isIntersecting);
    },
    { rootMargin, threshold: 0 }
  );
  observer.observe(target);
  return { entries, target };
}

describe('the cover-gate ledger belongs to the install that opened it', () => {
  it('is empty after restore(), and stops collecting for whatever runs next', () => {
    const observer = installIntersectionObserverStub({ autoIntersect: false });
    observeThrough(COVER_VIEWPORT_ROOT_MARGIN);
    expect(observer.gates).toHaveLength(1);

    observer.restore();

    // Handed back empty: nothing this install collected outlives it.
    expect(observer.gates).toHaveLength(0);

    // And the module-level ledger has moved on, so the several suites that assign the
    // bare class instead of calling `install` cannot push into it. Without this, a
    // `toHaveLength(n)` in one of those reads two suites' observations at once.
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
      IntersectionObserverStub;
    observeThrough(COVER_VIEWPORT_ROOT_MARGIN);
    expect(observer.gates).toHaveLength(0);
  });
});

describe('canvasVisible', () => {
  it('leaves the 200px canvas observers inert by default and opens them on request', () => {
    const inert = installIntersectionObserverStub();
    try {
      expect(observeThrough('200px').entries).toEqual([]);
    } finally {
      inert.restore();
    }

    const visible = installIntersectionObserverStub({ canvasVisible: true });
    try {
      expect(observeThrough('200px').entries).toEqual([true]);
      // The two axes are independent: a canvas told to paint is not a cover gate, so it
      // never lands in the ledger the gating tests drive.
      expect(visible.gates).toHaveLength(0);
    } finally {
      visible.restore();
    }
  });

  it('is restored along with the rest of the install, not left switched on', () => {
    const outer = installIntersectionObserverStub();
    const inner = installIntersectionObserverStub({ canvasVisible: true });
    inner.restore();

    expect(observeThrough('200px').entries).toEqual([]);
    outer.restore();
  });
});

describe('the cover gate is what autoIntersect drives', () => {
  it('holds the gate shut until the test emits, and reports the observed target', () => {
    const observer = installIntersectionObserverStub({ autoIntersect: false });
    try {
      const { entries, target } = observeThrough(COVER_VIEWPORT_ROOT_MARGIN);
      expect(entries).toEqual([]);
      expect(observer.gates).toHaveLength(1);
      expect(observer.gates[0].target).toBe(target);

      observer.gates[0].emit(true);
      expect(entries).toEqual([true]);
    } finally {
      observer.restore();
    }
  });
});
