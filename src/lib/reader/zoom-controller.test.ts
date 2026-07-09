import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContinuousZoomController } from './zoom-controller';
import type { RectLike } from './zoom-math';

/**
 * Fake layout world simulating the browser geometry the controller corrects
 * against: pages live at unscaled layout coordinates inside a wrapper that is
 * visually scaled by `zoom`; rects are derived the way getBoundingClientRect
 * would report them; scroll writes clamp to bounds (and coerce NaN to 0,
 * like real CSSOM setters).
 */
interface FakePage {
  x: number;
  y: number;
  w: number;
  h: number;
}

class FakeWorld {
  zoom = 1;
  scrollLeft = 0;
  scrollTop = 0;
  rtl = false;
  viewport = { width: 1000, height: 800 };
  pages: FakePage[] = [];
  /** Wrapper layout origin in scroll-content space; may depend on zoom to simulate alignment/centering shifts. */
  originX: (z: number) => number = () => 0;
  originY: (z: number) => number = () => 0;
  applyZoomLayoutCalls: number[] = [];

  private contentWidth(z: number): number {
    const right = Math.max(0, ...this.pages.map((p) => p.x + p.w));
    return this.originX(z) + right * z;
  }

  private contentHeight(z: number): number {
    const bottom = Math.max(0, ...this.pages.map((p) => p.y + p.h));
    return this.originY(z) + bottom * z;
  }

  get scrollWidth(): number {
    return Math.max(this.viewport.width, this.contentWidth(this.zoom));
  }

  get scrollHeight(): number {
    return Math.max(this.viewport.height, this.contentHeight(this.zoom));
  }

  private clampScrollLeft(v: number): number {
    if (Number.isNaN(v)) v = 0; // CSSOM coercion
    const range = this.scrollWidth - this.viewport.width;
    return this.rtl ? Math.max(-range, Math.min(0, v)) : Math.max(0, Math.min(range, v));
  }

  private clampScrollTop(v: number): number {
    if (Number.isNaN(v)) v = 0;
    const range = this.scrollHeight - this.viewport.height;
    return Math.max(0, Math.min(range, v));
  }

  /** Visual offset of the scroll content's left edge at scrollLeft = 0. */
  private get baseX(): number {
    return this.rtl ? this.viewport.width - this.scrollWidth : 0;
  }

  pageRect(i: number): RectLike {
    const p = this.pages[i];
    const z = this.zoom;
    return {
      left: this.baseX + this.originX(z) + p.x * z - this.scrollLeft,
      top: this.originY(z) + p.y * z - this.scrollTop,
      width: p.w * z,
      height: p.h * z
    };
  }

  readonly container = {
    world: this as FakeWorld,
    get scrollLeft() {
      return this.world.scrollLeft;
    },
    set scrollLeft(v: number) {
      this.world.scrollLeft = this.world['clampScrollLeft'](v);
    },
    get scrollTop() {
      return this.world.scrollTop;
    },
    set scrollTop(v: number) {
      this.world.scrollTop = this.world['clampScrollTop'](v);
    },
    get scrollWidth() {
      return this.world.scrollWidth;
    }
  };

  readonly pageEls = {
    world: this as FakeWorld,
    list(): { getBoundingClientRect(): RectLike }[] {
      return this.world.pages.map((_, i) => ({
        getBoundingClientRect: () => this.world.pageRect(i)
      }));
    }
  };
}

function makeController(
  world: FakeWorld,
  spies?: { settled?: (z: number) => void; zoomed?: (b: boolean) => void }
) {
  return new ContinuousZoomController({
    getScrollContainer: () => world.container,
    getPageElements: () => world.pageEls.list(),
    getViewport: () => world.viewport,
    applyZoomLayout: (z) => {
      world.zoom = z;
      world.applyZoomLayoutCalls.push(z);
    },
    onZoomedChange: spies?.zoomed,
    onSettled: spies?.settled
  });
}

/** Deterministic rAF pump for the Animator. */
let rafQueue: FrameRequestCallback[] = [];
let clock = 0;

function pump(frames = 80, dt = 16.67) {
  for (let i = 0; i < frames && rafQueue.length > 0; i++) {
    clock += dt;
    const cbs = rafQueue.splice(0);
    for (const cb of cbs) cb(clock);
  }
}

beforeEach(() => {
  rafQueue = [];
  clock = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A single tall page, like vertical fit-to-width. */
function tallPageWorld(): FakeWorld {
  const w = new FakeWorld();
  w.pages = [{ x: 0, y: 0, w: 1000, h: 1500 }];
  w.scrollTop = 300;
  return w;
}

describe('ContinuousZoomController — pinch', () => {
  it('zooms about the midpoint and pans with it', () => {
    const world = tallPageWorld();
    const c = makeController(world);

    c.pinchStart([
      { x: 400, y: 400 },
      { x: 600, y: 400 }
    ]);
    c.pinchMove([
      { x: 350, y: 380 },
      { x: 750, y: 380 }
    ]);

    expect(world.zoom).toBe(2);
    // Content under the initial midpoint (500, 400) → content (500, 700)
    // must now sit at the live midpoint (550, 380).
    expect(world.scrollLeft).toBeCloseTo(450, 4);
    expect(world.scrollTop).toBeCloseTo(1020, 4);
  });

  it('pinching inward at min zoom leaves scroll untouched (NaN regression)', () => {
    const world = tallPageWorld();
    const c = makeController(world);

    c.pinchStart([
      { x: 400, y: 400 },
      { x: 600, y: 400 }
    ]);
    c.pinchMove([
      { x: 450, y: 400 },
      { x: 550, y: 400 }
    ]);

    expect(world.zoom).toBe(1);
    expect(world.scrollLeft).toBe(0);
    expect(world.scrollTop).toBe(300);
  });

  it('end snaps bookkeeping target to nearest level, keeps the zoom, settles once', () => {
    const world = tallPageWorld();
    const settled = vi.fn();
    const c = makeController(world, { settled });

    c.pinchStart([
      { x: 400, y: 400 },
      { x: 600, y: 400 }
    ]);
    c.pinchMove([
      { x: 240, y: 400 },
      { x: 760, y: 400 }
    ]); // dist 200 → 520 ⇒ zoom 2.6
    c.pinchEnd();
    pump();

    expect(c.currentZoom).toBeCloseTo(2.6, 6);
    expect(c.zoomTarget).toBe(3);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledWith(2.6, 'gesture');
    expect(c.isActive).toBe(false);
  });

  it('ending near 1× animates to exactly 1 and reports unzoomed', () => {
    const world = tallPageWorld();
    const settled = vi.fn();
    const zoomed = vi.fn();
    const c = makeController(world, { settled, zoomed });

    c.pinchStart([
      { x: 400, y: 400 },
      { x: 600, y: 400 }
    ]);
    c.pinchMove([
      { x: 396, y: 400 },
      { x: 604, y: 400 }
    ]); // dist 200 → 208 ⇒ zoom 1.04
    c.pinchEnd();
    pump();

    expect(c.currentZoom).toBe(1);
    expect(c.zoomTarget).toBe(1);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledWith(1, 'gesture');
    expect(zoomed).toHaveBeenLastCalledWith(false);
  });

  it('re-baselines when pinchStart is called again mid-gesture (pointer-set change)', () => {
    const world = tallPageWorld();
    const c = makeController(world);

    c.pinchStart([
      { x: 400, y: 400 },
      { x: 600, y: 400 }
    ]);
    c.pinchMove([
      { x: 300, y: 400 },
      { x: 700, y: 400 }
    ]); // zoom 2
    // A different pair takes over (e.g. third finger landed / one lifted)
    c.pinchStart([
      { x: 100, y: 400 },
      { x: 900, y: 400 }
    ]);
    c.pinchMove([
      { x: 100, y: 400 },
      { x: 900, y: 400 }
    ]); // same distance ⇒ zoom must stay 2, not jump

    expect(world.zoom).toBeCloseTo(2, 6);
  });
});

describe('ContinuousZoomController — wheel', () => {
  it('one notch zooms one level anchored at the cursor', () => {
    const world = tallPageWorld();
    const settled = vi.fn();
    const c = makeController(world, { settled });

    c.wheelZoom({ deltaY: -120, deltaMode: 0, clientX: 300, clientY: 500, timeStamp: 1000 });
    pump();

    expect(c.zoomTarget).toBe(1.5);
    expect(c.currentZoom).toBe(1.5);
    // Content under cursor (300, 500) → content (300, 800) stays under it.
    expect(world.scrollLeft).toBeCloseTo(150, 3);
    expect(world.scrollTop).toBeCloseTo(700, 3);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('accumulates trackpad deltas into a single step', () => {
    const world = tallPageWorld();
    const c = makeController(world);

    for (let i = 0; i < 4; i++) {
      c.wheelZoom({
        deltaY: -20,
        deltaMode: 0,
        clientX: 500,
        clientY: 400,
        timeStamp: 1000 + i * 16
      });
    }
    expect(c.zoomTarget).toBe(1);
    c.wheelZoom({ deltaY: -20, deltaMode: 0, clientX: 500, clientY: 400, timeStamp: 1064 });
    expect(c.zoomTarget).toBe(1.5);
  });

  it('steps onto the level after an off-level pinch instead of dead-zoning', () => {
    const world = tallPageWorld();
    const c = makeController(world);

    c.pinchStart([
      { x: 400, y: 400 },
      { x: 600, y: 400 }
    ]);
    c.pinchMove([
      { x: 240, y: 400 },
      { x: 760, y: 400 }
    ]); // zoom 2.6
    c.pinchEnd(); // target → 3, zoom stays 2.6
    pump();

    c.wheelZoom({ deltaY: -120, deltaMode: 0, clientX: 500, clientY: 400, timeStamp: 2000 });
    pump();
    expect(c.currentZoom).toBe(3);
  });
});

describe('ContinuousZoomController — double-tap', () => {
  it('at 1× zooms to 2× moving the tap point toward the viewport center', () => {
    const world = tallPageWorld();
    const c = makeController(world);

    c.toggleZoom(300, 500);
    pump();

    expect(c.currentZoom).toBe(2);
    // Content under the tap (300, 500) → content (300, 800) ends at center (500, 400).
    expect(world.scrollLeft).toBeCloseTo(100, 3);
    expect(world.scrollTop).toBeCloseTo(1200, 3);
  });

  it('when zoomed resets to 1×', () => {
    const world = tallPageWorld();
    const zoomed = vi.fn();
    const c = makeController(world, { zoomed });

    c.toggleZoom(300, 500);
    pump();
    expect(c.currentZoom).toBe(2);

    c.toggleZoom(700, 300);
    pump();
    expect(c.currentZoom).toBe(1);
    expect(zoomed).toHaveBeenLastCalledWith(false);
  });

  it('resets even when the visible zoom is off-level after a pinch whose target snapped to 1', () => {
    const world = tallPageWorld();
    const c = makeController(world);

    // Pinch to 1.2: stays (above the 1.05 snap threshold), target snaps to 1.
    c.pinchStart([
      { x: 400, y: 400 },
      { x: 600, y: 400 }
    ]);
    c.pinchMove([
      { x: 380, y: 400 },
      { x: 620, y: 400 }
    ]); // zoom 1.2
    c.pinchEnd();
    pump();
    expect(c.currentZoom).toBeCloseTo(1.2, 6);
    expect(c.zoomTarget).toBe(1);

    c.toggleZoom(500, 400);
    pump();
    expect(c.currentZoom).toBe(1);
  });
});

describe('ContinuousZoomController — interruption and lifecycle', () => {
  it('finishNow snaps to the target and settles exactly once', () => {
    const world = tallPageWorld();
    const settled = vi.fn();
    const c = makeController(world, { settled });

    c.toggleZoom(300, 500);
    pump(3);
    expect(c.isActive).toBe(true);
    expect(c.currentZoom).toBeLessThan(2);

    c.finishNow();
    expect(c.currentZoom).toBe(2);
    expect(c.isActive).toBe(false);
    expect(settled).toHaveBeenCalledTimes(1);

    pump();
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('pinch start during an animation finishes it first', () => {
    const world = tallPageWorld();
    const settled = vi.fn();
    const c = makeController(world, { settled });

    c.toggleZoom(300, 500);
    pump(3);

    c.pinchStart([
      { x: 400, y: 400 },
      { x: 600, y: 400 }
    ]);
    expect(settled).toHaveBeenCalledTimes(1); // finished before baselining
    c.pinchMove([
      { x: 425, y: 400 },
      { x: 575, y: 400 }
    ]); // dist 200 → 150 ⇒ ratio 0.75 from zoom 2
    expect(world.zoom).toBeCloseTo(1.5, 6);
  });

  it('reset returns to 1× instantly and cleans up', () => {
    const world = tallPageWorld();
    const settled = vi.fn();
    const zoomed = vi.fn();
    const c = makeController(world, { settled, zoomed });

    c.toggleZoom(300, 500);
    pump();
    settled.mockClear();

    c.reset();
    expect(c.currentZoom).toBe(1);
    expect(world.zoom).toBe(1);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledWith(1, 'reset');
    expect(zoomed).toHaveBeenLastCalledWith(false);
  });

  it('gestures no-op safely when no pages exist', () => {
    const world = new FakeWorld();
    const c = makeController(world);

    c.toggleZoom(300, 500);
    c.wheelZoom({ deltaY: -120, deltaMode: 0, clientX: 300, clientY: 500, timeStamp: 0 });
    pump();
    expect(c.currentZoom).toBe(1);
  });
});

describe('ContinuousZoomController — geometry robustness', () => {
  it('keeps the anchor pinned when the wrapper origin shifts with zoom (alignment/centering)', () => {
    const world = tallPageWorld();
    world.originY = (z) => (z - 1) * 40; // simulated alignment shift
    const c = makeController(world);

    c.toggleZoom(300, 500);
    pump();

    // actual = originY(2) + contentY·2 − scrollTop must equal desired 400
    const rect = world.pageRect(0);
    const fy = 800 / 1500; // content (300, 800) inside the 1000x1500 page
    const fx = 300 / 1000;
    expect(rect.left + fx * rect.width).toBeCloseTo(500, 3);
    expect(rect.top + fy * rect.height).toBeCloseTo(400, 3);
  });

  it('RTL: zoom pins the cursor anchor inside the negative scroll range', () => {
    const world = new FakeWorld();
    world.rtl = true;
    world.pages = [
      { x: 0, y: 0, w: 800, h: 800 },
      { x: 800, y: 0, w: 800, h: 800 },
      { x: 1600, y: 0, w: 800, h: 800 }
    ];
    // scrollLeft = 0 shows the right end (RTL start); range is [-1400, 0]
    const c = makeController(world);

    c.cycleZoom(1, 600, 400);
    pump();

    expect(c.currentZoom).toBe(1.5);
    // Content under (600, 400) was content x = 2000; at 1.5× pinned at 600:
    // base' = 1000 − 3600 = −2600 ⇒ −2600 + 3000 − scrollLeft = 600 ⇒ scrollLeft = −200
    expect(world.scrollLeft).toBeCloseTo(-200, 3);
  });

  it('Safari gesture events drive the same pinch path', () => {
    const world = tallPageWorld();
    const settled = vi.fn();
    const c = makeController(world, { settled });

    c.gestureStart(500, 400);
    c.gestureChange(2, 550, 380);
    expect(world.zoom).toBe(2);
    expect(world.scrollLeft).toBeCloseTo(450, 4);
    expect(world.scrollTop).toBeCloseTo(1020, 4);

    c.gestureEnd();
    pump();
    expect(settled).toHaveBeenCalledTimes(1);
  });
});

describe('ZoomController — surface abstraction (additive)', () => {
  it('drives a custom ZoomSurface instead of a scroll container', () => {
    const world = tallPageWorld();
    const calls: string[] = [];
    const c = new ContinuousZoomController({
      surface: {
        isReady: () => true,
        applyZoomLayout: (z) => {
          world.zoom = z;
          calls.push(`layout:${z.toFixed(2)}`);
        },
        syncLayout: () => calls.push('sync'),
        correctView: (dx, dy) => {
          world.container.scrollLeft += dx;
          world.container.scrollTop += dy;
          calls.push('correct');
        }
      },
      getPageElements: () => world.pageEls.list(),
      getViewport: () => world.viewport
    });

    c.pinchStart([
      { x: 400, y: 400 },
      { x: 600, y: 400 }
    ]);
    c.pinchMove([
      { x: 350, y: 380 },
      { x: 750, y: 380 }
    ]);

    expect(world.zoom).toBe(2);
    expect(world.scrollLeft).toBeCloseTo(450, 4);
    expect(world.scrollTop).toBeCloseTo(1020, 4);
    expect(calls).toContain('sync');
    expect(calls).toContain('correct');
  });

  it('skips frames while the surface is not ready', () => {
    const world = tallPageWorld();
    let ready = false;
    const c = new ContinuousZoomController({
      surface: {
        isReady: () => ready,
        applyZoomLayout: (z) => {
          world.zoom = z;
        },
        syncLayout: () => {},
        correctView: (dx, dy) => {
          world.container.scrollLeft += dx;
          world.container.scrollTop += dy;
        }
      },
      getPageElements: () => world.pageEls.list(),
      getViewport: () => world.viewport
    });

    c.pinchStart([
      { x: 400, y: 400 },
      { x: 600, y: 400 }
    ]);
    c.pinchMove([
      { x: 300, y: 400 },
      { x: 700, y: 400 }
    ]);
    expect(world.zoom).toBe(1); // layout never applied

    ready = true;
    c.pinchMove([
      { x: 300, y: 400 },
      { x: 700, y: 400 }
    ]);
    expect(world.zoom).toBe(2);
  });

  it('drops a detached anchor (zero rect) instead of applying a garbage correction', () => {
    const world = tallPageWorld();
    const c = makeController(world);

    c.toggleZoom(300, 500);
    pump(3);
    const midLeft = world.scrollLeft;
    const midTop = world.scrollTop;

    // Simulate the {#key} swap destroying the anchored page mid-animation:
    // a detached element measures as an all-zero rect
    world.pages[0] = { x: 0, y: 0, w: 0, h: 0 };
    pump();

    // Zoom finishes but no zero-rect "correction" teleports the view
    expect(c.currentZoom).toBe(2);
    expect(Math.abs(world.scrollLeft - midLeft)).toBeLessThan(200);
    expect(Math.abs(world.scrollTop - midTop)).toBeLessThan(200);
  });

  it('reads dynamic levels from getLevels on every step', () => {
    const world = tallPageWorld();
    let levels: number[] = [0.5, 1, 2];
    const c = new ContinuousZoomController({
      getLevels: () => levels,
      getScrollContainer: () => world.container,
      getPageElements: () => world.pageEls.list(),
      getViewport: () => world.viewport,
      applyZoomLayout: (z) => {
        world.zoom = z;
      }
    });

    c.wheelZoom({ deltaY: -120, deltaMode: 0, clientX: 500, clientY: 400, timeStamp: 1000 });
    pump();
    expect(c.currentZoom).toBe(2); // 1 -> 2 with the dynamic list

    levels = [0.5, 1, 2, 4];
    c.wheelZoom({ deltaY: -120, deltaMode: 0, clientX: 500, clientY: 400, timeStamp: 2000 });
    pump();
    expect(c.currentZoom).toBe(4);

    c.wheelZoom({ deltaY: 240, deltaMode: 0, clientX: 500, clientY: 400, timeStamp: 3000 });
    pump();
    expect(c.currentZoom).toBe(1);
  });

  it('animateToLevel lands content sampled at from on the to point', () => {
    const world = tallPageWorld();
    const c = makeController(world);

    c.animateToLevel(0.9, { x: 300, y: 500 }, { x: 500, y: 400 });
    pump();
    expect(c.currentZoom).toBeCloseTo(0.9, 6);
  });
});

describe('ZoomController — snapToLevel (additive)', () => {
  it('applies the level instantly, settles once, and skips anchor correction', () => {
    const world = tallPageWorld();
    const settled = vi.fn();
    const c = makeController(world, { settled });

    const before = { left: world.scrollLeft, top: world.scrollTop };
    c.snapToLevel(2.5);

    expect(c.currentZoom).toBe(2.5);
    expect(c.zoomTarget).toBe(2.5);
    expect(world.zoom).toBe(2.5);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledWith(2.5, 'reset');
    // layout placement only — no anchor-driven scroll writes
    expect(world.scrollLeft).toBe(before.left);
    expect(world.scrollTop).toBe(before.top);
    expect(c.isActive).toBe(false);
  });

  it('interrupts an in-flight animation cleanly', () => {
    const world = tallPageWorld();
    const settled = vi.fn();
    const c = makeController(world, { settled });

    c.toggleZoom(300, 500);
    pump(3);
    c.snapToLevel(1.5);
    pump();

    expect(c.currentZoom).toBe(1.5);
    expect(settled).toHaveBeenCalledTimes(1);
  });
});

describe('ZoomController — snapToLevel anchor skip (regression pin)', () => {
  it('leaves scroll untouched when interrupting a live anchored gesture', () => {
    const world = tallPageWorld();
    const c = makeController(world);

    c.toggleZoom(300, 500);
    pump(3); // anchor is live, correction in flight
    const before = { left: world.scrollLeft, top: world.scrollTop };

    c.snapToLevel(1.5);
    // Layout placement only — a stale-anchor correction here would teleport
    // the view toward the abandoned gesture's target point.
    expect(world.scrollLeft).toBe(before.left);
    expect(world.scrollTop).toBe(before.top);
    expect(c.currentZoom).toBe(1.5);
  });
});

describe('ZoomController — settle reasons', () => {
  it('reports gesture on natural animated settle', () => {
    const world = tallPageWorld();
    const settled = vi.fn();
    const c = makeController(world, { settled });
    c.toggleZoom(300, 500);
    pump();
    expect(settled).toHaveBeenCalledWith(2, 'gesture');
  });

  it('reports interrupt by default from finishNow', () => {
    const world = tallPageWorld();
    const settled = vi.fn();
    const c = makeController(world, { settled });
    c.toggleZoom(300, 500);
    pump(3);
    c.finishNow();
    expect(settled).toHaveBeenCalledWith(2, 'interrupt');
  });

  it('reports nav when the interrupt precedes a navigation', () => {
    const world = tallPageWorld();
    const settled = vi.fn();
    const c = makeController(world, { settled });
    c.toggleZoom(300, 500);
    pump(3);
    c.finishNow('nav');
    expect(settled).toHaveBeenCalledWith(2, 'nav');
  });

  it('reports nav from a pinch interrupted for navigation', () => {
    const world = tallPageWorld();
    const settled = vi.fn();
    const c = makeController(world, { settled });
    c.pinchStart([
      { x: 400, y: 400 },
      { x: 600, y: 400 }
    ]);
    c.pinchMove([
      { x: 300, y: 400 },
      { x: 700, y: 400 }
    ]);
    c.finishNow('nav');
    expect(settled).toHaveBeenCalledWith(2, 'nav');
  });
});
