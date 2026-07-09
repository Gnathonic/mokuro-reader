import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PagedCamera } from './paged-camera';
import { baseTransform } from './paged-zoom-layout';
import { setInstantAnimations } from './animator';

const viewport = { width: 1600, height: 900 };

function makeWrapper() {
  return { style: { transform: '', transformOrigin: '' } } as unknown as HTMLElement;
}

function makeCamera(opts?: { clamp?: boolean; dpr?: number }) {
  const wrapper = makeWrapper();
  const camera = new PagedCamera({
    getWrapper: () => wrapper,
    getViewport: () => viewport,
    isClampingEnabled: () => opts?.clamp ?? true,
    getDevicePixelRatio: () => opts?.dpr ?? 1
  });
  return { camera, wrapper };
}

/**
 * Deterministic rAF pump for the pan Animators and the kinetic glide. Uses an
 * id→callback map so cancelAnimationFrame actually removes a pending frame —
 * the kinetic tracker cancels its poll loop on release, and a no-op caf would
 * let the stale loop keep stamping the shared timestamp and freeze the glide.
 */
let rafMap = new Map<number, FrameRequestCallback>();
let rafSeq = 0;
let clock = 0;

function pump(frames = 80, dt = 16.67) {
  for (let i = 0; i < frames && rafMap.size > 0; i++) {
    clock += dt;
    const batch = [...rafMap];
    rafMap.clear();
    for (const [, cb] of batch) cb(clock);
  }
}

beforeEach(() => {
  rafMap = new Map();
  rafSeq = 0;
  clock = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = ++rafSeq;
    rafMap.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafMap.delete(id);
  });
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const tall = { width: 700, height: 1000 };

describe('PagedCamera — base application', () => {
  it('places content at the base transform and renders it', () => {
    const { camera, wrapper } = makeCamera();
    camera.applyBase(tall, baseTransform('zoomFitToScreen', tall, viewport, true));

    expect(camera.translate.x).toBeCloseTo((1600 - 630) / 2, 4);
    expect(camera.translate.y).toBeCloseTo(0, 4);
    expect(camera.effectiveScale).toBeCloseTo(0.9, 6);
    expect(wrapper.style.transformOrigin).toBe('0 0');
    expect(wrapper.style.transform).toContain('scale(0.9)');
  });

  it('keeps the user zoom and re-places at the alignment when asked', () => {
    const { camera } = makeCamera();
    camera.applyBase(tall, baseTransform('keepZoom', tall, viewport, true));
    camera.setUserZoom(2);
    // At 2x the 1260px width still fits the 1600 viewport — fitting axes
    // center (the old end-aligned lock welded the page to the right edge).
    expect(camera.translate.x).toBeCloseTo((1600 - 700 * 0.9 * 2) / 2, 4);
    expect(camera.effectiveScale).toBeCloseTo(1.8, 6);
  });
});

describe('PagedCamera — clamping invariant', () => {
  it('clamps on scale-only writes (zooming out at an edge shrinks the bounds)', () => {
    const { camera } = makeCamera();
    camera.applyBase(tall, baseTransform('zoomFitToScreen', tall, viewport, true));
    camera.setUserZoom(3); // 1890x2700, overflows both axes
    camera.adjustView(2000, 3000); // pan past the bottom-right corner — clamps at the edges
    const atEdgeY = camera.translate.y;
    expect(atEdgeY).toBeCloseTo(900 - 2700, 1);

    camera.setUserZoom(1.5); // shrink: old translate now far out of bounds
    expect(camera.translate.y).toBeGreaterThanOrEqual(900 - 1000 * 0.9 * 1.5);
    expect(camera.translate.x).toBeCloseTo((1600 - 700 * 0.9 * 1.5) / 2, 4); // fitting axis re-locks
  });

  it('passes corrections through unclamped when clamping is disabled', () => {
    const { camera } = makeCamera({ clamp: false });
    camera.applyBase(tall, baseTransform('zoomFitToScreen', tall, viewport, true));
    camera.adjustView(-5000, -5000); // free pan mode: way out of bounds is allowed
    expect(camera.translate.x).toBeCloseTo((1600 - 630) / 2 + 5000, 4);
    expect(camera.translate.y).toBeCloseTo(5000, 4);
  });

  it('clamps corrections at the content edges when enabled', () => {
    const { camera } = makeCamera();
    camera.applyBase(tall, baseTransform('zoomFitToScreen', tall, viewport, true));
    camera.setUserZoom(2); // 1260x1800: x fits (locks center), y overflows
    camera.adjustView(500, -4000);
    expect(camera.translate.x).toBeCloseTo((1600 - 1260) / 2, 4);
    expect(camera.translate.y).toBe(0); // clamped at the top edge
  });
});

describe('PagedCamera — panning', () => {
  it('smooth pan eases to a clamped target', () => {
    const { camera } = makeCamera();
    camera.applyBase(tall, baseTransform('zoomFitToScreen', tall, viewport, true));
    camera.setUserZoom(2);

    camera.panBy(0, -2000); // scroll down further than the range allows
    pump();
    expect(camera.translate.y).toBeCloseTo(900 - 1800, 1); // clamped end
  });

  it('rounds the settled translate to device pixels (compositor seam, #65)', () => {
    const { camera } = makeCamera({ dpr: 2 });
    camera.applyBase(tall, baseTransform('zoomFitToScreen', tall, viewport, true));
    camera.setUserZoom(2);
    camera.adjustView(333.337, 333.331);
    camera.settle();
    expect(camera.translate.y * 2).toBeCloseTo(Math.round(camera.translate.y * 2), 6);
  });

  it('reports edge state for swipe-to-flip gating', () => {
    const { camera } = makeCamera();
    camera.applyBase(tall, baseTransform('zoomFitToScreen', tall, viewport, true));
    expect(camera.edgeState()).toEqual({ canRevealLeft: false, canRevealRight: false });

    camera.setUserZoom(3); // 1890 wide
    camera.adjustView(-10000, 0); // fully right (x -> 0)
    const s = camera.edgeState();
    expect(s.canRevealLeft).toBe(false);
    expect(s.canRevealRight).toBe(true);
  });
});

describe('PagedCamera — ZoomSurface', () => {
  it('implements the controller surface over user zoom', () => {
    const { camera, wrapper } = makeCamera();
    camera.applyBase(tall, baseTransform('zoomFitToScreen', tall, viewport, true));
    const surface = camera.surface();

    expect(surface.isReady()).toBe(true);
    surface.applyZoomLayout(2);
    expect(camera.effectiveScale).toBeCloseTo(1.8, 6);
    surface.correctView(100, 200);
    expect(wrapper.style.transform).toContain('scale(1.8');
  });

  it('is not ready before content is set', () => {
    const { camera } = makeCamera();
    expect(camera.surface().isReady()).toBe(false);
  });
});

describe('PagedCamera — projectCentered (double-tap target)', () => {
  it('returns the viewport center when centering is reachable', () => {
    const { camera } = makeCamera();
    camera.applyBase(tall, baseTransform('zoomFitToScreen', tall, viewport, true));
    // Tap the page center: at 2x it can center exactly (y overflows, x locks
    // center which IS the centered position for a center-aligned mode)
    const rectCenter = { x: 800, y: 450 };
    const p = camera.projectCentered(rectCenter, 2);
    expect(p.x).toBeCloseTo(800, 4);
    expect(p.y).toBeCloseTo(450, 4);
  });

  it('pulls the target inside bounds for a near-corner tap', () => {
    const { camera } = makeCamera();
    camera.applyBase(tall, baseTransform('zoomFitToScreen', tall, viewport, true));
    // Tap near the page's top edge: centering that content at 2x would push
    // the view past the top bound — the projection lands where the clamp
    // actually allows, so the animation has a consistent, reachable target.
    const rect = { x: 800, y: 20 };
    const p = camera.projectCentered(rect, 2);
    expect(p.y).toBeLessThan(450); // can't be centered…
    expect(p.y).toBeCloseTo(40, 1); // …content point sits at y*2 with the view clamped at the top
  });

  it('returns the raw center when clamping is disabled', () => {
    const { camera } = makeCamera({ clamp: false });
    camera.applyBase(tall, baseTransform('zoomFitToScreen', tall, viewport, true));
    const p = camera.projectCentered({ x: 800, y: 20 }, 2);
    expect(p.x).toBeCloseTo(800, 4);
    expect(p.y).toBeCloseTo(450, 4);
  });
});

describe('PagedCamera — fitting axes center (top-pin bug)', () => {
  it('zoomOriginal: a page smaller than the viewport sits centered, not at the top corner', () => {
    const { camera } = makeCamera();
    const small = { width: 700, height: 800 };
    camera.applyBase(small, baseTransform('zoomOriginal', small, viewport, true));
    expect(camera.translate.x).toBeCloseTo((1600 - 700) / 2, 4);
    expect(camera.translate.y).toBeCloseTo((900 - 800) / 2, 4);
  });

  it('keepZoom: zooming below an axis fit re-centers that axis instead of pinning it', () => {
    const { camera } = makeCamera();
    camera.applyBase(tall, baseTransform('keepZoom', tall, viewport, true));
    // base 0.9 → scaled 630x900; zoom to 0.8 → 504x720, both axes fit
    camera.setUserZoom(0.8);
    expect(camera.translate.x).toBeCloseTo((1600 - 700 * 0.9 * 0.8) / 2, 4);
    expect(camera.translate.y).toBeCloseTo((900 - 1000 * 0.9 * 0.8) / 2, 4);
  });

  it('zoomOriginal: an overflowing page still starts reading at the top and pans freely', () => {
    const { camera } = makeCamera();
    const big = { width: 2000, height: 2800 };
    camera.applyBase(big, baseTransform('zoomOriginal', big, viewport, true));
    expect(camera.translate.y).toBe(0); // reading start
    expect(camera.translate.x).toBe(1600 - 2000); // RTL right edge visible
    camera.adjustView(0, 500); // pan down
    expect(camera.translate.y).toBe(-500); // NOT snapped back to the top
  });
});

describe('PagedCamera — fillScreen mode', () => {
  it('tall page: width fills exactly, height overflows from the top', () => {
    const { camera } = makeCamera();
    camera.applyBase(tall, baseTransform('zoomFillScreen', tall, viewport, true));
    const scale = 1600 / 700;
    expect(camera.effectiveScale).toBeCloseTo(scale, 6);
    expect(camera.translate.x).toBeCloseTo(0, 4);
    expect(camera.translate.y).toBe(0);
    camera.adjustView(0, 300);
    expect(camera.translate.y).toBe(-300); // overflowing height is pannable
  });

  it('wide spread: height fills exactly, width overflows at the RTL reading corner', () => {
    const { camera } = makeCamera();
    const wide = { width: 3200, height: 900 };
    camera.applyBase(wide, baseTransform('zoomFillScreen', wide, viewport, true));
    expect(camera.effectiveScale).toBeCloseTo(1, 6);
    expect(camera.translate.x).toBe(1600 - 3200);
    expect(camera.translate.y).toBeCloseTo(0, 4);
    camera.adjustView(-400, 0);
    expect(camera.translate.x).toBe(1600 - 3200 + 400);
  });
});

describe('PagedCamera — inertial fling (kinetic)', () => {
  // A big overflowing page so there's room to glide and a bound to hit.
  const big = { width: 4000, height: 3000 };

  function drag(camera: PagedCamera, stepX: number, stepY: number, frames: number) {
    camera.kineticStart();
    pump(1); // let the track loop arm
    for (let i = 0; i < frames; i++) {
      camera.adjustView(stepX, stepY); // pointer-space delta → content moves
      pump(1); // a track sample for this frame
    }
  }

  it('glides past the release point after a fast drag, then settles', () => {
    const { camera } = makeCamera();
    camera.applyBase(big, baseTransform('zoomOriginal', big, viewport, true));
    // start centered-ish then drag up-left fast (content moves up/left)
    const releaseY = camera.translate.y;
    drag(camera, 0, 60, 6); // adjustView(0,60) → ty -= 60 each frame (content up)
    const atRelease = camera.translate.y;
    camera.kineticStop();
    pump(120);
    // glided further in the drag direction (ty decreased past release)
    expect(camera.translate.y).toBeLessThan(atRelease);
    expect(atRelease).toBeLessThan(releaseY);
    // came to rest within bounds (ty in [view-scaled, 0])
    expect(camera.translate.y).toBeGreaterThanOrEqual(900 - 3000 - 1);
    expect(camera.translate.y).toBeLessThanOrEqual(0 + 1);
  });

  it('a fling never escapes the clamp bounds', () => {
    const { camera } = makeCamera();
    camera.applyBase(big, baseTransform('zoomOriginal', big, viewport, true));
    drag(camera, 0, 600, 6); // huge upward velocity → would overshoot the bottom edge
    camera.kineticStop();
    pump(300);
    // clamped to the bottom edge, not flung past it
    expect(camera.translate.y).toBeGreaterThanOrEqual(900 - 3000 - 1);
  });

  it('does not fling when animations are instant (e-ink); just settles', () => {
    setInstantAnimations(true);
    try {
      const { camera } = makeCamera();
      camera.applyBase(big, baseTransform('zoomOriginal', big, viewport, true));
      drag(camera, 0, 60, 6);
      const atRelease = camera.translate.y;
      camera.kineticStop();
      pump(120);
      expect(camera.translate.y).toBe(atRelease); // no glide
    } finally {
      setInstantAnimations(false);
    }
  });

  it('an explicit panBy (wheel/keyboard scroll) cancels an in-flight glide', () => {
    const { camera } = makeCamera();
    camera.applyBase(big, baseTransform('zoomOriginal', big, viewport, true));
    drag(camera, 0, 60, 6);
    camera.kineticStop();
    pump(2); // glide a couple frames (fling still has momentum)
    const mid = camera.translate.y;
    camera.panBy(0, -100); // wheel scroll up arrives mid-fling
    pump(120); // run the panBy animation to completion
    // The view lands at the panBy target (mid - 100), proving the fling was
    // cancelled — had it kept gliding it would be far more negative than that.
    expect(camera.translate.y).toBeCloseTo(mid - 100, 0);
  });

  it('stopPan cancels an in-flight glide (a new press wins)', () => {
    const { camera } = makeCamera();
    camera.applyBase(big, baseTransform('zoomOriginal', big, viewport, true));
    drag(camera, 0, 60, 6);
    camera.kineticStop();
    pump(2); // glide a couple frames
    const mid = camera.translate.y;
    camera.stopPan(); // new gesture interrupts
    pump(60);
    expect(camera.translate.y).toBe(mid); // frozen where the glide was cut
  });
});
