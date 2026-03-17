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

	// Overlay toggle — 1:1 from Reader.svelte
	let textBoxWasActive = false;
	let pointerDownX = 0;
	let pointerDownY = 0;
	const DRAG_THRESHOLD = 5;

	// Zoom — CSS transform on content only, containers stay 100vh
	let userZoom = $state(1);
	let isZoomAnimating = $state(false);
	const ZOOM_LEVELS = [1, 1.5, 2, 3];

	// Panning (when zoomed)
	let isPanning = $state(false);
	let panStartX = 0;
	let panStartY = 0;
	let panOffsetX = $state(0);
	let panOffsetY = $state(0);
	let panStartOffsetX = 0;
	let panStartOffsetY = 0;

	// Tile rendering
	let tileConfig: TileConfig | null = $state(null);
	let decoder: TileDecoder | null = $state(null);
	let visibleSpreads = $state(new Set<number>());

	// Progress tracking — which spread we last reported
	let lastReportedSpreadIdx = $state(-1);

	// Page we last reported — to detect external page changes
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

	// Fit-to-screen scale for each spread
	function fitScale(spread: PageSpread): number {
		const { w, h } = nativeSize(spread);
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

		if (!oldSpreads) return; // initial — onMount handles it

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

	// ============================================================
	// Lifecycle
	// ============================================================

	let visibilityObserver: IntersectionObserver | undefined;

	onMount(async () => {
		// Initialize tile config from device capabilities
		const detected = await detectTileConfig();
		tileConfig = applyUrlParamOverrides(detected);

		// Create shared decoder for all spread canvases
		decoder = new TileDecoder();

		// Set up IntersectionObserver to track which spreads are near the viewport
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
			case 'PageDown':
			case ' ':
				e.preventDefault();
				navigateToNextSpread();
				break;
			case 'ArrowRight':
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
	// Zoom — CSS transform only, container height stays 100vh
	// ============================================================

	function cycleZoom(direction: number) {
		const curIdx = ZOOM_LEVELS.indexOf(userZoom);
		let nextIdx = curIdx < 0 ? (direction > 0 ? 1 : 0) : curIdx + direction;
		nextIdx = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, nextIdx));
		const newZoom = ZOOM_LEVELS[nextIdx];
		if (newZoom === userZoom) return;

		isZoomAnimating = true;
		userZoom = newZoom;
		if (newZoom === 1) {
			panOffsetX = 0;
			panOffsetY = 0;
		}
		setTimeout(() => {
			isZoomAnimating = false;
		}, 300);
	}

	function handleWheel(e: WheelEvent) {
		if (!e.ctrlKey && !e.metaKey) return;
		e.preventDefault();
		if (e.deltaY < 0) cycleZoom(1);
		else if (e.deltaY > 0) cycleZoom(-1);
	}

	// ============================================================
	// Overlay + panning + double-tap
	// ============================================================

	function handleOverlayPointerDown(e: PointerEvent) {
		pointerDownX = e.clientX;
		pointerDownY = e.clientY;

		if ((e.target as HTMLElement).closest('.textBox')) {
			textBoxWasActive = true;
		}

		if (e.button !== 0) return;
		if ((e.target as HTMLElement).closest('.textBox')) return;

		if (userZoom > 1) {
			isPanning = true;
			panStartX = e.clientX;
			panStartY = e.clientY;
			panStartOffsetX = panOffsetX;
			panStartOffsetY = panOffsetY;
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		}
	}

	function handlePointerMove(e: PointerEvent) {
		if (!isPanning) return;
		panOffsetX = panStartOffsetX + (e.clientX - panStartX);
		panOffsetY = panStartOffsetY + (e.clientY - panStartY);
	}

	function handlePointerUp(e: PointerEvent) {
		if (isPanning) {
			try {
				(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
			} catch {}
		}
		isPanning = false;
	}

	let lastTapTime = 0;
	const DOUBLE_TAP_DELAY = 300;

	function handleOverlayToggle(e: MouseEvent) {
		if ((e.target as HTMLElement).closest('.textBox')) return;

		const dx = e.clientX - pointerDownX;
		const dy = e.clientY - pointerDownY;
		if (dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) return;

		if (textBoxWasActive) {
			textBoxWasActive = false;
			return;
		}

		const now = Date.now();
		if (now - lastTapTime < DOUBLE_TAP_DELAY) {
			lastTapTime = 0;
			const curIdx = ZOOM_LEVELS.indexOf(userZoom);
			const nextIdx = (curIdx + 1) % ZOOM_LEVELS.length;
			isZoomAnimating = true;
			userZoom = ZOOM_LEVELS[nextIdx];
			if (ZOOM_LEVELS[nextIdx] === 1) {
				panOffsetX = 0;
				panOffsetY = 0;
			}
			setTimeout(() => {
				isZoomAnimating = false;
			}, 300);
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
		style:overflow-y={userZoom > 1 ? 'hidden' : 'auto'}
		style:overflow-x="hidden"
		style:overscroll-behavior="none"
		style:scroll-snap-type={$settings.scrollSnap ? 'y mandatory' : 'none'}
		onscroll={handleScroll}
		role="none"
	>
		{#if tileConfig && decoder}
			{#each spreads as spread, spreadIndex (spread.pageIndices[0])}
				{@const scale = fitScale(spread)}
				{@const isActive = spreadIndex === lastReportedSpreadIdx}
				<!--
					Each spread is a full-viewport slide.
					Height is ALWAYS 100% of container — zoom does not change this.
				-->
				<div
					class="flex items-center justify-center"
					style:height="100%"
					style:min-height="100%"
					style:scroll-snap-align={$settings.scrollSnap ? 'start' : 'none'}
					style:filter={`invert(${$invertColorsActive ? 1 : 0})`}
					data-spread-index={spreadIndex}
					onpointerdown={handleOverlayPointerDown}
					onpointermove={handlePointerMove}
					onpointerup={handlePointerUp}
					onpointercancel={handlePointerUp}
					onclick={handleOverlayToggle}
					role="none"
				>
					<div
						class="relative"
						style:transform={isActive && userZoom !== 1
							? `scale(${userZoom}) translate(${panOffsetX / userZoom}px, ${panOffsetY / userZoom}px)`
							: 'none'}
						style:transition={isZoomAnimating ? 'transform 0.3s ease' : 'none'}
						style:cursor={isPanning ? 'grabbing' : userZoom > 1 ? 'grab' : 'default'}
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
				</div>
			{/each}
		{/if}
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
