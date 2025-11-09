<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { db } from '$lib/catalog/db';
	import { getCurrentPages, getOriginalPages } from '$lib/catalog/pages';
	import type { VolumeData, Page, Block } from '$lib/types';
	import { onMount } from 'svelte';
	import { Button, Modal, Spinner, Toast } from 'flowbite-svelte';
	import { CheckCircleSolid, CloseCircleSolid } from 'flowbite-svelte-icons';
	import EditToolbar from '$lib/components/Editor/EditToolbar.svelte';
	import EditCanvas from '$lib/components/Editor/EditCanvas.svelte';

	type ZoomMode = 'fit-screen' | 'fit-width' | 'original';

	let volumeUuid = $derived($page.params.volume || '');
	let pageIndexParam = $derived($page.params.pageIndex || '0');
	let pageIndex = $derived(parseInt(pageIndexParam, 10));

	let volumeData = $state<VolumeData | undefined>(undefined);
	let workingBlocks = $state<Block[]>([]);
	let selectedIndex = $state<number | null>(null);
	let hasUnsavedChanges = $state(false);
	let isLoading = $state(true);
	let showUnsavedWarning = $state(false);
	let pendingNavigation: (() => void) | null = null;
	let zoomMode = $state<ZoomMode>('fit-screen');
	let showSaveSuccess = $state(false);
	let showSaveError = $state(false);
	let saveErrorMessage = $state('');

	let pageData = $derived(volumeData ? getCurrentPages(volumeData)[pageIndex] : undefined);
	let totalPages = $derived(volumeData ? getCurrentPages(volumeData).length : 0);
	let pageImage = $derived(
		volumeData?.files && Object.values(volumeData.files)[pageIndex]
			? URL.createObjectURL(Object.values(volumeData.files)[pageIndex])
			: ''
	);

	onMount(async () => {
		await loadVolumeData();
	});

	async function loadVolumeData() {
		isLoading = true;
		try {
			const data = await db.volumes_data.get(volumeUuid);
			if (data) {
				volumeData = data;
				// Initialize working blocks with current page's blocks (edited or original)
				const currentPages = getCurrentPages(data);
				workingBlocks = structuredClone(currentPages[pageIndex]?.blocks || []);
			}
		} catch (error) {
			console.error('Failed to load volume data:', error);
		} finally {
			isLoading = false;
		}
	}

	function updateBlock(index: number, updatedBlock: Block) {
		workingBlocks[index] = updatedBlock;
		hasUnsavedChanges = true;
		workingBlocks = [...workingBlocks]; // Trigger reactivity
	}

	function deleteBlock(index: number) {
		workingBlocks.splice(index, 1);
		hasUnsavedChanges = true;
		selectedIndex = null;
		workingBlocks = [...workingBlocks]; // Trigger reactivity
	}

	function cloneBlock(index: number): number {
		const clonedBlock = structuredClone(workingBlocks[index]);
		// Offset the cloned box slightly
		const offset = 20;
		clonedBlock.box = [
			clonedBlock.box[0] + offset,
			clonedBlock.box[1] + offset,
			clonedBlock.box[2] + offset,
			clonedBlock.box[3] + offset
		];
		workingBlocks.push(clonedBlock);
		hasUnsavedChanges = true;
		workingBlocks = [...workingBlocks]; // Trigger reactivity
		return workingBlocks.length - 1; // Return new index
	}

	async function saveEdits() {
		if (!volumeData) return;

		try {
			// Get current pages (edited or original)
			const currentPages = getCurrentPages(volumeData);

			// Create a copy and update the current page's blocks
			// Use JSON parse/stringify to avoid cloning issues with IndexedDB objects and Svelte proxies
			const updatedPages = JSON.parse(JSON.stringify(currentPages));
			updatedPages[pageIndex].blocks = JSON.parse(JSON.stringify(workingBlocks));

			// Save to edited_pages field
			await db.volumes_data.update(volumeUuid, {
				edited_pages: updatedPages
			});

			// Update local volumeData
			volumeData.edited_pages = updatedPages;
			hasUnsavedChanges = false;

			// Show success toast
			showSaveSuccess = true;
			setTimeout(() => {
				showSaveSuccess = false;
			}, 3000);

			console.log('Edits saved successfully');
		} catch (error) {
			console.error('Failed to save edits:', error);

			// Show error toast
			saveErrorMessage = error instanceof Error ? error.message : 'Unknown error';
			showSaveError = true;
			setTimeout(() => {
				showSaveError = false;
			}, 5000);
		}
	}

	function navigatePage(newPageIndex: number) {
		if (newPageIndex < 0 || newPageIndex >= totalPages) return;

		if (hasUnsavedChanges) {
			showUnsavedWarning = true;
			pendingNavigation = () => {
				goto(`/${$page.params.manga}/${volumeUuid}/edit/${newPageIndex}`);
			};
		} else {
			goto(`/${$page.params.manga}/${volumeUuid}/edit/${newPageIndex}`);
		}
	}

	function exitToReader() {
		if (hasUnsavedChanges) {
			showUnsavedWarning = true;
			pendingNavigation = () => {
				goto(`/${$page.params.manga}/${volumeUuid}?page=${pageIndex + 1}`);
			};
		} else {
			goto(`/${$page.params.manga}/${volumeUuid}?page=${pageIndex + 1}`);
		}
	}

	async function saveAndNavigate() {
		await saveEdits();
		showUnsavedWarning = false;
		if (pendingNavigation) {
			pendingNavigation();
			pendingNavigation = null;
		}
	}

	function discardAndNavigate() {
		hasUnsavedChanges = false;
		showUnsavedWarning = false;
		if (pendingNavigation) {
			pendingNavigation();
			pendingNavigation = null;
		}
	}

	function cancelNavigation() {
		showUnsavedWarning = false;
		pendingNavigation = null;
	}

	async function exportMokuro() {
		if (!volumeData) return;

		try {
			const metadata = await db.volumes.get(volumeUuid);
			if (!metadata) return;

			const currentPages = getCurrentPages(volumeData);

			const mokuroData = {
				version: metadata.mokuro_version,
				title: metadata.series_title,
				title_uuid: metadata.series_uuid,
				volume: metadata.volume_title,
				volume_uuid: metadata.volume_uuid,
				pages: currentPages,
				chars: currentPages.reduce(
					(total, page) =>
						total +
						page.blocks.reduce((pageTotal, block) => pageTotal + block.lines.join('').length, 0),
					0
				)
			};

			const blob = new Blob([JSON.stringify(mokuroData, null, 2)], {
				type: 'application/json'
			});
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `${metadata.volume_title}_edited.mokuro`;
			a.click();
			URL.revokeObjectURL(url);
		} catch (error) {
			console.error('Failed to export .mokuro file:', error);
		}
	}
</script>

<svelte:head>
	<title>Edit Page {pageIndex + 1}</title>
</svelte:head>

{#if isLoading}
	<div class="flex items-center justify-center w-screen h-screen">
		<Spinner size="12" />
	</div>
{:else if volumeData && pageData}
	<EditToolbar
		{pageIndex}
		{totalPages}
		{hasUnsavedChanges}
		bind:zoomMode
		onPrev={() => navigatePage(pageIndex - 1)}
		onNext={() => navigatePage(pageIndex + 1)}
		onSave={saveEdits}
		onExport={exportMokuro}
		onExit={exitToReader}
		onZoomChange={(mode) => (zoomMode = mode)}
	/>

	<EditCanvas
		{pageData}
		{pageImage}
		{zoomMode}
		bind:workingBlocks
		bind:selectedIndex
		{updateBlock}
		{deleteBlock}
		{cloneBlock}
	/>

	<Modal bind:open={showUnsavedWarning} size="xs" autoclose={false}>
		<div class="text-center">
			<h3 class="mb-5 text-lg font-normal text-gray-500 dark:text-gray-400">
				You have unsaved changes. Save before leaving?
			</h3>
			<div class="flex justify-center gap-4">
				<Button color="green" on:click={saveAndNavigate}>Save & Continue</Button>
				<Button color="red" on:click={discardAndNavigate}>Discard</Button>
				<Button color="alternative" on:click={cancelNavigation}>Cancel</Button>
			</div>
		</div>
	</Modal>

	<!-- Success Toast -->
	<Toast
		color="green"
		position="top-right"
		open={showSaveSuccess}
		class="fixed top-20 right-4 z-50"
	>
		<svelte:fragment slot="icon">
			<CheckCircleSolid class="w-5 h-5" />
		</svelte:fragment>
		Edits saved successfully
	</Toast>

	<!-- Error Toast -->
	<Toast
		color="red"
		position="top-right"
		open={showSaveError}
		class="fixed top-20 right-4 z-50"
	>
		<svelte:fragment slot="icon">
			<CloseCircleSolid class="w-5 h-5" />
		</svelte:fragment>
		Failed to save: {saveErrorMessage}
	</Toast>
{:else}
	<div class="flex items-center justify-center w-screen h-screen">
		<p class="text-xl">Failed to load page data</p>
	</div>
{/if}
