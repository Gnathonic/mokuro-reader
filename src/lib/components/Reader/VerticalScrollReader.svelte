<script lang="ts">
  import type { Page, VolumeMetadata } from '$lib/types';
  import type { VolumeSettings } from '$lib/settings/volume-data';
  import { settings, invertColorsActive } from '$lib/settings';
  import { matchFilesToPages } from '$lib/reader/image-cache';
  import { getCharCount } from '$lib/util/count-chars';
  import { activityTracker } from '$lib/util/activity-tracker';
  import MangaPage from './MangaPage.svelte';
  import { ScrollAnimator } from '$lib/reader/scroll-animator';
  import { Animator } from '$lib/reader/animator';
  import { screenToContent, computeScrollPosition } from '$lib/reader/zoom-math';
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
    // zoomFitToWidth (default) — always fill viewport width, upscale if needed
    return {
      width: '100%',
      maxWidth: '',
      height: 'auto'
    };
  }

  // ============================================================
  // Zoom — CSS zoom on the scroll content
  // ============================================================

  let userZoom = $state(1);
  let zoomTarget = 1;
  const ZOOM_LEVELS = [1, 1.5, 2, 3];

  // Zoom anchor — content-space point to keep fixed on screen during zoom
  let zoomAnchorContentX = 0;
  let zoomAnchorContentY = 0;
  let zoomAnchorScreenX = 0;
  let zoomAnchorScreenY = 0;
  let zoomWrapperEl: HTMLDivElement | undefined = $state();
  let zoomSpacerEl: HTMLDivElement | undefined = $state();

  // Zoom animator — GPU-composited via transform: scale()
  // Updates transform + spacer dimensions + scroll position directly (no Svelte re-render)
  // Wrapper offset is 0,0 — centering spacers are INSIDE the wrapper,
  // so contentY from getBoundingClientRect already includes the spacer offset.
  const WRAPPER_OFFSET_X = 0;
  const WRAPPER_OFFSET_Y = 0;

  const zoomAnimator = new Animator(
    1,
    (currentZoom) => {
      if (!zoomWrapperEl || !scrollContainer || !zoomSpacerEl) return;

      // 1. Set spacer dimensions for scroll bounds.
      // Use viewportWidth as base (not wrapper.offsetWidth which stretches to fill spacer
      // and creates an exponential feedback loop).
      // Height uses wrapper.offsetHeight which is stable (determined by stacked content, not parent).
      zoomSpacerEl.style.width = currentZoom > 1 ? `${viewportWidth * currentZoom}px` : '';
      zoomSpacerEl.style.minHeight = `${zoomWrapperEl.offsetHeight * currentZoom + viewportHeight}px`;

      // 2. Apply transform
      zoomWrapperEl.style.transform = currentZoom !== 1 ? `scale(${currentZoom})` : '';

      // 3. Force layout
      void scrollContainer.scrollWidth;

      // 4. Set scroll using tested math
      const { scrollLeft, scrollTop } = computeScrollPosition(
        zoomAnchorContentX,
        zoomAnchorContentY,
        zoomAnchorScreenX,
        zoomAnchorScreenY,
        currentZoom,
        WRAPPER_OFFSET_X,
        WRAPPER_OFFSET_Y
      );
      scrollContainer.scrollLeft = scrollLeft;
      scrollContainer.scrollTop = scrollTop;
    },
    {
      factor: 0.25,
      epsilon: 0.005,
      onSettle: () => {
        userZoom = zoomTarget;
        // At zoom 1, clear spacer dimensions and reset horizontal scroll
        if (zoomTarget <= 1 && scrollContainer && zoomSpacerEl) {
          zoomSpacerEl.style.width = '';
          zoomSpacerEl.style.minHeight = '';
          scrollContainer.scrollLeft = 0;
        }
      }
    }
  );

  /**
   * Animate zoom, sampling content at fromScreen and placing it at toScreen.
   * - Wheel zoom: from=cursor, to=cursor (keep cursor point fixed)
   * - Double-tap: from=click, to=center (zoom clicked area to center)
   */
  function animateZoom(
    newZoom: number,
    fromScreenX: number,
    fromScreenY: number,
    toScreenX: number,
    toScreenY: number
  ) {
    if (!scrollContainer || !zoomWrapperEl) return;
    const currentZoom = zoomAnimator.current || 1;

    const wrapperRect = zoomWrapperEl.getBoundingClientRect();

    // Content-space point under the "from" screen position
    zoomAnchorContentX = (fromScreenX - wrapperRect.left) / currentZoom;
    zoomAnchorContentY = (fromScreenY - wrapperRect.top) / currentZoom;

    // Where that content should end up on screen
    zoomAnchorScreenX = toScreenX;
    zoomAnchorScreenY = toScreenY;

    zoomTarget = newZoom;
    zoomAnimator.setTarget(newZoom);
  }

  function cycleZoom(direction: number, anchorX?: number, anchorY?: number) {
    const curIdx = ZOOM_LEVELS.indexOf(zoomTarget);
    let nextIdx = curIdx < 0 ? (direction > 0 ? 1 : 0) : curIdx + direction;
    nextIdx = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, nextIdx));
    const newZoom = ZOOM_LEVELS[nextIdx];
    if (newZoom === zoomTarget) return;

    // Wheel: keep the cursor point fixed on screen
    const ax = anchorX ?? viewportWidth / 2;
    const ay = anchorY ?? viewportHeight / 2;
    animateZoom(newZoom, ax, ay, ax, ay);
  }

  // When zoom mode changes (Z key), stay on the current page.
  // Use lastReportedPage (set by scroll progress tracking) since
  // detectCurrentPage() would see the already-shifted layout.
  let prevZoomMode = $settings.continuousZoomDefault;
  $effect(() => {
    if (zoomMode === prevZoomMode) return;
    prevZoomMode = zoomMode;

    const pageIdx = lastReportedPage - 1;
    tick().then(() => {
      const el = pageElements[pageIdx];
      if (el)
        el.scrollIntoView({
          behavior: 'instant',
          block: pageFitsVertically(pageIdx) ? 'center' : 'start'
        });
    });
  });

  // ============================================================
  // Progress tracking
  // ============================================================

  let lastReportedPage = currentPage;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let pageElements: HTMLDivElement[] = [];

  function detectCurrentPage(): number {
    if (!scrollContainer) return 0;
    const centerY = scrollContainer.scrollTop + scrollContainer.clientHeight / 2;
    let closest = 0;
    let closestDist = Infinity;

    for (let i = 0; i < pageElements.length; i++) {
      const el = pageElements[i];
      if (!el) continue;
      const elCenter = el.offsetTop + el.offsetHeight / 2;
      const dist = Math.abs(elCenter - centerY);
      if (dist < closestDist) {
        closestDist = dist;
        closest = i;
      }
    }
    return closest;
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
    settleTimer = setTimeout(reportProgress, 150);
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
   * Check if a page fits vertically in the viewport at current zoom.
   */
  function pageFitsVertically(pageIdx: number): boolean {
    const el = pageElements[pageIdx];
    if (!el) return false;
    return el.offsetHeight * userZoom <= viewportHeight * 1.05;
  }

  let lastNavPage = currentPage - 1;

  function scrollToPageVertical(pageIdx: number) {
    if (!scroller) return;

    // Past the end — mark complete and exit
    if (pageIdx >= pages.length) {
      const { charCount } = getCharCount(pages, pages.length);
      onPageChange(pages.length, charCount, true);
      onVolumeNav('next');
      return;
    }
    // Before the start — exit
    if (pageIdx < 0) {
      onVolumeNav('prev');
      return;
    }

    lastNavPage = pageIdx;
    const el = pageElements[pageIdx];
    if (!el) return;

    scroller.scrollToElement(el, 'center', pageFitsVertically(pageIdx) ? 'center' : 'start');
  }

  function handleKeydown(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' ||
      target.isContentEditable
    )
      return;
    if (!scrollContainer) return;

    // In fit-to-screen, pages fit viewport — arrows page.
    // In fit-to-width/original, pages can be taller — arrows pan.
    const shouldPanVertically = zoomMode !== 'zoomFitToScreen';

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (shouldPanVertically) {
          scroller?.scrollBy(0, viewportHeight * 0.5);
        } else {
          scrollToPageVertical(detectCurrentPage() + 1);
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (shouldPanVertically) {
          scroller?.scrollBy(0, -viewportHeight * 0.5);
        } else {
          scrollToPageVertical(detectCurrentPage() - 1);
        }
        break;
      case 'ArrowLeft':
        e.preventDefault();
        scroller?.scrollBy(-viewportWidth * 0.5, 0);
        break;
      case 'ArrowRight':
        e.preventDefault();
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
    // TODO: Wheel zoom disabled — targeting causes position loss
    // const swap = $settings.swapWheelBehavior;
    // const isZoom = swap ? !(e.ctrlKey || e.metaKey) : e.ctrlKey || e.metaKey;
    // if (isZoom) {
    // 	e.preventDefault();
    // 	cycleZoom(e.deltaY < 0 ? 1 : -1, e.clientX, e.clientY);
    // }
  }

  // ============================================================
  // Click-drag panning
  // ============================================================

  let isDragging = false;
  let wasDrag = false;
  let textBoxWasActive = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragScrollLeft = 0;
  let dragScrollTop = 0;
  const DRAG_THRESHOLD = 5;

  // Pinch zoom state
  let activePointers = new Map<number, { x: number; y: number }>();
  let isPinching = false;
  let pinchStartDist = 0;
  let pinchStartZoom = 1;

  function pinchDistance(): number {
    const pts = [...activePointers.values()];
    if (pts.length < 2) return 0;
    const dx = pts[1].x - pts[0].x;
    const dy = pts[1].y - pts[0].y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function pinchMidpoint(): { x: number; y: number } {
    const pts = [...activePointers.values()];
    if (pts.length < 2) return { x: 0, y: 0 };
    return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
  }

  function handlePointerDown(e: PointerEvent) {
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if ((e.target as HTMLElement).closest('.textBox')) {
      textBoxWasActive = true;
      return;
    }

    // TODO: Pinch zoom disabled — targeting causes position loss
    // if (activePointers.size === 2) {
    // 	isDragging = false;
    // 	wasDrag = true;
    // 	isPinching = true;
    // 	pinchStartDist = pinchDistance();
    // 	pinchStartZoom = zoomAnimator.current || 1;
    // 	return;
    // }

    if (e.button !== 0) return;

    isDragging = true;
    wasDrag = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragScrollLeft = scrollContainer?.scrollLeft ?? 0;
    dragScrollTop = scrollContainer?.scrollTop ?? 0;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: PointerEvent) {
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (isPinching && activePointers.size >= 2) {
      const dist = pinchDistance();
      if (pinchStartDist > 0) {
        const newZoom = pinchStartZoom * (dist / pinchStartDist);
        const mid = pinchMidpoint();
        // Clamp to zoom level range
        const clamped = Math.max(
          ZOOM_LEVELS[0],
          Math.min(ZOOM_LEVELS[ZOOM_LEVELS.length - 1], newZoom)
        );
        animateZoom(clamped, mid.x, mid.y, mid.x, mid.y);
      }
      return;
    }

    if (!isDragging || !scrollContainer) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;

    if (!wasDrag && dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) {
      wasDrag = true;
      window.getSelection()?.removeAllRanges();
    }

    if (wasDrag) {
      e.preventDefault();
      scrollContainer.scrollTop = dragScrollTop - dy;
      if (userZoom > 1) {
        scrollContainer.scrollLeft = dragScrollLeft - dx;
      }
    }
  }

  function handlePointerUp(e: PointerEvent) {
    activePointers.delete(e.pointerId);

    if (isPinching) {
      if (activePointers.size < 2) {
        isPinching = false;
        // Snap zoomTarget to nearest level for keyboard zoom to work from
        const currentZoom = zoomAnimator.current || 1;
        zoomTarget = ZOOM_LEVELS.reduce((prev, curr) =>
          Math.abs(curr - currentZoom) < Math.abs(prev - currentZoom) ? curr : prev
        );
      }
      return;
    }

    if (isDragging) {
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    isDragging = false;
  }

  // ============================================================
  // Overlay toggle + double-tap zoom
  // ============================================================

  let lastTapTime = 0;
  const DOUBLE_TAP_DELAY = 300;

  function handleClick(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('.textBox')) return;
    if (wasDrag) return;

    // First tap outside after interacting with a text box dismisses it without toggling
    if (textBoxWasActive) {
      textBoxWasActive = false;
      return;
    }

    const now = Date.now();
    // TODO: Double-tap zoom disabled — targeting causes position loss
    // if (now - lastTapTime < DOUBLE_TAP_DELAY) {
    //   lastTapTime = 0;
    //   const curIdx = ZOOM_LEVELS.indexOf(zoomTarget);
    //   const nextIdx = (curIdx + 1) % ZOOM_LEVELS.length;
    //   const newZoom = ZOOM_LEVELS[nextIdx];
    //   if (newZoom !== zoomTarget) {
    //     animateZoom(newZoom, e.clientX, e.clientY, viewportWidth / 2, viewportHeight / 2);
    //   }
    //   return;
    // }
    lastTapTime = now;
    const tapTime = now;
    setTimeout(() => {
      if (lastTapTime === tapTime) onOverlayToggle?.();
    }, DOUBLE_TAP_DELAY);
  }

  // ============================================================
  // Resize
  // ============================================================

  function handleResize() {
    const pageIdx = lastReportedPage - 1;
    viewportWidth = window.innerWidth;
    viewportHeight = window.innerHeight;
    tick().then(() => {
      const el = pageElements[pageIdx];
      if (el)
        el.scrollIntoView({
          behavior: 'instant',
          block: pageFitsVertically(pageIdx) ? 'center' : 'start'
        });
    });
  }

  onMount(() => {
    if (scrollContainer) {
      scroller = new ScrollAnimator(scrollContainer);
    }
    outerDiv?.addEventListener('wheel', handleWheel, { passive: false });
    requestAnimationFrame(() => {
      const el = pageElements[currentPage - 1];
      if (el) el.scrollIntoView({ behavior: 'instant', block: 'start' });
    });
  });

  onDestroy(() => {
    scroller?.destroy();
    zoomAnimator.destroy();
    outerDiv?.removeEventListener('wheel', handleWheel);
    if (settleTimer) clearTimeout(settleTimer);
  });
</script>

<svelte:window onkeydown={handleKeydown} onresize={handleResize} />

<div
  bind:this={outerDiv}
  class="fixed inset-0"
  style:background-color={$settings.backgroundColor}
  style:touch-action="none"
  onpointerdown={handlePointerDown}
  onpointermove={handlePointerMove}
  onpointerup={handlePointerUp}
  onpointercancel={handlePointerUp}
  onclick={handleClick}
  role="none"
>
  <div
    bind:this={scrollContainer}
    class="scrollbar-hide h-full w-full"
    style:overflow-y="auto"
    style:overflow-x="auto"
    style:overscroll-behavior="none"
    onscroll={handleScroll}
  >
    <div bind:this={zoomSpacerEl} style:filter={`invert(${$invertColorsActive ? 1 : 0})`}>
      <div bind:this={zoomWrapperEl} style:transform-origin="top left">
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

<style>
  .scrollbar-hide {
    scrollbar-width: none;
    -ms-overflow-style: none;
  }
  .scrollbar-hide::-webkit-scrollbar {
    display: none;
  }
</style>
