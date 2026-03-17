<script lang="ts">
	import type { Page, VolumeMetadata } from '$lib/types';
	import type { PageSpread } from '$lib/reader/spread-grouping';
	import type { TileConfig } from '$lib/reader/tile/tile-config';
	import { TileRenderer } from '$lib/reader/tile/tile-renderer';
	import { TileDecoder, type DecodeResult } from '$lib/reader/tile/tile-decoder';
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

	let canvas: HTMLCanvasElement | undefined = $state();
	let renderer: TileRenderer | null = null;
	let loaded = $state(false);
	let decodeResults = $state<DecodeResult[]>([]);

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

	// Page entries with x-offsets for positioning text overlays
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

	onMount(async () => {
		if (!canvas) return;

		renderer = new TileRenderer(config);
		await renderer.init(canvas, nativeW, nativeH);

		// If already visible when mounted, start loading
		if (visible) {
			loadTiles();
		}
	});

	onDestroy(() => {
		if (renderer) {
			renderer.destroy();
			renderer = null;
		}
		// Close any decode result bitmaps we still hold
		for (const result of decodeResults) {
			for (const tile of result.tiles) {
				tile.bitmap.close();
			}
		}
		decodeResults = [];
	});

	// React to visibility changes
	$effect(() => {
		if (visible && renderer?.initialized && !loaded) {
			loadTiles();
		}
	});

	async function loadTiles() {
		if (!renderer || loaded) return;

		try {
			// Decode each page in the spread
			const allTiles: Array<{ col: number; row: number; bitmap: ImageBitmap }> = [];
			const results: DecodeResult[] = [];

			for (let i = 0; i < spread.pageIndices.length; i++) {
				const pageIndex = spread.pageIndices[i];
				const file = files[pageIndex];
				if (!file) continue;

				const result = await decoder.decodePage(file, config);
				results.push(result);

				// Calculate x-offset for this page within the spread
				const entry = entries.find((e) => e.pageIndex === pageIndex);
				const xOffsetPx = entry?.xOffset ?? 0;

				// Adjust tile positions by the page offset within the spread
				const colOffset = Math.floor(xOffsetPx / config.contentSize);
				const pxOffset = xOffsetPx - colOffset * config.contentSize;

				for (const tile of result.tiles) {
					allTiles.push({
						col: tile.col + colOffset,
						row: tile.row,
						bitmap: tile.bitmap
					});
				}
			}

			decodeResults = results;
			renderer.setTiles(allTiles);
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
		<!-- PixiJS canvas renders the tiled page images -->
		<canvas
			bind:this={canvas}
			width={nativeW}
			height={nativeH}
			class="absolute inset-0"
		></canvas>

		<!-- HTML text overlay on top of canvas for extension compatibility -->
		{#each entries as entry (entry.pageIndex)}
			<div class="absolute top-0" style:left={`${entry.xOffset}px`}>
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
