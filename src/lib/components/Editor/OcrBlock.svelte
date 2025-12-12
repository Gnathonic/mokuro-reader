<script lang="ts">
  import { tick } from 'svelte';
  import type { Block } from '$lib/types';
  import { getImageDeltas, smartResizeFont } from '$lib/util/ocrMath';
  import type { OcrState } from '$lib/states/OcrState.svelte';

  import OcrLine from './OcrLine.svelte';
  import ResizeHandles from './ResizeHandles.svelte';
  import TouchToggle from '$lib/components/TouchToggle.svelte';

  // --- Props ---
  let { block, ocrState, onDelete } = $props<{
    block: Block;
    ocrState: OcrState;
    onDelete: () => void;
  }>();

  // --- Local State ---
  let isHovered = $state(false);
  let blockElement: HTMLDivElement | undefined = $state();

  // Registry of child line components for focus management
  let lineComponents: Record<number, any> = $state({});

  // handle drag or double click
  let doubleClickTimer: ReturnType<typeof setTimeout> | null = null;
  let isPendingDoubleClick = false;

  // handle resize handle visibility on mobile
  let resizeHandleTimer: ReturnType<typeof setTimeout> | null = null;
  let resizeHandleIsVisible = $state(false);

  // --- Derived Styles ---
  let geometry = $derived.by(() => {
    // Safety check
    if (ocrState.imgWidth === 0 || ocrState.imgHeight === 0) {
      return { left: 0, top: 0, width: 0, height: 0 };
    }

    const x_min = (block.box[0] / ocrState.imgWidth) * 100;
    const y_min = (block.box[1] / ocrState.imgHeight) * 100;
    const width = ((block.box[2] - block.box[0]) / ocrState.imgWidth) * 100;
    const height = ((block.box[3] - block.box[1]) / ocrState.imgHeight) * 100;

    return { x_min, y_min, width, height };
  });

  // --- Interactions ---

  // 1. Block Drag
  const handleBlockDragStart = (startEvent: PointerEvent) => {
    ocrState.setFocus(block); // Select box
    if (isPendingDoubleClick) {
      // put whatever future doubleclick handling here
      startEvent.stopPropagation();
      return;
    }

    isPendingDoubleClick = true;
    if (doubleClickTimer) {
      clearTimeout(doubleClickTimer);
    }

    doubleClickTimer = setTimeout(() => {
      isPendingDoubleClick = false;
      doubleClickTimer = null;
    }, 300);

    // Make handle visible on touch devices
    if (startEvent.pointerType !== 'mouse') {
      resizeHandleIsVisible = true;
      if (resizeHandleTimer) {
        clearTimeout(resizeHandleTimer);
      }
      resizeHandleTimer = setTimeout(() => {
        resizeHandleIsVisible = false;
        resizeHandleTimer = null;
      }, 1000);
    }

    // Mode check: If user drags a block, switch to layout (BOX) mode
    if (ocrState.ocrMode === 'TEXT') ocrState.setMode('BOX');
    if (!ocrState.overlayElement || !blockElement) return;

    startEvent.preventDefault();
    startEvent.stopPropagation();

    let totalScreenDeltaX = 0;
    let totalScreenDeltaY = 0;
    let totalImageDeltaX = 0;
    let totalImageDeltaY = 0;

    let lastX = startEvent.clientX;
    let lastY = startEvent.clientY;

    const handleDragMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - lastX;
      const deltaY = moveEvent.clientY - lastY;
      lastX = moveEvent.clientX;
      lastY = moveEvent.clientY;

      // 1. Visual Update (Screen Space)
      const currentZoom = ocrState.currentScale;
      totalScreenDeltaX += deltaX / currentZoom;
      totalScreenDeltaY += deltaY / currentZoom;

      if (blockElement) {
        blockElement.style.transform = `translate(${totalScreenDeltaX}px, ${totalScreenDeltaY}px)`;
      }

      // 2. Data Calculation (Image Space)
      const { imageDeltaX, imageDeltaY } = getImageDeltas(
        { movementX: deltaX, movementY: deltaY },
        ocrState.overlayElement!,
        ocrState.imgWidth,
        ocrState.imgHeight
      );
      totalImageDeltaX += imageDeltaX;
      totalImageDeltaY += imageDeltaY;
    };

    const handleDragEnd = () => {
      window.removeEventListener('pointermove', handleDragMove);
      window.removeEventListener('pointerup', handleDragEnd);

      // Reset Transform
      if (blockElement) {
        blockElement.style.transform = '';
      }

      // If drag time is too short, it's probably a double click.
      if (isPendingDoubleClick) return;

      // Commit Data Changes
      const box = block.box; // circumvent mutation warning
      box[0] += totalImageDeltaX;
      box[1] += totalImageDeltaY;
      box[2] += totalImageDeltaX;
      box[3] += totalImageDeltaY;

      // Update Children
      for (const lineCoords of block.lines_coords) {
        for (const coord of lineCoords) {
          coord[0] += totalImageDeltaX;
          coord[1] += totalImageDeltaY;
        }
      }

      ocrState.markDirty();
    };

    window.addEventListener('pointermove', handleDragMove);
    window.addEventListener('pointerup', handleDragEnd);
  };

  // 2. Block Resize
  const handleResizeStart = (startEvent: PointerEvent, handleType: string) => {
    if (ocrState.ocrMode !== 'BOX' || !ocrState.overlayElement) return;
    startEvent.preventDefault();
    startEvent.stopPropagation();

    let lastX = startEvent.clientX;
    let lastY = startEvent.clientY;

    const handleDragMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - lastX;
      const deltaY = moveEvent.clientY - lastY;
      lastX = moveEvent.clientX;
      lastY = moveEvent.clientY;

      const { imageDeltaX, imageDeltaY } = getImageDeltas(
        { movementX: deltaX, movementY: deltaY },
        ocrState.overlayElement!,
        ocrState.imgWidth,
        ocrState.imgHeight
      );

      const box = block.box;
      switch (handleType) {
        case 'top-left':
          box[0] += imageDeltaX;
          box[1] += imageDeltaY;
          break;
        case 'top-center':
          box[1] += imageDeltaY;
          break;
        case 'top-right':
          box[2] += imageDeltaX;
          box[1] += imageDeltaY;
          break;
        case 'middle-left':
          box[0] += imageDeltaX;
          break;
        case 'middle-right':
          box[2] += imageDeltaX;
          break;
        case 'bottom-left':
          box[0] += imageDeltaX;
          box[3] += imageDeltaY;
          break;
        case 'bottom-center':
          box[3] += imageDeltaY;
          break;
        case 'bottom-right':
          box[2] += imageDeltaX;
          box[3] += imageDeltaY;
          break;
      }
    };

    const handleDragEnd = () => {
      window.removeEventListener('pointermove', handleDragMove);
      window.removeEventListener('pointerup', handleDragEnd);
      ocrState.markDirty();
    };

    window.addEventListener('pointermove', handleDragMove);
    window.addEventListener('pointerup', handleDragEnd);
  };

  // 3. Child Line Actions (Bubbled Up)

  const handleSplit = async (index: number, textBefore: string, textAfter: string) => {
    // 1. Update current line
    block.lines[index] = textBefore;

    // 2. Calculate Geometry for new line (Simple heuristic: place below or next to)
    const GAP = 2;
    const oldCoords = block.lines_coords[index];
    const width = oldCoords[1][0] - oldCoords[0][0];
    const height = oldCoords[3][1] - oldCoords[0][1];

    let newX = oldCoords[0][0];
    let newY = oldCoords[0][1];

    if (block.vertical) {
      // Assuming RTL for vertical typically, but let's just stick to "next to it"
      newX = oldCoords[0][0] - width - GAP;
    } else {
      newY = oldCoords[0][1] + height + GAP;
    }

    const newCoords: [[number, number], [number, number], [number, number], [number, number]] = [
      [newX, newY],
      [newX + width, newY],
      [newX + width, newY + height],
      [newX, newY + height]
    ];

    // 3. Insert new data
    block.lines.splice(index + 1, 0, textAfter);
    block.lines_coords.splice(index + 1, 0, newCoords);

    ocrState.markDirty();
    await tick();

    // 4. Focus new line
    lineComponents[index + 1]?.focus();
  };

  const handleMerge = async (index: number, text: string) => {
    if (index === 0) return;

    // 1. Capture length for caret position
    const prevLength = block.lines[index - 1].length;

    // 2. Perform Data Merge
    block.lines[index - 1] += text;
    block.lines.splice(index, 1);
    block.lines_coords.splice(index, 1);

    ocrState.markDirty();
    await tick();

    // 3. Focus and Set Caret
    const prevComponent = lineComponents[index - 1];
    if (prevComponent) {
      prevComponent.focus();
      prevComponent.setCaret(prevLength);
    }
  };

  const handleNavigate = (
    e: KeyboardEvent,
    index: number,
    dir: 'up' | 'down' | 'left' | 'right',
    offset: number
  ) => {
    let targetIndex = -1;

    if (!block.vertical) {
      if (dir === 'up') targetIndex = index - 1;
      if (dir === 'down') targetIndex = index + 1;
    } else {
      if (dir === 'left') targetIndex = index + 1;
      if (dir === 'right') targetIndex = index - 1;
    }

    if (targetIndex < 0 || targetIndex >= block.lines.length) return;
    e.preventDefault();
    const targetComponent = lineComponents[targetIndex];
    const targetLineLength = block.lines[targetIndex].length;
    const clampedOffset = Math.min(offset, targetLineLength);
    targetComponent?.setCaret(clampedOffset);
  };

  const handleSmartResize = (targetElement: HTMLElement) => {
    smartResizeFont(block, targetElement, ocrState.imgWidth, ocrState.fontScale);
    ocrState.markDirty();
  };

  // 4. Block-Level Mutations
  const toggleVertical = () => {
    block.vertical = !block.vertical;
    ocrState.markDirty();
  };

  const deleteLine = (index: number) => {
    if (block.lines.length <= 1) {
      // If it's the last line, delete the whole block
      onDelete();
    } else {
      block.lines.splice(index, 1);
      block.lines_coords.splice(index, 1);
      ocrState.markDirty();
    }
  };

  const handleWindowKeydown = (e: KeyboardEvent) => {
    if (!isHovered) return;
    // Selection logic removed as it's less critical for the editor port right now
    // and simplifies dependencies
  };
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<div
  class="group/block absolute transition-shadow"
  style:left="{geometry.x_min}%"
  style:top="{geometry.y_min}%"
  style:width="{geometry.width}%"
  style:height="{geometry.height}%"
  style:pointer-events="auto"
  bind:this={blockElement}
  onmouseenter={() => (isHovered = true)}
  onmouseleave={() => (isHovered = false)}
  onpointerdown={handleBlockDragStart}
  role="textbox"
  tabindex="-1"
>
  {#if ocrState.ocrMode === 'BOX'}
    <ResizeHandles
      variant="block"
      forceVisible={resizeHandleIsVisible}
      onResizeStart={handleResizeStart}
    />
  {/if}

  <TouchToggle
    class="relative h-full w-full"
    forceVisible={ocrState.ocrMode === 'BOX' ||
      (ocrState.ocrMode === 'TEXT' && ocrState.focusedBlock === block)}
  >
    {#snippet trigger()}
      <div
        class="absolute top-0 left-0 z-1 h-full w-full border transition-opacity"
        class:border-green-500={ocrState.showTriggerOutline}
        class:border-transparent={!ocrState.showTriggerOutline}
      ></div>
    {/snippet}

    <div
      class="relative h-full w-full p-0"
      class:vertical-text={block.vertical}
      class:bg-transparent={ocrState.ocrMode === 'BOX'}
      class:bg-white={ocrState.ocrMode !== 'BOX' && ocrState.ocrMode !== 'TEXT'}
    >
      {#each block.lines as line, i}
        <OcrLine
          bind:this={lineComponents[i]}
          line={block.lines[i]}
          coords={block.lines_coords[i]}
          lineIndex={i}
          blockBox={block.box}
          isVertical={block.vertical ?? false}
          fontSize={block.font_size ?? 12}
          {ocrState}
          onSplit={handleSplit}
          onMerge={handleMerge}
          onNavigate={handleNavigate}
          onSmartResizeRequest={handleSmartResize}
          onFocusRequest={(el) => {
            ocrState.setFocus(block);
          }}
          onLineChange={(newText) => {
            // This function is necessary because block.lines[i] is passed by value
            const line = block.lines; // circumvent warning
            line[i] = newText;
            /* Note: ocrState.markDirty() is called by the Line component */
          }}
          onCoordChange={(newCoords) => {
            const coords = block.lines_coords[i];
            for (let j = 0; j < coords.length; j++) {
              const coord = coords[j];
              coord[0] = newCoords[j][0];
              coord[1] = newCoords[j][1];
            }
          }}
          onDeleteRequest={() => deleteLine(i)}
          onToggleVerticalRequest={toggleVertical}
          onReorderRequest={() => {
            /* reorder logic disabled for initial port */
          }}
        />
      {/each}
    </div>
  </TouchToggle>
</div>

<style>
  .vertical-text {
    writing-mode: vertical-rl;
    text-orientation: mixed;
    font-feature-settings:
      'vhal' 1,
      'locl' 1;
  }
</style>
