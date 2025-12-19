<script lang="ts">
  import { clamp, promptConfirmation } from '$lib/util';
  import type { Page } from '$lib/types';
  import { settings } from '$lib/settings';
  import { imageToWebp, showCropper, updateLastCard } from '$lib/anki-connect';

  interface Props {
    page: Page;
    src?: File;
    volumeUuid: string;
  }

  let { page, src, volumeUuid }: Props = $props();

  interface TextBoxData {
    // Pre-computed style string to reduce DOM operations
    styleString: string;
    lines: string[];
    area: number;
    fontSize: string; // Keep for hover adjustment
    isOriginalMode: boolean;
  }

  // Pre-compute shared styles once
  let sharedStyles = $derived.by(() => {
    const fontWeight = $settings.boldFont ? 'bold' : '400';
    const display = $settings.displayOCR ? 'block' : 'none';
    const border = $settings.textBoxBorders ? '1px solid red' : 'none';
    return { fontWeight, display, border };
  });

  let textBoxes = $derived(
    page.blocks
      .map((block) => {
        const { img_height, img_width } = page;
        const { box, font_size, lines, vertical } = block;

        let [_xmin, _ymin, _xmax, _ymax] = box;

        // Only expand bounding boxes when using auto font sizing
        let xmin, ymin, xmax, ymax;

        if ($settings.fontSize === 'auto') {
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

        // Replace ellipsis characters
        const processedLines = lines.map((line) =>
          line.replace(/\.\.\./g, '…').replace(/．．．/g, '…')
        );

        // Determine font size
        let fontSize: string;
        if ($settings.fontSize === 'auto' || $settings.fontSize === 'original') {
          fontSize = `${font_size}px`;
        } else {
          fontSize = `${$settings.fontSize}pt`;
        }

        const isOriginalMode = $settings.fontSize === 'original';
        const useMinDimensions = $settings.fontSize !== 'auto' && !isOriginalMode;
        const writingMode = vertical ? 'vertical-rl' : 'horizontal-tb';

        // Build a single style string to reduce DOM operations
        const styles: string[] = [
          `left:${xmin}px`,
          `top:${ymin}px`,
          `font-size:${fontSize}`,
          `font-weight:${sharedStyles.fontWeight}`,
          `display:${sharedStyles.display}`,
          `border:${sharedStyles.border}`,
          `writing-mode:${writingMode}`
        ];

        if (!isOriginalMode) {
          if (useMinDimensions) {
            styles.push(`min-width:${width}px`, `min-height:${height}px`);
          } else {
            styles.push(`width:${width}px`, `height:${height}px`);
          }
        }

        const textBox: TextBoxData = {
          styleString: styles.join(';'),
          lines: processedLines,
          area,
          fontSize,
          isOriginalMode
        };

        return textBox;
      })
      .sort(({ area: a }, { area: b }) => b - a)
  );

  let contenteditable = $derived($settings.textEditable);
  let triggerMethod = $derived($settings.ankiConnectSettings.triggerMethod || 'both');

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

    // Convert to px for consistent handling
    const originalInPx = unit === 'pt' ? originalSize * 1.333 : originalSize;

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

    const onMouseEnter = () => {
      // Skip if already processed, OCR is hidden, or using manual font size
      if (
        processedTextBoxes.has(index) ||
        sharedStyles.display !== 'block' ||
        $settings.fontSize !== 'auto'
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

    element.addEventListener('mouseenter', onMouseEnter);

    return {
      destroy() {
        element.removeEventListener('mouseenter', onMouseEnter);
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

  async function onUpdateCard(event: Event, lines: string[]) {
    if ($settings.ankiConnectSettings.enabled) {
      const sentence = lines.join(' ');
      if ($settings.ankiConnectSettings.cropImage) {
        // Get image URL from rendered page, fallback to creating from src
        const url =
          getImageUrlFromElement(event.target as HTMLElement) ||
          (src ? URL.createObjectURL(src) : null);
        if (url) {
          showCropper(url, sentence);
        }
      } else if (src) {
        promptConfirmation('Add image to last created anki card?', async () => {
          const imageData = await imageToWebp(src, $settings);
          updateLastCard(imageData, sentence);
        });
      }
    }
  }

  function onContextMenu(event: Event, lines: string[]) {
    if (triggerMethod === 'both' || triggerMethod === 'rightClick') {
      event.preventDefault();
      onUpdateCard(event, lines);
    }
  }

  function onDoubleTap(event: Event, lines: string[]) {
    // Always stop propagation to prevent zoom from triggering
    event.stopPropagation();
    if (triggerMethod === 'both' || triggerMethod === 'doubleTap') {
      event.preventDefault();
      onUpdateCard(event, lines);
    }
  }
</script>

{#each textBoxes as { styleString, lines, fontSize, isOriginalMode }, index (`${volumeUuid}-textBox-${index}`)}
  <div
    use:handleTextBoxHover={[index, fontSize]}
    class="textBox"
    class:originalMode={isOriginalMode}
    style={adjustedFontSizes.has(index)
      ? styleString.replace(/font-size:[^;]+/, `font-size:${adjustedFontSizes.get(index)}`)
      : styleString}
    role="none"
    oncontextmenu={(e) => onContextMenu(e, lines)}
    ondblclick={(e) => onDoubleTap(e, lines)}
    {contenteditable}
  >
    <p>
      {#each lines as line, i}{line}{#if i < lines.length - 1}<br />{/if}{/each}
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

  /* Original mode: no size constraints, allow overflow */
  .textBox.originalMode {
    overflow: visible;
    white-space: nowrap;
  }

  .textBox.originalMode p {
    white-space: nowrap;
  }
</style>
