<script lang="ts">
  import type { Page } from '$lib/types';
  import TextBoxes from './TextBoxes.svelte';

  interface Props {
    page: Page;
    src: File;
    cachedBitmap?: ImageBitmap | null;
    volumeUuid: string;
    showTextBoxes?: boolean;
  }

  let { page, src, cachedBitmap, volumeUuid, showTextBoxes = true }: Props = $props();

  let canvasEl: HTMLCanvasElement | undefined = $state();

  // Draw pre-decoded bitmap to canvas when ready
  // Defer to next frame to avoid blocking during spread transitions
  $effect(() => {
    if (!canvasEl || !cachedBitmap) return;

    // Capture refs for closure
    const canvas = canvasEl;
    const bitmap = cachedBitmap;

    requestAnimationFrame(() => {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0);
      }
    });
  });
</script>

<div
  draggable="false"
  style:width={`${page.img_width}px`}
  style:height={`${page.img_height}px`}
  class="relative"
>
  <canvas
    bind:this={canvasEl}
    width={page.img_width}
    height={page.img_height}
    class="absolute inset-0 h-full w-full"
    style="object-fit: contain;"
  ></canvas>
  {#if showTextBoxes}
    <TextBoxes {page} {src} {volumeUuid} />
  {/if}
</div>
