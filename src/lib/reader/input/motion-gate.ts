/**
 * Motion interrupt contract — THE statement of what must stop before new
 * motion starts.
 *
 * Each reading surface has several motion owners that can animate the view
 * concurrently: a zoom controller (pinch/wheel/double-tap animations), a
 * scroll or pan animator, and the user's own drag. Letting two of them run
 * at once is how the worst input bugs happened — a zoom's per-frame
 * corrections stomping a pan, a drag writing absolute positions from a
 * pre-zoom baseline, a scroll animator gliding from a stale position after
 * a zoom correction.
 *
 * Instead of every input handler remembering which owners to stop (the old
 * scattered ritual: `if (controller.isActive) controller.finishNow();
 * camera.stopPan(); scroller?.stop(); scroller?.sync(); ...` in a dozen
 * variations), each surface builds ONE MotionGate and every handler opens
 * with the call matching its intent. A new input handler that forgets the
 * gate is a review smell; a handler that calls the wrong intent is at
 * least explicit about what it expects to interrupt.
 *
 * The gate interrupts COMPETING owners only — the input's own machinery
 * (the zoom controller for a zoom gesture, the tracker for a pointer pan)
 * manages its own state and must not be reset by the gate.
 */
export interface MotionGate {
  /**
   * A zoom gesture is starting (pinch, wheel zoom, double-tap, Safari
   * trackpad). Stop scroll/pan animations AND any held drag — its absolute
   * baselines would fight the zoom's correction frames. (Held drags are
   * cancelled via PointerGestureTracker.cancelPan, which is pinch-safe.)
   */
  beforeZoom(): void;

  /**
   * The user grabbed the surface (pan press). Finish any in-flight zoom so
   * the drag acts on settled geometry, and stop pan/scroll animations so
   * they don't fight the drag.
   */
  beforeManualPan(): void;

  /**
   * An animated or native scroll is starting (wheel scroll, scroll-image
   * key). Finish any in-flight zoom; scroll animations are left alone so
   * successive ticks chain smoothly.
   */
  beforeAnimatedScroll(): void;

  /**
   * A navigation jump is starting (keyboard page nav, external page
   * change). Finish any in-flight zoom with the 'nav' settle reason (its
   * progress report would be superseded) and resync the scroll animator to
   * the corrected position. Surfaces without their own navigation omit it.
   */
  beforeNav?(): void;
}
