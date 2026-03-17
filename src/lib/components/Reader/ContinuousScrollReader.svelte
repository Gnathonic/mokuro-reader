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
	import SpreadCanvas from './SpreadCanvas.svelte';
	import { onMount, onDestroy, tick } from 'svelte';

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

	let scrollContainer: HTMLDivElement | undefined = $state();
	let viewportWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1024);
	let viewportHeight = $state(typeof window !== 'undefined' ? window.innerHeight : 768);

	// Overlay toggle
	let textBoxWasActive = false;
	let pointerDownX = 0;
	let pointerDownY = 0;
	const DRAG_THRESHOLD = 5;

	// Zoom — CSS zoom on content wrapper via direct DOM manipulation.
	// Only $state is updated when animation settles, not every frame.
	// This avoids Svelte re-rendering the entire template at 60fps.
	let userZoom = $state(1); // Only updated on settle for snap/conditional logic
	let zoomWrapper: HTMLDivElement | undefined = $state();
	const ZOOM_LEVELS = [1, 1.5, 2, 3];

	// Tile rendering
	let tileConfig: TileConfig | null = $state(null);
	let decoder: TileDecoder | null = $state(null);
	let visibleSpreads = $state(new Set<number>());

	// Progress tracking
	let lastReportedSpreadIdx = $state(-1);
	let lastReportedPage = currentPage;

	// Scroll event suppression during programmatic scrolls
	let ignoreScrollEvents = false;

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

	let isPortrait = $derived(isPortraitOrientation());

	let spreads: PageSpread[] = $derived(
		groupPagesIntoSpreads(
			pages,
			volumeSettings.singlePageView ?? 'auto',
			volumeSettings.rightToLeft ?? true,
			isPortrait,
			breakpoints
		)
	);

	// Scale spread based on zoom mode setting
	function fitScale(spread: PageSpread): number {
		const { w, h } = nativeSize(spread);
		const zoomMode = $settings.continuousZoomDefault;

		if (zoomMode === 'zoomFitToWidth') {
			return viewportWidth / w;
		} else if (zoomMode === 'zoomOriginal') {
			return 1;
		}
		// zoomFitToScreen (default)
		return Math.min(viewportWidth / w, viewportHeight / h);
	}

	function nativeSize(spread: PageSpread) {
		const w =
			spread.type === 'dual'
				? spread.pages[0].img_width + spread.pages[1].img_width
				: spread.pages[0].img_width;
		const h =
			spread.type === 'dual'
				? Math.max(spread.pages[0].img_height, spread.pages[1].img_height)
				: spread.pages[0].img_height;
		return { w, h };
	}

	// ============================================================
	// Progress — report when dominant visible spread changes
	// ============================================================

	let scrollEndTimer: ReturnType<typeof setTimeout> | null = null;

	function detectDominantSpread(): number {
		if (!scrollContainer) return -1;
		const centerY = scrollContainer.clientHeight / 2;
		const containerTop = scrollContainer.getBoundingClientRect().top;
		let bestIdx = -1;
		let bestDist = Infinity;

		for (const el of scrollContainer.querySelectorAll('[data-spread-index]')) {
			const rect = el.getBoundingClientRect();
			const elCenter = rect.top - containerTop + rect.height / 2;
			const dist = Math.abs(elCenter - centerY);
			if (dist < bestDist) {
				bestDist = dist;
				bestIdx = parseInt((el as HTMLElement).dataset.spreadIndex ?? '-1');
			}
		}
		return bestIdx;
	}

	function reportProgress(spreadIdx: number) {
		if (spreadIdx < 0 || spreadIdx >= spreads.length) return;
		if (spreadIdx === lastReportedSpreadIdx) return;
		lastReportedSpreadIdx = spreadIdx;

		const spread = spreads[spreadIdx];
		const maxPageIndex = Math.max(...spread.pageIndices);
		const pageNum = maxPageIndex + 1;
		const { charCount } = getCharCount(pages, pageNum);
		const isComplete = pageNum >= pages.length;

		lastReportedPage = pageNum;
		onPageChange(pageNum, charCount, isComplete);
		activityTracker.recordActivity();
	}

	function handleScroll() {
		if (!scrollContainer || ignoreScrollEvents) return;
		activityTracker.recordActivity();

		if (scrollEndTimer) clearTimeout(scrollEndTimer);
		scrollEndTimer = setTimeout(() => {
			const idx = detectDominantSpread();
			if (idx >= 0) reportProgress(idx);
		}, 150);

		// Auto-advance at bottom
		const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
		if (scrollTop + clientHeight >= scrollHeight - 2) {
			onVolumeNav('next');
		}
	}

	// ============================================================
	// Scroll-to helpers
	// ============================================================

	function scrollToSpread(spreadIdx: number, smooth: boolean) {
		if (!scrollContainer || spreadIdx < 0) return;
		ignoreScrollEvents = true;

		const el = scrollContainer.querySelector(`[data-spread-index="${spreadIdx}"]`);
		if (el) {
			el.scrollIntoView({ behavior: smooth ? 'smooth' : 'instant', block: 'start' });
		}

		setTimeout(
			() => {
				ignoreScrollEvents = false;
			},
			smooth ? 600 : 100
		);
	}

	// ============================================================
	// React to external page changes
	// ============================================================

	$effect(() => {
		if (currentPage !== lastReportedPage) {
			lastReportedPage = currentPage;
			const idx = findSpreadForPage(spreads, currentPage - 1);
			if (idx >= 0) {
				lastReportedSpreadIdx = idx;
				scrollToSpread(idx, true);
			}
		}
	});

	// React to spread re-layout (hasCover, page mode)
	let prevSpreads: PageSpread[] | null = null;
	$effect(() => {
		if (spreads === prevSpreads) return;
		const oldSpreads = prevSpreads;
		prevSpreads = spreads;

		if (!oldSpreads) return;

		const oldSpread =
			lastReportedSpreadIdx >= 0 && lastReportedSpreadIdx < oldSpreads.length
				? oldSpreads[lastReportedSpreadIdx]
				: null;
		const oldPageIdx = oldSpread ? Math.max(...oldSpread.pageIndices) : currentPage - 1;

		tick().then(() => {
			reobserve();
			const newIdx = findSpreadForPage(spreads, oldPageIdx);
			if (newIdx >= 0) {
				lastReportedSpreadIdx = newIdx;
				scrollToSpread(newIdx, false);
				reportProgress(newIdx);
			}
		});
	});

	// React to zoom mode changes — preserve current spread position
	let prevZoomMode = $settings.continuousZoomDefault;
	$effect(() => {
		const zoomMode = $settings.continuousZoomDefault;
		if (zoomMode === prevZoomMode) return;
		prevZoomMode = zoomMode;

		tick().then(() => {
			if (lastReportedSpreadIdx >= 0) {
				scrollToSpread(lastReportedSpreadIdx, false);
			}
		});
	});

	// ============================================================
	// Lifecycle
	// ============================================================

	let visibilityObserver: IntersectionObserver | undefined;

	onMount(async () => {
		const detected = await detectTileConfig();
		tileConfig = applyUrlParamOverrides(detected);
		decoder = new TileDecoder();

		visibilityObserver = new IntersectionObserver(
			(entries) => {
				let changed = false;
				for (const entry of entries) {
					const idx = parseInt((entry.target as HTMLElement).dataset.spreadIndex ?? '-1');
					if (idx < 0) continue;

					if (entry.isIntersecting) {
						if (!visibleSpreads.has(idx)) {
							visibleSpreads.add(idx);
							changed = true;
						}
					} else {
						if (visibleSpreads.has(idx)) {
							visibleSpreads.delete(idx);
							changed = true;
						}
					}
				}
				if (changed) visibleSpreads = new Set(visibleSpreads);
			},
			{ root: scrollContainer, rootMargin: '200% 0px' }
		);

		scrollContainer?.addEventListener('wheel', handleWheel, { passive: false });

		requestAnimationFrame(() => {
			reobserve();
			const idx = findSpreadForPage(spreads, currentPage - 1);
			if (idx >= 0) {
				lastReportedSpreadIdx = idx;
				scrollToSpread(idx, false);
			}
		});
	});

	onDestroy(() => {
		visibilityObserver?.disconnect();
		scrollContainer?.removeEventListener('wheel', handleWheel);
		if (scrollEndTimer) clearTimeout(scrollEndTimer);
		zoomAnimator.destroy();
		if (decoder) {
			decoder.destroy();
			decoder = null;
		}
	});

	function reobserve() {
		if (!scrollContainer) return;
		visibilityObserver?.disconnect();
		for (const el of scrollContainer.querySelectorAll('[data-spread-index]')) {
			visibilityObserver?.observe(el);
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

		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				scrollContainer?.scrollBy({ top: viewportHeight * 0.8, behavior: 'smooth' });
				break;
			case 'ArrowUp':
				e.preventDefault();
				scrollContainer?.scrollBy({ top: -viewportHeight * 0.8, behavior: 'smooth' });
				break;
			case 'ArrowLeft':
				e.preventDefault();
				scrollContainer?.scrollBy({ left: -viewportWidth * 0.5, behavior: 'smooth' });
				break;
			case 'ArrowRight':
				e.preventDefault();
				scrollContainer?.scrollBy({ left: viewportWidth * 0.5, behavior: 'smooth' });
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
				scrollToSpread(0, true);
				break;
			case 'End':
				e.preventDefault();
				scrollToSpread(spreads.length - 1, true);
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
		const current = detectDominantSpread();
		const next = (current >= 0 ? current : lastReportedSpreadIdx) + 1;
		if (next >= spreads.length) {
			onVolumeNav('next');
			return;
		}
		scrollToSpread(next, true);
	}

	function navigateToPrevSpread() {
		const current = detectDominantSpread();
		const prev = (current >= 0 ? current : lastReportedSpreadIdx) - 1;
		if (prev < 0) {
			onVolumeNav('prev');
			return;
		}
		scrollToSpread(prev, true);
	}

	// ============================================================
	// Zoom — Animator-driven, direct DOM manipulation
	//
	// The Animator drives zoom. Its onFrame callback directly sets
	// zoomWrapper.style.zoom and scrollContainer.scrollLeft/Top.
	// This bypasses Svelte reactivity — no re-render per frame.
	// userZoom ($state) is only updated on settle for template logic
	// (scroll-snap, padding conditionals).
	// ============================================================

	import { Animator } from '$lib/reader/animator';

	// Anchor: content-space point that stays fixed at a viewport position
	let anchorContentX = 0;
	let anchorContentY = 0;
	let anchorViewX = 0;
	let anchorViewY = 0;

	let zoomTarget = 1; // Discrete target from ZOOM_LEVELS
	let currentZoom = 1; // Live value (not $state — updated by animator)

	const zoomAnimator = new Animator(
		1,
		(z) => {
			currentZoom = z;

			// Direct DOM manipulation — no Svelte reactivity
			if (zoomWrapper) {
				zoomWrapper.style.zoom = z === 1 ? '' : String(z);
				zoomWrapper.style.paddingLeft = z > 1.01 ? '50vw' : '';
				zoomWrapper.style.paddingRight = z > 1.01 ? '50vw' : '';
			}
			if (scrollContainer) {
				scrollContainer.scrollLeft = anchorContentX * z - anchorViewX;
				scrollContainer.scrollTop = anchorContentY * z - anchorViewY;
			}
		},
		{
			factor: 0.18,
			onSettle: () => {
				// Sync $state only on settle — triggers one Svelte update
				userZoom = zoomTarget;
			}
		}
	);

	function setZoomAnchor(clientX: number, clientY: number) {
		if (!scrollContainer) return;
		const rect = scrollContainer.getBoundingClientRect();
		anchorViewX = clientX - rect.left;
		anchorViewY = clientY - rect.top;
		const z = currentZoom || 1;
		anchorContentX = (scrollContainer.scrollLeft + anchorViewX) / z;
		anchorContentY = (scrollContainer.scrollTop + anchorViewY) / z;
	}

	function zoomToPoint(clientX: number, clientY: number) {
		const curIdx = findClosestZoomIndex(zoomTarget);
		const nextIdx = (curIdx + 1) % ZOOM_LEVELS.length;
		setZoomAnchor(clientX, clientY);
		zoomTarget = ZOOM_LEVELS[nextIdx];
		zoomAnimator.setTarget(zoomTarget);
	}

	function cycleZoom(direction: number) {
		if (!scrollContainer) return;
		const rect = scrollContainer.getBoundingClientRect();
		const curIdx = findClosestZoomIndex(zoomTarget);
		let nextIdx = curIdx + direction;
		nextIdx = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, nextIdx));
		const newZoom = ZOOM_LEVELS[nextIdx];
		if (newZoom === zoomTarget) return;

		setZoomAnchor(rect.left + rect.width / 2, rect.top + rect.height / 2);
		zoomTarget = newZoom;
		zoomAnimator.setTarget(zoomTarget);
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
		if (!e.ctrlKey && !e.metaKey) return;
		e.preventDefault();
		if (e.deltaY < 0) cycleZoom(1);
		else if (e.deltaY > 0) cycleZoom(-1);
	}

	// ============================================================
	// Click-drag panning + overlay toggle + double-tap zoom
	//
	// Drag panning: pointerdown starts tracking, pointermove scrolls
	// the container. No preventDefault on pointerdown so click events
	// still fire. wasDrag flag distinguishes drags from taps.
	// ============================================================

	let isDragging = false;
	let wasDrag = false;
	let dragStartScrollLeft = 0;
	let dragStartScrollTop = 0;

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
		dragStartScrollLeft = scrollContainer?.scrollLeft ?? 0;
		dragStartScrollTop = scrollContainer?.scrollTop ?? 0;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}

	function handlePointerMove(e: PointerEvent) {
		if (!isDragging || !scrollContainer) return;
		const dx = e.clientX - pointerDownX;
		const dy = e.clientY - pointerDownY;

		// Only start dragging after exceeding threshold
		if (!wasDrag && dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) {
			wasDrag = true;
		}

		if (wasDrag) {
			scrollContainer.scrollLeft = dragStartScrollLeft - dx;
			scrollContainer.scrollTop = dragStartScrollTop - dy;
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

	let lastTapTime = 0;
	const DOUBLE_TAP_DELAY = 300;

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
	}
</script>

<svelte:window onkeydown={handleKeydown} onresize={handleResize} />

<div class="fixed inset-0" style:background-color={$settings.backgroundColor}>
	<div
		bind:this={scrollContainer}
		class="h-full w-full scrollbar-hide"
		style:overflow="auto"
		style:overscroll-behavior="none"
		style:scroll-snap-type={$settings.scrollSnap && userZoom === 1 ? 'y mandatory' : 'none'}
		onscroll={handleScroll}
		onpointerdown={handlePointerDown}
		onpointermove={handlePointerMove}
		onpointerup={handlePointerUp}
		onpointercancel={handlePointerUp}
		onclick={handleClick}
		role="none"
	>
		<!-- Zoom wrapper: style.zoom set directly by animator (not Svelte reactivity) -->
		<div bind:this={zoomWrapper}>
			{#if tileConfig && decoder}
				{#each spreads as spread, spreadIndex (spread.pageIndices[0])}
					{@const scale = fitScale(spread)}
					{@const isFitToScreen = $settings.continuousZoomDefault === 'zoomFitToScreen'}
					<div
						class="flex items-center justify-center"
						style:height={isFitToScreen ? '100vh' : 'auto'}
						style:min-height={isFitToScreen ? '100vh' : 'auto'}
						style:scroll-snap-align={$settings.scrollSnap && userZoom === 1 ? 'start' : 'none'}
						style:filter={`invert(${$invertColorsActive ? 1 : 0})`}
						data-spread-index={spreadIndex}
					>
						<SpreadCanvas
							{spread}
							files={indexedFiles}
							{volume}
							config={tileConfig}
							visible={visibleSpreads.has(spreadIndex)}
							{scale}
							rtl={volumeSettings.rightToLeft ?? true}
							{missingPagePaths}
							{decoder}
						/>
					</div>
				{/each}
			{/if}
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
