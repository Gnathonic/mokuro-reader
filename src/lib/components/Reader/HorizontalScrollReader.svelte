<script lang="ts">
	import type { Page, VolumeMetadata } from '$lib/types';
	import type { VolumeSettings } from '$lib/settings/volume-data';
	import { settings, invertColorsActive } from '$lib/settings';
	import { matchFilesToPages } from '$lib/reader/image-cache';
	import { getCharCount } from '$lib/util/count-chars';
	import { activityTracker } from '$lib/util/activity-tracker';
	import TextBoxes from './TextBoxes.svelte';
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

	let scrollContainer: HTMLDivElement | undefined = $state();
	let viewportHeight = $state(typeof window !== 'undefined' ? window.innerHeight : 768);
	let indexedFiles = $derived.by(() => matchFilesToPages(files, pages));
	let missingPagePaths = $derived(new Set(volume?.missing_page_paths || []));
	let rtl = $derived(volumeSettings.rightToLeft ?? true);

	// All images scaled to match viewport height
	function scaledWidth(page: Page): number {
		return (page.img_width / page.img_height) * viewportHeight;
	}

	// Blob URLs
	let blobUrls = $state<string[]>([]);

	$effect(() => {
		const urls = indexedFiles.map((file) => (file ? URL.createObjectURL(file) : ''));
		blobUrls = urls;

		return () => {
			urls.forEach((url) => {
				if (url) URL.revokeObjectURL(url);
			});
		};
	});

	// Progress tracking
	let lastReportedPage = currentPage;
	let settleTimer: ReturnType<typeof setTimeout> | undefined;
	let pageElements: HTMLDivElement[] = [];

	function detectCurrentPage(): number {
		if (!scrollContainer) return 0;
		const centerX = scrollContainer.scrollLeft + scrollContainer.clientWidth / 2;

		let closest = 0;
		let closestDist = Infinity;

		for (let i = 0; i < pageElements.length; i++) {
			const el = pageElements[i];
			if (!el) continue;
			const elCenter = el.offsetLeft + el.offsetWidth / 2;
			const dist = Math.abs(elCenter - centerX);
			if (dist < closestDist) {
				closestDist = dist;
				closest = i;
			}
		}

		return closest;
	}

	function handleScroll() {
		if (!scrollContainer) return;
		activityTracker.recordActivity();

		if (settleTimer) clearTimeout(settleTimer);
		settleTimer = setTimeout(() => {
			const pageIdx = detectCurrentPage();
			const pageNum = pageIdx + 1;
			if (pageNum !== lastReportedPage) {
				lastReportedPage = pageNum;
				const { charCount } = getCharCount(pages, pageNum);
				onPageChange(pageNum, charCount, pageNum >= pages.length);
			}
		}, 150);

		// Auto-advance
		const { scrollLeft, scrollWidth, clientWidth } = scrollContainer;
		const atEnd = rtl
			? scrollLeft <= 2 - (scrollWidth - clientWidth)
			: scrollLeft + clientWidth >= scrollWidth - 2;
		if (atEnd) {
			onVolumeNav('next');
		}
	}

	// Scroll to current page on external change
	$effect(() => {
		if (currentPage !== lastReportedPage && scrollContainer) {
			lastReportedPage = currentPage;
			const el = pageElements[currentPage - 1];
			if (el) {
				el.scrollIntoView({ behavior: 'smooth', inline: 'center' });
			}
		}
	});

	function handleClick(e: MouseEvent) {
		if ((e.target as HTMLElement).closest('.textBox')) return;
		onOverlayToggle?.();
	}

	function handleResize() {
		viewportHeight = window.innerHeight;
	}

	onMount(() => {
		requestAnimationFrame(() => {
			const el = pageElements[currentPage - 1];
			if (el) {
				el.scrollIntoView({ behavior: 'instant', inline: 'center' });
			}
		});
	});

	onDestroy(() => {
		if (settleTimer) clearTimeout(settleTimer);
	});
</script>

<svelte:window onresize={handleResize} />

<div
	class="fixed inset-0"
	style:background-color={$settings.backgroundColor}
	style:filter={`invert(${$invertColorsActive ? 1 : 0})`}
>
	<div
		bind:this={scrollContainer}
		class="flex h-full items-center overflow-x-auto overflow-y-hidden scrollbar-hide"
		style:overscroll-behavior="none"
		style:direction={rtl ? 'rtl' : 'ltr'}
		onscroll={handleScroll}
		onclick={handleClick}
		role="none"
	>
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

<style>
	.scrollbar-hide {
		scrollbar-width: none;
		-ms-overflow-style: none;
	}
	.scrollbar-hide::-webkit-scrollbar {
		display: none;
	}
</style>
