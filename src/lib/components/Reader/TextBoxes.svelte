<script lang="ts">
  import { clamp, promptConfirmation } from '$lib/util';
  import type { Page } from '$lib/types';
  import { settings, volumes } from '$lib/settings';
  import {
    showCropper,
    openCreateModal,
    openUpdateModal,
    expandTextBoxBounds,
    sendQuickCapture,
    getLastCardInfo,
    getCardAgeInMin,
    extractFieldValues,
    getModelConfig,
    blobToBase64,
    type VolumeMetadata
  } from '$lib/anki-connect';
  import { db } from '$lib/catalog/db';
  import {
    layoutLines,
    getDefaultMeasurer,
    processLine,
    type LineLayout
  } from '$lib/reader/line-coords-layout';
  import { lineTransform } from '$lib/reader/line-grid';
  import { dedupeBlocks } from '$lib/reader/block-dedupe';

  interface ContextMenuData {
    x: number;
    y: number;
    lines: string[];
    imgElement: HTMLElement | null;
    textBox?: [number, number, number, number]; // [xmin, ymin, xmax, ymax] for initial crop
    pageIndex?: number;
    /** Index into page.blocks — lets the reader open the editor on this box. */
    blockIndex?: number;
  }

  interface Props {
    page: Page;
    src?: File;
    volumeUuid: string;
    /** 0-based page index within the volume */
    pageIndex?: number;
    /** Force text visibility (for placeholder/missing pages) */
    forceVisible?: boolean;
    /** Callback when context menu should be shown */
    onContextMenu?: (data: ContextMenuData) => void;
  }

  let { page, src, volumeUuid, pageIndex, forceVisible = false, onContextMenu }: Props = $props();

  interface TextBoxData {
    left: string;
    top: string;
    width: string;
    height: string;
    fontSize: string;
    writingMode: string;
    lines: string[];
    area: number;
    useMinDimensions: boolean;
    isOriginalMode: boolean;
    /** Per-line positions/sizes from lines_coords — auto mode (fitted sizes)
     * and original mode (the file's size); null (no usable quads) falls back
     * to legacy hover-fit auto / whole-block original */
    lineLayouts: LineLayout[] | null;
    /** Changes whenever a line's flow size or target can have: re-measure */
    layoutSignature: string;
    blockIndex: number; // Original index in page.blocks
  }

  let textBoxes = $derived(
    dedupeBlocks(page.blocks)
      .map(({ block, blockIndex }) => {
        const { img_height, img_width } = page;
        const { box, font_size, lines, vertical } = block;

        let [_xmin, _ymin, _xmax, _ymax] = box;

        // Replace manual ellipsis with proper ellipsis character (…)
        // Handle both ASCII periods (...) and full-width periods (．．．).
        const processedLines = lines.map(processLine);

        const isOriginalMode = $settings.fontSize === 'original';
        const isAutoMode = $settings.fontSize === 'auto';

        // Auto mode: derive per-line position/size from the OCR line quads.
        // mokuro's block font_size overstates the true character size (it is
        // the quad width, furigana included), so rendering it as-is overflows
        // the box; the quads themselves are accurate. Null (no lines_coords,
        // e.g. pre-lines_coords imports) → legacy hover-fit auto below.
        // Japanese print is fixed-pitch, so every line sits on the grid of its
        // block's pitch — one plain text node, the grid as letter-spacing, a
        // tilted quad as a rotation (line-grid.ts). No span per character: the
        // lightest DOM, and the one Yomitan/Migaku are safest with.
        let lineLayouts = isAutoMode
          ? layoutLines(block, processedLines, getDefaultMeasurer())
          : null;

        // Original mode is "what the file says": the file's PLACEMENT at the
        // file's SIZE. The placement is the line quads — so every line goes on
        // its quad exactly as in auto (frame, the block's pitch grid, ink
        // insets, a tilted quad turned) — and the size is the block's
        // font_size instead of a fitted one, with nothing wrapped, clipped or
        // moved to make that size fit (`size: 'file'`). It used to ignore the
        // quads and flow the block as one upright paragraph, which left a
        // file whose lines are rotated looking nothing like what it says.
        //
        // Where the file contradicts ITSELF the quads win: mokuro's font_size
        // is the quad's thickness, ruby and mask slack included (median +20%,
        // p95 2×), and at that size on the file's real pitch the glyphs draw
        // on top of each other. So the block's size is its font_size capped by
        // what its lines can carry (spacing never under −0.05em, never much
        // thicker than the quad — `fileLineSizes`), still ONE size per block.
        // Only a block without usable quads (volumes from before mokuro wrote
        // lines_coords) keeps the whole-block paragraph: there is nothing to
        // place its lines on.
        if (isOriginalMode) {
          lineLayouts = layoutLines(block, processedLines, getDefaultMeasurer(), { size: 'file' });
        }

        // Only expand bounding boxes for legacy hover-fit auto sizing;
        // per-line layout and manual font sizes use exact OCR bounding boxes
        let xmin, ymin, xmax, ymax;

        if (isAutoMode && !lineLayouts) {
          // Expand bounding box by 10% (5% on each side) to give text more room
          const originalWidth = _xmax - _xmin;
          const originalHeight = _ymax - _ymin;
          const expansionX = originalWidth * 0.05;
          const expansionY = originalHeight * 0.05;

          xmin = clamp(_xmin - expansionX, 0, img_width);
          ymin = clamp(_ymin - expansionY, 0, img_height);
          xmax = clamp(_xmax + expansionX, 0, img_width);
          ymax = clamp(_ymax + expansionY, 0, img_height);
        } else {
          xmin = _xmin;
          ymin = _ymin;
          xmax = _xmax;
          ymax = _ymax;
        }

        const width = xmax - xmin;
        const height = ymax - ymin;
        const area = width * height;

        // Determine font size based on setting
        let fontSize: string;
        if ($settings.fontSize === 'auto' || $settings.fontSize === 'original') {
          fontSize = `${font_size}px`;
        } else {
          fontSize = `${$settings.fontSize}pt`;
        }

        const textBox: TextBoxData = {
          left: `${xmin}px`,
          top: `${ymin}px`,
          width: `${width}px`,
          height: `${height}px`,
          fontSize,
          writingMode: vertical ? 'vertical-rl' : 'horizontal-tb',
          lines: processedLines,
          area,
          useMinDimensions: $settings.fontSize !== 'auto' && !isOriginalMode,
          isOriginalMode,
          lineLayouts,
          // Everything a span's natural origin, its size or its target depends
          // on — letter-spacing changes the span's extent, and a rotated line
          // is centred in its own-frame box.
          layoutSignature: lineLayouts
            ? lineLayouts
                .map((l, i) =>
                  l.hidden
                    ? ''
                    : `${l.left},${l.top},${l.fontSize},${processedLines[i].length}` +
                      (l.letterSpacing || l.inset ? `,s${l.letterSpacing},${l.inset}` : '') +
                      (l.rotation ? `,r${l.rotation},${l.width},${l.height}` : '')
                )
                .join('|')
            : '',
          blockIndex
        };

        return textBox;
      })
      .sort(({ area: a }, { area: b }) => {
        return b - a;
      })
  );

  let fontWeight = $derived($settings.boldFont ? 'bold' : '400');
  let display = $derived($settings.displayOCR ? 'block' : 'none');
  let alwaysShowOCR = $derived($settings.alwaysShowOCR);
  let border = $derived($settings.textBoxBorders ? '1px solid red' : 'none');

  // Double-tap trigger: enabled if triggerMethod is 'doubleTap' or 'both' (legacy)
  let doubleTapEnabled = $derived(
    $settings.ankiConnectSettings.triggerMethod === 'doubleTap' ||
      $settings.ankiConnectSettings.triggerMethod === 'both'
  );
  let ankiTags = $derived($settings.ankiConnectSettings.tags);
  let cardMode = $derived($settings.ankiConnectSettings.cardMode);
  let volumeMetadata = $derived<VolumeMetadata>({
    seriesTitle: $volumes[volumeUuid]?.series_title,
    volumeTitle: $volumes[volumeUuid]?.volume_title
  });

  // Load volume cover image from DB and add to metadata
  async function getMetadataWithCover(): Promise<VolumeMetadata> {
    try {
      const dbVolume = await db.volumes.get(volumeUuid);
      if (dbVolume?.thumbnail) {
        const coverImage = await blobToBase64(dbVolume.thumbnail);
        if (coverImage) {
          return { ...volumeMetadata, coverImage };
        }
      }
    } catch {
      // Fall through to return metadata without cover
    }
    return volumeMetadata;
  }

  // Track adjusted font sizes for each textbox
  let adjustedFontSizes = $state<Map<number, string>>(new Map());
  // Track which textboxes need word wrapping enabled
  let needsWrapping = $state<Set<number>>(new Set());
  // Track which textboxes have been processed
  let processedTextBoxes = $state<Set<number>>(new Set());

  // Calculate optimal font size for a textbox using binary search
  // Two-phase approach: scale up until overflow, then find the goldilocks size
  function calculateOptimalFontSize(element: HTMLDivElement, initialFontSize: string) {
    // Parse the initial font size to get numeric value
    const match = initialFontSize.match(/(\d+(?:\.\d+)?)(px|pt)/);
    if (!match) return null;

    const originalSize = parseFloat(match[1]);
    const unit = match[2];
    const minFontSize = 8; // Minimum font size in px
    const maxFontSize = 200; // Maximum font size to try when scaling up

    // Convert to px for consistent handling, rounding to integer
    // Integer font sizes ensure the binary search always makes progress
    let originalInPx = Math.round(unit === 'pt' ? originalSize * 1.333 : originalSize);

    // Guard against invalid font sizes that would cause infinite loops
    // (0, negative, NaN, or Infinity would break the binary search)
    if (!Number.isFinite(originalInPx) || originalInPx < minFontSize) {
      originalInPx = minFontSize;
    }

    // Check if content overflows at a given font size
    const isOverflowingAt = (size: number) => {
      element.style.fontSize = `${size}px`;
      return (
        element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth
      );
    };

    // Binary search to find the largest font size that fits
    // Searches between low (fits) and high (overflows or max)
    const findOptimalSize = () => {
      // Phase 1: Find upper bound by scaling up until overflow
      let low = minFontSize;
      let high = originalInPx;

      // If original fits, try scaling up to find the true max
      if (!isOverflowingAt(originalInPx)) {
        // Double until we overflow or hit max
        high = originalInPx;
        while (!isOverflowingAt(high) && high < maxFontSize) {
          low = high;
          high = Math.min(high * 2, maxFontSize);
        }
        // If we're at max and still not overflowing, use max
        if (!isOverflowingAt(high)) {
          return high;
        }
      } else {
        // Original overflows, check if min fits
        if (isOverflowingAt(minFontSize)) {
          return minFontSize;
        }
        low = minFontSize;
        high = originalInPx;
      }

      // Phase 2: Binary search between low (fits) and high (overflows)
      while (high - low > 1) {
        const mid = Math.floor((low + high) / 2);
        if (isOverflowingAt(mid)) {
          high = mid;
        } else {
          low = mid;
        }
      }

      return low;
    };

    // Step 1: Find optimal size without wrapping
    element.style.whiteSpace = 'nowrap';
    element.style.wordWrap = 'normal';
    element.style.overflowWrap = 'normal';
    const noWrapSize = findOptimalSize();

    // Step 2: Only try wrapping if it could give us 1.3x the font size
    // Quick check: would 1.3x the noWrapSize overflow with wrapping?
    element.style.whiteSpace = 'normal';
    element.style.wordWrap = 'break-word';
    element.style.overflowWrap = 'break-word';

    const thresholdSize = noWrapSize * 1.3;
    if (!isOverflowingAt(thresholdSize)) {
      // Wrapping allows at least 1.3x - search for the actual optimal wrap size
      const wrapSize = findOptimalSize();
      return {
        finalSize: wrapSize,
        useWrapping: true,
        originalInPx
      };
    }

    // Wrapping doesn't help enough, use nowrap
    return {
      finalSize: noWrapSize,
      useWrapping: false,
      originalInPx
    };
  }

  // Handle hover event to calculate resize on demand (only for auto font sizing)
  function handleTextBoxHover(element: HTMLDivElement, params: [number, string]) {
    const [index, initialFontSize] = params;

    const calculate = () => {
      // Skip if already processed, OCR is hidden, using manual font size, or
      // the box is laid out per-line from lines_coords (no fitting needed)
      if (
        processedTextBoxes.has(index) ||
        display !== 'block' ||
        $settings.fontSize !== 'auto' ||
        element.classList.contains('perLine')
      )
        return;

      // Mark as processed immediately to prevent duplicate calculations
      processedTextBoxes.add(index);

      // Use requestAnimationFrame to ensure the DOM is fully rendered
      requestAnimationFrame(() => {
        const result = calculateOptimalFontSize(element, initialFontSize);
        if (!result) return;

        const { finalSize, useWrapping, originalInPx } = result;

        // Apply final settings
        if (useWrapping) {
          needsWrapping.add(index);
          element.style.whiteSpace = 'normal';
          element.style.wordWrap = 'break-word';
          element.style.overflowWrap = 'break-word';
        } else {
          element.style.whiteSpace = 'nowrap';
          element.style.wordWrap = 'normal';
          element.style.overflowWrap = 'normal';
        }

        element.style.fontSize = `${finalSize}px`;

        // Store adjusted size if it changed
        if (finalSize < originalInPx) {
          adjustedFontSizes.set(index, `${finalSize}px`);
        }
      });
    };

    element.addEventListener('mouseenter', calculate);
    // touchstart fires before long-press reveals the text box
    element.addEventListener('touchstart', calculate, { passive: true });

    return {
      destroy() {
        element.removeEventListener('mouseenter', calculate);
        element.removeEventListener('touchstart', calculate);
      }
    };
  }

  // Per-line layout (auto mode, and original mode for a block with line
  // quads): each line renders as an inline-block kept in normal
  // flow, so DOM text scanners (Yomitan/Migaku) read the whole block as one
  // continuous run — a per-line `position: absolute` would inject a hard break
  // at every line and split words/sentences across lines (issue #254). We then
  // translate each line onto its lines_coords quad. Measurement is required:
  // an inline element's natural flow position is only knowable after layout.
  //
  // offsetLeft/offsetTop are measured against the .textBox (the span's
  // offsetParent, since the box is position:absolute) and are in image px —
  // zoom is applied as an ancestor transform, so this coordinate space is
  // zoom-invariant. Both offsetLeft and the target `left` reference the box's
  // padding edge, so `target - offsetLeft` is the exact translate.
  //
  // The fixed-pitch grid and rotation ride the same transform (lineTransform):
  // the grid's start inset is added to the translate, and a tilted line
  // is laid into its own-frame box and turned about that box's centre. A
  // transform never takes the span out of flow (#254 holds), and the browser
  // hit-tests the TURNED glyphs — elementFromPoint / caretRangeFromPoint, what
  // Yomitan scans with — so the touch zones follow the slant of the print.
  // offsetLeft/Top/Width/Height are layout values: a transform already on the
  // span does not move them, so a re-measure is idempotent.
  function positionPerLine(container: HTMLDivElement, _signature: string) {
    let raf = 0;

    const apply = () => {
      const spans = container.querySelectorAll<HTMLElement>('.positionedLine');
      if (spans.length === 0) return;
      // display:none box (OCR hidden) → no offsetParent; measurement would read
      // 0. Skip and re-run on reveal (mouseenter/touchstart) or update.
      if (spans[0].offsetParent === null) return;

      // Read every natural box first (one layout), then write every
      // transform (compositor-only, no reflow) — avoids layout thrash.
      const naturals = [...spans].map((span) => ({
        left: span.offsetLeft,
        top: span.offsetTop,
        width: span.offsetWidth,
        height: span.offsetHeight
      }));
      const vertical = container.style.writingMode === 'vertical-rl';

      spans.forEach((span, i) => {
        const { targetLeft, targetTop, inset, rotation, boxWidth, boxHeight } = span.dataset;
        const target = { left: Number(targetLeft), top: Number(targetTop) };
        if (!Number.isFinite(target.left) || !Number.isFinite(target.top)) return;
        const { transform, origin } = lineTransform({
          natural: naturals[i],
          target,
          box: rotation ? { width: Number(boxWidth), height: Number(boxHeight) } : undefined,
          inset: Number(inset) || 0,
          rotation: Number(rotation) || 0,
          vertical
        });
        span.style.transform = transform;
        // '' puts an un-rotated line back on the default (it may have been
        // rotated before an OCR edit straightened its quad)
        span.style.transformOrigin = origin;
      });
    };

    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(apply);
    };

    schedule();
    // Fonts change glyph advance → re-measure once the real font is ready.
    document.fonts?.ready?.then(schedule);
    // Box may have been display:none at mount; catch first reveal.
    container.addEventListener('mouseenter', schedule);
    container.addEventListener('touchstart', schedule, { passive: true });

    return {
      // _signature changes on displayOCR toggle, font-size setting change, or
      // a change to the box's line layout (an OCR edit, a line gaining or
      // losing its character cells, its grid spacing or its rotation) —
      // anything that moves a natural origin or a target.
      update: schedule,
      destroy() {
        cancelAnimationFrame(raf);
        container.removeEventListener('mouseenter', schedule);
        container.removeEventListener('touchstart', schedule);
      }
    };
  }

  function getImageUrlFromElement(element: HTMLElement): string | null {
    // Traverse up to find the MangaPage div with background-image
    let current: HTMLElement | null = element;
    while (current) {
      const bgImage = getComputedStyle(current).backgroundImage;
      if (bgImage && bgImage !== 'none') {
        // Extract URL from "url(...)"
        const match = bgImage.match(/url\(["']?(.+?)["']?\)/);
        if (match) {
          return match[1];
        }
      }
      current = current.parentElement;
    }
    return null;
  }

  function getSelectedText(): string {
    // Get actual selected text from the DOM
    const selection = window.getSelection();
    return selection?.toString().trim() || '';
  }

  async function onUpdateCard(event: Event, lines: string[], blockIndex: number) {
    if (!$settings.ankiConnectSettings.enabled) return;

    const selectedText = getSelectedText();
    const fullSentence = lines.join(' ');

    // Get the original block's bounding box for initial crop
    const block = page.blocks[blockIndex];
    const textBox = block ? expandTextBoxBounds(block, page) : undefined;

    // Get image URL
    const url =
      getImageUrlFromElement(event.target as HTMLElement) ||
      (src ? URL.createObjectURL(src) : null);

    if (!url) return;

    // Get current page number for {page} template
    // Use the explicit pageIndex prop (0-based) when available, otherwise fall back to progress
    const pageNumber = pageIndex != null ? pageIndex + 1 : $volumes[volumeUuid]?.progress || 1;

    // Load cover image for {cover} template support
    const metadataWithCover = await getMetadataWithCover();

    if (cardMode === 'update') {
      // Update mode: fetch previous card values with retry
      const maxRetries = 3;
      let lastCard = null;
      let lastError = '';

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        lastCard = await getLastCardInfo();

        if (!lastCard || !lastCard.noteId) {
          lastError = 'No recent card found to update';
          // Wait before retry (except on last attempt)
          if (attempt < maxRetries - 1) {
            await new Promise((r) => setTimeout(r, 500));
          }
          continue;
        }

        if (!lastCard.modelName) {
          lastError = 'Could not detect card note type';
          // Wait before retry
          if (attempt < maxRetries - 1) {
            await new Promise((r) => setTimeout(r, 500));
          }
          continue;
        }

        // Success - break out of retry loop
        lastError = '';
        break;
      }

      if (lastError || !lastCard?.noteId || !lastCard?.modelName) {
        const { showSnackbar } = await import('$lib/util');
        showSnackbar(`Error: ${lastError || 'Failed to fetch card info'}`);
        return;
      }

      const cardAge = getCardAgeInMin(lastCard.noteId);
      if (cardAge >= 5) {
        // Card too old
        const { showSnackbar } = await import('$lib/util');
        showSnackbar(`Last card is ${cardAge} minutes old (max 5 min)`);
        return;
      }

      const previousValues = extractFieldValues(lastCard);

      // Get the model config to check for quickCapture setting
      const modelConfig = getModelConfig(lastCard.modelName, 'update');
      const hasConfig = !!modelConfig;
      const quickCapture = modelConfig?.quickCapture ?? false;

      if (quickCapture) {
        // Quick capture: send directly without modal
        await sendQuickCapture(
          'update',
          url,
          selectedText || fullSentence,
          fullSentence,
          metadataWithCover,
          textBox,
          previousValues,
          lastCard.noteId,
          lastCard.tags,
          lastCard.modelName,
          page.img_path
        );
      } else {
        // Show modal in update mode - use the card's model name
        // (also shown if quickCapture but no config exists)
        openUpdateModal(
          url,
          previousValues,
          lastCard.noteId,
          lastCard.modelName,
          lastCard.tags, // existing tags from the card
          selectedText || fullSentence,
          fullSentence,
          ankiTags,
          metadataWithCover,
          undefined,
          textBox,
          pageNumber,
          page.img_path
        );
      }
    } else {
      // Create mode
      const { selectedModel } = $settings.ankiConnectSettings;
      const modelConfig = getModelConfig(selectedModel, 'create');
      const quickCapture = modelConfig?.quickCapture ?? false;

      if (quickCapture) {
        await sendQuickCapture(
          'create',
          url,
          selectedText || fullSentence,
          fullSentence,
          metadataWithCover,
          textBox,
          undefined, // previousValues
          undefined, // previousCardId
          undefined, // previousTags
          undefined, // modelName
          page.img_path
        );
      } else {
        // Show modal (also shown if quickCapture but no config exists)
        openCreateModal(
          url,
          selectedText || fullSentence,
          fullSentence,
          ankiTags,
          metadataWithCover,
          undefined,
          textBox,
          pageNumber,
          page.img_path
        );
      }
    }
  }

  function handleContextMenu(event: MouseEvent, lines: string[], blockIndex: number) {
    // Only show custom context menu if enabled in settings
    if (!$settings.textBoxContextMenu) return;

    event.preventDefault();

    // Get text box bounds with padding
    const block = page.blocks[blockIndex];
    const textBox = block ? expandTextBoxBounds(block, page) : undefined;

    onContextMenu?.({
      x: event.clientX,
      y: event.clientY,
      lines,
      imgElement: event.target as HTMLElement,
      textBox,
      pageIndex,
      blockIndex
    });
  }

  function onDoubleTap(event: Event, lines: string[], blockIndex: number) {
    // Always stop propagation to prevent zoom from triggering
    event.stopPropagation();
    if (doubleTapEnabled) {
      event.preventDefault();
      onUpdateCard(event, lines, blockIndex);
    }
  }

  function onCopy(event: ClipboardEvent) {
    // Strip line breaks from copied text (Ctrl+C default behavior)
    const selection = window.getSelection()?.toString() || '';
    const stripped = selection.replace(/[\n\r\t]/g, '');
    event.clipboardData?.setData('text/plain', stripped);
    event.preventDefault();
  }
</script>

{#each textBoxes as { fontSize, height, left, lines, top, width, writingMode, useMinDimensions, isOriginalMode, lineLayouts, layoutSignature, blockIndex }, index (`${volumeUuid}-textBox-${index}`)}
  {@const usePerLine = lineLayouts !== null}
  <div
    use:handleTextBoxHover={[index, fontSize]}
    use:positionPerLine={`${display}|${$settings.fontSize}|${layoutSignature}`}
    class="textBox"
    class:originalMode={isOriginalMode}
    class:perLine={usePerLine}
    class:forceVisible
    class:alwaysVisible={alwaysShowOCR}
    style:width={usePerLine ? width : isOriginalMode || useMinDimensions ? undefined : width}
    style:height={usePerLine ? height : isOriginalMode || useMinDimensions ? undefined : height}
    style:min-width={isOriginalMode ? undefined : useMinDimensions ? width : undefined}
    style:min-height={isOriginalMode ? undefined : useMinDimensions ? height : undefined}
    style:left
    style:top
    style:font-size={adjustedFontSizes.get(index) || fontSize}
    style:font-weight={fontWeight}
    style:display
    style:border
    style:writing-mode={writingMode}
    role="none"
    oncontextmenu={(e) => handleContextMenu(e, lines, blockIndex)}
    ondblclick={(e) => onDoubleTap(e, lines, blockIndex)}
    oncopy={onCopy}
  >
    <p>
      {#if usePerLine && lineLayouts}
        {#each lines as line, lineIndex}{#if !lineLayouts[lineIndex].hidden}<span
              class="ocr-line positionedLine"
              class:wrappedLine={lineLayouts[lineIndex].wrap}
              data-target-left={lineLayouts[lineIndex].left}
              data-target-top={lineLayouts[lineIndex].top}
              data-inset={lineLayouts[lineIndex].inset || undefined}
              data-rotation={lineLayouts[lineIndex].rotation || undefined}
              data-box-width={lineLayouts[lineIndex].rotation
                ? lineLayouts[lineIndex].width
                : undefined}
              data-box-height={lineLayouts[lineIndex].rotation
                ? lineLayouts[lineIndex].height
                : undefined}
              style:width={lineLayouts[lineIndex].wrap
                ? `${lineLayouts[lineIndex].width}px`
                : undefined}
              style:height={lineLayouts[lineIndex].wrap
                ? `${lineLayouts[lineIndex].height}px`
                : undefined}
              style:font-size={`${lineLayouts[lineIndex].fontSize}px`}
              style:letter-spacing={lineLayouts[lineIndex].letterSpacing
                ? `${lineLayouts[lineIndex].letterSpacing}px`
                : undefined}>{line}</span
            >{/if}{/each}
      {:else}
        {#each lines as line}<span class="ocr-line">{line}</span>{/each}
      {/if}
    </p>
  </div>
{/each}

<style>
  .textBox {
    color: black;
    padding: 0;
    position: absolute;
    line-height: 1.1em;
    font-size: 16pt;
    font-family: 'Noto Sans JP', sans-serif;
    /* Word wrapping controlled dynamically by JavaScript */
    border: 1px solid rgba(0, 0, 0, 0);
    z-index: 11;
    user-select: text;
    -webkit-user-select: text;
    -moz-user-select: text;
    -ms-user-select: text;
    -webkit-text-size-adjust: 100%;
    text-size-adjust: 100%;
    box-sizing: border-box;
  }

  .textBox:focus,
  .textBox:hover {
    background: rgb(255, 255, 255);
    border: 1px solid rgba(0, 0, 0, 0);
  }

  .textBox p {
    visibility: hidden;
    /* Word wrapping controlled dynamically by JavaScript */
    letter-spacing: 0.1em;
    line-height: 1.1em;
    background-color: rgb(255, 255, 255);
    font-weight: var(--bold);
    font-family: 'Noto Sans JP', sans-serif;
    z-index: 11;
    user-select: text;
    -webkit-user-select: text;
    -moz-user-select: text;
    -ms-user-select: text;
    -webkit-text-size-adjust: 100%;
    text-size-adjust: 100%;
  }

  .textBox:focus p,
  .textBox:hover p {
    visibility: visible;
  }

  /* Force visibility for placeholder/missing pages, or when always-show OCR is enabled */
  .textBox.forceVisible,
  .textBox.alwaysVisible {
    background: rgb(255, 255, 255);
  }

  .textBox.forceVisible p,
  .textBox.alwaysVisible p {
    visibility: visible;
  }

  /* Original mode: the file's font size is not made to fit, so text may run
     past the box — never clipped. (A per-line box keeps its OCR dimensions as
     the hover target; a whole-block one is unsized.) */
  .textBox.originalMode {
    overflow: visible;
    white-space: nowrap;
  }

  .textBox.originalMode p {
    white-space: nowrap;
  }

  /* Auto and original mode with lines_coords: each line is placed at its
     detected quad — with a geometry-derived font size in auto, the file's
     block font_size in original. The line stays inline-block IN NORMAL FLOW
     (not position:absolute) so DOM text scanners read the block as one
     continuous run (#254); a measurement action then translates it onto the
     quad. line-height 1 keeps the column/row no thicker than the font size.
     letter-spacing 0 is the default only: a line on the fixed-pitch grid
     carries its own as an inline style — (pitch − font size) per em of
     advance — which steps the ONE text node along the line with no
     per-character element; positionPerLine adds the start inset (the first
     glyph's cell begins before its ink, so usually negative) and, for a tilted
     quad, the rotation.
     font-kerning none: print is fixed-pitch and the measurer measures it that
     way (createCanvasMeasurer) — a kerned 」「 would come up short of its two
     cells, in a row at least (columns are not kerned to begin with). */
  .textBox.perLine .ocr-line.positionedLine {
    display: inline-block;
    line-height: 1;
    letter-spacing: 0;
    font-kerning: none;
    white-space: nowrap;
    /* transform (translate onto the quad, rotate with it) and its origin are
       set by positionPerLine */
  }

  /* A quad that captured multiple print columns (base text + furigana):
     the text flows inside the full quad bbox at the block's reference size,
     wrapping into columns/rows instead of shrinking onto one line. */
  .textBox.perLine .ocr-line.positionedLine.wrappedLine {
    white-space: normal;
    line-break: anywhere;
  }

  /* Legacy/manual modes: use a CSS-generated newline instead of <br/> so DOM
     walkers (Migaku/Yomitan) see one continuous text run per textbox and don't
     treat line breaks as sentence boundaries. Per-line (auto) mode positions
     each line explicitly and needs no visible newline; the generated content
     was never seen by Yomitan anyway. */
  .textBox:not(.perLine) .ocr-line:not(:last-child)::after {
    content: '\A';
    white-space: pre;
  }
</style>
