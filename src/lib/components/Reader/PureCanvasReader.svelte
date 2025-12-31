<script lang="ts">
  import type { Page, VolumeMetadata } from '$lib/types';
  import type { VolumeSettings } from '$lib/settings';
  import { settings, invertColorsActive } from '$lib/settings';
  import {
    groupPagesIntoSpreads,
    findSpreadForPage,
    type PageSpread
  } from '$lib/reader/spread-grouping';
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
  }

  let { pages, files, volume, volumeSettings, currentPage, onPageChange, onVolumeNav }: Props =
    $props();

  // ============================================
  // CORE STATE
  // ============================================

  // Transform state - NOT using panzoom, we control everything
  let transform = $state({ x: 0, y: 0, scale: 1 });

  // Canvas refs
  let canvasEl: HTMLCanvasElement | undefined = $state();
  let ctx: CanvasRenderingContext2D | null = null;
  let backBuffer: HTMLCanvasElement | undefined;
  let backCtx: CanvasRenderingContext2D | null = null;

  // Text overlay ref (for direct DOM manipulation)
  let textOverlayEl: HTMLDivElement | undefined = $state();

  // Viewport dimensions
  let viewportWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1920);
  let viewportHeight = $state(typeof window !== 'undefined' ? window.innerHeight : 1080);

  // Pre-rendered page canvases (OffscreenCanvas where supported)
  let pageCanvases = new Map<number, OffscreenCanvas | HTMLCanvasElement>();

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

  // ============================================
  // SPREAD LAYOUT
  // ============================================

  // Reactive portrait detection for auto mode
  let isPortrait = $derived(viewportWidth <= viewportHeight);

  // Reactive settings for spread calculation
  let pageViewMode = $derived(volumeSettings.singlePageView ?? 'auto');
  let hasCover = $derived(volumeSettings.hasCover ?? true);
  let rtl = $derived(volumeSettings.rightToLeft ?? true);

  // Calculate pairing offset based on current page
  // Current page should always be first of its spread
  let pairingOffset = $derived.by(() => {
    // Access all dependencies BEFORE any early returns to ensure Svelte tracks them
    const anchorPage = currentPage - 1;
    const mode = pageViewMode;
    const cover = hasCover;
    const portrait = isPortrait;

    if (anchorPage <= 0) return 0;
    if (mode === 'single') return 0;
    if (portrait && mode === 'auto') return 0;

    // With hasCover: odd pages (1,3,5) are naturally first
    // Without hasCover: even pages (0,2,4) are naturally first
    const naturallyFirst = cover ? anchorPage % 2 === 1 : anchorPage % 2 === 0;
    return naturallyFirst ? 0 : 1;
  });

  // Group pages into spreads based on settings
  // Explicitly access dependencies in the derived to ensure tracking
  let spreads = $derived.by(() => {
    const p = pages;
    const mode = pageViewMode;
    const cover = hasCover;
    const direction = rtl;
    const portrait = isPortrait;
    const offset = pairingOffset;
    return groupPagesIntoSpreads(p, mode, cover, direction, portrait, offset);
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
    yOffset: number; // Cumulative Y position in content space
    width: number;
    height: number;
    pageLayouts: PageLayout[];
  }

  // Calculate spread layout (all spreads stacked vertically)
  let spreadLayout = $derived.by((): SpreadLayout[] => {
    const layouts: SpreadLayout[] = [];
    let yOffset = 0;
    const pageGap = 20; // Gap between spreads

    for (let i = 0; i < spreads.length; i++) {
      const spread = spreads[i];
      const pageLayouts: PageLayout[] = [];

      if (spread.type === 'single') {
        const page = spread.pages[0];
        const pageIdx = spread.pageIndices[0];
        pageLayouts.push({
          pageIndex: pageIdx,
          xOffset: 0,
          width: page.img_width,
          height: page.img_height
        });
        layouts.push({
          spreadIndex: i,
          yOffset,
          width: page.img_width,
          height: page.img_height,
          pageLayouts
        });
        yOffset += page.img_height + pageGap;
      } else {
        // Dual spread
        const [page1, page2] = spread.pages;
        const [idx1, idx2] = spread.pageIndices;
        const height = Math.max(page1.img_height, page2.img_height);
        const width = page1.img_width + page2.img_width;

        // RTL: right page first, then left page
        if (rtl) {
          pageLayouts.push({
            pageIndex: idx2,
            xOffset: 0,
            width: page2.img_width,
            height: page2.img_height
          });
          pageLayouts.push({
            pageIndex: idx1,
            xOffset: page2.img_width,
            width: page1.img_width,
            height: page1.img_height
          });
        } else {
          pageLayouts.push({
            pageIndex: idx1,
            xOffset: 0,
            width: page1.img_width,
            height: page1.img_height
          });
          pageLayouts.push({
            pageIndex: idx2,
            xOffset: page1.img_width,
            width: page2.img_width,
            height: page2.img_height
          });
        }

        layouts.push({
          spreadIndex: i,
          yOffset,
          width,
          height,
          pageLayouts
        });
        yOffset += height + pageGap;
      }
    }

    return layouts;
  });

  // Total content height
  let totalContentHeight = $derived(
    spreadLayout.length > 0
      ? spreadLayout[spreadLayout.length - 1].yOffset + spreadLayout[spreadLayout.length - 1].height
      : 0
  );

  // ============================================
  // SYNC WITH EXTERNAL PAGE CHANGES
  // ============================================

  let lastExternalPage = $state(currentPage);
  $effect(() => {
    if (currentPage !== lastExternalPage) {
      lastExternalPage = currentPage;
      const pageIndex = currentPage - 1;
      const targetSpreadIndex = findSpreadForPage(spreads, pageIndex);
      if (targetSpreadIndex >= 0 && targetSpreadIndex !== localSpreadIndex) {
        localSpreadIndex = targetSpreadIndex;
        tick().then(() => {
          applyZoomMode();
        });
      }
    }
  });

  // Sync when spreads change (e.g., hasCover toggle)
  let lastSpreadsKey = $state('');
  $effect(() => {
    const spreadsKey = spreads.map((s) => s.pageIndices.join('-')).join('|');
    if (spreadsKey !== lastSpreadsKey) {
      lastSpreadsKey = spreadsKey;
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

  // Watch for zoom mode changes
  let lastZoomMode = $state($settings.zoomDefault);
  $effect(() => {
    const zoomMode = $settings.zoomDefault;
    if (zoomMode !== lastZoomMode) {
      lastZoomMode = zoomMode;
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

  const PRERENDER_BUFFER = 2;
  const PRELOAD_BUFFER = 4;

  // Pre-render pages to OffscreenCanvas
  function preRenderPage(pageIndex: number, bitmap: ImageBitmap, page: Page): void {
    if (pageCanvases.has(pageIndex)) return;

    // Use OffscreenCanvas if available, otherwise HTMLCanvasElement
    let canvas: OffscreenCanvas | HTMLCanvasElement;
    let pCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;

    if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(page.img_width, page.img_height);
      pCtx = canvas.getContext('2d');
    } else {
      canvas = document.createElement('canvas');
      canvas.width = page.img_width;
      canvas.height = page.img_height;
      pCtx = canvas.getContext('2d');
    }

    if (pCtx) {
      pCtx.drawImage(bitmap, 0, 0);
      pageCanvases.set(pageIndex, canvas);
      // Update bitmapsReady to trigger re-render
      bitmapsReady = new Set([...bitmapsReady, pageIndex]);
    }
  }

  // Load and pre-render pages in the window around current spread
  $effect(() => {
    if (!cacheInitialized) return;

    const currentSpread = spreads[localSpreadIndex];
    if (!currentSpread) return;

    const centerPageIdx = currentSpread.pageIndices[0];
    imageCache.updateCache(files, pages, centerPageIdx);

    // Preload spreads in a wider window
    const startIdx = Math.max(0, localSpreadIndex - PRELOAD_BUFFER);
    const endIdx = Math.min(spreads.length - 1, localSpreadIndex + PRELOAD_BUFFER);

    for (let i = startIdx; i <= endIdx; i++) {
      const spread = spreads[i];
      if (spread) {
        for (const pageIdx of spread.pageIndices) {
          if (!pageCanvases.has(pageIdx)) {
            // Try sync first
            const bitmap = imageCache.getBitmapSync(pageIdx);
            if (bitmap) {
              preRenderPage(pageIdx, bitmap, pages[pageIdx]);
            } else {
              // Request async
              imageCache.getBitmap(pageIdx).then((resolvedBitmap) => {
                if (resolvedBitmap && !pageCanvases.has(pageIdx)) {
                  preRenderPage(pageIdx, resolvedBitmap, pages[pageIdx]);
                  scheduleDraw();
                }
              });
            }
          }
        }
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

    // Get 2D context with high-quality image rendering
    ctx = canvasEl.getContext('2d');
    if (ctx) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
    }

    // Set canvas size accounting for device pixel ratio (for sharp rendering on HiDPI)
    canvasEl.width = viewportWidth * dpr;
    canvasEl.height = viewportHeight * dpr;
    // CSS size stays at viewport size
    canvasEl.style.width = `${viewportWidth}px`;
    canvasEl.style.height = `${viewportHeight}px`;

    // Create back buffer at HiDPI resolution
    backBuffer = document.createElement('canvas');
    backBuffer.width = viewportWidth * dpr;
    backBuffer.height = viewportHeight * dpr;
    backCtx = backBuffer.getContext('2d');
    if (backCtx) {
      backCtx.imageSmoothingEnabled = true;
      backCtx.imageSmoothingQuality = 'high';
    }
  }

  onMount(() => {
    setupCanvas();

    // Handle window resize
    const handleResize = () => {
      viewportWidth = window.innerWidth;
      viewportHeight = window.innerHeight;
      dpr = window.devicePixelRatio || 1;

      if (canvasEl) {
        canvasEl.width = viewportWidth * dpr;
        canvasEl.height = viewportHeight * dpr;
        canvasEl.style.width = `${viewportWidth}px`;
        canvasEl.style.height = `${viewportHeight}px`;
      }
      if (backBuffer) {
        backBuffer.width = viewportWidth * dpr;
        backBuffer.height = viewportHeight * dpr;
      }
      applyZoomMode();
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
    // Clean up pre-rendered canvases
    pageCanvases.clear();
    imageCache.cleanup();
  });

  // ============================================
  // DRAW FUNCTION (THE HEART OF THE SYSTEM)
  // ============================================

  let drawScheduled = false;

  function scheduleDraw() {
    if (drawScheduled) return;
    drawScheduled = true;
    requestAnimationFrame(() => {
      drawScheduled = false;
      draw();
    });
  }

  function draw(): void {
    if (!ctx || !backCtx || !backBuffer) return;

    // Ensure high-quality image scaling (canvas state can be reset)
    backCtx.imageSmoothingEnabled = true;
    backCtx.imageSmoothingQuality = 'high';

    // All drawing is done at HiDPI resolution (CSS pixels * dpr)
    const canvasW = viewportWidth * dpr;
    const canvasH = viewportHeight * dpr;

    // 1. Clear back buffer
    backCtx.fillStyle = $settings.backgroundColor || '#1a1a1a';
    backCtx.fillRect(0, 0, canvasW, canvasH);

    // 2. Calculate which spreads are visible
    const visibleSpreads = getVisibleSpreads();

    // 3. Draw each visible spread
    for (const sl of visibleSpreads) {
      // Calculate spread center X position (in CSS pixels)
      const spreadScreenX = (viewportWidth - sl.width * transform.scale) / 2;

      for (const pl of sl.pageLayouts) {
        const source = pageCanvases.get(pl.pageIndex);
        if (!source) continue;

        // Calculate positions in CSS pixels
        const screenX = spreadScreenX + pl.xOffset * transform.scale;
        const screenY = sl.yOffset * transform.scale + transform.y;
        const screenW = pl.width * transform.scale;
        const screenH = pl.height * transform.scale;

        // Culling: skip if completely off-screen (in CSS pixels)
        if (screenX + screenW < 0 || screenX > viewportWidth) continue;
        if (screenY + screenH < 0 || screenY > viewportHeight) continue;

        // Draw at HiDPI resolution (multiply by dpr)
        backCtx.drawImage(source, screenX * dpr, screenY * dpr, screenW * dpr, screenH * dpr);
      }
    }

    // 4. Blit to visible canvas (atomic, no flash)
    ctx.drawImage(backBuffer, 0, 0);

    // 5. Update text overlay position (synchronous DOM update)
    updateTextOverlayPosition();
  }

  function getVisibleSpreads(): SpreadLayout[] {
    const result: SpreadLayout[] = [];

    for (const sl of spreadLayout) {
      const screenY = sl.yOffset * transform.scale + transform.y;
      const screenH = sl.height * transform.scale;

      // Check if spread is visible (with some buffer)
      if (screenY + screenH >= -viewportHeight && screenY <= viewportHeight * 2) {
        result.push(sl);
      }
    }

    return result;
  }

  function updateTextOverlayPosition(): void {
    if (!textOverlayEl) return;
    // Position the text overlay container to match the canvas transform
    textOverlayEl.style.transform = `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`;
  }

  // Trigger draw when bitmaps become ready
  $effect(() => {
    // Reference bitmapsReady to create dependency
    const _ = bitmapsReady.size;
    if (ctx && backCtx) {
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
    isDragging = true;
    dragStart = { x: e.clientX, y: e.clientY };
    transformStart = { x: transform.x, y: transform.y };
  }

  function handleMouseMove(e: MouseEvent): void {
    if (!isDragging) return;

    transform.x = transformStart.x + (e.clientX - dragStart.x);
    transform.y = transformStart.y + (e.clientY - dragStart.y);

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
  function isTextBoxClick(e: MouseEvent): boolean {
    const target = e.target as HTMLElement;
    return target.closest('.textBox') !== null;
  }

  // Wheel scroll/zoom
  function handleWheel(e: WheelEvent): void {
    e.preventDefault();
    cancelSnapAnimation(); // Stop any ongoing snap

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

  // Zoom at point
  function zoomAt(clientX: number, clientY: number, scaleDelta: number): void {
    const newScale = Math.max(0.1, Math.min(10, transform.scale * scaleDelta));
    const ratio = newScale / transform.scale;

    // Keep point under cursor stationary
    transform.x = clientX - (clientX - transform.x) * ratio;
    transform.y = clientY - (clientY - transform.y) * ratio;
    transform.scale = newScale;

    draw();
  }

  // Touch handling
  let activeTouches: Touch[] = [];
  let initialPinchDistance = 0;
  let initialScale = 1;
  let initialPinchCenter = { x: 0, y: 0 };

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
    cancelSnapAnimation(); // Stop any ongoing snap
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
      initialScale = transform.scale;
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

      const newDistance = getTouchDistance(newTouches[0], newTouches[1]);
      const newCenter = getTouchCenter(newTouches[0], newTouches[1]);
      const scale = (newDistance / initialPinchDistance) * initialScale;

      // Zoom towards pinch center
      const ratio = scale / transform.scale;
      transform.x = newCenter.x - (newCenter.x - transform.x) * ratio;
      transform.y = newCenter.y - (newCenter.y - transform.y) * ratio;
      transform.scale = scale;

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
    activeTouches = Array.from(e.touches);

    if (activeTouches.length === 0) {
      isDragging = false;

      // Calculate velocity for inertial scrolling
      if (wasDragging && velocitySamples.length >= 2) {
        const velocity = calculateVelocity();

        // Only apply inertia if velocity is significant
        const speed = Math.sqrt(velocity.vx * velocity.vx + velocity.vy * velocity.vy);
        if (speed > 100) {
          // px/s threshold
          startInertialScroll(velocity.vx, velocity.vy);
          return; // Don't snap immediately, inertia will handle it
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

    const friction = 0.95; // Deceleration factor per frame (lower = faster stop)
    const minVelocity = 250; // Stop when velocity drops below this (px/s)
    let lastTime = performance.now();

    function animate(currentTime: number) {
      const dt = (currentTime - lastTime) / 1000; // Delta time in seconds
      lastTime = currentTime;

      // Apply velocity
      transform.x += vx * dt;
      transform.y += vy * dt;

      // Apply friction
      vx *= friction;
      vy *= friction;

      draw();
      checkSpreadTransition();

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

    const scaledHeight = spread.height * transform.scale;
    const topY = -spread.yOffset * transform.scale;
    const bottomY = topY + viewportHeight - scaledHeight;

    // How much we want to pan (60% of viewport)
    const panAmount = viewportHeight * 0.6;

    // Small threshold for "at boundary" detection
    const threshold = 2;

    let targetY: number;

    if (direction === 'up') {
      // Check if already at top boundary
      if (transform.y >= topY - threshold) {
        // At top - go to bottom of previous page (to continue reading upward)
        jumpToSpread(localSpreadIndex - 1, 'bottom');
        return;
      }

      // Calculate how much we can pan up (toward topY, which is >= current y)
      const remainingToTop = topY - transform.y;
      const actualPan = Math.min(panAmount, remainingToTop);

      targetY = transform.y + actualPan;
    } else {
      // Check if already at bottom boundary (or content fits in viewport)
      const effectiveBottomY =
        scaledHeight <= viewportHeight
          ? topY + (viewportHeight - scaledHeight) / 2 // Centered position
          : bottomY;

      if (transform.y <= effectiveBottomY + threshold) {
        // At bottom - go to top of next page (to continue reading downward)
        jumpToSpread(localSpreadIndex + 1, 'top');
        return;
      }

      // Calculate how much we can pan down (toward bottomY, which is <= current y)
      const remainingToBottom = transform.y - effectiveBottomY;
      const actualPan = Math.min(panAmount, remainingToBottom);

      targetY = transform.y - actualPan;
    }

    // Animate to target position
    animatePanTo(targetY);
  }

  /**
   * Animate pan to a target Y position
   */
  function animatePanTo(targetY: number): void {
    cancelSnapAnimation();

    // Capture start position and time on first frame to avoid race conditions
    let startY: number | null = null;
    let startTime: number | null = null;
    let distance: number;
    let duration: number;

    function animate(currentTime: number) {
      // Capture on first frame after any pending effects have run
      if (startY === null) {
        startY = transform.y;
        startTime = currentTime;
        distance = targetY - startY;

        // Skip animation if distance is tiny
        if (Math.abs(distance) < 1) {
          transform.y = targetY;
          draw();
          snapAnimationId = null;
          return;
        }

        // Scale duration based on distance: 100ms min, 200ms max
        duration = Math.min(200, Math.max(100, Math.abs(distance) * 0.4));
      }

      const elapsed = currentTime - startTime!;
      const progress = Math.min(elapsed / duration, 1);

      // Linear easing for consistent key pan movement
      transform.y = startY + distance * progress;
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
    const viewCenterY = (-transform.y + viewportHeight / 2) / transform.scale;

    for (let i = 0; i < spreadLayout.length; i++) {
      const s = spreadLayout[i];
      if (viewCenterY >= s.yOffset && viewCenterY < s.yOffset + s.height) {
        return i;
      }
    }

    return viewCenterY < 0 ? 0 : spreadLayout.length - 1;
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
    localSpreadIndex = index;
    const spread = spreadLayout[index];
    if (!spread) return;

    const scaledHeight = spread.height * transform.scale;
    let targetY: number;

    if (position === 'bottom') {
      // Position so bottom of spread aligns with bottom of viewport
      // (or center if spread fits in viewport)
      if (scaledHeight <= viewportHeight) {
        targetY = -spread.yOffset * transform.scale + (viewportHeight - scaledHeight) / 2;
      } else {
        targetY = -spread.yOffset * transform.scale + viewportHeight - scaledHeight;
      }
    } else {
      // Position spread at top of viewport
      targetY = -spread.yOffset * transform.scale;
    }

    // Notify parent
    const newPage = spreads[index].pageIndices[0] + 1;
    const { charCount } = getCharCount(pages, newPage);
    const isComplete = index === spreads.length - 1;
    lastExternalPage = newPage;
    onPageChange(newPage, charCount, isComplete);
    activityTracker.recordActivity();

    if (animate) {
      animatePanTo(targetY);
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
    if (!spread) return;

    switch ($settings.zoomDefault) {
      case 'zoomFitToScreen':
        transform.scale = Math.min(viewportWidth / spread.width, viewportHeight / spread.height);
        break;
      case 'zoomFitToWidth':
        transform.scale = viewportWidth / spread.width;
        break;
      case 'zoomOriginal':
        transform.scale = 1;
        break;
    }

    // Center horizontally and position at top of spread
    transform.x = 0; // Centering handled in draw()
    transform.y = -spread.yOffset * transform.scale;

    draw();
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

  function snapToNearestBoundary(): void {
    const spread = spreadLayout[localSpreadIndex];
    if (!spread) return;

    const scaledHeight = spread.height * transform.scale;
    let targetY: number;

    // Calculate target position
    if (scaledHeight <= viewportHeight) {
      // Content fits - center it
      targetY = -spread.yOffset * transform.scale + (viewportHeight - scaledHeight) / 2;
    } else {
      // Snap to nearest boundary (top or bottom)
      const topY = -spread.yOffset * transform.scale;
      const bottomY = topY + viewportHeight - scaledHeight;

      if (transform.y > topY) {
        targetY = topY;
      } else if (transform.y < bottomY) {
        targetY = bottomY;
      } else {
        // Already within bounds, no snap needed
        return;
      }
    }

    // Animate to target
    animateSnapTo(targetY);
  }

  function animateSnapTo(targetY: number): void {
    cancelSnapAnimation();

    const startY = transform.y;
    const distance = targetY - startY;

    // Skip animation if distance is tiny
    if (Math.abs(distance) < 1) {
      transform.y = targetY;
      draw();
      return;
    }

    const duration = 100; // ms - quick snap
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
  style:filter={`invert(${$invertColorsActive ? 1 : 0})`}
  onmousedown={handleMouseDown}
  onmousemove={handleMouseMove}
  onmouseup={handleMouseUp}
  onmouseleave={handleMouseUp}
  onwheel={handleWheel}
  ontouchstart={handleTouchStart}
  ontouchmove={handleTouchMove}
  ontouchend={handleTouchEnd}
>
  <!-- Back layer: Canvas for images -->
  <canvas bind:this={canvasEl} class="main-canvas"></canvas>

  <!-- Front layer: Text overlay (positioned via JS) -->
  <div bind:this={textOverlayEl} class="text-overlay" style:transform-origin="0 0">
    {#each visibleTextBoxData as spreadData (spreadData.spreadIndex)}
      {@const sl = spreadLayout[spreadData.spreadIndex]}
      {#if sl}
        <div
          class="spread-overlay"
          style:top={`${sl.yOffset}px`}
          style:left={`${(viewportWidth / transform.scale - sl.width) / 2}px`}
          style:width={`${sl.width}px`}
          style:height={`${sl.height}px`}
        >
          {#each spreadData.pageLayouts as pl (pl.pageIndex)}
            <div
              class="page-overlay"
              style:left={`${pl.xOffset}px`}
              style:width={`${pl.page.img_width}px`}
              style:height={`${pl.page.img_height}px`}
            >
              <TextBoxes page={pl.page} src={pl.file} volumeUuid={volume.volume_uuid} />
            </div>
          {/each}
        </div>
      {/if}
    {/each}
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
    background: var(--background-color, #1a1a1a);
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
