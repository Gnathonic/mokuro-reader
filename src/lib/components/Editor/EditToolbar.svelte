<script lang="ts">
  import { Button, Toolbar, ToolbarGroup, Select, Tooltip } from 'flowbite-svelte';
  import {
    CaretLeftSolid,
    CaretRightSolid,
    FloppyDiskSolid,
    DownloadSolid,
    XSolid,
    UndoOutline,
    CirclePlusSolid,
    TrashBinSolid
  } from 'flowbite-svelte-icons';

  type ZoomMode = 'fit-screen' | 'fit-width' | 'original';

  interface Props {
    pageIndex: number;
    totalPages: number;
    hasUnsavedChanges: boolean;
    hasEdits: boolean;
    isBlockSelected: boolean; // Controls state of block actions
    zoomMode: ZoomMode;
    onPrev: () => void;
    onNext: () => void;
    onSave: () => void;
    onExport: () => void;
    onExit: () => void;
    onRevert: () => void;
    onAddBox: () => void;
    onDelete: () => void;
    onZoomChange: (mode: ZoomMode) => void;
  }

  let {
    pageIndex,
    totalPages,
    hasUnsavedChanges,
    hasEdits,
    isBlockSelected,
    zoomMode = $bindable(),
    onPrev,
    onNext,
    onSave,
    onExport,
    onExit,
    onRevert,
    onAddBox,
    onDelete,
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
  class="fixed top-0 right-0 left-0 z-50 flex items-center justify-between border-b border-gray-700 bg-gray-800 px-4 py-2"
>
  <ToolbarGroup class="flex items-center gap-2">
    <Button size="sm" color="alternative" onclick={onExit} class="!p-2">
      <XSolid class="h-4 w-4" />
      <span class="ml-2 hidden sm:inline">Exit</span>
    </Button>
    <Tooltip>Exit Editor</Tooltip>

    <div class="mx-2 flex items-center gap-1 font-medium text-white">
      <span class="hidden sm:inline">Page</span>
      <span>{pageIndex + 1}</span>
      <span class="text-gray-400">/</span>
      <span>{totalPages}</span>
    </div>

    <Button size="xs" color="alternative" disabled={pageIndex <= 0} onclick={onPrev} class="!p-2">
      <CaretLeftSolid class="h-4 w-4" />
    </Button>

    <Button
      size="xs"
      color="alternative"
      disabled={pageIndex >= totalPages - 1}
      onclick={onNext}
      class="!p-2"
    >
      <CaretRightSolid class="h-4 w-4" />
    </Button>

    <div class="ml-2 hidden sm:block">
      <Select
        size="sm"
        class="w-36"
        value={zoomMode}
        onchange={handleZoomChange}
        items={zoomOptions}
      />
    </div>
  </ToolbarGroup>

  <ToolbarGroup class="flex items-center gap-2">
    <!-- Block Actions -->
    <div class="mr-2 flex items-center gap-1 border-r border-gray-600 pr-2">
      <Button
        size="sm"
        color="red"
        outline
        disabled={!isBlockSelected}
        onclick={onDelete}
        class="!p-2"
      >
        <TrashBinSolid class="h-4 w-4" />
        <span class="ml-2 hidden sm:inline">Delete</span>
      </Button>
      <Tooltip>Delete Selected Box</Tooltip>

      <Button size="sm" color="purple" onclick={onAddBox} class="!p-2">
        <CirclePlusSolid class="h-4 w-4" />
        <span class="ml-2 hidden sm:inline">Add Box</span>
      </Button>
    </div>

    <!-- Page Actions -->
    {#if hasUnsavedChanges}
      <span class="mr-2 hidden animate-pulse text-xs font-bold text-yellow-400 sm:inline"
        >Unsaved</span
      >
    {/if}

    <Button size="sm" color="green" onclick={onSave} disabled={!hasUnsavedChanges} class="!p-2">
      <FloppyDiskSolid class="h-4 w-4" />
      <span class="ml-2 hidden sm:inline">Save</span>
    </Button>

    {#if hasEdits}
      <Button size="sm" color="red" onclick={onRevert} class="!p-2">
        <UndoOutline class="h-4 w-4" />
      </Button>
      <Tooltip>Revert to Original</Tooltip>
    {/if}

    <Button size="sm" color="blue" onclick={onExport} class="!p-2">
      <DownloadSolid class="h-4 w-4" />
    </Button>
    <Tooltip>Export .mokuro</Tooltip>
  </ToolbarGroup>
</Toolbar>
