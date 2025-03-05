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

  interface Props {
    left: (_e: any, ingoreTimeOut?: boolean) => void;
    right: (_e: any, ingoreTimeOut?: boolean) => void;
    src1: File;
    src2: File | undefined;
  }

  let { left, right, src1, src2 }: Props = $props();

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
  </SpeedDial>
{/if}
