<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Button, Modal, Spinner, Fileupload } from 'flowbite-svelte';
  import { getVolumeFiles } from '$lib/util/volume-editor';
  import { showSnackbar } from '$lib/util';
  import { IMAGE_MIME_TYPES } from '$lib/import/types';
  import Cropper from 'cropperjs';
  import 'cropperjs/dist/cropper.css';

  interface Props {
    volumeUuid: string;
    onSelect: (file: File) => void;
    onCancel: () => void;
  }

  let { volumeUuid, onSelect, onCancel }: Props = $props();

  let open = $state(true);
  let loading = $state(true);
  let pages = $state<{ path: string; file: File; url: string }[]>([]);
  let selectedPageIndex = $state<number | null>(null);

  // Cropping state
  let showCropper = $state(false);
  let cropImage = $state<string | null>(null);
  let cropper: Cropper | null = null;

  onMount(async () => {
    await loadPages();
  });

  onDestroy(() => {
    // Clean up object URLs
    for (const page of pages) {
      URL.revokeObjectURL(page.url);
    }
    if (cropImage) {
      URL.revokeObjectURL(cropImage);
    }
    if (cropper) {
      cropper.destroy();
    }
  });

  async function loadPages() {
    loading = true;
    try {
      const files = await getVolumeFiles(volumeUuid);
      if (files) {
        pages = files.map((f) => ({
          path: f.path,
          file: f.file,
          url: URL.createObjectURL(f.file)
        }));
      }
    } catch (err) {
      console.error('Error loading pages:', err);
    } finally {
      loading = false;
    }
  }

  const validImageMimeTypes = new Set(Object.values(IMAGE_MIME_TYPES));

  function isValidImageFile(file: File): boolean {
    return validImageMimeTypes.has(file.type) || file.type.startsWith('image/');
  }

  function handleFileUpload(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      const file = input.files[0];
      if (!isValidImageFile(file)) {
        showSnackbar('Please select a valid image file');
        return;
      }
      onSelect(file);
      handleClose();
    }
  }

  function handlePageSelect(index: number) {
    selectedPageIndex = index;
  }

  function handleUsePage() {
    if (selectedPageIndex !== null && pages[selectedPageIndex]) {
      onSelect(pages[selectedPageIndex].file);
      handleClose();
    }
  }

  async function handleCropPage() {
    if (selectedPageIndex !== null && pages[selectedPageIndex]) {
      cropImage = pages[selectedPageIndex].url;
      showCropper = true;
    }
  }

  function initCropper(img: HTMLImageElement) {
    const setup = () => {
      // Destroy existing cropper if any
      if (cropper) {
        cropper.destroy();
      }

      const imageWidth = img.naturalWidth;
      const imageHeight = img.naturalHeight;
      const imageAspect = imageWidth / imageHeight;
      const targetAspect = 3 / 4;

      // Determine if we should use 3:4 or full image
      const useTargetAspect = imageAspect >= targetAspect;

      cropper = new Cropper(img, {
        viewMode: 1, // Restrict crop box to image bounds
        dragMode: 'move',
        autoCropArea: 1, // Start with full coverage
        restore: false,
        guides: true,
        center: true,
        highlight: false,
        cropBoxMovable: true,
        cropBoxResizable: true,
        toggleDragModeOnDblclick: false,
        initialAspectRatio: useTargetAspect ? targetAspect : imageAspect,
        aspectRatio: NaN, // Free-form resizing (no locked aspect)
        ready() {
          if (!cropper) return;

          if (useTargetAspect) {
            // Set crop box to full height with 3:4 aspect, centered
            const containerData = cropper.getContainerData();
            const imageData = cropper.getImageData();

            // Calculate crop box dimensions at full height
            const cropHeight = imageData.height;
            const cropWidth = cropHeight * targetAspect;
            const left = imageData.left + (imageData.width - cropWidth) / 2;
            const top = imageData.top;

            cropper.setCropBoxData({
              left,
              top,
              width: cropWidth,
              height: cropHeight
            });
          }
          // Otherwise autoCropArea: 1 already selects the full image
        }
      });
    };

    if (img.complete && img.naturalWidth > 0) {
      setup();
    } else {
      img.onload = setup;
    }
  }

  async function handleCropConfirm() {
    if (!cropper) return;

    try {
      const canvas = cropper.getCroppedCanvas({
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'high'
      });

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', 0.9)
      );

      if (blob) {
        const file = new File([blob], 'cover.jpg', { type: 'image/jpeg' });
        onSelect(file);
        handleClose();
      }
    } catch (err) {
      console.error('Error cropping image:', err);
    }
  }

  function handleCropCancel() {
    if (cropper) {
      cropper.destroy();
      cropper = null;
    }
    showCropper = false;
    cropImage = null;
  }

  function handleClose() {
    if (cropper) {
      cropper.destroy();
      cropper = null;
    }
    open = false;
    onCancel();
  }

  function handleZoomIn() {
    cropper?.zoom(0.1);
  }

  function handleZoomOut() {
    cropper?.zoom(-0.1);
  }

  function handleReset() {
    cropper?.reset();
  }
</script>

<Modal bind:open size="xl" onclose={handleClose}>
  <div class="p-2">
    {#if showCropper && cropImage}
      <!-- Cropper View -->
      <h3 class="mb-4 text-xl font-semibold text-gray-900 dark:text-white">Crop Cover</h3>

      <div
        class="cropper-container relative mb-4 h-[400px] w-full overflow-hidden rounded-lg bg-gray-900"
      >
        <img
          src={cropImage}
          alt="Crop preview"
          class="cropper-image block max-w-full"
          use:initCropper
        />
      </div>

      <div class="mb-4 flex items-center justify-center gap-2">
        <Button size="xs" color="light" onclick={handleZoomOut}>−</Button>
        <span class="text-sm text-gray-600 dark:text-gray-400">Zoom</span>
        <Button size="xs" color="light" onclick={handleZoomIn}>+</Button>
        <Button size="xs" color="light" onclick={handleReset} class="ml-4">Reset</Button>
      </div>

      <div class="flex justify-end gap-2">
        <Button color="alternative" onclick={handleCropCancel}>Back</Button>
        <Button color="primary" onclick={handleCropConfirm}>Use Cropped Image</Button>
      </div>
    {:else}
      <!-- Selection View -->
      <h3 class="mb-4 text-xl font-semibold text-gray-900 dark:text-white">Change Cover</h3>

      <!-- Upload Section -->
      <div class="mb-6">
        <span class="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
          Upload an image
        </span>
        <Fileupload accept="image/*" onchange={handleFileUpload} />
      </div>

      <!-- Page Selection -->
      <div class="mb-4">
        <span class="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
          Or select from volume pages:
        </span>

        {#if loading}
          <div class="flex items-center justify-center py-8">
            <Spinner size="6" />
          </div>
        {:else if pages.length === 0}
          <div class="py-4 text-center text-gray-500">No pages found</div>
        {:else}
          <div
            class="grid max-h-[300px] grid-cols-5 gap-2 overflow-y-auto rounded-lg border border-gray-200 p-2 sm:grid-cols-6 md:grid-cols-8 dark:border-gray-700"
          >
            {#each pages as page, index}
              <button
                onclick={() => handlePageSelect(index)}
                class="relative aspect-[5/7] overflow-hidden rounded border-2 transition-all hover:border-primary-400 {selectedPageIndex ===
                index
                  ? 'border-primary-500 ring-2 ring-primary-300'
                  : 'border-gray-200 dark:border-gray-700'}"
              >
                <img
                  src={page.url}
                  alt="Page {index + 1}"
                  class="h-full w-full object-cover"
                  loading="lazy"
                />
                <span
                  class="absolute right-0 bottom-0 left-0 bg-black/50 py-0.5 text-center text-xs text-white"
                >
                  {index + 1}
                </span>
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Actions -->
      <div class="relative z-10 flex justify-end gap-2">
        <Button color="alternative" onclick={handleClose}>Cancel</Button>
        {#if selectedPageIndex !== null}
          <Button color="light" onclick={handleCropPage}>Crop Page</Button>
          <Button color="primary" onclick={handleUsePage}>Use Page</Button>
        {/if}
      </div>
    {/if}
  </div>
</Modal>

<style>
  .cropper-container :global(.cropper-container) {
    height: 100% !important;
  }
</style>
