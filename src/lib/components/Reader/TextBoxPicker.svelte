<script lang="ts">
  import { Button, Helper, Modal, Spinner } from 'flowbite-svelte';
  import type { Page } from '$lib/types';
  import { showCropper, expandTextBoxBounds, type VolumeMetadata } from '$lib/anki-connect';
  import { onMount } from 'svelte';
  import { textBoxPickerStore } from './text-box-picker';

  let open = $state(false);
  let image = $state<string | undefined>(undefined);
  let page = $state<Page | undefined>(undefined);
  let tags = $state<string | undefined>(undefined);
  let metadata = $state<VolumeMetadata | undefined>(undefined);

  // Track which block is currently selected (for highlighting)
  let selectedBlockIndex = $state<number | null>(null);

  // Flatten blocks from page with their position info for rendering
  interface TextBoxZone {
    left: string;
    top: string;
    width: string;
    height: string;
    text: string;
    blockIndex: number;
    box: [number, number, number, number];
  }

  let textBoxZones = $derived.by(() => {
    const zones: TextBoxZone[] = [];
    if (!page) return zones;

    const { img_width, img_height, blocks } = page;
    if (!img_width || !img_height) return zones;

    blocks.forEach((block, index) => {
      const [xmin, ymin, xmax, ymax] = block.box;
      // Convert to percentages for responsive positioning
      zones.push({
        left: `${(xmin / img_width) * 100}%`,
        top: `${(ymin / img_height) * 100}%`,
        width: `${((xmax - xmin) / img_width) * 100}%`,
        height: `${((ymax - ymin) / img_height) * 100}%`,
        text: block.lines.join(' '),
        blockIndex: index,
        box: block.box as [number, number, number, number]
      });
    });

    return zones;
  });

  onMount(() => {
    textBoxPickerStore.subscribe((value) => {
      open = value.open;
      image = value.image;
      page = value.page;
      tags = value.tags;
      metadata = value.metadata;

      if (value.open) {
        selectedBlockIndex = null;
      }
    });
  });

  function selectTextboxZone(zone: TextBoxZone) {
    selectedBlockIndex = zone.blockIndex;
  }

  function close() {
    selectedBlockIndex = null;
    textBoxPickerStore.set({ open: false });
  }

  function handleContinue() {
    if (selectedBlockIndex === null || !page || !image) return;

    const zone = textBoxZones.find((z) => z.blockIndex === selectedBlockIndex);
    if (!zone) return;

    const block = page.blocks[zone.blockIndex];
    if (!block) return;

    const selectedText = zone.text;
    const textBox = expandTextBoxBounds(block, page);

    // Capture values before close() clears the store state
    const imageUrl = image;
    const ankiTags = tags;
    const volumeMetadata = metadata;

    close();

    // Show the cropper with the selected text and bounds
    showCropper(imageUrl, selectedText, selectedText, ankiTags, volumeMetadata, undefined, textBox);
  }

  // Handle backdrop mousedown - dismiss on mousedown outside content
  function handleBackdropMousedown(ev: MouseEvent & { currentTarget: HTMLDialogElement }) {
    const dlg = ev.currentTarget;
    if (ev.target === dlg) {
      const rect = dlg.getBoundingClientRect();
      const clickedInContent =
        ev.clientX >= rect.left &&
        ev.clientX <= rect.right &&
        ev.clientY >= rect.top &&
        ev.clientY <= rect.bottom;

      if (!clickedInContent) {
        close();
      }
    }
  }
</script>

<Modal
  title="Select Text Box"
  bind:open
  size="lg"
  onclose={close}
  outsideclose={false}
  onmousedown={handleBackdropMousedown}
>
  {#if image && page}
    <div class="flex flex-col gap-3">
      <div class="image-container flex justify-center">
        <div class="relative inline-block">
          <img src={image} alt="Page preview" class="max-h-[60svh] object-contain" />
          {#each textBoxZones as zone}
            <button
              type="button"
              onclick={() => selectTextboxZone(zone)}
              class="textbox-zone"
              class:selected={selectedBlockIndex === zone.blockIndex}
              style:left={zone.left}
              style:top={zone.top}
              style:width={zone.width}
              style:height={zone.height}
              title={zone.text}
            ></button>
          {/each}
        </div>
      </div>
      <Helper class="text-center">Click a text box on the image to select it</Helper>

      <div class="relative z-10 flex justify-end gap-2">
        <Button color="alternative" onclick={close}>Cancel</Button>
        <Button color="primary" onclick={handleContinue} disabled={selectedBlockIndex === null}>
          Continue
        </Button>
      </div>
    </div>
  {:else}
    <div class="text-center"><Spinner /></div>
  {/if}
</Modal>

<style>
  .textbox-zone {
    position: absolute;
    border: 2px solid red;
    background: transparent;
    cursor: pointer;
    transition: all 0.15s ease;
    padding: 0;
  }

  .textbox-zone:hover {
    background: rgba(255, 0, 0, 0.15);
    border-color: #ff4444;
  }

  .textbox-zone.selected {
    background: rgba(0, 128, 255, 0.25);
    border-color: #0080ff;
    border-width: 3px;
  }
</style>
