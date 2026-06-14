/**
 * The reader's ONE pointer state machine — pan/pinch tracking shared by all
 * three reading surfaces (PagedViewport and both scroll readers), which
 * previously each carried a divergent ~80-line copy. The copies disagreed in
 * ways that shipped bugs: two of three leaked pointers whose release never
 * reached the surface element, and the capture policy was opposite between
 * surfaces with neither stated.
 *
 * Structural guarantees:
 *
 * - **Leak-proof:** pointerup/pointercancel listen on the WINDOW, always.
 *   A pointer that enters the map on pointerdown leaves it on release no
 *   matter where the release lands (overlays, context menus, outside the
 *   browser pane via capture). No phantom entries → no misread pinches.
 * - **Capture policy is named config**, not an accident: 'deferred' waits
 *   for the drag threshold so taps still deliver native clicks to in-wrapper
 *   buttons and text-selection presses stay uncaptured; 'immediate' captures
 *   on pan start.
 * - **Pinch always wins and never cares about roles**: every pointer joins
 *   the map (suppressPan only vetoes PAN initiation), two pointers upgrade
 *   to pinch (ending any pan), pointer-set changes re-baseline, dropping to
 *   one pointer downgrades to a fresh pan with the survivor.
 * - **Consumer-lost pinches resurrect**: if ≥2 pointers move while
 *   `isPinchAlive()` reports false (a mid-gesture reset cleared the zoom
 *   controller's pinch), onPinchStart re-fires to re-baseline.
 *
 * The tracker owns classification and lifecycle only — surfaces keep full
 * control of actuation through the callbacks (scroll writes, camera moves,
 * cross-axis gating).
 */

/** Movement (px) before a press becomes a pan. */
const DRAG_THRESHOLD = 5;

export interface TrackedPointer {
  id: number;
  x: number;
  y: number;
  type: string;
  /** Position at press — drift detection for suppressed (selection) drags. */
  pressX: number;
  pressY: number;
  /** Pan eligibility evaluated at press (primary button, not suppressed). */
  canPan: boolean;
}

export interface PanDeltas {
  /** Incremental since the previous move (paged camera adjustments). */
  dx: number;
  dy: number;
  /** Total since the pan pointer pressed (scroll readers' absolute drags). */
  totalDx: number;
  totalDy: number;
}

export interface PanSummary {
  /** Whether the press ever crossed the drag threshold. */
  panned: boolean;
  /**
   * The gesture did not end by the user's release: the OS cancelled the
   * pointer (pointercancel — system gestures, orientation change, overlays)
   * or the surface interrupted it (cancelPan). Cancelled summaries must
   * never classify as swipes; pointercancel coordinates are unreliable, so
   * endX/endY hold the last-known pan position instead.
   */
  cancelled: boolean;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  durationMs: number;
  pointerType: string;
}

export interface PointerTrackerConfig {
  /** Surface element receiving pointerdown/pointermove. */
  getElement(): HTMLElement | null | undefined;
  /** See module doc — 'deferred' until threshold, or 'immediate' on press. */
  capturePolicy: 'deferred' | 'immediate';
  /**
   * Veto PAN initiation for this press (e.g. mouse/pen on a text box keeps
   * drag selection). The pointer still joins the map and can pinch.
   */
  suppressPan?(e: PointerEvent): boolean;

  /**
   * A pan-eligible press registered (primary button, not suppressed) —
   * before any threshold. Surfaces interrupt in-flight zoom animations and
   * capture scroll baselines here.
   */
  onPress?(p: TrackedPointer, e: PointerEvent): void;
  onPanMove?(p: TrackedPointer, deltas: PanDeltas, e: PointerEvent): void;
  onPanEnd?(summary: PanSummary): void;

  /** Fires on pinch entry AND on every pointer-set re-baseline. */
  onPinchStart?(points: TrackedPointer[]): void;
  onPinchMove?(points: TrackedPointer[]): void;
  /** Fires when dropping below two pointers; `remaining` survives, if any. */
  onPinchEnd?(remaining: TrackedPointer | null): void;
  /** Liveness probe for resurrecting consumer-lost pinches. */
  isPinchAlive?(): boolean;
  /**
   * When a pinch drops to one pointer, the survivor continues as a fresh pan
   * (the old panzoom pinch→drag handoff — right for incremental-delta
   * surfaces). Absolute-baseline surfaces leave this off: their baselines
   * would be stale and the pan would fight the post-pinch settle animation.
   */
  pinchSurvivorPans?: boolean;

  /**
   * Safari desktop trackpad pinch (proprietary gesturestart/change/end —
   * Safari never synthesizes ctrl+wheel). Wired by the tracker so the
   * listener trio isn't copied per surface.
   */
  safariGestures?: {
    start(x: number, y: number): void;
    change(scale: number, x: number, y: number): void;
    end(): void;
  };
}

export class PointerGestureTracker {
  private config: PointerTrackerConfig;
  private pointers = new Map<number, TrackedPointer>();
  private attached = false;
  private element: HTMLElement | null = null;

  private pinching = false;
  private pinchSinceLastPress = false;

  private panId: number | null = null;
  private panEligible = false;
  private panEngaged = false;
  private panStartX = 0;
  private panStartY = 0;
  private panLastX = 0;
  private panLastY = 0;
  private panStartTime = 0;
  private panType = 'mouse';
  private captured = false;
  private dragSinceLastPress = false;

  constructor(config: PointerTrackerConfig) {
    this.config = config;
  }

  get pointerCount(): number {
    return this.pointers.size;
  }

  get isPanning(): boolean {
    return this.panEngaged;
  }

  get isPinching(): boolean {
    return this.pinching;
  }

  /** True once this press sequence panned or pinched — suppresses the click. */
  get wasDrag(): boolean {
    return this.dragSinceLastPress;
  }

  /** A pinch happened since the last fresh single press (swipe suppression). */
  get wasPinch(): boolean {
    return this.pinchSinceLastPress;
  }

  attach(): void {
    if (this.attached) return;
    const el = this.config.getElement();
    if (!el) return;
    this.element = el;
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    if (this.config.safariGestures) {
      el.addEventListener('gesturestart', this.onGestureStart);
      el.addEventListener('gesturechange', this.onGestureChange);
      el.addEventListener('gestureend', this.onGestureEnd);
    }
    // Releases land wherever the pointer is — overlays, dialogs, the window
    // edge. Listening here is what makes leaks structural rather than a
    // per-surface fix.
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
    this.attached = true;
  }

  detach(): void {
    if (!this.attached) return;
    this.element?.removeEventListener('pointerdown', this.onDown);
    this.element?.removeEventListener('pointermove', this.onMove);
    if (this.config.safariGestures) {
      this.element?.removeEventListener('gesturestart', this.onGestureStart);
      this.element?.removeEventListener('gesturechange', this.onGestureChange);
      this.element?.removeEventListener('gestureend', this.onGestureEnd);
    }
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onUp);
    this.pointers.clear();
    this.resetPan();
    this.pinching = false;
    this.attached = false;
  }

  /**
   * Force-end any pan (engaged or candidate) — e.g. a wheel zoom starting
   * while a drag is held, whose absolute baselines would fight the zoom's
   * correction frames. Never touches pinch state, so it is safe to call
   * from onPinchStart (where the tracker is mid-upgrade).
   */
  cancelPan(): void {
    if (this.panEngaged) this.finishPan(this.panLastX, this.panLastY, true);
    this.resetPan();
  }

  private onDown = (evt: Event): void => {
    const e = evt as PointerEvent;
    if (this.pointers.size === 0) {
      this.dragSinceLastPress = false;
      this.pinchSinceLastPress = false;
    }
    // Eligibility is decided at press time for EVERY pointer — suppressPan
    // runs even for non-primary buttons and pinch fingers, both because its
    // side effects matter (a right-click on a text box must still arm the
    // tap-dismissal) and because the pinch-survivor handoff needs it later.
    const suppressed = this.config.suppressPan?.(e) ?? false;
    const canPan = e.button === 0 && !suppressed;
    this.pointers.set(e.pointerId, {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      type: e.pointerType,
      pressX: e.clientX,
      pressY: e.clientY,
      canPan
    });

    if (this.pointers.size >= 2) {
      this.beginPinch();
      return;
    }

    if (!canPan) return;

    this.panId = e.pointerId;
    this.panEligible = true;
    this.panEngaged = false;
    this.panStartX = e.clientX;
    this.panStartY = e.clientY;
    this.panLastX = e.clientX;
    this.panLastY = e.clientY;
    this.panStartTime = performance.now();
    this.panType = e.pointerType;

    if (this.config.capturePolicy === 'immediate') this.capture(e.pointerId);
    this.config.onPress?.(this.pointers.get(e.pointerId)!, e);
  };

  private onMove = (evt: Event): void => {
    const e = evt as PointerEvent;
    const tracked = this.pointers.get(e.pointerId);
    if (!tracked) return;
    tracked.x = e.clientX;
    tracked.y = e.clientY;

    if (this.pointers.size >= 2) {
      // Resurrect a consumer-lost pinch (mid-gesture reset) before moving.
      if (this.pinching && this.config.isPinchAlive && !this.config.isPinchAlive()) {
        this.config.onPinchStart?.(this.points());
      }
      if (this.pinching) this.config.onPinchMove?.(this.points());
      return;
    }

    if (!this.panEligible || this.panId !== e.pointerId) {
      // A suppressed press (selection drag, non-primary button) that drifts
      // past the threshold is still a drag for click purposes — the ensuing
      // click must not toggle overlays or consume the dismissal swallow.
      if (!this.dragSinceLastPress && this.pointers.size === 1) {
        const drift = Math.hypot(e.clientX - tracked.pressX, e.clientY - tracked.pressY);
        if (drift > DRAG_THRESHOLD) this.dragSinceLastPress = true;
      }
      return;
    }

    const dx = e.clientX - this.panLastX;
    const dy = e.clientY - this.panLastY;

    if (!this.panEngaged) {
      const fromStart = Math.hypot(e.clientX - this.panStartX, e.clientY - this.panStartY);
      if (fromStart <= DRAG_THRESHOLD) return;
      this.panEngaged = true;
      this.dragSinceLastPress = true;
      // A drag is never also a text selection — clear any partial one.
      window.getSelection()?.removeAllRanges();
      if (this.config.capturePolicy === 'deferred') this.capture(e.pointerId);
    }

    this.panLastX = e.clientX;
    this.panLastY = e.clientY;
    this.config.onPanMove?.(
      tracked,
      {
        dx,
        dy,
        totalDx: e.clientX - this.panStartX,
        totalDy: e.clientY - this.panStartY
      },
      e
    );
  };

  private onUp = (evt: Event): void => {
    const e = evt as PointerEvent;
    const had = this.pointers.has(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (!had) return;

    if (this.pinching) {
      if (this.pointers.size >= 2) {
        this.config.onPinchStart?.(this.points()); // re-baseline the new pair
        return;
      }
      this.pinching = false;
      const remaining = this.points()[0] ?? null;
      this.config.onPinchEnd?.(remaining);
      // Only an eligible pointer may inherit the pan — a suppressed press
      // (pen on a text box mid-selection) must not start panning because a
      // stray second finger came and went.
      if (remaining && remaining.canPan && this.config.pinchSurvivorPans) {
        // The survivor continues as a fresh pan from its current position.
        this.panId = remaining.id;
        this.panEligible = true;
        this.panEngaged = false;
        this.panStartX = remaining.x;
        this.panStartY = remaining.y;
        this.panLastX = remaining.x;
        this.panLastY = remaining.y;
        this.panStartTime = performance.now();
        this.panType = remaining.type;
      }
      return;
    }

    if (this.panId === e.pointerId) {
      const cancelled = evt.type === 'pointercancel';
      this.finishPan(
        cancelled ? this.panLastX : e.clientX,
        cancelled ? this.panLastY : e.clientY,
        cancelled
      );
      this.resetPan();
    }
  };

  private beginPinch(): void {
    // Flags first: the upgrade's onPanEnd fires synchronously below, and
    // consumers read wasPinch there to veto swipe classification.
    this.pinching = true;
    this.pinchSinceLastPress = true;
    this.dragSinceLastPress = true;
    if (this.panEngaged) this.finishPan(this.panLastX, this.panLastY);
    this.resetPan();
    this.config.onPinchStart?.(this.points());
  }

  private finishPan(endX: number, endY: number, cancelled = false): void {
    this.releaseCapture();
    this.config.onPanEnd?.({
      panned: this.panEngaged,
      cancelled,
      startX: this.panStartX,
      startY: this.panStartY,
      endX,
      endY,
      durationMs: performance.now() - this.panStartTime,
      pointerType: this.panType
    });
  }

  private resetPan(): void {
    this.releaseCapture();
    this.panId = null;
    this.panEligible = false;
    this.panEngaged = false;
  }

  private capture(pointerId: number): void {
    try {
      this.element?.setPointerCapture(pointerId);
      this.captured = true;
    } catch {
      /* inactive pointer (synthetic events) — ignore */
    }
  }

  private releaseCapture(): void {
    if (!this.captured) return;
    this.captured = false;
    if (this.panId === null) return;
    try {
      this.element?.releasePointerCapture(this.panId);
    } catch {
      /* already released */
    }
  }

  private points(): TrackedPointer[] {
    return [...this.pointers.values()];
  }

  // WebKit proprietary gesture events (typed minimally — Safari only).
  private onGestureStart = (e: Event): void => {
    e.preventDefault();
    const ge = e as Event & { clientX?: number; clientY?: number };
    this.config.safariGestures?.start(ge.clientX ?? 0, ge.clientY ?? 0);
  };

  private onGestureChange = (e: Event): void => {
    e.preventDefault();
    const ge = e as Event & { scale?: number; clientX?: number; clientY?: number };
    this.config.safariGestures?.change(ge.scale ?? 1, ge.clientX ?? 0, ge.clientY ?? 0);
  };

  private onGestureEnd = (e: Event): void => {
    e.preventDefault();
    this.config.safariGestures?.end();
  };
}

/**
 * The standard wiring from tracker pinches (and Safari trackpad gestures)
 * into a zoom controller — identical across all three reading surfaces, so
 * it lives here once. The `x || width/2` fallback recenters gestures whose
 * coordinates WebKit omitted (reported as 0).
 */
export function zoomGestureConfig(deps: {
  beforeZoom(): void;
  controller: {
    readonly isActive: boolean;
    pinchStart(points: { x: number; y: number }[]): void;
    pinchMove(points: { x: number; y: number }[]): void;
    pinchEnd(): void;
    gestureStart(x: number, y: number): void;
    gestureChange(scale: number, x: number, y: number): void;
    gestureEnd(): void;
  };
  getViewport(): { width: number; height: number };
}): Pick<
  PointerTrackerConfig,
  'onPinchStart' | 'onPinchMove' | 'onPinchEnd' | 'isPinchAlive' | 'safariGestures'
> {
  const { controller } = deps;
  return {
    onPinchStart: (pts) => {
      deps.beforeZoom();
      controller.pinchStart(pts);
    },
    onPinchMove: (pts) => controller.pinchMove(pts),
    onPinchEnd: () => controller.pinchEnd(),
    isPinchAlive: () => controller.isActive,
    safariGestures: {
      start: (x, y) => {
        deps.beforeZoom();
        controller.gestureStart(
          x || deps.getViewport().width / 2,
          y || deps.getViewport().height / 2
        );
      },
      change: (scale, x, y) =>
        controller.gestureChange(
          scale,
          x || deps.getViewport().width / 2,
          y || deps.getViewport().height / 2
        ),
      end: () => controller.gestureEnd()
    }
  };
}
