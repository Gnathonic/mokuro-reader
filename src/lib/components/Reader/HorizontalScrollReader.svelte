<script lang="ts">
	import type { Page, VolumeMetadata } from '$lib/types';
	import type { VolumeSettings } from '$lib/settings/volume-data';
	import { settings, invertColorsActive } from '$lib/settings';
	import { matchFilesToPages } from '$lib/reader/image-cache';
	import { getCharCount } from '$lib/util/count-chars';
	import { activityTracker } from '$lib/util/activity-tracker';
	import TextBoxes from './TextBoxes.svelte';
	import { ScrollAnimator } from '$lib/reader/scroll-animator';
	import { onMount, onDestroy } from 'svelte';

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

	let outerDiv: HTMLDivElement | undefined = $state();
	let scrollContainer: HTMLDivElement | undefined = $state();
	let scroller: ScrollAnimator | null = null;
	let viewportWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1024);
	let viewportHeight = $state(typeof window !== 'undefined' ? window.innerHeight : 768);
	let indexedFiles = $derived.by(() => matchFilesToPages(files, pages));
	let missingPagePaths = $derived(new Set(volume?.missing_page_paths || []));
	let rtl = $derived(volumeSettings.rightToLeft ?? true);

	function scaledWidth(page: Page): number {
		return (page.img_width / page.img_height) * viewportHeight;
	}

	// ============================================================
	// Zoom — CSS zoom on scroll content
	// ============================================================

	let userZoom = $state(1);
	const ZOOM_LEVELS = [1, 1.5, 2, 3];

	function cycleZoom(direction: number, anchorX?: number, anchorY?: number) {
		if (!scrollContainer) return;
		const curIdx = ZOOM_LEVELS.indexOf(userZoom);
		let nextIdx = curIdx < 0 ? (direction > 0 ? 1 : 0) : curIdx + direction;
		nextIdx = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, nextIdx));
		const newZoom = ZOOM_LEVELS[nextIdx];
		if (newZoom === userZoom) return;

		const ax = anchorX ?? viewportWidth / 2;
		const ay = anchorY ?? viewportHeight / 2;
		const contentX = (scrollContainer.scrollLeft + ax) / userZoom;
		const contentY = (scrollContainer.scrollTop + ay) / userZoom;

		userZoom = newZoom;

		requestAnimationFrame(() => {
			if (!scrollContainer) return;
			scrollContainer.scrollLeft = contentX * newZoom - ax;
			scrollContainer.scrollTop = contentY * newZoom - ay;
		});
	}

	// ============================================================
	// Blob URLs
	// ============================================================

	let blobUrls = $state<string[]>([]);

	$effect(() => {
		const urls = indexedFiles.map((file) => (file ? URL.createObjectURL(file) : ''));
		blobUrls = urls;
		return () => {
			urls.forEach((url) => { if (url) URL.revokeObjectURL(url); });
		};
	});

	// ============================================================
	// Progress tracking
	// ============================================================

	let lastReportedPage = currentPage;
	let navTarget = currentPage - 1;
	let settleTimer: ReturnType<typeof setTimeout> | undefined;
	let pageElements: HTMLDivElement[] = [];

	function detectCurrentPage(): number {
		if (!scrollContainer) return 0;
		// Find the lowest-index page that is fully visible in the viewport.
		// Always anchoring to the lower page prevents flip-flopping between
		// the two pages of a visible pair.
		const containerRect = scrollContainer.getBoundingClientRect();

		for (let i = 0; i < pageElements.length; i++) {
			const el = pageElements[i];
			if (!el) continue;
			const rect = el.getBoundingClientRect();
			if (rect.left >= containerRect.left - 2 && rect.right <= containerRect.right + 2) {
				return i; // First (lowest index) fully visible page
			}
		}

		// Fallback: closest to center
		const viewCenterX = containerRect.left + containerRect.width / 2;
		let closest = 0;
		let closestDist = Infinity;
		for (let i = 0; i < pageElements.length; i++) {
			const el = pageElements[i];
			if (!el) continue;
			const rect = el.getBoundingClientRect();
			const dist = Math.abs(rect.left + rect.width / 2 - viewCenterX);
			if (dist < closestDist) {
				closestDist = dist;
				closest = i;
			}
		}
		return closest;
	}

	function reportProgress() {
		// Use highest visible page for progress (furthest read)
		const highestVisible = detectHighestVisiblePage();
		const pageNum = highestVisible + 1;
		if (pageNum !== lastReportedPage) {
			lastReportedPage = pageNum;
			const { charCount } = getCharCount(pages, pageNum);
			onPageChange(pageNum, charCount, pageNum >= pages.length);
		}
	}

	function detectHighestVisiblePage(): number {
		if (!scrollContainer) return 0;
		const containerRect = scrollContainer.getBoundingClientRect();
		let highest = 0;

		for (let i = 0; i < pageElements.length; i++) {
			const el = pageElements[i];
			if (!el) continue;
			const rect = el.getBoundingClientRect();
			// Fully visible
			if (rect.left >= containerRect.left - 2 && rect.right <= containerRect.right + 2) {
				highest = i;
			}
		}

		// Fallback to detectCurrentPage if nothing fully visible
		return highest || detectCurrentPage();
	}

	function handleScroll() {
		if (!scrollContainer) return;
		scroller?.onScroll();
		// Sync navTarget from manual scroll (drag/wheel), not from keyboard animation
		if (!scroller?.isAnimating) {
			navTarget = detectCurrentPage();
		}
		activityTracker.recordActivity();

		if (settleTimer) clearTimeout(settleTimer);
		settleTimer = setTimeout(reportProgress, 150);

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
	function navigateToPage(pageIdx: number, clamp = false) {
		if (!scroller || !scrollContainer) return;

		// Past the end: clamp first, exit on second press
		if (pageIdx >= pages.length) {
			if (clamp || navTarget < pages.length - 1) {
				pageIdx = pages.length - 1;
				// Mark as complete
				const { charCount } = getCharCount(pages, pages.length);
				onPageChange(pages.length, charCount, true);
			} else {
				onVolumeNav('next');
				return;
			}
		}
		// Before the start: clamp first, exit on second press
		if (pageIdx < 0) {
			if (clamp || navTarget > 0) {
				pageIdx = 0;
			} else {
				onVolumeNav('prev');
				return;
			}
		}
		navTarget = pageIdx;
		const el = pageElements[pageIdx];
		if (!el) return;

		// If a neighbor fits, center the pair
		const neighbor = pageIdx + 1 < pages.length ? pageIdx + 1 : pageIdx - 1;
		const neighborEl = neighbor >= 0 ? pageElements[neighbor] : null;

		if (neighborEl) {
			const elRect = el.getBoundingClientRect();
			const neighborRect = neighborEl.getBoundingClientRect();
			if (elRect.width + neighborRect.width <= scrollContainer.clientWidth + 2) {
				scroller.scrollToPairCenter(el, neighborEl);
				return;
			}
		}

		scroller.scrollToElement(el, 'center', 'center');
	}

	function handleKeydown(e: KeyboardEvent) {
		const target = e.target as HTMLElement;
		if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable) return;
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
			case ' ':
				e.preventDefault();
				navigateToPage(current + 2);
				break;
			case 'PageUp':
				e.preventDefault();
				navigateToPage(current - 2);
				break;
			case 'Home':
				e.preventDefault();
				navigateToPage(0, true);
				break;
			case 'End':
				e.preventDefault();
				navigateToPage(pages.length - 1, true);
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

	// ============================================================
	// Wheel — scroll along strip or zoom
	// ============================================================

	function handleWheel(e: WheelEvent) {
		if (!scrollContainer) return;
		const swap = $settings.swapWheelBehavior;
		const isZoom = swap ? !(e.ctrlKey || e.metaKey) : (e.ctrlKey || e.metaKey);

		if (isZoom) {
			e.preventDefault();
			cycleZoom(e.deltaY < 0 ? 1 : -1, e.clientX, e.clientY);
		} else {
			// Convert vertical wheel to horizontal scroll
			e.preventDefault();
			const delta = rtl ? -e.deltaY : e.deltaY;
			scrollContainer.scrollLeft += delta;
		}
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

	function handlePointerDown(e: PointerEvent) {
		if ((e.target as HTMLElement).closest('.textBox')) return;
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
			scrollContainer.scrollTop = dragScrollTop - dy;
		}
	}

	function handlePointerUp(e: PointerEvent) {
		if (isDragging) {
			try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
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
		if (now - lastTapTime < DOUBLE_TAP_DELAY) {
			lastTapTime = 0;
			const curIdx = ZOOM_LEVELS.indexOf(userZoom);
			const nextIdx = (curIdx + 1) % ZOOM_LEVELS.length;
			const newZoom = ZOOM_LEVELS[nextIdx];
			if (newZoom !== userZoom && scrollContainer) {
				const contentX = (scrollContainer.scrollLeft + e.clientX) / userZoom;
				const contentY = (scrollContainer.scrollTop + e.clientY) / userZoom;
				const biasX = e.clientX + (viewportWidth / 2 - e.clientX) * 0.7;
				const biasY = e.clientY + (viewportHeight / 2 - e.clientY) * 0.7;
				userZoom = newZoom;
				requestAnimationFrame(() => {
					if (!scrollContainer) return;
					scrollContainer.scrollLeft = contentX * newZoom - biasX;
					scrollContainer.scrollTop = contentY * newZoom - biasY;
				});
			}
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

	onMount(() => {
		if (scrollContainer) {
			scroller = new ScrollAnimator(scrollContainer);
		}
		outerDiv?.addEventListener('wheel', handleWheel, { passive: false });
		requestAnimationFrame(() => {
			const el = pageElements[currentPage - 1];
			if (el) el.scrollIntoView({ behavior: 'instant', inline: 'center' });
		});
	});

	onDestroy(() => {
		scroller?.destroy();
		outerDiv?.removeEventListener('wheel', handleWheel);
		if (settleTimer) clearTimeout(settleTimer);
	});
</script>

<svelte:window onkeydown={handleKeydown} onresize={handleResize} />

<div
	bind:this={outerDiv}
	class="fixed inset-0"
	style:background-color={$settings.backgroundColor}
	style:filter={`invert(${$invertColorsActive ? 1 : 0})`}
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
		class="flex h-full items-center overflow-auto scrollbar-hide"
		style:overscroll-behavior="none"
		style:direction={rtl ? 'rtl' : 'ltr'}
		onscroll={handleScroll}
	>
		<div class="flex items-center" style:direction={rtl ? 'rtl' : 'ltr'} style:zoom={userZoom !== 1 ? userZoom : undefined}>
			{#each pages as page, i (i)}
				<div
					bind:this={pageElements[i]}
					class="relative flex-shrink-0"
					style:width={`${scaledWidth(page)}px`}
					style:height={`${viewportHeight}px`}
					style:direction="ltr"
				>
					{#if blobUrls[i]}
						<img
							src={blobUrls[i]}
							alt="Page {i + 1}"
							class="block h-full w-auto"
							loading="lazy"
							draggable="false"
						/>
					{/if}
					<div
						class="absolute inset-0"
						style:width={`${page.img_width}px`}
						style:height={`${page.img_height}px`}
						style:transform={`scale(${viewportHeight / page.img_height})`}
						style:transform-origin="top left"
					>
						<TextBoxes
							{page}
							src={indexedFiles[i]}
							volumeUuid={volume.volume_uuid}
							pageIndex={i}
							forceVisible={missingPagePaths.has(page.img_path)}
						/>
					</div>
				</div>
			{/each}
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
