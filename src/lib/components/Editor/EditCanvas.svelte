<script lang="ts">
  import type { Page, Block } from '$lib/types';
  import { onMount } from 'svelte';

  import OcrBlock from './OcrBlock.svelte';
  import { OcrState } from '$lib/states/OcrState.svelte';

  type ZoomMode = 'fit-screen' | 'fit-width' | 'original';

  interface Props {
    pageData: Page;
    pageImage: string;
    workingBlocks: Block[];
    zoomMode: ZoomMode;
    // Callbacks
    onBlockFocus: (block: Block | null) => void;
    onOcrChange: () => void;
  }

  let {
    pageData,
    pageImage,
    workingBlocks = $bindable(),
    zoomMode,
    onBlockFocus,
    onOcrChange
  }: Props = $props();

  let containerRef: HTMLDivElement | undefined = $state();
  let scale = $state(1);

  // 1. Initialize OcrState
  const ocrState = new OcrState({
    showTriggerOutline: true,
    isSmartResizeMode: true,
    readingDirection: 'rtl',
    onOcrChange: () => {
      // Propagete dirty signal
      onOcrChange();
    },
    onLineFocus: (block) => {
      // Propagate focus UP to parent
      onBlockFocus(block);
    }
  });

  let proxyPage = $derived({
    ...pageData,
    blocks: workingBlocks
  });

  $effect(() => {
    ocrState.page = proxyPage;
    ocrState.currentScale = scale;
  });

  function handleDeselect() {
    onBlockFocus(null);
    ocrState.setFocus(null);
  }

  function calculateZoom() {
    if (!containerRef) return;

    const container = containerRef;
    const padding = 64;
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
    zoomMode;
    calculateZoom();
  });

  // --- Actions ---
  const handleOverlayClick = (e: MouseEvent) => {
    // Only act on clicks directly on the background (not bubbling from block)
    if (e.target !== e.currentTarget) return;

    // Blur focus if clicking empty space
    if (ocrState.ocrMode === 'TEXT') {
      ocrState.setFocus(null);
      ocrState.setMode('BOX');
    }

    // Clear Selection
    const selection = window.getSelection();
    if (selection) selection.removeAllRanges();
  };

  // internal function for cascade delete
  const handleDeleteBlock = (blockToDelete: Block) => {
    const index = proxyPage.blocks.indexOf(blockToDelete);
    if (index > -1) {
      proxyPage.blocks.splice(index, 1);
      ocrState.markDirty();
    }
  };

  // --- Public Methods ---

  export const deleteFocusedBlock = () => {
    if (ocrState.focusedBlock) {
      handleDeleteBlock(ocrState.focusedBlock);
    }
  };

  export const addTextboxToCenter = () => {
    if (!pageData) return;

    const centerX = pageData.img_width / 2;
    const centerY = pageData.img_height / 2;
    const defaultWidth = 200;
    const defaultHeight = 100;

    // Use lines_coords for proper polygon support in new OCR system
    const newBlock: Block = {
      box: [
        centerX - defaultWidth / 2,
        centerY - defaultHeight / 2,
        centerX + defaultWidth / 2,
        centerY + defaultHeight / 2
      ],
      vertical: true, // Default to vertical for Japanese text
      font_size: 24,
      lines: ['New Text'],
      lines_coords: [
        [
          [centerX - defaultWidth / 2 + 10, centerY - defaultHeight / 2 + 10],
          [centerX + defaultWidth / 2 - 10, centerY - defaultHeight / 2 + 10],
          [centerX + defaultWidth / 2 - 10, centerY + defaultHeight / 2 - 10],
          [centerX - defaultWidth / 2 + 10, centerY + defaultHeight / 2 - 10]
        ]
      ]
    };

    workingBlocks.push(newBlock);
    workingBlocks = [...workingBlocks];
    ocrState.setFocus(newBlock);
    ocrState.markDirty();
  };
</script>

<div
  bind:this={containerRef}
  class="fixed top-16 right-0 bottom-0 left-0 overflow-auto bg-gray-900 p-8"
>
  <div
    class="m-auto"
    style:width="{pageData.img_width * scale}px"
    style:height="{pageData.img_height * scale}px"
  >
    <div
      class="relative top-0 left-0"
      style:aspect-ratio="{pageData.img_width} / {pageData.img_height}"
      style:width="{pageData.img_width}px"
      style:height="{pageData.img_height}px"
      style:transform="scale({scale})"
      style:transform-origin="top left"
    >
      <img
        src={pageImage}
        alt="Manga page"
        class="pointer-events-none absolute top-0 left-0 h-full w-full object-contain select-none"
        draggable="false"
      />

      <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
      <div
        class="ocr-top-layer absolute top-0 left-0 h-full w-full object-contain"
        bind:this={ocrState.overlayElement}
        onclick={handleOverlayClick}
        oncontextmenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {#each proxyPage.blocks as block, i (block)}
          <OcrBlock
            block={proxyPage.blocks[i]}
            {ocrState}
            onDelete={() => handleDeleteBlock(block)}
          />
        {/each}
      </div>

      <button class="absolute inset-0 -z-10" onclick={handleDeselect} aria-label="Deselect box"
      ></button>
    </div>
  </div>
</div>
