<script lang="ts">
  import { currentView } from '$lib/util/hash-router';
  import { cropperStore, getCroppedImg, type Pixels, sendToAnki } from '$lib/anki-connect';
  import { settings } from '$lib/settings';
  import { Button, Helper, Input, Label, Modal, Spinner, Textarea } from 'flowbite-svelte';
  import { onMount } from 'svelte';
  import Cropper from 'svelte-easy-crop';
  import type { Page } from '$lib/types';

  let open = $state(false);
  let pixels: Pixels | undefined = undefined;
  let loading = $state(false);
  let crop = $state({ x: 0, y: 0 });
  let zoom = $state(1);

  // Editable fields
  let editableSelectedText = $state('');
  let editableSentence = $state('');

  // Track whether we opened with no pre-selected text (show textbox picker)
  let openedWithoutText = $state(false);

  // Track which block is currently selected (for highlighting)
  let selectedBlockIndex = $state<number | null>(null);

  // Track whether crop image is enabled
  let cropEnabled = $derived($settings.ankiConnectSettings.cropImage);
  let cardMode = $derived($settings.ankiConnectSettings.cardMode);
  let grabSentence = $derived($settings.ankiConnectSettings.grabSentence);
  let sentenceField = $derived($settings.ankiConnectSettings.sentenceField);

  // Get available pages for selection
  let pages = $derived($cropperStore?.pages || []);

  // Flatten blocks from all pages with their position info for rendering
  interface TextBoxZone {
    left: string;
    top: string;
    width: string;
    height: string;
    text: string;
    blockIndex: number;
  }

  let textBoxZones = $derived.by(() => {
    const zones: TextBoxZone[] = [];
    // Use first page only (each image corresponds to one page)
    const page = pages[0];
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
        blockIndex: index
      });
    });

    return zones;
  });

  // Show textbox picker when in create mode, no text selected, and pages available
  let showTextboxPicker = $derived(
    cardMode === 'create' && openedWithoutText && textBoxZones.length > 0
  );

  // Close modal on navigation (hash route change)
  let previousViewType = $state($currentView.type);
  $effect(() => {
    const viewType = $currentView.type;
    if (viewType !== previousViewType) {
      previousViewType = viewType;
      if (open) {
        close();
      }
    }
  });

  onMount(() => {
    cropperStore.subscribe((value) => {
      if (value) {
        open = value.open;
        // Initialize editable fields from store
        if (value.open) {
          editableSelectedText = value.selectedText || '';
          editableSentence = value.sentence || '';
          // Track if we opened without pre-selected text
          openedWithoutText = !value.selectedText;
          selectedBlockIndex = null;
        }
      }
    });
  });

  // Select a textbox zone to populate both Front and Sentence fields
  function selectTextboxZone(zone: TextBoxZone) {
    editableSelectedText = zone.text;
    editableSentence = zone.text;
    selectedBlockIndex = zone.blockIndex;
  }

  function close() {
    loading = false;
    editableSelectedText = '';
    editableSentence = '';
    openedWithoutText = false;
    selectedBlockIndex = null;
    cropperStore.set({ open: false });
  }

  async function onSend() {
    if ($cropperStore?.image) {
      loading = true;
      try {
        let imageData: string | null | undefined;

        if (cropEnabled && pixels) {
          // Crop the image if crop mode is enabled
          imageData = await getCroppedImg($cropperStore.image, pixels, $settings);
        } else {
          // Use full image - fetch and convert to base64
          const response = await fetch($cropperStore.image);
          const blob = await response.blob();
          imageData = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.readAsDataURL(blob);
          });
        }

        sendToAnki(
          imageData,
          editableSelectedText,
          editableSentence,
          $cropperStore.tags,
          $cropperStore.metadata
        );
        close();
      } catch (error) {
        console.error('[Cropper] Error:', error);
        loading = false;
      }
    }
  }

  function onCropComplete(detail: any) {
    // In v4, the callback receives the detail directly (not as e.detail)
    // This fires continuously as the user adjusts the crop area
    pixels = detail.pixels;
  }
</script>

<Modal
  title={cardMode === 'create' ? 'Create Anki Card' : 'Update Anki Card'}
  bind:open
  onclose={close}
>
  {#if $cropperStore?.image && !loading}
    <div class="flex flex-col gap-3">
      {#if cropEnabled}
        <div class="relative h-[30svh] w-full sm:h-[40svh]">
          <Cropper
            zoomSpeed={0.5}
            maxZoom={10}
            image={$cropperStore?.image}
            bind:crop
            bind:zoom
            oncropcomplete={onCropComplete}
          />
        </div>
      {:else}
        <div class="image-container flex justify-center">
          <div class="relative inline-block">
            <img src={$cropperStore?.image} alt="Preview" class="max-h-[30svh] object-contain" />
            {#if showTextboxPicker}
              <!-- Clickable text box zones overlaid on the image -->
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
            {/if}
          </div>
        </div>
        {#if showTextboxPicker}
          <Helper class="text-center">Click a text box on the image to select it</Helper>
        {/if}
      {/if}

      <div>
        <Label class="text-gray-900 dark:text-white">
          Front: {#if cardMode === 'create'}<span class="text-red-500">*</span>{/if}
        </Label>
        <Input
          bind:value={editableSelectedText}
          placeholder="Selected text for card front..."
          class="mt-1"
          required={cardMode === 'create'}
        />
        <Helper class="mt-1"
          >The word or phrase (card front){#if cardMode === 'create'}
            - required{/if}</Helper
        >
      </div>

      {#if grabSentence && sentenceField !== 'Front'}
        <div>
          <Label class="text-gray-900 dark:text-white">{sentenceField}:</Label>
          <Textarea
            rows={2}
            bind:value={editableSentence}
            placeholder="Full sentence context..."
            class="mt-1"
          />
          <Helper class="mt-1">Full context sentence</Helper>
        </div>
      {/if}

      <div class="flex gap-2">
        <Button onclick={onSend} class="flex-1">
          {cardMode === 'create' ? 'Create Card' : 'Update Card'}
        </Button>
        <Button onclick={close} outline color="light">Cancel</Button>
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
