<script lang="ts">
  import type { Block } from '$lib/types';
  import {
    TrashBinSolid,
    FileCopySolid,
    ExpandOutline,
    ArrowUpRightDownLeftOutline
  } from 'flowbite-svelte-icons';
  import { clamp } from '$lib/util';

  interface Props {
    block: Block;
    index: number;
    isSelected: boolean;
    imgWidth: number;
    imgHeight: number;
    selectedIndex: number | null;
    onSelect: () => void;
    onUpdate: (block: Block) => void;
    onDelete: () => void;
    onClone: () => number;
  }

  let {
    block,
    index,
    isSelected,
    imgWidth,
    imgHeight,
    selectedIndex = $bindable(),
    onSelect,
    onUpdate,
    onDelete,
    onClone
  }: Props = $props();

  let isDraggingMove = $state(false);
  let isDraggingResize = $state(false);
  let dragStartX = $state(0);
  let dragStartY = $state(0);
  let isEditingText = $state(false);
  let textContent = $state('');
  let resizeFrameCount = $state(0);

  // Derived values
  let [xmin, ymin, xmax, ymax] = $derived(block.box);
  let width = $derived(xmax - xmin);
  let height = $derived(ymax - ymin);

  // Initialize text content when block changes
  $effect(() => {
    textContent = block.lines.join('\n');
  });

  function handleSelect(e: MouseEvent) {
    e.stopPropagation();
    if (!isSelected) {
      onSelect();
    }
  }

  function handleMoveStart(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    isDraggingMove = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;

    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleMoveEnd);
  }

  function handleMove(e: MouseEvent) {
    if (!isDraggingMove) return;

    const deltaX = e.clientX - dragStartX;
    const deltaY = e.clientY - dragStartY;

    // Calculate new position
    const newXmin = clamp(xmin + deltaX, 0, imgWidth - width);
    const newYmin = clamp(ymin + deltaY, 0, imgHeight - height);

    onUpdate({
      ...block,
      box: [newXmin, newYmin, newXmin + width, newYmin + height]
    });

    dragStartX = e.clientX;
    dragStartY = e.clientY;
  }

  function handleMoveEnd() {
    isDraggingMove = false;
    document.removeEventListener('mousemove', handleMove);
    document.removeEventListener('mouseup', handleMoveEnd);
  }

  function handleResizeStart(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    isDraggingResize = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;

    document.addEventListener('mousemove', handleResize);
    document.addEventListener('mouseup', handleResizeEnd);
  }

  function handleResize(e: MouseEvent) {
    if (!isDraggingResize) return;

    const deltaX = e.clientX - dragStartX;
    const deltaY = e.clientY - dragStartY;

    // Calculate new bottom-right corner (top-left stays anchored)
    const newXmax = clamp(xmax + deltaX, xmin + 20, imgWidth);
    const newYmax = clamp(ymax + deltaY, ymin + 20, imgHeight);

    onUpdate({
      ...block,
      box: [xmin, ymin, newXmax, newYmax]
    });

    dragStartX = e.clientX;
    dragStartY = e.clientY;

    // Auto-size font every 10 frames during resize (throttle for performance)
    resizeFrameCount++;
    if (resizeFrameCount % 10 === 0) {
      requestAnimationFrame(() => autoSizeFontDuringResize());
    }
  }

  async function autoSizeFontDuringResize() {
    // Get the text container element
    const container = document.querySelector(
      `[data-block-index="${index}"] .text-container`
    ) as HTMLElement;
    if (!container) return;

    const maxSize = 100;
    const minSize = 6;

    // Helper to check if content overflows
    const isOverflowing = () => {
      return (
        container.scrollHeight > container.clientHeight ||
        container.scrollWidth > container.clientWidth
      );
    };

    let testSize = block.font_size;

    // Quick check: if overflowing, decrease; if not, try to increase
    if (isOverflowing()) {
      // Decrease until fits
      while (testSize > minSize && isOverflowing()) {
        testSize--;
        onUpdate({
          ...block,
          font_size: testSize
        });
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    } else {
      // Try to increase
      while (testSize < maxSize) {
        testSize++;
        onUpdate({
          ...block,
          font_size: testSize
        });
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if (isOverflowing()) {
          // Went too far, go back one
          testSize--;
          onUpdate({
            ...block,
            font_size: testSize
          });
          break;
        }
      }
    }
  }

  function handleResizeEnd() {
    isDraggingResize = false;
    resizeFrameCount = 0;
    document.removeEventListener('mousemove', handleResize);
    document.removeEventListener('mouseup', handleResizeEnd);

    // Do a final auto-size when resize is complete
    requestAnimationFrame(() => autoSizeFontDuringResize());
  }

  function handleClone(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();

    // Create the clone and get new index
    const newIndex = onClone();

    // Select the new box
    selectedIndex = newIndex;

    // Immediately start move mode on the cloned box
    isDraggingMove = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;

    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleMoveEnd);
  }

  function handleDelete(e: MouseEvent) {
    e.stopPropagation();
    onDelete();
  }

  function handleTextClick(e: MouseEvent) {
    if (isSelected) {
      e.stopPropagation();
      isEditingText = true;
    }
  }

  function handleTextBlur() {
    isEditingText = false;
    // Update lines from text content
    const newLines = textContent.split('\n').filter((line) => line.trim() !== '');
    onUpdate({
      ...block,
      lines: newLines.length > 0 ? newLines : ['']
    });
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      isEditingText = false;
      textContent = block.lines.join('\n'); // Revert changes
    } else if (e.key === 'Delete' && !isEditingText && isSelected) {
      onDelete();
    }
  }

  async function autoSizeFontSize(e: MouseEvent) {
    e.stopPropagation();

    // Get the text container element
    const container = (e.currentTarget as HTMLElement).parentElement?.querySelector(
      '.w-full.h-full'
    ) as HTMLElement;
    if (!container) return;

    const maxSize = 100;
    const minSize = 6;

    // Helper to check if content overflows
    const isOverflowing = () => {
      return (
        container.scrollHeight > container.clientHeight ||
        container.scrollWidth > container.clientWidth
      );
    };

    // Helper to wait for next frame
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

    let testSize = block.font_size;

    // Phase 1: Increase size until overflow
    while (testSize < maxSize) {
      testSize++;
      onUpdate({
        ...block,
        font_size: testSize
      });
      await nextFrame();

      if (isOverflowing()) {
        // Found overflow! Now reduce until it fits
        // Phase 2: Decrease size until it fits
        while (testSize > minSize && isOverflowing()) {
          testSize--;
          onUpdate({
            ...block,
            font_size: testSize
          });
          await nextFrame();
        }
        return; // Done!
      }
    }
  }
</script>

<svelte:window onkeydown={handleKeyDown} />

<div
  class="absolute border-2"
  class:border-dashed={!isSelected}
  class:border-solid={isSelected}
  class:border-gray-400={!isSelected}
  class:border-blue-500={isSelected}
  class:opacity-60={!isSelected}
  class:opacity-100={isSelected}
  class:z-10={!isSelected}
  class:z-50={isSelected}
  class:cursor-move={isDraggingMove}
  class:cursor-nwse-resize={isDraggingResize}
  style:left="{xmin}px"
  style:top="{ymin}px"
  style:width="{width}px"
  style:height="{height}px"
  style:writing-mode={block.vertical ? 'vertical-rl' : 'horizontal-tb'}
  onclick={handleSelect}
  role="button"
  tabindex="0"
  data-block-index={index}
>
  <!-- Text Content -->
  {#if isEditingText}
    <textarea
      bind:value={textContent}
      onblur={handleTextBlur}
      class="h-full w-full resize-none border-none bg-white p-1 text-black outline-none"
      style:writing-mode={block.vertical ? 'vertical-rl' : 'horizontal-tb'}
      style:font-size="{block.font_size}px"
      style:line-height="1.1em"
      style:font-family="'Noto Sans JP', sans-serif"
      autofocus
    ></textarea>
  {:else}
    <div
      class="text-container h-full w-full cursor-text overflow-hidden p-1 text-black"
      class:bg-white={isSelected}
      class:bg-opacity-80={isSelected}
      onclick={handleTextClick}
      role="button"
      tabindex="-1"
      style:font-size="{block.font_size}px"
      style:line-height="1.1em"
      style:font-family="'Noto Sans JP', sans-serif"
    >
      {#each block.lines as line}
        <p class="m-0 leading-tight">{line}</p>
      {/each}
    </div>
  {/if}

  {#if isSelected}
    <!-- Move Handle (Top-Left) -->
    <button
      class="handle handle-move"
      onmousedown={handleMoveStart}
      title="Move"
      aria-label="Move box"
    >
      <ExpandOutline class="h-4 w-4 rotate-45" />
    </button>

    <!-- Delete Handle (Top-Right) -->
    <button
      class="handle handle-delete"
      onclick={handleDelete}
      title="Delete"
      aria-label="Delete box"
    >
      <TrashBinSolid class="h-3 w-3" />
    </button>

    <!-- Clone Handle (Bottom-Left) -->
    <button
      class="handle handle-clone"
      onmousedown={handleClone}
      title="Clone (drag to place)"
      aria-label="Clone box"
    >
      <FileCopySolid class="h-3 w-3" />
    </button>

    <!-- Resize Handle (Bottom-Right) -->
    <button
      class="handle handle-resize"
      onmousedown={handleResizeStart}
      title="Resize (auto-sizes font)"
      aria-label="Resize box"
    >
      <ArrowUpRightDownLeftOutline class="h-4 w-4 rotate-90" />
    </button>
  {/if}
</div>

<style>
  .handle {
    position: absolute;
    width: 28px;
    height: 28px;
    background: white;
    border: 2px solid #3b82f6;
    border-radius: 6px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    transition: all 0.2s;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
  }

  .handle:hover {
    transform: scale(1.1);
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
  }

  .handle-move {
    top: -14px;
    left: -14px;
    cursor: move;
    color: #3b82f6;
  }

  .handle-delete {
    top: -14px;
    right: -14px;
    cursor: pointer;
    background: #ef4444;
    color: white;
    border-color: #dc2626;
  }

  .handle-clone {
    bottom: -14px;
    left: -14px;
    cursor: copy;
    background: #10b981;
    color: white;
    border-color: #059669;
  }

  .handle-resize {
    bottom: -14px;
    right: -14px;
    cursor: nwse-resize;
    color: #3b82f6;
  }
</style>
