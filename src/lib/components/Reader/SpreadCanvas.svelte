<script lang="ts">
	import type { Page, VolumeMetadata } from '$lib/types';
	import type { PageSpread } from '$lib/reader/spread-grouping';
	import type { TileConfig } from '$lib/reader/tile/tile-config';
	import { TileRenderer } from '$lib/reader/tile/tile-renderer';
	import { TileDecoder } from '$lib/reader/tile/tile-decoder';
	import TextBoxes from './TextBoxes.svelte';
	import { onMount, onDestroy } from 'svelte';

	interface Props {
		spread: PageSpread;
		files: File[];
		volume: VolumeMetadata;
		config: TileConfig;
		visible: boolean;
		scale: number;
		rtl: boolean;
		missingPagePaths: Set<string>;
		decoder: TileDecoder;
	}

	let {
		spread,
		files,
		volume,
		config,
		visible,
		scale,
		rtl,
		missingPagePaths,
		decoder
	}: Props = $props();

	// One canvas + renderer per page in the spread
	let canvases: HTMLCanvasElement[] = $state([]);
	let renderers: TileRenderer[] = [];
	let loaded = $state(false);

	// Compute native spread dimensions
	let nativeW = $derived(
		spread.type === 'dual'
			? spread.pages[0].img_width + spread.pages[1].img_width
			: spread.pages[0].img_width
	);
	let nativeH = $derived(
		spread.type === 'dual'
			? Math.max(spread.pages[0].img_height, spread.pages[1].img_height)
			: spread.pages[0].img_height
	);

	// Page entries with x-offsets for positioning
	let entries = $derived.by(() => {
		if (spread.type === 'dual') {
			const [p0, p1] = spread.pages;
			const [i0, i1] = spread.pageIndices;
			return rtl
				? [
						{ page: p1, pageIndex: i1, xOffset: 0 },
						{ page: p0, pageIndex: i0, xOffset: p1.img_width }
					]
				: [
						{ page: p0, pageIndex: i0, xOffset: 0 },
						{ page: p1, pageIndex: i1, xOffset: p0.img_width }
					];
		}
		return [{ page: spread.pages[0], pageIndex: spread.pageIndices[0], xOffset: 0 }];
	});

	onMount(() => {
		// If already visible when mounted, start loading
		if (visible) {
			initAndLoad();
		}
	});

	onDestroy(() => {
		for (const renderer of renderers) {
			renderer.destroy();
		}
		renderers = [];
	});

	// React to visibility changes
	$effect(() => {
		if (visible && !loaded) {
			initAndLoad();
		}
	});

	async function initAndLoad() {
		if (loaded || renderers.length > 0) return;

		// Wait a tick for canvases to bind
		await new Promise((r) => requestAnimationFrame(r));

		try {
			for (let i = 0; i < entries.length; i++) {
				const entry = entries[i];
				const file = files[entry.pageIndex];
				const canvas = canvases[i];
				if (!file || !canvas) continue;

				// Create renderer for this page
				const renderer = new TileRenderer(config);
				await renderer.init(canvas, entry.page.img_width, entry.page.img_height);
				renderers.push(renderer);

				// Decode and upload tiles
				const result = await decoder.decodePage(file, config);
				renderer.setTiles(result.tiles);
			}
			loaded = true;
		} catch (err) {
			console.error('Failed to load tiles for spread:', spread.pageIndices, err);
		}
	}
</script>

<div
	class="relative"
	style:width={`${nativeW * scale}px`}
	style:height={`${nativeH * scale}px`}
>
	<div
		class="relative origin-top-left"
		style:width={`${nativeW}px`}
		style:height={`${nativeH}px`}
		style:transform={`scale(${scale})`}
	>
		<!-- One canvas per page, positioned within the spread -->
		{#each entries as entry, i (entry.pageIndex)}
			<div
				class="absolute top-0"
				style:left={`${entry.xOffset}px`}
				style:width={`${entry.page.img_width}px`}
				style:height={`${entry.page.img_height}px`}
			>
				<canvas
					bind:this={canvases[i]}
					width={entry.page.img_width}
					height={entry.page.img_height}
				></canvas>

				<!-- HTML text overlay on top of canvas -->
				<TextBoxes
					page={entry.page}
					src={files[entry.pageIndex]}
					volumeUuid={volume.volume_uuid}
					pageIndex={entry.pageIndex}
					forceVisible={missingPagePaths.has(entry.page.img_path)}
				/>
			</div>
		{/each}
	</div>
</div>
