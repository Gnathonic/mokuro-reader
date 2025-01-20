<script lang="ts">
  import { clamp, promptConfirmation } from '$lib/util';
  import type { Page } from '$lib/types';
  import { settings } from '$lib/settings';
  import { imageToWebp, showCropper, updateLastCard } from '$lib/anki-connect';
  import { onDestroy } from 'svelte';

  export let page: Page;
  export let src: File;
  
  let textBoxElements: HTMLDivElement[] = [];

  onDestroy(() => {
    // Clean up text box elements when component is destroyed
    textBoxElements.forEach(el => {
      if (el && el.parentNode) {
        el.parentNode.removeChild(el);
      }
    });
    textBoxElements = [];
  });

  $: textBoxes = page.blocks
    .map((block) => {
      const { img_height, img_width } = page;
      const { box, font_size, lines, vertical } = block;

      let [_xmin, _ymin, _xmax, _ymax] = box;

      const xmin = clamp(_xmin, 0, img_width);
      const ymin = clamp(_ymin, 0, img_height);
      const xmax = clamp(_xmax, 0, img_width);
      const ymax = clamp(_ymax, 0, img_height);

      const width = xmax - xmin;
      const height = ymax - ymin;
      const area = width * height;

      const textBox = {
        left: `${xmin}px`,
        top: `${ymin}px`,
        width: `${width}px`,
        height: `${height}px`,
        fontSize: $settings.fontSize === 'auto' ? `${font_size}px` : `${$settings.fontSize}pt`,
        writingMode: vertical ? 'vertical-rl' : 'horizontal-tb',
        lines,
        area
      };

      return textBox;
    })
    .sort(({ area: a }, { area: b }) => {
      return b - a;
    });

  $: fontWeight = $settings.boldFont ? 'bold' : '400';
  $: display = $settings.displayOCR ? 'block' : 'none';
  $: border = $settings.textBoxBorders ? '1px solid red' : 'none';
  $: contenteditable = $settings.textEditable;

  $: triggerMethod = $settings.ankiConnectSettings.triggerMethod || 'both';

  async function onUpdateCard(lines: string[]) {
    if ($settings.ankiConnectSettings.enabled) {
      const sentence = lines.join(' ');
      if ($settings.ankiConnectSettings.cropImage) {
        showCropper(URL.createObjectURL(src), sentence);
      } else {
        promptConfirmation('Add image to last created anki card?', async () => {
          const imageData = await imageToWebp(src);
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

{#each textBoxes as { fontSize, height, left, lines, top, width, writingMode }, index (`textBox-${index}`)}
  <div
    class="textBox"
    style:width
    style:height
    style:left
    style:top
    style:font-size={fontSize}
    style:font-weight={fontWeight}
    style:display
    style:border
    style:writing-mode={writingMode}
    role="none"
    on:contextmenu={(e) => onContextMenu(e, lines)}
    on:dblclick={(e) => onDoubleTap(e, lines)}
    {contenteditable}
    bind:this={textBoxElements[index]}
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
    white-space: nowrap;
    border: 1px solid rgba(0, 0, 0, 0);
    z-index: 11;
  }

  .textBox:focus,
  .textBox:hover {
    background: rgb(255, 255, 255);
    border: 1px solid rgba(0, 0, 0, 0);
  }

  .textBox p {
    display: none;
    white-space: nowrap;
    letter-spacing: 0.1em;
    line-height: 1.1em;
    margin: 0;
    background-color: rgb(255, 255, 255);
    font-weight: var(--bold);
    z-index: 11;
  }

  .textBox:focus p,
  .textBox:hover p {
    display: table;
  }
</style>
