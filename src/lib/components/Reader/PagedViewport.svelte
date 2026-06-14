<script lang="ts">
  import type { Snippet } from 'svelte';
  import { onDestroy, onMount } from 'svelte';
  import { settings } from '$lib/settings';
  import { PagedCamera } from '$lib/reader/paged-camera';
  import { ContinuousZoomController } from '$lib/reader/zoom-controller';
  import type { Size } from '$lib/reader/paged-zoom-layout';
  import {
    applyPagedBase,
    createSessionState,
    doubleTapTarget,
    pagedLevels
  } from '$lib/reader/paged-zoom-session';
  import { normalizeWheelDelta, wheelIntentIsZoom } from '$lib/reader/zoom-math';
  import { pagedZoom, type PagedZoomApi } from '$lib/reader/paged-zoom';
  import { PointerGestureTracker, zoomGestureConfig } from '$lib/reader/input/pointer-tracker';
  import { gestureTargetRole } from '$lib/reader/input/gesture-target';
  import { TapDiscriminator } from '$lib/reader/input/tap';
  import { classifySwipe } from '$lib/reader/input/swipe';
  import type { MotionGate } from '$lib/reader/input/motion-gate';

  interface Props {
    /** Native pixel size of the displayed page or pair — from page data, not DOM. */
    contentSize: Size;
    /**
     * Identity of the displayed content (e.g. the page index). Manga pages
     * are overwhelmingly uniform in size, so the base must re-apply on page
     * turns even when the dimensions don't change.
     */
    pageKey: number | string;
    rtl: boolean;
    /**
     * An edge-gated swipe asked for the page on this VISUAL side ('left' =
     * rightward swipe revealing the left page). RTL mapping is the
     * caller's concern.
     */
    onPageFlip?: (side: 'left' | 'right') => void;
    /** A lone tap on the page surface (not text box / chrome). */
    onOverlayToggle?: () => void;
    children?: Snippet;
  }

  let { contentSize, pageKey, rtl, onPageFlip, onOverlayToggle, children }: Props = $props();

  let wrapperEl: HTMLDivElement | undefined = $state();
  let viewportWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1024);
  let viewportHeight = $state(typeof window !== 'undefined' ? window.innerHeight : 768);

  // Session state for the controller's dynamic level ladder (plain object —
  // read by closures at call time, never rendered).
  const session = createSessionState();

  const camera = new PagedCamera({
    getWrapper: () => wrapperEl,
    getViewport: () => ({ width: viewportWidth, height: viewportHeight }),
    isClampingEnabled: () => $settings.bounds || $settings.mobile,
    getDevicePixelRatio: () => (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1)
  });

  const controller = new ContinuousZoomController({
    surface: camera.surface(),
    getLevels: () => pagedLevels(session.baseScale, session.fitScale),
    getPageElements: () => {
      // During a {#key page} transition both the outgoing and incoming trees
      // are in the DOM; anchor only to the live (last) tree's pages.
      if (!wrapperEl) return [];
      const all = [...wrapperEl.querySelectorAll<HTMLElement>('[data-page-index]')];
      if (all.length === 0) return all;
      const liveTree = all[all.length - 1].closest('.col-start-1');
      return liveTree ? all.filter((el) => el.closest('.col-start-1') === liveTree) : all;
    },
    getViewport: () => ({ width: viewportWidth, height: viewportHeight }),
    onSettled: () => camera.settle()
  });

  function applyBase(mode: string) {
    applyPagedBase(
      { camera, controller, state: session },
      mode,
      contentSize,
      { width: viewportWidth, height: viewportHeight },
      rtl
    );
  }

  // Re-apply on page-identity / content / mode / viewport / direction
  // changes. The base is computed from page data, so the {#key page}
  // transition overlap can't skew it; pageKey makes uniform-dimension page
  // turns (the normal manga case) re-apply too.
  let lastSig = '';
  $effect(() => {
    const mode = $settings.zoomDefault as string;
    const sig = `${pageKey}|${contentSize.width}x${contentSize.height}|${mode}|${viewportWidth}x${viewportHeight}|${rtl}`;
    if (sig === lastSig) return;
    lastSig = sig;
    applyBase(mode);
  });

  // Enabling bounds/mobile mid-session must clamp the current view
  // immediately — the camera reads the gate lazily, only on mutations.
  $effect(() => {
    if ($settings.bounds || $settings.mobile) camera.settle();
  });

  function handleResize() {
    viewportWidth = window.innerWidth;
    viewportHeight = window.innerHeight;
  }

  // ============================================================
  // Wheel — attached to the wrapper (non-passive, so ctrl+wheel can
  // preventDefault the browser page-zoom)
  // ============================================================

  /** Interrupt choke points — see MotionGate for the contract. */
  const motion: MotionGate = {
    beforeZoom() {
      camera.stopPan();
      tracker.cancelPan();
    },
    beforeManualPan() {
      if (controller.isActive) controller.finishNow();
      camera.stopPan();
    },
    beforeAnimatedScroll() {
      // camera.panBy chains glides itself — only the zoom must yield.
      if (controller.isActive) controller.finishNow();
    }
    // No beforeNav: page turns are owned by Reader and re-apply the base
    // through the pageKey effect.
  };

  function handleWheel(e: WheelEvent) {
    const modifier = e.ctrlKey || e.metaKey;
    if (wheelIntentIsZoom(modifier, $settings.swapWheelBehavior)) {
      e.preventDefault();
      motion.beforeZoom();
      controller.wheelZoom(e);
      return;
    }
    e.preventDefault();
    motion.beforeAnimatedScroll();
    camera.panBy(0, -normalizeWheelDelta(e.deltaY, e.deltaMode));
  }

  function doubleTap(x: number, y: number) {
    const levels = pagedLevels(session.baseScale, session.fitScale);
    const target = doubleTapTarget(controller.currentZoom, levels[0]);
    motion.beforeZoom();
    // Zooming in animates the tapped content toward the CLAMPED center
    // position — aiming at the raw center fights the bounds near edges.
    controller.animateToLevel(
      target,
      { x, y },
      target >= 2 ? camera.projectCentered({ x, y }, target) : { x, y }
    );
  }

  function scrollImage(direction: 'up' | 'down') {
    motion.beforeAnimatedScroll();
    const amount = viewportHeight * 0.75;
    camera.panBy(0, direction === 'down' ? -amount : amount);
  }

  function zoomFitToScreen() {
    // Show the whole page without changing the persisted mode — the next
    // page turn re-applies the user's zoomDefault.
    applyPagedBase(
      { camera, controller, state: session },
      'zoomFitToScreen',
      contentSize,
      { width: viewportWidth, height: viewportHeight },
      rtl
    );
  }

  const api: PagedZoomApi = {
    scrollImage,
    zoomFitToScreen
  };

  // ============================================================
  // Pointer gestures — classification lives in PointerGestureTracker
  // (src/lib/reader/input/pointer-tracker.ts); this config holds only the
  // paged surface's policy:
  //
  // - capture 'deferred': gutter-button clicks and text-selection drags
  //   deliver natively; capture engages only once a drag crosses threshold
  // - mouse/pen on a text box is a selection drag, never a pan; touch has no
  //   drag-selection gesture, so touch pans everywhere (exactly like the old
  //   panzoom touch path)
  // - swipe-to-flip is classified HERE from pan summaries (onPanEnd below),
  //   edge-gated via press-time camera state (#186)
  // - pan deltas are incremental — the camera accumulates them
  // - isPinchAlive lets the tracker resurrect a pinch whose controller state
  //   was cleared mid-gesture by a base re-application (rotation, page turn)
  // ============================================================

  // Edge state sampled at press, BEFORE the pan moves the camera — swipe
  // classification needs to know what was hidden when the gesture began.
  let edgeAtPress = { canRevealLeft: false, canRevealRight: false };

  const tracker = new PointerGestureTracker({
    getElement: () => wrapperEl,
    capturePolicy: 'deferred',
    suppressPan: (e) => {
      if (gestureTargetRole(e.target) !== 'textbox') return false;
      // Any press on a text box marks the next outside tap as a dismissal.
      taps.noteTextBoxInteraction();
      return e.pointerType !== 'touch';
    },
    onPress: () => {
      motion.beforeManualPan();
      edgeAtPress = camera.edgeState();
      // Track the drag for an inertial fling on release.
      camera.kineticStart();
    },
    onPanMove: (_p, d) => camera.adjustView(-d.dx, -d.dy),
    onPanEnd: (s) => {
      const side =
        $settings.mobile && !s.cancelled
          ? classifySwipe({
              summary: s,
              wasPinch: tracker.wasPinch,
              viewport: { width: viewportWidth, height: viewportHeight },
              thresholdPercent: $settings.swipeThreshold,
              canRevealLeftAtStart: edgeAtPress.canRevealLeft,
              canRevealRightAtStart: edgeAtPress.canRevealRight
            })
          : null;
      if (side) {
        // The gesture flipped the page — the new page re-applies its base,
        // so drop any momentum rather than flinging the outgoing page.
        camera.stopPan();
        onPageFlip?.(side);
      } else if (s.cancelled) {
        // OS-cancelled gesture: drop the momentum and settle in place.
        camera.stopPan();
        camera.settle();
      } else {
        // Normal release: glide with inertia (or settle if too slow).
        camera.kineticStop();
      }
    },
    // The finger remaining after a pinch keeps panning (the old panzoom
    // pinch→drag handoff) — safe here because deltas are incremental.
    pinchSurvivorPans: true,
    ...zoomGestureConfig({
      beforeZoom: () => motion.beforeZoom(),
      controller,
      getViewport: () => ({ width: viewportWidth, height: viewportHeight })
    })
  });

  // 'immediate' reproduces the native click/click/dblclick sequence this
  // surface was built on — instant overlay toggles, zoom on the second tap.
  const taps = new TapDiscriminator({
    commitPolicy: 'immediate',
    // Native dblclick (which this surface used before) required the clicks
    // to land near each other — keep that gate.
    maxDoubleTapDistancePx: 40,
    onTap: () => onOverlayToggle?.(),
    onDoubleTap: (x, y) => doubleTap(x, y)
  });

  function handleClick(e: MouseEvent) {
    if (gestureTargetRole(e.target) !== 'page') return;
    if (tracker.wasDrag) return;
    taps.tap(e.clientX, e.clientY);
  }

  onMount(() => {
    pagedZoom.set(api);
    tracker.attach();
    wrapperEl?.addEventListener('wheel', handleWheel, { passive: false });
  });

  onDestroy(() => {
    pagedZoom.set(undefined);
    tracker.detach();
    taps.cancel();
    wrapperEl?.removeEventListener('wheel', handleWheel);
    controller.destroy();
    camera.destroy();
  });
</script>

<svelte:window onresize={handleResize} />

<div
  bind:this={wrapperEl}
  data-mokuro-reader
  style:touch-action="none"
  onclick={handleClick}
  role="none"
>
  {@render children?.()}
</div>
