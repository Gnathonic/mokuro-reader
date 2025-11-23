<script lang="ts">
  import { clamp, promptConfirmation } from '$lib/util';
  import type { Page } from '$lib/types';
  import { settings } from '$lib/settings';
  import { imageToWebp, showCropper, updateLastCard } from '$lib/anki-connect';

  interface Props {
    page: Page;
    src: File;
    volumeUuid: string;
  }

  let { page, src, volumeUuid }: Props = $props();

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
  }

  let textBoxes = $derived(
    page.blocks
      .map((block) => {
        const { img_height, img_width } = page;
        const { box, font_size, lines, vertical } = block;

        let [_xmin, _ymin, _xmax, _ymax] = box;

        // Only expand bounding boxes when using auto font sizing
        // Manual font sizes should use exact OCR bounding boxes
        let xmin, ymin, xmax, ymax;

        if ($settings.fontSize === 'auto') {
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
          // Use exact OCR bounding boxes for manual font sizes
          xmin = _xmin;
          ymin = _ymin;
          xmax = _xmax;
          ymax = _ymax;
        }

        const width = xmax - xmin;
        const height = ymax - ymin;
        const area = width * height;

        // Replace manual ellipsis with proper ellipsis character (…)
        // Handle both ASCII periods (...) and full-width periods (．．．)
        const processedLines = lines.map((line) =>
          line.replace(/\.\.\./g, '…').replace(/．．．/g, '…')
        );

        const textBox: TextBoxData = {
          left: `${xmin}px`,
          top: `${ymin}px`,
          width: `${width}px`,
          height: `${height}px`,
          fontSize: $settings.fontSize === 'auto' ? `${font_size}px` : `${$settings.fontSize}pt`,
          writingMode: vertical ? 'vertical-rl' : 'horizontal-tb',
          lines: processedLines,
          area,
          useMinDimensions: $settings.fontSize !== 'auto'
        };

        return textBox;
      })
      .sort(({ area: a }, { area: b }) => {
        return b - a;
      })
  );

  let fontWeight = $derived($settings.boldFont ? 'bold' : '400');
  let display = $derived($settings.displayOCR ? 'block' : 'none');
  let border = $derived($settings.textBoxBorders ? '1px solid red' : 'none');
  let contenteditable = $derived($settings.textEditable);

  let triggerMethod = $derived($settings.ankiConnectSettings.triggerMethod || 'both');

  // Track adjusted font sizes for each textbox
  let adjustedFontSizes = $state<Map<number, string>>(new Map());
  // Track which textboxes need word wrapping enabled
  let needsWrapping = $state<Set<number>>(new Set());
  // Track which textboxes have been processed
  let processedTextBoxes = $state<Set<number>>(new Set());

  // Calculate optimal font size for a textbox
  function calculateOptimalFontSize(element: HTMLDivElement, initialFontSize: string) {
    // Parse the initial font size to get numeric value
    const match = initialFontSize.match(/(\d+(?:\.\d+)?)(px|pt)/);
    if (!match) return null;

    const originalSize = parseFloat(match[1]);
    const unit = match[2];
    const minFontSize = 8; // Minimum font size in px

    // Convert to px for consistent handling
    let originalInPx = unit === 'pt' ? originalSize * 1.333 : originalSize;

    // Check if content overflows
    const isOverflowing = () => {
      return (
        element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth
      );
    };

    // Test nowrap mode: reduce font size until it fits
    element.style.whiteSpace = 'nowrap';
    element.style.wordWrap = 'normal';
    element.style.overflowWrap = 'normal';
    element.style.fontSize = `${originalInPx}px`;

    let noWrapSize = originalInPx;
    while (isOverflowing() && noWrapSize > minFontSize) {
      noWrapSize -= 1;
      element.style.fontSize = `${noWrapSize}px`;
    }

    // Test wrap mode: reduce font size until it fits
    element.style.whiteSpace = 'normal';
    element.style.wordWrap = 'break-word';
    element.style.overflowWrap = 'break-word';
    element.style.fontSize = `${originalInPx}px`;

    let wrapSize = originalInPx;
    while (isOverflowing() && wrapSize > minFontSize) {
      wrapSize -= 1;
      element.style.fontSize = `${wrapSize}px`;
    }

    // Choose the mode that allows larger font size (prefer wrapping if 1.2x better)
    let finalSize: number;
    let useWrapping: boolean;

    if (wrapSize >= noWrapSize * 1.2) {
      // Wrapping allows significantly larger font
      finalSize = wrapSize;
      useWrapping = true;
    } else {
      // Nowrap is better or wrapping doesn't help enough
      finalSize = noWrapSize;
      useWrapping = false;
    }

    return {
      finalSize,
      useWrapping,
      originalInPx
    };
  }

  // Handle hover event to calculate resize on demand (only for auto font sizing)
  function handleTextBoxHover(element: HTMLDivElement, params: [number, string]) {
    const [index, initialFontSize] = params;

    const onMouseEnter = () => {
      // Skip if already processed, OCR is hidden, or using manual font size
      if (processedTextBoxes.has(index) || display !== 'block' || $settings.fontSize !== 'auto')
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

  async function onUpdateCard(lines: string[]) {
    if ($settings.ankiConnectSettings.enabled) {
      const sentence = lines.join(' ');
      if ($settings.ankiConnectSettings.cropImage) {
        showCropper(URL.createObjectURL(src), sentence);
      } else {
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
      onUpdateCard(lines);
    }
  }

  function onDoubleTap(event: Event, lines: string[]) {
    if (triggerMethod === 'both' || triggerMethod === 'doubleTap') {
      event.preventDefault();
      onUpdateCard(lines);
    }
  }
</script>

{#each textBoxes as { fontSize, height, left, lines, top, width, writingMode, useMinDimensions }, index (`${volumeUuid}-textBox-${index}`)}
  <div
    use:handleTextBoxHover={[index, fontSize]}
    class="textBox"
    style:width={useMinDimensions ? undefined : width}
    style:height={useMinDimensions ? undefined : height}
    style:min-width={useMinDimensions ? width : undefined}
    style:min-height={useMinDimensions ? height : undefined}
    style:left
    style:top
    style:font-size={adjustedFontSizes.get(index) || fontSize}
    style:font-weight={fontWeight}
    style:display
    style:border
    style:writing-mode={writingMode}
    role="none"
    oncontextmenu={(e) => onContextMenu(e, lines)}
    ondblclick={(e) => onDoubleTap(e, lines)}
    {contenteditable}
  >
    {#each lines as line}
      <p>{line}</p>
    {/each}
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
    margin: 0;
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
</style>
