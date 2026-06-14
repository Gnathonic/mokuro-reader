<script lang="ts">
  import type { Page, VolumeMetadata } from '$lib/types';
  import type { VolumeSettings } from '$lib/settings/volume-data';
  import { settings, imageFilter } from '$lib/settings';
  import { matchFilesToPages } from '$lib/reader/image-cache';
  import { getCharCount } from '$lib/util/count-chars';
  import { activityTracker } from '$lib/util/activity-tracker';
  import MangaPage from './MangaPage.svelte';
  import { ScrollAnimator } from '$lib/reader/scroll-animator';
  import { ContinuousZoomController, type SettleReason } from '$lib/reader/zoom-controller';
  import { applyVerticalZoomLayout } from '$lib/reader/zoom-layout';
  import { closestPageToCenter } from '$lib/reader/page-detection';
  import { normalizeWheelDelta, wheelIntentIsZoom } from '$lib/reader/zoom-math';
  import { gestureTargetRole, keyboardShouldIgnore } from '$lib/reader/input/gesture-target';
  import { volumeEdgeNav } from '$lib/reader/page-nav';
  import { PointerGestureTracker, zoomGestureConfig } from '$lib/reader/input/pointer-tracker';
  import { TapDiscriminator } from '$lib/reader/input/tap';
  import type { MotionGate } from '$lib/reader/input/motion-gate';
  import { onMount, onDestroy, tick } from 'svelte';

  interface Props {
    pages: Page[];
    files: Record<string, File>;
    volume: VolumeMetadata;
    volumeSettings: VolumeSettings;
    currentPage: number;
    onPageChange: (newPage: number, charCount: number, isComplete: boolean) => void;
    onVolumeNav: (direction: 'prev' | 'next') => void;
    onOverlayToggle?: () => void;
    onContextMenu?: (data: any) => void;
  }

  let {
    pages,
    files,
    volume,
    volumeSettings,
    currentPage,
    onPageChange,
    onVolumeNav,
    onOverlayToggle,
    onContextMenu
  }: Props = $props();

  let outerDiv: HTMLDivElement | undefined = $state();
  let scrollContainer: HTMLDivElement | undefined = $state();
  let scroller: ScrollAnimator | null = null;
  let viewportWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1024);
  let viewportHeight = $state(typeof window !== 'undefined' ? window.innerHeight : 768);
  let indexedFiles = $derived.by(() => matchFilesToPages(files, pages));
  let missingPagePaths = $derived(new Set(volume?.missing_page_paths || []));
  let zoomMode = $derived($settings.continuousZoomDefault);

  // Base scale for each page based on zoom mode
  function pageStyle(page: Page): { width: string; maxWidth: string; height: string } {
    if (zoomMode === 'zoomOriginal') {
      return {
        width: `${page.img_width}px`,
        maxWidth: `${page.img_width}px`,
        height: `${page.img_height}px`
      };
    }
    if (zoomMode === 'zoomFitToScreen') {
      // Scale so the entire page fits in the viewport
      const scaleW = viewportWidth / page.img_width;
      const scaleH = viewportHeight / page.img_height;
      const scale = Math.min(scaleW, scaleH);
      return {
        width: `${page.img_width * scale}px`,
        maxWidth: `${page.img_width * scale}px`,
        height: `${page.img_height * scale}px`
      };
    }
    // zoomFillScreen (default; legacy persisted zoomFitToWidth lands here).
    // The strip axis always overflows in continuous mode, so filling the
    // screen means filling the CROSS axis — the width here. In horizontal
    // mode the same setting fills the height, which is what makes it safe
    // under "match orientation" rotation (fit-to-width was not).
    return {
      width: '100%',
      maxWidth: '',
      height: 'auto'
    };
  }

  // ============================================================
  // Zoom — transform scale + measurement-based scroll correction
  // ============================================================

  let zoomWrapperEl: HTMLDivElement | undefined = $state();
  let zoomSpacerEl: HTMLDivElement | undefined = $state();
  let isZoomed = $state(false);

  /**
   * Widest page's scaled layout width at the current zoom mode — the zoomed
   * wrapper pins to this (not the viewport width) so empty side margins
   * never become pannable scroll range.
   */
  function maxContentWidth(): number {
    let max = 0;
    for (const page of pages) {
      let width: number;
      if (zoomMode === 'zoomOriginal') {
        width = page.img_width;
      } else if (zoomMode === 'zoomFitToScreen') {
        const scale = Math.min(viewportWidth / page.img_width, viewportHeight / page.img_height);
        width = page.img_width * scale;
      } else {
        width = viewportWidth; // zoomFillScreen — fills the cross axis
      }
      if (width > max) max = width;
    }
    return max || viewportWidth;
  }

  // Reader-specific zoomed layout — shared with the e2e suite, see zoom-layout.ts
  function applyZoomLayout(zoom: number) {
    if (!zoomWrapperEl || !zoomSpacerEl) return;
    applyVerticalZoomLayout(
      { wrapper: zoomWrapperEl, spacer: zoomSpacerEl },
      { width: viewportWidth, height: viewportHeight },
      maxContentWidth(),
      zoom
    );
  }

  function handleZoomSettled(zoom: number, reason: SettleReason) {
    if (zoom <= 1 && scrollContainer) {
      // Reset the cross axis only when no scroll range legitimately remains
      // at 1× (zoomOriginal pages wider than the viewport keep theirs).
      if (scrollContainer.scrollWidth <= scrollContainer.clientWidth + 1) {
        scrollContainer.scrollLeft = 0;
      }
    }
    // 'nav' settles are superseded by the navigation that caused them, and
    // 'reset' settles have stale scroll geometry the caller re-anchors next.
    if (reason === 'gesture' || reason === 'interrupt') reportProgress();
  }

  const zoomController = new ContinuousZoomController({
    getScrollContainer: () => scrollContainer,
    getPageElements: () => pageElements,
    getViewport: () => ({ width: viewportWidth, height: viewportHeight }),
    applyZoomLayout,
    onZoomedChange: (zoomed) => {
      isZoomed = zoomed;
    },
    onSettled: handleZoomSettled
  });

  /**
   * Interrupt choke points — see MotionGate for the contract. Notable here:
   * beforeNav resyncs the scroller because its state only updates via async
   * scroll events; without sync() the next scrollBy would animate from a
   * stale position and undo the zoom's final correction.
   */
  const motion: MotionGate = {
    beforeZoom() {
      scroller?.stop();
      tracker.cancelPan();
    },
    beforeManualPan() {
      if (zoomController.isActive) zoomController.finishNow();
      scroller?.stop();
    },
    beforeAnimatedScroll() {
      if (zoomController.isActive) zoomController.finishNow();
    },
    beforeNav() {
      if (!zoomController.isActive) return;
      zoomController.finishNow('nav');
      scroller?.sync();
    }
  };

  // When the zoom mode (Z key) or a layout-affecting setting changes, reset
  // any user zoom (its measured spacer/transform are stale against the new
  // layout) and stay on the current page. Use lastReportedPage (set by
  // scroll progress tracking) since detectCurrentPage() would see the
  // already-shifted layout.
  let prevLayoutKey = `${$settings.continuousZoomDefault}|${$settings.pageDividers}|${$settings.scrollGap}`;
  $effect(() => {
    const layoutKey = `${zoomMode}|${$settings.pageDividers}|${$settings.scrollGap}`;
    if (layoutKey === prevLayoutKey) return;
    prevLayoutKey = layoutKey;

    const pageIdx = lastReportedPage - 1;
    zoomController.reset();
    tick().then(() => reanchorToPage(pageIdx));
  });

  // ============================================================
  // Progress tracking
  // ============================================================

  let lastReportedPage = currentPage;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let pageElements: HTMLDivElement[] = [];

  /**
   * Current page = element whose visual center is closest to the viewport
   * center. Uses getBoundingClientRect (visual space) so it stays correct
   * under the zoom transform — offsetTop is unscaled layout space and
   * diverges from scroll coordinates as soon as zoom != 1.
   */
  function detectCurrentPage(): number {
    if (!scrollContainer) return 0;
    return closestPageToCenter(
      scrollContainer.getBoundingClientRect(),
      pageElements.map((el) => el?.getBoundingClientRect()),
      'y'
    );
  }

  function reportProgress() {
    const pageIdx = detectCurrentPage();
    const pageNum = pageIdx + 1;
    if (pageNum !== lastReportedPage) {
      lastReportedPage = pageNum;
      const { charCount } = getCharCount(pages, pageNum);
      onPageChange(pageNum, charCount, pageNum >= pages.length);
    }
  }

  function handleScroll() {
    if (!scrollContainer) return;
    scroller?.onScroll();
    activityTracker.recordActivity();

    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      // Mid-zoom layout is in flux; the zoom settle hook reports instead.
      if (zoomController.isActive) return;
      reportProgress();
    }, 150);
  }

  // External page change
  $effect(() => {
    if (currentPage !== lastReportedPage && scrollContainer) {
      lastReportedPage = currentPage;
      scrollToPageVertical(currentPage - 1);
    }
  });

  // ============================================================
  // Keyboard
  // ============================================================

  /**
   * Check if a page fits vertically in the viewport at the current zoom.
   * Visual rect height is transform-aware for any zoom value.
   */
  function pageFitsVertically(pageIdx: number): boolean {
    const el = pageElements[pageIdx];
    if (!el) return false;
    return el.getBoundingClientRect().height <= viewportHeight * 1.05;
  }

  /** Instant re-anchor after a layout reset (zoom-mode change, resize). */
  function reanchorToPage(pageIdx: number) {
    const el = pageElements[pageIdx];
    if (el)
      el.scrollIntoView({
        behavior: 'instant',
        block: pageFitsVertically(pageIdx) ? 'center' : 'start'
      });
  }

  function scrollToPageVertical(pageIdx: number) {
    if (!scroller) return;

    if (volumeEdgeNav(pageIdx, pages, onPageChange, onVolumeNav)) return;

    motion.beforeNav?.();
    const el = pageElements[pageIdx];
    if (!el) return;

    scroller.scrollToElement(el, 'center', pageFitsVertically(pageIdx) ? 'center' : 'start');
  }

  function handleKeydown(e: KeyboardEvent) {
    if (keyboardShouldIgnore(e.target)) return;
    if (!scrollContainer) return;

    // In fit-to-screen, pages fit viewport — arrows page.
    // In fit-to-width/original, pages can be taller — arrows pan.
    const shouldPanVertically = zoomMode !== 'zoomFitToScreen';

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (shouldPanVertically) {
          motion.beforeNav?.();
          scroller?.scrollBy(0, viewportHeight * 0.5);
        } else {
          scrollToPageVertical(detectCurrentPage() + 1);
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (shouldPanVertically) {
          motion.beforeNav?.();
          scroller?.scrollBy(0, -viewportHeight * 0.5);
        } else {
          scrollToPageVertical(detectCurrentPage() - 1);
        }
        break;
      case 'ArrowLeft':
        e.preventDefault();
        motion.beforeNav?.();
        scroller?.scrollBy(-viewportWidth * 0.5, 0);
        break;
      case 'ArrowRight':
        e.preventDefault();
        motion.beforeNav?.();
        scroller?.scrollBy(viewportWidth * 0.5, 0);
        break;
      case 'PageDown':
      case ' ':
        e.preventDefault();
        scrollToPageVertical(detectCurrentPage() + 1);
        break;
      case 'PageUp':
        e.preventDefault();
        scrollToPageVertical(detectCurrentPage() - 1);
        break;
      case 'Home':
        e.preventDefault();
        scrollToPageVertical(0);
        break;
      case 'End':
        e.preventDefault();
        scrollToPageVertical(pages.length - 1);
        break;
    }
  }

  // ============================================================
  // Wheel — scroll or zoom
  // ============================================================

  function handleWheel(e: WheelEvent) {
    if (!scrollContainer) return;
    const modifier = e.ctrlKey || e.metaKey;

    if (wheelIntentIsZoom(modifier, $settings.swapWheelBehavior)) {
      e.preventDefault();
      motion.beforeZoom();
      zoomController.wheelZoom(e);
      return;
    }

    if (modifier) {
      // Swap mode: modifier+wheel is the scroll intent. Scroll manually —
      // letting it fall through would trigger browser page zoom instead.
      e.preventDefault();
      motion.beforeAnimatedScroll();
      scrollContainer.scrollTop += normalizeWheelDelta(e.deltaY, e.deltaMode);
      return;
    }

    // Bare wheel scrolls natively; don't let it fight an active zoom.
    motion.beforeAnimatedScroll();
  }

  // ============================================================
  // Click-drag panning — classification lives in PointerGestureTracker
  // (src/lib/reader/input/pointer-tracker.ts); this config holds only the
  // scroll surface's policy:
  //
  // - capture 'immediate': the whole surface is one big drag target, so
  //   capture on press (the old behavior) — clicks still fire normally
  // - a press on a text box never pans, for ANY pointer type: drag there is
  //   text selection (Yomitan/Migaku scanning)
  // - pan writes absolute scroll positions from press-time baselines
  //   (totals), with horizontal gated on actual overflow
  // - no pinch-survivor pan: an absolute-baseline pan starting mid-settle
  //   would fight the post-pinch snap animation
  // ============================================================

  let dragScrollLeft = 0;
  let dragScrollTop = 0;

  const tracker = new PointerGestureTracker({
    getElement: () => outerDiv,
    capturePolicy: 'immediate',
    suppressPan: (e) => {
      if (gestureTargetRole(e.target) === 'textbox') {
        taps.noteTextBoxInteraction();
        return true;
      }
      return false;
    },
    onPress: () => {
      motion.beforeManualPan();
      dragScrollLeft = scrollContainer?.scrollLeft ?? 0;
      dragScrollTop = scrollContainer?.scrollTop ?? 0;
    },
    onPanMove: (_p, d) => {
      if (!scrollContainer) return;
      scrollContainer.scrollTop = dragScrollTop - d.totalDy;
      if (isZoomed || scrollContainer.scrollWidth > scrollContainer.clientWidth + 1) {
        scrollContainer.scrollLeft = dragScrollLeft - d.totalDx;
      }
    },
    ...zoomGestureConfig({
      beforeZoom: () => motion.beforeZoom(),
      controller: zoomController,
      getViewport: () => ({ width: viewportWidth, height: viewportHeight })
    })
  });

  // ============================================================
  // Overlay toggle + double-tap zoom
  // ============================================================

  const taps = new TapDiscriminator({
    onTap: () => onOverlayToggle?.(),
    onDoubleTap: (x, y) => {
      motion.beforeZoom();
      zoomController.toggleZoom(x, y);
    }
  });

  function handleClick(e: MouseEvent) {
    if (gestureTargetRole(e.target) !== 'page') return;
    if (tracker.wasDrag) return;
    taps.tap(e.clientX, e.clientY);
  }

  // ============================================================
  // Resize
  // ============================================================

  function handleResize() {
    const pageIdx = lastReportedPage - 1;
    zoomController.reset();
    viewportWidth = window.innerWidth;
    viewportHeight = window.innerHeight;
    tick().then(() => reanchorToPage(pageIdx));
  }

  onMount(() => {
    if (scrollContainer) {
      scroller = new ScrollAnimator(scrollContainer);
    }
    outerDiv?.addEventListener('wheel', handleWheel, { passive: false });
    tracker.attach();
    requestAnimationFrame(() => {
      const el = pageElements[currentPage - 1];
      if (el) el.scrollIntoView({ behavior: 'instant', block: 'start' });
    });
  });

  onDestroy(() => {
    scroller?.destroy();
    zoomController.destroy();
    outerDiv?.removeEventListener('wheel', handleWheel);
    tracker.detach();
    taps.cancel();
    if (settleTimer) clearTimeout(settleTimer);
  });
</script>

<svelte:window onkeydown={handleKeydown} onresize={handleResize} />

<div
  bind:this={outerDiv}
  class="fixed inset-0"
  style:background-color="var(--reader-bg)"
  style:touch-action="none"
  onclick={handleClick}
  role="none"
>
  <div
    bind:this={scrollContainer}
    class="scrollbar-hide h-full w-full"
    style:overflow-y="auto"
    style:overflow-x="auto"
    style:overscroll-behavior="none"
    style:overflow-anchor="none"
    onscroll={handleScroll}
  >
    <div bind:this={zoomSpacerEl} style:filter={$imageFilter}>
      <!-- transform-origin is set by applyVerticalZoomLayout -->
      <div bind:this={zoomWrapperEl}>
        <!-- Centering spacer -->
        <div style:height="50vh"></div>
        {#each pages as page, i (i)}
          {@const ps = pageStyle(page)}
          {@const displayWidth = ps.height === 'auto' ? viewportWidth : parseFloat(ps.width)}
          {@const scale = displayWidth / page.img_width}
          <div
            bind:this={pageElements[i]}
            class="relative mx-auto overflow-hidden"
            style:width={ps.width}
            style:max-width={ps.maxWidth}
            style:aspect-ratio={ps.height === 'auto'
              ? `${page.img_width} / ${page.img_height}`
              : undefined}
            style:height={ps.height !== 'auto' ? ps.height : undefined}
            style:margin-bottom={$settings.pageDividers ? `${$settings.scrollGap - 1}px` : '-1px'}
          >
            <div
              class="origin-top-left"
              style:transform={scale !== 1 ? `scale(${scale})` : undefined}
              style:width={`${page.img_width}px`}
              style:height={`${page.img_height}px`}
            >
              <MangaPage
                {page}
                src={indexedFiles[i]}
                volumeUuid={volume.volume_uuid}
                pageIndex={i}
                forceVisible={missingPagePaths.has(page.img_path)}
                {onContextMenu}
              />
            </div>
          </div>
        {/each}
        <!-- Centering spacer -->
        <div style:height="50vh"></div>
      </div>
    </div>
  </div>
</div>
