<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { toggleFullScreen, zoomFitToScreen } from '$lib/panzoom';
  import { SpeedDial, SpeedDialButton } from 'flowbite-svelte';
  import { settings } from '$lib/settings';
  import {
    ArrowLeftOutline,
    ArrowRightOutline,
    CompressOutline,
    ImageOutline,
    ZoomOutOutline
  } from 'flowbite-svelte-icons';
  import { imageToWebp, showCropper, updateLastCard } from '$lib/anki-connect';
  import { promptConfirmation } from '$lib/util';
  import { db } from '$lib/catalog/db';

  interface Props {
    left: (_e: any, ingoreTimeOut?: boolean) => void;
    right: (_e: any, ingoreTimeOut?: boolean) => void;
    volumeUuid: string;
    pageNumber: number; // 0-indexed
    showSecondPage: boolean;
  }

  let { left, right, volumeUuid, pageNumber, showSecondPage }: Props = $props();

  let open = $state(false);

  function handleZoom() {
    zoomFitToScreen();
    open = false;
  }

  function handleLeft(_e: Event) {
    left(_e, true);
    open = false;
  }

  function handleRight(_e: Event) {
    right(_e, true);
    open = false;
  }

  async function onUpdateCard(pageOffset: number = 0) {
    if (!$settings.ankiConnectSettings.enabled) return;

    // Load specified page image from DB
    const img = await db.volumes_images
      .where('volume_uuid')
      .equals(volumeUuid)
      .and(img => img.page_number === pageNumber + pageOffset)
      .first();

    if (img) {
      if ($settings.ankiConnectSettings.cropImage) {
        showCropper(URL.createObjectURL(img.image));
      } else {
        promptConfirmation('Add image to last created anki card?', async () => {
          const imageData = await imageToWebp(img.image, $settings);
          updateLastCard(imageData);
        });
      }
    }
    open = false;
  }

</script>

{#if $settings.quickActions}
  <SpeedDial
    tooltip="none"
    trigger="click"
    defaultClass="absolute end-3 bottom-3 z-50"
    color="transparent"
    bind:open
  >
    {#if $settings.ankiConnectSettings.enabled}
      <SpeedDialButton name={showSecondPage ? '1' : undefined} on:click={() => onUpdateCard(0)}>
        <ImageOutline />
      </SpeedDialButton>
    {/if}
    {#if $settings.ankiConnectSettings.enabled && showSecondPage}
      <SpeedDialButton name="2" on:click={() => onUpdateCard(1)}>
        <ImageOutline />
      </SpeedDialButton>
    {/if}
    <SpeedDialButton on:click={toggleFullScreen}>
      <CompressOutline />
    </SpeedDialButton>
    <SpeedDialButton on:click={handleZoom}>
      <ZoomOutOutline />
    </SpeedDialButton>
    <SpeedDialButton on:click={handleRight}>
      <ArrowRightOutline />
    </SpeedDialButton>
    <SpeedDialButton on:click={handleLeft}>
      <ArrowLeftOutline />
    </SpeedDialButton>
  </SpeedDial>
{/if}
