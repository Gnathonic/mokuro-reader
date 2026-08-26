import { COVER_VIEWPORT_ROOT_MARGIN } from '$lib/catalog/cover-viewport';

/**
 * The jsdom stand-in for `IntersectionObserver`, shared by every suite that
 * renders a cover-drawing surface.
 *
 * TWO KINDS OF OBSERVER LIVE ON THESE COMPONENTS and they want opposite
 * answers in jsdom:
 *
 * - `CompositeCanvas`/`ThumbnailCanvas` observe with `rootMargin: '200px'` to
 *   decide whether to PAINT. Every suite here wants that to stay off — jsdom
 *   has no 2D context worth painting into — which is why they all installed a
 *   no-op observer class of their own (nine identical copies before this file).
 * - `cover-claims.svelte.ts` observes with {@link COVER_VIEWPORT_ROOT_MARGIN}
 *   to decide whether to ASK for a cover. A no-op observer answers "never
 *   visible", which would silently turn every `requestCover` assertion in the
 *   repo into a vacuous one.
 *
 * So this stub discriminates on `rootMargin`: the canvas observers stay inert,
 * the cover gate reports visible. `autoIntersect: false` (see
 * {@link installIntersectionObserverStub}) holds the cover gate closed instead
 * and hands the test the observed targets, which is how the gating suites
 * drive a card in and out of view on purpose. `canvasVisible: true` is the
 * other axis: the two `*.covers.test.ts` suites DO stub a 2D context and assert
 * on what reached it, so for them the canvas observers have to answer visible
 * as well.
 */

/** One cover-gate observation a test can drive by hand. */
export interface ObservedCoverGate {
  target: Element;
  /** Deliver an intersection record for this target, as the browser would. */
  emit(isIntersecting: boolean): void;
}

let autoIntersect = true;
let canvasVisible = false;
let observedGates: ObservedCoverGate[] = [];

type Callback = (entries: IntersectionObserverEntry[], observer: unknown) => void;

export class IntersectionObserverStub {
  private readonly callback: Callback;
  private readonly isCoverGate: boolean;

  constructor(callback: Callback, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.isCoverGate = options?.rootMargin === COVER_VIEWPORT_ROOT_MARGIN;
  }

  observe(target: Element): void {
    const emit = (isIntersecting: boolean) => {
      this.callback(
        [
          {
            target,
            isIntersecting,
            intersectionRatio: isIntersecting ? 1 : 0
          } as unknown as IntersectionObserverEntry
        ],
        this
      );
    };
    if (!this.isCoverGate) {
      // A canvas visibility observer. Inert by default (jsdom has no 2D context worth
      // painting into); the suites that DO stub one pass `canvasVisible: true`.
      if (canvasVisible) emit(true);
      return;
    }
    observedGates.push({ target, emit });
    if (autoIntersect) emit(true);
  }

  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

/**
 * Install {@link IntersectionObserverStub} globally and hand back the live list
 * of cover-gate observations plus a `restore()` for `afterEach`.
 *
 * `autoIntersect` defaults to true so a suite that only needs "the surface is
 * on screen" behaves exactly as it did before the gate existed. Pass `false`
 * to keep every gate shut until the test emits for it.
 *
 * `canvasVisible` defaults to false — the canvas observers stay inert, which is
 * what all but the two `*.covers.test.ts` suites want. Pass `true` when the
 * suite has stubbed `getContext` and is asserting on what the canvas was handed.
 */
export function installIntersectionObserverStub(
  options: { autoIntersect?: boolean; canvasVisible?: boolean } = {}
): {
  gates: ObservedCoverGate[];
  restore(): void;
} {
  const previousAuto = autoIntersect;
  const previousCanvas = canvasVisible;
  const previousIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  autoIntersect = options.autoIntersect ?? true;
  canvasVisible = options.canvasVisible ?? false;
  observedGates = [];
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
    IntersectionObserverStub;

  const gates = observedGates;
  return {
    gates,
    restore() {
      autoIntersect = previousAuto;
      canvasVisible = previousCanvas;
      // The gate ledger is part of what an install owns, so a restore has to give it
      // back too. `observedGates` is MODULE-level and only ever reset by `install`, so
      // without both lines below a suite that assigns the bare class afterwards keeps
      // pushing into THIS `gates` array — and a later `toHaveLength(n)` reads a mixture
      // of two suites' observations and passes or fails for the wrong reason.
      gates.length = 0;
      observedGates = [];
      (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = previousIO;
    }
  };
}
