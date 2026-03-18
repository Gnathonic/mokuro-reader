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
	let indexedFiles = $derived.by(() => matchFilesToPages(files, pages));
	let missingPagePaths = $derived(new Set(volume?.missing_page_paths || []));

	// Blob URLs for images
	let blobUrls = $state<string[]>([]);

	$effect(() => {
		// Create blob URLs for all pages
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
		const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
		if (scrollTop + clientHeight >= scrollHeight - 2) {
			onVolumeNav('next');
		}
	}

	// Scroll to current page on external change
	$effect(() => {
		if (currentPage !== lastReportedPage && scrollContainer) {
			lastReportedPage = currentPage;
			const el = pageElements[currentPage - 1];
			if (el) {
				el.scrollIntoView({ behavior: 'smooth', block: 'start' });
			}
		}
	});

	// Overlay toggle on click
	function handleClick(e: MouseEvent) {
		if ((e.target as HTMLElement).closest('.textBox')) return;
		onOverlayToggle?.();
	}

	onMount(() => {
		// Scroll to initial page
		requestAnimationFrame(() => {
			const el = pageElements[currentPage - 1];
			if (el) {
				el.scrollIntoView({ behavior: 'instant', block: 'start' });
			}
		});
	});

	onDestroy(() => {
		if (settleTimer) clearTimeout(settleTimer);
	});
</script>

<div
	class="fixed inset-0"
	style:background-color={$settings.backgroundColor}
	style:filter={`invert(${$invertColorsActive ? 1 : 0})`}
>
	<div
		bind:this={scrollContainer}
		class="h-full w-full overflow-y-auto overflow-x-hidden scrollbar-hide"
		style:overscroll-behavior="none"
		onscroll={handleScroll}
		onclick={handleClick}
		role="none"
	>
		{#each pages as page, i (i)}
			<div
				bind:this={pageElements[i]}
				class="relative mx-auto"
				style:width="100%"
				style:max-width={`${page.img_width}px`}
				style:aspect-ratio={`${page.img_width} / ${page.img_height}`}
			>
				{#if blobUrls[i]}
					<img
						src={blobUrls[i]}
						alt="Page {i + 1}"
						class="block w-full"
						loading="lazy"
						draggable="false"
					/>
				{/if}
				<div class="absolute inset-0">
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
