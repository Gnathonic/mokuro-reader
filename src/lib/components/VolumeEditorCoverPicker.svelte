<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Button, Modal, Spinner, Fileupload } from 'flowbite-svelte';
  import { getVolumeFiles } from '$lib/util/volume-editor';
  import { showSnackbar } from '$lib/util';
  import {
    displayableImageBlob,
    RASTER_FORMAT_NAMES,
    RASTER_IMAGE_TYPES,
    sniffRasterBlob
  } from '$lib/util/raster-image';
  import ImageCropper from './ImageCropper.svelte';
  import {
    cropZoneToRect,
    initialCoverCrop,
    rectToCropZone,
    roundCropData,
    type CropZone
  } from '$lib/util/crop-geometry';

  type CropTemplate = CropZone;

  interface SelectionContext {
    pageIndex: number | null;
    cropZone: CropTemplate | null;
  }

  interface Props {
    volumeUuid: string;
    initialPageIndex?: number | null;
    openCropperOnLoad?: boolean;
    lastCropZone?: CropTemplate | null;
    hasNextVolume?: boolean;
    onSelect: (file: File, context?: SelectionContext) => void;
    onSelectAndNext?: (file: File, context?: SelectionContext) => void;
    onCancel: () => void;
  }

  let {
    volumeUuid,
    initialPageIndex = null,
    openCropperOnLoad = false,
    lastCropZone = null,
    hasNextVolume = false,
    onSelect,
    onSelectAndNext,
    onCancel
  }: Props = $props();

  let open = $state(true);
  let loading = $state(true);
  let pages = $state<{ path: string; file: File; url: string }[]>([]);
  let selectedPageIndex = $state<number | null>(null);

  // Cropping state
  let showCropper = $state(false);
  let cropImage = $state<string | null>(null);
  let cropper = $state<ImageCropper | undefined>();
  let generatedCropImageUrl = $state<string | null>(null);
  let appendedPageIndex = $state<number | null>(null);
  let appendCandidateIndex = $state<number | null>(null);

  // Capture Escape so it doesn't propagate to the series page's back-navigation handler
  $effect(() => {
    if (!open) return;

    function handleKeydown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        if (showCropper) {
          handleCropCancel();
        } else {
          handleClose();
        }
      }
    }

    window.addEventListener('keydown', handleKeydown, true);
    return () => window.removeEventListener('keydown', handleKeydown, true);
  });

  onMount(async () => {
    await loadPages();
  });

  onDestroy(() => {
    // Clean up object URLs
    for (const page of pages) {
      URL.revokeObjectURL(page.url);
    }
    if (generatedCropImageUrl) {
      URL.revokeObjectURL(generatedCropImageUrl);
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
          url: URL.createObjectURL(displayableImageBlob(f.file))
        }));
        if (pages.length > 0) {
          const defaultIndex = Math.min(Math.max(initialPageIndex ?? 0, 0), pages.length - 1);
          selectedPageIndex = defaultIndex;
          if (openCropperOnLoad) {
            cropImage = pages[defaultIndex]?.url || null;
            appendCandidateIndex = getDefaultAppendCandidateIndex(defaultIndex);
            showCropper = cropImage !== null;
          }
        }
      }
    } catch (err) {
      console.error('Error loading pages:', err);
    } finally {
      loading = false;
    }
  }

  /** Raster bytes only, whatever the file's type or name says (SVG is unsupported). */
  async function isValidImageFile(file: File): Promise<boolean> {
    return (await sniffRasterBlob(file).catch(() => null)) !== null;
  }

  async function handleFileUpload(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      const file = input.files[0];
      if (!(await isValidImageFile(file))) {
        showSnackbar(`Please select a ${RASTER_FORMAT_NAMES} image (SVG is not supported)`);
        return;
      }
      onSelect(file, { pageIndex: null, cropZone: null });
      handleClose();
    }
  }

  function handlePageSelect(index: number) {
    selectedPageIndex = index;
  }

  function handleUsePage() {
    if (selectedPageIndex !== null && pages[selectedPageIndex]) {
      onSelect(pages[selectedPageIndex].file, {
        pageIndex: selectedPageIndex,
        cropZone: null
      });
      handleClose();
    }
  }

  async function handleCropPage() {
    if (selectedPageIndex !== null && pages[selectedPageIndex]) {
      clearGeneratedCropImage();
      cropImage = pages[selectedPageIndex].url;
      appendedPageIndex = null;
      appendCandidateIndex = getDefaultAppendCandidateIndex(selectedPageIndex);
      showCropper = true;
    }
  }

  function clearGeneratedCropImage() {
    if (generatedCropImageUrl) {
      URL.revokeObjectURL(generatedCropImageUrl);
      generatedCropImageUrl = null;
    }
  }

  function getDefaultAppendCandidateIndex(baseIndex: number | null): number | null {
    if (baseIndex === null || pages.length < 2) return null;
    if (baseIndex + 1 < pages.length) return baseIndex + 1;
    if (baseIndex - 1 >= 0) return baseIndex - 1;
    return null;
  }

  function handleAppendCandidateChange(event: Event) {
    const value = Number.parseInt((event.target as HTMLSelectElement).value, 10);
    appendCandidateIndex = Number.isFinite(value) ? value : null;
  }

  async function loadImageBitmap(file: File): Promise<ImageBitmap> {
    return await createImageBitmap(file);
  }

  async function stitchPagesHorizontally(first: File, second: File): Promise<File> {
    const [img1, img2] = await Promise.all([loadImageBitmap(first), loadImageBitmap(second)]);
    const width = img1.width + img2.width;
    const height = Math.max(img1.height, img2.height);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      img1.close();
      img2.close();
      throw new Error('Could not get canvas context');
    }

    ctx.drawImage(img1, 0, 0);
    ctx.drawImage(img2, img1.width, 0);
    img1.close();
    img2.close();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.95)
    );
    if (!blob) {
      throw new Error('Failed to stitch images');
    }

    return new File([blob], 'appended-cover.jpg', { type: 'image/jpeg' });
  }

  async function appendSecondImage() {
    if (
      selectedPageIndex === null ||
      appendCandidateIndex === null ||
      selectedPageIndex === appendCandidateIndex ||
      !pages[selectedPageIndex] ||
      !pages[appendCandidateIndex]
    ) {
      return;
    }

    try {
      const stitched = await stitchPagesHorizontally(
        pages[selectedPageIndex].file,
        pages[appendCandidateIndex].file
      );
      clearGeneratedCropImage();
      generatedCropImageUrl = URL.createObjectURL(stitched);
      cropImage = generatedCropImageUrl;
      appendedPageIndex = appendCandidateIndex;
    } catch (err) {
      console.error('Error appending second image for cover crop:', err);
      showSnackbar('Failed to append second image');
    }
  }

  function removeAppendedImage() {
    if (selectedPageIndex === null || !pages[selectedPageIndex]) return;
    clearGeneratedCropImage();
    cropImage = pages[selectedPageIndex].url;
    appendedPageIndex = null;
  }

  /** The crop as a JPEG at 0.9, at the image's natural resolution. */
  async function croppedCoverFile(): Promise<File | null> {
    const canvas = cropper?.toCanvas();
    if (!canvas) return null;
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.9)
    );
    return blob ? new File([blob], 'cover.jpg', { type: 'image/jpeg' }) : null;
  }

  async function handleCropConfirm() {
    if (!cropper) return;

    try {
      const file = await croppedCoverFile();
      if (file) {
        onSelect(file, {
          pageIndex: selectedPageIndex,
          cropZone: getCurrentCropZone()
        });
        handleClose();
      }
    } catch (err) {
      console.error('Error cropping image:', err);
    }
  }

  function handleCropCancel() {
    clearGeneratedCropImage();
    appendedPageIndex = null;
    showCropper = false;
    cropImage = null;
  }

  function handleClose() {
    clearGeneratedCropImage();
    appendedPageIndex = null;
    open = false;
    onCancel();
  }

  function handleReset() {
    cropper?.reset();
  }

  function handleRotate90() {
    cropper?.rotate();
  }

  function getCurrentCropZone() {
    const crop = cropper?.getCrop();
    const size = cropper?.getImageSize();
    if (!crop || !size) return null;
    return rectToCropZone(roundCropData(crop), size.width, size.height);
  }

  function applyLastCropZone() {
    const size = cropper?.getImageSize();
    if (!cropper || !lastCropZone || !size) return;
    const rect = cropZoneToRect(lastCropZone, size.width, size.height);
    if (rect) cropper.setCrop(rect);
  }

  async function handleCropConfirmAndNext() {
    if (!cropper || !onSelectAndNext) return;

    try {
      const file = await croppedCoverFile();
      if (file) {
        onSelectAndNext(file, {
          pageIndex: selectedPageIndex,
          cropZone: getCurrentCropZone()
        });
        handleClose();
      }
    } catch (err) {
      console.error('Error cropping image for next volume:', err);
    }
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
        handleClose();
      }
    }
  }
</script>

<Modal
  bind:open
  size="xl"
  onclose={handleClose}
  class="cover-picker-modal"
  outsideclose={false}
  onmousedown={handleBackdropMousedown}
>
  <div class="p-2">
    {#if showCropper && cropImage}
      <!-- Cropper View -->
      <h3 class="mb-4 text-xl font-semibold text-gray-900 dark:text-white">Crop Cover</h3>

      <div
        class="cover-crop-area relative mb-4 h-[70dvh] w-full overflow-hidden rounded-lg bg-gray-900"
      >
        {#key cropImage}
          <ImageCropper
            bind:this={cropper}
            src={cropImage}
            initialCrop={initialCoverCrop}
            drawable
          />
        {/key}
      </div>

      <div class="mb-4 flex items-center justify-center gap-2">
        <Button size="xs" color="light" onclick={handleReset}>Reset</Button>
        <Button size="xs" color="light" onclick={handleRotate90}>Rotate 90°</Button>
        {#if selectedPageIndex !== null && pages.length > 1}
          <select
            class="rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            value={appendCandidateIndex ?? ''}
            onchange={handleAppendCandidateChange}
          >
            {#each pages as page, index}
              {#if index !== selectedPageIndex}
                <option value={index}>Append page {index + 1}</option>
              {/if}
            {/each}
          </select>
          <Button
            size="xs"
            color="light"
            onclick={appendSecondImage}
            disabled={appendCandidateIndex === null}
          >
            Append
          </Button>
          {#if appendedPageIndex !== null}
            <Button size="xs" color="light" onclick={removeAppendedImage}>Remove Appended</Button>
          {/if}
        {/if}
        {#if lastCropZone}
          <Button size="xs" color="light" onclick={applyLastCropZone}>Copy Last Crop Zone</Button>
        {/if}
      </div>

      <div class="flex justify-end gap-2">
        <Button color="alternative" onclick={handleCropCancel}>Back</Button>
        <Button color="primary" onclick={handleCropConfirm}>Use Cropped Image</Button>
        {#if onSelectAndNext && hasNextVolume}
          <Button color="blue" onclick={handleCropConfirmAndNext}>Use + Next Volume</Button>
        {/if}
      </div>
    {:else}
      <!-- Selection View -->
      <h3 class="mb-4 text-xl font-semibold text-gray-900 dark:text-white">Change Cover</h3>

      <!-- Upload Section -->
      <div class="mb-6">
        <span class="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
          Upload an image
        </span>
        <Fileupload accept={RASTER_IMAGE_TYPES.join(',')} onchange={handleFileUpload} />
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
            class="grid max-h-[70dvh] grid-cols-5 gap-2 overflow-y-auto rounded-lg border border-gray-200 p-2 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 dark:border-gray-700"
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
  /* Expand modal width */
  :global(.cover-picker-modal) {
    max-width: calc(100vw - 3rem) !important;
    width: calc(100vw - 3rem) !important;
  }
</style>
