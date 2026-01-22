<script lang="ts">
  import { currentView } from '$lib/util/hash-router';
  import { cropperStore, getCroppedImg, type Pixels, sendToAnki } from '$lib/anki-connect';
  import { settings } from '$lib/settings';
  import { Button, Helper, Input, Label, Modal, Spinner } from 'flowbite-svelte';
  import { onMount, onDestroy } from 'svelte';
  import CropperJS from 'cropperjs';
  import 'cropperjs/dist/cropper.css';

  let open = $state(false);
  let pixels: Pixels | undefined = undefined;
  let loading = $state(false);
  let cropper: CropperJS | null = null;

  // Editable fields
  let editableSelectedText = $state('');
  let editableSentence = $state('');

  // Track whether crop image is enabled (preset to text box vs full image)
  let cropEnabled = $derived($settings.ankiConnectSettings.cropImage);
  let cardMode = $derived($settings.ankiConnectSettings.cardMode);
  let grabSentence = $derived($settings.ankiConnectSettings.grabSentence);
  let sentenceField = $derived($settings.ankiConnectSettings.sentenceField);

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

          // On mobile, blur the auto-focused input to prevent keyboard from appearing
          // and causing layout issues with the cropper
          if ($settings.mobile) {
            requestAnimationFrame(() => {
              if (document.activeElement instanceof HTMLElement) {
                document.activeElement.blur();
              }
            });
          }
        }
      }
    });
  });

  onDestroy(() => {
    if (cropper) {
      cropper.destroy();
      cropper = null;
    }
  });

  function initCropper(img: HTMLImageElement) {
    const setup = () => {
      if (cropper) {
        cropper.destroy();
      }

      // Get text box bounds if available
      const textBox = $cropperStore?.textBox;

      cropper = new CropperJS(img, {
        viewMode: 1,
        dragMode: 'move',
        autoCropArea: 1,
        restore: false,
        guides: true,
        center: true,
        highlight: false,
        cropBoxMovable: true,
        cropBoxResizable: true,
        toggleDragModeOnDblclick: false,
        aspectRatio: NaN, // Free-form cropping
        ready() {
          // When "Preset to text box" is enabled and textBox bounds available, use them
          // Otherwise, preset to full image (autoCropArea: 1 already does this)
          if (cropEnabled && textBox && cropper) {
            const [xmin, ymin, xmax, ymax] = textBox;
            cropper.setData({
              x: xmin,
              y: ymin,
              width: xmax - xmin,
              height: ymax - ymin
            });
          }
          updatePixels();
        },
        crop() {
          updatePixels();
        }
      });
    };

    if (img.complete && img.naturalWidth > 0) {
      setup();
    } else {
      img.onload = setup;
    }
  }

  function updatePixels() {
    if (!cropper) return;
    const data = cropper.getData(true);
    pixels = {
      x: data.x,
      y: data.y,
      width: data.width,
      height: data.height
    };
  }

  // Handle backdrop mousedown - dismiss on mousedown outside content, not mouseup
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

  function close() {
    if (cropper) {
      cropper.destroy();
      cropper = null;
    }
    loading = false;
    editableSelectedText = '';
    editableSentence = '';
    cropperStore.set({ open: false });
  }

  async function onSend() {
    if ($cropperStore?.image && pixels) {
      loading = true;
      try {
        // Always use the cropped region from the cropper
        const imageData = await getCroppedImg($cropperStore.image, pixels, $settings);

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
</script>

<Modal
  title={cardMode === 'create' ? 'Create Anki Card' : 'Update Anki Card'}
  bind:open
  onclose={close}
  outsideclose={false}
  onmousedown={handleBackdropMousedown}
>
  {#if $cropperStore?.image && !loading}
    <div class="flex flex-col gap-3">
      <div class="cropper-container">
        <img
          src={$cropperStore?.image}
          alt="Crop preview"
          class="cropper-image block max-w-full"
          use:initCropper
        />
      </div>

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
          <Input
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
  .cropper-container {
    position: relative;
    height: 50dvh;
    overflow: hidden;
    border-radius: 0.5rem;
    background: #111827;
  }

  .cropper-container :global(.cropper-container) {
    height: 100% !important;
  }

  /* Make resize handles larger and easier to grab */
  .cropper-container :global(.cropper-point) {
    width: 20px !important;
    height: 20px !important;
    opacity: 1 !important;
  }

  .cropper-container :global(.cropper-point.point-nw) {
    top: -10px !important;
    left: -10px !important;
  }

  .cropper-container :global(.cropper-point.point-ne) {
    top: -10px !important;
    right: -10px !important;
  }

  .cropper-container :global(.cropper-point.point-sw) {
    bottom: -10px !important;
    left: -10px !important;
  }

  .cropper-container :global(.cropper-point.point-se) {
    bottom: -10px !important;
    right: -10px !important;
  }

  .cropper-container :global(.cropper-point.point-n) {
    width: 40px !important;
    height: 20px !important;
    top: -10px !important;
    left: 50% !important;
    margin-left: -20px !important;
  }

  .cropper-container :global(.cropper-point.point-s) {
    width: 40px !important;
    height: 20px !important;
    bottom: -10px !important;
    top: auto !important;
    left: 50% !important;
    margin-left: -20px !important;
  }

  .cropper-container :global(.cropper-point.point-e) {
    height: 40px !important;
    width: 20px !important;
    right: -10px !important;
    left: auto !important;
    top: 50% !important;
    margin-top: -20px !important;
  }

  .cropper-container :global(.cropper-point.point-w) {
    height: 40px !important;
    width: 20px !important;
    left: -10px !important;
    top: 50% !important;
    margin-top: -20px !important;
  }

  .cropper-container :global(.cropper-line) {
    background-color: rgba(59, 130, 246, 0.5) !important;
  }
</style>
