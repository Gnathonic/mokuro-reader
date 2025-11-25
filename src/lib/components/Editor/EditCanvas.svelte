<script lang="ts">
  import type { Page, Block } from '$lib/types';
  import EditableBox from './EditableBox.svelte';
  import { onMount } from 'svelte';

  type ZoomMode = 'fit-screen' | 'fit-width' | 'original';

  interface Props {
    pageData: Page;
    pageImage: string;
    workingBlocks: Block[];
    selectedIndex: number | null;
    zoomMode: ZoomMode;
    updateBlock: (index: number, block: Block) => void;
    deleteBlock: (index: number) => void;
    cloneBlock: (index: number) => number;
  }

  let {
    pageData,
    pageImage,
    workingBlocks = $bindable(),
    selectedIndex = $bindable(),
    zoomMode,
    updateBlock,
    deleteBlock,
    cloneBlock
  }: Props = $props();

  let containerRef: HTMLDivElement;
  let scale = $state(1);

  function handleSelect(index: number) {
    selectedIndex = index;
  }

  function handleDeselect() {
    selectedIndex = null;
  }

  function calculateZoom() {
    if (!containerRef) return;

    const container = containerRef;
    const padding = 64; // 8 * 2 (p-8 on each side)
    const containerWidth = container.clientWidth - padding;
    const containerHeight = container.clientHeight - padding;
    const pageWidth = pageData.img_width;
    const pageHeight = pageData.img_height;

    let newScale = 1;

    switch (zoomMode) {
      case 'fit-screen': {
        const scaleX = containerWidth / pageWidth;
        const scaleY = containerHeight / pageHeight;
        newScale = Math.min(scaleX, scaleY);
        break;
      }
      case 'fit-width': {
        newScale = containerWidth / pageWidth;
        break;
      }
      case 'original': {
        newScale = 1;
        break;
      }
    }

    scale = newScale;
  }

  onMount(() => {
    calculateZoom();
    window.addEventListener('resize', calculateZoom);
    return () => {
      window.removeEventListener('resize', calculateZoom);
    };
  });

  $effect(() => {
    // Recalculate when zoom mode changes
    zoomMode;
    calculateZoom();
  });
</script>

<div
  bind:this={containerRef}
  class="fixed top-16 right-0 bottom-0 left-0 flex items-center justify-center overflow-auto bg-gray-900 p-8"
>
  <div
    class="relative"
    style:width="{pageData.img_width}px"
    style:height="{pageData.img_height}px"
    style:transform="scale({scale})"
    style:transform-origin="center center"
  >
    <!-- Page Image -->
    <img
      src={pageImage}
      alt="Manga page"
      class="pointer-events-none absolute top-0 left-0 h-full w-full object-contain select-none"
      draggable="false"
    />

    <!-- Editable Text Boxes -->
    {#each workingBlocks as block, index (index)}
      <EditableBox
        {block}
        {index}
        isSelected={selectedIndex === index}
        imgWidth={pageData.img_width}
        imgHeight={pageData.img_height}
        onSelect={() => handleSelect(index)}
        onUpdate={(updatedBlock) => updateBlock(index, updatedBlock)}
        onDelete={() => deleteBlock(index)}
        onClone={() => cloneBlock(index)}
        bind:selectedIndex
      />
    {/each}

    <!-- Click outside to deselect -->
    <button class="absolute inset-0 -z-10" onclick={handleDeselect} aria-label="Deselect box"
    ></button>
  </div>
</div>
