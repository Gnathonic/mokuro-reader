<script lang="ts">
  import { afterNavigate, beforeNavigate } from '$app/navigation';
  import { cropperStore, getCroppedImg, type Pixels, updateLastCard } from '$lib/anki-connect';
  import { settings } from '$lib/settings';
  import { Button, Modal, Spinner } from 'flowbite-svelte';
  import { onMount } from 'svelte';
  import Cropper from 'svelte-easy-crop';

  let open = $state(false);
  let pixels: Pixels | undefined = undefined;
  let loading = $state(false);
  let crop = $state({ x: 0, y: 0 });
  let zoom = $state(1);

  afterNavigate(() => {
    close();
  });

  beforeNavigate((nav) => {
    if (open) {
      nav.cancel();
      close();
    }
  });

  onMount(() => {
    cropperStore.subscribe((value) => {
      if (value) {
        open = value.open;
      }
    });
  });

  function close() {
    loading = false;
    cropperStore.set({ open: false });
  }

  async function onCrop() {
    console.log('[Cropper] onCrop called');
    console.log('[Cropper] $cropperStore?.image:', $cropperStore?.image);
    console.log('[Cropper] pixels:', pixels);

    if ($cropperStore?.image && pixels) {
      console.log('[Cropper] Starting crop operation');
      loading = true;
      try {
        const imageData = await getCroppedImg($cropperStore.image, pixels, $settings);
        console.log('[Cropper] Got cropped image, updating card');
        updateLastCard(imageData, $cropperStore.sentence);
        close();
      } catch (error) {
        console.error('[Cropper] Error during crop:', error);
        loading = false;
      }
    } else {
      console.warn('[Cropper] Cannot crop - missing image or pixels');
    }
  }

  function onCropComplete(detail: any) {
    // In v4, the callback receives the detail directly (not as e.detail)
    // This fires continuously as the user adjusts the crop area
    pixels = detail.pixels;
  }
</script>

<Modal title="Crop image" bind:open onclose={close}>
  {#if $cropperStore?.image && !loading}
    <div class=" flex flex-col gap-2">
      <div class="relative h-[55svh] w-full sm:h-[65svh]">
        <Cropper
          zoomSpeed={0.5}
          maxZoom={10}
          image={$cropperStore?.image}
          bind:crop
          bind:zoom
          oncropcomplete={onCropComplete}
        />
      </div>
      {#if $settings.ankiConnectSettings.grabSentence && $cropperStore?.sentence}
        <p>
          <b>Sentence:</b>
          {$cropperStore?.sentence}
        </p>
      {/if}
      <Button onclick={onCrop}>Crop</Button>
      <Button onclick={close} outline color="light">Close</Button>
    </div>
  {:else}
    <div class="text-center"><Spinner /></div>
  {/if}
</Modal>
