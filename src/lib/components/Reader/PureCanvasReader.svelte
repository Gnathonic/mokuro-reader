<script lang="ts">
  import type { Page, VolumeMetadata } from '$lib/types';
  import type { VolumeSettings } from '$lib/settings';
  import { settings, invertColorsActive, updateVolumeSetting } from '$lib/settings';
  import { volumes } from '$lib/settings/volume-data';
  import Pica from 'pica';
  import { findSpreadForPage, type PageSpread } from '$lib/reader/spread-grouping';
  import { shouldShowSinglePage, calculateMedianPageWidth } from '$lib/reader/page-mode-detection';
  import { updateCacheStrategy } from '$lib/reader/canvas-cache';
  import { getCharCount } from '$lib/util/count-chars';
  import { activityTracker } from '$lib/util/activity-tracker';
  import { ImageCache } from '$lib/reader/image-cache';
  import { onMount, onDestroy, tick, untrack } from 'svelte';
  import TextBoxes from './TextBoxes.svelte';

  interface Props {
    pages: Page[];
    files: Record<string, File>;
    volume: VolumeMetadata;
    volumeSettings: VolumeSettings;
    currentPage: number;
    onPageChange: (newPage: number, charCount: number, isComplete: boolean) => void;
    onVolumeNav: (direction: 'prev' | 'next') => void;
    onOverlayToggle?: () => void;
  }

  let {
    pages,
    files,
    volume,
    volumeSettings,
    currentPage,
    onPageChange,
    onVolumeNav,
    onOverlayToggle
  }: Props = $props();

  // ============================================
  // CORE STATE
  // ============================================

  // Transform state - NOT using panzoom, we control everything
  // Note: In continuous mode, scale is a user zoom MULTIPLIER on top of per-spread calculated scales
  let transform = $state({ x: 0, y: 0, scale: 1 });

  // User zoom multiplier (applied on top of per-spread scales)
  let userZoomMultiplier = $state(1);

  // Canvas refs
  let canvasEl: HTMLCanvasElement | undefined = $state();
  let ctx: CanvasRenderingContext2D | null = null;

  // Zoom settling detection
  let isZooming = $state(false);
  let zoomSettleTimeout: ReturnType<typeof setTimeout> | null = null;
  const ZOOM_SETTLE_DELAY = 150; // ms after last zoom action

  // Track the zoom level pageCanvases were rendered at
  let pageCanvasesZoom = $state(1);
  let pageCanvasesSpreadScale = new Map<number, number>(); // pageIndex -> spread scale used

  // Counter to force cache effect to re-run (incremented when cache is invalidated)
  let cacheInvalidationCounter = $state(0);

  // Text overlay ref (for direct DOM manipulation)
  let textOverlayEl: HTMLDivElement | undefined = $state();

  // Viewport dimensions
  let viewportWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1920);
  let viewportHeight = $state(typeof window !== 'undefined' ? window.innerHeight : 1080);

  // Pre-rendered page canvases (OffscreenCanvas where supported)
  let pageCanvases = new Map<number, OffscreenCanvas | HTMLCanvasElement>();

  // Pica instances for high-quality Lanczos scaling (lazy-loaded)
  // Try fast mode first (WASM/WebWorkers), fall back to JS-only, then to worker-canvas
  type ResizeMode = 'pica-fast' | 'pica-js' | 'worker-canvas';
  let resizeMode: ResizeMode = 'pica-fast';
  let picaFast: ReturnType<typeof Pica> | null = null;
  let picaJsOnly: ReturnType<typeof Pica> | null = null;

  function getPicaFast(): ReturnType<typeof Pica> {
    if (!picaFast) picaFast = new Pica(); // Default: uses WASM, WebWorkers if available
    return picaFast;
  }
  function getPicaJsOnly(): ReturnType<typeof Pica> {
    if (!picaJsOnly) picaJsOnly = new Pica({ features: ['js'] });
    return picaJsOnly;
  }

  const PICA_OPTIONS = {
    filter: 'lanczos3' as const,
    unsharpAmount: 80,
    unsharpRadius: 0.6,
    unsharpThreshold: 2
  };

  // Worker-based canvas resize fallback
  let resizeWorker: Worker | null = null;
  let resizeWorkerId = 0;
  let resizeWorkerPending = new Map<
    number,
    {
      resolve: (bitmap: ImageBitmap) => void;
      reject: (err: Error) => void;
    }
  >();

  function getResizeWorker(): Worker {
    if (!resizeWorker) {
      resizeWorker = new Worker(new URL('$lib/workers/canvas-resize-worker.ts', import.meta.url), {
        type: 'module'
      });
      resizeWorker.onmessage = (e) => {
        const { type, id, bitmap, error } = e.data;
        const pending = resizeWorkerPending.get(id);
        if (!pending) return;
        resizeWorkerPending.delete(id);
        if (type === 'result') {
          pending.resolve(bitmap);
        } else {
          pending.reject(new Error(error));
        }
      };
    }
    return resizeWorker;
  }

  async function resizeWithWorker(
    bitmap: ImageBitmap,
    targetWidth: number,
    targetHeight: number
  ): Promise<ImageBitmap> {
    const worker = getResizeWorker();
    const id = ++resizeWorkerId;

    return new Promise((resolve, reject) => {
      resizeWorkerPending.set(id, { resolve, reject });
      worker.postMessage(
        { type: 'resize', id, bitmap, targetWidth, targetHeight },
        { transfer: [bitmap] } // Transfer bitmap to worker
      );
    });
  }

  // Track in-flight renders to avoid duplicates
  let picaRenderingPages = new Set<number>();

  // Image cache for loading bitmaps
  let imageCache = new ImageCache({ prev: 10, next: 10 });
  let cacheInitialized = false;

  // Bitmap ready tracking
  let bitmapsReady = $state<Set<number>>(new Set());

  // Local spread index - not derived from currentPage to avoid race conditions
  let localSpreadIndex = $state(0);

  // Animation IDs for cleanup
  let snapAnimationId: number | null = null;
  let inertiaAnimationId: number | null = null;

  // Flag to prevent spreads-change effect from interfering with explicit navigation
  let isExplicitNavigation = false;

  // ============================================
  // SPREAD LAYOUT
  // ============================================

  // Reactive portrait detection for auto mode
  let isPortrait = $derived(viewportWidth <= viewportHeight);

  // Reactive settings for spread calculation
  let pageViewMode = $derived(volumeSettings.singlePageView ?? 'auto');
  let rtl = $derived(volumeSettings.rightToLeft ?? true);
  let hasCover = $derived(volumeSettings.hasCover ?? false);

  // Continuous zoom mode setting
  let continuousZoomMode = $derived($settings.continuousZoomDefault);

  // Missing page paths for forceVisible (placeholder pages)
  let missingPagePaths = $derived(new Set(volume?.missing_page_paths || []));

  // Anchor page for spread grouping - only changes on explicit external navigation
  // (e.g., page selector), NOT during normal scrolling
  let anchorPage = $state(currentPage);

  // Group pages into spreads, anchored to the anchor page
  // The anchor page is always the START of a spread, allowing users to shift pairings
  // by navigating to different pages via the page selector
  let spreads = $derived.by(() => {
    const mode = pageViewMode;
    const _portrait = isPortrait; // Reference for reactivity
    const _width = viewportWidth;
    const _height = viewportHeight;

    // Anchor point: the page the user explicitly navigated to (0-indexed)
    const anchorIndex = anchorPage - 1;

    // Calculate median page width once for the whole volume
    const medianWidth = calculateMedianPageWidth(pages);
    console.log(
      `[Spreads] Calculating spreads: anchor=${anchorPage}, mode=${mode}, pages=${pages.length}, hasCover=${hasCover}, medianWidth=${medianWidth}`
    );

    // Helper to check if a page should be single
    function isSinglePage(pageIndex: number): boolean {
      const page = pages[pageIndex];
      const next = pages[pageIndex + 1];
      const prev = pageIndex > 0 ? pages[pageIndex - 1] : undefined;
      return shouldShowSinglePage(
        mode,
        page,
        next,
        prev,
        pageIndex === 0,
        hasCover,
        pageIndex,
        medianWidth
      );
    }

    // Build spreads forward from anchor
    const forwardSpreads: PageSpread[] = [];
    let i = anchorIndex;
    while (i < pages.length) {
      const page = pages[i];
      const nextPage = pages[i + 1];
      const showSingle = isSinglePage(i);

      if (showSingle || !nextPage) {
        forwardSpreads.push({
          type: 'single',
          pages: [page],
          pageIndices: [i]
        });
        i += 1;
      } else {
        const spreadPages = rtl ? [nextPage, page] : [page, nextPage];
        const spreadIndices = rtl ? [i + 1, i] : [i, i + 1];
        forwardSpreads.push({
          type: 'dual',
          pages: spreadPages,
          pageIndices: spreadIndices
        });
        i += 2;
      }
    }

    // Build spreads backward from anchor (working backwards)
    const backwardSpreads: PageSpread[] = [];
    i = anchorIndex - 1;
    while (i >= 0) {
      const page = pages[i];
      const prevPage = pages[i - 1];
      const showSingle = isSinglePage(i);

      if (showSingle || !prevPage) {
        backwardSpreads.unshift({
          type: 'single',
          pages: [page],
          pageIndices: [i]
        });
        i -= 1;
      } else {
        // Check if the previous page would also be single
        const prevSingle = isSinglePage(i - 1);
        if (prevSingle) {
          // Previous is single, so current is single too
          backwardSpreads.unshift({
            type: 'single',
            pages: [page],
            pageIndices: [i]
          });
          i -= 1;
        } else {
          // Pair with previous page
          const spreadPages = rtl ? [page, prevPage] : [prevPage, page];
          const spreadIndices = rtl ? [i, i - 1] : [i - 1, i];
          backwardSpreads.unshift({
            type: 'dual',
            pages: spreadPages,
            pageIndices: spreadIndices
          });
          i -= 2;
        }
      }
    }

    return [...backwardSpreads, ...forwardSpreads];
  });

  // Layout info for each spread: yOffset, width, height, pageLayouts
  interface PageLayout {
    pageIndex: number;
    xOffset: number; // Offset within spread (for dual pages)
    width: number;
    height: number;
  }

  interface SpreadLayout {
    spreadIndex: number;
    yOffset: number; // Cumulative Y position in SCALED content space
    width: number; // Native width
    height: number; // Native height
    scale: number; // Per-spread scale based on zoom mode
    scaledWidth: number; // width * scale
    scaledHeight: number; // height * scale
    pageLayouts: PageLayout[];
  }

  // Calculate scale for a spread based on zoom mode
  function calculateSpreadScale(width: number, height: number): number {
    switch (continuousZoomMode) {
      case 'zoomFitToWidth':
        return viewportWidth / width;
      case 'zoomFitToScreen':
        return Math.min(viewportWidth / width, viewportHeight / height);
      case 'zoomOriginal':
        return 1;
      default:
        return viewportWidth / width;
    }
  }

  // Calculate spread layout (all spreads stacked vertically)
  // Each spread gets its own scale based on zoom mode
  // yOffset accumulates using SCALED heights
  let spreadLayout = $derived.by((): SpreadLayout[] => {
    const layouts: SpreadLayout[] = [];
    let yOffset = 0;
    const pageGap = 20; // Gap between spreads (in screen pixels)

    for (let i = 0; i < spreads.length; i++) {
      const spread = spreads[i];
      const pageLayouts: PageLayout[] = [];

      if (spread.type === 'single') {
        const page = spread.pages[0];
        const pageIdx = spread.pageIndices[0];
        const width = page.img_width;
        const height = page.img_height;
        const scale = calculateSpreadScale(width, height);

        pageLayouts.push({
          pageIndex: pageIdx,
          xOffset: 0,
          width,
          height
        });
        layouts.push({
          spreadIndex: i,
          yOffset,
          width,
          height,
          scale,
          scaledWidth: width * scale,
          scaledHeight: height * scale,
          pageLayouts
        });
        yOffset += height * scale + pageGap;
      } else {
        // Dual spread
        const [page1, page2] = spread.pages;
        const [idx1, idx2] = spread.pageIndices;
        const height = Math.max(page1.img_height, page2.img_height);
        const width = page1.img_width + page2.img_width;
        const scale = calculateSpreadScale(width, height);

        // Determine earlier and later pages by index (independent of RTL swap in spread creation)
        const earlierIdx = Math.min(idx1, idx2);
        const laterIdx = Math.max(idx1, idx2);
        const earlierPage = idx1 < idx2 ? page1 : page2;
        const laterPage = idx1 < idx2 ? page2 : page1;

        // RTL: earlier page on right, later page on left
        // LTR: earlier page on left, later page on right
        if (rtl) {
          pageLayouts.push({
            pageIndex: laterIdx,
            xOffset: 0,
            width: laterPage.img_width,
            height: laterPage.img_height
          });
          pageLayouts.push({
            pageIndex: earlierIdx,
            xOffset: laterPage.img_width,
            width: earlierPage.img_width,
            height: earlierPage.img_height
          });
        } else {
          pageLayouts.push({
            pageIndex: earlierIdx,
            xOffset: 0,
            width: earlierPage.img_width,
            height: earlierPage.img_height
          });
          pageLayouts.push({
            pageIndex: laterIdx,
            xOffset: earlierPage.img_width,
            width: laterPage.img_width,
            height: laterPage.img_height
          });
        }

        layouts.push({
          spreadIndex: i,
          yOffset,
          width,
          height,
          scale,
          scaledWidth: width * scale,
          scaledHeight: height * scale,
          pageLayouts
        });
        yOffset += height * scale + pageGap;
      }
    }

    return layouts;
  });

  // Total content height (in scaled space, before userZoomMultiplier)
  let totalContentHeight = $derived(
    spreadLayout.length > 0
      ? spreadLayout[spreadLayout.length - 1].yOffset +
          spreadLayout[spreadLayout.length - 1].scaledHeight
      : 0
  );

  // ============================================
  // SYNC WITH EXTERNAL PAGE CHANGES
  // ============================================

  let lastExternalPage = $state(currentPage);
  $effect(() => {
    if (currentPage !== lastExternalPage) {
      lastExternalPage = currentPage;
      // Cancel any running animations that might interfere
      cancelInertiaAnimation();
      cancelSnapAnimation();

      // Set flag to prevent spreads-change effect from interfering
      isExplicitNavigation = true;

      // Update anchor page - this will cause spreads to recalculate
      // with the new page as the start of a spread
      anchorPage = currentPage;

      const pageIndex = currentPage - 1;
      const targetSpreadIndex = findSpreadForPage(spreads, pageIndex);
      if (targetSpreadIndex >= 0 && targetSpreadIndex !== localSpreadIndex) {
        localSpreadIndex = targetSpreadIndex;
        tick().then(() => {
          isExplicitNavigation = false;
          applyZoomMode();
        });
      } else {
        isExplicitNavigation = false;
      }
    }
  });

  // Sync when spreads change (e.g., viewport resize, zoom mode change)
  // Skip when explicitly navigating - jumpToSpread handles its own positioning
  let lastSpreadsKey = $state('');
  $effect(() => {
    const spreadsKey = spreads.map((s) => s.pageIndices.join('-')).join('|');
    if (spreadsKey !== lastSpreadsKey) {
      const wasExplicitNav = isExplicitNavigation;
      lastSpreadsKey = spreadsKey;

      // If we're explicitly navigating, don't interfere - jumpToSpread handles everything
      if (wasExplicitNav) {
        return;
      }

      // Cancel any running animations that might call checkSpreadTransition with stale values
      cancelInertiaAnimation();
      cancelSnapAnimation();
      const pageIndex = currentPage - 1;
      const targetSpreadIndex = findSpreadForPage(spreads, pageIndex);
      if (targetSpreadIndex >= 0) {
        localSpreadIndex = targetSpreadIndex;
      }
      tick().then(() => {
        applyZoomMode();
      });
    }
  });

  // Watch for zoom mode changes (standard reader)
  let lastZoomMode = $state($settings.zoomDefault);
  $effect(() => {
    const zoomMode = $settings.zoomDefault;
    if (zoomMode !== lastZoomMode) {
      lastZoomMode = zoomMode;
      applyZoomMode();
    }
  });

  // Watch for continuous zoom mode changes
  let lastContinuousZoomMode = $state($settings.continuousZoomDefault);
  $effect(() => {
    const zoomMode = $settings.continuousZoomDefault;
    if (zoomMode !== lastContinuousZoomMode) {
      lastContinuousZoomMode = zoomMode;
      // Reset user zoom and reposition - spreadLayout will recalculate with new scales
      applyZoomMode();
    }
  });

  // ============================================
  // PRE-RENDERING PIPELINE
  // ============================================

  // Initialize image cache
  $effect(() => {
    if (cacheInitialized || !files || !pages || pages.length === 0) return;
    imageCache.updateCache(files, pages, 0);
    cacheInitialized = true;
  });

  const MAX_CACHED_PAGES = 6;
  const PRELOAD_BUFFER = 1; // prev + current + next = 3 spreads = 6 pages for dual

  // Get the effective scale for a page (spread scale * user zoom)
  function getPageEffectiveScale(pageIndex: number): number {
    // Find which spread this page belongs to
    for (const sl of spreadLayout) {
      for (const pl of sl.pageLayouts) {
        if (pl.pageIndex === pageIndex) {
          return sl.scale * userZoomMultiplier;
        }
      }
    }
    return userZoomMultiplier;
  }

  // Pre-render page to canvas at current zoom level
  async function preRenderPage(pageIndex: number, bitmap: ImageBitmap, page: Page): Promise<void> {
    const effectiveScale = getPageEffectiveScale(pageIndex);
    const existingScale = pageCanvasesSpreadScale.get(pageIndex);

    // Skip if already rendered at this scale or currently rendering
    if (pageCanvases.has(pageIndex) && existingScale === effectiveScale) return;
    if (picaRenderingPages.has(pageIndex)) return;

    // Mark as rendering
    picaRenderingPages.add(pageIndex);

    try {
      // Calculate scaled dimensions
      const scaledWidth = Math.ceil(page.img_width * effectiveScale * dpr);
      const scaledHeight = Math.ceil(page.img_height * effectiveScale * dpr);

      let destCanvas: HTMLCanvasElement;

      if (resizeMode === 'worker-canvas') {
        // Worker-based canvas fallback - clone bitmap since worker will consume it
        const bitmapClone = await createImageBitmap(bitmap);
        const resultBitmap = await resizeWithWorker(bitmapClone, scaledWidth, scaledHeight);

        // Convert ImageBitmap to canvas for consistent storage
        destCanvas = document.createElement('canvas');
        destCanvas.width = scaledWidth;
        destCanvas.height = scaledHeight;
        const ctx = destCanvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(resultBitmap, 0, 0);
        }
        resultBitmap.close();
      } else {
        // Pica-based resize (fast or js-only)
        // Pica requires HTMLCanvasElement, so create source canvas from bitmap
        const srcCanvas = document.createElement('canvas');
        srcCanvas.width = bitmap.width;
        srcCanvas.height = bitmap.height;
        const srcCtx = srcCanvas.getContext('2d');
        if (!srcCtx) return;
        srcCtx.drawImage(bitmap, 0, 0);

        // Create destination canvas
        destCanvas = document.createElement('canvas');
        destCanvas.width = scaledWidth;
        destCanvas.height = scaledHeight;

        // Try pica modes with fallback chain
        let success = false;
        if (resizeMode === 'pica-fast') {
          try {
            await getPicaFast().resize(srcCanvas, destCanvas, PICA_OPTIONS);
            success = true;
          } catch (err) {
            console.info('[resize] pica-fast failed, trying pica-js:', err);
            resizeMode = 'pica-js';
          }
        }

        if (!success && resizeMode === 'pica-js') {
          try {
            await getPicaJsOnly().resize(srcCanvas, destCanvas, PICA_OPTIONS);
            success = true;
          } catch (err) {
            console.info('[resize] pica-js failed, falling back to worker-canvas:', err);
            resizeMode = 'worker-canvas';
          }
        }

        if (!success && resizeMode === 'worker-canvas') {
          // Retry with worker
          const bitmapClone = await createImageBitmap(bitmap);
          const resultBitmap = await resizeWithWorker(bitmapClone, scaledWidth, scaledHeight);
          const ctx = destCanvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(resultBitmap, 0, 0);
          }
          resultBitmap.close();
        }
      }

      // Store the result
      pageCanvases.set(pageIndex, destCanvas);
      pageCanvasesSpreadScale.set(pageIndex, effectiveScale);
      pageCanvasesZoom = userZoomMultiplier;
      perfStats.prerenderCount++;

      // Update bitmapsReady to trigger re-render
      bitmapsReady = new Set([...bitmapsReady, pageIndex]);
      scheduleDraw();
    } catch (err) {
      console.error('[resize] Failed to pre-render page:', err);
    } finally {
      picaRenderingPages.delete(pageIndex);
    }
  }

  // Build spread page indices array for cache strategy
  function getSpreadPageIndicesArray(): number[][] {
    return spreads.map((s) => s.pageIndices);
  }

  // Load and pre-render pages in the window around current spread
  $effect(() => {
    if (!cacheInitialized) return;

    // Depend on invalidation counter to re-run when cache is cleared
    const _ = cacheInvalidationCounter;

    const currentSpread = spreads[localSpreadIndex];
    if (!currentSpread) return;

    const centerPageIdx = currentSpread.pageIndices[0];
    imageCache.updateCache(files, pages, centerPageIdx);

    // Use the cache strategy to determine what to evict and load
    const cachedPages = [...pageCanvases.keys()];
    const spreadPageIndices = getSpreadPageIndicesArray();
    const { toEvict, toLoad } = updateCacheStrategy(
      cachedPages,
      spreadPageIndices,
      localSpreadIndex,
      centerPageIdx,
      { maxCachedPages: MAX_CACHED_PAGES, preloadBuffer: PRELOAD_BUFFER }
    );

    // Evict pages that are too far
    for (const pageIdx of toEvict) {
      pageCanvases.delete(pageIdx);
      pageCanvasesSpreadScale.delete(pageIdx);
    }

    // Load needed pages
    for (const pageIdx of toLoad) {
      const bitmap = imageCache.getBitmapSync(pageIdx);
      if (bitmap) {
        preRenderPage(pageIdx, bitmap, pages[pageIdx]);
      } else {
        imageCache.getBitmap(pageIdx).then((resolvedBitmap) => {
          if (
            resolvedBitmap &&
            !pageCanvases.has(pageIdx) &&
            pageCanvases.size < MAX_CACHED_PAGES
          ) {
            preRenderPage(pageIdx, resolvedBitmap, pages[pageIdx]);
            scheduleDraw();
          }
        });
      }
    }
  });

  // ============================================
  // CANVAS SETUP
  // ============================================

  // Track device pixel ratio for HiDPI rendering
  let dpr = $state(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);

  function setupCanvas() {
    if (!canvasEl) return;

    // Get 2D context
    ctx = canvasEl.getContext('2d');
    if (ctx) {
      ctx.imageSmoothingEnabled = false;
    }

    // Set canvas size accounting for device pixel ratio (for sharp rendering on HiDPI)
    canvasEl.width = viewportWidth * dpr;
    canvasEl.height = viewportHeight * dpr;
    // CSS size stays at viewport size
    canvasEl.style.width = `${viewportWidth}px`;
    canvasEl.style.height = `${viewportHeight}px`;
  }

  onMount(() => {
    setupCanvas();

    // Handle window resize
    const handleResize = () => {
      const newWidth = window.innerWidth;
      const newHeight = window.innerHeight;
      const newDpr = window.devicePixelRatio || 1;

      console.log(
        `[Resize] ${viewportWidth}x${viewportHeight} → ${newWidth}x${newHeight}, dpr=${newDpr}`
      );

      viewportWidth = newWidth;
      viewportHeight = newHeight;
      dpr = newDpr;

      if (canvasEl) {
        canvasEl.width = viewportWidth * dpr;
        canvasEl.height = viewportHeight * dpr;
        canvasEl.style.width = `${viewportWidth}px`;
        canvasEl.style.height = `${viewportHeight}px`;

        // Re-acquire context after resize (can be lost on some devices)
        ctx = canvasEl.getContext('2d');
        if (ctx) {
          ctx.imageSmoothingEnabled = false;
        } else {
          console.error('[Resize] Failed to get canvas context after resize');
        }
      }

      // Wait for derived values (spreadLayout) to recalculate before applying zoom
      tick().then(() => {
        applyZoomMode();
      });
    };

    window.addEventListener('resize', handleResize);

    // Initial zoom mode
    tick().then(() => {
      applyZoomMode();
    });

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  });

  onDestroy(() => {
    // Clean up animations
    if (snapAnimationId !== null) {
      cancelAnimationFrame(snapAnimationId);
    }
    if (inertiaAnimationId !== null) {
      cancelAnimationFrame(inertiaAnimationId);
    }
    if (zoomSettleTimeout) {
      clearTimeout(zoomSettleTimeout);
    }
    // Clean up pre-rendered canvases
    pageCanvases.clear();
    pageCanvasesSpreadScale.clear();
    imageCache.cleanup();
    // Clean up resize worker
    if (resizeWorker) {
      resizeWorker.terminate();
      resizeWorker = null;
    }
    resizeWorkerPending.clear();
  });

  // ============================================
  // DRAW FUNCTION (THE HEART OF THE SYSTEM)
  // ============================================

  let drawScheduled = false;

  // Performance instrumentation
  const PERF_ENABLED = true;
  const perfStats = {
    drawCount: 0,
    lastDrawTime: 0,
    avgDrawTime: 0,
    maxDrawTime: 0,
    prerenderCount: 0
  };

  // Log stats every 60 frames
  function logPerfStats(): void {
    if (!PERF_ENABLED) return;
    if (perfStats.drawCount % 60 === 0 && perfStats.drawCount > 0) {
      console.log(
        `[PERF STATS] draws: ${perfStats.drawCount}, avgDraw: ${perfStats.avgDrawTime.toFixed(2)}ms, maxDraw: ${perfStats.maxDrawTime.toFixed(2)}ms, prerenders: ${perfStats.prerenderCount}`
      );
    }
  }

  function scheduleDraw() {
    if (drawScheduled) return;
    drawScheduled = true;
    requestAnimationFrame(() => {
      drawScheduled = false;
      draw();
    });
  }

  // Mark zoom as active and schedule settling
  function markZoomActive(): void {
    isZooming = true;
    if (zoomSettleTimeout) {
      clearTimeout(zoomSettleTimeout);
    }
    zoomSettleTimeout = setTimeout(() => {
      isZooming = false;
      zoomSettleTimeout = null;
      // DON'T clear pageCanvases - keep old ones visible until new ones replace them
      // Just clear the scale tracking so preRenderPage knows to re-render
      pageCanvasesSpreadScale.clear();
      // Trigger cache effect to re-run and load pages at new zoom
      cacheInvalidationCounter++;
      scheduleDraw();
    }, ZOOM_SETTLE_DELAY);
  }

  function draw(): void {
    const t0 = performance.now();
    if (!ctx) return;

    // All drawing is done at HiDPI resolution (CSS pixels * dpr)
    const canvasW = viewportWidth * dpr;
    const canvasH = viewportHeight * dpr;

    // Clear canvas to transparent (background color comes from CSS, unaffected by invert filter)
    ctx.clearRect(0, 0, canvasW, canvasH);
    const t1 = performance.now();

    // Get visible spreads
    const visibleSpreads = getVisibleSpreads();

    // During zoom gestures, always use slow path
    const forceSlowPath = isZooming;
    ctx.imageSmoothingEnabled = false;

    for (const sl of visibleSpreads) {
      const effectiveScale = sl.scale * userZoomMultiplier;
      const spreadCenterX = (viewportWidth - sl.width * effectiveScale) / 2;

      for (const pl of sl.pageLayouts) {
        const source = pageCanvases.get(pl.pageIndex);
        if (!source) continue;

        // Screen position in CSS pixels (transform.x shifts from center)
        const screenX = spreadCenterX + pl.xOffset * effectiveScale + transform.x;
        const screenY = sl.yOffset * userZoomMultiplier + transform.y;
        const screenW = pl.width * effectiveScale;
        const screenH = pl.height * effectiveScale;

        // Culling: skip if completely off-screen
        if (screenX + screenW < 0 || screenX > viewportWidth) continue;
        if (screenY + screenH < 0 || screenY > viewportHeight) continue;

        // Check if this page's canvas is at the correct scale for direct blit
        const cachedScale = pageCanvasesSpreadScale.get(pl.pageIndex);
        const canDirectBlit = !forceSlowPath && cachedScale === effectiveScale;

        if (canDirectBlit) {
          // FAST PATH: Direct blit, no scaling
          ctx.drawImage(source, screenX * dpr, screenY * dpr);
        } else {
          // SLOW PATH: Scale from existing pageCanvas (keeps old image visible during transitions)
          ctx.drawImage(source, screenX * dpr, screenY * dpr, screenW * dpr, screenH * dpr);
        }
      }
    }
    const t2 = performance.now();

    // Update text overlay position (synchronous DOM update)
    updateTextOverlayPosition();
    const t3 = performance.now();

    // Update stats
    perfStats.drawCount++;
    const totalTime = t3 - t0;
    perfStats.lastDrawTime = totalTime;
    perfStats.avgDrawTime =
      (perfStats.avgDrawTime * (perfStats.drawCount - 1) + totalTime) / perfStats.drawCount;
    if (totalTime > perfStats.maxDrawTime) perfStats.maxDrawTime = totalTime;

    if (PERF_ENABLED && totalTime > 8) {
      console.log(
        `[PERF] draw: total=${totalTime.toFixed(2)}ms (clear=${(t1 - t0).toFixed(2)}, render=${(t2 - t1).toFixed(2)}, textOverlay=${(t3 - t2).toFixed(2)})`
      );
    }

    logPerfStats();
  }

  function getVisibleSpreads(): SpreadLayout[] {
    const result: SpreadLayout[] = [];

    for (const sl of spreadLayout) {
      // yOffset is already in scaled space, apply userZoomMultiplier
      const screenY = sl.yOffset * userZoomMultiplier + transform.y;
      const screenH = sl.scaledHeight * userZoomMultiplier;

      // Check if spread is visible (with some buffer)
      if (screenY + screenH >= -viewportHeight && screenY <= viewportHeight * 2) {
        result.push(sl);
      }
    }

    return result;
  }

  function updateTextOverlayPosition(): void {
    if (!textOverlayEl) return;
    // Position the text overlay container - apply both X and Y translation
    // Each spread overlay handles its own scale via inline styles
    textOverlayEl.style.transform = `translate(${transform.x}px, ${transform.y}px)`;
  }

  // Trigger draw when bitmaps become ready
  $effect(() => {
    // Reference bitmapsReady to create dependency
    const _ = bitmapsReady.size;
    if (ctx) {
      scheduleDraw();
    }
  });

  // ============================================
  // INPUT HANDLING (REPLACE PANZOOM)
  // ============================================

  // Drag state
  let isDragging = false;
  let dragStart = { x: 0, y: 0 };
  let transformStart = { x: 0, y: 0 };

  function handleMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return; // Left click only
    if (isTextBoxClick(e)) return; // Allow text selection

    cancelSnapAnimation(); // Stop any ongoing snap
    cancelZoomAnimation(); // Stop any ongoing zoom animation
    isDragging = true;
    dragStart = { x: e.clientX, y: e.clientY };
    transformStart = { x: transform.x, y: transform.y };
  }

  function handleMouseMove(e: MouseEvent): void {
    if (!isDragging) return;

    transform.x = transformStart.x + (e.clientX - dragStart.x);
    transform.y = transformStart.y + (e.clientY - dragStart.y);

    // Clamp horizontal bounds
    const spread = spreadLayout[localSpreadIndex];
    if (spread) {
      const bounds = getSpreadBounds(spread);
      transform.x = Math.min(bounds.leftX, Math.max(bounds.rightX, transform.x));
    }

    draw(); // Synchronous!
    checkSpreadTransition();
  }

  function handleMouseUp(): void {
    if (isDragging) {
      isDragging = false;
      if ($settings.scrollSnap) {
        snapToNearestBoundary();
      }
    }
  }

  // Check if click is on a text box
  function isTextBoxClick(e: MouseEvent | TouchEvent): boolean {
    const target = e.target as HTMLElement;
    return target.closest('.textBox') !== null;
  }

  // Double-click zoom (desktop)
  function handleDoubleClick(e: MouseEvent): void {
    if (isTextBoxClick(e)) return; // Don't zoom when double-clicking text
    e.preventDefault();
    handleDoubleTapZoom(e.clientX, e.clientY);
  }

  // Click to toggle UI overlay visibility
  function handleClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;

    // Only toggle if clicking on blank space (not text boxes)
    if (target.closest('.textBox')) return;

    // Don't toggle if dismissing an active textbox (has selection or focus)
    const selection = window.getSelection();
    const hasTextSelection = selection && selection.toString().trim().length > 0;
    const activeElement = document.activeElement;
    const hasActiveTextBox = activeElement?.closest('.textBox') !== null;

    if (hasTextSelection || hasActiveTextBox) {
      // Clear selection/focus but don't toggle UI
      selection?.removeAllRanges();
      if (activeElement instanceof HTMLElement) {
        activeElement.blur();
      }
      return;
    }

    onOverlayToggle?.();
  }

  // Wheel scroll/zoom
  function handleWheel(e: WheelEvent): void {
    e.preventDefault();
    cancelSnapAnimation(); // Stop any ongoing snap
    cancelZoomAnimation(); // Stop any ongoing zoom animation

    const shouldZoom = $settings.swapWheelBehavior ? !e.ctrlKey : e.ctrlKey;

    if (shouldZoom) {
      const scaleDelta = 1 - e.deltaY * 0.001;
      zoomAt(e.clientX, e.clientY, scaleDelta);
    } else {
      transform.y -= e.deltaY;
      draw();
      checkSpreadTransition();
      scheduleSnapAfterWheel();
    }
  }

  // Zoom at point (modifies userZoomMultiplier, not per-spread scales)
  function zoomAt(clientX: number, clientY: number, scaleDelta: number): void {
    markZoomActive(); // Signal that zoom is happening

    const newZoom = Math.max(0.1, Math.min(10, userZoomMultiplier * scaleDelta));
    const ratio = newZoom / userZoomMultiplier;

    // Keep point under cursor stationary
    transform.x = clientX - (clientX - transform.x) * ratio;
    transform.y = clientY - (clientY - transform.y) * ratio;
    userZoomMultiplier = newZoom;

    draw();
  }

  // Touch handling
  let activeTouches: Touch[] = [];
  let initialPinchDistance = 0;
  let initialZoom = 1;
  let initialPinchCenter = { x: 0, y: 0 };

  // Double-tap/double-click detection
  let lastTapTime = 0;
  let lastTapPos = { x: 0, y: 0 };
  const DOUBLE_TAP_THRESHOLD = 300; // ms
  const DOUBLE_TAP_DISTANCE = 30; // px tolerance
  const DOUBLE_TAP_ZOOM_LEVEL = 2.5; // Target zoom level for double-tap

  // Zoom animation
  let zoomAnimationId: number | null = null;

  function cancelZoomAnimation(): void {
    if (zoomAnimationId !== null) {
      cancelAnimationFrame(zoomAnimationId);
      zoomAnimationId = null;
    }
  }

  /**
   * Animate zoom to a target level, keeping the specified point stationary.
   * Uses ease-out cubic for smooth deceleration.
   */
  function animateZoomTo(
    targetZoom: number,
    clientX: number,
    clientY: number,
    duration = 250
  ): void {
    cancelZoomAnimation();
    cancelSnapAnimation();
    markZoomActive();

    const startZoom = userZoomMultiplier;
    const startX = transform.x;
    const startY = transform.y;
    const startTime = performance.now();

    // Calculate target position to keep point under cursor stationary
    const ratio = targetZoom / startZoom;
    const targetX = clientX - (clientX - startX) * ratio;
    const targetY = clientY - (clientY - startY) * ratio;

    function animate(currentTime: number) {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3); // Ease-out cubic

      userZoomMultiplier = startZoom + (targetZoom - startZoom) * eased;
      transform.x = startX + (targetX - startX) * eased;
      transform.y = startY + (targetY - startY) * eased;

      draw();

      if (progress < 1) {
        zoomAnimationId = requestAnimationFrame(animate);
      } else {
        zoomAnimationId = null;
        // After zoom animation completes, snap if enabled
        if ($settings.scrollSnap) {
          snapToNearestBoundary();
        }
      }
    }

    zoomAnimationId = requestAnimationFrame(animate);
  }

  /**
   * Handle double-tap/double-click zoom.
   * Toggles between 1x and DOUBLE_TAP_ZOOM_LEVEL, zooming at the tap location.
   */
  function handleDoubleTapZoom(clientX: number, clientY: number): void {
    // Toggle zoom: if zoomed in, zoom out; if zoomed out, zoom in
    const isZoomedIn = userZoomMultiplier > 1.5;
    const targetZoom = isZoomedIn ? 1 : DOUBLE_TAP_ZOOM_LEVEL;
    animateZoomTo(targetZoom, clientX, clientY);
  }

  /**
   * Check if a tap qualifies as a double-tap based on timing and position.
   */
  function isDoubleTap(clientX: number, clientY: number): boolean {
    const now = performance.now();
    const timeDiff = now - lastTapTime;
    const distance = Math.sqrt(
      Math.pow(clientX - lastTapPos.x, 2) + Math.pow(clientY - lastTapPos.y, 2)
    );
    return timeDiff < DOUBLE_TAP_THRESHOLD && distance < DOUBLE_TAP_DISTANCE;
  }

  /**
   * Record a tap for double-tap detection.
   */
  function recordTap(clientX: number, clientY: number): void {
    lastTapTime = performance.now();
    lastTapPos = { x: clientX, y: clientY };
  }

  // Velocity tracking for inertial scrolling
  interface VelocitySample {
    x: number;
    y: number;
    time: number;
  }
  let velocitySamples: VelocitySample[] = [];
  const VELOCITY_SAMPLE_COUNT = 5; // Number of samples to average

  function cancelInertiaAnimation(): void {
    if (inertiaAnimationId !== null) {
      cancelAnimationFrame(inertiaAnimationId);
      inertiaAnimationId = null;
    }
  }

  function handleTouchStart(e: TouchEvent): void {
    // Prevent native scroll/zoom on iOS Safari (unless touching a text box)
    if (!isTextBoxClick(e)) {
      e.preventDefault();
    }

    cancelSnapAnimation(); // Stop any ongoing snap
    cancelZoomAnimation(); // Stop any ongoing zoom animation
    cancelInertiaAnimation(); // Stop any ongoing inertia
    activeTouches = Array.from(e.touches);
    velocitySamples = []; // Reset velocity tracking

    if (activeTouches.length === 1) {
      // Single touch - start drag
      const touch = activeTouches[0];
      dragStart = { x: touch.clientX, y: touch.clientY };
      transformStart = { x: transform.x, y: transform.y };
      isDragging = true;

      // Start tracking velocity
      velocitySamples.push({
        x: touch.clientX,
        y: touch.clientY,
        time: performance.now()
      });
    } else if (activeTouches.length === 2) {
      // Two fingers - start pinch
      isDragging = false;
      initialPinchDistance = getTouchDistance(activeTouches[0], activeTouches[1]);
      initialZoom = userZoomMultiplier;
      initialPinchCenter = getTouchCenter(activeTouches[0], activeTouches[1]);
    }
  }

  function handleTouchMove(e: TouchEvent): void {
    e.preventDefault();
    const newTouches = Array.from(e.touches);

    if (newTouches.length === 1 && isDragging) {
      // Pan
      const touch = newTouches[0];
      transform.x = transformStart.x + (touch.clientX - dragStart.x);
      transform.y = transformStart.y + (touch.clientY - dragStart.y);

      // Clamp horizontal bounds
      const spread = spreadLayout[localSpreadIndex];
      if (spread) {
        const bounds = getSpreadBounds(spread);
        transform.x = Math.min(bounds.leftX, Math.max(bounds.rightX, transform.x));
      }

      // Track velocity samples
      const now = performance.now();
      velocitySamples.push({
        x: touch.clientX,
        y: touch.clientY,
        time: now
      });
      // Keep only recent samples
      if (velocitySamples.length > VELOCITY_SAMPLE_COUNT) {
        velocitySamples.shift();
      }

      draw();
      checkSpreadTransition();
    } else if (newTouches.length === 2) {
      // Pinch zoom - no inertia for pinch
      velocitySamples = [];
      markZoomActive(); // Signal that zoom is happening

      const newDistance = getTouchDistance(newTouches[0], newTouches[1]);
      const newCenter = getTouchCenter(newTouches[0], newTouches[1]);
      const newZoom = (newDistance / initialPinchDistance) * initialZoom;

      // Zoom towards pinch center
      const ratio = newZoom / userZoomMultiplier;
      transform.x = newCenter.x - (newCenter.x - transform.x) * ratio;
      transform.y = newCenter.y - (newCenter.y - transform.y) * ratio;
      userZoomMultiplier = newZoom;

      // Also pan based on center movement
      const centerDx = newCenter.x - initialPinchCenter.x;
      const centerDy = newCenter.y - initialPinchCenter.y;
      transform.x += centerDx;
      transform.y += centerDy;
      initialPinchCenter = newCenter;

      draw();
    }

    activeTouches = newTouches;
  }

  function handleTouchEnd(e: TouchEvent): void {
    const wasDragging = isDragging;
    const previousTouchCount = activeTouches.length;
    activeTouches = Array.from(e.touches);

    if (activeTouches.length === 0) {
      isDragging = false;

      // Check for tap (single finger, minimal movement)
      if (previousTouchCount === 1) {
        const lastTouch = e.changedTouches[0];
        const tapDistance = Math.sqrt(
          Math.pow(lastTouch.clientX - dragStart.x, 2) +
            Math.pow(lastTouch.clientY - dragStart.y, 2)
        );
        const isTap = tapDistance < 10; // Less than 10px movement = tap

        if (isTap) {
          // Check for double-tap
          if (isDoubleTap(lastTouch.clientX, lastTouch.clientY)) {
            // Don't trigger on text boxes
            const target = e.target as HTMLElement;
            if (!target.closest('.textBox')) {
              handleDoubleTapZoom(lastTouch.clientX, lastTouch.clientY);
              lastTapTime = 0; // Reset so triple-tap doesn't trigger again
              return;
            }
          }
          // Record this tap for potential double-tap
          recordTap(lastTouch.clientX, lastTouch.clientY);
        }
      }

      // Calculate velocity for inertial scrolling
      if (wasDragging && velocitySamples.length >= 2) {
        const velocity = calculateVelocity();
        const speed = Math.sqrt(velocity.vx * velocity.vx + velocity.vy * velocity.vy);

        // In snap mode, check for page-change fling with dynamic threshold
        // Threshold is lower when near the page boundary, higher when far from it
        // Only trigger on clearly vertical swipes (vy must be at least 2x vx)
        const isVerticalSwipe = Math.abs(velocity.vy) > Math.abs(velocity.vx) * 2;
        if ($settings.scrollSnap && isVerticalSwipe) {
          // Determine direction based on vertical velocity
          // Negative vy = swiping up = scrolling down = next spread (start at top)
          // Positive vy = swiping down = scrolling up = previous spread (start at bottom)
          const direction = velocity.vy < 0 ? 'down' : 'up';
          const threshold = getDynamicFlingThreshold(direction);

          if (speed > threshold) {
            if (direction === 'down') {
              jumpToSpread(localSpreadIndex + 1, 'top');
            } else {
              jumpToSpread(localSpreadIndex - 1, 'bottom');
            }
            return;
          }
        }

        // Allow inertial scrolling if there's meaningful velocity
        // (inertia handler will snap when it stops if snap mode is enabled)
        const minInertiaSpeed = 100; // px/s
        if (speed > minInertiaSpeed) {
          startInertialScroll(velocity.vx, velocity.vy);
          return;
        }
      }

      // No significant velocity, snap if enabled
      if ($settings.scrollSnap) {
        snapToNearestBoundary();
      }
    }
  }

  function calculateVelocity(): { vx: number; vy: number } {
    if (velocitySamples.length < 2) {
      return { vx: 0, vy: 0 };
    }

    // Use the oldest and newest samples to calculate velocity
    const oldest = velocitySamples[0];
    const newest = velocitySamples[velocitySamples.length - 1];
    const dt = (newest.time - oldest.time) / 1000; // Convert to seconds

    if (dt <= 0) {
      return { vx: 0, vy: 0 };
    }

    return {
      vx: (newest.x - oldest.x) / dt,
      vy: (newest.y - oldest.y) / dt
    };
  }

  function startInertialScroll(vx: number, vy: number): void {
    cancelInertiaAnimation();
    cancelSnapAnimation();

    // Linear deceleration feels more physical - fast flings travel much further
    // deceleration in px/s² - higher = stops faster
    const deceleration = 2500;
    const minVelocity = 30; // Stop when barely moving (px/s)
    let lastTime = performance.now();

    // In snap mode, constrain to current spread bounds
    const constrainToBounds = $settings.scrollSnap;
    const spread = spreadLayout[localSpreadIndex];
    const bounds = spread ? getSpreadBounds(spread) : null;

    function animate(currentTime: number) {
      const dt = (currentTime - lastTime) / 1000; // Delta time in seconds
      lastTime = currentTime;

      // Apply velocity
      transform.x += vx * dt;
      transform.y += vy * dt;

      // Clamp to spread bounds
      if (bounds) {
        // Horizontal bounds (always enforce)
        if (transform.x > bounds.leftX) {
          transform.x = bounds.leftX;
          vx = 0;
        } else if (transform.x < bounds.rightX) {
          transform.x = bounds.rightX;
          vx = 0;
        }

        // Vertical bounds (only in snap mode)
        // When hitting boundary, stop inertia and animate to boundary
        if (constrainToBounds) {
          const effectiveBottomY = bounds.fitsInViewport ? bounds.centerY : bounds.bottomY;
          if (transform.y > bounds.topY) {
            // Hit top boundary - stop inertia and animate
            inertiaAnimationId = null;
            animateToY(bounds.topY);
            return;
          } else if (transform.y < effectiveBottomY) {
            // Hit bottom boundary - stop inertia and animate
            inertiaAnimationId = null;
            animateToY(effectiveBottomY);
            return;
          }
        }
      }

      // Apply linear deceleration (frame-rate independent)
      // This feels more physical - fast flings travel proportionally further
      const currentSpeed = Math.sqrt(vx * vx + vy * vy);
      if (currentSpeed > 0) {
        const reduction = deceleration * dt;
        const newSpeed = Math.max(0, currentSpeed - reduction);
        const factor = newSpeed / currentSpeed;
        vx *= factor;
        vy *= factor;
      }

      draw();

      // Only check spread transition if not constraining to bounds
      if (!constrainToBounds) {
        checkSpreadTransition();
      }

      // Check if we should stop
      const speed = Math.sqrt(vx * vx + vy * vy);
      if (speed > minVelocity) {
        inertiaAnimationId = requestAnimationFrame(animate);
      } else {
        inertiaAnimationId = null;
        // Snap when inertia ends
        if ($settings.scrollSnap) {
          snapToNearestBoundary();
        }
      }
    }

    inertiaAnimationId = requestAnimationFrame(animate);
  }

  function getTouchDistance(t1: Touch, t2: Touch): number {
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function getTouchCenter(t1: Touch, t2: Touch): { x: number; y: number } {
    return {
      x: (t1.clientX + t2.clientX) / 2,
      y: (t1.clientY + t2.clientY) / 2
    };
  }

  // ============================================
  // KEYBOARD NAVIGATION
  // ============================================

  function handleKeydown(e: KeyboardEvent): void {
    if (isInputFocused()) return;

    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        panVertical('up');
        break;
      case 'ArrowDown':
        e.preventDefault();
        panVertical('down');
        break;
      case 'ArrowLeft':
        e.preventDefault();
        panHorizontal('left');
        break;
      case 'ArrowRight':
        e.preventDefault();
        panHorizontal('right');
        break;
      case 'PageDown':
      case ' ':
        e.preventDefault();
        jumpToSpread(localSpreadIndex + 1);
        break;
      case 'PageUp':
        e.preventDefault();
        jumpToSpread(localSpreadIndex - 1);
        break;
      case 'Home':
        e.preventDefault();
        jumpToSpread(0);
        break;
      case 'End':
        e.preventDefault();
        jumpToSpread(spreads.length - 1);
        break;
      case '+':
      case '=':
        zoomAt(viewportWidth / 2, viewportHeight / 2, 1.1);
        break;
      case '-':
        zoomAt(viewportWidth / 2, viewportHeight / 2, 0.9);
        break;
    }
  }

  /**
   * Pan vertically by 60% of viewport, respecting page boundaries.
   * Only changes pages when already at the boundary.
   * Animates the pan smoothly.
   */
  function panVertical(direction: 'up' | 'down'): void {
    const spread = spreadLayout[localSpreadIndex];
    if (!spread) return;

    cancelSnapAnimation(); // Cancel any ongoing animation

    // Check if at boundary - if so, change pages
    if (isAtSpreadBoundary(direction)) {
      if (direction === 'up') {
        jumpToSpread(localSpreadIndex - 1, 'bottom');
      } else {
        jumpToSpread(localSpreadIndex + 1, 'top');
      }
      return;
    }

    // Pan within current spread
    const bounds = getSpreadBounds(spread);
    const panAmount = viewportHeight * 0.6;
    let targetY: number;

    if (direction === 'up') {
      const remainingToTop = bounds.topY - transform.y;
      const actualPan = Math.min(panAmount, remainingToTop);
      targetY = transform.y + actualPan;
    } else {
      const effectiveBottomY = bounds.fitsInViewport ? bounds.centerY : bounds.bottomY;
      const remainingToBottom = transform.y - effectiveBottomY;
      const actualPan = Math.min(panAmount, remainingToBottom);
      targetY = transform.y - actualPan;
    }

    animateToY(targetY);
  }

  /**
   * Pan horizontally by 30% of viewport, respecting spread boundaries.
   * Animates the pan smoothly.
   */
  function panHorizontal(direction: 'left' | 'right'): void {
    const spread = spreadLayout[localSpreadIndex];
    if (!spread) return;

    cancelSnapAnimation();

    const bounds = getSpreadBounds(spread);

    // If content fits horizontally, no panning needed
    if (bounds.fitsHorizontally) return;

    const panAmount = viewportWidth * 0.3;
    let targetX: number;

    if (direction === 'left') {
      // Pan left = shift content right = increase transform.x
      const remainingToLeft = bounds.leftX - transform.x;
      const actualPan = Math.min(panAmount, remainingToLeft);
      targetX = transform.x + actualPan;
    } else {
      // Pan right = shift content left = decrease transform.x
      const remainingToRight = transform.x - bounds.rightX;
      const actualPan = Math.min(panAmount, remainingToRight);
      targetX = transform.x - actualPan;
    }

    animateToX(targetX);
  }

  /**
   * Animate to a target X position with ease-out cubic easing.
   */
  function animateToX(targetX: number): void {
    cancelSnapAnimation();

    const startX = transform.x;
    const distance = targetX - startX;

    if (Math.abs(distance) < 1) {
      transform.x = targetX;
      draw();
      return;
    }

    const duration = Math.min(200, Math.max(100, Math.abs(distance) * 0.3));
    const startTime = performance.now();

    function animate(currentTime: number) {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);

      transform.x = startX + distance * eased;
      draw();

      if (progress < 1) {
        snapAnimationId = requestAnimationFrame(animate);
      } else {
        snapAnimationId = null;
      }
    }

    snapAnimationId = requestAnimationFrame(animate);
  }

  /**
   * Animate to a target Y position with ease-out cubic easing.
   * Duration scales with distance for natural feel.
   */
  function animateToY(targetY: number): void {
    cancelSnapAnimation();

    const startY = transform.y;
    const distance = targetY - startY;

    // Skip animation if distance is tiny
    if (Math.abs(distance) < 1) {
      transform.y = targetY;
      draw();
      return;
    }

    // Scale duration based on distance: 100ms min, 200ms max
    const duration = Math.min(200, Math.max(100, Math.abs(distance) * 0.3));
    const startTime = performance.now();

    function animate(currentTime: number) {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);

      // Ease-out cubic for smooth deceleration
      const eased = 1 - Math.pow(1 - progress, 3);

      transform.y = startY + distance * eased;
      draw();

      if (progress < 1) {
        snapAnimationId = requestAnimationFrame(animate);
      } else {
        snapAnimationId = null;
      }
    }

    snapAnimationId = requestAnimationFrame(animate);
  }

  function isInputFocused(): boolean {
    const active = document.activeElement;
    return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
  }

  // ============================================
  // SPREAD NAVIGATION
  // ============================================

  function getCurrentSpreadIndex(): number {
    // Find which spread is most visible based on viewport center
    // yOffset is in scaled space (before userZoomMultiplier)
    const viewCenterY = (-transform.y + viewportHeight / 2) / userZoomMultiplier;

    if (spreadLayout.length === 0) return 0;
    if (viewCenterY < 0) return 0;

    // Find the spread that contains the view center.
    // Iterate from the end to handle gaps between spreads correctly -
    // gaps are attributed to the spread above them.
    for (let i = spreadLayout.length - 1; i >= 0; i--) {
      const s = spreadLayout[i];
      if (viewCenterY >= s.yOffset) {
        return i;
      }
    }

    return 0;
  }

  function checkSpreadTransition(): void {
    const newSpreadIndex = getCurrentSpreadIndex();
    if (newSpreadIndex !== localSpreadIndex) {
      // Update local state
      localSpreadIndex = newSpreadIndex;

      // Notify parent
      const newSpread = spreads[newSpreadIndex];
      if (newSpread) {
        const newPage = newSpread.pageIndices[0] + 1;
        const { charCount } = getCharCount(pages, newPage);
        const isComplete = newSpreadIndex === spreads.length - 1;
        lastExternalPage = newPage;
        onPageChange(newPage, charCount, isComplete);
        activityTracker.recordActivity();
      }
    }
  }

  function jumpToSpread(
    index: number,
    position: 'top' | 'bottom' = 'top',
    animate: boolean = true
  ): void {
    if (index < 0) {
      onVolumeNav('prev');
      return;
    }
    if (index >= spreads.length) {
      onVolumeNav('next');
      return;
    }

    cancelSnapAnimation();

    // Navigate within existing spread structure (don't change anchor)
    const targetSpread = spreads[index];
    if (!targetSpread) return;

    localSpreadIndex = index;
    const spread = spreadLayout[index];
    if (!spread) return;

    const targetY = getSpreadTargetY(spread, position) ?? -spread.yOffset * userZoomMultiplier;

    // Notify parent
    const newPage = targetSpread.pageIndices[0] + 1;
    lastExternalPage = newPage;
    const { charCount } = getCharCount(pages, newPage);
    const isComplete = index === spreads.length - 1;
    onPageChange(newPage, charCount, isComplete);
    activityTracker.recordActivity();

    // Reset horizontal position when changing spreads
    transform.x = 0;

    if (animate) {
      animateToY(targetY);
    } else {
      transform.y = targetY;
      draw();
    }
  }

  // ============================================
  // ZOOM MODES
  // ============================================

  function applyZoomMode(): void {
    const spread = spreadLayout[localSpreadIndex];
    if (!spread) {
      console.warn(
        `[applyZoomMode] No spread at index ${localSpreadIndex}, spreadLayout.length=${spreadLayout.length}`
      );
      // Still schedule a draw to show something
      scheduleDraw();
      return;
    }

    console.log(
      `[applyZoomMode] Applying zoom for spread ${localSpreadIndex}, yOffset=${spread.yOffset}`
    );

    // Reset user zoom multiplier - per-spread scales handle the zoom mode
    userZoomMultiplier = 1;

    // DON'T clear pageCanvases - keep old ones visible until new ones replace them
    // The draw function will scale old canvases (slow path) until new ones are ready
    // Just clear the scale tracking so preRenderPage knows to re-render
    pageCanvasesSpreadScale.clear();

    // Center horizontally and position at top of spread
    // yOffset is already in per-spread scaled space
    transform.x = 0; // Centering handled in draw()
    transform.y = -spread.yOffset * userZoomMultiplier;

    // Trigger cache effect to re-run and load pages at new zoom
    cacheInvalidationCounter++;
    scheduleDraw();
  }

  // ============================================
  // SCROLL SNAP (with smooth animation)
  // ============================================

  let wheelSnapTimeout: ReturnType<typeof setTimeout> | null = null;

  function scheduleSnapAfterWheel(): void {
    if (!$settings.scrollSnap) return;
    if (wheelSnapTimeout) {
      clearTimeout(wheelSnapTimeout);
    }
    wheelSnapTimeout = setTimeout(() => {
      snapToNearestBoundary();
      wheelSnapTimeout = null;
    }, 50); // Snap quickly while momentum is still visible
  }

  function cancelSnapAnimation(): void {
    if (snapAnimationId !== null) {
      cancelAnimationFrame(snapAnimationId);
      snapAnimationId = null;
    }
  }

  /**
   * Get the valid Y position bounds for a spread.
   * Returns topY, bottomY (for content larger than viewport), and centerY (for content that fits).
   */
  function getSpreadBounds(spread: SpreadLayout): {
    topY: number;
    bottomY: number;
    centerY: number;
    fitsInViewport: boolean;
    leftX: number;
    rightX: number;
    centerX: number;
    fitsHorizontally: boolean;
  } {
    const scaledHeight = spread.scaledHeight * userZoomMultiplier;
    const topY = -spread.yOffset * userZoomMultiplier;
    const bottomY = topY + viewportHeight - scaledHeight;
    const centerY = topY + (viewportHeight - scaledHeight) / 2;

    const scaledWidth = spread.scaledWidth * userZoomMultiplier;
    // When transform.x = 0, spread is centered. leftX/rightX are the bounds for transform.x
    // Positive transform.x shifts content right (shows left edge)
    // Negative transform.x shifts content left (shows right edge)
    const leftX = 0; // Can't shift right past center
    const rightX = 0; // Can't shift left past center
    const maxShift = (scaledWidth - viewportWidth) / 2;
    const fitsHorizontally = scaledWidth <= viewportWidth;

    return {
      topY,
      bottomY,
      centerY,
      fitsInViewport: scaledHeight <= viewportHeight,
      leftX: fitsHorizontally ? 0 : maxShift,
      rightX: fitsHorizontally ? 0 : -maxShift,
      centerX: 0,
      fitsHorizontally
    };
  }

  /**
   * Calculate dynamic fling threshold based on proximity to spread boundary.
   * The closer the boundary is to the viewport center, the easier it is to trigger paging.
   * @param velocityDirection - 'up' (vy > 0, going to previous) or 'down' (vy < 0, going to next)
   * @returns threshold in px/s - lower means easier to trigger page change
   */
  function getDynamicFlingThreshold(velocityDirection: 'up' | 'down'): number {
    const spread = spreadLayout[localSpreadIndex];
    if (!spread) {
      // Fallback to base threshold
      return ($settings.swipeThreshold / 100) * viewportHeight * 5;
    }

    const viewportCenterY = viewportHeight / 2;

    // Determine which boundary we're approaching
    // When scrolling down (velocityDirection === 'down'), we approach the bottom boundary
    // When scrolling up (velocityDirection === 'up'), we approach the top boundary
    // Screen position = transform.y + (content position * userZoomMultiplier)
    const spreadTopOnScreen = transform.y + spread.yOffset * userZoomMultiplier;
    const spreadHeightOnScreen = spread.scaledHeight * userZoomMultiplier;

    let boundaryScreenY: number;
    if (velocityDirection === 'down') {
      // Bottom boundary: top of spread + height of spread
      boundaryScreenY = spreadTopOnScreen + spreadHeightOnScreen;
    } else {
      // Top boundary
      boundaryScreenY = spreadTopOnScreen;
    }

    // Distance from boundary to viewport center (in pixels)
    const distanceFromCenter = Math.abs(boundaryScreenY - viewportCenterY);

    // Half viewport = screen edge
    const halfViewport = viewportHeight / 2;

    // If boundary is off-screen, don't allow paging via fling
    if (distanceFromCenter > halfViewport) {
      return Infinity;
    }

    // Base threshold from user settings
    const baseThreshold = ($settings.swipeThreshold / 100) * viewportHeight;

    // Scale from 0x at center to 1x at screen edge
    // When boundary is at viewport center, even tiny inertia should trigger paging
    const scaleFactor = distanceFromCenter / halfViewport;

    return baseThreshold * scaleFactor;
  }

  /**
   * Determine which boundary we need to snap to based on current position.
   * @returns 'top' if past top, 'bottom' if past bottom, null if within valid bounds
   */
  function getSnapDirection(spread: SpreadLayout): 'top' | 'bottom' | null {
    const bounds = getSpreadBounds(spread);

    // Content fits - check if we're not centered
    if (bounds.fitsInViewport) {
      const tolerance = 1;
      if (Math.abs(transform.y - bounds.centerY) > tolerance) {
        // Need to center - use 'top' since both resolve to centerY anyway
        return 'top';
      }
      return null;
    }

    // Content larger than viewport - check boundaries
    if (transform.y > bounds.topY) {
      return 'top';
    } else if (transform.y < bounds.bottomY) {
      return 'bottom';
    }
    return null;
  }

  /**
   * Calculate the target Y position for a spread based on desired alignment.
   * Centers content if it fits in viewport, otherwise aligns to edge.
   * @param spread - The spread layout to position
   * @param position - 'top' or 'bottom' edge alignment (centers if content fits)
   * @returns The target Y position
   */
  function getSpreadTargetY(spread: SpreadLayout, position: 'top' | 'bottom'): number {
    const bounds = getSpreadBounds(spread);

    // Content fits in viewport - always center
    if (bounds.fitsInViewport) {
      return bounds.centerY;
    }

    // Content larger than viewport - align to requested edge
    return position === 'bottom' ? bounds.bottomY : bounds.topY;
  }

  /**
   * Check if we're at a boundary of the current spread and should change pages.
   * @param direction - 'up' (toward previous spread) or 'down' (toward next spread)
   * @param threshold - pixel threshold for boundary detection
   * @returns true if at the boundary in the given direction
   */
  function isAtSpreadBoundary(direction: 'up' | 'down', threshold: number = 2): boolean {
    const spread = spreadLayout[localSpreadIndex];
    if (!spread) return false;

    const bounds = getSpreadBounds(spread);

    if (direction === 'up') {
      // At top boundary?
      return transform.y >= bounds.topY - threshold;
    } else {
      // At bottom boundary? (use centerY if content fits)
      const effectiveBottomY = bounds.fitsInViewport ? bounds.centerY : bounds.bottomY;
      return transform.y <= effectiveBottomY + threshold;
    }
  }

  function snapToNearestBoundary(): void {
    const spread = spreadLayout[localSpreadIndex];
    if (!spread) return;

    const bounds = getSpreadBounds(spread);

    // Snap horizontal to center if content fits
    if (bounds.fitsHorizontally && transform.x !== 0) {
      transform.x = 0;
    }

    const direction = getSnapDirection(spread);
    if (direction === null) {
      // Already in valid Y position, but still draw to apply any X changes
      draw();
      return;
    }

    const targetY = getSpreadTargetY(spread, direction);
    animateToY(targetY);
  }

  // ============================================
  // TEXT OVERLAY
  // ============================================

  // Buffer for text overlay - keep more spreads in DOM to avoid recreation during scroll
  const TEXT_OVERLAY_BUFFER = 5;

  // Get text boxes for visible spreads
  let visibleTextBoxData = $derived.by(() => {
    const result: {
      spreadIndex: number;
      yOffset: number;
      pageLayouts: {
        pageIndex: number;
        xOffset: number;
        page: Page;
        file: File | undefined;
      }[];
    }[] = [];

    // Wide buffer to minimize DOM recreation during scroll
    const startIdx = Math.max(0, localSpreadIndex - TEXT_OVERLAY_BUFFER);
    const endIdx = Math.min(spreadLayout.length - 1, localSpreadIndex + TEXT_OVERLAY_BUFFER);

    for (let i = startIdx; i <= endIdx; i++) {
      const sl = spreadLayout[i];
      if (!sl) continue;

      const spread = spreads[i];
      const pageLayouts = sl.pageLayouts.map((pl) => ({
        pageIndex: pl.pageIndex,
        xOffset: pl.xOffset,
        page: pages[pl.pageIndex],
        file: imageCache.getFile(pl.pageIndex)
      }));

      result.push({
        spreadIndex: i,
        yOffset: sl.yOffset,
        pageLayouts
      });
    }

    return result;
  });
</script>

<svelte:window on:keydown={handleKeydown} />

<div
  class="pure-canvas-reader"
  role="presentation"
  style:background-color={$settings.backgroundColor}
  onmousedown={handleMouseDown}
  onmousemove={handleMouseMove}
  onmouseup={handleMouseUp}
  onmouseleave={handleMouseUp}
  onclick={handleClick}
  ondblclick={handleDoubleClick}
  onwheel={handleWheel}
  ontouchstart={handleTouchStart}
  ontouchmove={handleTouchMove}
  ontouchend={handleTouchEnd}
>
  <!-- Content layer: Canvas + text overlay (inverted together, background stays normal) -->
  <div class="content-layer" style:filter={`invert(${$invertColorsActive ? 1 : 0})`}>
    <!-- Back layer: Canvas for images -->
    <canvas bind:this={canvasEl} class="main-canvas"></canvas>

    <!-- Front layer: Text overlay (positioned via JS) -->
    <div bind:this={textOverlayEl} class="text-overlay" style:transform-origin="0 0">
      {#each visibleTextBoxData as spreadData (spreadData.spreadIndex)}
        {@const sl = spreadLayout[spreadData.spreadIndex]}
        {#if sl}
          {@const effectiveScale = sl.scale * userZoomMultiplier}
          <div
            class="spread-overlay"
            style:top={`${sl.yOffset * userZoomMultiplier}px`}
            style:left={`${(viewportWidth - sl.width * effectiveScale) / 2}px`}
            style:width={`${sl.width}px`}
            style:height={`${sl.height}px`}
            style:transform={`scale(${effectiveScale})`}
            style:transform-origin="0 0"
          >
            {#each spreadData.pageLayouts as pl (pl.pageIndex)}
              <div
                class="page-overlay"
                style:left={`${pl.xOffset}px`}
                style:width={`${pl.page.img_width}px`}
                style:height={`${pl.page.img_height}px`}
              >
                <TextBoxes
                  page={pl.page}
                  src={pl.file}
                  volumeUuid={volume.volume_uuid}
                  forceVisible={missingPagePaths.has(pl.page.img_path)}
                />
              </div>
            {/each}
          </div>
        {/if}
      {/each}
    </div>
  </div>
</div>

<style>
  .pure-canvas-reader {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    overflow: hidden;
    background-color: #1a1a1a; /* fallback, overridden by inline style */
    /* Prevent native touch gestures (scroll, zoom, pull-to-refresh) on iOS Safari */
    touch-action: none;
    -webkit-overflow-scrolling: auto;
    overscroll-behavior: none;
  }

  .content-layer {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
  }

  .main-canvas {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    z-index: 1;
    /* Canvas never moves - we control drawing ourselves */
  }

  .text-overlay {
    position: absolute;
    top: 0;
    left: 0;
    z-index: 2;
    /* Transform applied via JS for synchronous updates */
    pointer-events: none;
  }

  .spread-overlay {
    position: absolute;
    pointer-events: none;
    /* Let browser skip rendering when off-screen */
    content-visibility: auto;
  }

  .page-overlay {
    position: absolute;
    top: 0;
    pointer-events: auto;
    /* Let browser skip rendering when off-screen */
    content-visibility: auto;
  }

  /* Allow text selection in text boxes */
  .page-overlay :global(.textBox) {
    pointer-events: auto;
  }
</style>
