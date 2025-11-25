<script lang="ts">
	import { Button, Toolbar, ToolbarGroup, Select } from 'flowbite-svelte';
	import {
		CaretLeftSolid,
		CaretRightSolid,
		FloppyDiskSolid,
		DownloadSolid,
		XSolid,
		UndoOutline,
		CirclePlusSolid
	} from 'flowbite-svelte-icons';

	type ZoomMode = 'fit-screen' | 'fit-width' | 'original';

	interface Props {
		pageIndex: number;
		totalPages: number;
		hasUnsavedChanges: boolean;
		hasEdits: boolean;
		zoomMode: ZoomMode;
		onPrev: () => void;
		onNext: () => void;
		onSave: () => void;
		onExport: () => void;
		onExit: () => void;
		onRevert: () => void;
		onAddBox: () => void;
		onZoomChange: (mode: ZoomMode) => void;
	}

	let {
		pageIndex,
		totalPages,
		hasUnsavedChanges,
		hasEdits,
		zoomMode = $bindable(),
		onPrev,
		onNext,
		onSave,
		onExport,
		onExit,
		onRevert,
		onAddBox,
		onZoomChange
	}: Props = $props();

	const zoomOptions = [
		{ value: 'fit-screen', name: 'Fit to Screen' },
		{ value: 'fit-width', name: 'Fit to Width' },
		{ value: 'original', name: 'Original Size' }
	];

	function handleZoomChange(event: Event) {
		const target = event.target as HTMLSelectElement;
		onZoomChange(target.value as ZoomMode);
	}
</script>

<Toolbar
	color="dark"
	class="fixed top-0 left-0 right-0 z-50 px-4 py-2 flex items-center justify-between"
>
	<ToolbarGroup class="flex items-center gap-2">
		<Button size="sm" color="alternative" onclick={onExit}>
			<XSolid class="w-4 h-4 mr-2" />
			Exit
		</Button>

		<div class="mx-4 text-white font-medium">
			Page {pageIndex + 1} / {totalPages}
		</div>

		<Button size="sm" color="alternative" disabled={pageIndex <= 0} onclick={onPrev}>
			<CaretLeftSolid class="w-4 h-4 mr-2" />
			Previous
		</Button>

		<Button size="sm" color="alternative" disabled={pageIndex >= totalPages - 1} onclick={onNext}>
			Next
			<CaretRightSolid class="w-4 h-4 ml-2" />
		</Button>

		<div class="ml-4">
			<Select
				size="sm"
				class="w-40"
				value={zoomMode}
				onchange={handleZoomChange}
				items={zoomOptions}
			/>
		</div>
	</ToolbarGroup>

	<ToolbarGroup class="flex items-center gap-2">
		{#if hasUnsavedChanges}
			<span class="text-yellow-400 text-sm mr-2">Unsaved changes</span>
		{/if}

		<Button size="sm" color="green" onclick={onSave} disabled={!hasUnsavedChanges}>
			<FloppyDiskSolid class="w-4 h-4 mr-2" />
			Save
		</Button>

		<Button size="sm" color="purple" onclick={onAddBox}>
			<CirclePlusSolid class="w-4 h-4 mr-2" />
			Add Textbox
		</Button>

		{#if hasEdits}
			<Button size="sm" color="red" onclick={onRevert}>
				<UndoOutline class="w-4 h-4 mr-2" />
				Revert to Original
			</Button>
		{/if}

		<Button size="sm" color="blue" onclick={onExport}>
			<DownloadSolid class="w-4 h-4 mr-2" />
			Export .mokuro
		</Button>
	</ToolbarGroup>
</Toolbar>
