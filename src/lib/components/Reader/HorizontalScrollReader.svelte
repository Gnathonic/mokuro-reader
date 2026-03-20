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
  import { computeScrollPosition } from '$lib/reader/zoom-math';
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
    onVisibleCountChange?: (count: number) => void;
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
    onVisibleCountChange,
    onContextMenu
  }: Props = $props();

  let outerDiv: HTMLDivElement | undefined = $state();
  let scrollContainer: HTMLDivElement | undefined = $state();
  let scroller: ScrollAnimator | null = null;
  let viewportWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1024);
  let viewportHeight = $state(typeof window !== 'undefined' ? window.innerHeight : 768);
  let indexedFiles = $derived.by(() => matchFilesToPages(files, pages));
  let missingPagePaths = $derived(new Set(volume?.missing_page_paths || []));
  let rtl = $derived(volumeSettings.rightToLeft ?? true);
  let zoomMode = $derived($settings.continuousZoomDefault);

  // Page dimensions based on zoom mode
  function pageSize(page: Page): { width: number; height: number } {
    if (zoomMode === 'zoomOriginal') {
      return { width: page.img_width, height: page.img_height };
    }
    if (zoomMode === 'zoomFitToWidth') {
      const scale = viewportWidth / page.img_width;
      return { width: viewportWidth, height: page.img_height * scale };
    }
    // zoomFitToScreen / default: fit to height
    const scale = viewportHeight / page.img_height;
    return { width: page.img_width * scale, height: viewportHeight };
  }

  function scaledWidth(page: Page): number {
    return pageSize(page).width;
  }

  // ============================================================
  // Zoom — CSS zoom on scroll content
  // ============================================================

  let userZoom = $state(1);
  let zoomTarget = 1;
  const ZOOM_LEVELS = [1, 1.5, 2, 3];

  let zoomAnchorContentX = 0;
  let zoomAnchorContentY = 0;
  let zoomAnchorScreenX = 0;
  let zoomAnchorScreenY = 0;
  let zoomWrapperEl: HTMLDivElement | undefined = $state();
  let zoomSpacerEl: HTMLDivElement | undefined = $state();

  // Wrapper offset is 0,0 — centering spacers are INSIDE the wrapper
  const WRAPPER_OFFSET_X = 0;
  const WRAPPER_OFFSET_Y = 0;

  const zoomAnimator = new Animator(
    1,
    (currentZoom) => {
      if (!zoomWrapperEl || !scrollContainer || !zoomSpacerEl) return;

      // Set spacer dimensions (use viewportHeight as base, not offsetHeight which feeds back)
      zoomSpacerEl.style.height = currentZoom > 1 ? `${viewportHeight * currentZoom}px` : '';
      zoomSpacerEl.style.width = currentZoom > 1 ? `${viewportWidth * currentZoom}px` : '';

      // Apply transform
      zoomWrapperEl.style.transform = currentZoom !== 1 ? `scale(${currentZoom})` : '';

      // Force layout
      void scrollContainer.scrollWidth;

      // Set scroll using tested math
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
        if (zoomTarget <= 1 && scrollContainer && zoomSpacerEl) {
          zoomSpacerEl.style.width = '';
          zoomSpacerEl.style.height = '';
          scrollContainer.scrollTop = 0;
        }
      }
    }
  );

  /**
   * Animate zoom: sample content at fromScreen, place at toScreen.
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

    zoomAnchorContentX = (fromScreenX - wrapperRect.left) / currentZoom;
    zoomAnchorContentY = (fromScreenY - wrapperRect.top) / currentZoom;
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

    const ax = anchorX ?? viewportWidth / 2;
    const ay = anchorY ?? viewportHeight / 2;
    animateZoom(newZoom, ax, ay, ax, ay);
  }

  // When zoom mode changes (Z key), stay on the current page
  let prevZoomMode = $settings.continuousZoomDefault;
  $effect(() => {
    if (zoomMode === prevZoomMode) return;
    prevZoomMode = zoomMode;

    const pageIdx = lastReportedPage - 1;
    tick().then(() => {
      const el = pageElements[pageIdx];
      if (el) el.scrollIntoView({ behavior: 'instant', inline: 'center' });
    });
  });

  // ============================================================
  // Progress tracking
  // ============================================================

  let lastReportedPage = currentPage;
  let navTarget = $state(currentPage - 1);
  let navIsKeyboard = false; // true when navTarget was set by keyboard, not scroll
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let pageElements: HTMLDivElement[] = [];

  /**
   * Check how much of a page is visible in the viewport (0-1 ratio).
   */
  function visibilityRatio(el: HTMLElement, containerRect: DOMRect): number {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const visibleLeft = Math.max(rect.left, containerRect.left);
    const visibleRight = Math.min(rect.right, containerRect.right);
    return Math.max(0, visibleRight - visibleLeft) / rect.width;
  }

  /**
   * Detect current page: the >95% visible page whose center is closest
   * to the viewport center. Falls back to any page with center in viewport.
   */
  function detectCurrentPage(): number {
    if (!scrollContainer) return navTarget;
    const containerRect = scrollContainer.getBoundingClientRect();
    const viewportCenter = containerRect.left + containerRect.width / 2;

    // Primary: among >95% visible pages, pick the one closest to viewport center
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < pageElements.length; i++) {
      const el = pageElements[i];
      if (!el) continue;
      if (visibilityRatio(el, containerRect) > 0.95) {
        const rect = el.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const dist = Math.abs(centerX - viewportCenter);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }
    }
    if (bestIdx >= 0) return bestIdx;

    // Fallback: page with center closest to viewport center
    for (let i = 0; i < pageElements.length; i++) {
      const el = pageElements[i];
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      if (centerX >= containerRect.left && centerX <= containerRect.right) {
        const dist = Math.abs(centerX - viewportCenter);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }
    }

    return bestIdx >= 0 ? bestIdx : navTarget;
  }

  function reportProgress() {
    // Use navTarget directly — it's set by detectCurrentPage (center-most visible)
    // on manual scroll settle, or by navigateToPage on keyboard nav.
    const pageNum = Math.min(navTarget + 1, pages.length);
    if (pageNum !== lastReportedPage) {
      lastReportedPage = pageNum;
      const { charCount } = getCharCount(pages, pageNum);
      onPageChange(pageNum, charCount, pageNum >= pages.length);
    }

    // Report how many pages are visible for the page counter display
    if (onVisibleCountChange && scrollContainer) {
      const containerRect = scrollContainer.getBoundingClientRect();
      let count = 0;
      for (let i = 0; i < pageElements.length; i++) {
        const el = pageElements[i];
        if (!el) continue;
        if (visibilityRatio(el, containerRect) > 0.95) count++;
      }
      onVisibleCountChange(Math.max(count, 1));
    }
  }

  function handleScroll() {
    if (!scrollContainer) return;
    scroller?.onScroll();
    activityTracker.recordActivity();

    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      // On settle, sync navTarget from DOM only if it wasn't set by keyboard
      if (!navIsKeyboard) {
        navTarget = detectCurrentPage();
      }
      navIsKeyboard = false;
      reportProgress();
    }, 150);
  }

  // External page change
  $effect(() => {
    if (currentPage !== lastReportedPage && scroller) {
      lastReportedPage = currentPage;
      navigateToPage(currentPage - 1);
    }
  });

  // ============================================================
  // Keyboard
  // ============================================================

  /**
   * Count how many pages are currently fully visible in the viewport.
   */

  /**
   * Navigate to a page. If the target is past the boundaries,
   * exit to the series page instead. Home/End use clamp=true
   * to stay at the boundary without exiting.
   */
  function navigateToPage(pageIdx: number) {
    if (!scroller || !scrollContainer) return;

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
    navTarget = pageIdx;
    navIsKeyboard = true;
    const el = pageElements[pageIdx];
    if (!el) return;

    // Cover page is always displayed alone
    const isCoverAlone = volumeSettings.hasCover && pageIdx === 0;

    // If a neighbor fits and it's not the cover page, center the pair
    if (!isCoverAlone) {
      const neighbor = pageIdx + 1 < pages.length ? pageIdx + 1 : pageIdx - 1;
      // Don't pair with the cover page either
      const neighborIsCover = volumeSettings.hasCover && neighbor === 0;
      const neighborEl = neighbor >= 0 && !neighborIsCover ? pageElements[neighbor] : null;

      if (neighborEl) {
        const elRect = el.getBoundingClientRect();
        const neighborRect = neighborEl.getBoundingClientRect();
        if (elRect.width + neighborRect.width <= scrollContainer.clientWidth + 2) {
          scroller.scrollToPairCenter(el, neighborEl);
          return;
        }
      }
    }

    scroller.scrollToElement(el, 'center', 'center');
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

    // Always use navTarget — it's authoritative.
    // Set by navigateToPage() on keyboard nav, synced by manual scroll.
    const current = navTarget;
    const leftDelta = rtl ? 1 : -1;

    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        navigateToPage(current + leftDelta);
        break;
      case 'ArrowRight':
        e.preventDefault();
        navigateToPage(current - leftDelta);
        break;
      case 'ArrowUp':
        e.preventDefault();
        scroller?.scrollBy(0, -viewportHeight * 0.5);
        break;
      case 'ArrowDown':
        e.preventDefault();
        scroller?.scrollBy(0, viewportHeight * 0.5);
        break;
      case 'PageDown':
      case ' ': {
        e.preventDefault();
        // Jump 1 from cover page, 2 otherwise
        const fwd = volumeSettings.hasCover && current === 0 ? 1 : 2;
        navigateToPage(current + fwd);
        break;
      }
      case 'PageUp': {
        e.preventDefault();
        // Jump 1 when landing on cover page, 2 otherwise
        const back = volumeSettings.hasCover && current <= 2 ? 1 : 2;
        navigateToPage(current - back);
        break;
      }
      case 'Home':
        e.preventDefault();
        navigateToPage(0);
        break;
      case 'End':
        e.preventDefault();
        navigateToPage(pages.length - 1);
        break;
    }
  }

  // ============================================================
  // Wheel — scroll along strip or zoom
  // ============================================================

  function handleWheel(e: WheelEvent) {
    if (!scrollContainer) return;
    // TODO: Wheel zoom disabled — targeting causes position loss
    // const swap = $settings.swapWheelBehavior;
    // const isZoom = swap ? !(e.ctrlKey || e.metaKey) : e.ctrlKey || e.metaKey;
    // if (isZoom) {
    //   e.preventDefault();
    //   cycleZoom(e.deltaY < 0 ? 1 : -1, e.clientX, e.clientY);
    // } else {
    // Convert vertical wheel to horizontal scroll
    e.preventDefault();
    const delta = rtl ? -e.deltaY : e.deltaY;
    scrollContainer.scrollLeft += delta;
    // }
  }

  // ============================================================
  // Click-drag panning
  // ============================================================

  let isDragging = false;
  let wasDrag = false;
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

    if ((e.target as HTMLElement).closest('.textBox')) return;

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
      document.body.style.userSelect = 'none';
    }

    if (wasDrag) {
      e.preventDefault();
      scrollContainer.scrollLeft = dragScrollLeft - dx;
      if (userZoom > 1) {
        scrollContainer.scrollTop = dragScrollTop - dy;
      }
    }
  }

  function handlePointerUp(e: PointerEvent) {
    activePointers.delete(e.pointerId);

    if (isPinching) {
      if (activePointers.size < 2) {
        isPinching = false;
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
      document.body.style.userSelect = '';
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
    const wasLandscape = viewportWidth > viewportHeight;
    const pageIdx = lastReportedPage - 1;
    viewportWidth = window.innerWidth;
    viewportHeight = window.innerHeight;
    const isLandscape = viewportWidth > viewportHeight;

    tick().then(() => {
      if (isLandscape && !wasLandscape) {
        // Rotated to landscape — center pair if both fit
        navigateToPage(pageIdx);
      } else {
        // Rotated to portrait or just resized — use current page
        const el = pageElements[pageIdx];
        if (el) el.scrollIntoView({ behavior: 'instant', inline: 'center' });
      }
    });
  }

  onMount(() => {
    if (scrollContainer) {
      scroller = new ScrollAnimator(scrollContainer);
    }
    outerDiv?.addEventListener('wheel', handleWheel, { passive: false });
    requestAnimationFrame(() => {
      // Use navigateToPage for pair centering on landscape mount
      if (scroller) {
        navigateToPage(currentPage - 1);
      } else {
        const el = pageElements[currentPage - 1];
        if (el) el.scrollIntoView({ behavior: 'instant', inline: 'center' });
      }
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
    class="scrollbar-hide flex h-full"
    style:align-items={userZoom > 1 ? 'flex-start' : 'center'}
    style:overflow-x="auto"
    style:overflow-y="auto"
    style:overscroll-behavior="none"
    style:direction={rtl ? 'rtl' : 'ltr'}
    onscroll={handleScroll}
  >
    <div
      bind:this={zoomSpacerEl}
      class="flex"
      style:align-items={userZoom > 1 ? 'flex-start' : 'center'}
      style:direction={rtl ? 'rtl' : 'ltr'}
      style:filter={`invert(${$invertColorsActive ? 1 : 0})`}
    >
      <div
        bind:this={zoomWrapperEl}
        class="flex"
        style:align-items={userZoom > 1 ? 'flex-start' : 'center'}
        style:direction={rtl ? 'rtl' : 'ltr'}
        style:transform-origin="top left"
      >
        <!-- Centering spacer: allows first page to be centered -->
        <div class="flex-shrink-0" style:width="50vw"></div>
        {#each pages as page, i (i)}
          {@const size = pageSize(page)}
          {@const scale = size.height / page.img_height}
          {@const isSpreadPartner =
            $settings.pageGaps &&
            $settings.seamlessSpreads &&
            i === (rtl ? navTarget + 1 : navTarget)}
          {@const gap = !$settings.pageGaps
            ? '-1px'
            : isSpreadPartner
              ? '-1px'
              : `${$settings.scrollGap - 1}px`}
          <div
            bind:this={pageElements[i]}
            class="relative flex-shrink-0 overflow-hidden"
            style:width={`${size.width}px`}
            style:height={`${size.height}px`}
            style:direction="ltr"
            style:margin-right={gap}
          >
            <div
              class="origin-top-left"
              style:transform={`scale(${scale})`}
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
        <!-- Centering spacer: allows last page to be centered -->
        <div class="flex-shrink-0" style:width="50vw"></div>
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
