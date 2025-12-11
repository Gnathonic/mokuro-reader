<script lang="ts">
  import { getImageDeltas, ligaturize } from '$lib/util/ocrMath';
  import ResizeHandles from './ResizeHandles.svelte';
  import type { OcrState } from '$lib/states/OcrState.svelte';

  // --- Props ---
  let {
    line,
    coords,
    lineIndex,
    // Context
    blockBox,
    isVertical,
    fontSize,
    // State Object
    ocrState,
    // Callbacks
    onSplit,
    onMerge,
    onNavigate,
    onSmartResizeRequest,
    onFocusRequest,
    onLineChange,
    onCoordChange,
    onDeleteRequest,
    onToggleVerticalRequest,
    onReorderRequest
  } = $props<{
    line: string;
    coords: [[number, number], [number, number], [number, number], [number, number]];
    lineIndex: number;
    blockBox: [number, number, number, number];
    isVertical: boolean;
    fontSize: number;
    ocrState: OcrState;
    onSplit: (index: number, textBefore: string, textAfter: string) => void;
    onMerge: (index: number, text: string) => void;
    onNavigate: (
      event: KeyboardEvent,
      index: number,
      direction: 'up' | 'down' | 'left' | 'right',
      offset: number
    ) => void;
    onSmartResizeRequest: (targetElement: HTMLElement) => void;
    onFocusRequest: (targetElement: HTMLElement) => void;
    onLineChange: (newText: string) => void;
    onCoordChange: (
      newCoords: [[number, number], [number, number], [number, number], [number, number]]
    ) => void;
    onDeleteRequest: () => void;
    onToggleVerticalRequest: () => void;
    onReorderRequest: () => void;
  }>();

  let lineElement: HTMLElement | undefined = $state();
  let textHoldingElement: HTMLElement | undefined = $state();
  let isEmpty = $state(line === '');
  let DPR: number | undefined = $state();
  let finalFontSize = $derived((ocrState.fontScale / (DPR ?? 1)) * fontSize);

  // handle drag or double click
  let doubleClickTimer: ReturnType<typeof setTimeout> | null = null;
  let isPendingDoubleClick = false;

  // handle resize handle visibility on mobile
  let resizeHandleTimer: ReturnType<typeof setTimeout> | null = null;
  let resizeHandleIsVisible = $state(false);

  // Clipboard Logic
  const handleClipboardAction = async (command: 'cut' | 'copy' | 'paste') => {
    // Early returns for validation
    if (!lineElement && !textHoldingElement) return;
    const target = (lineElement ?? textHoldingElement) as HTMLElement;
    target.focus();

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    const selectedText = selection.toString();

    // Try modern Clipboard API first
    if (navigator.clipboard) {
      try {
        if (command === 'copy') {
          await navigator.clipboard.writeText(selectedText);
        } else if (command === 'cut') {
          await navigator.clipboard.writeText(selectedText);
          selection.deleteFromDocument();
          // manually trigger input handling
          handleInput();
        } else if (command === 'paste') {
          const text = await navigator.clipboard.readText();
          if (!text) return;

          const range = selection.getRangeAt(0);
          range.deleteContents();
          range.insertNode(document.createTextNode(text));

          // move carat to end
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
          // manually trigger input handling
          handleInput();
        }
      } catch (err) {
        console.warn(`Clipboard API failed, trying execCommand:`, err);
        // Fall through to execCommand
      }
      return;
    }

    // Fallback to execCommand (HTTP contexts only)
    if (command === 'paste') {
      console.warn('Paste requires HTTPS/localhost. Use Ctrl+V.');
      return;
    }

    try {
      const success = document.execCommand(command);
      if (success && command === 'cut') handleInput();
      if (!success) console.error(`execCommand ${command} failed`);
    } catch (err) {
      console.error(`execCommand ${command} error:`, err);
    }
  };

  const handleInput = () => {
    isEmpty = textHoldingElement?.textContent === '';
    if (ocrState.isSmartResizeMode && textHoldingElement && textHoldingElement.textContent !== '')
      onSmartResizeRequest(textHoldingElement);

    // Sync local -> parent (upsync)
    let innerText = textHoldingElement?.innerText ?? '';
    onLineChange(innerText);
    ocrState.markDirty();
  };

  // --- Derived Geometry ---
  let relativeStyles = $derived.by(() => {
    const blockW = blockBox[2] - blockBox[0];
    const blockH = blockBox[3] - blockBox[1];

    // Safety check to avoid division by zero if block has 0 size
    if (blockW === 0 || blockH === 0) return { left: 0, top: 0, width: 0, height: 0 };

    const x_min = ((coords[0][0] - blockBox[0]) / blockW) * 100;
    const y_min = ((coords[0][1] - blockBox[1]) / blockH) * 100;
    const x_max = ((coords[2][0] - blockBox[0]) / blockW) * 100;
    const y_max = ((coords[2][1] - blockBox[1]) / blockH) * 100;

    return {
      left: x_min,
      top: y_min,
      width: x_max - x_min,
      height: y_max - y_min
    };
  });

  // --- Actions ---

  const handleDoubleClick = (event: MouseEvent) => {
    // 1. Prioritize DBLCLICK action
    ocrState.setMode('TEXT');
    onFocusRequest(event.currentTarget as HTMLElement);

    // 2. Crucial State Reset & Drag Prevention
    if (doubleClickTimer) {
      clearTimeout(doubleClickTimer);
    }
    isPendingDoubleClick = false;

    event.stopPropagation();
  };

  const handleDragStart = (startEvent: PointerEvent) => {
    onFocusRequest(startEvent.currentTarget as HTMLElement); // focus block on first click

    // Double click hybrid handling
    if (isPendingDoubleClick) {
      handleDoubleClick(startEvent);
      startEvent.stopPropagation();
      return;
    }

    // If this is the start of a new interaction, set the double-click timer.
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

    // Actual handle drag start
    if (ocrState.ocrMode === 'TEXT') ocrState.setMode('BOX');
    if (!ocrState.overlayElement || !lineElement) return;
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

      // 1. Visual Update
      const currentZoom = ocrState.currentScale;
      totalScreenDeltaX += deltaX / currentZoom / devicePixelRatio;
      totalScreenDeltaY += deltaY / currentZoom / devicePixelRatio;

      if (lineElement) {
        lineElement.style.transform = `translate(${totalScreenDeltaX}px, ${totalScreenDeltaY}px)`;
      }

      // 2. Data Calculation
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

      if (lineElement) {
        lineElement.style.transform = '';
      }

      // If drag time is too short, it's probably a double click.
      if (isPendingDoubleClick) return;

      // Commit
      const localCoords = JSON.parse(JSON.stringify(coords));
      for (const coord of localCoords) {
        coord[0] += totalImageDeltaX;
        coord[1] += totalImageDeltaY;
      }
      onCoordChange(localCoords);

      ocrState.markDirty();
    };

    window.addEventListener('pointermove', handleDragMove);
    window.addEventListener('pointerup', handleDragEnd);
  };

  const handleResizeStart = (startEvent: PointerEvent, handleType: string) => {
    if (ocrState.ocrMode !== 'BOX' || !ocrState.overlayElement) return;
    startEvent.preventDefault();
    startEvent.stopPropagation();

    // 1. Snapshot Initial State
    const localCoords = JSON.parse(JSON.stringify(coords));
    const blockW = blockBox[2] - blockBox[0];
    const blockH = blockBox[3] - blockBox[1];

    let lastX = startEvent.clientX;
    let lastY = startEvent.clientY;

    const handleDragMove = (moveEvent: PointerEvent) => {
      // Type changed to PointerEvent for consistency
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

      // 2. Update Local Coordinates (Math Only)
      switch (handleType) {
        case 'top-left':
          localCoords[0][0] += imageDeltaX;
          localCoords[0][1] += imageDeltaY;
          localCoords[1][1] += imageDeltaY;
          localCoords[3][0] += imageDeltaX;
          break;
        case 'top-center':
          localCoords[0][1] += imageDeltaY;
          localCoords[1][1] += imageDeltaY;
          break;
        case 'top-right':
          localCoords[1][0] += imageDeltaX;
          localCoords[1][1] += imageDeltaY;
          localCoords[0][1] += imageDeltaY;
          localCoords[2][0] += imageDeltaX;
          break;
        case 'middle-left':
          localCoords[0][0] += imageDeltaX;
          localCoords[3][0] += imageDeltaX;
          break;
        case 'middle-right':
          localCoords[1][0] += imageDeltaX;
          localCoords[2][0] += imageDeltaX;
          break;
        case 'bottom-left':
          localCoords[3][0] += imageDeltaX;
          localCoords[3][1] += imageDeltaY;
          localCoords[0][0] += imageDeltaX;
          localCoords[2][1] += imageDeltaY;
          break;
        case 'bottom-center':
          localCoords[2][1] += imageDeltaY;
          localCoords[3][1] += imageDeltaY;
          break;
        case 'bottom-right':
          localCoords[2][0] += imageDeltaX;
          localCoords[2][1] += imageDeltaY;
          localCoords[1][0] += imageDeltaX;
          localCoords[3][1] += imageDeltaY;
          break;
      }

      // 3. Visual Update (Direct DOM Style)
      if (lineElement && blockW > 0 && blockH > 0) {
        const x_min = ((localCoords[0][0] - blockBox[0]) / blockW) * 100;
        const y_min = ((localCoords[0][1] - blockBox[1]) / blockH) * 100;
        const x_max = ((localCoords[2][0] - blockBox[0]) / blockW) * 100;
        const y_max = ((localCoords[2][1] - blockBox[1]) / blockH) * 100;

        lineElement.style.left = `${x_min}%`;
        lineElement.style.top = `${y_min}%`;
        lineElement.style.width = `${x_max - x_min}%`;
        lineElement.style.height = `${y_max - y_min}%`;
      }

      if (ocrState.isSmartResizeMode && textHoldingElement) {
        onSmartResizeRequest(textHoldingElement);
      }
    };

    const handleDragEnd = () => {
      window.removeEventListener('pointermove', handleDragMove);
      window.removeEventListener('pointerup', handleDragEnd);

      onCoordChange(localCoords);
      ocrState.markDirty();

      if (ocrState.isSmartResizeMode && textHoldingElement) {
        onSmartResizeRequest(textHoldingElement);
      }
    };

    window.addEventListener('pointermove', handleDragMove);
    window.addEventListener('pointerup', handleDragEnd);
  };

  // --- Text Interaction ---
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key.startsWith('Arrow')) {
      e.stopPropagation();
      const selection = window.getSelection();
      const offset = selection?.anchorOffset ?? 0;
      let dir: 'up' | 'down' | 'left' | 'right' | null = null;
      if (e.key === 'ArrowUp') dir = 'up';
      if (e.key === 'ArrowDown') dir = 'down';
      if (e.key === 'ArrowLeft') dir = 'left';
      if (e.key === 'ArrowRight') dir = 'right';

      if (dir) {
        onNavigate(e, lineIndex, dir, offset);
      }
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      const selection = window.getSelection();
      if (!selection) return;
      const offset = selection.anchorOffset;
      const textBefore = line.substring(0, offset);
      const textAfter = line.substring(offset);
      onSplit(lineIndex, textBefore, textAfter);
    }

    if (e.key === 'Backspace') {
      const selection = window.getSelection();
      if (selection && selection.anchorOffset === 0 && lineIndex > 0) {
        e.preventDefault();
        onMerge(lineIndex, line);
      }
    }
  };

  export const focus = () => {
    if (textHoldingElement) textHoldingElement.focus();
  };

  export const setCaret = (offset: number) => {
    if (!textHoldingElement) return;

    // Make sure we have focus first
    textHoldingElement.focus();

    const textNode = textHoldingElement.firstChild;
    const selection = window.getSelection();

    if (textNode && selection) {
      try {
        selection.removeAllRanges();
        selection.collapse(textNode, offset);
      } catch (e) {
        console.warn('Failed to set caret', e);
      }
    }
  };
</script>

<svelte:window bind:devicePixelRatio={DPR} />

{#if ocrState.ocrMode === 'BOX'}
  <div
    bind:this={lineElement}
    class="group/line absolute z-2 border border-red-500/50 bg-[rgba(239,128,128,0.7)] transition-colors"
    style:left="{relativeStyles.left}%"
    style:top="{relativeStyles.top}%"
    style:width="{relativeStyles.width}%"
    style:height="{relativeStyles.height}%"
    role="button"
    tabindex="-1"
    onpointerdown={handleDragStart}
    oncontextmenu={(e) => {
      e.preventDefault();
      e.stopPropagation();
    }}
  >
    <ResizeHandles
      variant="line"
      forceVisible={resizeHandleIsVisible}
      onResizeStart={handleResizeStart}
    />
    <div
      bind:this={textHoldingElement}
      class="ocr-line-text pointer-events-none h-fit w-fit whitespace-nowrap"
      class:vertical-text={isVertical}
      style:font-size="{finalFontSize}px"
    >
      {ligaturize(line)}
    </div>
  </div>
{:else if ocrState.ocrMode === 'TEXT'}
  <div
    bind:this={lineElement}
    class="absolute z-2 border border-red-500/70 bg-[rgba(239,128,128,0.85)]"
    style:left="{relativeStyles.left}%"
    style:top="{relativeStyles.top}%"
    style:width="{relativeStyles.width}%"
    style:height="{relativeStyles.height}%"
    onpointerdown={handleDragStart}
    role="button"
    tabindex="-1"
  >
    <div
      bind:this={textHoldingElement}
      contenteditable="true"
      role="textbox"
      tabindex="0"
      class="{isEmpty
        ? 'h-full w-full'
        : 'h-fit w-fit'} bg-blue ocr-line-text m-0 p-0 leading-none whitespace-nowrap outline-none"
      class:vertical-text={isVertical}
      style:cursor={isVertical ? 'vertical-text' : 'text'}
      style:font-size="{finalFontSize}px"
      bind:innerText={line}
      onpointerdown={(e) => e.stopPropagation()}
      onkeydown={handleKeyDown}
      oninput={handleInput}
      onfocus={(e) => {
        onFocusRequest(e.currentTarget as HTMLElement);
        if (
          ocrState.isSmartResizeMode &&
          textHoldingElement &&
          textHoldingElement.textContent !== ''
        )
          onSmartResizeRequest(textHoldingElement);
      }}
      data-line-index={lineIndex}
    ></div>
  </div>
{:else}
  <!-- READ Mode is effectively removed/fallback, but just in case -->
  <span
    class="ocr-line-text pointer-events-auto relative z-3 m-0 inline-flex items-center border border-transparent p-0 align-top leading-none"
    class:vertical-text={isVertical}
    style:left="{isVertical
      ? -100 + relativeStyles.width + relativeStyles.left
      : relativeStyles.width + relativeStyles.left}%"
    style:top="{relativeStyles.top}%"
    style:width="{relativeStyles.width}%"
    style:height="{relativeStyles.height}%"
    style:margin-bottom="-{isVertical ? relativeStyles.height : 0}%"
    style:margin-left="-{isVertical ? 0 : relativeStyles.width}%"
    style:font-size="{finalFontSize}px"
    style:border-color={ocrState.isSmartResizeMode ? 'red' : 'transparent'}
    style:cursor={isVertical ? 'vertical-text' : 'text'}
    role="button"
    tabindex="-1"
  >
    {ligaturize(line)}
  </span>
{/if}

<style>
  .ocr-line-text {
    color: black;
    font-weight: 500;
    white-space: nowrap;
    user-select: text;

    /* Ensure a high-quality CJK font is used */
    font-family: 'Source Han Serif JP', 'Noto Sans JP', sans-serif;
    line-height: 1;
  }
</style>
