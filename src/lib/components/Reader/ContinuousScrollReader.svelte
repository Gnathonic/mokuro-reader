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
	import {
		detectTileConfig,
		applyUrlParamOverrides,
		TileDecoder,
		type TileConfig
	} from '$lib/reader/tile';
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
	let tileConfig: TileConfig | null = null;

	// Zoom
	const ZOOM_LEVELS = [1, 1.5, 2, 3];
	let zoomTarget = 1;

	// Progress tracking
	let lastReportedSpreadIdx = -1;
	let lastReportedPage = currentPage;

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
	let spreadOffsetCount = $state(0);

	let effectiveBreakpoints = $derived.by(() => {
		if (spreadOffsetCount === 0) return breakpoints;
		const bp = [...breakpoints];
		const bpSet = new Set(bp);
		// Add N breakpoints at the first N pairable pages
		let added = 0;
		for (let i = 0; i < pages.length && added < spreadOffsetCount; i++) {
			if (!bpSet.has(i)) {
				bp.push(i);
				bpSet.add(i);
				added++;
			}
		}
		return bp.sort((a, b) => a - b);
	});

	let isPortrait = $derived(isPortraitOrientation());

	let spreads: PageSpread[] = $derived(
		groupPagesIntoSpreads(
			pages,
			volumeSettings.singlePageView ?? 'auto',
			volumeSettings.rightToLeft ?? true,
			isPortrait,
			effectiveBreakpoints
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

		// Initialize tile config
		const detected = await detectTileConfig();
		tileConfig = applyUrlParamOverrides(detected);

		// Initialize decoder
		decoder = new TileDecoder();

		// Initialize renderer
		renderer = new ViewportRenderer(tileConfig);
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
	});

	// React to layout changes (settings, orientation, page mode)
	let prevLayout: SpreadLayoutResult | null = null;
	$effect(() => {
		if (layout === prevLayout || !camera || !scroller || !renderer) return;
		const isInitial = prevLayout === null;
		prevLayout = layout;

		// Clear all rendered spreads — positions and groupings have changed
		renderer.clear();
		scroller.clear();

		// Update systems with new layout
		camera.setLayout(layout);
		scroller.setLayout(layout);

		if (!isInitial) {
			// Find which spread contains the page we were on
			const pageIdx = lastReportedSpreadIdx >= 0
				? Math.max(...(spreads[Math.min(lastReportedSpreadIdx, spreads.length - 1)]?.pageIndices ?? [0]))
				: currentPage - 1;
			const newIdx = findSpreadForPage(spreads, pageIdx);
			if (newIdx >= 0) {
				lastReportedSpreadIdx = newIdx;
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

		// Update visibility (throttled — check every few frames)
		updateVisibility();

		// Debounced progress reporting
		if (settleTimer) clearTimeout(settleTimer);
		settleTimer = setTimeout(() => {
			reportProgress();
			activityTracker.recordActivity();
		}, 150);
	}

	function handleCameraSettle(_state: CameraState) {
		reportProgress();

		// Snap to nearest spread if enabled
		if ($settings.scrollSnap && camera && zoomTarget === 1) {
			const dominant = camera.getDominantSpread();
			if (dominant >= 0 && dominant !== lastReportedSpreadIdx) {
				camera.snapToSpread(dominant, true);
			}
		}
	}

	// ============================================================
	// Visibility & tile loading
	// ============================================================

	function updateVisibility() {
		if (!camera || !scroller || !renderer || !decoder || !tileConfig) return;

		const { top, bottom } = camera.getWorldRect();
		const { toLoad, toUnload } = scroller.update(top, bottom);

		// Unload
		for (const idx of toUnload) {
			renderer.removeSpread(idx);
		}

		// Load
		for (const idx of toLoad) {
			loadSpread(idx);
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

	async function loadSpread(spreadIndex: number) {
		if (!renderer || !decoder || !tileConfig) return;
		if (renderer.hasSpread(spreadIndex)) return;

		const item = layout.items[spreadIndex];
		if (!item) return;

		try {
			const pageResults: Array<{ decodeResult: any; xOffset: number }> = [];

			for (const entry of item.pageEntries) {
				const file = indexedFiles[entry.pageIndex];
				if (!file) continue;

				const result = await decoder.decodePage(file, tileConfig);
				pageResults.push({ decodeResult: result, xOffset: entry.xOffset });
			}

			// Check we're still relevant (might have scrolled away during decode)
			if (renderer && scroller?.getLoaded().has(spreadIndex)) {
				renderer.addSpread(spreadIndex, item, pageResults, layout.maxWidth);
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
		const pageNum = maxPageIndex + 1;
		const { charCount } = getCharCount(pages, pageNum);
		const isComplete = pageNum >= pages.length;

		lastReportedPage = pageNum;
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
			case 'o':
			case 'O':
				e.preventDefault();
				offsetSpreads();
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
		spreadOffsetCount += 1;
		// Layout will re-derive, triggering the layout change effect
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
		if (e.ctrlKey || e.metaKey) {
			if (e.deltaY < 0) cycleZoom(1);
			else if (e.deltaY > 0) cycleZoom(-1);
		} else {
			// Normal wheel: scroll vertically
			camera.panByScreen(0, -e.deltaY);
		}
	}

	// ============================================================
	// Pointer interaction: drag pan + tap/double-tap
	// ============================================================

	function handlePointerDown(e: PointerEvent) {
		pointerDownX = e.clientX;
		pointerDownY = e.clientY;

		if ((e.target as HTMLElement).closest('.textBox')) {
			textBoxWasActive = true;
			return;
		}

		if (e.button !== 0) return;

		isDragging = true;
		wasDrag = false;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}

	function handlePointerMove(e: PointerEvent) {
		if (!isDragging || !camera) return;

		const dx = e.clientX - pointerDownX;
		const dy = e.clientY - pointerDownY;

		if (!wasDrag && dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) {
			wasDrag = true;
		}

		if (wasDrag) {
			// Move camera by the delta since last frame
			camera.panByScreen(dx, dy);
			pointerDownX = e.clientX;
			pointerDownY = e.clientY;
		}
	}

	function handlePointerUp(e: PointerEvent) {
		if (isDragging) {
			try {
				(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
			} catch {}
		}
		isDragging = false;
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
