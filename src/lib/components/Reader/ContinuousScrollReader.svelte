<script lang="ts">
	import type { Page, VolumeMetadata } from '$lib/types';
	import type { VolumeSettings } from '$lib/settings/volume-data';
	import { settings, invertColorsActive } from '$lib/settings';
	import { matchFilesToPages } from '$lib/reader/image-cache';
	import {
		groupPagesIntoSpreads,
		findSpreadForPage,
		detectSpreadBreakpoints,
		type PageSpread
	} from '$lib/reader/spread-grouping';
	import { isPortraitOrientation } from '$lib/reader/page-mode-detection';
	import { getCharCount } from '$lib/util/count-chars';
	import { activityTracker } from '$lib/util/activity-tracker';
	import { TileDecoder, type DecodeResult } from '$lib/reader/tile/tile-decoder';
	import { detectTileConfig, applyUrlParamOverrides } from '$lib/reader/tile/tile-config';
	import {
		computeSpreadLayout,
		VirtualScroller,
		ViewportRenderer,
		CameraController,
		type SpreadLayoutResult,
		type CameraState
	} from '$lib/reader/viewport';
	import TextBoxes from './TextBoxes.svelte';
	import { onMount, onDestroy } from 'svelte';

	// ============================================================
	// Props
	// ============================================================

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

	// ============================================================
	// State
	// ============================================================

	let wrapperDiv: HTMLDivElement | undefined = $state();
	let canvas: HTMLCanvasElement | undefined = $state();
	let overlayRoot: HTMLDivElement | undefined = $state();
	let viewportWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1024);
	let viewportHeight = $state(typeof window !== 'undefined' ? window.innerHeight : 768);

	// Visible spread indices for the text overlay (updated each frame)
	let visibleSpreadIndices = $state<number[]>([]);

	// Core systems (initialized in onMount)
	let renderer: ViewportRenderer | null = null;
	let camera: CameraController | null = null;
	let scroller: VirtualScroller | null = null;
	let decoder: TileDecoder | null = null;
	let tileSize = 512;

	// Zoom
	const ZOOM_LEVELS = [1, 1.5, 2, 3];
	let zoomTarget = 1;

	// Progress tracking
	let lastReportedSpreadIdx = -1;
	let lastReportedPage = currentPage;
	let lastAnchorPageIdx = currentPage - 1; // First page of current spread, for layout anchoring

	// Pointer interaction
	let pointerDownX = 0;
	let pointerDownY = 0;
	let isDragging = false;
	let wasDrag = false;
	let textBoxWasActive = false;
	const DRAG_THRESHOLD = 5;

	// Double-tap
	let lastTapTime = 0;
	const DOUBLE_TAP_DELAY = 300;

	// Scroll settle timer for progress reporting
	let settleTimer: ReturnType<typeof setTimeout> | null = null;

	// ============================================================
	// Derived — spreads, layout
	// ============================================================

	let indexedFiles = $derived.by(() => matchFilesToPages(files, pages));
	let missingPagePaths = $derived(new Set(volume?.missing_page_paths || []));

	let breakpoints = $derived.by(() => {
		const bp = [...(volumeSettings.spreadBreakpoints ?? detectSpreadBreakpoints(pages))];
		if (volumeSettings.hasCover && !bp.includes(0)) bp.push(0);
		return bp.sort((a, b) => a - b);
	});

	// Ephemeral offset: each press of O adds one more breakpoint,
	// shifting pairings by 1 each time. Resets on layout settings change.
	// Spread pairing anchor: the page index that MUST be the first
	// in its spread. Pairing radiates outward from here.
	// null = no anchor (default hasCover/breakpoint behavior).
	let pairingAnchor = $state<number | null>(null);

	// Reactive: re-derives when viewportWidth/viewportHeight change (on resize/rotation)
	let isPortrait = $derived(viewportWidth <= viewportHeight);

	let spreads: PageSpread[] = $derived(
		groupPagesIntoSpreads(
			pages,
			volumeSettings.singlePageView ?? 'auto',
			volumeSettings.rightToLeft ?? true,
			isPortrait,
			breakpoints,
			pairingAnchor ?? undefined
		)
	);

	let layout: SpreadLayoutResult = $derived(
		computeSpreadLayout(spreads, volumeSettings.rightToLeft ?? true)
	);

	/**
	 * Compute the base camera scale from the zoom mode setting.
	 * This is the scale at which a "typical" spread fits the viewport.
	 */
	function baseScale(): number {
		if (layout.items.length === 0) return 1;
		// Use the first spread as reference for base scale
		const ref = layout.items[Math.min(lastReportedSpreadIdx >= 0 ? lastReportedSpreadIdx : 0, layout.items.length - 1)];
		const zoomMode = $settings.continuousZoomDefault;

		if (zoomMode === 'zoomFitToWidth') {
			return viewportWidth / ref.width;
		} else if (zoomMode === 'zoomOriginal') {
			return 1;
		}
		// zoomFitToScreen
		return Math.min(viewportWidth / ref.width, viewportHeight / ref.height);
	}

	// ============================================================
	// Lifecycle
	// ============================================================

	onMount(async () => {
		if (!canvas) return;

		// Detect tile size for this device
		const detected = await detectTileConfig();
		const config = applyUrlParamOverrides(detected);
		tileSize = config.tileSize;

		// Initialize decoder and renderer
		decoder = new TileDecoder();
		renderer = new ViewportRenderer(tileSize);
		await renderer.init(canvas, viewportWidth, viewportHeight);

		// Initialize camera
		camera = new CameraController(
			renderer.stage,
			viewportWidth,
			viewportHeight,
			{
				onFrame: handleCameraFrame,
				onSettle: handleCameraSettle
			}
		);
		camera.setLayout(layout);

		// Initialize virtual scroller
		scroller = new VirtualScroller(layout, viewportHeight);

		// Set initial camera position
		const initialScale = baseScale();
		zoomTarget = 1; // User zoom multiplier starts at 1
		const idx = findSpreadForPage(spreads, currentPage - 1);
		if (idx >= 0) {
			lastReportedSpreadIdx = idx;
			camera.zoomTo(initialScale, viewportWidth / 2, viewportHeight / 2, false);
			camera.snapToSpread(idx, false);
		} else {
			camera.zoomTo(initialScale, viewportWidth / 2, viewportHeight / 2, false);
		}

		// Register wheel listener with passive: false to allow preventDefault
		wrapperDiv?.addEventListener('wheel', handleWheelNative, { passive: false });

		// Listen for offset-spreads event from settings UI
		window.addEventListener('offset-spreads', handleOffsetSpreadsEvent);

		// Do initial visibility check
		updateVisibility();
	});

	function handleWheelNative(e: WheelEvent) {
		e.preventDefault();
		handleWheel(e);
	}

	function handleOffsetSpreadsEvent() {
		offsetSpreads();
	}

	onDestroy(() => {
		wrapperDiv?.removeEventListener('wheel', handleWheelNative);
		window.removeEventListener('offset-spreads', handleOffsetSpreadsEvent);
		camera?.destroy();
		renderer?.destroy();
		decoder?.destroy();
		scroller?.clear();
		if (settleTimer) clearTimeout(settleTimer);
		if (snapTimer) clearTimeout(snapTimer);
	});

	// React to layout changes (settings, orientation, page mode)
	let prevLayout: SpreadLayoutResult | null = null;
	$effect(() => {
		if (layout === prevLayout || !camera || !scroller || !renderer) return;
		const isInitial = prevLayout === null;
		prevLayout = layout;

		// Clear rendered spreads — positions and groupings may have changed.
		// Tiles need re-uploading since spread containers hold position data.
		renderer.clear();
		scroller.clear();

		// Update systems with new layout
		camera.setLayout(layout);
		scroller.setLayout(layout);

		if (!isInitial) {
			// Use the FIRST page of the current spread (stable anchor).
			// Don't use lastReportedPage (max page) — that shifts the
			// anchor forward by 1 on dual spreads.
			const newIdx = findSpreadForPage(spreads, lastAnchorPageIdx);
			if (newIdx >= 0) {
				lastReportedSpreadIdx = newIdx;
				const newScale = baseScale() * zoomTarget;
				camera.zoomTo(newScale, viewportWidth / 2, viewportHeight / 2, false);
				camera.snapToSpread(newIdx, false);
			}
		}

		// Reload visible spreads with new layout
		updateVisibility();
	});

	// React to zoom mode changes
	let prevZoomMode = '';
	$effect(() => {
		const mode = $settings.continuousZoomDefault;
		if (mode === prevZoomMode || !camera) return;
		prevZoomMode = mode;

		const newBase = baseScale();
		camera.zoomTo(newBase * zoomTarget, viewportWidth / 2, viewportHeight / 2, true);
	});

	// React to external page changes
	$effect(() => {
		if (currentPage !== lastReportedPage && camera) {
			lastReportedPage = currentPage;
			const idx = findSpreadForPage(spreads, currentPage - 1);
			if (idx >= 0) {
				lastReportedSpreadIdx = idx;
				camera.snapToSpread(idx, true);
			}
		}
	});

	// ============================================================
	// Camera callbacks
	// ============================================================

	function handleCameraFrame(state: CameraState) {
		// Sync HTML overlay transform
		if (overlayRoot) {
			overlayRoot.style.transform =
				`translate(${-state.x * state.scale}px, ${-state.y * state.scale}px) scale(${state.scale})`;
		}

		// Throttle visibility checks — no need to run every frame
		throttledUpdateVisibility();

		// Debounced progress reporting + snap
		if (settleTimer) clearTimeout(settleTimer);
		settleTimer = setTimeout(() => {
			reportProgress();
			activityTracker.recordActivity();
			trySnap();
		}, 200);
	}

	function handleCameraSettle(_state: CameraState) {
		reportProgress();
	}

	/**
	 * Snap to nearest spread boundary if snap is enabled.
	 * Called after user stops interacting (drag end, wheel idle).
	 */
	let snapTimer: ReturnType<typeof setTimeout> | undefined;

	function trySnap() {
		// TODO: Snap disabled until polished
		return;
		if (!$settings.scrollSnap || !camera) return;

		// Debounce to avoid snapping during rapid interactions
		if (snapTimer) clearTimeout(snapTimer);
		snapTimer = setTimeout(() => {
			if (!camera || camera.isAnimating) return;

			const dominant = camera.getDominantSpread();
			if (dominant >= 0) {
				camera.snapToSpread(dominant, true);
			}
		}, 100);
	}

	// ============================================================
	// Visibility & tile loading
	// ============================================================

	let lastVisibilityCheck = 0;
	const VISIBILITY_THROTTLE_MS = 100; // Check at most every 100ms

	function throttledUpdateVisibility() {
		const now = performance.now();
		if (now - lastVisibilityCheck < VISIBILITY_THROTTLE_MS) return;
		lastVisibilityCheck = now;
		updateVisibility();
	}

	function updateVisibility() {
		if (!camera || !scroller || !renderer || !decoder) return;

		const { top, bottom } = camera.getWorldRect();
		const { toLoad, toUnload } = scroller.update(top, bottom);

		// Unload spreads and evict their pages from decode cache
		for (const idx of toUnload) {
			renderer.removeSpread(idx);
			const item = layout.items[idx];
			if (item) {
				for (const entry of item.pageEntries) {
					pageDecodeCache.delete(entry.pageIndex);
				}
			}
		}

		// Queue loads (processed one at a time)
		for (const idx of toLoad) {
			queueLoadSpread(idx);
		}

		// Update visible indices for text overlay (only spreads actually on screen)
		const visibleRange = scroller.getLoaded();
		const newVisible = [...visibleRange].filter((idx) => {
			const item = layout.items[idx];
			if (!item) return false;
			return item.y + item.height >= top && item.y <= bottom;
		});
		// Only update $state if changed (avoid re-render churn)
		if (
			newVisible.length !== visibleSpreadIndices.length ||
			newVisible.some((v, i) => v !== visibleSpreadIndices[i])
		) {
			visibleSpreadIndices = newVisible;
		}
	}

	// Page-level decode cache: stores decoded tile results per page index.
	// Survives layout changes (rotation, mode switch) so pages don't
	// need to be re-decoded from the worker when only spread groupings change.
	let pageDecodeCache = new Map<number, DecodeResult>();

	// Load queue: process one spread at a time to avoid competing decodes
	let loadQueue: number[] = [];
	let isLoading = false;

	function queueLoadSpread(spreadIndex: number) {
		if (!renderer?.hasSpread(spreadIndex) && !loadQueue.includes(spreadIndex)) {
			loadQueue.push(spreadIndex);
			processLoadQueue();
		}
	}

	async function processLoadQueue() {
		if (isLoading) return;
		isLoading = true;

		while (loadQueue.length > 0) {
			const spreadIndex = loadQueue.shift()!;

			// Skip if already loaded or no longer needed
			if (renderer?.hasSpread(spreadIndex)) continue;
			if (!scroller?.getLoaded().has(spreadIndex)) continue;

			await loadSpread(spreadIndex);
		}

		isLoading = false;
	}

	// Tile upload queue: tiles arrive from worker via onTile callback,
	// rAF loop drains one per frame. No async generator overhead.
	import type { TileBitmap } from '$lib/reader/tile/tile-decoder';
	import type { Container } from 'pixi.js';
	let tileUploadQueue: Array<{
		container: Container;
		tile: TileBitmap;
		xOffset: number;
	}> = [];
	let draining = false;

	function drainTileQueue() {
		if (draining || tileUploadQueue.length === 0 || !renderer) return;
		draining = true;

		function step() {
			if (tileUploadQueue.length === 0 || !renderer) {
				draining = false;
				return;
			}

			const { container, tile, xOffset } = tileUploadQueue.shift()!;
			renderer.uploadTile(container, tile, xOffset);

			if (tileUploadQueue.length > 0) {
				requestAnimationFrame(step);
			} else {
				draining = false;
			}
		}

		requestAnimationFrame(step);
	}

	async function loadSpread(spreadIndex: number) {
		if (!renderer || !decoder) return;

		const item = layout.items[spreadIndex];
		if (!item) return;

		try {
			const container = renderer.createSpread(spreadIndex, item, layout.maxWidth);

			for (const entry of item.pageEntries) {
				// Check cache first
				const cached = pageDecodeCache.get(entry.pageIndex);
				if (cached) {
					for (const tile of cached.tiles) {
						tileUploadQueue.push({ container, tile, xOffset: entry.xOffset });
					}
					drainTileQueue();
					continue;
				}

				const file = indexedFiles[entry.pageIndex];
				if (!file) continue;

				// Decode page — tiles arrive via onTile callback as they're sliced.
				// Each tile is pushed to the upload queue, drained one per frame.
				const result = await decoder.decodePage(file, tileSize, (tile) => {
					if (!scroller?.getLoaded().has(spreadIndex)) return;
					tileUploadQueue.push({ container, tile, xOffset: entry.xOffset });
					drainTileQueue();
				});

				// Cache for reuse on layout changes
				pageDecodeCache.set(entry.pageIndex, result);
			}
		} catch (err) {
			console.error(`Failed to load spread ${spreadIndex}:`, err);
		}
	}

	// ============================================================
	// Progress
	// ============================================================

	function reportProgress() {
		if (!camera) return;
		const dominant = camera.getDominantSpread();
		if (dominant < 0 || dominant >= spreads.length) return;
		if (dominant === lastReportedSpreadIdx) return;

		lastReportedSpreadIdx = dominant;
		const spread = spreads[dominant];
		const maxPageIndex = Math.max(...spread.pageIndices);
		const minPageIndex = Math.min(...spread.pageIndices);
		const pageNum = maxPageIndex + 1;
		const { charCount } = getCharCount(pages, pageNum);
		const isComplete = pageNum >= pages.length;

		lastReportedPage = pageNum;
		lastAnchorPageIdx = minPageIndex; // First page — stable anchor for layout changes
		onPageChange(pageNum, charCount, isComplete);

		// Auto-advance at end
		if (isComplete) {
			const worldRect = camera.getWorldRect();
			if (worldRect.bottom >= layout.totalHeight) {
				onVolumeNav('next');
			}
		}
	}

	// ============================================================
	// Keyboard
	// ============================================================

	function handleKeydown(e: KeyboardEvent) {
		const target = e.target as HTMLElement;
		if (
			target.tagName === 'INPUT' ||
			target.tagName === 'TEXTAREA' ||
			target.tagName === 'SELECT' ||
			target.isContentEditable
		)
			return;

		if (!camera) return;

		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				camera.panByScreenAnimated(0, -viewportHeight * 0.8);
				break;
			case 'ArrowUp':
				e.preventDefault();
				camera.panByScreenAnimated(0, viewportHeight * 0.8);
				break;
			case 'ArrowLeft':
				e.preventDefault();
				camera.panByScreenAnimated(viewportWidth * 0.5, 0);
				break;
			case 'ArrowRight':
				e.preventDefault();
				camera.panByScreenAnimated(-viewportWidth * 0.5, 0);
				break;
			case 'PageDown':
			case ' ':
				e.preventDefault();
				navigateToNextSpread();
				break;
			case 'PageUp':
				e.preventDefault();
				navigateToPrevSpread();
				break;
			case 'Home':
				e.preventDefault();
				camera.snapToSpread(0, true);
				break;
			case 'End':
				e.preventDefault();
				camera.snapToSpread(spreads.length - 1, true);
				break;
			case '+':
			case '=':
				e.preventDefault();
				cycleZoom(1);
				break;
			case '-':
				e.preventDefault();
				cycleZoom(-1);
				break;
		}
	}

	function navigateToNextSpread() {
		if (!camera) return;
		const current = camera.getDominantSpread();
		const next = (current >= 0 ? current : lastReportedSpreadIdx) + 1;
		if (next >= spreads.length) {
			onVolumeNav('next');
			return;
		}
		camera.snapToSpread(next, true);
	}

	function offsetSpreads() {
		// Find the current spread
		const spreadIdx = camera?.getDominantSpread() ?? lastReportedSpreadIdx;
		if (spreadIdx < 0 || spreadIdx >= spreads.length) return;

		const spread = spreads[spreadIdx];

		if (spread.type === 'single') {
			// Already single — anchor at this page to start pairing from here
			pairingAnchor = spread.pageIndices[0];
		} else {
			// Dual spread — anchor at the second page to flip the pairing.
			// [A,B] becomes [A], [B,C] — B becomes first of next pair.
			pairingAnchor = spread.pageIndices[1];
		}
	}

	function navigateToPrevSpread() {
		if (!camera) return;
		const current = camera.getDominantSpread();
		const prev = (current >= 0 ? current : lastReportedSpreadIdx) - 1;
		if (prev < 0) {
			onVolumeNav('prev');
			return;
		}
		camera.snapToSpread(prev, true);
	}

	// ============================================================
	// Zoom
	// ============================================================

	function cycleZoom(direction: number) {
		if (!camera) return;
		const curIdx = findClosestZoomIndex(zoomTarget);
		let nextIdx = curIdx + direction;
		nextIdx = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, nextIdx));
		const newZoom = ZOOM_LEVELS[nextIdx];
		if (newZoom === zoomTarget) return;

		zoomTarget = newZoom;
		const effectiveScale = baseScale() * zoomTarget;
		camera.zoomTo(effectiveScale, viewportWidth / 2, viewportHeight / 2, true);
	}

	function zoomToPoint(clientX: number, clientY: number) {
		if (!camera) return;
		const curIdx = findClosestZoomIndex(zoomTarget);
		const nextIdx = (curIdx + 1) % ZOOM_LEVELS.length;
		zoomTarget = ZOOM_LEVELS[nextIdx];
		const effectiveScale = baseScale() * zoomTarget;

		// Zoom so the clicked area moves toward viewport center.
		// Blend between "anchor at click" and "center on click":
		//   bias=0: clicked point stays fixed on screen (pure anchor)
		//   bias=1: clicked point moves to viewport center (Google Maps style)
		const bias = 0.7;
		const centerX = viewportWidth / 2;
		const centerY = viewportHeight / 2;
		// Screen position where the world point should end up:
		// blend from click position toward viewport center
		const toX = clientX + (centerX - clientX) * bias;
		const toY = clientY + (centerY - clientY) * bias;

		camera.zoomToWithTarget(effectiveScale, clientX, clientY, toX, toY, true);
	}

	function findClosestZoomIndex(zoom: number): number {
		let bestIdx = 0;
		let bestDist = Infinity;
		for (let i = 0; i < ZOOM_LEVELS.length; i++) {
			const dist = Math.abs(ZOOM_LEVELS[i] - zoom);
			if (dist < bestDist) {
				bestDist = dist;
				bestIdx = i;
			}
		}
		return bestIdx;
	}

	function handleWheel(e: WheelEvent) {
		if (!camera) return;
		const swap = $settings.swapWheelBehavior;
		const isZoom = swap ? !(e.ctrlKey || e.metaKey) : (e.ctrlKey || e.metaKey);

		if (isZoom) {
			if (e.deltaY < 0) cycleZoom(1);
			else if (e.deltaY > 0) cycleZoom(-1);
		} else {
			camera.panByScreen(0, -e.deltaY);
		}
	}

	// ============================================================
	// Pointer interaction: drag pan, pinch zoom, inertial fling, tap/double-tap
	// ============================================================

	// Track all active pointers for multi-touch
	let activePointers = new Map<number, { x: number; y: number }>();

	// Pinch state
	let isPinching = false;
	let pinchStartDist = 0;
	let pinchStartScale = 1;
	let pinchLastMidX = 0;
	let pinchLastMidY = 0;

	// Velocity tracking: ring buffer of recent pointer samples
	const VELOCITY_SAMPLES = 5;
	const FLING_THRESHOLD = 0.15; // px/ms — minimum velocity to trigger fling
	let pointerSamples: Array<{ x: number; y: number; t: number }> = [];

	function recordPointerSample(x: number, y: number) {
		pointerSamples.push({ x, y, t: performance.now() });
		if (pointerSamples.length > VELOCITY_SAMPLES) {
			pointerSamples.shift();
		}
	}

	function computeVelocity(): { vx: number; vy: number } {
		if (pointerSamples.length < 2) return { vx: 0, vy: 0 };
		const oldest = pointerSamples[0];
		const newest = pointerSamples[pointerSamples.length - 1];
		const dt = newest.t - oldest.t;
		if (dt < 1) return { vx: 0, vy: 0 };
		return {
			vx: (newest.x - oldest.x) / dt,
			vy: (newest.y - oldest.y) / dt
		};
	}

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
		return {
			x: (pts[0].x + pts[1].x) / 2,
			y: (pts[0].y + pts[1].y) / 2
		};
	}

	function handlePointerDown(e: PointerEvent) {
		activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

		if ((e.target as HTMLElement).closest('.textBox')) {
			textBoxWasActive = true;
			return;
		}

		if (activePointers.size === 2 && camera) {
			// Second finger — start pinch, cancel drag
			isDragging = false;
			wasDrag = true; // Suppress click
			isPinching = true;
			pinchStartDist = pinchDistance();
			pinchStartScale = camera.scale;
			const mid = pinchMidpoint();
			pinchLastMidX = mid.x;
			pinchLastMidY = mid.y;
			return;
		}

		if (e.button !== 0) return;

		pointerDownX = e.clientX;
		pointerDownY = e.clientY;
		isDragging = true;
		wasDrag = false;
		pointerSamples = [];
		recordPointerSample(e.clientX, e.clientY);
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}

	function handlePointerMove(e: PointerEvent) {
		activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

		if (isPinching && camera && activePointers.size >= 2) {
			// Pinch zoom: scale proportional to finger distance change
			const dist = pinchDistance();
			if (pinchStartDist > 0) {
				const newScale = pinchStartScale * (dist / pinchStartDist);
				const mid = pinchMidpoint();

				// Pan by midpoint movement
				camera.panByScreen(mid.x - pinchLastMidX, mid.y - pinchLastMidY);
				// Zoom anchored at midpoint
				camera.zoomTo(newScale, mid.x, mid.y, false);

				pinchLastMidX = mid.x;
				pinchLastMidY = mid.y;
			}
			return;
		}

		if (!isDragging || !camera) return;

		const dx = e.clientX - pointerDownX;
		const dy = e.clientY - pointerDownY;

		if (!wasDrag && dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) {
			wasDrag = true;
		}

		if (wasDrag) {
			camera.panByScreen(dx, dy);
			pointerDownX = e.clientX;
			pointerDownY = e.clientY;
			recordPointerSample(e.clientX, e.clientY);
		}
	}

	function handlePointerUp(e: PointerEvent) {
		activePointers.delete(e.pointerId);

		if (isPinching) {
			if (activePointers.size < 2) {
				// Pinch ended — update zoomTarget to nearest level
				isPinching = false;
				if (camera) {
					const currentScale = camera.scale;
					const base = baseScale();
					const currentZoomMultiplier = currentScale / base;
					zoomTarget = ZOOM_LEVELS.reduce((prev, curr) =>
						Math.abs(curr - currentZoomMultiplier) < Math.abs(prev - currentZoomMultiplier)
							? curr
							: prev
					);
				}
				trySnap();
			}
			return;
		}

		const wasDragging = isDragging && wasDrag;
		if (isDragging) {
			try {
				(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
			} catch {}
		}
		isDragging = false;

		if (wasDragging && camera) {
			recordPointerSample(e.clientX, e.clientY);
			const { vx, vy } = computeVelocity();
			const speed = Math.sqrt(vx * vx + vy * vy);

			if (speed > FLING_THRESHOLD) {
				camera.fling(vx, vy);
			}

			trySnap();
		}
	}

	function handleClick(e: MouseEvent) {
		if ((e.target as HTMLElement).closest('.textBox')) return;
		if (wasDrag) return;

		if (textBoxWasActive) {
			textBoxWasActive = false;
			return;
		}

		const now = Date.now();
		if (now - lastTapTime < DOUBLE_TAP_DELAY) {
			lastTapTime = 0;
			zoomToPoint(e.clientX, e.clientY);
			return;
		}
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
		viewportWidth = window.innerWidth;
		viewportHeight = window.innerHeight;
		renderer?.resize(viewportWidth, viewportHeight);
		camera?.setViewport(viewportWidth, viewportHeight);
		scroller?.setViewportHeight(viewportHeight);

		// Recalculate camera scale for new viewport dimensions
		// (fit-to-width/fit-to-screen depend on viewport size)
		if (camera) {
			const newScale = baseScale() * zoomTarget;
			camera.zoomTo(newScale, viewportWidth / 2, viewportHeight / 2, false);
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} onresize={handleResize} />

<div
	bind:this={wrapperDiv}
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
	<!-- Single PixiJS canvas for all page rendering -->
	<canvas
		bind:this={canvas}
		class="absolute inset-0 h-full w-full"
	></canvas>

	<!-- HTML text overlay: CSS-transformed to match PixiJS camera -->
	<div
		bind:this={overlayRoot}
		class="pointer-events-none absolute inset-0"
		style:transform-origin="0 0"
		style:filter={`invert(${$invertColorsActive ? 1 : 0})`}
	>
		{#each visibleSpreadIndices as spreadIdx (spreadIdx)}
			{@const item = layout.items[spreadIdx]}
			{@const spread = spreads[spreadIdx]}
			{#if item && spread}
				<div
					class="pointer-events-auto absolute"
					style:left={`${(layout.maxWidth - item.width) / 2}px`}
					style:top={`${item.y}px`}
					style:width={`${item.width}px`}
					style:height={`${item.height}px`}
				>
					{#each item.pageEntries as entry (entry.pageIndex)}
						<div class="absolute top-0" style:left={`${entry.xOffset}px`}>
							<TextBoxes
								page={entry.page}
								src={indexedFiles[entry.pageIndex]}
								volumeUuid={volume.volume_uuid}
								pageIndex={entry.pageIndex}
								forceVisible={missingPagePaths.has(entry.page.img_path)}
							/>
						</div>
					{/each}
				</div>
			{/if}
		{/each}
	</div>
</div>
