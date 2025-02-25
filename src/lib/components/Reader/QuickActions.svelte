<script lang="ts">
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
  import { currentVolume } from '$lib/catalog';
  import { generateThumbnail } from '$lib/catalog/thumbnails';

  export let left: (_e: any, ingoreTimeOut?: boolean) => void;
  export let right: (_e: any, ingoreTimeOut?: boolean) => void;
  export let src1: File;
  export let src2: File | undefined;

  let open = false;

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

  async function onUpdateCard(src: File | undefined) {
    if ($settings.ankiConnectSettings.enabled && src) {
      if ($settings.ankiConnectSettings.cropImage) {
        showCropper(URL.createObjectURL(src));
      } else {
        promptConfirmation('Add image to last created anki card?', async () => {
          const imageData = await imageToWebp(src);
          updateLastCard(imageData);
        });
      }
    }
    open = false;
  }

  async function onSetThumbnail(src: File | undefined) {
    if (src && $currentVolume) {
      promptConfirmation('Set this page as volume thumbnail?', async () => {
        try {
          const thumbnail = await generateThumbnail(src);
          await db.volumes.where('volume_uuid').equals($currentVolume.volume_uuid).modify({ thumbnail });
        } catch (error) {
          console.error('Failed to update thumbnail for volume:', $currentVolume.volume_uuid, error);
        }
      });
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
      <SpeedDialButton name={src2 ? '1' : undefined} on:click={() => onUpdateCard(src1)}>
        <ImageOutline />
      </SpeedDialButton>
    {/if}
    {#if $settings.ankiConnectSettings.enabled && src2}
      <SpeedDialButton name="2" on:click={() => onUpdateCard(src2)}>
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
    <SpeedDialButton on:click={() => onSetThumbnail(src1)}>
      <PhotoOutline />
    </SpeedDialButton>
  </SpeedDial>
{/if}
